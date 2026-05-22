import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useResolveCellIds } from "../../api/cellIds";
import { useSeedSummary } from "../../api/embeddings";

/** Parse a pasted blob of root_ids. Accepts space/comma/newline-separated
 *  lists (Neuroglancer `segments=` URL fragments, notebook clipboard
 *  pastes, column copies all "just work"). Returns the cleaned list of
 *  unique integer-shaped tokens preserving order.
 *
 *  The seed mechanism today binds to a single root_id at a time; the
 *  caller toasts when more than one parses and uses the first. The
 *  parser still returns the full list so the toast can report the
 *  dropped-count accurately. */
function parseRootIds(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (!/^[0-9]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

interface Props {
  /** Datastack — required for the cell_id resolver. */
  ds: string | null;
  /** Active feature table id — required for the feature-table-scoped
   *  seed summary (partner counts restricted to cells in this table). */
  featureTableId: string | null;
  /** Materialization version — required for the resolver. */
  matVersion: number | "live" | null;
  /** Current seed root_id (from `?seed=`), or null when no seed is set. */
  seedRootId: string | null;
  /** Write the seed root_id back to `?seed=`. Pass null to clear. */
  onChange: (next: string | null) => void;
  /** Whether the seed cell is marked with a ring on the scatter. This
   *  is an overlay on top of the visualization (independent of the
   *  color channel), not a plot variable. */
  markSeed: boolean;
  /** Toggle the seed-cell marker. */
  onMarkSeedChange: (next: boolean) => void;
}

/** Left-sidebar widget that holds the explorer's "Connectivity Seed."
 *  Setting a seed exposes server-derived `seed_*` columns
 *  (`seed_is_partner`, `seed_n_syn_out`, etc.) as bindable channels on
 *  the universe scatter and the plot rail — derived from the seed's
 *  cached connectivity bundle, no additional CAVE round-trip when the
 *  seed has been visited recently in `/neuron`.
 *
 *  Multi-seed is a planned extension; today the widget accepts a
 *  pasted list but warns and keeps only the first id. The single-seed
 *  constraint is what keeps the URL short and the column projection
 *  unambiguous. */
export function ConnectivitySeedWidget({
  ds,
  featureTableId,
  matVersion,
  seedRootId,
  onChange,
  markSeed,
  onMarkSeedChange,
}: Props) {
  const [draft, setDraft] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Clear the draft input when the URL state diverges from what we last
  // submitted (e.g. another widget cleared the seed, a recipe applied a
  // new seed). The current `seedRootId` always wins; `draft` is just
  // transient editing buffer.
  const lastSubmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (seedRootId !== lastSubmittedRef.current) {
      setDraft("");
      setWarning(null);
      setError(null);
      lastSubmittedRef.current = seedRootId;
    }
  }, [seedRootId]);

  // Resolve the current seed root_id → cell_id so users can confirm
  // they pasted the right one (and so the breadcrumb shows the
  // canonical cell_id). Skips the request when no seed is set or when
  // the resolver isn't applicable (live mode has no universe cache).
  const resolveArgs = useMemo(() => {
    if (!seedRootId || !ds) return null;
    if (matVersion === "live" || matVersion === null) return null;
    return {
      ds,
      matVersion,
      rootIds: [seedRootId],
    };
  }, [ds, matVersion, seedRootId]);
  const resolved = useResolveCellIds(resolveArgs);

  // Fetch the feature-table-scoped seed summary. This is the actual
  // "connectivity seed work": it builds (and caches) the seed's
  // partner bundle server-side — the same synapse cache `seed_columns()`
  // projects from — so by the time the user binds a `seed_*` channel
  // the data is warm. It also gives a definite "the seed is ready"
  // signal plus the partner counts. The counts are restricted to cells
  // *in this feature table* — the explorer only renders feature-table
  // cells, so the whole-connectome partner count would overstate what
  // the user will actually see highlighted on the scatter.
  const seedSummary = useSeedSummary(
    seedRootId && ds && featureTableId && matVersion !== "live" && matVersion !== null
      ? { ds, featureTableId, matVersion, seedRootId }
      : null,
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setWarning(null);
    const ids = parseRootIds(draft);
    if (ids.length === 0) {
      setError("Paste a root id (integer).");
      return;
    }
    if (ids.length > 1) {
      setWarning(
        `Multi-seed aggregates aren't supported yet — keeping the first id, dropped ${ids.length - 1}.`,
      );
    }
    onChange(ids[0]);
    lastSubmittedRef.current = ids[0];
  };

  const handleClear = () => {
    setDraft("");
    setError(null);
    setWarning(null);
    onChange(null);
    lastSubmittedRef.current = null;
  };

  const resolvedCellId = resolved.data?.root_to_cell?.[seedRootId ?? ""];

  return (
    <div className="seed-widget">
      <form onSubmit={handleSubmit} className="seed-widget-form">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="Paste a root_id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Connectivity seed root_id"
        />
        <button type="submit" disabled={!draft.trim()}>
          Set seed
        </button>
        {seedRootId && (
          <button type="button" onClick={handleClear}>
            Clear
          </button>
        )}
      </form>
      {error && <div className="seed-widget-error">{error}</div>}
      {warning && <div className="seed-widget-warning">{warning}</div>}
      {seedRootId && (
        <div className="seed-widget-active">
          <div>
            <span className="seed-widget-label">Active seed:</span>{" "}
            <code>{seedRootId}</code>
          </div>
          {resolveArgs && (
            <div className="seed-widget-sub">
              {resolved.isLoading
                ? "resolving cell_id…"
                : resolvedCellId
                  ? <>cell_id <code>{String(resolvedCellId)}</code></>
                  : resolved.isError
                    ? <span className="seed-widget-warning">
                        couldn't resolve cell_id
                      </span>
                    : "no cell_id mapped"}
            </div>
          )}
          {/* Connectivity-bundle status — the definitive "seed is
              ready" signal. Until this reads ready, the seed_* columns
              may still be computing on the first plot/table request.
              Partner counts are restricted to cells in this feature
              table (what the scatter will actually highlight). */}
          {resolveArgs && (
            (() => {
              if (seedSummary.isError) {
                return (
                  <div className="seed-widget-status error">
                    ⚠ connectivity failed to load
                  </div>
                );
              }
              const summary = seedSummary.data;
              if (summary) {
                return (
                  <div className="seed-widget-status ready">
                    ✓ connectivity ready —{" "}
                    {summary.n_in.toLocaleString()} in ·{" "}
                    {summary.n_out.toLocaleString()} out partners in this
                    feature table
                  </div>
                );
              }
              return (
                <div className="seed-widget-status loading">
                  <span className="seed-widget-spinner" /> loading
                  connectivity…
                </div>
              );
            })()
          )}
          <label className="seed-widget-toggle">
            <input
              type="checkbox"
              checked={markSeed}
              onChange={(e) => onMarkSeedChange(e.target.checked)}
            />
            Mark seed cell on scatter
          </label>
          <div className="seed-widget-hint">
            Bind <code>seed_partner_dir</code>, <code>seed_n_syn_out</code>,
            or other <code>seed_*</code> columns on the scatter or any
            dynamic plot.
          </div>
        </div>
      )}
      {!seedRootId && (
        <div className="seed-widget-hint">
          Set a seed to enable connectivity-derived columns
          (<code>seed_is_partner</code>, <code>seed_n_syn_out</code>, …).
        </div>
      )}
    </div>
  );
}
