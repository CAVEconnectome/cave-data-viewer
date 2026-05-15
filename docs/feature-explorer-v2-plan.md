# Feature Explorer v2 — unified experience over the shared toolkit

## Context

`docs/feature-explorer-plan.md` (Part 1) shipped a working `/explore` route with hand-rolled scatter, table, filter, and selection components. That parallel UI was rolled back (1da2714) once it became clear the project already owns the right primitives in `/neuron` and `/tables/*`: `PartnersTable`, `PlotPanel` / `DynamicPlotPanel`, `AnalyticsRail`, `CellFilterPanel`, and the `?cells=` / `?dec=` / `?plots` / `?viz_*` / `?sel_*` URL vocabulary.

v2 grafts the explorer onto those primitives so that **the explorer is another data source over a shared UI framework, not a separate framework**. The unification goal is one mental model — and one set of components to maintain — across single-cell connectivity browsing (`/neuron`) and population feature browsing (`/explore`).

### Foundation already in place (preserved through the rollback)

- Manifest schema v2: `feature_tables` own the data, `embeddings` are 2D views nested under them. `GET /feature_tables`, `POST /knn`, `POST /resolve_roots` endpoints.
- Universe-level `cell_id ↔ root_id` cache per `(ds, mv)` (595b338) — one CAVE fetch per mat_version, dict-fast thereafter. Removes resolver cost from the inner loop of lasso, filter, and cross-nav.
- `services/embeddings/` package: `manifest.py`, `loader.py`, `knn.py`, `resolver.py`, `decoration_join.py`, `source.py`, `uri.py`.
- Three caches: manifest (L1, SWR), frame (L1 + L2 GCS, immutable), kNN index (L1).
- `EmbeddingPicker`, `DecorationPicker`, `KnnControls` components.

### Removed in the rollback (will be re-derived from shared primitives)

- `ChannelPicker`, `EmbeddingScatter`, `ExplorerTable`, `FeatureFilters`, `SelectionPane`.
- Backend `/points` and `/column` endpoints — their work moves into the unified plot resolver path.

## Settled design decisions

| Question | Decision |
| --- | --- |
| **Row identity in shared components** | `PartnersTable` learns an explicit primary-key column. The data source declares `key_column: "root_id" \| "cell_id"`; `PartnersTable` takes a `keyColumn` prop and a `crossNavHref` callback. No synthetic-root_id columns. |
| **Scatter placement** | The universe scatter is a *first-class page element*, not an `AnalyticsRail` panel. It renders all cells from the parquet, with the filter result overlaid as a highlight trace. Sibling histograms / bar charts over feature columns *do* live in the rail and brush back into the same highlight set. |
| **Cell list latency** | The cell list is paged client-side from an L2-served full frame. `n` shown of `N` indicator. First load is parquet-fast (~hundreds of ms cold, sub-50ms warm); the scatter requests the same parquet so the two views stay synchronized without a second fetch. |
| **kNN** | Deferred. Backend endpoint stays live (`POST /feature_tables/<ft>/knn` is harmless to leave). UI integration — how kNN selections relate to lasso selections, brush highlights, and the `?sel_*` machinery — is a follow-up plan. |

### The universe-plot framing (drives most of v2)

The scatter is fundamentally different from every plot the project currently renders:

- It is **always over the universe** (all cells in the feature table), never over a filtered subset.
- Selection state — `?cells=` filter result, `?sel_<id>=` brush from a histogram, lasso on the scatter itself — is rendered as a **highlight layer** over the universe trace, not by recomputing the trace.
- The cell list table at the bottom shows the *filtered* subset with paging — it's a different consumer of the same selection set.
- A cross-cutting "highlight set" of cell_ids is the shared object: the scatter overlays it, the table filters by it, sibling histograms brush into it.

Concretely: the universe trace is computed once per `(ft, embedding)` and cached in the frame. The highlight set is computed by applying `?cells=` clauses + `?sel_*` brushes to that frame; the same set drives the scatter overlay and the cell-list table filter.

## The `embedding_cells` data source

`services/plots.py:DataQuery.source` becomes:

```python
Literal["partners_in", "partners_out", "partners_both", "embedding_cells"]
```

The `resolve_plot` dispatch already branches on `source`. Today it pulls frames from a `NeuronQuery`. v2 introduces a thin abstraction over the row context so the resolver works against either:

```python
class RowContext(Protocol):
    """Source of a dataframe + the column that identifies its rows."""
    @property
    def key_column(self) -> str: ...        # "root_id" | "cell_id"
    @property
    def datastack(self) -> str: ...
    @property
    def mat_version(self) -> int | Literal["live"]: ...
    def frame(self) -> pd.DataFrame: ...    # already-merged with decoration
```

`NeuronQuery` already satisfies this in spirit (`partners_in()` / `partners_out()` / unified frame) — the refactor is to expose `key_column = "root_id"` and have the resolver consult it. The new `FeatureTableQuery` implements the same Protocol with `key_column = "cell_id"` and `frame()` reading from `services/embeddings/loader.py`.

### Decoration merge for cell_id-keyed frames

The big asymmetry. Today `resolve_plot` calls `lookup_decorations(root_ids=df["root_id"].astype(int).tolist(), ...)`. For `embedding_cells`:

1. Take the frame's `cell_id` column → resolve each to `root_id` at `?mv` via the universe cache (one O(1) dict lookup per id after the universe is warm).
2. Call `lookup_decorations` with the resolved `root_ids`.
3. Join positionally back onto the frame's rows; missing/ambiguous → `null`.
4. Returned column names are `<table>.<column>` exactly like the partners-frame path.

This logic already exists in `services/embeddings/decoration_join.py` from Part 1; v2 calls it from `resolve_plot` rather than from the deleted `/column` endpoint.

### Filter (`?cells=`) on cell_id-keyed frames

`_apply_cell_filters` is column-name based and works unchanged once decoration columns are merged. The user writes `?cells=cell_type_multifeature_combo.cell_type:eq:L4_PYR,soma_depth_y:between:200,400` — the first clause references a decoration column (joined via the resolver), the second references a parquet column (already on the frame).

## URL keys

Shared with `/neuron` (same syntax, same parser, same semantics):

| Param | Meaning |
| --- | --- |
| `ds` | datastack |
| `mv` | mat version — drives the resolver and any cross-nav |
| `dec` | attached decoration tables |
| `cells` | filter expression (parquet columns + `table.column` decoration columns) |
| `plots` | analytics-rail panel list |
| `viz_<id>` | per-panel channel bindings |
| `sel_<id>` | per-panel brush selection (cell_id set in `/explore`, root_id set in `/neuron`) |
| `hide` / `show` / `coll` | column visibility / collapsed groups in the cell-list table |
| `unfilter` | AnalyticsRail "show all" toggle |

Explorer-only:

| Param | Meaning |
| --- | --- |
| `ft` | feature table id (selects the dataset) |
| `emb` | embedding view id (selects axes within `ft`) |

Deferred (kNN follow-up): `cell`, `neighbors`, `k`, `knn_features`.

## Page layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Workspace shell — sidebar, breadcrumb, share menu (inherited)   │
├──────────────┬───────────────────────────────────┬──────────────┤
│ Left rail    │ Universe scatter (primary)        │ AnalyticsRail│
│              │  - all cells from ft.emb          │  - histograms│
│ ft picker    │  - highlight overlay = ?cells ∪   │    over      │
│ emb picker   │    ⋃ ?sel_<id>                    │    feature   │
│ dec picker   │  - lasso writes a ?sel_<id>       │    columns   │
│ CellFilter   │  - hover → cell_id + bound vals   │  - brushes   │
│   Panel      │                                   │    AND into  │
│              ├───────────────────────────────────┤    highlight │
│              │ Cell list (PartnersTable mold)    │              │
│              │  - rows: filtered subset, paged   │              │
│              │  - n / N indicator                │              │
│              │  - column groups: axes + features │              │
│              │    + attached decoration columns  │              │
│              │  - row click → /neuron via        │              │
│              │    useResolveRoots cross-nav      │              │
└──────────────┴───────────────────────────────────┴──────────────┘
```

`Workspace.tsx` already provides the shell + sidebar + breadcrumb. The `/explore` route mounts a new component (rebuilt `FeatureExplorer.tsx`) that composes:

- left rail: `EmbeddingPicker` (now `FeatureTablePicker` + `EmbeddingPicker`), `DecorationPicker`, `CellFilterPanel`
- center: `UniverseScatter` (new, the explorer's one bespoke component) above `PartnersTable` (with explorer key column + cross-nav callback)
- right: `AnalyticsRail` (existing, reading `embedding_cells` as its data source)

## Component changes

### `PartnersTable` — generalize to a key column

The single hard-coded assumption to remove is `getRowId: (row) => row.root_id` (line 567) and the four other `root_id` references (lines 35, 341, 471, 548). Replace with two new props:

```ts
interface Props {
  // ... existing props ...
  /** Primary-key column name on each row. Defaults to "root_id" so /neuron
   *  callers are unchanged. */
  keyColumn?: "root_id" | "cell_id";
  /** Builds the cross-nav href for a clicked row. Defaults to the existing
   *  partnerHref builder (root_id → /neuron). Explorer passes a builder that
   *  resolves cell_id → root_id at the current mv before constructing the
   *  /neuron URL. */
  crossNavHref?: (rowId: string) => string;
}
```

`getRowId`, `globalFilterFn`, the brush comparison, and the link rendering all read from these props. The `__action_ngl__` column (per-row "open in Neuroglancer") becomes a no-op or hidden when `keyColumn === "cell_id"` and the row hasn't been resolved yet — alternatively, the resolution can happen lazily on click, since the universe cache makes the round-trip free for warm pods.

### `AnalyticsRail` — neutralize the `NeuronQuery` assumption

`AnalyticsRail` currently takes `ds` / `rootId` / `matVersion` / `bundle: ConnectivityBundle`. v2 swaps the trailing two for an abstract `dataContext` prop that carries enough for the rail to build its `?plots` / `?viz_*` requests:

```ts
type DataContext =
  | { kind: "neuron"; ds: string; matVersion: number | "live"; bundle: ConnectivityBundle }
  | { kind: "embedding"; ds: string; matVersion: number | "live"; ft: string; emb: string };
```

The rail's job is unchanged: render panels, wire brushes, manage `?sel_*`. The plot fetch hook routes through to the right backend endpoint based on `kind`. `summaryAvailable` / preset gating learns the explorer's column set (driven by the feature table's `feature_columns` + `categorical_columns` + attached decoration columns).

### `UniverseScatter` — the one bespoke explorer component

Why this isn't an `AnalyticsRail` panel:

- It always renders the universe; the rail's mental model is "panels over the filter result".
- It owns the lasso, which writes to a `?sel_<id>=` key the rail then reads. Coordinating that ownership through the rail's panel registry is more wiring than it's worth.
- The highlight set is rendered as a second WebGL trace; that's a render strategy specific to the universe-vs-highlight split, not a generic plot.

Implementation outline (~150 lines, lazy-imported plotly like `PlotPanel`):

- Fetches the universe via `useUniverseScatter(ds, ft, emb)` — returns `{cell_ids, x, y, n_cells}` from a new `GET /feature_tables/<ft>/embeddings/<emb>/scatter` endpoint backed by the existing frame cache.
- Computes the highlight set client-side from `?cells=` + `?sel_*` — a Set<cell_id>. No backend round-trip per filter change.
- Two `scattergl` traces: universe (gray, low opacity) and highlight (orange, full opacity). State updates swap which ids belong to which trace.
- `onSelected` writes a new `?sel_<id>=` key with the lasso'd cell_ids, registered against the rail's panel list as `panel=universe_scatter`.
- Hover shows cell_id + currently-bound color column value (if any decoration column is bound to `color`).

### Cell list — `PartnersTable` over the filter result

Fetched via `usePlotsResolve` (or its data-only sibling) with `source=embedding_cells` and the active `?cells=` filter. The endpoint returns the filtered frame; the table renders it directly. Column groups follow the feature table's schema:

- `cell_id` (primary key, always visible)
- axes group: `umap_x`, `umap_y` (or whatever the embedding declares)
- features group: parquet `feature_columns`
- categoricals group: parquet `categorical_columns`
- one group per attached decoration table

The `n shown of N` indicator reads from the response (`filtered_count` and `total_count`).

## Backend changes

### `services/plots.py`

- Add `embedding_cells` to `DataQuery.source`.
- Extract `RowContext` Protocol (or its informal equivalent) so `resolve_plot` reads `key_column` and a `frame()` method instead of always reaching for `nq.partners_in()` etc.
- `FeatureTableQuery` class in `services/embeddings/query.py` implements the protocol: loads the parquet, calls the resolver + `lookup_decorations` for any decoration tables on the request, returns a merged frame.
- The decoration merge inside `resolve_plot` (currently `lookup_decorations(..., root_ids=df["root_id"]...)`) branches on `key_column`: cell_id-keyed frames resolve first.

### `services/embeddings/`

- New `query.py` for `FeatureTableQuery`. Thin — most logic is already in `loader.py` + `decoration_join.py`.
- Keep `decoration_join.py`. Its callers shift from the deleted `/column` endpoint to `FeatureTableQuery.frame()`.

### `endpoints/embeddings.py`

- Restore a `GET /feature_tables/<ft>/embeddings/<emb>/scatter` endpoint returning the universe (cell_ids + x + y, no filter, no decoration). Cheaper than `/points` because it doesn't take `color_by` — color is bound by the SPA from any other column it fetches separately.
- Add a `POST /feature_tables/<ft>/embeddings/<emb>/cells` endpoint (or fold this into the existing plot endpoint) that returns the filter-resolved frame for the cell list table.
- `POST /knn` and `POST /resolve_roots` keep their current shape.

### `endpoints/plots.py`

- Accept `embedding_cells` as a `source` value. Route to `FeatureTableQuery` instead of `NeuronQuery` based on whether the request carries `ft` + `emb` or `root_id`.
- The plot fetch hook (`useDynamicPlot` or equivalent) calls this with `?ft=&emb=&plot_id=&viz=...&cells=&dec=...` for explorer panels.

## Task sequence

Ordered to keep the SPA bootable at every commit. Each task aims for a single commit.

1. **Backend: `RowContext` Protocol + `embedding_cells` plot source.** Refactor `resolve_plot` to read `key_column` and `frame()` from an abstract context; add `FeatureTableQuery` implementing the protocol; route `source: embedding_cells` to it. No new endpoints yet — verified by a unit-style smoke test against the local manifest.
2. **Backend: `/scatter` endpoint.** Universe payload, no filter, no decoration. Backed by `dcv_embedding_frame_cache`. ~50 lines.
3. **Backend: plot endpoint accepts explorer context.** `endpoints/plots.py` routes `?ft=&emb=` to `FeatureTableQuery`; existing `?root=` path is unchanged.
4. **Frontend: `PartnersTable` learns `keyColumn` + `crossNavHref` props.** Default values preserve `/neuron` behavior. Touch only the prop surface + the five hard-coded `root_id` references.
5. **Frontend: `AnalyticsRail` takes a `dataContext` discriminated union.** `/neuron` callers wrap their existing args; an `/explore` caller passes `kind: "embedding"`. The rail's preset / column-availability logic learns the explorer's column set.
6. **Frontend: `UniverseScatter` component.** Universe trace + highlight trace + lasso, lazy plotly import, ~150 lines.
7. **Frontend: rebuild `FeatureExplorer.tsx` as the composition root.** Left rail (pickers + CellFilterPanel), center (UniverseScatter + PartnersTable over filtered frame), right rail (AnalyticsRail with explorer dataContext). Existing placeholder is replaced.
8. **Frontend: cross-nav from cell list rows to `/neuron`.** Wire `crossNavHref` via `useResolveRoots`; greyed-out rows for `missing`/`ambiguous` resolutions; bulk "Open in NG" deferred unless trivial after the resolver hook exists.

## Verification

Local manual walk-through against `minnie65_public` + `/tmp/cdv-embeddings/manifest.yaml`:

1. Navigate to `/explore?ds=minnie65_public&ft=microns_v661_soma&emb=morpho_umap`. Universe scatter renders (~87k points, gray).
2. Attach `cell_type_multifeature_combo` via the decoration picker (`?dec=` updates). The picker should be the *same* picker the `/neuron` view uses; no explorer-specific variant.
3. Bind that table's `cell_type` to the scatter's color (or to a sibling bar plot in the AnalyticsRail). Universe trace re-colors; resolver runs once for the universe and caches.
4. Add a filter clause `proofreading_status_and_strategy.status_axon:eq:true` to `?cells=` via `CellFilterPanel`. Universe scatter dims non-matching points (highlight trace shrinks); cell list table updates to show matching subset with `n shown of N`; sibling histogram panels in the rail update to reflect the filter.
5. Lasso a region of the universe scatter. A new `?sel_universe=` URL key appears; the cell list filters down to the lasso AND the existing `?cells=` filter; sibling histograms in the rail show the lasso'd subset's distribution.
6. Click a row in the cell list. `useResolveRoots` resolves the cell_id → root_id at `?mv`; navigate to `/neuron?root=...&dec=...&cells=...&from=explore:morpho_umap`. The decoration tables and filter expression are preserved verbatim; the partners view lands fully configured.
7. Hard refresh. Every URL param round-trips: `ft`, `emb`, `dec`, `cells`, `plots`, `viz_*`, `sel_*`, `hide`, `show`, `coll`. No `root_id` appears in the URL.
8. Change `?mv` to a stale version. Rows whose cell_ids don't resolve at the new mv grey out in the cell list with a status tooltip; decoration-column values flip to null for those rows.

## Out of scope for v2 (follow-ups)

- **kNN UI.** Endpoint stays; SPA wiring is its own plan.
- **Reverse cross-nav** ("View in explorer" button on `/neuron`'s IdentityStrip) — needs the identity-strip branch to land first.
- **Bulk "Open in Neuroglancer"** on the cell list — needs a generic ids-as-segments `/links` template.
- **Numeric decoration columns in the filter picker UI** — the `?cells=` parser already handles them; the picker's column discovery needs a small extension to surface them.
- **The cell_id-keyed decoration short-circuit** — for tables that are themselves cell_id-keyed in CAVE (e.g. nucleus-row cell-type tables), the resolver step is redundant. v2 still goes through the resolver universally; a per-table flag in the datastack YAML or table metadata is the future optimization path.
- **Part 2** (features-as-decorations on `/neuron`) — sketched in the Part 1 plan; planned separately after v2 lands.

## Critical files to read before starting

| Pattern to mirror | File |
| --- | --- |
| Plot source dispatch + decoration merge | `cave_data_viewer/api/services/plots.py` (`resolve_plot`, ~L1251–1400) |
| `NeuronQuery` shape (informs `RowContext`) | `cave_data_viewer/api/services/neuron.py` |
| Parquet frame loader + caches | `cave_data_viewer/api/services/embeddings/loader.py`, `caches.py` |
| Resolver + decoration join | `cave_data_viewer/api/services/embeddings/{resolver,decoration_join}.py` |
| Hard-coded `root_id` references in the table | `frontend/src/components/PartnersTable.tsx` (lines 35, 341, 471, 548, 567) |
| AnalyticsRail props + panel dispatch | `frontend/src/components/AnalyticsRail.tsx` (top ~60 lines) |
| URL state batching | `frontend/src/hooks/useUrlState.ts` (`useSetUrlParams`) |
| Lazy plotly import pattern | `frontend/src/components/PlotPanel.tsx` |
| `?cells=` filter syntax + UI | `frontend/src/components/CellFilterPanel.tsx`, `cave_data_viewer/api/services/plots.py:_parse_cells_param` |
