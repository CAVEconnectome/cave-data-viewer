import { useMemo } from "react";
import type { EmbeddingColorBlock } from "../../api/types";

interface Props {
  color: EmbeddingColorBlock;
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
 * - **numeric**: gradient bar with min / max ticks, matching the
 *   client-side Viridis approximation in UniverseScatter.
 *
 * Mounts in `UniverseScatter` as a top-right overlay (below the
 * pan/lasso toolbar). The parent decides positioning; this
 * component just renders content + sizing.
 */
export function ColorLegend({ color }: Props) {
  if (color.kind === "categorical") return <CategoricalLegend color={color} />;
  return <NumericLegend color={color} />;
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

function NumericLegend({ color }: { color: EmbeddingColorBlock }) {
  // Compute min/max from the (potentially null-laden) values array.
  // Match the client-side 3-stop Viridis stand-in in UniverseScatter.
  const { lo, hi } = useMemo(() => {
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    for (const v of color.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    return Number.isFinite(mn) ? { lo: mn, hi: mx } : { lo: 0, hi: 1 };
  }, [color.values]);
  return (
    <div className="color-legend">
      <div className="color-legend-title" title={color.column}>
        {bareCol(color.column)}
      </div>
      <div
        className="color-legend-gradient"
        style={{
          background:
            "linear-gradient(to right, rgb(68, 1, 84), rgb(33, 144, 141), rgb(253, 231, 37))",
        }}
      />
      <div className="color-legend-numeric-ticks">
        <span>{formatNum(lo)}</span>
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
