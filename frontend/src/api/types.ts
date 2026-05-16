// Types mirror the JSON shapes returned by the Flask backend.

export interface ApiError {
  code: string;
  message: string;
  hint?: string | null;
  details?: Record<string, unknown>;
}

export interface DatastackInfo {
  datastack: string;
  aligned_volume: { name?: string; description?: string; image_source?: string };
  viewer_site: string | null;
  soma_table: string | null;
  synapse_table: string | null;
  voxel_resolution: [number, number, number] | null;
  live_mode: boolean;
}

export interface DatastacksListResponse {
  datastacks: string[];
}

export interface CellIdLookupResponse {
  // Either or both keys are populated; entries map to null on no match.
  cell_to_root: Record<string, string | null>;
  root_to_cell: Record<string, string | null>;
}

export interface VersionMetadata {
  version: number;
  expires_on: string | null;
  valid: boolean;
}

export interface VersionsResponse {
  versions: VersionMetadata[];
}

export interface TableListItem {
  name: string;
  kind: "table" | "view";
  /** Free-text description from CAVE table metadata. Long; the SPA truncates
   *  with a "show more" toggle. Null when the metadata endpoint had nothing
   *  for this table — happens for views (no batch view-metadata endpoint),
   *  or when the upstream metadata fetch failed. */
  description?: string | null;
  /** Annotation schema, e.g. "synapse", "cell_type_local", "cell_type_reference",
   *  "bound_tag". Useful as a chip — the user can scan for the kind of table
   *  they're after without reading every name. */
  schema_type?: string | null;
  /** When set, this is a reference table that points its `target_id` at rows
   *  in `reference_table`. Surfaced as a small "→ <table>" badge in the UI. */
  reference_table?: string | null;
  /** Voxel resolution in nm/voxel for this table's points. Mostly informative;
   *  shown compactly as "4×4×40 nm" in the card detail row. */
  voxel_resolution?: [number, number, number] | null;
  /** Row count on the materialized version we queried metadata against.
   *  Null when CAVE didn't populate `valid_row_count` for this table. */
  row_count?: number | null;
}

export interface TablesResponse {
  tables: TableListItem[];
  /** Mirrors the requested mode: `null` for live, integer for a specific
   *  materialization. The SPA's "tables (live)" / "v<N>" label keys off this. */
  mat_version: number | null;
  /** The version actually used to fetch the names + metadata. In live mode
   *  this resolves to the latest valid materialized version (CAVE doesn't
   *  expose a stable live table set). Lets the SPA disclose "live, showing
   *  v<N>" when it wants to without having to re-run the version lookup. */
  effective_mat_version: number | null;
}

/** Full distinct-string-values dict for a table, returned by the
 *  `/datastacks/<ds>/tables/<table>/values` endpoint. Maps each string-typed
 *  column to its complete universe of values across the entire table —
 *  not just the loaded slice — so category filter dropdowns surface every
 *  selectable choice even when the table is too large to load in full. */
export interface TableUniqueValuesResponse {
  table: string;
  values: Record<string, string[]>;
}

export interface TableRowsResponse {
  datastack: string;
  table: string;
  is_view: boolean;
  offset: number;
  limit: number;
  filters: Record<string, unknown>;
  row_count: number;
  /** True when the response was capped at `limit` and matching rows beyond
   *  the cap may exist. The SPA flips into "server mode" filter dispatch
   *  on this signal and shows a partial-results disclosure. */
  limit_hit: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
}

// Note on root_id: int64 CAVE root ids exceed JS Number precision (float64,
// safe up to 2^53). The backend serializes them as JSON strings and the SPA
// keeps them as strings throughout — never call Number() on a root id.
export interface PartnerRecord {
  root_id: string;
  // Optional because the unified Both-tab row schema replaces this with a pair
  // of `n_syn_in` / `n_syn_out` columns; directional-tab rows always carry it.
  num_syn?: number;
  num_soma?: number;
  cell_id?: string | null;  // present only when num_soma == 1 (unique nucleus)
  // Per-row datastack tag. Always present on Feature Explorer cell rows
  // (the loader fills it with the request's ds when the parquet doesn't
  // already declare it); absent on /neuron partner rows, which are
  // single-ds by construction. Cross-nav prefers row.source_ds when
  // present, falling back to the URL's ?ds.
  source_ds?: string;
  // Annotation-table columns land as `<table>.<col>` (e.g.
  // `cell_type_multifeature_combo.cell_type`); aggregation columns from
  // `synapse_aggregation_rules` are bare. The index signature covers both.
  [k: string]: unknown;
}

export interface ConnectivitySummary {
  num_partners_in: number | null;
  num_partners_out: number | null;
  num_syn_in: number;
  num_syn_out: number;
  num_soma: number;
  soma_pt_position: [number, number, number] | null;
}

/**
 * One logical group of partner-record columns. The frontend renders these as
 * a two-row header: top row is the group `name` spanning its `columns`, bottom
 * row is the bare column header (last segment after the dot in dotted names).
 *
 * `kind`:
 *   "intrinsic" — root_id
 *   "synapse"   — num_syn + aggregation rules
 *   "soma"      — num_soma + cell_id
 *   "table"     — an annotation table (cell-type, status, free-form);
 *                  columns are dotted keys (`<table>.<col>`)
 */
export interface ColumnGroup {
  name: string;
  kind: "intrinsic" | "synapse" | "soma" | "table";
  columns: string[];
}

export interface ConnectivityBundle {
  datastack: string;
  root_id: string;
  version_used: number | "live";
  timestamp_used: string | null;
  synapse_table: string;
  soma_table: string | null;
  partners_in?: PartnerRecord[];
  partners_out?: PartnerRecord[];
  /** The queried cell itself, shaped as a single partner-style record so
   *  the SPA's "Cell" tab can reuse the same column-rendering machinery
   *  as the partner tabs. Holds intrinsic + cell-type + decoration +
   *  spatial annotations; synapse-group fields don't apply (per-edge
   *  stats are per-partner by construction). */
  root_record?: PartnerRecord;
  summary?: ConnectivitySummary;
  synapse_columns_meta: {
    aggregation_rules: { name: string; column: string; agg: string }[];
    synapse_table: string;
  };
  column_groups: ColumnGroup[];
  decoration_revalidation: {
    ticket_id: string;
    pending_root_ids: string[];
    poll_url: string;
  } | null;
  /** Set when the backend translated a stale root_id via
   *  `chunkedgraph.suggest_latest_root` because synapse queries on the
   *  original root returned empty. Both directions empty is a strong
   *  signal that proofreading edited the cell since the URL was minted;
   *  the backend silently retries with the suggested current root and
   *  surfaces the swap so the SPA can update `?root=` and notify the
   *  user. `original` and `current` are stringified int64 root_ids
   *  (same convention as `root_id` itself). `reason` is a short
   *  machine-readable tag for logs / future-feature dispatch. */
  root_id_updated?: {
    original: string;
    current: string;
    reason: string;
  };
  /** SpatialProvider-facing metadata: axis-role mapping, per-column label
   *  overrides, supported summary kinds. Drives the SPA's depth-axis
   *  treatment and label rendering without hardcoding cortex column
   *  names — a thalamus provider that emits `dist_from_center` instead
   *  of `soma_depth` plumbs through here. Always present; an empty-
   *  shape object for null-provider datastacks. */
  spatial_meta: SpatialMeta;
  /** Per-cell summary visualizations emitted by the spatial provider.
   *  Empty list when the provider has no panels for this cell (e.g.
   *  cortex with no synapses, or a null provider). The SPA dispatches
   *  on `kind` to a registered renderer. */
  summary_panels: SummaryPanel[];
}

export interface SpatialMeta {
  /** Provider name — `"cortex"` / `"null"` / future `"thalamus"`. Mainly
   *  for debugging; the SPA shouldn't branch on it. */
  provider: string;
  /** Axis-role → column-name mapping. Cortex publishes `depth`,
   *  `tangential_x`, `tangential_z`; other providers fill in their own
   *  set. Use to look up "which column is the depth axis on this
   *  datastack" without grepping for `soma_depth`. */
  axes: Record<string, { column: string; label: string }>;
  /** Column-name → role tag, including unifier `_in` / `_out` variants
   *  of per-direction features. Drives `isCellPositionColumn` (a column
   *  with role `depth` or `tangential` is a valid cell-marker axis) and
   *  any future axis-aware affordances. Roles: `depth` / `tangential` /
   *  `radial` / `distance` / `other`. */
  column_roles: Record<string, string>;
  /** Provider-emitted column label overrides. Cortex uses this to rename
   *  `radial_dist_root_soma` → `radial_dist` for table headers. Layered
   *  on top of the SPA's anatomy-independent renames in
   *  `tableColumns.tsx::DISPLAY_NAME_OVERRIDES`. */
  label_overrides: Record<string, string>;
  /** Summary-panel kinds the provider declares it could emit (whether
   *  or not data is present for a given cell). The actual data lives
   *  on `summary_panels`; this list drives "which presets show in the
   *  '+ Add plot' menu" for summary kinds. */
  summary_kinds: string[];
  /** Cortex-only echo of the datastack's depth-axis config. Other
   *  providers leave these absent. */
  depth_range?: [number, number] | null;
  layer_boundaries?: number[] | null;
  layer_names?: string[] | null;
}

export interface SummaryPanel {
  kind: string;
  /** Renderer-specific payload. The SPA's per-kind renderer narrows
   *  this to a typed shape (e.g. `SynapseDepthProfileData` for
   *  `kind === "synapse_depth_profile"`). */
  data: Record<string, unknown>;
}

export interface SynapseDepthProfileData {
  bin_edges: number[];
  counts_in: number[];
  counts_out: number[];
  depth_axis_name: string;
  depth_range: [number, number] | null;
  layer_boundaries: number[] | null;
  layer_names: string[] | null;
}

export interface LinkResponse {
  url: string;
  shortened: boolean;
}

/**
 * Operator-curated tour entries (examples + recipes) loaded by the landing
 * page and the sidebar Recipes widget. Mirrors the YAML schema in
 * `services/datastack_config.py` (TourBase / Example / Recipe).
 *
 * Bindings are JSON-stringified into the SPA's `?viz_<id>=` URL key
 * verbatim; field names match the backend wire contract.
 */
export interface TourPlotBindings {
  x?: string | null;
  y?: string | null;
  hue?: string | null;
  size?: string | null;
  weight?: string | null;
  scope?: string | null;
  show_cell_depth?: boolean | null;
}

export interface TourPlot {
  /** Author-facing label (for diff readability). The SPA generates fresh
   *  panel ids on apply so opening the same tour twice doesn't collide. */
  id?: string | null;
  /** Summary panel kind (e.g. "synapse_depth_profile"). Mutually exclusive
   *  with `bindings`; if both are set the SPA prefers `summary_kind`. */
  summary_kind?: string | null;
  bindings?: TourPlotBindings | null;
  /** When true, this panel opts out of the tour's `cells:` filter. The SPA
   *  collects matching panel ids into the `?unfilter=` URL key at apply
   *  time. Defaults to false. */
  unfiltered?: boolean | null;
}

export interface TourBase {
  id: string;
  title: string;
  description?: string | null;
  decoration_tables: string[];
  plots: TourPlot[];
  /** Raw `?cells=` URL value. Shape: `<table>.<col>:<op>:<val>[,...]`. */
  cells?: string | null;
  hide: string[];
  show: string[];
  coll: string[];
  /** Body schema version. Server stamps `1` if absent on PUT; future
   *  schema changes use this for negotiation. See
   *  `cave_data_viewer/api/services/recipes.py`. */
  version?: number;
  /** Reserved for a future personal/team/shared distinction. Not yet
   *  surfaced in the UI; the field name is reserved on both sides so a
   *  newer client can introduce it without an older server stripping it.
   */
  kind?: string;
  /** Reserved for a future organization/search-labels feature. */
  tags?: string[];
}

export interface Example extends TourBase {
  mat_version: number;
  /** Stringified int64 root id. */
  root: string;
}

export type Recipe = TourBase;

export interface ToursResponse {
  datastack: string;
  examples: Example[];
  recipes: Recipe[];
}

// Plotly's figure JSON. We don't try to type the full Plotly trace shape —
// react-plotly.js consumes it as `data`/`layout` directly. The backend builds
// it server-side via go.Figure.to_json().
export interface PlotResponse {
  figure: { data: unknown[]; layout: Record<string, unknown> };
  meta?: {
    /** Rows after cell-filter mask (or before, if no filter is active). */
    matched_count: number;
    /** Rows before cell-filter mask. Equal to matched_count when no filter. */
    pre_filter_count: number;
    filtered: boolean;
  };
}

/** Catalog entry from `GET /plot_specs`. Drives the SPA's plot picker so
 *  adding a new plot template doesn't require a frontend code change. */
export interface PlotSpecCatalogEntry {
  name: string;
  /** Primary chart kind. Dynamic specs may auto-pick a different kind at
   *  request time based on which axes the SPA binds. */
  kind: "bar" | "histogram" | "scatter" | "stripplot";
  dynamic: boolean;
  description: string;
  /** Source frame the plot reads from. Drives whether the SPA shows a
   *  source-side summary or a unified-frame editor. */
  source: "partners_in" | "partners_out" | "partners_both";
}

export interface PlotSpecCatalogResponse {
  specs: PlotSpecCatalogEntry[];
}

// ---- Feature Explorer ------------------------------------------------------

/** One embedding under a feature table — a 2D scatter view. */
export interface EmbeddingListItem {
  id: string;
  title: string;
  description: string | null;
  axes: [string, string];
  default_color_by: string | null;
  /** Optional override of the table's feature_columns for kNN over this
   *  embedding. ``null`` means "inherit from the parent table". */
  knn_features: string[] | null;
  /** Which axis (if any) is depth-shaped; lets the rendering pipeline
   *  flip the axis + overlay layer markers. */
  depth_axis: "x" | "y" | null;
}

/** A manifest-declared category — a named subset of a feature table's
 *  columns used purely for UI organization (channel-picker optgroups,
 *  "+ add plot" menus, mass select/deselect). Columns may appear in
 *  multiple categories; columns not referenced by any category render
 *  under an implicit "Uncategorized" group. */
export interface FeatureCategory {
  id: string;
  title: string;
  description: string | null;
  /** Bare parquet column names (same namespace as `feature_columns`
   *  and `categorical_columns`). The SPA prefixes them with the
   *  feature_table id when matching against the dotted channel
   *  namespace. */
  columns: string[];
}

/** One feature table — the data unit; owns rows, features, and a list
 *  of embeddings (views) declared over those rows. */
export interface FeatureTableListItem {
  id: string;
  title: string;
  description: string | null;
  id_column: string;
  feature_columns: string[] | null;
  categorical_columns: string[];
  depth_columns: string[];
  has_audit: boolean;
  /** Optional manifest-declared categories. Empty array = no
   *  categorization declared; the SPA falls back to grouping by
   *  feature/categorical kind. */
  categories: FeatureCategory[];
  embeddings: EmbeddingListItem[];
}

export interface EmbeddingKnnDefaults {
  default_k: number;
  max_k: number;
  standardize: boolean;
}

/** One participant in a manifest's datastack set. Single-ds manifests have
 *  exactly one entry (the parent datastack). Multi-ds manifests (phase 2)
 *  list every participating datastack so the SPA can detect joint-embedding
 *  mode up front and toggle multi-select / per-row routing UI without a
 *  manifest re-fetch. */
export interface ManifestDatastackEntry {
  name: string;
  /** Per-datastack override for `cell_id_source_table`. When set, takes
   *  precedence over the datastack YAML's value — used by joint manifests
   *  where different participants anchor on different source tables. */
  cell_id_source_table: string | null;
}

export interface FeatureTableListResponse {
  /** When false, every other field is omitted — the explorer is not
   *  configured for this datastack and the SPA should hide /explore. */
  enabled: boolean;
  cell_id_source_table?: string;
  /** Manifest-declared participating datastacks. Always populated when
   *  `enabled` is true; single-ds (or pre-phase-1) manifests collapse to a
   *  one-element list naming the request's `ds`. */
  datastacks?: ManifestDatastackEntry[];
  knn?: EmbeddingKnnDefaults;
  feature_tables?: FeatureTableListItem[];
}

/** Back-compat alias. The catalog used to be a flat embeddings list under
 *  schema v1; the catalog hook keeps the historical name even though the
 *  inner shape is now feature_tables. */
export type EmbeddingListResponse = FeatureTableListResponse;

export interface EmbeddingKnnNeighbor {
  cell_id: string;
  distance: number;
  /** Datastack tag for the neighbor. Single-ds parquets emit a uniform
   *  value (every neighbor inherits the query's ds); phase-2 multi-ds
   *  parquets carry the actual per-row source. Always present on
   *  responses from phase-1+ servers. */
  source_ds?: string;
}

export interface EmbeddingKnnResponse {
  query_cell_id: string;
  /** Datastack the query cell_id resolves under. Used by the SPA when
   *  the kNN result feeds cross-nav, so the destination /neuron URL
   *  picks the query's home ds even if the SPA's active datastack
   *  scope is broader. */
  query_source_ds?: string;
  neighbors: EmbeddingKnnNeighbor[];
}

export type ResolutionStatus = "ok" | "missing" | "ambiguous";

export interface CellRootResolution {
  cell_id: string;
  root_id: string | null;
  status: ResolutionStatus;
  /** Datastack the cell_id was resolved in. Single-ds path-scoped
   *  /resolve_roots emits a uniform value (the URL's ds); phase-2
   *  body-scoped /resolve_roots will emit per-row source_ds so a
   *  multi-ds batch resolves correctly in one round trip. */
  source_ds?: string;
  /** Only populated when status === "ambiguous". */
  candidates?: string[];
}

export interface ResolveRootsResponse {
  mat_version: string | null;
  resolutions: CellRootResolution[];
}

/** Per-input status from `POST /feature_tables/<ft>/find_cells`:
 *  - `ok`: chunkedgraph aligned + nucleus reverse-resolved cleanly.
 *  - `unaligned`: chunkedgraph couldn't walk the lineage at the
 *    request's mat_version (root unknown to the chunkedgraph or no
 *    usable timestamp).
 *  - `unresolved`: alignment succeeded but the aligned root has no
 *    nucleus mapping in the datastack's lookup view at this
 *    mat_version (cell deleted, or root_id_lookup_main_table is stale).
 */
export type FindCellStatus = "ok" | "unaligned" | "unresolved";

export interface FindCellResult {
  /** Echo of the input root_id (string, since chunkedgraph root_ids
   *  exceed JS Number precision). */
  original_root_id: string;
  /** Aligned root_id at the request's mat_version. `null` when
   *  `status === "unaligned"`. */
  root_id: string | null;
  /** Resolved cell_id on the explorer's universe. `null` when
   *  `status !== "ok"`. */
  cell_id: string | null;
  /** `true` when the chunkedgraph swapped the input for a different
   *  current root (i.e. the input was stale). `false` when the input
   *  was already current at this mat_version. */
  aligned: boolean;
  status: FindCellStatus;
}

export interface FindCellsResponse {
  mat_version: string | null;
  /** One result per input, in input order. */
  results: FindCellResult[];
}

export interface EmbeddingColorBlock {
  column: string;
  kind: "categorical" | "numeric";
  /** Same length as `cell_ids`. Categorical → strings or null;
   *  numeric → numbers or null. */
  values: Array<string | number | null>;
  /** Value → hex map. Present only on categorical channels; lets the
   *  scatter reuse the project's consistent categorical palette so a
   *  predicted_class value lands on the same hex it does in /neuron. */
  color_map?: Record<string, string>;
}

export interface EmbeddingSizeBlock {
  column: string;
  /** Raw numeric values, same length as `cell_ids`. Nullable for
   *  rows where the source column was NaN. The client rank-scales
   *  these to px in UniverseScatter (so the size-range slider is a
   *  free client-side transform with no refetch), and SummaryPanel
   *  bins them for the distribution overlay. */
  values: Array<number | null>;
  raw_range: [number, number];
}

/** Scatter (universe) payload for one embedding view. */
export interface EmbeddingScatterResponse {
  cell_ids: string[];
  /** Parallel per-row datastack tag. Single-ds manifests emit a uniform
   *  array (every value equals the request's ds); multi-ds manifests
   *  (phase 2) diverge per row. The SPA reads this when routing
   *  cross-nav or coloring by source dataset; phase-1 readers can ignore
   *  it since every entry equals the workspace's active ds. */
  source_ds?: string[];
  /** Per-point x and y values. Nullable because a parquet column
   *  (e.g. a subset-embedding axis) may be null for cells outside the
   *  subset; the scatter drops those points. */
  x: Array<number | null>;
  y: Array<number | null>;
  axes: { x: string; y: string };
  color: EmbeddingColorBlock | null;
  size: EmbeddingSizeBlock | null;
  n_cells: number;
}

/** Universe-aligned values for a single column. Same `cell_ids` order
 *  as `EmbeddingScatterResponse`, so selection masks built against the
 *  scatter index in directly to this response's `values`. Used by the
 *  manual-histogram surface in SummaryPanel and (eventually) by the
 *  differential-features + similarity-expansion features. */
export interface EmbeddingColumnResponse {
  column: string;
  cell_ids: string[];
  /** Parallel per-row datastack tag (same shape as on
   *  `EmbeddingScatterResponse`). Optional for forward compatibility
   *  with older servers. */
  source_ds?: string[];
  n_cells: number;
  kind: "numeric" | "categorical";
  /** Same length + order as `cell_ids`. Numeric → numbers or null;
   *  categorical → strings or null. */
  values: Array<number | null> | Array<string | null>;
  /** Numeric only. [min, max] over the finite values; 0/0 when the
   *  column is entirely null. */
  raw_range?: [number, number];
  /** Categorical only. Value → hex; same palette resolution as the
   *  scatter's `color_map` so a category lands on the same hex
   *  everywhere. */
  color_map?: Record<string, string>;
}

/** Cell-list rows for the explorer's PartnersTable mounting. Shape
 *  mirrors the partners-frame so the same component renders both. */
export interface FeatureTableCellsResponse {
  cell_ids: string[];
  /** Row records keyed by cell_id; parquet columns are prefixed with the
   *  feature_table_id (e.g. `morpho_sample.predicted_class`) so they
   *  share the `<table>.<col>` namespace with decoration columns. */
  rows: PartnerRecord[];
  column_groups: ColumnGroup[];
  matched_count: number;
  total_count: number;
  limit: number;
  limit_hit: boolean;
}
