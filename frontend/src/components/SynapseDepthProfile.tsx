import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ConnectivityBundle, SummaryPanel, SynapseDepthProfileData } from "../api/types";
import { applyTheme } from "../plots/theme";

/**
 * Per-neuron synapse depth profile — a two-color histogram of all input
 * and output synapses along the cortical-depth axis. Renders entirely on
 * the SPA from a `SummaryPanel` of `kind === "synapse_depth_profile"`
 * (computed once at bundle assembly time by the cortex spatial provider);
 * no plot-endpoint round-trip.
 *
 * Lives in the analytics rail as a special-purpose summary panel, opted
 * into via "+ Add plot → Synapse depth profile". The rail's dispatch
 * (`SummaryPanels.tsx`) finds the matching panel by kind and mounts this
 * component, or skips it when the provider didn't emit one (datastack
 * without a spatial transform, or a non-cortex provider).
 *
 * Visual conventions:
 *   - Horizontal bars (depth on y-axis, count on x-axis), pia at top
 *     via reversed range — matches the rest of the app's depth charts.
 *   - `barmode="overlay"` with each trace at ~0.55 opacity, so input /
 *     output overlap reads as a darker blend (easier than mentally
 *     summing side-by-side bars).
 *   - Colors: TAB10[0] (blue, input) and TAB10[3] (red, output). Pulled
 *     from the SPA's CSS tokens via `theme.ts` for consistency with the
 *     rest of the rail.
 *   - Layer guides + range pinning when the bundle ships them — same
 *     visual language as the backend's `_apply_depth_guides` so a
 *     stripplot of `median_syn_depth` and this summary line up.
 */

const PLOTLY_CONFIG = { displaylogo: false, responsive: true };

// Reuses the same module the PlotPanel does — once one of them loads
// plotly, the other doesn't pay again.
const Plot = lazy(async () => {
  const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
    import("react-plotly.js/factory"),
    import("plotly.js-cartesian-dist-min"),
  ]);
  return { default: createPlotlyComponent(Plotly.default) };
});

// Layer-guide styling. Mirrors `_DEPTH_LINE_COLOR` / `_DEPTH_LABEL_COLOR`
// in `services/plots.py` so client-side and backend-rendered depth
// charts use the same visual vocabulary.
const LAYER_LINE_COLOR = "rgba(120, 120, 120, 0.45)";
const LAYER_LABEL_COLOR = "rgba(120, 120, 120, 0.95)";

// Input / output colors — TAB10's first and fourth entries. Hardcoded
// here rather than reading from CSS because react-plotly receives these
// as bare hex; keeping them in sync with `--cat-1` / `--cat-4` in
// `styles.css` is one of the costs of the dual-source pattern. If they
// drift, both bars and the SPA's stripplot legend swatches will move
// in lockstep, so the worst case is a one-line edit.
const COLOR_INPUT = "#1f77b4";
const COLOR_OUTPUT = "#d62728";

// Cell-soma reference line. Mirrors `_CELL_MARKER_COLOR` /
// `_CELL_MARKER_LINE_WIDTH` in `services/plots.py` so the dynamic
// plots' soma marker and this summary's reference line share a visual
// vocabulary — a black dashed glyph means "this is the queried cell"
// across the whole rail.
const CELL_LINE_COLOR = "rgba(0, 0, 0, 0.85)";
const CELL_LINE_WIDTH = 1.2;

interface Props {
  /** The `synapse_depth_profile` summary panel from `bundle.summary_panels`.
   *  May be null when the dispatcher couldn't find one (provider didn't
   *  emit it for this cell); the component renders null in that case. */
  panel: SummaryPanel | null;
  bundle: ConnectivityBundle;
  onClose?: () => void;
  /** Reorder handlers, mirroring `<DynamicPlotPanel>`. Undefined when
   *  this panel is at the top/bottom of the rail; renders disabled
   *  buttons in that case. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  height?: number;
}

export function SynapseDepthProfile({ panel, bundle, onClose, onMoveUp, onMoveDown, height = 320 }: Props) {
  const profile = (panel?.data as SynapseDepthProfileData | undefined) ?? null;

  // "count" → raw synapse counts per bin (the default).
  // "fraction" → each direction normalized to its own total, so the two
  // distributions compare in shape regardless of the input/output count
  // imbalance. Useful when one direction has 10x more synapses than
  // the other and the smaller curve becomes invisible at count scale.
  const [scale, setScale] = useState<"count" | "fraction">("count");

  // Cell-soma marker — a horizontal dashed line at the queried cell's
  // own soma depth. Mirrors the toggle on dynamic plots, but kept as
  // local component state (not URL state) to match the existing `scale`
  // toggle's pattern — this panel doesn't otherwise carry per-instance
  // URL config, and adding it for a single boolean would be more
  // complexity than payoff. Default ON.
  const [showCellDepth, setShowCellDepth] = useState(true);
  // Read the queried cell's soma depth from the bundle's root record.
  // Coerced through `Number()` since `PartnerRecord` values are typed
  // as `unknown`; non-finite (missing soma, no transform configured)
  // hides the toggle entirely so an inert control isn't shown.
  const cellDepth = useMemo<number | null>(() => {
    const v = bundle.root_record?.soma_depth as unknown;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  }, [bundle.root_record]);

  // Modal state. ESC closes; matches the DynamicPlotPanel pattern so
  // the rail's two flavours of panel behave the same way.
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // The analytics-rail dispatch can mount this panel unconditionally —
  // when the datastack has no transform configured (or no synapses to
  // bin) the bundle field is absent and we render nothing. Avoids a
  // dangling empty panel after a datastack change.
  if (!profile) return null;

  // Bin centers (where the bars actually sit) — averaging adjacent
  // edges gives N centers from the N+1 edges. Layout-side range
  // anchors to the original bin_edges so depth_range bookends are
  // honored when the datastack provides them.
  const binCenters = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < profile.bin_edges.length - 1; i += 1) {
      out.push((profile.bin_edges[i] + profile.bin_edges[i + 1]) / 2);
    }
    return out;
  }, [profile.bin_edges]);

  // `bar` thickness — the average bin width. Plotly auto-sizes
  // horizontal bars from data spacing; setting it explicitly lets the
  // overlay render with consistent width even if the depth_range
  // changes between datastacks.
  const binWidth = useMemo(() => {
    if (profile.bin_edges.length < 2) return 0;
    return (profile.bin_edges[profile.bin_edges.length - 1] - profile.bin_edges[0]) / (profile.bin_edges.length - 1);
  }, [profile.bin_edges]);

  // Y-axis range: pia at top via reversed tuple. Falls back to
  // [bin_edges[-1], bin_edges[0]] when the datastack didn't supply an
  // explicit depth_range (still produces a depth-correct chart, just
  // not comparable across neurons).
  const yRange = useMemo<[number, number]>(() => {
    if (profile.depth_range) return [profile.depth_range[1], profile.depth_range[0]];
    const e = profile.bin_edges;
    return [e[e.length - 1], e[0]];
  }, [profile.depth_range, profile.bin_edges]);

  // Layer guides — horizontal lines at each boundary depth + label
  // annotations at each region's midpoint. Plus the optional cell-soma
  // marker (a darker dashed line at the queried cell's own depth)
  // when `showCellDepth` is on and the bundle carries a soma_depth.
  // Layout="above" so the cell line sits over the bars (it's a
  // reference glyph the user is actively asking to see); layer guides
  // stay "below" so the data remains the visual focus there.
  const { shapes, annotations } = useMemo(() => {
    const sh: object[] = [];
    const an: object[] = [];
    if (profile.layer_boundaries) {
      for (const boundary of profile.layer_boundaries) {
        sh.push({
          type: "line",
          xref: "paper",
          x0: 0, x1: 1,
          yref: "y",
          y0: boundary, y1: boundary,
          line: { color: LAYER_LINE_COLOR, width: 1, dash: "dot" },
          layer: "below",
        });
      }

      // Region labels: edges = [depth_range[0], ...layer_boundaries, depth_range[1]].
      // `layer_names[i]` labels the region whose bottom is `layer_boundaries[i]`.
      if (profile.depth_range && profile.layer_names) {
        const edges = [profile.depth_range[0], ...profile.layer_boundaries, profile.depth_range[1]];
        for (let i = 0; i < profile.layer_names.length && i + 1 < edges.length; i += 1) {
          const top = edges[i];
          const bottom = edges[i + 1];
          an.push({
            xref: "paper",
            yref: "y",
            x: 0.005, y: (top + bottom) / 2,
            text: profile.layer_names[i],
            showarrow: false,
            font: { size: 10, color: LAYER_LABEL_COLOR },
            xanchor: "left",
            yanchor: "middle",
          });
        }
      }
    }

    if (showCellDepth && cellDepth !== null) {
      sh.push({
        type: "line",
        xref: "paper",
        x0: 0, x1: 1,
        yref: "y",
        y0: cellDepth, y1: cellDepth,
        line: { color: CELL_LINE_COLOR, width: CELL_LINE_WIDTH, dash: "dash" },
        layer: "above",
      });
    }
    return { shapes: sh, annotations: an };
  }, [profile.layer_boundaries, profile.layer_names, profile.depth_range, showCellDepth, cellDepth]);

  // In "fraction" mode each direction is divided by its own total so
  // the two curves render at comparable scale. Falls back to raw counts
  // when a direction has zero synapses (avoid divide-by-zero) — that
  // direction's bars just stay at zero, which is correct.
  const totalIn = useMemo(() => profile.counts_in.reduce((a, b) => a + b, 0), [profile.counts_in]);
  const totalOut = useMemo(() => profile.counts_out.reduce((a, b) => a + b, 0), [profile.counts_out]);
  const yIn = useMemo(
    () => (scale === "fraction" && totalIn > 0
      ? profile.counts_in.map((c) => c / totalIn)
      : profile.counts_in),
    [profile.counts_in, scale, totalIn],
  );
  const yOut = useMemo(
    () => (scale === "fraction" && totalOut > 0
      ? profile.counts_out.map((c) => c / totalOut)
      : profile.counts_out),
    [profile.counts_out, scale, totalOut],
  );
  // Hover formatting per scale — fractions read better as 3-decimal /
  // percent than raw 0.0123 numbers; keep counts as integers.
  const hoverFmt = scale === "fraction" ? "%{x:.1%}" : "%{x}";

  // Two horizontal bar traces, overlaid. `customdata` left empty —
  // brushing a per-cell summary doesn't have a partner-row vocabulary
  // to map back to.
  const data = useMemo(() => [
    {
      type: "bar",
      orientation: "h",
      x: yIn,
      y: binCenters,
      width: Array(binCenters.length).fill(binWidth),
      name: "input",
      marker: { color: COLOR_INPUT, opacity: 0.55 },
      hovertemplate: `depth %{y:.0f} µm<br>input: ${hoverFmt}<extra></extra>`,
    },
    {
      type: "bar",
      orientation: "h",
      x: yOut,
      y: binCenters,
      width: Array(binCenters.length).fill(binWidth),
      name: "output",
      marker: { color: COLOR_OUTPUT, opacity: 0.55 },
      hovertemplate: `depth %{y:.0f} µm<br>output: ${hoverFmt}<extra></extra>`,
    },
  ], [yIn, yOut, binCenters, binWidth, hoverFmt]);

  // Theme injects fonts / paper bg / gridcolor; we add the histogram-
  // specific bits on top.
  const layout = useMemo(() => {
    const themed = applyTheme({
      data: [],
      layout: {
        barmode: "overlay",
        showlegend: true,
        legend: { x: 1, xanchor: "right", y: 1, yanchor: "top" },
        xaxis: {
          title: { text: scale === "fraction" ? "fraction of synapses" : "synapse count" },
          tickformat: scale === "fraction" ? ".0%" : undefined,
        },
        yaxis: {
          title: { text: profile.depth_axis_name },
          range: yRange,
          autorange: false,
          showgrid: false,
          zeroline: false,
        },
        shapes,
        annotations,
      },
    });
    return {
      ...(themed.layout as object),
      autosize: true,
      margin: { l: 60, r: 16, t: 16, b: 40 },
    };
  }, [yRange, shapes, annotations, profile.depth_axis_name, scale]);

  const style = useMemo(() => ({ width: "100%", height: `${height}px` }), [height]);

  return (
    <>
      <div className="plot-panel">
        <div className="plot-panel-header dynamic">
          <button type="button" className="dynamic-summary" tabIndex={-1}>
            <span className="dynamic-summary-text">Synapse depth profile</span>
          </button>
          {/* Scale toggle — count vs per-direction fraction. Pill button
              that flips on click, matching the visual weight of the
              other inline header controls. Title clarifies the off
              state for users discovering the affordance. */}
          {/* Scale toggle. Single-character glyphs (`#` for counts, `%` for
              fraction) keep the button width constant across modes — the
              full word "fraction" was wide enough to push the close button
              onto a second header row on narrower panels. Title preserves
              the verbose explanation for accessibility / discoverability. */}
          <button
            type="button"
            className={`dynamic-scale${scale === "fraction" ? " active" : ""}`}
            onClick={() => setScale((s) => (s === "count" ? "fraction" : "count"))}
            title={
              scale === "fraction"
                ? "Showing fraction per direction (click for counts)"
                : "Showing synapse counts (click for per-direction fraction)"
            }
            aria-label={scale === "fraction" ? "Showing fraction" : "Showing counts"}
          >
            {scale === "fraction" ? "%" : "#"}
          </button>
          {/* Cell-soma marker toggle — hidden when the bundle has no
              soma_depth (datastack without a transform, or queried cell
              missing from the soma table) so an inert button isn't
              shown. Same visual style as the dynamic plots' ⊙ toggle. */}
          {cellDepth !== null && (
            <button
              type="button"
              className={`dynamic-cell-depth${showCellDepth ? " active" : ""}`}
              onClick={() => setShowCellDepth((v) => !v)}
              title={
                showCellDepth
                  ? "Hide cell soma reference (dashed black line at the queried cell's depth)"
                  : "Show queried cell's soma as a dashed black line at its depth"
              }
              aria-pressed={showCellDepth}
            >
              ⊙
            </button>
          )}
          <button
            type="button"
            className="dynamic-move"
            onClick={onMoveUp}
            disabled={!onMoveUp}
            title="Move panel up"
            aria-label="Move panel up"
          >
            ↑
          </button>
          <button
            type="button"
            className="dynamic-move"
            onClick={onMoveDown}
            disabled={!onMoveDown}
            title="Move panel down"
            aria-label="Move panel down"
          >
            ↓
          </button>
          <button
            type="button"
            className="dynamic-expand"
            onClick={() => setExpanded(true)}
            title="View larger (Esc to close)"
            aria-label="View larger"
          >
            ⤢
          </button>
          {onClose && (
            <button
              type="button"
              className="dynamic-close"
              onClick={onClose}
              title="Remove this plot"
              aria-label="Remove this plot"
            >
              ✕
            </button>
          )}
        </div>
        <Suspense fallback={<div className="loading">Loading plot library…</div>}>
          <Plot
            data={data as never}
            layout={layout}
            style={style}
            useResizeHandler
            config={PLOTLY_CONFIG}
          />
        </Suspense>
      </div>
      {expanded &&
        createPortal(
          <div
            className="plot-modal-backdrop"
            onClick={() => setExpanded(false)}
            role="presentation"
          >
            <div
              className="plot-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <button
                type="button"
                className="plot-modal-close"
                onClick={() => setExpanded(false)}
                title="Close (Esc)"
                aria-label="Close"
              >
                ✕
              </button>
              <Suspense fallback={<div className="loading">Loading plot library…</div>}>
                <Plot
                  data={data as never}
                  layout={layout}
                  style={{ width: "100%", height: `${Math.floor(window.innerHeight * 0.78)}px` }}
                  useResizeHandler
                  config={PLOTLY_CONFIG}
                />
              </Suspense>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
