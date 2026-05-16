import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCellList,
  useEmbeddingList,
  useEmbeddingScatter,
  useResolveRoots,
} from "../../api/embeddings";
import { useCrossNavHref } from "../../hooks/useCrossNavHref";
import {
  parseMatVersion,
  useSetUrlParams,
  useUrlParam,
} from "../../hooks/useUrlState";
import { randomSubsample, useNglLink } from "../../hooks/useNglLink";
import type { PartnerRecord } from "../../api/types";

/** Hard cap on the cells handed to /links/segments at once. The server
 *  allows up to 1000; the explorer caps lower (500) because Neuroglancer
 *  itself starts feeling sluggish past a few hundred segments and the
 *  user rarely needs more for a "look at this group" workflow. Sets
 *  above the cap get randomly sub-sampled — `Open in NGL` on a 50k
 *  filter result is meaningful as a sample, not as a full enumeration. */
const NGL_LINK_CAP = 500;

interface ClearPillProps {
  label: string;
  /** True when there's something to clear. Drives the active vs greyed
   *  visual. */
  active: boolean;
  onClear: () => void;
  /** Pill color variant — "lasso" reads orange (matches the scatter
   *  highlight); "rowsel" reads blue (matches row-checkbox semantics). */
  variant: "lasso" | "rowsel";
}

function ClearPill({ label, active, onClear, variant }: ClearPillProps) {
  return (
    <span
      role="button"
      className={`explore-clear-pill explore-clear-pill-${variant}${
        active ? "" : " disabled"
      }`}
      aria-disabled={!active}
      title={active ? `Clear the active ${label}` : `No active ${label} to clear`}
      onClick={(e) => {
        e.stopPropagation();
        if (!active) return;
        onClear();
      }}
    >
      × clear {label}
    </span>
  );
}

interface NglActionPillProps {
  label: string;
  count: number;
  disabled: boolean;
  liveDisabled: boolean;
  onOpen: () => void;
}

/** Pill-shaped NGL action button used in the drawer header. Lives
 *  next to the count + clear-pills so the user finds all the
 *  "current cell set" actions in one place. Always rendered (even
 *  when its action isn't available) so the user knows the feature
 *  exists — disabled state vs missing element is a clearer signal
 *  than a button popping in only when conditions align.
 *
 *  Tooltip explains why the button is disabled: empty set vs live
 *  mode vs pending request.
 */
function NglActionPill({
  label,
  count,
  disabled,
  liveDisabled,
  onOpen,
}: NglActionPillProps) {
  const sampled = Math.min(count, NGL_LINK_CAP);
  const title = liveDisabled
    ? "Switch to a materialized version to open in Neuroglancer"
    : count === 0
      ? `No ${label} cells to open`
      : count > NGL_LINK_CAP
        ? `Open a random sample of ${NGL_LINK_CAP} cells from the ${count.toLocaleString()} ${label}`
        : `Open ${count.toLocaleString()} ${label} cells in Neuroglancer`;
  return (
    <span
      role="button"
      className={`explore-ngl-pill${disabled ? " disabled" : ""}`}
      aria-disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onOpen();
      }}
    >
      ↗ {label} ({sampled.toLocaleString()}
      {count > NGL_LINK_CAP && (
        <>/{count.toLocaleString()}</>
      )}
      )
    </span>
  );
}

import { CellFilterMenu } from "../CellFilterMenu";
import { PartnersTable } from "../PartnersTable";
import { CellIdSearch } from "./CellIdSearch";
import { ChannelPicker } from "./ChannelPicker";
import { DecorationPicker } from "./DecorationPicker";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { FeatureTablePicker } from "./FeatureTablePicker";
import { SavedSetsPanel } from "./SavedSetsPanel";
import { SummaryPanel } from "./SummaryPanel";
import {
  UniverseScatter,
  type UniverseScatterHandle,
} from "./UniverseScatter";
import {
  useNamedSelections,
  type NamedSelection,
} from "../../hooks/useNamedSelections";
import { useResizableRailWidth } from "../../hooks/useResizableRailWidth";

/**
 * Route component for `/explore`.
 *
 * Composes the explorer onto the shared toolkit: the same
 * PartnersTable that renders /neuron's partners renders the cell
 * list here, the same CellFilterPanel writes `?cells=` here, the same
 * DecorationPicker writes `?dec=` here. The explorer-specific surface
 * is the universe scatter (a first-class page element, not a rail
 * panel) and the feature-table + embedding pickers.
 *
 * Highlight set computation: `?cells=` filter result is the highlight
 * — those are the cells the user's filter selected. Plus any lasso
 * selection from the universe scatter (`?sel_universe=`). Without a
 * filter or lasso, the scatter renders the universe at full opacity
 * with no overlay (everything is "in scope").
 */
export function FeatureExplorer() {
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const [ft] = useUrlParam("ft");
  const [emb] = useUrlParam("emb");
  const [decRaw] = useUrlParam("dec");
  const [cells] = useUrlParam("cells");
  // Unified selection state: cell_ids the user has chosen, by either
  // mechanism — row checkboxes in the table OR lassoing on the
  // scatter. Lassoing is a *selection action*, not a table filter —
  // a polygon over the scatter behaves the same as ticking each
  // contained cell's checkbox.
  //
  // Lives in local component state (not URL) — large lassos overflow
  // Node's 8KB header limit when the URL becomes a request line on
  // page refresh (HTTP 431). Selections are inherently transient and
  // the user opted out of URL persistence here. The rest of the view
  // config — ?cells, ?dec, ?ft, ?emb, channel bindings — stays in
  // URL state for shareability.
  const [selTableLocal, setSelTableLocal] = useState<string[]>([]);
  const setSelTable = useCallback((csv: string | null) => {
    setSelTableLocal(csv ? csv.split(",").filter(Boolean) : []);
  }, []);
  // Set-typed mutators for the named-set algebra below — operating on
  // raw arrays would require redundant split-and-join on every call.
  const replaceSelection = useCallback((cellIds: string[]) => {
    setSelTableLocal(cellIds);
  }, []);
  const unionIntoSelection = useCallback((cellIds: string[]) => {
    setSelTableLocal((prev) => {
      const seen = new Set(prev);
      const out = [...prev];
      for (const c of cellIds) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push(c);
        }
      }
      return out;
    });
  }, []);
  const subtractFromSelection = useCallback((cellIds: string[]) => {
    setSelTableLocal((prev) => {
      const drop = new Set(cellIds);
      return prev.filter((c) => !drop.has(c));
    });
  }, []);
  // Seaborn-style channel bindings. Each is the dotted column name
  // (parquet columns are prefixed with the feature_table id; decoration
  // columns are `<dec_table>.<col>`) or null to fall back to the
  // embedding's default.
  const [xBinding] = useUrlParam("x");
  const [yBinding] = useUrlParam("y");
  const [colorBinding] = useUrlParam("color");
  const [sizeBinding] = useUrlParam("size");
  const [sizeMinRaw] = useUrlParam("size_min");
  const [sizeMaxRaw] = useUrlParam("size_max");
  const [colorMinRaw] = useUrlParam("color_min");
  const [colorMaxRaw] = useUrlParam("color_max");
  const [colormapId] = useUrlParam("cmap");
  const [colorCenterRaw] = useUrlParam("color_center");
  // Drawer state for the cell-list table. Closed by default so the
  // scatter owns the full canvas on first arrival; user clicks the
  // drawer handle to pull up the table.
  const [tableRaw, setTable] = useUrlParam("table");
  const tableOpen = tableRaw === "open";
  // "Limit visible to selection" — a *snapshot* of cell_ids the user
  // froze at the moment they clicked the action. The table narrows
  // to these. Distinct from the live selection so the user can
  // modify their selection (check/uncheck rows, lasso more) without
  // the visible-set shifting under their interactions.
  // Same URL-overflow reasoning as the selection state — kept local.
  const [limitToCellIds, setLimitToCellIds] = useState<string[]>([]);
  const setLimitTo = useCallback((csv: string | null) => {
    setLimitToCellIds(csv ? csv.split(",").filter(Boolean) : []);
  }, []);
  // Size range falls back to client defaults when URL is silent.
  const sizeMinPx = sizeMinRaw ? parseFloat(sizeMinRaw) : 2.0;
  const sizeMaxPx = sizeMaxRaw ? parseFloat(sizeMaxRaw) : 18.0;
  // Color clipping is null-default — the slider's bounds come from
  // the data extent at render time, and null means "use the full
  // extent." Explicit URL values clamp the colorscale endpoints.
  const colorMin = colorMinRaw ? parseFloat(colorMinRaw) : null;
  const colorMax = colorMaxRaw ? parseFloat(colorMaxRaw) : null;
  // Center for diverging colormaps. Null = "no explicit pick" → renderer
  // falls back to the range midpoint, which is a visual no-op until the
  // user moves it. Numeric URL values clamp the gradient pivot.
  const colorCenter = colorCenterRaw ? parseFloat(colorCenterRaw) : null;
  const setUrl = useSetUrlParams();

  const matVersion = parseMatVersion(mv);
  const decorationTables = decRaw ? decRaw.split(",").filter(Boolean) : [];

  // Resizable rail width. Persists to localStorage so reloads + cross-
  // nav preserve it; clamped to [260, 640] inside the hook.
  const {
    width: railWidth,
    beginDrag: beginRailResize,
    isDragging: railResizing,
  } = useResizableRailWidth();

  // Imperative handle on the universe scatter. Used by CellIdSearch to
  // re-frame the camera onto a freshly-resolved cell (or set of cells)
  // after `replaceSelection(...)` populates the highlight set. The
  // scatter's `fitView` reads `partition.highlight` which depends on the
  // `highlightedCellIds` prop — so the call has to be deferred until
  // React has flushed the selection state change and the scatter has
  // re-committed its partition. `requestAnimationFrame` is enough: the
  // state update fires synchronously, React schedules a render, then
  // rAF runs after the commit phase, and `ref.current.fitView` is the
  // latest closure (useImperativeHandle re-binds on fitView change).
  const scatterRef = useRef<UniverseScatterHandle | null>(null);
  const fitToSelection = useCallback(() => {
    requestAnimationFrame(() => {
      scatterRef.current?.fitView();
    });
  }, []);

  // Named cell sets — per (ds, ft) localStorage layer. The hook is
  // disabled gracefully when ds/ft are null (initial render before
  // catalog defaults kick in) so the panel just renders the empty
  // state during that brief window.
  const namedSelections = useNamedSelections(ds, ft);
  // Inline "Save selection" affordance: the drawer header pill opens
  // an input pre-filled with the auto-suggested name. Local state
  // holds the draft + open flag so the rename input doesn't fight
  // with the pill's click toggle.
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveDraftName, setSaveDraftName] = useState("");
  const openSavePrompt = () => {
    setSaveDraftName(namedSelections.suggestName());
    setSavePromptOpen(true);
  };
  const closeSavePrompt = () => {
    setSavePromptOpen(false);
  };
  const commitSavePrompt = () => {
    if (selTableLocal.length === 0) {
      setSavePromptOpen(false);
      return;
    }
    namedSelections.save(saveDraftName, selTableLocal);
    setSavePromptOpen(false);
  };

  // Catalog — drives both pickers + tells us if the explorer is even
  // configured for this datastack.
  const catalog = useEmbeddingList(ds);
  const featureTables = catalog.data?.feature_tables ?? [];

  // Default the picks to the first available feature_table + its first
  // embedding when the URL is silent. Replaces the URL so the back
  // button doesn't bounce through the "no pick" state.
  useEffect(() => {
    if (!catalog.data?.enabled) return;
    if (featureTables.length === 0) return;
    const ftMissing = !ft || !featureTables.find((t) => t.id === ft);
    const defaultFt = featureTables[0];
    const targetFt = ftMissing ? defaultFt : featureTables.find((t) => t.id === ft)!;
    const embMissing = !emb || !targetFt.embeddings.find((e) => e.id === emb);
    const defaultEmb = targetFt.embeddings[0];
    if (ftMissing || embMissing) {
      setUrl(
        {
          ft: ftMissing ? defaultFt.id : ft,
          emb: embMissing ? defaultEmb?.id ?? null : emb,
        },
        { replace: true },
      );
    }
  }, [catalog.data, featureTables, ft, emb, setUrl]);

  // The unified selection set: cell_ids from row checkboxes AND
  // lasso. One source of truth — populated by either mechanism,
  // read by the scatter highlight, the table's row-checked state,
  // and the NGL "selected" action. Local state (see setSelTable
  // comment above on why we don't put this in URL state).
  const rowSelectedCellIds = selTableLocal;

  // Scatter response — fetched by UniverseScatter too, but TanStack
  // Query dedupes by queryKey so there's only one network call. We
  // read it here to feed the SummaryPanel's universe counts + the
  // ChannelPicker's color-slider bounds without prop-drilling from
  // UniverseScatter.
  const scatter = useEmbeddingScatter(
    ds && ft && emb
      ? {
          ds,
          featureTableId: ft,
          embeddingId: emb,
          x: xBinding,
          y: yBinding,
          colorBy: colorBinding,
          sizeBy: sizeBinding,
          decorationTables,
          matVersion,
        }
      : null,
  );

  // Color slider bounds: data extent of the bound numeric column.
  // Recomputed on each response so the slider always reflects the
  // current column's range, not a stale one from a previous binding.
  const colorBound = useMemo(() => {
    const c = scatter.data?.color;
    if (!c || c.kind !== "numeric") return null;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of c.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return null;
    return { lo, hi };
  }, [scatter.data?.color]);

  // Universe Set for the Cell ID Search's `cell_id` mode. The scatter
  // already loaded the cell_id array; wrap it in a Set so membership
  // checks are O(1) per token rather than O(n) per token. Re-builds
  // only when the underlying array reference changes (TanStack Query
  // hands us a stable reference per response).
  const universeCellIds = useMemo<Set<string> | null>(() => {
    const ids = scatter.data?.cell_ids;
    if (!ids) return null;
    return new Set(ids);
  }, [scatter.data?.cell_ids]);

  // /cells fetch — the cell-list table reads from this. With lasso
  // now a selection mechanism (not a filter), the request is driven
  // purely by the filter expression `?cells=` from CellFilterPanel.
  // matched_count reflects "everything passing the filter."
  const cellList = useCellList(
    ds && ft
      ? {
          ds,
          featureTableId: ft,
          matVersion,
          decorationTables,
          cells,
        }
      : null,
  );

  // Selection (the "mark" set in scope/view/mark) — the union of two
  // mechanisms that both produce selections, not one overriding the
  // other:
  //   - Predicate selection: cells matching the CellFilterPanel
  //     expression (`?cells=`). Only counted when a filter is active —
  //     without one, cellList returns the full universe, which would
  //     trivially mark everything.
  //   - Brush selection: row checkboxes + scatter lasso, both pooled
  //     into `rowSelectedCellIds`.
  // The two compose: filter to a population, then lasso a subset, and
  // both stay marked on the plot. Empty union → no overlay.
  const highlightedCellIds = useMemo(() => {
    const fromPredicate = cells && cellList.data ? cellList.data.cell_ids : [];
    if (fromPredicate.length === 0 && rowSelectedCellIds.length === 0) return null;
    const union = new Set<string>(fromPredicate);
    for (const id of rowSelectedCellIds) union.add(id);
    return union;
  }, [rowSelectedCellIds, cells, cellList.data]);

  // Batch cell_id → root_id resolution for the visible rows. The
  // resolver universe-caches per (ds, mv) server-side so a 94k-cell
  // resolution is a single CAVE round-trip; subsequent requests within
  // the same mv are dict reads. Disabled in live mode (resolver is
  // materialization-keyed in v1).
  const resolveCellIds = cellList.data?.cell_ids ?? [];
  const resolveQuery = useResolveRoots(
    ds && ft && matVersion !== "live" && resolveCellIds.length > 0
      ? {
          ds,
          featureTableId: ft,
          cellIds: resolveCellIds,
          matVersion,
        }
      : null,
  );

  // Map cell_id → resolved root_id (or null when missing/ambiguous).
  // Keyed by stringified cell_id to match the wire convention.
  const rootByCellId = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of resolveQuery.data?.resolutions ?? []) {
      m.set(r.cell_id, r.status === "ok" ? r.root_id : null);
    }
    return m;
  }, [resolveQuery.data]);

  // Helper: project a cell_id list through the resolver map and
  // discard unresolved ids. Used by both NGL buttons.
  const resolveRoots = (cellIds: string[]): string[] => {
    const out: string[] = [];
    for (const cid of cellIds) {
      const root = rootByCellId.get(cid);
      if (root) out.push(root);
    }
    return out;
  };

  // Cross-nav builder for the per-row "→" link in the cell-list table.
  // Inter-view (explore → neuron) so explorer URL state (ft/emb/x/y/…)
  // stays put. cells + decorations carry forward — the user's filter
  // and decoration choices belong on both sides.
  const cellCrossNavHref = useCrossNavHref({
    ds: ds ?? "",
    matVersion,
    from: `explore:${ft ?? ""}/${emb ?? ""}`,
    decorationTables,
    cells,
    inheritParams: false,
    resolveRoot: (cellId) => rootByCellId.get(cellId) ?? null,
  });

  const ngl = useNglLink();
  const openInNgl = async (cellIds: string[]) => {
    if (matVersion === "live" || !ds) return;
    const roots = resolveRoots(cellIds);
    if (roots.length === 0) return;
    const sampled = randomSubsample(roots, NGL_LINK_CAP);
    await ngl.open({ kind: "segments", ds, matVersion, rootIds: sampled });
  };
  // Per-row NGL action — opens a single cell as a segment. Wraps the
  // bulk handler with a one-id list; reuses the same mutation +
  // error-surface so the user sees "NGL link failed" if it errors.
  const openCellInNgl = (cellId: string) => {
    void openInNgl([cellId]);
  };

  // Enrich cellList rows with the resolved root_id so PartnersTable's
  // existing rendering machinery picks it up like any other column.
  // The augmented column_groups carries a "current root" group so the
  // user can see the resolution alongside cell_id.
  const enrichedCells = useMemo(() => {
    if (!cellList.data) return null;
    // PartnerRecord.root_id is typed as string (non-null) for the
    // /neuron use case. In /explore the field is a *resolution* —
    // null is meaningful ("didn't resolve at this mv"). The cast
    // is safe because the cell-list table renders root_id via the
    // CopyableId path which handles null; nothing else in the
    // explorer reads this field as a non-null string.
    const rows = cellList.data.rows.map((row) => {
      const cid = String(row.cell_id);
      return {
        ...row,
        root_id: rootByCellId.get(cid) ?? null,
      };
    }) as unknown as PartnerRecord[];
    const groups = cellList.data.column_groups.map((g) =>
      g.name === "id" ? { ...g, columns: [...g.columns, "root_id"] } : g,
    );
    return { rows, column_groups: groups };
  }, [cellList.data, rootByCellId]);

  if (!ds) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Pick a datastack to begin.</p>
      </div>
    );
  }
  if (catalog.isLoading) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Loading catalog…</p>
      </div>
    );
  }
  if (catalog.data && !catalog.data.enabled) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>
          The feature explorer is not configured for <code>{ds}</code>.
        </p>
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Failed to load the catalog: {String(catalog.error)}</p>
      </div>
    );
  }
  if (!ft || !emb) {
    // Effect above will fill these in on the next tick.
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Initializing…</p>
      </div>
    );
  }

  const currentFt = featureTables.find((t) => t.id === ft) ?? null;
  const currentEmbeddings = currentFt?.embeddings ?? [];
  const currentEmb = currentEmbeddings.find((e) => e.id === emb) ?? null;

  return (
    <div
      className="explore"
      style={{ gridTemplateColumns: `${railWidth}px 6px 1fr` }}
    >
      <aside className="explore-rail">
        <FeatureTablePicker
          featureTables={featureTables}
          value={ft}
          onChange={(next) => {
            // Switching feature tables clears the embedding pick — the
            // next table has a different list. The effect above will
            // re-default emb on the following tick.
            setUrl({ ft: next, emb: null, sel_universe: null });
          }}
        />
        <EmbeddingPicker
          embeddings={currentEmbeddings}
          value={emb}
          onChange={(next) =>
            setUrl({ emb: next, sel_universe: null })
          }
        />
        {matVersion !== "live" && (
          <DecorationPicker
            ds={ds}
            matVersion={matVersion}
            attached={decorationTables}
            onChange={(next) =>
              setUrl({ dec: next.length > 0 ? next.join(",") : null })
            }
          />
        )}
        <CellIdSearch
          ds={ds}
          featureTableId={ft}
          matVersion={matVersion}
          universeCellIds={universeCellIds}
          onReplaceSelection={replaceSelection}
          onUnionIntoSelection={unionIntoSelection}
          onFitToSelection={fitToSelection}
        />
        <ChannelPicker
          featureTable={currentFt}
          cellsColumnGroups={cellList.data?.column_groups}
          x={xBinding}
          y={yBinding}
          colorBy={colorBinding}
          sizeBy={sizeBinding}
          sizeMinPx={sizeMinPx}
          sizeMaxPx={sizeMaxPx}
          colorBound={colorBound}
          colorMin={colorMin}
          colorMax={colorMax}
          colorIsNumeric={scatter.data?.color?.kind === "numeric"}
          colormapId={colormapId}
          colorCenter={colorCenter}
          defaultXLabel={currentEmb?.axes?.[0]}
          defaultYLabel={currentEmb?.axes?.[1]}
          defaultColorLabel={currentEmb?.default_color_by ?? null}
          onChange={(next) =>
            setUrl({
              ...(next.x !== undefined ? { x: next.x } : {}),
              ...(next.y !== undefined ? { y: next.y } : {}),
              ...(next.colorBy !== undefined ? { color: next.colorBy } : {}),
              ...(next.sizeBy !== undefined ? { size: next.sizeBy } : {}),
              ...(next.sizeMinPx !== undefined
                ? { size_min: String(next.sizeMinPx) }
                : {}),
              ...(next.sizeMaxPx !== undefined
                ? { size_max: String(next.sizeMaxPx) }
                : {}),
              ...(next.colorMin !== undefined
                ? { color_min: next.colorMin === null ? null : String(next.colorMin) }
                : {}),
              ...(next.colorMax !== undefined
                ? { color_max: next.colorMax === null ? null : String(next.colorMax) }
                : {}),
              ...(next.colormapId !== undefined ? { cmap: next.colormapId } : {}),
              ...(next.colorCenter !== undefined
                ? {
                    color_center:
                      next.colorCenter === null ? null : String(next.colorCenter),
                  }
                : {}),
            })
          }
        />
        <SummaryPanel
          scatter={scatter.data}
          highlightedCellIds={highlightedCellIds}
          ds={ds}
          featureTable={currentFt}
          cellsColumnGroups={cellList.data?.column_groups}
          matVersion={matVersion}
          decorationTables={decorationTables}
        />
        <SavedSetsPanel
          selections={namedSelections.selections}
          currentSelection={selTableLocal}
          onLoad={(s: NamedSelection) => replaceSelection(s.cellIds)}
          onAdd={(s: NamedSelection) => unionIntoSelection(s.cellIds)}
          onSubtract={(s: NamedSelection) => subtractFromSelection(s.cellIds)}
          onRename={(s: NamedSelection, name: string) =>
            namedSelections.rename(s.id, name)
          }
          onRemove={(s: NamedSelection) => namedSelections.remove(s.id)}
        />
      </aside>
      {/* Vertical drag handle between rail and scatter. Hover state in
          CSS; the active class comes from the hook's isDragging flag
          so the handle stays highlighted while the user is mid-drag
          even after the cursor leaves its bounds. */}
      <div
        className={`explore-rail-handle${railResizing ? " dragging" : ""}`}
        onMouseDown={beginRailResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize feature explorer rail"
        title="Drag to resize rail"
      />
      <section className={`explore-center${tableOpen ? " table-open" : ""}`}>
        <div className="explore-scatter-wrap">
          <UniverseScatter
            ref={scatterRef}
            ds={ds}
            featureTableId={ft}
            embeddingId={emb}
            x={xBinding}
            y={yBinding}
            colorBy={colorBinding}
            sizeBy={sizeBinding}
            sizeMinPx={sizeMinPx}
            sizeMaxPx={sizeMaxPx}
            colorMin={colorMin}
            colorMax={colorMax}
            colormapId={colormapId}
            colorCenter={colorCenter}
            decorationTables={decorationTables}
            matVersion={matVersion}
            highlightedCellIds={highlightedCellIds}
            onLassoSelect={(polygonIds) => {
              // Lasso writes into the unified selection. Intersect with
              // the in-scope set so the user can't "select" cells that
              // don't pass the current filter — out-of-scope cells
              // wouldn't show in the table or have meaningful NGL
              // resolution there anyway. When no filter is active the
              // in-scope set is the full universe, so the intersection
              // collapses to the polygon hit-test result.
              const scope = cellList.data
                ? new Set(cellList.data.cell_ids)
                : null;
              const inScope =
                scope === null ? polygonIds : polygonIds.filter((id) => scope.has(id));
              setSelTable(inScope.length > 0 ? inScope.join(",") : null);
            }}
          />
        </div>
        {/* Drawer: handle always visible; body only when open. */}
        <div className={`explore-drawer${tableOpen ? " open" : ""}`}>
          <button
            type="button"
            className="explore-drawer-handle"
            onClick={() => setTable(tableOpen ? null : "open")}
            aria-expanded={tableOpen}
            title={tableOpen ? "Hide cell table" : "Show cell table"}
          >
            {/* Table-shaped icon so the handle reads as "tabular cell
                data" rather than just a generic expand chevron. Inline
                SVG (rather than a Unicode glyph) so it renders
                consistently across platforms at this small size. */}
            <svg
              className="explore-drawer-icon"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              aria-hidden="true"
            >
              <rect
                x="1.5"
                y="1.5"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                rx="1.5"
              />
              <line x1="1.5" y1="5" x2="12.5" y2="5" stroke="currentColor" strokeWidth="1" />
              <line x1="1.5" y1="9" x2="12.5" y2="9" stroke="currentColor" strokeWidth="1" />
              <line x1="6" y1="1.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1" />
            </svg>
            <span className="explore-drawer-toggle">{tableOpen ? "▾" : "▴"}</span>
            <span className="explore-drawer-count">
              {cellList.data ? (
                <>
                  <strong>{cellList.data.matched_count.toLocaleString()}</strong>
                  {" of "}
                  <strong>{cellList.data.total_count.toLocaleString()}</strong>
                  {" cells"}
                  {cellList.data.limit_hit && (
                    <em>
                      {" "}— capped at {cellList.data.limit.toLocaleString()}
                    </em>
                  )}
                </>
              ) : cellList.isLoading ? (
                "Loading cells…"
              ) : cellList.isError ? (
                <span className="error">Failed: {String(cellList.error)}</span>
              ) : (
                ""
              )}
            </span>
            {/* Filter menu — popover lives in the drawer header so the
                user edits the filter next to the table the filter
                affects. The whole drawer-handle is a button, so the
                pill wrapper stops propagation to prevent a filter
                click from toggling the drawer open/closed. */}
            <span
              className="explore-pill-wrap"
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              <CellFilterMenu
                columnGroups={cellList.data?.column_groups}
                sampleRows={cellList.data?.rows}
                className="explore-filter-pill"
                placement="up"
                categoriesByTable={
                  currentFt && currentFt.categories.length > 0
                    ? { [currentFt.id]: currentFt.categories }
                    : undefined
                }
              />
            </span>
            <span className="explore-pill-separator" aria-hidden />
            {/* NGL actions — grouped on the left side with the
                count and selection context (where filtering and
                selection actually happen). Both buttons are always
                rendered; "selected" greys out when nothing is row-
                selected so the user can see the action exists even
                when it's not actionable. Live mode disables both. */}
            <NglActionPill
              label="visible"
              count={cellList.data?.matched_count ?? 0}
              disabled={
                !cellList.data ||
                cellList.data.matched_count === 0 ||
                matVersion === "live" ||
                ngl.isPending
              }
              liveDisabled={matVersion === "live"}
              onOpen={() =>
                cellList.data && openInNgl(cellList.data.cell_ids)
              }
            />
            <NglActionPill
              label="selected"
              count={rowSelectedCellIds.length}
              disabled={
                rowSelectedCellIds.length === 0 ||
                matVersion === "live" ||
                ngl.isPending
              }
              liveDisabled={matVersion === "live"}
              onOpen={() => openInNgl(rowSelectedCellIds)}
            />
            {/* Single clear-selection pill — covers both lasso and
                row-click selections now that they share the same
                URL key. Greyed when there's nothing to clear. */}
            <span className="explore-pill-separator" aria-hidden />
            <ClearPill
              label="selection"
              active={rowSelectedCellIds.length > 0}
              onClear={() => setSelTable(null)}
              variant="rowsel"
            />
            {/* Save the current selection as a named cell set. Persists
                in localStorage; surfaces in the rail's SavedSetsPanel
                for later load/union/subtract. Disabled when there's
                nothing to save. The wrapper stops drawer-toggle
                propagation so the popover doesn't open/close the
                drawer when the user types into the rename input. */}
            <span
              className="explore-pill-wrap"
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              <span
                role="button"
                className={`explore-save-pill${
                  rowSelectedCellIds.length === 0 ? " disabled" : ""
                }`}
                aria-disabled={rowSelectedCellIds.length === 0}
                title={
                  rowSelectedCellIds.length === 0
                    ? "Make a selection first"
                    : `Save ${rowSelectedCellIds.length.toLocaleString()} cells as a named set`
                }
                onClick={() => {
                  if (rowSelectedCellIds.length === 0) return;
                  if (savePromptOpen) {
                    closeSavePrompt();
                  } else {
                    openSavePrompt();
                  }
                }}
              >
                ★ Save selection
              </span>
              {savePromptOpen && rowSelectedCellIds.length > 0 && (
                <span className="explore-save-prompt">
                  <input
                    type="text"
                    className="explore-save-prompt-input"
                    value={saveDraftName}
                    autoFocus
                    onChange={(e) => setSaveDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitSavePrompt();
                      if (e.key === "Escape") closeSavePrompt();
                    }}
                  />
                  <button
                    type="button"
                    className="explore-save-prompt-ok"
                    onClick={commitSavePrompt}
                    title="Save"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="explore-save-prompt-cancel"
                    onClick={closeSavePrompt}
                    title="Cancel"
                  >
                    ×
                  </button>
                </span>
              )}
            </span>
          </button>
          {tableOpen && enrichedCells && enrichedCells.rows.length > 0 && (
            <div className="explore-drawer-body">
              {ngl.isError && (
                <div className="explore-ngl-error">
                  NGL link failed: {String(ngl.error)}
                </div>
              )}
              <PartnersTable
                extraActions={
                  <>
                    <button
                      type="button"
                      className="explore-toolbar-btn"
                      disabled={rowSelectedCellIds.length === 0}
                      title={
                        rowSelectedCellIds.length === 0
                          ? "Select some rows first, then snapshot the selection into the visible set"
                          : `Snapshot ${rowSelectedCellIds.length} selected cells as the visible set — the table narrows to these and stays stable while you modify the selection`
                      }
                      onClick={() => setLimitTo(rowSelectedCellIds.join(","))}
                    >
                      Limit visible to selection
                      {rowSelectedCellIds.length > 0 && (
                        <span className="explore-toolbar-btn-count">
                          &nbsp;({rowSelectedCellIds.length})
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="explore-toolbar-btn"
                      disabled={limitToCellIds.length === 0}
                      title={
                        limitToCellIds.length === 0
                          ? "Nothing limiting the visible set right now"
                          : "Drop the snapshot — table returns to the full filter scope"
                      }
                      onClick={() => setLimitTo(null)}
                    >
                      Reset visible
                    </button>
                    {limitToCellIds.length > 0 && (
                      <span className="explore-toolbar-hint">
                        limited to {limitToCellIds.length.toLocaleString()} snapshot
                      </span>
                    )}
                  </>
                }
                ds={ds}
                rootId={ft}
                matVersion={matVersion}
                direction="both"
                rows={enrichedCells.rows}
                columnGroups={enrichedCells.column_groups}
                decorationTables={decorationTables}
                keyColumn="cell_id"
                // Resolve cell_id → root_id at the active mv. Cells
                // that didn't resolve (missing / ambiguous / not yet
                // resolved / live mode) get a "#" href from the
                // resolver below so the link is visually present but
                // doesn't navigate. Inter-view cross-nav: explorer URL
                // state stays put rather than polluting /neuron.
                crossNavHref={cellCrossNavHref}
                enableNglAction={false}
                rowsLabel="cells"
                selectedIds={rowSelectedCellIds}
                onSelectedIdsChange={(ids) =>
                  setSelTable(ids.length > 0 ? ids.join(",") : null)
                }
                externalSelection={
                  limitToCellIds.length > 0 ? limitToCellIds : null
                }
                onRowNglClick={openCellInNgl}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
