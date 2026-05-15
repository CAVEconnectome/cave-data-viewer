# Feature Explorer v2 — what shipped

`docs/feature-explorer-v2-plan.md` describes the intended v2 graft of the
explorer onto the shared toolkit. The actual landed surface is substantially
larger; this doc captures the gap and the design principles that emerged
during implementation.

Companion to `docs/feature-explorer-plan.md` (Part 1) and
`docs/feature-explorer-related-tools.md` (the single-cell-omics survey).

## What landed

### Architecture

- **Engine swap**: `UniverseScatter` rewritten on **deck.gl**
  (`@deck.gl/core` + `@deck.gl/react` + `@deck.gl/layers`). Plotly stays
  for `/neuron`'s partner-frame plots. Two `ScatterplotLayer` instances
  (base + highlight) under one `OrthographicView`. Hover/click via the
  picking buffer (sub-millisecond regardless of point count). Hand-rolled
  lasso via polygon hit-test against the rendered points; `OrthographicViewport`
  unproject maps screen → data space.
- **Per-axis normalization**: positions pre-scaled to a unit square so
  feature-vs-feature scatters get full dynamic range on both axes
  (`OrthographicView` is uniformly-scaled by design).
- **Cinematic layout**: full-bleed scatter + left rail + bottom drawer
  table. Drawer state in URL (`?table=open`).
- **PartnersTable generalized**: `keyColumn` (root_id|cell_id),
  `crossNavHref` callback, `enableNglAction`, `rowsLabel`, controlled
  `selectedIds`/`onSelectedIdsChange`, `extraActions` slot,
  `onRowNglClick` callback. `/neuron` callers unchanged via defaults.
- **embedding_cells data source** in `services/plots.py`:
  `FeatureTableQuery` implements the same `RowContext` shape `NeuronQuery`
  does (`datastack`, `mat_version`, `key_column`, `frame()`). Resolver-
  flow decoration columns join inside `frame()`; partner-frame paths
  stay unchanged.

### Endpoints

- `GET /feature_tables/<ft>/embeddings/<emb>/scatter` — universe scatter
  payload with optional `?x`, `?y`, `?color`, `?size`, `?color_min`,
  `?color_max`, `?dec`, `?mat_version` channel bindings. Returns
  per-point arrays + `color_map` (categorical) using the shared
  `resolve_categorical_color_map` so values land on the same hex
  everywhere in the project.
- `POST /feature_tables/<ft>/cells` — cell-list rows. POST (was GET)
  because `sel_cell_ids` could overflow Node's 8KB header limit on
  big lassos. Body shape: `{mat_version, dec, cells, sel_cell_ids,
  limit}`.
- `POST /knn`, `POST /resolve_roots` — unchanged from Part 1.
- `/plots/<spec_name>` — accepts either `root_id` (NeuronQuery path,
  /neuron) or `feature_table_id`+`embedding_id` (FeatureTableQuery path,
  /explore). Source comes from the spec; the endpoint picks the right
  row context.
- `embedding_cells_dynamic.yaml` plot spec — dynamic spec with
  `source: embedding_cells` so AnalyticsRail panels can render against
  feature data (not yet wired into the explorer UI).

### Channel system

- Seaborn-style **x/y/color/size pickers** in the left rail
  (`ChannelPicker`). Options merge parquet columns + decoration
  columns. Generalized `RangeSlider` supports `mode: "single" |
  "range"` — size slider is always visible (single-thumb when no
  channel bound; dual-thumb when bound).
- Size: percentile-rank scaling on the client; size-range slider is a
  free transform (no refetch). Floor at 0.25 px for sub-pixel control
  on dense embeddings.
- Color: categorical via project-shared color map; numeric via 3-stop
  Viridis approximation. Color-range slider clips the colorscale
  endpoints — outliers can't blow out long-tail features. Channel
  changes preserve pan/zoom (the auto-fit hold).
- URL keys: `?x ?y ?color ?size ?size_min ?size_max ?color_min
  ?color_max ?dec ?ft ?emb`.

### Selection / highlight feedback loop

- **Lasso is a selection action** (not a table filter). Drawing a
  polygon populates the unified row-selection set (same URL state as
  ticking checkboxes). Lasso ∩ filter scope is enforced client-side
  in the lasso handler.
- **"Limit visible to selection" / "Reset visible"** — discrete
  snapshot actions in the table's action bar. Once limited, modifying
  the selection doesn't change the visible set (avoids the "table
  shifting under your interactions" problem of a live toggle).
- **Highlight precedence**: row-sel > filter result > none. The
  scatter's highlight overlay reads the same set the NGL "selected"
  button operates on.
- **Sparse-highlight visibility**: highlight markers get an
  exponential size bonus when count is small (8 * exp(-N/80) px at
  N=1 → ~0 at N=500), plus a 1.5 px white stroke always. Single-cell
  selections are findable against 94k points. The `fit` button
  zooms to the highlight when one is active.
- **Selection state lives in component state**, not URL — large
  lassos overflowed Node's 8KB request-line header limit on
  refresh (HTTP 431). Trade-off: refresh drops selection.

### Cross-nav + Neuroglancer integration

- Cell-list rows have both `→` (cross-nav to `/neuron?root=<resolved>`)
  and `↗` (open this cell in NGL as a segment). `→` uses the resolved
  root_id; `↗` routes through `/links/segments`.
- Drawer header pills: **Open visible (N) in NGL**, **Open selected
  (M) in NGL**, **× clear selection**. All always rendered, disabled
  when their action isn't available. Bulk pills cap at 500 cells with
  reservoir sub-sampling above.
- Resolution status surfaced via the `root_id` column rendering null
  for cells that didn't resolve at the active mat_version.

### Caching

- `dcv_cell_id_universe_cache`: `LayeredSwrCache(immutable=True)`
  shared across pods + users via GCS L2. First user / first pod on a
  new mat_version pays one CAVE round-trip (~5s for the full lookup
  view); everyone else on any pod hits warm. Universe cache key
  bumped to `v2` after extending `CellUniverse` to include
  `cell_to_pos`.
- Lazy CAVE client in the `/resolve_roots` endpoint — wraps
  `request_client` so cache-hit requests skip the ~500ms client
  construction. Warm-path resolutions return in <1ms.
- Universe fetch now requests `desired_resolution=[1000,1000,1000]`
  so `pt_position` values come back in micrometers — same scale as
  the parquet's `soma_depth_y`. Free side-effect of the universe
  fetch.

### Nucleus position columns

`FeatureTableQuery.frame()` enriches every materialized request with
`nucleus.x` / `nucleus.y` / `nucleus.z` columns (µm) reading from
the universe cache's `cell_to_pos`. Channel pickers see them via
`column_groups`; users bind them like any other column. Powers the
"space × feature" workflow (nucleus.y vs soma_depth_y, color by
nucleus.z, filter by anatomical depth, etc.).

`/scatter`, `/cells`, and `resolve_plot` recognize `"nucleus"` as a
synthetic table prefix — native to the frame, no decoration join
triggered.

### Summary panel

Left-rail summary that adapts to bound channels:

- **Categorical color** → stacked bars per category, universe (gray)
  + highlight (channel color), sorted by count.
- **Numeric color or numeric size** → density-normalized histogram
  with universe + highlight overlaid. Density (each distribution
  sums to 1) so a 444-cell highlight reads against a 94k universe.
- **Both color and size bound** → both histograms render.
- **Categorical color + numeric size** → bars + size histogram.
- **Nothing bound** → just the count.

### Robustness

- **HTTP 431 fix** — selection state out of URL.
- **NaN → null** in /cells response body. pandas `to_dict` emits
  Python `float('nan')` which slips past `NumpyJSONProvider`
  (default-encoder type); stdlib `json.dumps` writes the non-
  standard `NaN` token; browser `JSON.parse` rejects. Walk rows
  after `to_dict`, coerce non-finite floats to None.
- **ResizeObserver ref** attached to the always-rendered outer
  container so initial-fit zoom fires at the right canvas size.
- **`hasUserInteractedRef`** gates auto-fit: re-fits freely until
  the user pans/zooms (caught via deck.gl's `interactionState`
  active flags only — `inTransition: false` doesn't trigger).

## Design principles that emerged this session

These weren't in the v2 plan but landed as load-bearing principles
across multiple commits:

1. **Always render disabled, never hide based on state.** The four
   header pills (open visible / open selected / clear lasso / clear
   selection) are always present in the drawer header. Disabled
   styling signals "feature exists, just not actionable now." This
   beats popping UI in/out because the user learns the action
   surface once and remembers it.

2. **Snapshot actions over live toggles when interactions can mutate
   the underlying state.** "Show only selected" as a toggle had a
   feedback loop (deselecting a row removed it from view mid-
   interaction). "Limit visible to selection" as a discrete action
   that snapshots the current selection avoids this.

3. **Lasso is selection, not filter.** Earlier the lasso filtered
   the table (`?sel_universe` → server filter); row checkboxes were
   separate (`?sel_table`). User-facing semantics conflated:
   lassoing *felt* like selecting but the "Open selected" pill was
   still empty. Unifying both into one selection set fixed the
   model. The "Limit visible to selection" action recovers the
   "narrow table to my lasso" workflow without conflating filter
   and selection in the data model.

4. **Visual hierarchy on the scatter prioritizes the highlight, not
   the channel.** When a highlight is active and a color channel is
   bound, the base layer's channel colors desaturate to grayscale
   (88% mix). The highlight stays full-saturation. Channel coloring
   is for "explore the universe"; highlight is for "what I have
   selected right now."

5. **Sparse highlights need adaptive treatment.** Single-cell
   selections in 94k points were invisible at default render size.
   Exponential size bonus on the highlight layer + always-on white
   stroke + fit-to-highlight on the toolbar's `fit` button.

6. **Local state for transient things, URL state for shareable
   things.** Selection (transient) lives in component state.
   Filter (`?cells=`), decoration tables (`?dec=`), channel
   bindings (`?x ?y ?color ?size`), drawer state (`?table`) live
   in URL — those are the configuration of a shareable view. Big
   selections can't be in URL anyway (HTTP 431 risk).

7. **Cache for all users, not per-process.** The universe cache
   moved from a module-level TTLCache to `LayeredSwrCache(immutable=True)`
   on `app.extensions` with GCS L2. The cell_id ↔ root_id mapping at
   a frozen mat_version is immutable; sharing it across pods +
   users is correct AND fast (~30ms L2 read vs ~5s CAVE fetch).

## Known gaps (covered in the related-tools doc)

The roadmap of features that were considered but not built lives in
`docs/feature-explorer-related-tools.md`. High-priority next items:

- **Manual per-feature histogram toggle** in the summary bar (see
  `docs/feature-explorer-next-steps.md` for the plan)
- **Differential features** ("what features distinguish my
  selection?") — client-side compute over `cellList.rows`
- **Similarity-based selection expansion** with PCA option +
  distance-as-column + CDF threshold finding
- **Cell ID search** (paste a root_id or cell_id, fit-to-highlight)
- **Recipes** for the explorer config
- **Density overlay** (the deferred deck.gl `HeatmapLayer` toggle)

## Files

Backend:

- `cave_data_viewer/api/endpoints/embeddings.py` — `/scatter`,
  `/cells`, `/knn`, `/resolve_roots`; channel-binding params on
  `/scatter`; POST `/cells` with body shape; column_groups assembly.
- `cave_data_viewer/api/endpoints/plots.py` — accepts either
  `root_id` (NeuronQuery) or `ft+emb` (FeatureTableQuery) body.
- `cave_data_viewer/api/services/embeddings/query.py` —
  `FeatureTableQuery` with `frame(decoration_tables=...)` enriching
  for decoration + nucleus position columns.
- `cave_data_viewer/api/services/cell_id.py` — `CellUniverse`
  with `cell_to_pos`; `cell_ids_to_positions` helper; v2 cache key;
  desired_resolution=[1000,1000,1000] for µm.
- `cave_data_viewer/api/services/plots.py` — `embedding_cells`
  source dispatch; nucleus/feature_table prefix special-casing.
- `cave_data_viewer/api/__init__.py` — `dcv_cell_id_universe_cache`
  registered.
- `cave_data_viewer/api/services/object_store.py` — `cell_id_universe`
  added to `_KINDS`.

Frontend:

- `frontend/src/components/explore/FeatureExplorer.tsx` — composition
  root.
- `frontend/src/components/explore/UniverseScatter.tsx` — deck.gl
  scatter, lasso, hover, fit-to-highlight, sparse-highlight
  treatment.
- `frontend/src/components/explore/ChannelPicker.tsx` — channel +
  range-slider pickers.
- `frontend/src/components/explore/RangeSlider.tsx` — single/range
  dual-thumb slider.
- `frontend/src/components/explore/ColorLegend.tsx` — in-chart
  legend overlay.
- `frontend/src/components/explore/SummaryPanel.tsx` — adaptive
  categorical + numeric histograms.
- `frontend/src/components/explore/FeatureTablePicker.tsx`,
  `EmbeddingPicker.tsx`, `DecorationPicker.tsx`, `KnnControls.tsx`
  — peripheral pickers.
- `frontend/src/components/PartnersTable.tsx` — generalized for
  cell-id keying, controlled selection, `extraActions` slot,
  `onRowNglClick`.
- `frontend/src/api/embeddings.ts` — `useEmbeddingList`,
  `useEmbeddingScatter`, `useCellList`, `useResolveRoots`,
  `useEmbeddingKnnMutation`.
