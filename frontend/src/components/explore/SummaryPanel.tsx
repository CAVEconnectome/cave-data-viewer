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

interface Props {
  /** Universe scatter response — provides `cell_ids` and the bound
   *  color channel's per-point values + color_map. Null while
   *  loading. */
  scatter?: EmbeddingScatterResponse | null;
  /** The highlight set — typically (filter ∩ lasso). Null when nothing
   *  narrows the universe; bars then show universe counts only. */
  highlightedCellIds?: Set<string> | null;
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
  universeCount: number;
  highlightCount: number;
}

const SUMMARY_PLOTS_KEY = "summary_plots";

/**
 * Summary panel for the explorer's left rail.
 *
 * Three sections, top-to-bottom:
 *
 * 1. **Count line** — how many cells are highlighted vs in the universe.
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
 * highlight overlay recomputes.
 */
export function SummaryPanel({
  scatter,
  highlightedCellIds,
  ds,
  featureTable,
  cellsColumnGroups,
  matVersion,
  decorationTables,
}: Props) {
  const totalCells = scatter?.n_cells ?? 0;
  const highlightSize = highlightedCellIds?.size ?? 0;

  const [summaryPlotsRaw, setSummaryPlotsRaw] = useUrlParam(SUMMARY_PLOTS_KEY);
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

  // Channel-driven categorical breakdown (same rows as before — colored
  // bars per category, universe + highlight overlaid).
  const channelCategories = useMemo<CategoryRow[] | null>(() => {
    const color = scatter?.color;
    if (!color || color.kind !== "categorical") return null;
    return buildCategoryRows(
      color.values as Array<string | null>,
      scatter!.cell_ids,
      color.color_map ?? {},
      highlightedCellIds,
      totalCells,
    );
  }, [scatter, highlightedCellIds, totalCells]);

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
      <div className="explore-picker-label">Summary</div>
      <div className="summary-panel-count">
        {highlightedCellIds && highlightSize > 0 ? (
          <>
            <strong>{highlightSize.toLocaleString()}</strong> of{" "}
            <strong>{totalCells.toLocaleString()}</strong> cells in scope
          </>
        ) : (
          <>
            <strong>{totalCells.toLocaleString()}</strong> cells total
          </>
        )}
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
          highlightedCellIds={highlightedCellIds ?? null}
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
          highlightedCellIds={highlightedCellIds ?? null}
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

// --- manual-plot wrapper ----------------------------------------------------

interface ManualPlotProps {
  column: string;
  ds: string | null;
  featureTableId: string | null;
  matVersion: number | "live" | null;
  decorationTables: string[];
  highlightedCellIds: Set<string> | null;
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
  highlightedCellIds,
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
        <div className="summary-manual-plot-placeholder" title={column}>
          <div className="summary-panel-cat-title">{bareCol(column)}</div>
          <div className="summary-manual-plot-msg">
            requires a materialized version
          </div>
        </div>
      ) : q.isLoading ? (
        <div className="summary-manual-plot-placeholder" title={column}>
          <div className="summary-panel-cat-title">{bareCol(column)}</div>
          <div className="summary-manual-plot-msg">loading…</div>
        </div>
      ) : q.isError ? (
        <div className="summary-manual-plot-placeholder" title={column}>
          <div className="summary-panel-cat-title">{bareCol(column)}</div>
          <div className="summary-manual-plot-msg error">
            failed: {String(q.error)}
          </div>
        </div>
      ) : q.data ? (
        <ManualPlotBody
          response={q.data}
          highlightedCellIds={highlightedCellIds}
        />
      ) : null}
    </div>
  );
}

function ManualPlotBody({
  response,
  highlightedCellIds,
}: {
  response: EmbeddingColumnResponse;
  highlightedCellIds: Set<string> | null;
}) {
  if (response.kind === "numeric") {
    return (
      <NumericHistogram
        column={response.column}
        values={response.values as Array<number | null>}
        cellIds={response.cell_ids}
        highlightedCellIds={highlightedCellIds}
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
    highlightedCellIds,
    response.n_cells,
  );
  if (!rows || rows.length === 0) {
    return (
      <div className="summary-manual-plot-placeholder" title={response.column}>
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
  const maxUniverse = Math.max(...rows.map((c) => c.universeCount), 1);
  return (
    <div className="summary-panel-categories" title={column}>
      <div className="summary-panel-cat-title">{bareCol(column)}</div>
      {rows.map((cat) => (
        <SummaryRow key={cat.label} cat={cat} maxUniverse={maxUniverse} />
      ))}
    </div>
  );
}

function buildCategoryRows(
  values: Array<string | null>,
  cellIds: string[],
  colorMap: Record<string, string>,
  highlight: Set<string> | null | undefined,
  totalCells: number,
): CategoryRow[] {
  const universe = new Map<string, number>();
  const highlightCounts = new Map<string, number>();
  for (let i = 0; i < values.length; i++) {
    const raw = values[i];
    const key = raw === null || raw === undefined ? "(none)" : String(raw);
    universe.set(key, (universe.get(key) ?? 0) + 1);
    if (highlight && highlight.has(cellIds[i])) {
      highlightCounts.set(key, (highlightCounts.get(key) ?? 0) + 1);
    }
  }
  const out: CategoryRow[] = [];
  for (const [label, count] of universe.entries()) {
    // Drop the "(none)" / null slot from the displayed rows when it
    // would be visually noisy. Keep it when it's a meaningful slice
    // (>5% of the universe) so the user knows it exists.
    if (label === "(none)" && totalCells > 0 && count / totalCells < 0.05)
      continue;
    out.push({
      label,
      hex: colorMap[label] ?? "#dcdcdc",
      universeCount: count,
      highlightCount: highlightCounts.get(label) ?? 0,
    });
  }
  out.sort((a, b) => b.universeCount - a.universeCount);
  return out;
}

interface NumericHistogramProps {
  column: string;
  values: Array<number | null>;
  cellIds: string[];
  highlightedCellIds: Set<string> | null;
  /** Hex color for the highlight bars. Defaults to the project's
   *  accent orange so unbound (e.g. lasso-only) cases still read. */
  color?: string;
}

function NumericHistogram({
  column,
  values,
  cellIds,
  highlightedCellIds,
  color = "#f59e0b",
}: NumericHistogramProps) {
  const bins = useMemo(
    () => buildHistogram(values, cellIds, highlightedCellIds, 24),
    [values, cellIds, highlightedCellIds],
  );

  if (!bins || bins.universeDensity.length === 0) return null;

  const width = 240;
  // Reduced from the previous 60→46 — the axis-tick row is now rendered
  // in HTML below the SVG (preserveAspectRatio="none" stretched the
  // SVG <text> glyphs horizontally at wider rail widths). The visual
  // height the user sees is still ~60px after the HTML row underneath.
  const height = 46;
  const padLeft = 0;
  const innerW = width - padLeft;
  const innerH = height;
  // Both distributions are area-normalized to sum 1; the y-axis is
  // shared and scales to the larger of the two distributions' max
  // bin. Result: subset bars and universe bars are visually
  // comparable as *shapes* — the user can see a distribution shift
  // even when the subset is 444 cells out of 94k. Absolute counts
  // are shown above the histogram in the "N of M cells in scope"
  // line.
  const maxDensity = Math.max(
    1e-9,
    ...bins.universeDensity,
    ...bins.highlightDensity,
  );
  const barW = innerW / bins.universeDensity.length;
  const hasHighlight = bins.highlightDensity.some((d) => d > 0);

  return (
    <div className="summary-histogram" title={column}>
      <div className="summary-panel-cat-title">{bareCol(column)}</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="summary-histogram-svg"
        preserveAspectRatio="none"
      >
        {bins.universeDensity.map((u, i) => {
          const h = (u / maxDensity) * innerH;
          const hl = bins.highlightDensity[i];
          const hlH = (hl / maxDensity) * innerH;
          const x = padLeft + i * barW;
          return (
            <g key={i}>
              {/* Universe bar (gray). */}
              <rect
                x={x + 0.5}
                y={innerH - h}
                width={Math.max(0, barW - 1)}
                height={h}
                fill="rgba(0, 0, 0, 0.18)"
              />
              {/* Highlight overlay (in the channel color). Density-
                  normalized so a small subset is still visible at
                  comparable scale to the universe distribution. */}
              {hasHighlight && hl > 0 && (
                <rect
                  x={x + 0.5}
                  y={innerH - hlH}
                  width={Math.max(0, barW - 1)}
                  height={hlH}
                  fill={color}
                  opacity={0.8}
                />
              )}
            </g>
          );
        })}
      </svg>
      {/* Tick row in HTML so the rail's resize handle doesn't stretch
          the text glyphs horizontally (which is what the SVG-internal
          tick text suffered from with preserveAspectRatio="none"). */}
      <div className="summary-histogram-ticks">
        <span>{formatTick(bins.binMin)}</span>
        <span>{formatTick(bins.binMax)}</span>
      </div>
    </div>
  );
}

interface HistogramData {
  /** Universe distribution density (each value = bin count /
   *  universe total; sums to 1). */
  universeDensity: number[];
  /** Highlight distribution density (each value = bin count /
   *  highlight total; sums to 1 when the highlight is non-empty,
   *  else all zeros). */
  highlightDensity: number[];
  binMin: number;
  binMax: number;
}

function buildHistogram(
  values: Array<number | null>,
  cellIds: string[],
  highlight: Set<string> | null,
  nBins: number,
): HistogramData | null {
  // Pass 1: extent over finite values.
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn)) return null;

  const binsLen = mx === mn ? 1 : nBins;
  const binCounts = new Array<number>(binsLen).fill(0);
  const highlightCounts = new Array<number>(binsLen).fill(0);
  let universeTotal = 0;
  let highlightTotal = 0;

  if (mx === mn) {
    // Constant column — single bin so the panel renders without a
    // divide-by-zero downstream.
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      binCounts[0] += 1;
      universeTotal += 1;
      if (highlight && highlight.has(cellIds[i])) {
        highlightCounts[0] += 1;
        highlightTotal += 1;
      }
    }
  } else {
    const span = mx - mn;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      let bin = Math.floor(((v - mn) / span) * nBins);
      if (bin >= nBins) bin = nBins - 1; // clamp the max-value point
      binCounts[bin] += 1;
      universeTotal += 1;
      if (highlight && highlight.has(cellIds[i])) {
        highlightCounts[bin] += 1;
        highlightTotal += 1;
      }
    }
  }

  // Normalize to densities (each distribution sums to 1) so a small
  // subset's shape is visually comparable to the full universe's.
  const universeDensity = binCounts.map((c) =>
    universeTotal > 0 ? c / universeTotal : 0,
  );
  const highlightDensity = highlightCounts.map((c) =>
    highlightTotal > 0 ? c / highlightTotal : 0,
  );
  return { universeDensity, highlightDensity, binMin: mn, binMax: mx };
}

function formatTick(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0))
    return n.toExponential(1);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(2);
}

function SummaryRow({
  cat,
  maxUniverse,
}: {
  cat: CategoryRow;
  maxUniverse: number;
}) {
  const universePct = (cat.universeCount / maxUniverse) * 100;
  const highlightPctOfMax = (cat.highlightCount / maxUniverse) * 100;
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
          style={{ width: `${universePct}%` }}
        />
        {cat.highlightCount > 0 && (
          <div
            className="summary-row-bar-highlight"
            style={{
              width: `${highlightPctOfMax}%`,
              background: cat.hex,
            }}
          />
        )}
      </div>
      <div className="summary-row-count">
        {cat.highlightCount > 0 ? (
          <>
            {cat.highlightCount.toLocaleString()}
            <span className="summary-row-count-of">/</span>
            {cat.universeCount.toLocaleString()}
          </>
        ) : (
          cat.universeCount.toLocaleString()
        )}
      </div>
    </div>
  );
}

function bareCol(col: string): string {
  const dot = col.indexOf(".");
  return dot >= 0 ? col.slice(dot + 1) : col;
}
