import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useResolveRoots } from "../../api/embeddings";
import type { CellRootResolution } from "../../api/types";

interface Props {
  ds: string;
  matVersion: number | "live";
  embeddingId: string;
  /** Currently-focused cell. Rendered as a one-row section at the top so
   *  the user always sees "the cell I'm looking at" prominently. */
  focusCellId: string | null;
  /** kNN result. Empty array means "no neighbors searched yet"; non-empty
   *  renders a scrollable list. */
  neighborCellIds: string[];
  /** Lasso/box-selected cell_ids. Same treatment as neighbors but a
   *  different section header + color cue. */
  brushCellIds: string[];
  /** Called when the user clicks a row — focuses that cell. */
  onCellClick: (cellId: string) => void;
  /** "Clear" affordances on each section. The caller wipes the
   *  corresponding URL state. */
  onClearNeighbors: () => void;
  onClearBrush: () => void;
  /** Single source of truth for /neuron href construction (lives in
   *  FeatureExplorer so the rules are shared with ExplorerTable). */
  buildNeuronHref: (rootId: string) => string;
}

/**
 * Right-rail summary of the three selection states (Focus / Neighbors /
 * Brush). Each section lists cell_ids one per row.
 *
 * Cross-nav into /neuron goes through a batched resolver prefetch:
 *
 *   - Section render mounts → useResolveRoots fires (one query per
 *     section, batched into a single POST per non-empty section).
 *   - Each row peeks at its resolution; on `status: "ok"` it renders a
 *     `<Link>` to /neuron preserving ds/mv/dec/cells/plots/viz_* and
 *     setting `?from=explore:<embedding_id>`.
 *   - On `status: "missing"` or `"ambiguous"`, the row renders as a
 *     greyed-out non-link with a tooltip explaining why.
 *
 * The resolver query is cached by (ds, mv, cellIds-csv) so identical
 * neighbor sets across kNN runs and visual selections share a single
 * round-trip per session.
 */
export function SelectionPane({
  ds,
  matVersion,
  embeddingId,
  focusCellId,
  neighborCellIds,
  brushCellIds,
  onCellClick,
  onClearNeighbors,
  onClearBrush,
  buildNeuronHref,
}: Props) {
  const empty =
    !focusCellId && neighborCellIds.length === 0 && brushCellIds.length === 0;
  if (empty) {
    return (
      <aside className="explore-selection explore-selection-empty">
        Click a point, lasso a region, or use the kNN controls to start a selection.
      </aside>
    );
  }

  return (
    <aside className="explore-selection">
      {focusCellId && (
        <ResolvedSection
          title="Focus"
          color="focus"
          ds={ds}
          matVersion={matVersion}
          embeddingId={embeddingId}
          cellIds={[focusCellId]}
          buildHref={buildNeuronHref}
          onCellClick={onCellClick}
        />
      )}
      {neighborCellIds.length > 0 && (
        <ResolvedSection
          title={`Neighbors (${neighborCellIds.length})`}
          color="neighbor"
          ds={ds}
          matVersion={matVersion}
          embeddingId={embeddingId}
          cellIds={neighborCellIds}
          buildHref={buildNeuronHref}
          onCellClick={onCellClick}
          onClear={onClearNeighbors}
        />
      )}
      {brushCellIds.length > 0 && (
        <ResolvedSection
          title={`Brush selection (${brushCellIds.length})`}
          color="brush"
          ds={ds}
          matVersion={matVersion}
          embeddingId={embeddingId}
          cellIds={brushCellIds}
          buildHref={buildNeuronHref}
          onCellClick={onCellClick}
          onClear={onClearBrush}
        />
      )}
    </aside>
  );
}

interface ResolvedSectionProps {
  title: string;
  color: "focus" | "neighbor" | "brush";
  ds: string;
  matVersion: number | "live";
  embeddingId: string;
  cellIds: string[];
  buildHref: (rootId: string) => string;
  onCellClick: (cellId: string) => void;
  onClear?: () => void;
}

function ResolvedSection({
  title,
  color,
  ds,
  matVersion,
  embeddingId,
  cellIds,
  buildHref,
  onCellClick,
  onClear,
}: ResolvedSectionProps) {
  // One resolution query per section. Cached by (ds, mv, cellIds-csv) so
  // re-renders within the same session don't re-fetch, but a different
  // neighbor set (different kNN run) cuts a fresh entry.
  const resolveQuery = useResolveRoots({
    ds,
    embeddingId,
    cellIds,
    matVersion,
  });

  // Build a quick cell_id → resolution map for O(1) lookup per row.
  const byCellId = useMemo(() => {
    const m = new Map<string, CellRootResolution>();
    for (const r of resolveQuery.data?.resolutions ?? []) {
      m.set(r.cell_id, r);
    }
    return m;
  }, [resolveQuery.data]);

  const okCount = useMemo(() => {
    let n = 0;
    for (const r of resolveQuery.data?.resolutions ?? []) {
      if (r.status === "ok") n++;
    }
    return n;
  }, [resolveQuery.data]);

  return (
    <div className={`explore-selection-section explore-selection-${color}`}>
      <header>
        <span className="explore-selection-pip" aria-hidden />
        <span className="explore-selection-title">{title}</span>
        {resolveQuery.data && cellIds.length > 1 && (
          <span className="explore-selection-resolved-count" title="Cells resolvable at the current mat_version">
            {okCount}/{cellIds.length} resolvable
          </span>
        )}
        {onClear && (
          <button
            type="button"
            className="explore-selection-clear"
            onClick={onClear}
            aria-label={`Clear ${title.toLowerCase()}`}
          >
            ×
          </button>
        )}
      </header>
      <div className="explore-selection-rows">
        {cellIds.map((cellId) => (
          <CellRow
            key={`${color}-${cellId}`}
            cellId={cellId}
            resolution={byCellId.get(cellId) ?? null}
            isLoading={resolveQuery.isPending}
            buildHref={buildHref}
            onCellClick={onCellClick}
          />
        ))}
      </div>
    </div>
  );
}

interface CellRowProps {
  cellId: string;
  resolution: CellRootResolution | null;
  isLoading: boolean;
  buildHref: (rootId: string) => string;
  onCellClick: (cellId: string) => void;
}

function CellRow({ cellId, resolution, isLoading, buildHref, onCellClick }: CellRowProps) {
  // Two interactions on each row:
  //   - The id button focuses the cell in-explorer (no cross-nav)
  //   - The → link cross-navs to /neuron with the resolved root_id
  // The arrow is hidden / disabled when the resolution is missing or
  // ambiguous so a click never goes to a broken /neuron URL.
  const status = resolution?.status;
  const canNavigate = !!resolution && status === "ok" && !!resolution.root_id;

  let tooltip = "";
  if (isLoading) tooltip = "Resolving root_id at this mat_version…";
  else if (status === "missing") {
    tooltip = "This cell has no current root_id at the selected mat_version. Try a more recent mv.";
  } else if (status === "ambiguous") {
    tooltip = `Ambiguous: maps to ${resolution?.candidates?.length ?? "multiple"} root_ids. Cross-nav disabled.`;
  } else if (canNavigate) {
    tooltip = `Open /neuron for root_id ${resolution!.root_id}`;
  }

  return (
    <div className={`explore-selection-row ${canNavigate ? "" : "explore-selection-row-disabled"}`}>
      <button
        type="button"
        className="explore-selection-row-id"
        onClick={() => onCellClick(cellId)}
        title={`Focus cell ${cellId}`}
      >
        {cellId}
      </button>
      {canNavigate ? (
        <Link
          to={buildHref(resolution!.root_id!)}
          className="explore-selection-row-nav"
          title={tooltip}
          aria-label={`Open neuron view for cell ${cellId}`}
        >
          →
        </Link>
      ) : (
        <span
          className="explore-selection-row-nav explore-selection-row-nav-disabled"
          title={tooltip}
          aria-hidden
        >
          {isLoading ? "…" : status === "ambiguous" ? "⚠" : "—"}
        </span>
      )}
    </div>
  );
}
