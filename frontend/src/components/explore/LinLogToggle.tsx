export type AxisScale = "lin" | "log";

interface Props {
  value: AxisScale;
  onChange: (next: AxisScale) => void;
  /** Optional tooltip override. Default phrasing is generic ("X is
   *  linear/log"); callers controlling a specific axis (X binning,
   *  Y height) should pass their own copy. */
  title?: string;
  /** When true, the toggle is rendered grayed and clicks are
   *  swallowed. Callers use this to communicate that the log mode
   *  isn't available right now — e.g. log binning when the column
   *  contains non-positive values. */
  disabled?: boolean;
}

/**
 * Compact two-state lin/log toggle for histograms.
 *
 * The button's label shows the *active* scale so the user reads it
 * as a status indicator with implicit "click to switch" — same shape
 * as a chip / pill. What the toggle controls (X binning, Y heights,
 * etc.) is owned by the caller; this component is mode-agnostic.
 */
export function LinLogToggle({ value, onChange, title, disabled }: Props) {
  const next: AxisScale = value === "log" ? "lin" : "log";
  return (
    <button
      type="button"
      className={`linlog-toggle linlog-${value}`}
      onClick={() => !disabled && onChange(next)}
      disabled={disabled}
      title={
        title ??
        (value === "log"
          ? "Log scale — click for linear"
          : "Linear scale — click for log")
      }
      aria-label={`scale: ${value}; click to switch`}
    >
      {value}
    </button>
  );
}
