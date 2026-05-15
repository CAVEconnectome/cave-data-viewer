import { useCallback } from "react";

interface Props {
  /** Lower handle value. Always shown. */
  min: number;
  /** Upper handle value. Ignored in `mode: "single"`. */
  max: number;
  /** Slider bounds — outer envelope the user can drag within. */
  bound: { lo: number; hi: number };
  /** Step. Defaults to 1% of the bound span — fine enough for typical
   *  px ranges and raw numeric domains alike. */
  step?: number;
  /** Channel label shown to the left of the track. */
  label: string;
  /** Formatter for the readout under the slider. Receives a single
   *  numeric value; returns the user-facing string. */
  formatValue?: (n: number) => string;
  /** "range" (default) renders two thumbs; "single" renders just the
   *  `min` thumb (max is ignored). Used by ChannelPicker so the size
   *  slider stays available even when no size channel is bound —
   *  the single thumb then controls the uniform point size. */
  mode?: "single" | "range";
  onChange: (next: { min?: number; max?: number }) => void;
}

/**
 * Dual-thumb range slider, used for both size (px range) and color
 * (colorscale-domain range) channel clipping.
 *
 * Built from two stacked ``<input type="range">`` elements over a
 * shared track. Pointer events flow through to whichever thumb is
 * closer; the active segment of the track between the two values
 * fills in the project's accent color so the active range is visible
 * at a glance.
 *
 * Each handle is clamped against the other so dragging the min past
 * the max (or vice versa) is impossible — the moving handle stops one
 * step short of the static one.
 */
export function RangeSlider({
  min,
  max,
  bound,
  step,
  label,
  formatValue = (n) => n.toFixed(2),
  mode = "range",
  onChange,
}: Props) {
  const isSingle = mode === "single";
  // Compute a step from the bound span when one isn't supplied. ~1%
  // resolution is usually enough; finer slows the read-out flicker
  // without adding obvious precision.
  const effStep = step ?? Math.max(0.01, (bound.hi - bound.lo) / 100);

  const handleMin = useCallback(
    (v: number) => {
      // In single mode there's no max thumb to clamp against.
      const clamped = isSingle ? v : Math.min(v, max - effStep);
      onChange({ min: clamped });
    },
    [isSingle, max, effStep, onChange],
  );
  const handleMax = useCallback(
    (v: number) => {
      const clamped = Math.max(v, min + effStep);
      onChange({ max: clamped });
    },
    [min, effStep, onChange],
  );

  // Percent positions for the colored "active" segment of the track.
  // In single mode the segment fills from 0% to the min thumb so the
  // user sees a visual indicator of the current value's magnitude.
  const range = bound.hi - bound.lo;
  const leftPct = range > 0 ? ((min - bound.lo) / range) * 100 : 0;
  const rightPct = isSingle
    ? leftPct
    : range > 0 ? ((max - bound.lo) / range) * 100 : 100;
  const activeLeft = isSingle ? 0 : leftPct;
  const activeRight = 100 - rightPct;

  return (
    <div className="size-range-slider">
      <div className="size-range-slider-row">
        <span className="size-range-slider-label">{label}</span>
        <div className="size-range-slider-track-wrap">
          <div className="size-range-slider-track" />
          <div
            className="size-range-slider-track-active"
            style={{ left: `${activeLeft}%`, right: `${activeRight}%` }}
          />
          <input
            type="range"
            min={bound.lo}
            max={bound.hi}
            step={effStep}
            value={min}
            onChange={(e) => handleMin(parseFloat(e.target.value))}
            className="size-range-thumb size-range-thumb-min"
            aria-label={isSingle ? label : `${label} min`}
          />
          {!isSingle && (
            <input
              type="range"
              min={bound.lo}
              max={bound.hi}
              step={effStep}
              value={max}
              onChange={(e) => handleMax(parseFloat(e.target.value))}
              className="size-range-thumb size-range-thumb-max"
              aria-label={`${label} max`}
            />
          )}
        </div>
      </div>
      <div className="size-range-slider-readout">
        <span>{formatValue(min)}</span>
        {!isSingle && <span>{formatValue(max)}</span>}
      </div>
    </div>
  );
}
