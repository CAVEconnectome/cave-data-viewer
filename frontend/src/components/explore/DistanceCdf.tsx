import { useMemo, useRef } from "react";

interface Props {
  /** Sorted-ascending distances for the displayed population. */
  sortedDistances: number[];
  /** Current threshold (distance value); null = none set yet. */
  threshold: number | null;
  /** Click sets the threshold to the distance at the clicked rank. */
  onThresholdChange: (value: number) => void;
  /** Cell count within the current threshold — drawn on the axis so
   *  the user can read "where am I cutting" without leaving the chart. */
  withinCount?: number;
}

const VB_W = 240;
const PLOT_H = 80;
const PAD_TOP = 6;
const PAD_BOTTOM = 14;
const VB_H = PAD_TOP + PLOT_H + PAD_BOTTOM;

/**
 * Elbow plot for the selection-growth distance probe.
 *
 * X = rank (1..N) of the cell among the closest-to-seed population,
 * Y = distance, anchored at 0. The curve is monotone non-decreasing;
 * the "elbow" is where distance starts climbing sharply, which is
 * usually a natural cluster boundary. Clicking sets the threshold to
 * the distance at the clicked x — the within-count is everything to
 * the left of the cut.
 *
 * Y starts at 0 rather than `min` so the kink reads in *real distance
 * terms*: a cell at distance 0.5 sits visibly above the baseline, not
 * pinned to it by the min-anchored normalization. For probes where the
 * minimum distance is genuinely zero (centroid reduction with seeds in
 * the matrix) the two visualizations coincide.
 */
export function DistanceCdf({
  sortedDistances,
  threshold,
  onThresholdChange,
  withinCount,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const { pathD, dMax } = useMemo(() => {
    if (sortedDistances.length === 0) {
      return { pathD: "", dMax: 0 };
    }
    const n = sortedDistances.length;
    const max = sortedDistances[n - 1];
    const span = max || 1;
    // Downsample to ~one point per viewBox pixel — cheap to render at
    // any N without losing the elbow's shape.
    const samples = Math.min(VB_W, n);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < samples; i++) {
      const t = samples === 1 ? 0 : i / (samples - 1);
      const idx = Math.floor(t * (n - 1));
      const x = (idx / Math.max(1, n - 1)) * VB_W;
      const y = PAD_TOP + PLOT_H - (sortedDistances[idx] / span) * PLOT_H;
      pts.push([x, y]);
    }
    const d = pts
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ");
    return { pathD: d, dMax: max };
  }, [sortedDistances]);

  const dSpan = dMax || 1;
  const thresholdY =
    threshold == null || sortedDistances.length === 0
      ? null
      : PAD_TOP +
        PLOT_H -
        (Math.max(0, Math.min(threshold, dMax)) / dSpan) * PLOT_H;

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || sortedDistances.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const t = Math.max(0, Math.min(1, xPx / rect.width));
    const idx = Math.round(t * (sortedDistances.length - 1));
    onThresholdChange(sortedDistances[idx]);
  };

  if (sortedDistances.length === 0) return null;

  // The within-count label rides on top of the chart as an absolutely-
  // positioned HTML element rather than an `<text>` inside the SVG. The
  // SVG uses `preserveAspectRatio="none"` so the curve can fill any
  // container width, but that same setting stretches every `<text>`
  // node horizontally — which made "268" read at a weird wide aspect.
  // HTML text doesn't suffer the stretch, and percentage positioning
  // keeps the label anchored to the threshold line at any chart size.
  const labelTopPct = thresholdY != null ? (thresholdY / VB_H) * 100 : 0;

  return (
    <div className="distance-cdf-wrap">
      <svg
        ref={svgRef}
        className="distance-cdf-svg"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        onClick={handleClick}
        role="img"
        aria-label="Distance-by-rank elbow plot; click to set threshold at a rank"
      >
        <path className="distance-cdf-line" d={pathD} />
        {thresholdY != null && (
          <line
            className="distance-cdf-threshold"
            x1={0}
            y1={thresholdY}
            x2={VB_W}
            y2={thresholdY}
          />
        )}
      </svg>
      {thresholdY != null && threshold != null && (
        <div
          className="distance-cdf-threshold-label"
          style={{ top: `${labelTopPct}%` }}
        >
          {withinCount != null && withinCount > 0 ? (
            <span>
              <span className="distance-cdf-threshold-d">
                d={threshold.toFixed(2)}
              </span>{" "}
              · {formatCount(withinCount)} within
            </span>
          ) : (
            <span className="distance-cdf-threshold-d">
              d={threshold.toFixed(2)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact integer count formatter. 1000 → "1k", 2500 → "2.5k". Distinct
 *  from histogram.ts's `formatTick`, which formats axis-value magnitudes
 *  (with exponential notation for extremes). Counts and axis values are
 *  conceptually different — keep these formatters separate. */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
}
