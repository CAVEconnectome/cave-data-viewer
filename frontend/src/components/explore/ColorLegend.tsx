import { useMemo } from "react";
import type { EmbeddingColorBlock } from "../../api/types";
import {
  type Colormap,
  colormapCss,
  colormapCssCentered,
  getColormap,
} from "./colormaps";

interface Props {
  color: EmbeddingColorBlock;
  /** Colormap id chosen by the user. Drives the gradient in the
   *  numeric legend. Categorical legend ignores this — its swatches
   *  come from the server's `color_map`. */
  colormapId?: string | null;
  /** Numeric-color clipping endpoints. When set, the legend gradient
   *  spans [colorMin, colorMax] rather than the raw data extent — so
   *  the colorbar tracks the slider rather than ignoring it. Null
   *  falls back to data min/max. */
  colorMin?: number | null;
  colorMax?: number | null;
  /** Data value anchored to the colormap midpoint. Renders a tick on
   *  the gradient when the active colormap is diverging. Null defers
   *  to the linear-stretch default — no tick, gradient renders evenly. */
  colorCenter?: number | null;
}

/**
 * In-chart color legend. Reads the bound color channel's metadata
 * (column name + kind + color_map / numeric range) and renders:
 *
 * - **categorical**: swatch + label list, sorted by the same
 *   case-folded alphabetical order the backend's
 *   `resolve_categorical_color_map` uses. Caps at a reasonable count
 *   to avoid stealing the canvas; long category lists collapse to
 *   "+N more".
 * - **numeric**: gradient bar with min / max ticks. The gradient mirrors
 *   whatever colormap the user picked in the ChannelPicker; the ticks
 *   mirror whatever clipping range they set with the range slider.
 *   For diverging colormaps, a center tick marks where the colormap's
 *   midpoint sits on the value axis.
 */
export function ColorLegend({
  color,
  colormapId,
  colorMin,
  colorMax,
  colorCenter,
}: Props) {
  if (color.kind === "categorical") return <CategoricalLegend color={color} />;
  return (
    <NumericLegend
      color={color}
      colormap={getColormap(colormapId)}
      colorMin={colorMin ?? null}
      colorMax={colorMax ?? null}
      colorCenter={colorCenter ?? null}
    />
  );
}

function CategoricalLegend({ color }: { color: EmbeddingColorBlock }) {
  // Build the (label, hex) list from color_map; sort to match server-
  // side ordering. Drop the "(none)" / null slot from the top-level
  // list to keep the legend tight — that color reads as "absent" and
  // doesn't need a labeled swatch.
  const entries = useMemo(() => {
    const cm = color.color_map ?? {};
    return Object.entries(cm)
      .filter(([k]) => k !== "(none)")
      .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [color.color_map]);
  const MAX_SHOWN = 12;
  const shown = entries.slice(0, MAX_SHOWN);
  const overflow = entries.length - shown.length;
  return (
    <div className="color-legend">
      <div className="color-legend-title" title={color.column}>
        {bareCol(color.column)}
      </div>
      {shown.map(([label, hex]) => (
        <div key={label} className="color-legend-row">
          <span className="color-legend-swatch" style={{ background: hex }} />
          <span className="color-legend-label">{label}</span>
        </div>
      ))}
      {overflow > 0 && (
        <div className="color-legend-overflow">+{overflow} more</div>
      )}
    </div>
  );
}

function NumericLegend({
  color,
  colormap,
  colorMin,
  colorMax,
  colorCenter,
}: {
  color: EmbeddingColorBlock;
  colormap: Colormap;
  colorMin: number | null;
  colorMax: number | null;
  colorCenter: number | null;
}) {
  // Compute the displayed range: explicit slider endpoints win over
  // the data extent, so the legend always matches what the scatter
  // shows (values outside the slider range clamp to the endpoint
  // colors on the canvas, so labeling the slider range is honest).
  const { lo, hi } = useMemo(() => {
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    for (const v of color.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const dataLo = Number.isFinite(mn) ? mn : 0;
    const dataHi = Number.isFinite(mn) ? mx : 1;
    return {
      lo: colorMin !== null && Number.isFinite(colorMin) ? colorMin : dataLo,
      hi: colorMax !== null && Number.isFinite(colorMax) ? colorMax : dataHi,
    };
  }, [color.values, colorMin, colorMax]);

  // Only show the center tick when the colormap is actually diverging —
  // a center marker on viridis would be misleading because the renderer
  // ignores the center for non-diverging maps.
  const isDiverging = colormap.category === "diverging";
  const effectiveCenter = isDiverging
    ? (colorCenter !== null && Number.isFinite(colorCenter)
        ? colorCenter
        : (lo + hi) / 2)
    : null;
  const centerPct = useMemo(() => {
    if (effectiveCenter === null || hi <= lo) return null;
    const pct = ((effectiveCenter - lo) / (hi - lo)) * 100;
    // Clamp inside the bar so an out-of-range center still shows up
    // at the appropriate edge rather than disappearing.
    return Math.max(0, Math.min(100, pct));
  }, [effectiveCenter, lo, hi]);

  // Gradient choice: a diverging map at its anchored center needs the
  // centered gradient so the visual midpoint matches where the data
  // center sits. Non-diverging maps just use the canonical gradient.
  const gradient = isDiverging
    ? colormapCssCentered(colormap, lo, hi, effectiveCenter)
    : colormapCss(colormap);
  return (
    <div className="color-legend">
      <div className="color-legend-title" title={color.column}>
        {bareCol(color.column)}
      </div>
      <div className="color-legend-gradient-wrap">
        <div
          className="color-legend-gradient"
          style={{ background: gradient }}
        />
        {centerPct !== null && (
          <span
            className="color-legend-center-tick"
            style={{ left: `${centerPct}%` }}
            title={`center @ ${formatNum(effectiveCenter as number)}`}
            aria-hidden
          />
        )}
      </div>
      <div className="color-legend-numeric-ticks">
        <span>{formatNum(lo)}</span>
        {centerPct !== null && (
          <span
            className="color-legend-numeric-center"
            style={{ left: `${centerPct}%` }}
          >
            {formatNum(effectiveCenter as number)}
          </span>
        )}
        <span>{formatNum(hi)}</span>
      </div>
    </div>
  );
}

function bareCol(col: string): string {
  const dot = col.indexOf(".");
  return dot >= 0 ? col.slice(dot + 1) : col;
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1000 || Math.abs(n) < 0.01) return n.toExponential(1);
  return n.toFixed(2);
}
