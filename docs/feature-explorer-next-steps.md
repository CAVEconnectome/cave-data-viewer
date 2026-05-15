# Feature Explorer — next steps plan

Immediate work queue after the v2-status snapshot in
`docs/feature-explorer-v2-status.md`. Ordered so each item is load-bearing
for the next; the first one unlocks several downstream features without
much additional infrastructure.

The broader roadmap and feature priorities live in
`docs/feature-explorer-related-tools.md`. This doc is the per-feature
implementation plan for the items the user committed to building next.

## 1. Per-column endpoint + manual histogram toggle (foundation)

### Why first

The user picked the "better option" for the histogram view: backend ships
*universe* values for any feature column on demand, so the summary panel's
universe-vs-selection comparison uses the full universe distribution, not
just the current filter scope. This endpoint also feeds:

- **Differential features** (item 2 below) — needs universe values to
  compute t-stats against
- **Similarity-based selection expansion** (item 4) — needs feature
  values to compute distances
- **Categorical breakdown panels** — universe value distribution per
  categorical column

So this is a load-bearing endpoint, not a one-off polish item.

### Endpoint

`GET /feature_tables/<ft>/column/<col>?mat_version=<mv>&dec=<csv>`

Returns the universe-aligned values for one column. Same `cell_ids` order
as `/scatter`. Shape:

```json
{
  "column": "microns_v661_soma.nucleus_volume_um",
  "kind": "numeric" | "categorical",
  "values": [...],
  "raw_range": [min, max]  // numeric only
}
```

- Parquet columns: pluck from the cached frame, no CAVE call.
- Decoration columns (`<table>.<col>`): require `?dec=<table>` + `?mv=`;
  go through the `decoration_join.py` path same as /scatter.
- `nucleus.x/y/z`: from the universe cache (resolver). Same constraint as
  other places — requires `?mv=` and materialized mode.

Caching: TanStack Query on the SPA side with `staleTime: Infinity`
(parquet content + universe cache are both immutable per binding).
Backend caches the frame already; no new server-side cache needed.

### Frontend

`useEmbeddingColumn(args)` hook in `frontend/src/api/embeddings.ts`,
keyed by `(ds, ft, mv, column, decTables)`.

`SummaryPanel` gains a stack of manually-added feature histograms below
the channel-driven ones:

- "+ add plot" button at the bottom of the panel
- Picker (column picker reusing ChannelPicker's logic) → adds the
  column to the displayed list
- × icon on each histogram to remove
- URL state: `?summary_plots=<csv of column names>` — bounded
  (column names, not cell_ids), safe in URL

Each panel calls `useEmbeddingColumn` for its column; renders
`NumericHistogram` (or a new categorical-breakdown view) with universe
+ highlight overlay.

### Effort estimate

~6 files: 1 backend endpoint, 1 frontend hook, 1 picker component,
edits to `SummaryPanel.tsx`, `FeatureExplorer.tsx` for URL state, type
additions in `api/types.ts`. ~half-day.

## 2. Differential features panel

### What

Given a selection (row-sel set is non-empty), compute which feature
columns have the most-different distributions between "selected" and
"universe minus selected." Rank them; show top-N in a sortable table
in the summary panel.

### Statistic

For numeric features: Welch's t-statistic (or Cohen's d effect size)
between the two groups. For categorical: chi-squared / Fisher's exact
on the contingency table.

Client-side compute over the per-column values (from the endpoint
above). 100ms-ish on 94k cells × dozen features.

### UI

- Tab or panel in the summary bar — "Discriminating features"
- Auto-runs when selection is non-empty
- Top 5-10 features ranked by effect size
- Each row clickable: bind that feature to color (or open as a
  histogram in the summary, or add as a filter clause)

### Effort estimate

Pure frontend if column values are already fetched. ~half-day.

## 3. Cell ID search

### What

Input box accepts a `cell_id` or `root_id`. On enter:

- If `root_id`: reverse-resolve via `useResolveRoots` (existing).
- Set as the selection (`?sel_table` local state).
- Trigger `fit` so the scatter zooms to the highlighted single cell.

### UI

A small input field in the left rail, above the channel pickers.
Placeholder: "find cell by id". Error state for unresolvable ids.

### Effort estimate

~50 lines, mostly wiring. Couple hours.

## 4. Similarity-based selection expansion

This is the one the user spelled out concretely on the survey doc — see
`docs/feature-explorer-related-tools.md` §4b for the full design.

### Backend

`POST /feature_tables/<ft>/distance_to_set`

Body:
```json
{
  "cell_ids": [seed_cell_id_1, seed_cell_id_2, ...],
  "space": "raw" | "pca" | "umap",
  "k_pca": 10,
  "reduction": "centroid" | "nearest" | "mean"
}
```

Returns universe-aligned `{cell_ids: [...], distances: [...]}`.

Implementation:

- `services/embeddings/distance.py` (new module)
- Reuse `dcv_embedding_frame_cache` for the feature matrix
- Cache PCA decomposition per `(ds, ft, feature_subset_digest)` —
  mirrors the kNN index cache pattern (`services/embeddings/knn.py`).
  sklearn's `PCA` or direct numpy SVD; fit once on the full feature
  matrix; transform is O(n_features) per cell.
- Distance: vectorized numpy `||X - seed_centroid||` (or min-over-
  seeds for nearest reduction). Sub-100ms on 94k cells.
- "umap" space: just use the embedding's declared axes from the
  parquet — already in the frame.

### Frontend

When a selection is non-empty, a new section in the summary panel:

- "Expand selection" panel with:
  - Space picker (raw / PCA / UMAP)
  - Reduction picker (centroid / nearest / mean)
  - "Compute distances" button
- On compute: hits the endpoint; adds a `distance_to_selection`
  synthetic column to the cellList rows (client-side merge)
- **CDF visualization** below: empirical CDF of distances, click to
  set threshold
- **Threshold actions**:
  - "Filter to within threshold" → appends a `cells=`
    `distance_to_selection:lte:T` clause
  - "Set as new selection" → replaces row-sel with the within-
    threshold cell_ids

Distance is also bindable to color/size on the scatter via the
channel pickers (the synthetic column appears in column_groups).

### Effort estimate

Two days. The endpoint + caching is straightforward; the CDF widget
is a small SVG component; the trickiest piece is wiring the
synthetic distance column through cellList enrichment client-side.

## 5. Recipes for the explorer

The project already has a recipe machinery for the connectivity view
(`api/services/recipes.py`, `frontend/src/tours/`). Extend it for the
explorer.

A recipe is a named snapshot of:

- `ft`, `emb` (which feature table + embedding view)
- `dec` (attached decoration tables)
- `cells` (filter expression)
- Channel bindings (`x`, `y`, `color`, `size`, `color_min`,
  `color_max`, `size_min`, `size_max`)
- `summary_plots` (manually-added histograms — from item 1)
- Drawer state, column visibility
- Optional: a selection snapshot (cell_id list, server-side stored
  via token to avoid URL size)

### Selection-token pattern

For big selections:

- `POST /selections` with `{cell_ids: [...]}` returns `{token: "<uuid>"}`
- `GET /selections/<token>` returns the cell_id list
- Server-side TTL cache (~7 days), L2 GCS for durability
- Recipe references the token (small) rather than the id list (large)

### Effort estimate

The recipe machinery is mostly built; the explorer-specific work is
~half-day. The selection-token pattern is another ~half-day.

## Execution order

1. **Per-column endpoint** + manual histogram toggle (foundation —
   item 1).
2. **Differential features** panel (item 2 — cheap follow-on of #1).
3. **Cell ID search** (item 3 — small, big usability win, independent
   of #1).
4. **Similarity expansion** (item 4 — the killer feature).
5. **Recipes** (item 5 — saves the resulting workflows).

After (4), the explorer hits the "discover" capability target the
user articulated. Items 1-3 are within a session; (4) is a longer
push; (5) is the durability layer that turns ad-hoc discoveries into
reproducible analyses.

## Things explicitly NOT in this plan

These came up in conversation but aren't yet committed-to:

- **Density toggle** as a channel (task 29 in the original v2 plan).
  deck.gl `HeatmapLayer` / `HexagonLayer` underlay. Independent of the
  above; can land any time.
- **Linked small multiples** (multiple scatters with shared selection).
  Architecturally adjacent to items 1-2 — same column infrastructure
  — but a bigger layout-shell change. Defer until the analysis stack
  above is stable.
- **Annotation UI** (let user define a new categorical column).
  Significant scope; depends on a persistence story. After (5).
- **Cross-mat-version / cross-datastack comparisons**. Architecturally
  possible; premature.
- **Two-selection comparison**. Depends on (5); fold in when the
  named-cell-set machinery exists.
