/**
 * Plot recipes for the "+ Add plot" dropdown.
 *
 * Two flavours:
 *
 *   - **Static** (`STATIC_PLOT_PRESETS`) — table-agnostic recipes whose
 *     bindings reference intrinsic columns only (`soma_depth`,
 *     `soma_x`/`soma_z`) or summary fields on the bundle. Listed at the
 *     popover's root level alongside the drill-down entry points.
 *   - **Drill-down** (categorical bar charts) — built by composing
 *     `[direction] × [measure] × [table] × [column]` at each level of
 *     the popover. The drill-down doesn't materialize all crosses up-
 *     front (the count would explode with multiple tables loaded);
 *     instead the popover walks the available levels with
 *     `availableMeasures(bundle)` + `categoricalColumnsByTable(bundle)`
 *     and only the leaf click constructs the final `PlotBindings`.
 *
 * Either flavour, on click, writes the bindings into a fresh
 * `?viz_<id>={...}` URL key and appends the new id to `?plots=`. From
 * the rendering side both look identical — the chip starts collapsed
 * (because bindings exist) and the user can expand to tweak.
 */

import type { ConnectivityBundle, ColumnGroup, PartnerRecord } from "../api/types";
import type { PlotBindings } from "../api/queries";
import { classify } from "./columns";
import { directionalColumnNames, unifyColumnGroups } from "./unify";

// Canonical summary-kind union lives on `components/SummaryPanels.tsx`
// alongside the renderer registry (single source of truth — adding a
// new kind happens in one place). Re-exported here so callers that only
// touch presets don't need a separate import.
export type { SummaryKind } from "../components/SummaryPanels";
import type { SummaryKind } from "../components/SummaryPanels";

export interface PlotPreset {
  /** Stable identifier — used as the React key in the menu. Independent
   *  of the panel id this preset will create (each click generates a
   *  fresh `dyn-<random>` or `sum-<kind>-<random>`). */
  id: string;
  /** Menu text. Phrasing convention: "<measurement> by <grouping>" so
   *  the menu reads as a parallel list. */
  label: string;
  /** Tooltip shown on hover. Optional — omit when the label is
   *  self-explanatory. */
  description?: string;
  /** The recipe. Written verbatim to the new panel's `?viz_<id>=` URL
   *  key via `encodeVizParam`. Mutually exclusive with `summaryKind`
   *  in practice — bindings entries drive `<DynamicPlotPanel>`,
   *  summary entries drive a dedicated component. */
  bindings?: PlotBindings;
  /** When set, the preset adds a summary panel (id prefix `sum-<kind>-`)
   *  rather than a bindings-driven dynamic panel. The analytics rail
   *  recognises the prefix and renders the matching component. */
  summaryKind?: SummaryKind;
  /** Unified-frame column names that must exist on the bundle for the
   *  preset to be enabled. Missing columns → menu entry greyed out
   *  with a tooltip naming what's needed. Hue / size that gracefully
   *  degrade (fallback to colorway / fixed size) don't need to be
   *  listed; only columns the chart truly can't function without. */
  requires?: string[];
}

/**
 * Static presets — table-agnostic recipes that don't depend on which
 * cell-type / decoration tables are loaded. The categorical-axis
 * presets ("Output synapses by cell_type", etc.) are NOT here; the
 * popover composes those via the drill-down using
 * `availableMeasures` + `categoricalColumnsByTable`.
 */
export const STATIC_PLOT_PRESETS: PlotPreset[] = [
  {
    id: "soma_depth_distribution",
    label: "Soma depth distribution",
    description: "Histogram of partner soma depths in cortical coordinates",
    bindings: { x: "soma_depth" },
    requires: ["soma_depth"],
  },
  {
    id: "soma_layout_topdown",
    label: "Top-down soma layout (x vs z)",
    description: "Scatter of partner soma positions in the cortex-flat plane",
    // No hue pre-binding — let the user pick what to color by from the
    // panel pickers. The previous `hue: cell_type` default was nice
    // when a cell-type table was loaded but coupled the preset to a
    // specific datastack convention; users can still bind `cell_type`
    // (or any other categorical column) themselves once the panel
    // mounts. Backend now also drops missing hue/size silently, so
    // even hue-bound presets never 422 — but cleaner not to pre-bind
    // a column the preset can't guarantee.
    bindings: { x: "soma_x", y: "soma_z" },
    requires: ["soma_x", "soma_z"],
  },
  {
    id: "synapse_depth_profile",
    label: "Synapse depth profile (input + output)",
    description:
      "Per-cell histogram of all input and output synapses vs cortical depth — a top-level summary, not partner-driven",
    summaryKind: "synapse_depth_profile",
    // No `requires` (the gate is `bundle.summary_panels.some(p => p.kind === ...)`,
    // which `summaryAvailable` checks below). Column-name `requires`
    // doesn't apply since this preset isn't binding-driven.
  },
  {
    id: "out_syn_depth_vs_soma_depth",
    label: "Output synapse depth vs. partner soma depth",
    description: "Median output synapse depth vs. each partner's soma depth, colored by cell type, sized by net_size",
    bindings: {
      x: "soma_depth",
      y: "median_syn_depth_out",   // _out suffix on the unified frame
      size: "net_size_out",
    },
    requires: ["soma_depth", "median_syn_depth_out"],
  },
];


/** A weight measure offered at the drill-down's "measure" level
 *  ("Number" / "Mass"). Each one resolves to two unified-frame
 *  columns — `<col_prefix>_out` for the output direction,
 *  `<col_prefix>_in` for input — once the user has picked a
 *  direction. The popover materializes the final preset by combining
 *  direction + measure + (table, column) at the leaf click. */
export interface MeasureChoice {
  /** Stable id for the React key + state. */
  id: "count" | "mass";
  /** Menu label. */
  label: string;
  /** Tooltip describing what the bar plot sums. */
  description: string;
  /** Unified-frame column prefix; `_out` / `_in` are appended at use. */
  colPrefix: "n_syn" | "net_size";
}

/** Measures that exist in this bundle. `net_size` is only available
 *  when the datastack's synapse aggregation rules include it (BANC
 *  has it, some don't); `n_syn` is always present. */
export function availableMeasures(bundle: ConnectivityBundle): MeasureChoice[] {
  const groups = (bundle.column_groups ?? []) as ColumnGroup[];
  const directional = new Set(directionalColumnNames(groups));
  const out: MeasureChoice[] = [
    {
      id: "count",
      label: "Number (synapse count)",
      description: "Bar height = total number of synapses",
      colPrefix: "n_syn",
    },
  ];
  if (directional.has("net_size")) {
    out.push({
      id: "mass",
      label: "Mass (summed synapse size)",
      description: "Bar height = total synaptic mass (sum of synapse sizes)",
      colPrefix: "net_size",
    });
  }
  return out;
}

/**
 * Categorical columns in the bundle, grouped by their source table.
 * Drives the drill-down's "table" and "column" levels: the popover
 * renders one entry per table at the table level, then one entry per
 * column at the column level.
 *
 * `key` is the bind-ready column name (`cell_type` for the canonical
 * cell-type group, `<table>.<col>` for generic decoration tables —
 * matches how the unified frame keys its records). `display` is the
 * bare column name for the menu label.
 *
 * Empty when no rows are sampled (no partners → no values to classify).
 */
export function categoricalColumnsByTable(
  bundle: ConnectivityBundle,
): Array<{ table: string; columns: { key: string; display: string }[] }> {
  const groups = (bundle.column_groups ?? []) as ColumnGroup[];
  // Either direction's frame works for column classification — the
  // categorical fields are per-root_id (same value in both). Use
  // partners_out by default; fall back when the queried cell only has
  // inputs (common for axon fragments).
  const rows = ((bundle.partners_out?.length ? bundle.partners_out : bundle.partners_in) ?? []) as PartnerRecord[];
  if (rows.length === 0) return [];

  const out: Array<{ table: string; columns: { key: string; display: string }[] }> = [];
  for (const g of groups) {
    if (g.kind !== "table") continue;
    const cols: { key: string; display: string }[] = [];
    for (const col of g.columns) {
      const profile = classify(col, rows as Record<string, unknown>[]);
      const isCategorical =
        profile.vocabulary === "categorical-palette" ||
        profile.vocabulary === "categorical-greyscale";
      if (!isCategorical) continue;
      const display = col.includes(".") ? col.slice(col.indexOf(".") + 1) : col;
      cols.push({ key: col, display });
    }
    if (cols.length > 0) out.push({ table: g.name, columns: cols });
  }
  return out;
}

/**
 * Walk the bundle's column_groups and return the set of column names
 * the SPA can bind to on the unified frame. Mirrors the unifier's
 * `_in` / `_out` synapse-column split so directional names like
 * `n_syn_out`, `net_size_in`, `median_syn_depth_out` resolve. Includes
 * the synthetic `direction` column emitted by `partners_both` source.
 */
export function availableColumns(bundle: ConnectivityBundle): Set<string> {
  const groups = (bundle.column_groups ?? []) as ColumnGroup[];
  const directional = directionalColumnNames(groups);
  const unified = unifyColumnGroups(groups, directional);
  const set = new Set<string>(["direction"]);
  for (const g of unified) {
    for (const c of g.columns) set.add(c);
  }
  return set;
}

export function presetIsAvailable(preset: PlotPreset, available: Set<string>): boolean {
  return (preset.requires ?? []).every((c) => available.has(c));
}

export function missingRequirements(preset: PlotPreset, available: Set<string>): string[] {
  return (preset.requires ?? []).filter((c) => !available.has(c));
}

/**
 * Availability gate for summary-kind presets (those with `summaryKind`
 * set). Each summary kind reads from a different bundle field, so the
 * gate logic is per-kind. `null` return means "not a summary preset" —
 * the caller falls back to `presetIsAvailable` for column-name gating.
 */
export function summaryAvailable(
  preset: PlotPreset,
  bundle: ConnectivityBundle,
): boolean | null {
  if (!preset.summaryKind) return null;
  return bundle.summary_panels.some((p) => p.kind === preset.summaryKind);
}

/** Tooltip text explaining why a summary preset is greyed out, when it
 *  is. `null` when the preset is available (no tooltip needed) or
 *  isn't a summary kind. */
export function summaryUnavailableReason(
  preset: PlotPreset,
  bundle: ConnectivityBundle,
): string | null {
  if (!preset.summaryKind) return null;
  if (summaryAvailable(preset, bundle)) return null;
  if (preset.summaryKind === "synapse_depth_profile") {
    return "Needs: spatial transform configured for this datastack";
  }
  return "Unavailable for this datastack";
}

