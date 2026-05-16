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
  /** Cell_ids to render in the highlight layer (orange or, when color
   *  is bound, the channel color). The complement renders in the base
   *  layer (light gray when highlighting, solid blue otherwise).
   *  Empty/null = no highlight; single base layer at full weight. */
  highlightedCellIds?: Set<string> | null;
  /** Called with the lasso-selected cell_ids. Suppressed on empty
   *  selections so a phantom drag doesn't clear a real selection. */
  onLassoSelect?: (cellIds: string[]) => void;
  /** Called when the user clicks a single point. */
  onPointClick?: (cellId: string) => void;
  /** Optional fixed height. When unset, the component fills its
   *  parent (use this in flex layouts where the parent owns sizing).
   *  Required when the parent has no intrinsic height. */
  height?: number;
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
    colorMin,
    colorMax,
    colormapId,
    colorCenter,
    decorationTables,
    matVersion,
    highlightedCellIds,
    onLassoSelect,
    onPointClick,
    height,
  },
  ref,
) {
  const colormap = useMemo(() => getColormap(colormapId), [colormapId]);
  // Tool state — pan or lasso. Default pan so the very first
  // interaction (explore the universe) feels right. Toggle in the
  // top-right corner of the scatter; sticks until the user toggles
  // back so repeated lassos don't require re-clicking.
  const [tool, setTool] = useState<"pan" | "lasso">("pan");
  // Active lasso polygon in canvas-pixel coordinates. `null` when not
  // currently dragging. Points are accumulated as the user moves the
  // pointer; on release we convert to data space and emit cell_ids.
  const [lassoPx, setLassoPx] = useState<Array<[number, number]> | null>(null);
  // Hover state — picked cell_id + the bound channel values at that
  // point. Lazily computed once on hover so it doesn't recompute every
  // mousemove.
  const [hovered, setHovered] = useState<{
    id: string;
    px: number;
    py: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
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

  // Per-point resolved color/size arrays + base/highlight partition.
  // Positions are pre-normalized to a unit square so the
  // OrthographicView's uniform scaling doesn't squash one axis flat
  // when the data ranges differ wildly (depth: 1–1500 vs folding ratio:
  // 0–2). Pan/zoom operate in normalized space; axis labels (when we
  // add them) inverse-transform tick positions through `extent`.
  const partition = useMemo(
    () =>
      buildPartition(query.data, highlightedCellIds, extent, {
        sizeMinPx: sizeMinPx ?? 2,
        sizeMaxPx: sizeMaxPx ?? 18,
        colorMin: colorMin ?? null,
        colorMax: colorMax ?? null,
        colormap,
        colorCenter: colorCenter ?? null,
      }),
    [
      query.data,
      highlightedCellIds,
      extent,
      sizeMinPx,
      sizeMaxPx,
      colorMin,
      colorMax,
      colormap,
      colorCenter,
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
    // When a highlight is active, frame the viewport on the
    // highlighted cells specifically — that's almost always what
    // "fit" means in the moment (the user is looking for them).
    // Otherwise fit the full unit square (default extent).
    if (partition && partition.highlight.length > 0) {
      // Highlight positions are in the same normalized [0,1]×[0,1]
      // space the view targets. Find their bounding box, pad ~15%
      // for breathing room, set view center + zoom to that.
      let minX = 1;
      let maxX = 0;
      let minY = 1;
      let maxY = 0;
      for (const r of partition.highlight) {
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
    const base = new ScatterplotLayer({
      id: "universe-base",
      data: partition.base,
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
    });
    if (partition.highlight.length === 0) return [base];
    // Thin black stroke on every selected marker. The fill carries
    // most of the selection signal against a heavily-recessed base
    // layer; the stroke is just enough edge to keep marks legible at
    // any fill color, including pale colormap ends. The exponential
    // size bonus in `buildPartition` handles single-cell findability.
    const hl = new ScatterplotLayer({
      id: "universe-highlight",
      data: partition.highlight,
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
    });
    return [base, hl];
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
    if (tool !== "lasso") return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    setLassoPx([[px, py]]);
    (ev.target as Element).setPointerCapture(ev.pointerId);
  }, [tool]);

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
    setLassoPx(null);
    (ev.target as Element).releasePointerCapture(ev.pointerId);
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
    // Test every rendered point against the polygon. ~94k × ~10
    // polygon edges = 1M ops; sub-50ms in JS at this scale, fine
    // without needing GPU-side picking.
    const selected: string[] = [];
    const all = [...partition.base, ...partition.highlight];
    for (const row of all) {
      if (pointInPolygon(row.position, polyData)) selected.push(row.id);
    }
    if (selected.length === 0) return; // suppress empty-lasso noise
    onLassoSelect?.(selected);
  }, [tool, lassoPx, partition, viewState, onLassoSelect]);

  // Build SVG polygon path from current lasso points (while dragging).
  const lassoPath = useMemo(() => {
    if (!lassoPx || lassoPx.length < 2) return null;
    return lassoPx.map(([x, y]) => `${x},${y}`).join(" ");
  }, [lassoPx]);

  // Hover tooltip content. Looks up the bound channel values for the
  // hovered cell_id by index into the response arrays.
  const tooltip = useMemo(() => {
    if (!hovered || !query.data) return null;
    const idx = query.data.cell_ids.indexOf(hovered.id);
    if (idx < 0) return null;
    const lines: string[] = [`cell_id: ${hovered.id}`];
    const c = query.data.color;
    if (c) {
      const v = c.values[idx];
      lines.push(`${c.column}: ${v === null || v === undefined ? "(null)" : v}`);
    }
    const s = query.data.size;
    if (s) {
      const v = s.values[idx];
      lines.push(
        `${s.column}: ${
          v === null || v === undefined ? "(null)" : v
        } (range ${s.raw_range[0].toFixed(2)}–${s.raw_range[1].toFixed(2)})`,
      );
    }
    return { lines, px: hovered.px, py: hovered.py };
  }, [hovered, query.data]);

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
        controller={tool === "pan"}
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
      {/* Lasso overlay. `pointer-events: auto` only when in lasso mode
          so the deck.gl controller is responsible for pointer events
          during pan/zoom. */}
      <div
        className="universe-lasso-overlay"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          pointerEvents: tool === "lasso" ? "auto" : "none",
          cursor: tool === "lasso" ? "crosshair" : "default",
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
          renders when a color channel is bound. */}
      {query.data?.color && (
        <div className="universe-legend">
          <ColorLegend
            color={query.data.color}
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
        <button
          type="button"
          className={tool === "lasso" ? "active" : ""}
          onClick={() => setTool("lasso")}
          title="Lasso to select"
        >
          ⌒ lasso
        </button>
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
  base: RenderRow[];
  highlight: RenderRow[];
  /** Bumps when color resolution changes so deck.gl's updateTriggers
   *  invalidate the GPU buffer. Identity-stable when color is unchanged. */
  colorRevision: string;
  sizeRevision: string;
}

function buildPartition(
  data: EmbeddingScatterResponse | undefined,
  highlight: Set<string> | null | undefined,
  extent: Extent | null,
  opts: {
    sizeMinPx: number;
    sizeMaxPx: number;
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
    sizePx = rankScaleToPx(data.size.values, opts.sizeMinPx, opts.sizeMaxPx);
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
  const hasHighlight = !!highlight && highlight.size > 0;

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

  const base: RenderRow[] = [];
  const hl: RenderRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = data.cell_ids[i];
    const x = data.x[i];
    const y = data.y[i];
    if (x === null || y === null || x === undefined || y === undefined) continue;
    const isHighlight = hasHighlight && highlight!.has(id);

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
    // attention. Desaturate the non-highlighted points heavily so
    // the highlight (which keeps full saturation) reads as the
    // dominant signal. No-op when there's no color binding — base
    // is already gray.
    if (!isHighlight && hasHighlight && colorBlock) {
      rgb = desaturate(rgb, BASE_DESATURATE_WHEN_HIGHLIGHT);
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
    if (isHighlight) hl.push(row);
    else base.push(row);
  }

  // Sparse-highlight visibility boost. With ~94k cells, picking out
  // a handful of highlighted points is genuinely hard at default
  // size. Bump highlight radii continuously as the count shrinks —
  // small sets get markedly larger, the threshold dissolves so there
  // isn't a visible "snap" as the user lassos one more cell into a
  // medium-sized set.
  //
  // Curve: at 1 highlighted cell, +8px bonus; at 500, ~0. Continuous
  // exponential decay. Combined with the always-on stroke on the
  // highlight layer (see `getLineColor` in the layer config), even
  // single-cell selections become findable against a dense background.
  if (hl.length > 0 && hl.length <= 500) {
    const bonus = 8 * Math.exp(-hl.length / 80);
    for (const row of hl) {
      row.radius += bonus;
    }
  }

  // Revision strings drive deck.gl's updateTriggers — change ⇒ rebuild
  // the GPU buffers. Including the binding identity here is enough; the
  // per-point arrays are immutable for a given binding set.
  const colorRevision = `${colorBlock?.column ?? ""}|${colorBlock?.kind ?? ""}|${opts.colormap.id}|${opts.colorMin ?? ""}|${opts.colorMax ?? ""}|${isDiverging ? opts.colorCenter ?? "" : ""}|${hasHighlight ? "hl" : "no-hl"}`;
  const sizeRevision = `${sizeBlock?.column ?? ""}|${opts.sizeMinPx}|${opts.sizeMaxPx}|${hl.length}|${hasHighlight ? "hl" : "no-hl"}`;
  return { base, highlight: hl, colorRevision, sizeRevision };
}

/** Percentile-rank scaling: each value maps to its position in the
 *  sorted-by-value index, then linearly into [lo, hi]. NaN values
 *  land at `lo` so they're visible but deprioritized.
 *
 *  O(n log n) for the sort; ~80ms on 94k values, memoized in
 *  buildPartition. Mirrors the backend's _scale_size_rank that we
 *  retired from the /scatter response.
 */
function rankScaleToPx(
  values: Array<number | null>,
  lo: number,
  hi: number,
): number[] {
  const n = values.length;
  // Sort indices by value to compute ranks. NaN/null entries get
  // a sentinel rank of 0 (lo) without participating in the sort
  // among real values.
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v !== null && Number.isFinite(v)) idx.push(i);
  }
  idx.sort((a, b) => (values[a] as number) - (values[b] as number));
  const result = new Array<number>(n);
  // Default everything to lo; sorted indices overwrite below.
  for (let i = 0; i < n; i++) result[i] = lo;
  const m = idx.length;
  if (m === 0) return result;
  // Map sorted positions into [lo, hi]. Ties: average rank handled
  // implicitly by stable sort + linear position, close enough.
  const span = hi - lo;
  for (let k = 0; k < m; k++) {
    const pct = m === 1 ? 1 : k / (m - 1);
    result[idx[k]] = lo + pct * span;
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
