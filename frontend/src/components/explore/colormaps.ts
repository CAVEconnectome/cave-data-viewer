/**
 * Colormap registry for the universe scatter's numeric color channel.
 *
 * Each colormap is a small (3–7 stop) approximation of the canonical
 * matplotlib/d3-scale-chromatic LUTs — enough fidelity for a scatter
 * preview at typical screen size without pulling in a colormap library.
 * If a user needs an exact LUT later we can swap to d3-scale-chromatic
 * without changing this module's API (`sampleColormap`, `colormapCss`).
 *
 * Featured ids are surfaced as quick swatches in the picker; the rest
 * are findable via free-text search. Categorised by typical use:
 *   - sequential: monotonic luminance, good for ordered scalar data
 *   - single-hue: like sequential but constrained to one hue
 *   - diverging: meaningful zero/midpoint, good for centered data
 *   - cyclic: wraps end-to-start, good for periodic quantities
 */

export type RGB = [number, number, number];
export type ColorStop = [number, RGB]; // [t∈[0,1], rgb]

export interface Colormap {
  id: string;
  label: string;
  category: "sequential" | "single-hue" | "diverging" | "cyclic";
  stops: ColorStop[];
}

export const COLORMAPS: Colormap[] = [
  // Perceptually-uniform sequential (matplotlib's modern defaults).
  {
    id: "viridis",
    label: "Viridis",
    category: "sequential",
    stops: [
      [0.0, [68, 1, 84]],
      [0.25, [59, 82, 139]],
      [0.5, [33, 144, 141]],
      [0.75, [94, 201, 98]],
      [1.0, [253, 231, 37]],
    ],
  },
  {
    id: "plasma",
    label: "Plasma",
    category: "sequential",
    stops: [
      [0.0, [13, 8, 135]],
      [0.25, [126, 3, 168]],
      [0.5, [204, 71, 120]],
      [0.75, [248, 149, 64]],
      [1.0, [240, 249, 33]],
    ],
  },
  {
    id: "magma",
    label: "Magma",
    category: "sequential",
    stops: [
      [0.0, [0, 0, 4]],
      [0.25, [80, 18, 123]],
      [0.5, [183, 55, 121]],
      [0.75, [252, 137, 97]],
      [1.0, [252, 253, 191]],
    ],
  },
  {
    id: "inferno",
    label: "Inferno",
    category: "sequential",
    stops: [
      [0.0, [0, 0, 4]],
      [0.25, [87, 16, 110]],
      [0.5, [187, 55, 84]],
      [0.75, [249, 142, 9]],
      [1.0, [252, 255, 164]],
    ],
  },
  {
    id: "cividis",
    label: "Cividis",
    category: "sequential",
    stops: [
      [0.0, [0, 32, 76]],
      [0.25, [56, 73, 105]],
      [0.5, [124, 123, 120]],
      [0.75, [187, 175, 113]],
      [1.0, [255, 234, 70]],
    ],
  },
  {
    id: "turbo",
    label: "Turbo",
    category: "sequential",
    stops: [
      [0.0, [48, 18, 59]],
      [0.2, [70, 107, 227]],
      [0.4, [27, 209, 217]],
      [0.6, [167, 252, 102]],
      [0.8, [253, 177, 47]],
      [1.0, [122, 4, 3]],
    ],
  },
  {
    id: "gray",
    label: "Gray",
    category: "sequential",
    stops: [
      [0.0, [20, 20, 20]],
      [1.0, [245, 245, 245]],
    ],
  },

  // Single-hue ramps — good when a numeric channel should read as
  // "more of one thing" rather than across a perceptual spectrum.
  {
    id: "blues",
    label: "Blues",
    category: "single-hue",
    stops: [
      [0.0, [247, 251, 255]],
      [0.5, [107, 174, 214]],
      [1.0, [8, 48, 107]],
    ],
  },
  {
    id: "greens",
    label: "Greens",
    category: "single-hue",
    stops: [
      [0.0, [247, 252, 245]],
      [0.5, [116, 196, 118]],
      [1.0, [0, 68, 27]],
    ],
  },
  {
    id: "reds",
    label: "Reds",
    category: "single-hue",
    stops: [
      [0.0, [255, 245, 240]],
      [0.5, [251, 106, 74]],
      [1.0, [103, 0, 13]],
    ],
  },
  {
    id: "purples",
    label: "Purples",
    category: "single-hue",
    stops: [
      [0.0, [252, 251, 253]],
      [0.5, [158, 154, 200]],
      [1.0, [63, 0, 125]],
    ],
  },
  {
    id: "oranges",
    label: "Oranges",
    category: "single-hue",
    stops: [
      [0.0, [255, 245, 235]],
      [0.5, [253, 141, 60]],
      [1.0, [127, 39, 4]],
    ],
  },

  // Diverging — meaningful midpoint (use with a centered colorMin/Max).
  {
    id: "rdbu",
    label: "RdBu",
    category: "diverging",
    stops: [
      [0.0, [103, 0, 31]],
      [0.25, [214, 96, 77]],
      [0.5, [247, 247, 247]],
      [0.75, [67, 147, 195]],
      [1.0, [5, 48, 97]],
    ],
  },
  {
    id: "coolwarm",
    label: "Coolwarm",
    category: "diverging",
    stops: [
      [0.0, [59, 76, 192]],
      [0.5, [221, 221, 221]],
      [1.0, [180, 4, 38]],
    ],
  },
  {
    id: "brbg",
    label: "BrBG",
    category: "diverging",
    stops: [
      [0.0, [84, 48, 5]],
      [0.5, [245, 245, 245]],
      [1.0, [0, 60, 48]],
    ],
  },
  {
    id: "piyg",
    label: "PiYG",
    category: "diverging",
    stops: [
      [0.0, [142, 1, 82]],
      [0.5, [247, 247, 247]],
      [1.0, [39, 100, 25]],
    ],
  },
  {
    id: "prgn",
    label: "PRGn",
    category: "diverging",
    stops: [
      [0.0, [64, 0, 75]],
      [0.5, [247, 247, 247]],
      [1.0, [0, 68, 27]],
    ],
  },
  {
    id: "spectral",
    label: "Spectral",
    category: "diverging",
    stops: [
      [0.0, [158, 1, 66]],
      [0.25, [244, 109, 67]],
      [0.5, [255, 255, 191]],
      [0.75, [102, 194, 165]],
      [1.0, [50, 136, 189]],
    ],
  },

  // Cyclic — wraps around (HSV-style); useful for orientations / phases.
  {
    id: "twilight",
    label: "Twilight",
    category: "cyclic",
    stops: [
      [0.0, [226, 217, 226]],
      [0.25, [97, 119, 192]],
      [0.5, [40, 22, 76]],
      [0.75, [177, 86, 102]],
      [1.0, [226, 217, 226]],
    ],
  },
];

/** Featured colormaps surfaced as quick swatches in the picker.
 *  Picked for coverage: two perceptual sequentials, one single-hue
 *  baseline, one diverging baseline. */
export const FEATURED_COLORMAP_IDS: string[] = ["viridis", "plasma", "magma", "rdbu"];

export const DEFAULT_COLORMAP_ID = "viridis";

const BY_ID = new Map(COLORMAPS.map((c) => [c.id, c]));

/** Look up a colormap by id; falls back to the default if unknown. */
export function getColormap(id: string | null | undefined): Colormap {
  if (id && BY_ID.has(id)) return BY_ID.get(id)!;
  return BY_ID.get(DEFAULT_COLORMAP_ID)!;
}

/** Sample a colormap at t∈[0,1]. Out-of-range t clamps to the endpoints
 *  (matches the deck.gl render behavior for clipped values). */
export function sampleColormap(cmap: Colormap, t: number): RGB {
  const stops = cmap.stops;
  if (t <= stops[0][0]) return stops[0][1];
  if (t >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * u),
        Math.round(c0[1] + (c1[1] - c0[1]) * u),
        Math.round(c0[2] + (c1[2] - c0[2]) * u),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/** CSS `linear-gradient(...)` string for previewing the colormap as a
 *  horizontal bar. Used by the legend and the picker swatches. */
export function colormapCss(cmap: Colormap): string {
  return `linear-gradient(to right, ${cmap.stops
    .map(([t, [r, g, b]]) => `rgb(${r},${g},${b}) ${(t * 100).toFixed(1)}%`)
    .join(", ")})`;
}

/**
 * Piecewise-linear value → colormap-t mapping with an optional center.
 *
 * Without a center, this is just `(v - lo) / (hi - lo)` — a uniform
 * stretch of the colormap across the data range. With a center, the
 * colormap's midpoint (t = 0.5) is anchored to the data value `center`
 * regardless of where it sits relative to lo/hi:
 *
 *   - center inside [lo, hi]: two linear segments meet at t = 0.5,
 *     one stretching [lo, center] to [0, 0.5], the other stretching
 *     [center, hi] to [0.5, 1]. The two halves can have different
 *     slopes — that's the whole point.
 *   - center ≤ lo: the entire data range sits on the right half of
 *     the colormap; map [lo, hi] → [0.5, 1] uniformly.
 *   - center ≥ hi: mirror image — map [lo, hi] → [0, 0.5].
 *
 * `null` center disables centering and falls back to the uniform stretch.
 * Returned t is unclamped; callers should clamp before sampling so
 * out-of-range data lands on the endpoint color rather than NaN'ing.
 */
export function piecewiseT(
  v: number,
  lo: number,
  hi: number,
  center: number | null,
): number {
  if (hi <= lo) return 0.5;
  if (center === null || !Number.isFinite(center)) {
    return (v - lo) / (hi - lo);
  }
  if (center <= lo) {
    return 0.5 + 0.5 * ((v - lo) / (hi - lo));
  }
  if (center >= hi) {
    return 0.5 * ((v - lo) / (hi - lo));
  }
  if (v < center) {
    return 0.5 * ((v - lo) / (center - lo));
  }
  return 0.5 + 0.5 * ((v - center) / (hi - center));
}

/** CSS gradient string for a colormap displayed across [lo, hi] with
 *  an optional centered midpoint. Samples N evenly-spaced points along
 *  the value axis and emits a CSS color stop at each — uniform handling
 *  whether or not a center is set, and whether the center sits inside
 *  or outside the data range. Falls back to the un-ranged `colormapCss`
 *  when center is null. */
export function colormapCssCentered(
  cmap: Colormap,
  lo: number,
  hi: number,
  center: number | null,
): string {
  if (center === null || hi <= lo) return colormapCss(cmap);
  const N = 25;
  const stops: string[] = [];
  for (let i = 0; i < N; i++) {
    const pct = i / (N - 1);
    const v = lo + pct * (hi - lo);
    const t = Math.max(0, Math.min(1, piecewiseT(v, lo, hi, center)));
    const [r, g, b] = sampleColormap(cmap, t);
    stops.push(`rgb(${r},${g},${b}) ${(pct * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}
