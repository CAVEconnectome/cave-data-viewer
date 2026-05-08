/**
 * Declarative plot list rendered into the analytics rail.
 *
 * Each entry produces one plot panel. Static plots fix a backend spec; column-
 * bound plots accept a runtime column choice (e.g. a decoration column) and
 * select between a bar and a histogram backend spec based on the chosen
 * column's inferred kind.
 *
 * Per-plot column bindings persist via `?viz_<id>=<col>` URL keys so each
 * plot's selection survives reload and travels with shared links.
 *
 * Adding a new plot:
 *   - drop a YAML template into `cave_data_viewer/api/templates/plots/`
 *   - add a descriptor here referencing its `name` (for static) or its
 *     bar/histogram spec names (for column-bound)
 */

export interface StaticPlotDescriptor {
  id: string;
  title: string;
  kind: "static";
  spec: string;  // backend plot spec name (matches templates/plots/<name>.yaml)
}

export interface ColumnBoundPlotDescriptor {
  id: string;
  title: string;
  kind: "column-bound";
  source: "partners_out" | "partners_in";
  barSpec: string;
  histogramSpec: string;
}

/**
 * Runtime-configurable plot. The user binds x/y/hue/size from any column on
 * the *unified* partner record (one row per unique partner root_id, with both
 * `n_syn_out` / `n_syn_in` and per-direction aggregation columns available).
 * The backend's `dynamic: true` spec auto-picks chart kind:
 *   - 1 axis → histogram
 *   - 2 axes → scatter
 *
 * Active dynamic panels live in URL state (`?plots=<id>,...`); each panel's
 * bindings live at `?viz_<id>={...json...}`. Adding a panel = appending an
 * id to `?plots=`.
 */
export interface DynamicPlotDescriptor {
  id: string;
  title: string;
  kind: "dynamic";
  /** Backend spec name with `dynamic: true` — uses `partners_both`. */
  spec: string;
}

export type PlotDescriptor =
  | StaticPlotDescriptor
  | ColumnBoundPlotDescriptor
  | DynamicPlotDescriptor;

/**
 * Pre-baked panels rendered above the runtime-creatable list. Currently empty
 * — every plot is user-configured via "+ Add plot". Re-introduce static or
 * column-bound entries here when there's a panel that should always be
 * present (e.g. a fixed cortical-depth plot for cortex datastacks).
 *
 * Most backend specs in `api/templates/plots/` are *templates* that the "+
 * Add plot" picker references, not standalone-renderable panels — bar /
 * histogram specs need a runtime column binding, so auto-promoting them
 * here would render as empty boxes. The backend `/plot_specs` catalog
 * (exposed via `usePlotSpecs()`) is the right plumbing for the picker UI;
 * this list is for panels that should *always* mount.
 */
export const plotRegistry: PlotDescriptor[] = [];

/**
 * Hook form preserved so AnalyticsRail can swap in dynamic resolution later
 * (e.g. per-datastack defaults sourced from the backend) without changing
 * its call site. Today it returns the static list as-is.
 */
export function useResolvedPlotRegistry(): PlotDescriptor[] {
  return plotRegistry;
}
