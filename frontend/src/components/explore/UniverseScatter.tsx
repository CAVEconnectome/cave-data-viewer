import { lazy, Suspense, useCallback, useMemo } from "react";
import { useEmbeddingScatter } from "../../api/embeddings";

// Lazy-load react-plotly the same way PlotPanel does — keeps the ~2MB
// plotly bundle out of the landing-page / partner-browsing critical path.
// Same Plotly cartesian dist for parity; scattergl is included.
const Plot = lazy(async () => {
  const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
    import("react-plotly.js/factory"),
    import("plotly.js-cartesian-dist-min"),
  ]);
  return { default: createPlotlyComponent(Plotly.default) };
});

const PLOTLY_CONFIG = { displaylogo: false, responsive: true };

interface Props {
  ds: string;
  featureTableId: string;
  embeddingId: string;
  /** Cell_ids to render in the highlight trace (orange, full opacity).
   *  The complement (universe \ highlight) renders in the base trace
   *  (gray, low opacity). Empty or null → everything is in the base. */
  highlightedCellIds?: Set<string> | null;
  /** Called with cell_ids when the user box/lasso selects on the
   *  scatter. Suppressed when the selection is empty so a phantom
   *  Plotly event doesn't clear a real selection. */
  onLassoSelect?: (cellIds: string[]) => void;
  /** Called when the user clicks a single point — typically used to
   *  set a focal cell_id in URL state. */
  onPointClick?: (cellId: string) => void;
  height?: number;
}

/**
 * Universe scatter for the Feature Explorer.
 *
 * Renders every cell in a feature table at its 2D embedding coordinates,
 * with optional highlight overlay. Built around two scattergl traces:
 *
 * - **base** — universe \ highlight, gray, low opacity.
 * - **highlight** — the active highlight set, orange, full opacity.
 *
 * Splitting into two traces (rather than per-point opacity changes on a
 * single trace) lets Plotly skip re-layout on selection changes — only
 * the trace `x`/`y`/`customdata` arrays swap, which is cheap.
 *
 * Selection plumbing: each point's `customdata` carries the cell_id, so
 * the parent reads the lasso/click result without consulting any side
 * channel. Empty selections are suppressed (phantom event from Plotly's
 * deselect handler).
 */
export function UniverseScatter({
  ds,
  featureTableId,
  embeddingId,
  highlightedCellIds,
  onLassoSelect,
  onPointClick,
  height = 480,
}: Props) {
  const query = useEmbeddingScatter({
    ds,
    featureTableId,
    embeddingId,
  });

  // Partition the universe into base + highlight by index. Using arrays
  // keyed off the canonical cell_ids[i] order means the highlight set is
  // a Set<string> intersection — no per-point allocation in the inner
  // loop beyond the Set lookup itself.
  const { baseTrace, highlightTrace } = useMemo(() => {
    const data = query.data;
    if (!data) {
      return { baseTrace: null, highlightTrace: null };
    }
    const hl = highlightedCellIds;
    const hasHighlight = hl != null && hl.size > 0;
    if (!hasHighlight) {
      // Single trace at full opacity is more readable when nothing is
      // being highlighted (the dim-everything fallback would feel like
      // a bug — "why are the dots so faded?").
      return {
        baseTrace: {
          type: "scattergl",
          mode: "markers",
          x: data.x,
          y: data.y,
          customdata: data.cell_ids,
          marker: { size: 4, color: "#5b8bd1", opacity: 0.6 },
          hovertemplate: "%{customdata}<extra></extra>",
          name: "universe",
        },
        highlightTrace: null,
      };
    }
    const baseX: number[] = [];
    const baseY: number[] = [];
    const baseIds: string[] = [];
    const hlX: number[] = [];
    const hlY: number[] = [];
    const hlIds: string[] = [];
    for (let i = 0; i < data.cell_ids.length; i++) {
      const cid = data.cell_ids[i];
      if (hl!.has(cid)) {
        hlX.push(data.x[i]);
        hlY.push(data.y[i]);
        hlIds.push(cid);
      } else {
        baseX.push(data.x[i]);
        baseY.push(data.y[i]);
        baseIds.push(cid);
      }
    }
    return {
      baseTrace: {
        type: "scattergl",
        mode: "markers",
        x: baseX,
        y: baseY,
        customdata: baseIds,
        marker: { size: 3, color: "#9ca3af", opacity: 0.25 },
        hovertemplate: "%{customdata}<extra></extra>",
        name: "other",
      },
      highlightTrace: {
        type: "scattergl",
        mode: "markers",
        x: hlX,
        y: hlY,
        customdata: hlIds,
        marker: { size: 5, color: "#f59e0b", opacity: 0.9 },
        hovertemplate: "%{customdata}<extra></extra>",
        name: "selected",
      },
    };
  }, [query.data, highlightedCellIds]);

  const traces = useMemo(() => {
    const out: unknown[] = [];
    if (baseTrace) out.push(baseTrace);
    if (highlightTrace) out.push(highlightTrace);
    return out;
  }, [baseTrace, highlightTrace]);

  const layout = useMemo(
    () => ({
      autosize: true,
      height,
      margin: { l: 40, r: 12, t: 8, b: 36 },
      xaxis: { title: { text: query.data?.axes.x ?? "" }, zeroline: false },
      yaxis: { title: { text: query.data?.axes.y ?? "" }, zeroline: false },
      // `dragmode: 'lasso'` gives users selection on the first interaction
      // — pan stays available via the toolbar.
      dragmode: "lasso" as const,
      hovermode: "closest" as const,
      showlegend: false,
    }),
    [height, query.data?.axes.x, query.data?.axes.y],
  );

  const handleSelected = useCallback(
    (ev: { points?: Array<{ customdata?: unknown } | undefined> } | undefined) => {
      if (!ev || !ev.points) return;
      const ids = new Set<string>();
      for (const p of ev.points) {
        const cd = p?.customdata;
        if (typeof cd === "string") ids.add(cd);
      }
      if (ids.size === 0) return; // suppress phantom deselect events
      onLassoSelect?.(Array.from(ids));
    },
    [onLassoSelect],
  );

  const handleClick = useCallback(
    (ev: { points?: Array<{ customdata?: unknown } | undefined> } | undefined) => {
      if (!ev || !ev.points || ev.points.length === 0) return;
      const cd = ev.points[0]?.customdata;
      if (typeof cd === "string") onPointClick?.(cd);
    },
    [onPointClick],
  );

  if (query.isLoading) {
    return (
      <div className="universe-scatter loading" style={{ height }}>
        Loading universe scatter…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="universe-scatter error" style={{ height }}>
        Failed to load scatter: {String(query.error)}
      </div>
    );
  }
  if (!query.data || query.data.n_cells === 0) {
    return (
      <div className="universe-scatter empty" style={{ height }}>
        No cells in this embedding.
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="universe-scatter loading" style={{ height }}>
          Loading plotly…
        </div>
      }
    >
      <Plot
        data={traces as Parameters<typeof Plot>[0]["data"]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height }}
        useResizeHandler
        onSelected={handleSelected}
        onClick={handleClick}
      />
    </Suspense>
  );
}
