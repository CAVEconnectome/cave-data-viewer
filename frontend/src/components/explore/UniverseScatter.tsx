import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import DeckGL from "@deck.gl/react";
import { OrthographicView, OrthographicViewport } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { useEmbeddingScatter } from "../../api/embeddings";
import type { EmbeddingScatterResponse } from "../../api/types";
import { columnDisplayName } from "../tableColumns";
import { ColorLegend } from "./ColorLegend";
import {
  type Colormap,
  getColormap,
  piecewiseT,
  sampleColormap,
} from "./colormaps";

// Color hexes used when no channel binding is active.
const BASE_RGBA_NO_HIGHLIGHT: [number, number, number, number] = [91, 139, 209, 230];   // #5b8bd1
const BASE_RGBA_WITH_HIGHLIGHT: [number, number, number, number] = [229, 231, 235, 90]; // pale gray, low alpha — recedes
const HIGHLIGHT_RGBA: [number, number, number, number] = [245, 158, 11, 255]; // #f59e0b
const NULL_RGBA: [number, number, number, number] = [220, 220, 220, 220]; // #dcdcdc — null-color slot
const FOCUSED_VIEW_ZOOM = 0; // initial zoom; deck.gl tunes to fit via fitBounds below.

/** Amount to desaturate base-layer points toward grayscale when a
 *  highlight is active. 0 = full color, 1 = pure gray. Pushed close
 *  to fully gray — selection should emerge via the background
 *  receding, not via the foreground screaming. */
const BASE_DESATURATE_WHEN_HIGHLIGHT = 0.94;
const BASE_ALPHA_WHEN_HIGHLIGHT = 70;

interface Props {
  ds: string;
  featureTableId: string;
  embeddingId: string;
  /** Channel bindings forwarded to /scatter. Same wire as before; the
   *  response carries per-point arrays + (for categorical color) a
   *  color_map so a value lands on the same hex as the rest of the
   *  project. */
  x?: string | null;
  y?: string | null;
  colorBy?: string | null;
  sizeBy?: string | null;
  sizeMinPx?: number;
  sizeMaxPx?: number;
  /** Optional clipping for the size channel's data range. Values
   *  outside [sizeDataMin, sizeDataMax] clamp to the size endpoints
   *  (sizeMinPx / sizeMaxPx) so a long-tail outlier doesn't squash
   *  the size gradient onto a few cells. In-range values get the
   *  full rank-scaled gradient within the surviving subset. Null =
   *  use the full data extent (no clipping). Mirrors the color
   *  channel's clipping behavior. */
  sizeDataMin?: number | null;
  sizeDataMax?: number | null;
  /** Optional clipping for the numeric color channel. Values outside
   *  [colorMin, colorMax] clamp to the endpoint hex so long-tail
   *  outliers can't blow out the full colorscale onto a few cells. */
  colorMin?: number | null;
  colorMax?: number | null;
  /** Colormap id from the registry in `./colormaps`. Numeric color
   *  channels sample from this colormap; unknown ids fall back to the
   *  default (viridis). Ignored for categorical color. */
  colormapId?: string | null;
  /** Data value anchored to the colormap's midpoint when the active
   *  colormap is diverging. Null defers to (colorMin + colorMax) / 2 —
   *  the no-op midpoint that renders identically to the linear stretch.
   *  Ignored for non-diverging colormaps. */
  colorCenter?: number | null;
  decorationTables?: string[];
  matVersion?: number | "live" | null;
  /** Cells passing the active Filter Scope. Null means the full
   *  universe is in scope (no predicate, no snapshot) — everything
   *  renders normally. When set, cells *not* in this set are
   *  out-of-scope and render per `scopeMode` (ghosted or hidden) and
   *  cannot be lasso-selected — out of scope is out of scope, period. */
  inScopeCellIds?: Set<string> | null;
  /** Cells in the active selection AND currently in scope — the
   *  orange highlight overlay. Null/empty = no overlay. The bag may
   *  hold more cells than this (out-of-scope selections are preserved
   *  in FeatureExplorer's state but render as out-of-scope here). */
  selectedCellIds?: Set<string> | null;
  /** Out-of-scope rendering mode. "ghost" (default) keeps out-of-scope
   *  cells as faint background context; "hide" omits them entirely. In
   *  both modes they're non-pickable. Ignored when `inScopeCellIds` is
   *  null (nothing is out of scope). */
  scopeMode?: "ghost" | "hide";
  /** Called with the lasso-selected cell_ids — guaranteed in-scope
   *  because the partition omits or ghosts out-of-scope cells (and
   *  hit-test filters them out either way). Suppressed on empty
   *  selections so a phantom drag doesn't clear a real selection.
   *
   *  `mode` reflects modifier keys held when the lasso ended:
   *  `add` (Shift), `subtract` (Alt/Option), or `replace` (no modifier).
   *  Matches Photoshop/Figma/Finder semantics so a user can build up
   *  and pare down a selection without leaving the canvas. */
  onLassoSelect?: (
    cellIds: string[],
    mode: "replace" | "add" | "subtract",
  ) => void;
  /** Called when the user clicks a single point. */
  onPointClick?: (cellId: string) => void;
  /** Optional fixed height. When unset, the component fills its
   *  parent (use this in flex layouts where the parent owns sizing).
   *  Required when the parent has no intrinsic height. */
  height?: number;
  /** Synthetic distance-to-seeds values keyed by cell_id. Provided
   *  when the user has bound the ``__distance`` channel to color (or
   *  size); the scatter aligns these to the fetched ``cell_ids``
   *  order and feeds the resulting block into the partition as if
   *  it came from /scatter. The backend has no idea what
   *  ``__distance`` is, so the SPA strips the binding before
   *  fetching and substitutes the synthesized block here. */
  distanceColorMap?: Map<string, number> | null;
  distanceSizeMap?: Map<string, number> | null;
}

/** Imperative handle exposed via `forwardRef`. Lets parents trigger the
 *  scatter's internal "fit to current highlight (or full unit square)"
 *  pass without duplicating its layout maths. Used by `<CellIdSearch>`:
 *  after `replaceSelection([...])` lands, calling `fitView()` zooms the
 *  scatter onto the cells the user just searched for. */
export interface UniverseScatterHandle {
  /** Re-fit the camera. Frames the highlight set when one is active;
   *  otherwise fits the full unit square (default extent). */
  fitView: () => void;
}

// --- color helpers ----------------------------------------------------------

/** Parse "#rrggbb" → [r, g, b]. Tolerates bad input by falling back to NULL. */
function hexToRgb(hex: string | undefined | null): [number, number, number] {
  if (!hex || typeof hex !== "string" || hex.charAt(0) !== "#" || hex.length < 7) {
    return [NULL_RGBA[0], NULL_RGBA[1], NULL_RGBA[2]];
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return [NULL_RGBA[0], NULL_RGBA[1], NULL_RGBA[2]];
  }
  return [r, g, b];
}

/** Mix an RGB triple toward its grayscale luminance. `amount` is the
 *  fraction of gray (0 = unchanged, 1 = pure gray). Used to wash out
 *  non-highlighted points so the highlight reads cleanly. */
function desaturate(
  rgb: [number, number, number],
  amount: number,
): [number, number, number] {
  const [r, g, b] = rgb;
  // BT.601 luma — closer to perceived brightness than equal weights.
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  const k = 1 - amount;
  return [
    Math.round(r * k + gray * amount),
    Math.round(g * k + gray * amount),
    Math.round(b * k + gray * amount),
  ];
}

/** Map a numeric value into the chosen colormap. Null/NaN → NULL_RGBA so
 *  missing values render distinctly from the low end of the scale; a
 *  degenerate range (hi ≤ lo) collapses to the colormap's midpoint.
 *
 *  `center` is the data value anchored to t = 0.5; only meaningful for
 *  diverging colormaps (the caller decides whether to pass it). Null
 *  center is the linear stretch — equivalent to a center at (lo+hi)/2. */
function numericToColor(
  v: number | null | undefined,
  lo: number,
  hi: number,
  cmap: Colormap,
  center: number | null,
): [number, number, number] {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return [NULL_RGBA[0], NULL_RGBA[1], NULL_RGBA[2]];
  }
  if (hi <= lo) return sampleColormap(cmap, 0.5);
  const t = Math.max(0, Math.min(1, piecewiseT(v, lo, hi, center)));
  return sampleColormap(cmap, t);
}

// --- main component ---------------------------------------------------------

interface RenderRow {
  id: string;
  position: [number, number];
  /** [r, g, b, a] in 0-255. */
  color: [number, number, number, number];
  /** Pre-scaled marker radius in pixels (server gives 3-10px; we add a
   *  small bump for the highlight subset). */
  radius: number;
}

/**
 * Universe scatter for the Feature Explorer, deck.gl edition.
 *
 * Renders every cell in a feature table at its 2D embedding coordinates
 * (or user-bound x/y channels). Uses two ScatterplotLayer instances —
 * `base` (universe \ highlight) and `highlight` — so the highlight set
 * renders on top with its own color + size.
 *
 * The component owns:
 *   - data fetch via `useEmbeddingScatter` (same hook as before)
 *   - color/size resolution into per-point RGBA + radius
 *   - viewport state (deck.gl OrthographicView, pan + zoom)
 *   - hover / click via deck.gl's picking
 *
 * Lasso is wired in a follow-up commit; this one focuses on getting
 * the engine swap clean and the rendering equivalent to the Plotly
 * version. Public props are unchanged so FeatureExplorer doesn't move.
 */
export const UniverseScatter = forwardRef<UniverseScatterHandle, Props>(function UniverseScatter(
  {
    ds,
    featureTableId,
    embeddingId,
    x: xBinding,
    y: yBinding,
    colorBy,
    sizeBy,
    sizeMinPx,
    sizeMaxPx,
    sizeDataMin,
    sizeDataMax,
    colorMin,
    colorMax,
    colormapId,
    colorCenter,
    decorationTables,
    matVersion,
    inScopeCellIds,
    selectedCellIds,
    scopeMode = "ghost",
    onLassoSelect,
    onPointClick,
    height,
    distanceColorMap,
    distanceSizeMap,
  },
  ref,
) {
  const colormap = useMemo(() => getColormap(colormapId), [colormapId]);
  // Tool state — pan or lasso. Default pan so the very first
  // interaction (explore the universe) feels right. Toggle in the
  // top-right corner of the scatter; sticks until the user toggles
  // back so repeated lassos don't require re-clicking.
  const [tool, setTool] = useState<"pan" | "lasso">("pan");
  // Space-as-temporary-pan: while held, the lasso overlay defers
  // pointer events to deck.gl so the user can nudge the view without
  // toggling the tool. Tracked in state (not just a ref) so the
  // overlay's `pointer-events` / `cursor` rerender on press/release.
  const [spaceHeld, setSpaceHeld] = useState(false);
  // Active lasso polygon in canvas-pixel coordinates. `null` when not
  // currently dragging. Points are accumulated as the user moves the
  // pointer; on release we convert to data space and emit cell_ids.
  const [lassoPx, setLassoPx] = useState<Array<[number, number]> | null>(null);
  // Tracks whether a lasso drag is in flight. When idle, the overlay
  // sets `pointer-events: none` so wheel/right-click/hover reach
  // deck.gl naturally; we only steal pointer events for the duration
  // of an active drag.
  const draggingRef = useRef(false);
  // Hover state — picked cell_id + the bound channel values at that
  // point. Lazily computed once on hover so it doesn't recompute every
  // mousemove.
  const [hovered, setHovered] = useState<{
    id: string;
    px: number;
    py: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const query = useEmbeddingScatter({
    ds,
    featureTableId,
    embeddingId,
    x: xBinding,
    y: yBinding,
    colorBy,
    sizeBy,
    decorationTables,
    matVersion,
  });

  // Compute the per-axis extents once per data update. Used both to
  // normalize positions before they hit the layer (so x and y can
  // scale independently — OrthographicView itself is uniform-aspect)
  // and to seed the initial view state.
  const extent = useMemo(
    () => (query.data ? computeExtent(query.data) : null),
    [query.data],
  );

  // Synthetic ``__distance`` channel. The backend strips this binding
  // before /scatter is called (it has no idea what it is), so the
  // fetched response has no color/size block for it. Reconstitute one
  // here by aligning ``distanceColorMap`` (and the size counterpart)
  // to the fetched ``cell_ids`` order. The merged block looks
  // indistinguishable from a server-provided numeric channel from the
  // partition's point of view, so the colormap / legend / hover
  // tooltip all light up without further special-casing.
  const dataWithSynthetic = useMemo(() => {
    if (!query.data) return query.data;
    let data = query.data;
    if (distanceColorMap && data.color == null) {
      const values: Array<number | null> = new Array(data.cell_ids.length);
      for (let i = 0; i < data.cell_ids.length; i++) {
        const v = distanceColorMap.get(data.cell_ids[i]);
        values[i] = v == null ? null : v;
      }
      data = {
        ...data,
        color: { column: "__distance", kind: "numeric", values },
      };
    }
    if (distanceSizeMap && data.size == null) {
      const values: Array<number | null> = new Array(data.cell_ids.length);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < data.cell_ids.length; i++) {
        const v = distanceSizeMap.get(data.cell_ids[i]);
        if (v == null) {
          values[i] = null;
        } else {
          values[i] = v;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      data = {
        ...data,
        size: {
          column: "__distance",
          values,
          raw_range: [
            Number.isFinite(lo) ? lo : 0,
            Number.isFinite(hi) ? hi : 0,
          ],
        },
      };
    }
    return data;
  }, [query.data, distanceColorMap, distanceSizeMap]);

  // Per-point resolved color/size arrays + three-way partition
  // (out-of-scope / in-scope-not-selected / in-scope-selected).
  // Positions are pre-normalized to a unit square so the
  // OrthographicView's uniform scaling doesn't squash one axis flat
  // when the data ranges differ wildly (depth: 1–1500 vs folding ratio:
  // 0–2). Pan/zoom operate in normalized space; axis labels (when we
  // add them) inverse-transform tick positions through `extent`.
  const partition = useMemo(
    () =>
      buildPartition(dataWithSynthetic, inScopeCellIds, selectedCellIds, extent, {
        sizeMinPx: sizeMinPx ?? 2,
        sizeMaxPx: sizeMaxPx ?? 18,
        sizeDataMin: sizeDataMin ?? null,
        sizeDataMax: sizeDataMax ?? null,
        colorMin: colorMin ?? null,
        colorMax: colorMax ?? null,
        colormap,
        colorCenter: colorCenter ?? null,
        scopeMode,
      }),
    [
      dataWithSynthetic,
      inScopeCellIds,
      selectedCellIds,
      extent,
      sizeMinPx,
      sizeMaxPx,
      sizeDataMin,
      sizeDataMax,
      colorMin,
      colorMax,
      colormap,
      colorCenter,
      scopeMode,
    ],
  );

  // Measure the container so the initial fit uses the actual canvas
  // height (which can be smaller or larger than any fixed prop the
  // parent passed). ResizeObserver fires whenever the container's
  // dimensions change (e.g. when a sibling drawer opens). We track
  // measured height in a ref so subsequent resizes don't snap the
  // user's pan/zoom — only the initial fit (and explicit "fit view"
  // requests) re-compute zoom from height.
  const [measuredHeight, setMeasuredHeight] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setMeasuredHeight(entries[0].contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Hold-Space → temporary pan/zoom. While the key is held, the lasso
  // overlay falls back to `pointer-events: none` and deck.gl's
  // controller is enabled (see the layers/overlay JSX below), so a
  // user mid-lasso can nudge the view without round-tripping through
  // the tool toggle. Ignored when the user is typing into an input,
  // textarea, or contenteditable so Space doesn't get hijacked mid-
  // typing in the Cell ID Search box. Reset on `blur` (e.g., user
  // alt-tabs while holding Space) to avoid a "stuck pan" state.
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !(el instanceof HTMLElement)) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code !== "Space" || ev.repeat) return;
      if (isTypingTarget(document.activeElement)) return;
      ev.preventDefault(); // suppress page scroll on body-focused Space
      setSpaceHeld(true);
      // Discard any in-flight lasso polygon — switching modes mid-
      // drag would be ambiguous, and the user's clear intent is "let
      // me pan."
      if (draggingRef.current) {
        draggingRef.current = false;
        setLassoPx(null);
      }
    };
    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.code !== "Space") return;
      setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Initial view state — fit the unit square into the canvas with a
  // small padding margin. Independent of `extent` because the data is
  // pre-normalized; pan/zoom write back through `onViewStateChange`
  // after the initial fit. Re-fits only when the axes change (binding
  // swap) or on first data load — NOT on color/size/highlight/
  // container-resize, which would yank the user's view away.
  const [viewState, setViewState] = useState<{
    target: [number, number, number];
    zoom: number;
  } | null>(null);
  const axesKey = `${query.data?.axes.x ?? ""}/${query.data?.axes.y ?? ""}`;
  // `heightForFit` is the latest measured height; used inside the fit
  // effect but not a dep (changes don't trigger re-fit on container
  // resize). When measured is 0 (not measured yet) we fall back to
  // the prop or a sensible default.
  const heightForFitRef = useRef<number>(height ?? 480);
  if (measuredHeight > 0) heightForFitRef.current = measuredHeight;
  else if (height) heightForFitRef.current = height;

  // Auto-fit policy.
  //
  // We want to re-fit when:
  //   - data first lands
  //   - the axes change (different coordinate space — channel swap)
  //   - the container resizes BEFORE the user has interacted with the
  //     view (initial layout settling: flex distribution can give a
  //     small height on first paint, then grow once siblings finish
  //     measuring)
  //
  // We want to NOT re-fit on:
  //   - channel changes (color, size, dec, mat_version) — they refetch
  //     and briefly flip `query.data` to undefined, but the user's
  //     pan/zoom should survive
  //   - container resize AFTER user interaction (don't yank the view)
  //
  // Implementation: track `hasUserInteractedRef` (set when the user
  // pans/zooms via deck.gl's interactionState). The effect re-fits
  // freely until that flag flips; afterwards, only an axes change
  // re-fits.
  const hasUserInteractedRef = useRef(false);
  const lastFittedAxesRef = useRef<string | null>(null);
  useEffect(() => {
    if (!query.data) return;
    if (measuredHeight <= 0) return;
    const axesChanged = lastFittedAxesRef.current !== axesKey;
    const shouldFit = axesChanged || !hasUserInteractedRef.current;
    if (!shouldFit) return;
    lastFittedAxesRef.current = axesKey;
    setViewState(unitSquareViewState(measuredHeight));
  }, [axesKey, query.data, measuredHeight]);

  const fitView = useCallback(() => {
    // When a selection is active, frame the viewport on the
    // in-scope selected cells specifically — that's almost always
    // what "fit" means in the moment (the user is looking for them).
    // Out-of-scope bag members are deliberately excluded — out of
    // scope is out of scope, period. Otherwise fit the full unit
    // square (default extent).
    if (partition && partition.selected.length > 0) {
      // Selected positions are in the same normalized [0,1]×[0,1]
      // space the view targets. Find their bounding box, pad ~15%
      // for breathing room, set view center + zoom to that.
      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;
      for (const r of partition.selected) {
        const [x, y] = r.position;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      // Minimum effective span for the framing rectangle. A single-cell
      // highlight (the common case after a Cell ID search) has spanX =
      // spanY = 0, which without a floor produces a 14+ zoom that frames
      // the cell at extreme magnification — the user sees the cell at
      // its raw size with no surrounding context and reasonably reports
      // "fit zoomed in and I can't see anything." 0.15 of the unit
      // square frames ~15% of the embedding around the point, which is
      // dense enough to read morphology-bearing structure and sparse
      // enough that the highlighted cell stands out within it.
      //
      // For larger highlight sets the natural bounding box is wider
      // than 0.15 and the floor doesn't kick in.
      const MIN_FIT_SPAN = 0.15;
      const spanX = Math.max(maxX - minX, MIN_FIT_SPAN);
      const spanY = Math.max(maxY - minY, MIN_FIT_SPAN);
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const padding = 1.3;
      const containerPx = heightForFitRef.current;
      // Zoom = log2(pixels-per-data-unit). Fit the larger span.
      const fitSpan = Math.max(spanX, spanY) * padding;
      const zoom = Math.log2(containerPx / fitSpan);
      setViewState({
        target: [cx, cy, 0],
        zoom: Math.max(-10, Math.min(20, zoom)),
      });
      return;
    }
    setViewState(unitSquareViewState(heightForFitRef.current));
  }, [partition]);

  // Expose `fitView` to parents via the forwardRef handle. The
  // CellIdSearch component uses this to zoom to a freshly-resolved cell
  // (or set of cells) after `replaceSelection(...)` populates the
  // highlight set. Re-runs of useImperativeHandle pick up the latest
  // `fitView` closure (which already depends on `partition`), so a
  // ref.current.fitView() right after a state change reads the
  // up-to-date highlight bounds on the next render commit.
  useImperativeHandle(ref, () => ({ fitView }), [fitView]);

  const layers = useMemo(() => {
    if (!partition) return [];
    const out: ScatterplotLayer<RenderRow>[] = [];
    // Out-of-scope layer (non-pickable). Skipped when hide mode is
    // active OR when nothing is out of scope. Renders below in-scope
    // and selected so the active set always paints on top.
    if (partition.outOfScope.length > 0) {
      out.push(
        new ScatterplotLayer({
          id: "universe-outscope",
          data: partition.outOfScope,
          // Non-pickable: out of scope is out of scope, period — the
          // user can't hover-tooltip or click-select a ghosted cell.
          pickable: false,
          stroked: false,
          filled: true,
          radiusUnits: "pixels",
          getPosition: (d: RenderRow) => d.position,
          getFillColor: (d: RenderRow) => d.color,
          getRadius: (d: RenderRow) => d.radius,
          updateTriggers: {
            getFillColor: partition.colorRevision,
            getRadius: partition.sizeRevision,
          },
        }),
      );
    }
    // In-scope base layer (pickable). This is the "active" universe
    // the user can interact with.
    out.push(
      new ScatterplotLayer({
        id: "universe-base",
        data: partition.inScopeBase,
        pickable: true,
        stroked: false,
        filled: true,
        radiusUnits: "pixels",
        // `getPosition` returns native [x, y] from each row; ditto color/radius.
        getPosition: (d: RenderRow) => d.position,
        getFillColor: (d: RenderRow) => d.color,
        getRadius: (d: RenderRow) => d.radius,
        // Picking is cheap regardless of layer size — deck.gl reads a 1×1
        // pixel from the picking buffer rather than iterating points in JS.
        updateTriggers: {
          getFillColor: partition.colorRevision,
          getRadius: partition.sizeRevision,
        },
      }),
    );
    if (partition.selected.length > 0) {
      // Thin black stroke on every selected marker. The fill carries
      // most of the selection signal against a heavily-recessed base
      // layer; the stroke is just enough edge to keep marks legible at
      // any fill color, including pale colormap ends. The exponential
      // size bonus in `buildPartition` handles single-cell findability.
      out.push(
        new ScatterplotLayer({
          id: "universe-selected",
          data: partition.selected,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: "pixels",
          lineWidthUnits: "pixels",
          getPosition: (d: RenderRow) => d.position,
          getFillColor: (d: RenderRow) => d.color,
          getRadius: (d: RenderRow) => d.radius,
          getLineColor: [0, 0, 0, 200],
          getLineWidth: 1,
          updateTriggers: {
            getFillColor: partition.colorRevision,
            getRadius: partition.sizeRevision,
          },
        }),
      );
    }
    return out;
  }, [partition]);

  const handleClick = useCallback(
    (info: { object?: unknown }) => {
      if (!info?.object) return;
      const row = info.object as RenderRow;
      onPointClick?.(row.id);
    },
    [onPointClick],
  );

  const handleHover = useCallback(
    (info: { object?: unknown; x?: number; y?: number }) => {
      if (!info?.object) {
        setHovered(null);
        return;
      }
      const row = info.object as RenderRow;
      setHovered({ id: row.id, px: info.x ?? 0, py: info.y ?? 0 });
    },
    [],
  );

  // Lasso pointer handlers. Engaged only when `tool === "lasso"`; the
  // sibling overlay div flips its `pointer-events` so deck.gl's
  // controller never sees the drag (which would pan the view away
  // mid-lasso). On pointerup, we project polygon vertices to data
  // space and run point-in-polygon over the rendered partition to
  // emit cell_ids.
  const pointerStart = useCallback((ev: React.PointerEvent) => {
    if (tool !== "lasso" || spaceHeld) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    draggingRef.current = true;
    setLassoPx([[px, py]]);
    (ev.target as Element).setPointerCapture(ev.pointerId);
  }, [tool, spaceHeld]);

  const pointerMove = useCallback((ev: React.PointerEvent) => {
    if (tool !== "lasso") return;
    setLassoPx((prev) => {
      if (!prev) return prev;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return prev;
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      // Don't accumulate every event — coalesce to ~2px steps so the
      // polygon stays light without losing shape fidelity.
      const last = prev[prev.length - 1];
      if (Math.hypot(px - last[0], py - last[1]) < 2) return prev;
      return [...prev, [px, py]];
    });
  }, [tool]);

  const pointerEnd = useCallback((ev: React.PointerEvent) => {
    if (tool !== "lasso") return;
    const polygon = lassoPx;
    const wasDragging = draggingRef.current;
    draggingRef.current = false;
    setLassoPx(null);
    (ev.target as Element).releasePointerCapture(ev.pointerId);
    if (!wasDragging) return; // drag was discarded (e.g. Space pressed mid-gesture)
    if (!polygon || polygon.length < 3 || !partition || !viewState) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Build a viewport with the current view + canvas dimensions to
    // unproject the polygon vertices into normalized data space.
    const viewport = new OrthographicViewport({
      width: rect.width,
      height: rect.height,
      target: viewState.target,
      zoom: viewState.zoom,
    });
    const polyData: Array<[number, number]> = polygon.map(([px, py]) => {
      const [x, y] = viewport.unproject([px, py]);
      return [x, y];
    });
    // Test every in-scope point against the polygon. Out-of-scope
    // cells are skipped — out of scope is out of scope, period — so
    // a lasso that crosses ghosted cells can't accidentally select
    // them. ~94k × ~10 polygon edges = 1M ops; sub-50ms in JS at
    // this scale, fine without needing GPU-side picking.
    const selected: string[] = [];
    const inScopeRows = [...partition.inScopeBase, ...partition.selected];
    for (const row of inScopeRows) {
      if (pointInPolygon(row.position, polyData)) selected.push(row.id);
    }
    if (selected.length === 0) return; // suppress empty-lasso noise
    // Modifier keys at lasso-end decide the mode. Conventions match
    // Photoshop / Figma / Finder: Shift = add (extend selection),
    // Alt = subtract. Shift wins if both are held — extending is
    // the safer guess when the user is ambiguous.
    const mode: "replace" | "add" | "subtract" = ev.shiftKey
      ? "add"
      : ev.altKey
        ? "subtract"
        : "replace";
    onLassoSelect?.(selected, mode);
  }, [tool, lassoPx, partition, viewState, onLassoSelect]);

  // Wheel passthrough: the lasso overlay sits on top of deck.gl's
  // canvas with `pointer-events: auto` so it can capture left-drag
  // gestures for polygon drawing. That same hit-test prevents wheel
  // events from reaching deck.gl underneath, which would silently
  // kill scroll-zoom in lasso mode. We forward the wheel event by
  // dispatching a synthetic WheelEvent onto the canvas — deck.gl's
  // mjolnir.js listeners pick it up like any native wheel.
  //
  // The listener is attached with `{ passive: false }` so we can call
  // `preventDefault()` on the *original* event — React 17+ adds wheel
  // handlers as passive by default, so `onWheel={...}` with a
  // SyntheticEvent.preventDefault() is silently ignored and the page
  // scrolls while we zoom. The native listener is the only way to
  // block the page-scroll bleed.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheelNative = (ev: WheelEvent) => {
      const canvas = containerRef.current?.querySelector("canvas");
      if (!canvas) return;
      ev.preventDefault();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: ev.deltaX,
          deltaY: ev.deltaY,
          deltaZ: ev.deltaZ,
          deltaMode: ev.deltaMode,
          clientX: ev.clientX,
          clientY: ev.clientY,
          ctrlKey: ev.ctrlKey,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          metaKey: ev.metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);

  // Build SVG polygon path from current lasso points (while dragging).
  const lassoPath = useMemo(() => {
    if (!lassoPx || lassoPx.length < 2) return null;
    return lassoPx.map(([x, y]) => `${x},${y}`).join(" ");
  }, [lassoPx]);

  // Hover tooltip content. Looks up the bound channel values for the
  // hovered cell_id by index into the response arrays. Reads from the
  // synthetic-merged data so the __distance channel shows up here too
  // when bound (the fetched response has no block for it).
  const tooltip = useMemo(() => {
    if (!hovered || !dataWithSynthetic) return null;
    const idx = dataWithSynthetic.cell_ids.indexOf(hovered.id);
    if (idx < 0) return null;
    const lines: string[] = [`cell_id: ${hovered.id}`];
    const c = dataWithSynthetic.color;
    if (c) {
      const v = c.values[idx];
      lines.push(`${columnDisplayName(c.column)}: ${v === null || v === undefined ? "(null)" : v}`);
    }
    const s = dataWithSynthetic.size;
    if (s) {
      const v = s.values[idx];
      lines.push(
        `${columnDisplayName(s.column)}: ${
          v === null || v === undefined ? "(null)" : v
        } (range ${s.raw_range[0].toFixed(2)}–${s.raw_range[1].toFixed(2)})`,
      );
    }
    return { lines, px: hovered.px, py: hovered.py };
  }, [hovered, dataWithSynthetic]);

  // Single outer container so the ResizeObserver-bearing ref is
  // always attached — earlier conditional-return paths rendered
  // separate <div>s without the ref, so RO observed nothing and
  // measuredHeight stayed 0 (the bug behind "initial zoom is wrong;
  // Fit works"). Inner placeholders are overlay divs rendered on top
  // of the (possibly-empty) DeckGL canvas.
  const placeholder = query.isLoading
    ? "Loading universe scatter…"
    : query.isError
      ? `Failed to load scatter: ${String(query.error)}`
      : !query.data || query.data.n_cells === 0
        ? "No cells in this embedding."
        : null;
  const hasData = !!query.data && query.data.n_cells > 0;

  return (
    <div
      className="universe-scatter"
      ref={containerRef}
      style={{
        position: "relative",
        // Fixed height when the parent specifies one; otherwise fill
        // the parent (flex layouts own sizing).
        height: height ? `${height}px` : "100%",
        width: "100%",
      }}
    >
      {placeholder && (
        <div
          className={
            query.isError
              ? "universe-scatter-placeholder error"
              : "universe-scatter-placeholder"
          }
        >
          {placeholder}
        </div>
      )}
      {!hasData ? null : (
      <>
      <DeckGL
        views={new OrthographicView({ id: "ortho" })}
        viewState={viewState ?? undefined}
        // In lasso mode (without Space) we keep the controller *alive*
        // — just with drag-pan/rotate/double-click-zoom turned off — so
        // mouse-wheel zoom still works while a user is drawing
        // polygons. Pan mode and Space-held give the full controller.
        controller={
          tool === "pan" || spaceHeld
            ? true
            : {
                dragPan: false,
                dragRotate: false,
                doubleClickZoom: false,
              }
        }
        onViewStateChange={({ viewState: next, interactionState }) => {
          // Only the active gesture flags count as user interaction;
          // deck.gl will set `inTransition: false` and similar on
          // programmatic setViewState calls, which previously
          // false-positived this check.
          const is = interactionState as
            | {
                isDragging?: boolean;
                isPanning?: boolean;
                isZooming?: boolean;
                isRotating?: boolean;
              }
            | undefined;
          const isUserGesture = !!(
            is?.isDragging || is?.isPanning || is?.isZooming || is?.isRotating
          );
          if (isUserGesture) {
            hasUserInteractedRef.current = true;
          }
          setViewState({
            target: (next as { target: [number, number, number] }).target ?? [0, 0, 0],
            zoom: (next as { zoom: number }).zoom ?? FOCUSED_VIEW_ZOOM,
          });
        }}
        layers={layers}
        onClick={handleClick}
        onHover={handleHover}
        style={{ position: "absolute", left: "0", top: "0", right: "0", bottom: "0" }}
      />
      {/* Lasso overlay. Steals pointer events only while in lasso mode
          AND either a drag is in flight or no modifier is held —
          otherwise it stays `pointer-events: none` so wheel zoom,
          right-click, hover, and hold-Space pan all reach deck.gl
          naturally without a tool-toggle round-trip. */}
      <div
        className="universe-lasso-overlay"
        ref={overlayRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          pointerEvents:
            tool === "lasso" && !spaceHeld ? "auto" : "none",
          cursor:
            tool === "lasso" && !spaceHeld
              ? "crosshair"
              : spaceHeld
                ? "grab"
                : "default",
        }}
        onPointerDown={pointerStart}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
      >
        {lassoPath && (
          <svg
            width="100%"
            height="100%"
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            <polyline
              points={lassoPath}
              fill="rgba(245, 158, 11, 0.12)"
              stroke="#f59e0b"
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
          </svg>
        )}
      </div>
      {/* Color legend — top-left overlay, mirrors the toolbar. Only
          renders when a color channel is bound. Reads from the
          synthetic-merged data so the legend lights up when the user
          binds the __distance channel too. */}
      {dataWithSynthetic?.color && (
        <div className="universe-legend">
          <ColorLegend
            color={dataWithSynthetic.color}
            colormapId={colormap.id}
            colorMin={colorMin ?? null}
            colorMax={colorMax ?? null}
            colorCenter={colorCenter ?? null}
          />
        </div>
      )}
      {/* Tool toggle — top-right, pan vs lasso, plus a fit-view shortcut. */}
      <div className="universe-toolbar">
        <button
          type="button"
          className={tool === "pan" ? "active" : ""}
          onClick={() => setTool("pan")}
          title="Pan / zoom"
        >
          ✥ pan
        </button>
        {/* Lasso button is wrapped so the modifier-key cheat-sheet can
            anchor underneath as a CSS-hover tooltip. The wrapper has
            `position: relative`; the tooltip is `display: none` until
            the wrapper is hovered. */}
        <span className="universe-lasso-btn-wrap">
          <button
            type="button"
            className={tool === "lasso" ? "active" : ""}
            onClick={() => setTool("lasso")}
            aria-label="Lasso to select. Shift to add, Alt to subtract, Space to pan, Esc to clear."
          >
            ⌒ lasso
          </button>
          <div className="universe-lasso-tooltip" role="tooltip">
            <div><kbd>⇧</kbd> drag — add to selection</div>
            <div><kbd>⌥</kbd> drag — subtract from selection</div>
            <div><kbd>space</kbd> — pan while lassoing</div>
            <div><kbd>wheel</kbd> — zoom</div>
            <div><kbd>esc</kbd> — clear selection</div>
          </div>
        </span>
        <button
          type="button"
          onClick={fitView}
          title="Fit view to data"
        >
          ⤢ fit
        </button>
      </div>
      {/* Hover tooltip. Anchored to the canvas position deck.gl reports
          (info.x/y), offset so the cursor doesn't sit under it. */}
      {tooltip && (
        <div
          className="universe-tooltip"
          style={{
            position: "absolute",
            left: tooltip.px + 12,
            top: tooltip.py + 12,
            pointerEvents: "none",
          }}
        >
          {tooltip.lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
});

// --- point-in-polygon (ray-casting) -----------------------------------------

function pointInPolygon(
  point: [number, number],
  polygon: Array<[number, number]>,
): boolean {
  // Standard even-odd ray-casting. n^2 worst-case for nested polygons
  // isn't a concern — the user draws a single simple-ish polygon.
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// --- partition + extent helpers --------------------------------------------

interface Partition {
  /** Out-of-scope cells. Empty when no Filter Scope is active OR when
   *  scopeMode is "hide" (in which case they're omitted entirely so
   *  the scatter renders only the active set). Non-pickable in the
   *  layer config. Rendered ghosted (pale + low alpha). */
  outOfScope: RenderRow[];
  /** In-scope cells that aren't currently selected. The "active
   *  universe" — these are pickable, render in normal channel color,
   *  and form the base layer the user interacts with. */
  inScopeBase: RenderRow[];
  /** In-scope cells in the active selection — the orange highlight
   *  overlay layered on top of inScopeBase with a stroke + size bump.
   *  Out-of-scope bag members are NOT in this list (they live in
   *  outOfScope and look like other ghosted cells). */
  selected: RenderRow[];
  /** Bumps when color resolution changes so deck.gl's updateTriggers
   *  invalidate the GPU buffer. Identity-stable when color is unchanged. */
  colorRevision: string;
  sizeRevision: string;
}

function buildPartition(
  data: EmbeddingScatterResponse | undefined,
  inScope: Set<string> | null | undefined,
  selected: Set<string> | null | undefined,
  extent: Extent | null,
  opts: {
    sizeMinPx: number;
    sizeMaxPx: number;
    /** Size-channel data-range clipping. Null = use the full data
     *  extent (no clipping). When set, values outside the range
     *  clamp to the size endpoints; in-range values get the full
     *  rank-scaled gradient within the surviving subset. */
    sizeDataMin: number | null;
    sizeDataMax: number | null;
    /** Numeric-color clipping endpoints. Null = use the full data
     *  extent (no clipping). When set, values clamp to the endpoint
     *  colors. */
    colorMin: number | null;
    colorMax: number | null;
    /** Colormap to sample for numeric color. Ignored for categorical
     *  or unbound color. */
    colormap: Colormap;
    /** Anchor value for the colormap midpoint. Only applied when the
     *  colormap's category is "diverging" — non-diverging maps render
     *  linearly regardless. Null falls back to the linear stretch. */
    colorCenter: number | null;
    /** "ghost" keeps out-of-scope cells visible as background context;
     *  "hide" omits them entirely. */
    scopeMode: "ghost" | "hide";
  },
): Partition | null {
  if (!data || !extent) return null;
  const n = data.cell_ids.length;

  // Client-side rank-to-px scaling for the size channel. The server
  // ships raw values; we map each value to its percentile rank in the
  // sorted distribution, then linearly into [sizeMinPx, sizeMaxPx].
  // Same encoding as the backend `_scale_size_rank` used to do, but
  // now driven by the size-range slider without a refetch.
  let sizePx: number[] | null = null;
  if (data.size) {
    sizePx = rankScaleToPx(
      data.size.values,
      opts.sizeMinPx,
      opts.sizeMaxPx,
      opts.sizeDataMin,
      opts.sizeDataMax,
    );
  }
  // Per-axis linear scalers to [0, 1]. Constant-axis (xMax === xMin)
  // collapses to 0.5 so every point lands at the middle of that axis
  // rather than NaN'ing the position.
  const xSpan = extent.xMax - extent.xMin;
  const ySpan = extent.yMax - extent.yMin;
  const xScale = xSpan > 0 ? 1 / xSpan : 0;
  const yScale = ySpan > 0 ? 1 / ySpan : 0;
  const colorBlock = data.color;
  const sizeBlock = data.size;
  const hasScope = !!inScope;
  const hasSelected = !!selected && selected.size > 0;
  // "Recede the rest" condition — when a scope OR a selection is
  // active, the unmarked in-scope cells render in a more recessive
  // style so the selection (or, when there's no selection, the in-
  // scope set vs out-of-scope ghost) reads cleanly.
  const hasHighlight = hasSelected;

  // Precompute per-point color RGBA. Categorical → lookup color_map;
  // numeric → continuous Viridis; unbound → fall back to base/highlight
  // hexes depending on partition membership (decided per-point below).
  // For numeric color, user-supplied clipping (opts.colorMin / opts.
  // colorMax) overrides the data extent — values outside the clipped
  // range clamp to the endpoint hex so a long-tail outlier doesn't
  // blow the colorscale onto two extreme dots.
  // Diverging colormaps anchor their visual midpoint at `colorCenter`
  // (defaulting to (lo+hi)/2, which is a no-op — the user has to move
  // it). Non-diverging maps ignore the center and render linearly.
  const isDiverging = opts.colormap.category === "diverging";
  let numericLo = 0;
  let numericHi = 1;
  if (colorBlock?.kind === "numeric") {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of colorBlock.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (Number.isFinite(lo)) {
      numericLo = opts.colorMin != null ? opts.colorMin : lo;
      numericHi = opts.colorMax != null ? opts.colorMax : hi;
    }
  }

  const outOfScope: RenderRow[] = [];
  const inScopeBase: RenderRow[] = [];
  const selectedRows: RenderRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = data.cell_ids[i];
    const x = data.x[i];
    const y = data.y[i];
    if (x === null || y === null || x === undefined || y === undefined) continue;
    const isInScope = !hasScope || inScope!.has(id);
    // "hide" mode: skip out-of-scope cells entirely. Saves a non-
    // trivial fraction of GPU/CPU work when the scope is small (e.g.
    // 1k cells out of 94k). Selection is by definition in-scope
    // (effectiveSelection is computed as bag ∩ in-scope), so we
    // never skip a selected row.
    if (!isInScope && opts.scopeMode === "hide") continue;
    const isSelected = hasSelected && selected!.has(id);
    // Treat selection-driven recede the same way the old code did —
    // local alias for the rest of the per-point math which uses the
    // "highlight is active" condition to bump alpha / desaturation.
    const isHighlight = isSelected;

    let rgb: [number, number, number];
    if (colorBlock?.kind === "categorical") {
      const value = colorBlock.values[i];
      const hex = value === null || value === undefined
        ? colorBlock.color_map?.["(none)"] ?? "#dcdcdc"
        : colorBlock.color_map?.[String(value)] ?? "#dcdcdc";
      rgb = hexToRgb(hex);
    } else if (colorBlock?.kind === "numeric") {
      rgb = numericToColor(
        colorBlock.values[i] as number | null,
        numericLo,
        numericHi,
        opts.colormap,
        isDiverging ? opts.colorCenter : null,
      );
    } else {
      // No color binding: base layer uses one of the project's solid
      // hexes; partition decides which.
      const fallback = hasHighlight ? BASE_RGBA_WITH_HIGHLIGHT : BASE_RGBA_NO_HIGHLIGHT;
      rgb = [fallback[0], fallback[1], fallback[2]];
    }
    // Highlight alpha is full; base alpha varies by mode.
    let alpha: number;
    if (isHighlight) {
      alpha = 255;
    } else if (hasHighlight) {
      alpha = BASE_ALPHA_WHEN_HIGHLIGHT;
    } else {
      alpha = BASE_RGBA_NO_HIGHLIGHT[3];
    }
    // When color isn't bound and the point is in the highlight set,
    // use the saturated orange highlight color instead of the channel-
    // less base color so the highlight reads clearly.
    if (isHighlight && !colorBlock) {
      rgb = [HIGHLIGHT_RGBA[0], HIGHLIGHT_RGBA[1], HIGHLIGHT_RGBA[2]];
      alpha = HIGHLIGHT_RGBA[3];
    }
    // When highlight is active AND a color channel is bound, the
    // base layer's channel color competes with the highlight for
    // attention. Desaturate the non-highlighted in-scope points
    // heavily so the highlight (which keeps full saturation) reads
    // as the dominant signal. No-op when there's no color binding —
    // base is already gray.
    if (isInScope && !isHighlight && hasHighlight && colorBlock) {
      rgb = desaturate(rgb, BASE_DESATURATE_WHEN_HIGHLIGHT);
    }
    // Out-of-scope cells (ghost mode only — hide path skipped them
    // upstream). Override channel color entirely so they read as a
    // recessed background regardless of what the active color
    // binding is doing — the scope distinction outranks the channel
    // signal. They also lose alpha and any per-cell size variation
    // so the in-scope set always dominates visually.
    if (!isInScope) {
      rgb = [BASE_RGBA_WITH_HIGHLIGHT[0], BASE_RGBA_WITH_HIGHLIGHT[1], BASE_RGBA_WITH_HIGHLIGHT[2]];
      alpha = BASE_ALPHA_WHEN_HIGHLIGHT;
    }

    // Size:
    //   - Channel bound → client-rank-scaled to [sizeMinPx, sizeMaxPx]
    //   - No channel → uniform user-set size from the slider's `min`
    //     thumb (in single-thumb mode that's the only thumb).
    // Highlight gets a small absolute bump regardless of mode so it
    // still stands out from the base layer.
    let radius: number;
    if (sizePx) {
      radius = sizePx[i];
      if (isHighlight) radius += 1;
    } else {
      const baseSize = opts.sizeMinPx;
      radius = isHighlight ? baseSize + 1 : baseSize;
    }

    const nx = xScale > 0 ? ((x as number) - extent.xMin) * xScale : 0.5;
    const ny = yScale > 0 ? ((y as number) - extent.yMin) * yScale : 0.5;
    const row: RenderRow = {
      id,
      position: [nx, ny],
      color: [rgb[0], rgb[1], rgb[2], alpha],
      radius,
    };
    if (!isInScope) outOfScope.push(row);
    else if (isSelected) selectedRows.push(row);
    else inScopeBase.push(row);
  }

  // Sparse-selection visibility boost. With ~94k cells, picking out
  // a handful of highlighted points is genuinely hard at default
  // size. Bump highlight radii continuously as the count shrinks —
  // small sets get markedly larger, the threshold dissolves so there
  // isn't a visible "snap" as the user lassos one more cell into a
  // medium-sized set.
  //
  // Curve: at 1 selected cell, +8px bonus; at 500, ~0. Continuous
  // exponential decay. Combined with the always-on stroke on the
  // selected layer (see `getLineColor` in the layer config), even
  // single-cell selections become findable against a dense background.
  if (selectedRows.length > 0 && selectedRows.length <= 500) {
    const bonus = 8 * Math.exp(-selectedRows.length / 80);
    for (const row of selectedRows) {
      row.radius += bonus;
    }
  }

  // Revision strings drive deck.gl's updateTriggers — change ⇒ rebuild
  // the GPU buffers. Including the binding identity + scope/selection
  // tokens here is enough; the per-point arrays are immutable for a
  // given binding set.
  const colorRevision = `${colorBlock?.column ?? ""}|${colorBlock?.kind ?? ""}|${opts.colormap.id}|${opts.colorMin ?? ""}|${opts.colorMax ?? ""}|${isDiverging ? opts.colorCenter ?? "" : ""}|${hasHighlight ? "sel" : "no-sel"}|${hasScope ? `scope-${opts.scopeMode}` : "no-scope"}`;
  const sizeRevision = `${sizeBlock?.column ?? ""}|${opts.sizeMinPx}|${opts.sizeMaxPx}|${opts.sizeDataMin ?? ""}|${opts.sizeDataMax ?? ""}|${selectedRows.length}|${hasHighlight ? "sel" : "no-sel"}|${hasScope ? `scope-${opts.scopeMode}` : "no-scope"}`;
  return {
    outOfScope,
    inScopeBase,
    selected: selectedRows,
    colorRevision,
    sizeRevision,
  };
}

/** Percentile-rank scaling: each value maps to its position in the
 *  sorted-by-value index, then linearly into [lo, hi]. NaN values
 *  land at `lo` so they're visible but deprioritized.
 *
 *  When `dataMin` / `dataMax` are set, values outside that data range
 *  clamp to the size endpoints (≤ dataMin → lo, ≥ dataMax → hi) and
 *  only in-range values participate in the rank computation. This
 *  mirrors the color channel's clipping: a long-tail outlier doesn't
 *  squash the gradient onto the rest of the distribution.
 *
 *  O(n log n) for the sort; ~80ms on 94k values, memoized in
 *  buildPartition. Mirrors the backend's _scale_size_rank that we
 *  retired from the /scatter response.
 */
function rankScaleToPx(
  values: Array<number | null>,
  lo: number,
  hi: number,
  dataMin: number | null,
  dataMax: number | null,
): number[] {
  const n = values.length;
  const result = new Array<number>(n);
  // Default everything to lo. NaN / null cells, and cells we don't
  // overwrite below (out-of-range when clipping is active), keep the
  // default — same behavior as the un-clipped path's NaN handling.
  for (let i = 0; i < n; i++) result[i] = lo;
  // Bucket indices: in-range (participate in rank), or pinned to one
  // of the size endpoints. NaN/null sit in the default-lo bucket.
  const inRange: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (dataMin !== null && v <= dataMin) {
      result[i] = lo;
      continue;
    }
    if (dataMax !== null && v >= dataMax) {
      result[i] = hi;
      continue;
    }
    inRange.push(i);
  }
  // Rank-scale only the in-range subset across the full pixel
  // range. With no clipping (the default), this is the whole
  // dataset and the behavior matches the previous implementation.
  inRange.sort((a, b) => (values[a] as number) - (values[b] as number));
  const m = inRange.length;
  if (m === 0) return result;
  const span = hi - lo;
  for (let k = 0; k < m; k++) {
    const pct = m === 1 ? 1 : k / (m - 1);
    result[inRange[k]] = lo + pct * span;
  }
  return result;
}

interface Extent {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

function computeExtent(data: EmbeddingScatterResponse): Extent {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.cell_ids.length; i++) {
    const x = data.x[i];
    const y = data.y[i];
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    if (y === null || y === undefined || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (!Number.isFinite(xMin)) {
    return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
  }
  return { xMin, xMax, yMin, yMax };
}

function unitSquareViewState(heightPx: number): {
  target: [number, number, number];
  zoom: number;
} {
  // Data is pre-normalized to a unit square in `buildPartition`, so
  // the view always targets (0.5, 0.5) and the zoom that fits the y
  // axis depends only on the canvas height. OrthographicView's zoom
  // is log2-pixels-per-data-unit; with a 1-unit-tall data extent and a
  // 10% padding, we want heightPx * (1 - 2*padding) pixels to cover
  // the 1-unit span.
  const padding = 0.1;
  const fitHeightPx = heightPx * (1 - 2 * padding);
  const zoom = Math.log2(fitHeightPx);
  return {
    target: [0.5, 0.5, 0],
    zoom: Math.max(-10, Math.min(20, zoom)),
  };
}
