import { useCallback, useLayoutEffect, useRef } from "react";

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
  /** Optional third thumb for an inner value (e.g. the center of a
   *  diverging colormap). Renders as a slim vertical marker on the
   *  same track, visually distinct from the min/max thumbs. Clamped
   *  between [min, max]. Pass `null` to hide. Only honored in
   *  ``mode: "range"`` — a center between a single thumb and nothing
   *  has no meaning. */
  center?: number | null;
  /** Label for the center marker in the readout / aria. Defaults to
   *  "center" but a caller can override (e.g. "midpoint", "anchor"). */
  centerLabel?: string;
  /** When true, the readout shows a small "reset" pill that fires
   *  ``onCenterReset``. Use this to indicate the user has nudged the
   *  center off its default so the affordance only shows when there's
   *  something to reset. Ignored unless ``onCenterReset`` is provided. */
  centerIsExplicit?: boolean;
  /** Fires when the user drags the center thumb. Always called with a
   *  numeric value — the explicit-vs-default distinction lives in the
   *  caller (URL state vs computed default). */
  onCenterChange?: (v: number) => void;
  /** Fires when the user clicks the reset pill. Caller decides what
   *  "reset" means (drop URL state, restore midpoint, etc). */
  onCenterReset?: () => void;
  onChange: (next: { min?: number; max?: number }) => void;
}

/**
 * Dual-thumb range slider, used for both size (px range) and color
 * (colorscale-domain range) channel clipping. Optionally also renders
 * a slim third thumb for an "inner" value like a diverging colormap's
 * center pivot.
 *
 * Built from two-or-three stacked ``<input type="range">`` elements
 * over a shared track. Pointer events flow through to whichever thumb
 * is closer; the active segment of the track between the two range
 * values fills in the project's accent color so the active range is
 * visible at a glance.
 *
 * Each handle is clamped against the other so dragging the min past
 * the max (or vice versa) is impossible — the moving handle stops one
 * step short of the static one. The center thumb clamps against both
 * min and max.
 */
export function RangeSlider({
  min,
  max,
  bound,
  step,
  label,
  formatValue = (n) => n.toFixed(2),
  mode = "range",
  center,
  centerLabel = "center",
  centerIsExplicit,
  onCenterChange,
  onCenterReset,
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
  const handleCenter = useCallback(
    (v: number) => {
      // Clamp inside the active [min, max] range. A center *outside*
      // that range is renderable (the renderer handles it) but the
      // thumb represents an inner value so we don't let the user
      // drag it past the endpoints — they'd just push the min/max in.
      const clamped = Math.max(min, Math.min(max, v));
      onCenterChange?.(clamped);
    },
    [min, max, onCenterChange],
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

  // `Number.isFinite` rejects NaN/Infinity even though they pass the
  // null/undefined check, which fixes a thumb-at-far-left case where a
  // stale URL value parsed to NaN: an `<input type="range" value="NaN">`
  // falls back to browser-default behavior (frequently min) rather
  // than the spec midpoint.
  const showCenter =
    !isSingle && center !== null && center !== undefined && Number.isFinite(center);

  // Defensive sync: React sets controlled-input `value` on every
  // commit, but for a *conditionally mounted* `<input type="range">`
  // we've seen the visible thumb start at the min position on first
  // paint despite the prop being correct (likely a value-attribute vs
  // value-property timing issue between the mount and the browser's
  // first layout pass). Setting `value` via ref in a layout effect
  // forces the DOM property before paint and pins the thumb to the
  // intended position from frame one.
  const centerRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (showCenter && centerRef.current && center !== null && center !== undefined) {
      centerRef.current.value = String(center);
    }
  }, [showCenter, center]);

  const showReset =
    showCenter && centerIsExplicit && typeof onCenterReset === "function";

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
          {showCenter && (
            <input
              ref={centerRef}
              type="range"
              min={bound.lo}
              max={bound.hi}
              step={effStep}
              value={center as number}
              onChange={(e) => handleCenter(parseFloat(e.target.value))}
              className="size-range-thumb size-range-thumb-center"
              aria-label={`${label} ${centerLabel}`}
              title={`${centerLabel}: ${formatValue(center as number)}`}
            />
          )}
        </div>
      </div>
      <div className="size-range-slider-readout">
        <span>{formatValue(min)}</span>
        {showReset && (
          <button
            type="button"
            className="size-range-slider-reset"
            title={`Reset ${centerLabel} to the midpoint of the current range`}
            onClick={onCenterReset}
          >
            ↺ {centerLabel}
          </button>
        )}
        {!isSingle && <span>{formatValue(max)}</span>}
      </div>
    </div>
  );
}
