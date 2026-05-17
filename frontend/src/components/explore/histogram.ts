/**
 * Shared histogram primitives for the explorer rail.
 *
 * Both the Summary panel's per-column histograms and the Selection
 * Builder's numeric predicate widget bin a column the same way and
 * render the same visual language. Keeping the binning + tick formatter
 * in one module ensures the two surfaces agree (a "23.4" tick in one
 * place reads the same way in the other) and avoids the maintenance
 * cost of two near-identical copies.
 */

export interface HistogramData {
  /** Background distribution density (each value = bin count /
   *  background total; sums to 1). */
  bgDensity: number[];
  /** Foreground distribution density (each value = bin count /
   *  foreground total; sums to 1 when the foreground is non-empty,
   *  else all zeros). */
  fgDensity: number[];
  /** Raw counts per bin for the background population. Useful when a
   *  consumer wants absolute counts (e.g. the predicate builder's
   *  "N cells in selected bins" readout) rather than densities. */
  bgCounts: number[];
  /** Full edge sequence in original value space; length is
   *  ``bgCounts.length + 1``. Renderers read edges directly rather
   *  than assuming equal-width, so linear and log binning share one
   *  rendering path. */
  binEdges: number[];
  binMin: number;
  binMax: number;
  /** Whether the response is actually log-binned. May differ from the
   *  caller's request when the column has non-positive values and the
   *  log path falls back to linear. */
  binning: "linear" | "log";
  /** True when log binning was requested but downgraded because the
   *  background subset included non-positive values. */
  logFallback: boolean;
}

/** Bin a numeric column over a background population, optionally
 *  partitioning a foreground subset for overlay density.
 *
 *  Bins are derived from the **background** subset's extent (not the
 *  full universe) so the histogram stays meaningful when the user has
 *  narrowed to a small population — a long-tail outlier in the
 *  universe shouldn't squash the scope's distribution into a single
 *  bin.
 *
 *  Both distributions are normalized to densities (each sums to 1)
 *  so a foreground of 444 cells can be visually compared in shape to
 *  a 94k background.
 */
export function buildHistogram(
  values: Array<number | null>,
  cellIds: string[],
  bgCellIds: Set<string> | null,
  fgCellIds: Set<string> | null,
  nBins: number,
  binning: "linear" | "log" = "linear",
): HistogramData | null {
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (bgCellIds && !bgCellIds.has(cellIds[i])) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn)) return null;

  // Log binning needs all positive values in the background subset.
  // Silently fall back to linear when that doesn't hold so the panel
  // can render *something*; the ``logFallback`` flag lets the toggle
  // surface why it's not actually log.
  let effectiveBinning: "linear" | "log" = binning;
  let logFallback = false;
  if (binning === "log" && mn <= 0) {
    effectiveBinning = "linear";
    logFallback = true;
  }

  const binsLen = mx === mn ? 1 : nBins;
  const binCounts = new Array<number>(binsLen).fill(0);
  const fgCounts = new Array<number>(binsLen).fill(0);
  let bgTotal = 0;
  let fgTotal = 0;

  // Build the edge sequence once. Length is always binsLen+1; for
  // the constant-column degenerate case we collapse all edges to mn
  // so the renderer's per-bin math doesn't divide by zero (the single
  // bin's width is 0; the renderer special-cases this).
  const binEdges = new Array<number>(binsLen + 1);
  if (mx === mn) {
    for (let i = 0; i <= binsLen; i++) binEdges[i] = mn;
  } else if (effectiveBinning === "log") {
    const logMn = Math.log(mn);
    const logMx = Math.log(mx);
    for (let i = 0; i <= binsLen; i++) {
      binEdges[i] = Math.exp(logMn + (i / binsLen) * (logMx - logMn));
    }
  } else {
    const step = (mx - mn) / binsLen;
    for (let i = 0; i <= binsLen; i++) {
      binEdges[i] = mn + i * step;
    }
  }

  // Binning loop — log uses ``log(v) - log(mn)`` projection,
  // linear uses the existing range mapping. Single pass over values
  // for either mode.
  if (mx === mn) {
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const id = cellIds[i];
      if (bgCellIds && !bgCellIds.has(id)) continue;
      binCounts[0] += 1;
      bgTotal += 1;
      if (fgCellIds && fgCellIds.has(id)) {
        fgCounts[0] += 1;
        fgTotal += 1;
      }
    }
  } else if (effectiveBinning === "log") {
    const logMn = Math.log(mn);
    const logSpan = Math.log(mx) - logMn;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v) || v <= 0) continue;
      const id = cellIds[i];
      if (bgCellIds && !bgCellIds.has(id)) continue;
      let bin = Math.floor(((Math.log(v) - logMn) / logSpan) * nBins);
      if (bin >= nBins) bin = nBins - 1;
      if (bin < 0) bin = 0;
      binCounts[bin] += 1;
      bgTotal += 1;
      if (fgCellIds && fgCellIds.has(id)) {
        fgCounts[bin] += 1;
        fgTotal += 1;
      }
    }
  } else {
    const span = mx - mn;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const id = cellIds[i];
      if (bgCellIds && !bgCellIds.has(id)) continue;
      let bin = Math.floor(((v - mn) / span) * nBins);
      if (bin >= nBins) bin = nBins - 1;
      binCounts[bin] += 1;
      bgTotal += 1;
      if (fgCellIds && fgCellIds.has(id)) {
        fgCounts[bin] += 1;
        fgTotal += 1;
      }
    }
  }

  const bgDensity = binCounts.map((c) => (bgTotal > 0 ? c / bgTotal : 0));
  const fgDensity = fgCounts.map((c) => (fgTotal > 0 ? c / fgTotal : 0));
  return {
    bgDensity,
    fgDensity,
    bgCounts: binCounts,
    binEdges,
    binMin: mn,
    binMax: mx,
    binning: effectiveBinning,
    logFallback,
  };
}

/** Compact axis-tick formatter. Switches to scientific for very large
 *  / very small magnitudes; fixed precision otherwise. Same logic
 *  whether the tick is on a histogram, a CDF, or a range slider. */
export function formatTick(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0))
    return n.toExponential(1);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(2);
}
