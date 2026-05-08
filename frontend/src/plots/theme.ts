/**
 * Plotly theme injection.
 *
 * Reads CSS custom properties at runtime so the theme always matches whatever
 * is in `:root` — including any future dark-mode toggle. The figure JSON that
 * arrives from the backend carries trace data + a minimal layout; this
 * function returns a *new* figure with our theme merged into the layout.
 *
 * What gets injected:
 *   - `colorway`        from `--cat-1` … `--cat-10` for categorical hue
 *   - `font.family`     follows the SPA's UI font stack
 *   - `font.color`      from `--fg`
 *   - axis `gridcolor`  from `--line` (subtler than Plotly's default)
 *   - axis `zerolinecolor` from `--line`
 *   - transparent backgrounds so the figure inherits the panel's white
 *
 * `margin` is intentionally NOT set here — `PlotPanel.tsx` sets it after
 * theming so the header-aware top margin (`t: 16` with header / `t: 36`
 * without) stays under one owner.
 */

import type { PlotResponse } from "../api/types";

type Figure = PlotResponse["figure"];

const CATEGORICAL_TOKENS = Array.from({ length: 10 }, (_, i) => `--cat-${i + 1}`);

function readVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function readPalette(): string[] {
  const palette = CATEGORICAL_TOKENS.map((name) => readVar(name, ""));
  // Drop empties (token missing); fall back to Plotly's defaults if empty.
  return palette.filter(Boolean);
}

/**
 * Compose a Plotly layout with our theme tokens. Existing layout fields
 * from the backend (e.g. axis titles, custom annotations) win over theme
 * defaults, so this is safe to apply unconditionally.
 */
export function applyTheme(figure: Figure): Figure {
  const fg = readVar("--fg", "#1a1a1a");
  const line = readVar("--line", "#d8d8d8");
  const fontFamily = readVar(
    "--font-sans",
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  );
  const colorway = readPalette();
  const layout = figure.layout ?? {};

  return {
    ...figure,
    layout: {
      ...layout,
      // Don't override an explicit colorway, but inject ours when none is set.
      colorway: (layout as { colorway?: string[] }).colorway ?? (colorway.length ? colorway : undefined),
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: {
        family: fontFamily,
        size: 11,
        color: fg,
        ...((layout as { font?: object }).font ?? {}),
      },
      xaxis: {
        gridcolor: line,
        zerolinecolor: line,
        ...((layout as { xaxis?: object }).xaxis ?? {}),
      },
      yaxis: {
        gridcolor: line,
        zerolinecolor: line,
        ...((layout as { yaxis?: object }).yaxis ?? {}),
      },
    },
  };
}
