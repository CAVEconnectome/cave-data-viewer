import { useMemo, useState } from "react";
import { useEmbeddingColumn } from "../../api/embeddings";
import { useUrlParam } from "../../hooks/useUrlState";
import type {
  ColumnGroup,
  EmbeddingColumnResponse,
  EmbeddingScatterResponse,
  FeatureTableListItem,
} from "../../api/types";
import { ColumnPicker } from "./ColumnPicker";
import { columnDisplayName } from "../tableColumns";
import { buildHistogram, formatTick } from "./histogram";
import { LinLogToggle } from "./LinLogToggle";

/** Display mode for the panel's histograms.
 *
 *  - **all**: background bars = the full universe, overlay = the active
 *    Filter Scope. "How does my scope compare to the population?"
 *  - **scope**: background bars = the active Filter Scope, overlay = the
 *    effective selection (bag ∩ scope). "How does my selection compare
 *    to the filtered population?"
 *
 *  When no scope is active the two modes collapse (background and
 *  scope are both the universe) and the toggle hides itself. */
type BgMode = "all" | "scope";

interface Props {
  /** Universe scatter response — provides `cell_ids` and the bound
   *  color channel's per-point values + color_map. Null while
   *  loading. */
  scatter?: EmbeddingScatterResponse | null;
  /** The in-scope set — cells passing the active Filter Scope
   *  (predicate `?cells=` or "Filter to selection" snapshot). Null
   *  means the full universe is in scope; bars then show universe
   *  counts only. */
  inScopeCellIds?: Set<string> | null;
  /** The active selection — bag ∩ scope. Drives the overlay in
   *  "vs Scope" mode. Null/empty = no overlay in that mode. */
  selectedCellIds?: Set<string> | null;
  /** Datastack id — required so `useEmbeddingColumn` can route
   *  manual-histogram requests. */
  ds: string | null;
  /** Currently-bound feature table descriptor. Used for the column
   *  picker's category structure + for routing column requests. */
  featureTable: FeatureTableListItem | null;
  /** Column_groups from the /cells response. Lets the column picker
   *  surface attached decoration tables alongside parquet columns. */
  cellsColumnGroups?: ColumnGroup[];
  /** Active mat_version (parsed). Decoration / nucleus columns need
   *  it; pure-parquet columns ignore it. */
  matVersion: number | "live" | null;
  /** Decoration tables currently attached. Manual plots that
   *  reference a decoration column thread these through so the
   *  server doesn't need to re-attach them per request. */
  decorationTables: string[];
}

interface CategoryRow {
  label: string;
  hex: string;
  bgCount: number;
  fgCount: number;
}

const SUMMARY_PLOTS_KEY = "summary_plots";
const SUMMARY_BG_KEY = "summary_bg";

/**
 * Summary panel for the explorer's left rail.
 *
 * Three sections, top-to-bottom:
 *
 * 1. **Count line + bg-mode toggle** — how many cells are in scope vs in
 *    the universe, and a "vs All / vs Scope" toggle that controls what
 *    the histogram background bars represent (see {@link BgMode}). The
 *    toggle hides itself when no scope is active.
 * 2. **Channel-driven plots** — automatic histograms / categorical
 *    breakdowns mirroring whatever the color/size channels are bound
 *    to. Updates as the user binds channels in the rail.
 * 3. **Manual plots** — user-added per-column histograms. State lives
 *    in the `?summary_plots=` URL param (comma-separated dotted column
 *    paths) so a shared link reproduces the rail layout exactly. The
 *    "+ add plot" button at the bottom opens a category-grouped
 *    `ColumnPicker` popover with mass-select affordances per category.
 *
 * Each manual plot independently fetches its universe column via
 * `useEmbeddingColumn`, which caches forever client-side (parquet +
 * decoration snapshots are immutable at a mat_version). Switching
 * channels or filters doesn't refetch the underlying values — only the
 * bg/fg partitions recompute.
 */
export function SummaryPanel({
  scatter,
  inScopeCellIds,
  selectedCellIds,
  ds,
  featureTable,
  cellsColumnGroups,
  matVersion,
  decorationTables,
}: Props) {
  const totalCells = scatter?.n_cells ?? 0;
  const scopeSize = inScopeCellIds?.size ?? 0;
  const selectionSize = selectedCellIds?.size ?? 0;

  const [summaryPlotsRaw, setSummaryPlotsRaw] = useUrlParam(SUMMARY_PLOTS_KEY);
  const [bgModeRaw, setBgModeRaw] = useUrlParam(SUMMARY_BG_KEY);
  const bgMode: BgMode = bgModeRaw === "scope" ? "scope" : "all";
  const [picking, setPicking] = useState(false);

  const manualColumns = useMemo<string[]>(() => {
    if (!summaryPlotsRaw) return [];
    // Dedup while preserving first-occurrence order — a user pasting a
    // doubled list in the URL shouldn't see duplicate histograms.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of summaryPlotsRaw.split(",")) {
      const v = c.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }, [summaryPlotsRaw]);
  const selectedValues = useMemo(() => new Set(manualColumns), [manualColumns]);

  const updateManual = (next: string[]) => {
    setSummaryPlotsRaw(next.length > 0 ? next.join(",") : null);
  };
  const addColumn = (col: string) => {
    if (manualColumns.includes(col)) return;
    updateManual([...manualColumns, col]);
  };
  const removeColumn = (col: string) => {
    updateManual(manualColumns.filter((c) => c !== col));
  };

  // Resolved bg/fg sets given the active mode + the panel inputs. The
  // Both modes overlay the **selection** on the background. The bg
  // mode toggle controls only what the background is (universe in
  // "all" mode, scope in "scope" mode); the foreground is always
  // whatever the user has marked.
  //
  // Historical note: the prior model used the Filter Scope as the fg
  // in "all" mode and the selection only in "scope" mode. That
  // matched the era when Filter Scope was the central editing
  // surface, but with the SelectionBuilder owning predicate building
  // the selection bag is now the user-driven subset that deserves
  // overlay in either mode.
  const hasScope = !!inScopeCellIds;
  const effectiveBgMode: BgMode = hasScope ? bgMode : "all";
  const bgCellIds: Set<string> | null =
    effectiveBgMode === "scope" ? inScopeCellIds ?? null : null;
  const fgCellIds: Set<string> | null = selectedCellIds ?? null;

  // Channel-driven categorical breakdown (same rows as before — colored
  // bars per category, bg + fg overlaid).
  const channelCategories = useMemo<CategoryRow[] | null>(() => {
    const color = scatter?.color;
    if (!color || color.kind !== "categorical") return null;
    return buildCategoryRows(
      color.values as Array<string | null>,
      scatter!.cell_ids,
      color.color_map ?? {},
      bgCellIds,
      fgCellIds,
      totalCells,
    );
  }, [scatter, bgCellIds, fgCellIds, totalCells]);

  if (!scatter) return null;

  // Channel-driven numeric histograms (color + size when bound to
  // numeric columns).
  const numericChannels: Array<{
    key: string;
    column: string;
    values: Array<number | null>;
    color: string;
  }> = [];
  if (scatter.color && scatter.color.kind === "numeric") {
    numericChannels.push({
      key: "color",
      column: scatter.color.column,
      values: scatter.color.values as Array<number | null>,
      color: "#21908d",
    });
  }
  if (scatter.size) {
    numericChannels.push({
      key: "size",
      column: scatter.size.column,
      values: scatter.size.values,
      color: "#f59e0b",
    });
  }

  return (
    <div className="summary-panel">
      {hasScope && (
        <div className="summary-panel-head">
          <BgModeToggle
            value={bgMode}
            onChange={(next) =>
              // Default ("all"): clear the URL key so the share link
              // stays compact. "scope" is the only value that needs
              // to ride the URL.
              setBgModeRaw(next === "scope" ? "scope" : null)
            }
          />
        </div>
      )}
      <div className="summary-panel-count">
        {(() => {
          // Denominator = whatever the bg bars represent. "vs Scope"
          // backgrounds are the scope cells; everything else is the
          // universe. The selection numerator is shown unconditionally
          // when non-empty so the overlay's count is always readable
          // (it's the same number the orange bars represent).
          const bgIsScope =
            hasScope && effectiveBgMode === "scope";
          const denom = bgIsScope ? scopeSize : totalCells;
          const denomLabel = bgIsScope ? "in scope" : "cells";
          if (selectionSize > 0) {
            return (
              <>
                <strong>{selectionSize.toLocaleString()}</strong>
                {" selected of "}
                <strong>{denom.toLocaleString()}</strong>{" "}{denomLabel}
              </>
            );
          }
          return (
            <>
              <strong>{denom.toLocaleString()}</strong>{" "}{denomLabel}
            </>
          );
        })()}
      </div>
      {channelCategories && channelCategories.length > 0 && (
        <CategoricalBreakdown
          column={scatter.color!.column}
          rows={channelCategories}
        />
      )}
      {numericChannels.map((ch) => (
        <NumericHistogram
          key={ch.key}
          column={ch.column}
          values={ch.values}
          cellIds={scatter.cell_ids}
          bgCellIds={bgCellIds}
          fgCellIds={fgCellIds}
          color={ch.color}
        />
      ))}
      {manualColumns.length > 0 && (
        <div className="summary-panel-divider" />
      )}
      {manualColumns.map((col) => (
        <ManualPlot
          key={col}
          column={col}
          ds={ds}
          featureTableId={featureTable?.id ?? null}
          matVersion={matVersion}
          decorationTables={decorationTables}
          bgCellIds={bgCellIds}
          fgCellIds={fgCellIds}
          onRemove={() => removeColumn(col)}
        />
      ))}
      <div className="summary-panel-add-plot">
        <button
          type="button"
          className="summary-panel-add-button"
          onClick={() => setPicking((p) => !p)}
          disabled={!featureTable}
          title={
            featureTable
              ? "Add a histogram for any column"
              : "Pick a feature table first"
          }
        >
          + add plot
        </button>
        {picking && featureTable && (
          <div className="summary-panel-picker-popover">
            <ColumnPicker
              featureTable={featureTable}
              cellsColumnGroups={cellsColumnGroups}
              selectedValues={selectedValues}
              onAdd={(v) => addColumn(v)}
              onRemove={(v) => removeColumn(v)}
              onClose={() => setPicking(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// --- background mode toggle -------------------------------------------------

function BgModeToggle({
  value,
  onChange,
}: {
  value: BgMode;
  onChange: (next: BgMode) => void;
}) {
  return (
    <div
      className="summary-bg-toggle"
      role="group"
      aria-label="Histogram background distribution"
      title="What the background bars represent in the histograms below"
    >
      <button
        type="button"
        className={`summary-bg-toggle-btn${value === "all" ? " active" : ""}`}
        onClick={() => onChange("all")}
        title="Background = full universe; overlay = in-scope cells"
      >
        vs All
      </button>
      <button
        type="button"
        className={`summary-bg-toggle-btn${value === "scope" ? " active" : ""}`}
        onClick={() => onChange("scope")}
        title="Background = in-scope cells; overlay = current selection"
      >
        vs Scope
      </button>
    </div>
  );
}

// --- manual-plot wrapper ----------------------------------------------------

interface ManualPlotProps {
  column: string;
  ds: string | null;
  featureTableId: string | null;
  matVersion: number | "live" | null;
  decorationTables: string[];
  bgCellIds: Set<string> | null;
  fgCellIds: Set<string> | null;
  onRemove: () => void;
}

/**
 * One user-added histogram. Fetches the column's universe values
 * independently of the scatter (its own TanStack Query cache entry)
 * and dispatches to the numeric or categorical renderer.
 *
 * Decoration columns and synthetic nucleus columns go through the
 * resolver, so they only enable when `matVersion` is a real
 * materialization. A live-mode user sees a "manual plot needs a
 * materialized version" placeholder rather than a broken request.
 */
function ManualPlot({
  column,
  ds,
  featureTableId,
  matVersion,
  decorationTables,
  bgCellIds,
  fgCellIds,
  onRemove,
}: ManualPlotProps) {
  // Decoration / nucleus columns require a materialized version. Pure-
  // parquet columns (prefixed with the feature_table id) can fetch in
  // either mode — the universe enrichment is the only path that hits
  // CAVE.
  const isParquet =
    !!featureTableId && column.startsWith(`${featureTableId}.`);
  const liveBlocked = !isParquet && matVersion === "live";

  const q = useEmbeddingColumn(
    ds && featureTableId && !liveBlocked
      ? {
          ds,
          featureTableId,
          column,
          decorationTables,
          matVersion,
        }
      : null,
  );

  return (
    <div className="summary-manual-plot">
      <button
        type="button"
        className="summary-manual-plot-remove"
        title="Remove this plot"
        onClick={onRemove}
      >
        ×
      </button>
      {liveBlocked ? (
        <div className="summary-manual-plot-placeholder" title={bareCol(column)}>
          <div className="summary-panel-cat-title">{bareCol(column)}</div>
          <div className="summary-manual-plot-msg">
            requires a materialized version
          </div>
        </div>
      ) : q.isLoading ? (
        <div className="summary-manual-plot-placeholder" title={bareCol(column)}>
          <div className="summary-panel-cat-title">{bareCol(column)}</div>
          <div className="summary-manual-plot-msg">loading…</div>
        </div>
      ) : q.isError ? (
        <div className="summary-manual-plot-placeholder" title={bareCol(column)}>
          <div className="summary-panel-cat-title">{bareCol(column)}</div>
          <div className="summary-manual-plot-msg error">
            failed: {String(q.error)}
          </div>
        </div>
      ) : q.data ? (
        <ManualPlotBody
          response={q.data}
          bgCellIds={bgCellIds}
          fgCellIds={fgCellIds}
        />
      ) : null}
    </div>
  );
}

function ManualPlotBody({
  response,
  bgCellIds,
  fgCellIds,
}: {
  response: EmbeddingColumnResponse;
  bgCellIds: Set<string> | null;
  fgCellIds: Set<string> | null;
}) {
  if (response.kind === "numeric") {
    return (
      <NumericHistogram
        column={response.column}
        values={response.values as Array<number | null>}
        cellIds={response.cell_ids}
        bgCellIds={bgCellIds}
        fgCellIds={fgCellIds}
        // Distinct color from the channel-driven plots so the user
        // can see at a glance "this row came from a manual add."
        color="#6366f1"
      />
    );
  }
  // Categorical: project palette via the response's color_map. Build
  // the same breakdown rows the channel-driven categorical panel uses
  // so the look is consistent.
  const rows = buildCategoryRows(
    response.values as Array<string | null>,
    response.cell_ids,
    response.color_map ?? {},
    bgCellIds,
    fgCellIds,
    response.n_cells,
  );
  if (!rows || rows.length === 0) {
    return (
      <div className="summary-manual-plot-placeholder" title={bareCol(response.column)}>
        <div className="summary-panel-cat-title">{bareCol(response.column)}</div>
        <div className="summary-manual-plot-msg">no values</div>
      </div>
    );
  }
  return <CategoricalBreakdown column={response.column} rows={rows} />;
}

// --- shared rendering primitives --------------------------------------------

function CategoricalBreakdown({
  column,
  rows,
}: {
  column: string;
  rows: CategoryRow[];
}) {
  const maxBg = Math.max(...rows.map((c) => c.bgCount), 1);
  return (
    <div className="summary-panel-categories" title={bareCol(column)}>
      <div className="summary-panel-cat-title">{bareCol(column)}</div>
      {rows.map((cat) => (
        <SummaryRow key={cat.label} cat={cat} maxBg={maxBg} />
      ))}
    </div>
  );
}

/** Build per-category counts for the bg + fg distributions. `bgCellIds`
 *  filters the background bar (null = include all cells); `fgCellIds`
 *  filters the foreground overlay bar (null/empty = no overlay). */
function buildCategoryRows(
  values: Array<string | null>,
  cellIds: string[],
  colorMap: Record<string, string>,
  bgCellIds: Set<string> | null,
  fgCellIds: Set<string> | null,
  totalCells: number,
): CategoryRow[] {
  const bgCounts = new Map<string, number>();
  const fgCounts = new Map<string, number>();
  let bgTotal = 0;
  for (let i = 0; i < values.length; i++) {
    const id = cellIds[i];
    if (bgCellIds && !bgCellIds.has(id)) continue;
    const raw = values[i];
    const key = raw === null || raw === undefined ? "(none)" : String(raw);
    bgCounts.set(key, (bgCounts.get(key) ?? 0) + 1);
    bgTotal += 1;
    if (fgCellIds && fgCellIds.has(id)) {
      fgCounts.set(key, (fgCounts.get(key) ?? 0) + 1);
    }
  }
  const out: CategoryRow[] = [];
  // Use `totalCells` for the "(none)" drop heuristic — the heuristic
  // is about absolute prevalence in the data, not the background
  // subset, so a tiny scope's "(none)" doesn't get hidden by the
  // 5%-of-universe threshold.
  const noneThresholdBase = totalCells > 0 ? totalCells : bgTotal;
  for (const [label, count] of bgCounts.entries()) {
    // Drop the "(none)" / null slot from the displayed rows when it
    // would be visually noisy. Keep it when it's a meaningful slice
    // (>5% of the universe) so the user knows it exists.
    if (label === "(none)" && noneThresholdBase > 0 && count / noneThresholdBase < 0.05)
      continue;
    out.push({
      label,
      hex: colorMap[label] ?? "#dcdcdc",
      bgCount: count,
      fgCount: fgCounts.get(label) ?? 0,
    });
  }
  out.sort((a, b) => b.bgCount - a.bgCount);
  return out;
}

interface NumericHistogramProps {
  column: string;
  values: Array<number | null>;
  cellIds: string[];
  bgCellIds: Set<string> | null;
  fgCellIds: Set<string> | null;
  /** Hex color for the foreground bars. Defaults to the project's
   *  accent orange so unbound (e.g. selection-only) cases still read. */
  color?: string;
}

function NumericHistogram({
  column,
  values,
  cellIds,
  bgCellIds,
  fgCellIds,
  color = "#f59e0b",
}: NumericHistogramProps) {
  // Local binning state per histogram instance. Re-binning is a single
  // pass over the values (fast even at 94k cells) so the flip is
  // instant — no need for URL persistence.
  const [binning, setBinning] = useState<"linear" | "log">("linear");
  const bins = useMemo(
    () => buildHistogram(values, cellIds, bgCellIds, fgCellIds, 60, binning),
    [values, cellIds, bgCellIds, fgCellIds, binning],
  );

  if (!bins || bins.bgDensity.length === 0) return null;

  const width = 240;
  const height = 46;
  const innerH = height;
  // Both distributions are area-normalized to sum 1 so a small
  // foreground subset is visually comparable to the full background's
  // distribution shape. Absolute counts live in the count line above.
  const maxDensity = Math.max(1e-9, ...bins.bgDensity, ...bins.fgDensity);
  const heightFor = (d: number): number => (d / maxDensity) * innerH;
  const hasFg = bins.fgDensity.some((d) => d > 0);

  // Bin edges drive bar X positions — log-binned bars come out narrow
  // at the small end and wider at the large end automatically. Edge
  // → fraction-of-width via the same log-aware projection the
  // SelectionBuilder uses (kept inline rather than shared because the
  // Summary histogram has no click/drag surface).
  const mn = bins.binMin;
  const mx = bins.binMax;
  const valueToFrac = (v: number): number => {
    if (bins.binning === "log" && mn > 0) {
      const logMn = Math.log(mn);
      const logMx = Math.log(mx);
      const logSpan = logMx - logMn || 1;
      return (Math.log(Math.max(v, mn)) - logMn) / logSpan;
    }
    const span = mx - mn || 1;
    return (v - mn) / span;
  };

  const logUnavailable = mn <= 0;
  const toggleTitle = logUnavailable
    ? "Log binning needs all positive values; this column has values ≤ 0"
    : bins.binning === "log"
      ? "X-axis bins are log-spaced — click for linear"
      : "X-axis bins are linear — click for log";

  return (
    <div className="summary-histogram" title={bareCol(column)}>
      <div className="summary-panel-cat-title">{bareCol(column)}</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="summary-histogram-svg"
        preserveAspectRatio="none"
      >
        {bins.bgDensity.map((bg, i) => {
          const xLeft = valueToFrac(bins.binEdges[i]) * width;
          const xRight = valueToFrac(bins.binEdges[i + 1]) * width;
          const barW = Math.max(0, xRight - xLeft);
          const h = heightFor(bg);
          const fg = bins.fgDensity[i];
          const fgH = heightFor(fg);
          return (
            <g key={i}>
              <rect
                x={xLeft + 0.5}
                y={innerH - h}
                width={Math.max(0, barW - 1)}
                height={h}
                fill="rgba(0, 0, 0, 0.18)"
              />
              {hasFg && fg > 0 && (
                <rect
                  x={xLeft + 0.5}
                  y={innerH - fgH}
                  width={Math.max(0, barW - 1)}
                  height={fgH}
                  fill={color}
                  opacity={0.8}
                />
              )}
            </g>
          );
        })}
      </svg>
      {/* Tick row in HTML so the rail's resize handle doesn't stretch
          the text glyphs horizontally. */}
      <div className="summary-histogram-ticks">
        <span>{formatTick(bins.binMin)}</span>
        <span className="summary-histogram-ticks-right">
          <span>{formatTick(bins.binMax)}</span>
          <LinLogToggle
            value={binning === "log" ? "log" : "lin"}
            onChange={(v) => setBinning(v === "log" ? "log" : "linear")}
            disabled={logUnavailable}
            title={toggleTitle}
          />
        </span>
      </div>
    </div>
  );
}

// `buildHistogram`, `HistogramData`, and `formatTick` live in
// ./histogram.ts — shared with the Selection Builder's numeric
// predicate widget so the two surfaces bin and label identically.

function SummaryRow({
  cat,
  maxBg,
}: {
  cat: CategoryRow;
  maxBg: number;
}) {
  const bgPct = (cat.bgCount / maxBg) * 100;
  const fgPctOfMax = (cat.fgCount / maxBg) * 100;
  return (
    <div className="summary-row">
      <div className="summary-row-label" title={cat.label}>
        <span
          className="summary-row-swatch"
          style={{ background: cat.hex }}
        />
        <span className="summary-row-name">{cat.label}</span>
      </div>
      <div className="summary-row-bar-wrap">
        <div
          className="summary-row-bar-universe"
          style={{ width: `${bgPct}%` }}
        />
        {cat.fgCount > 0 && (
          <div
            className="summary-row-bar-highlight"
            style={{
              width: `${fgPctOfMax}%`,
              background: cat.hex,
            }}
          />
        )}
      </div>
      <div className="summary-row-count">
        {cat.fgCount > 0 ? (
          <>
            {cat.fgCount.toLocaleString()}
            <span className="summary-row-count-of">/</span>
            {cat.bgCount.toLocaleString()}
          </>
        ) : (
          cat.bgCount.toLocaleString()
        )}
      </div>
    </div>
  );
}

function bareCol(col: string): string {
  const dot = col.indexOf(".");
  const stripped = dot >= 0 ? col.slice(dot + 1) : col;
  return columnDisplayName(stripped);
}
