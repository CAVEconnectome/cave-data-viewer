# Generalizing cave-data-viewer for multi-dataset embeddings

## Context

Today every endpoint, URL key, cache key, and TypeScript type in cave-data-viewer
assumes one `ds` (datastack) per request and per workspace view. The Feature
Explorer's identity rule (cell_id keyed, root_id derived) was put in place
specifically because cell_id is the more stable identifier — and that decision
already anticipated cross-dataset comparison (`docs/feature-explorer-related-tools.md`
§14 calls out "shared latent space across datasets" as the deferred Tier-4 case).
The team is now ready to start engineering for it.

The headline goal is **joint embeddings** — a single UMAP/PCA whose coordinates
are commensurable across datastacks, browsable in `/explore` with cells colored
or shaped by source dataset, with cross-nav routing each cell back into its
*home* datastack's `/neuron` view. `/neuron`, `/tables`, and Neuroglancer links
stay single-dataset-per-view. Decoration tables differ between datasets
("parallel but distinct"), so the manifest needs a column-alias mechanism.

The principle that unlocks everything else: **a cell's identity becomes
`(ds, cell_id)`, not `cell_id` alone**, and that pair is propagated end-to-end
— parquet column, JSON response field, TypeScript row type, URL state, cross-nav
target. Once that primitive lands, joint embeddings, side-by-side comparison,
shard-by-ds resolver batching, and per-ds decoration aliasing all become
mechanical extensions rather than parallel pipelines.

## What's already multi-dataset-friendly

These pieces are already parameterized by `datastack`; the work is plumbing, not redesign:

- **CAVE client factory** (`cave_data_viewer/api/cave.py:34–115`) — every entry point
  takes `datastack_name` explicitly. Multiple clients can coexist in one process.
- **Resolver caches** (`cave_data_viewer/api/services/cell_id.py:169,257,321,435`) —
  keyed by `(datastack, ...)`. Cross-datastack lookups are a batch-and-shard
  wrapper over the existing per-ds calls.
- **Manifest discovery** (`services/embeddings/manifest.py`) — decoupled from the
  datastack YAML; a manifest URI can be referenced from multiple datastack configs.
- **Per-ds CAVE client pooling** — no global singleton, so multi-ds requests can
  fan out without locking.

## What's deeply single-dataset (the work)

- **Wire-level identity**: `cell_id`, `root_id`, `cell_ids` lists carry no `ds` tag.
  `PartnerRecord` (`frontend/src/api/types.ts:104`),
  `EmbeddingScatterResponse` (`types.ts:475`),
  `ResolveRootsResponse` (`types.ts:446`), and the parquet schema
  (`scripts/make_sample_embedding.py`) all assume bare ids.
- **URL state**: `?ds` is singular; `useSwitchDatastack()`
  (`hooks/useUrlState.ts:94–112`) atomically nukes every other URL key
  because everything else references the previous datastack's tables.
- **Cross-nav**: `useCrossNavHref` (`hooks/useCrossNavHref.ts:5–122`) and
  `useNglLink` (`hooks/useNglLink.ts:15–46`) take a single `ds`. The destination
  `/neuron?root=…&ds=…` always uses the *workspace*'s ds, never the row's.
- **Manifest schema**: `cell_id_source_table` lives in the datastack YAML
  (`config/datastacks/minnie65_public.yaml:55–66`), not in the manifest — so the
  manifest itself is implicitly single-ds. The schema comment at
  `manifest.py:174` already flags this as a v3 lift target.
- **Decoration**: `?dec=table_name` is resolved against the current datastack's
  `get_tables()` (`DecorationPicker.tsx:34`). If two datastacks use different
  table names for the same concept, there is no aliasing path today.
- **Endpoint signatures**: `POST /datastacks/<ds>/feature_tables/.../resolve_roots`
  scopes batch resolves to one ds in the URL path — can't accept a heterogeneous
  cell-id list as-is.

## Strategy: per-row `(ds, cell_id)` identity, manifest-level multi-ds declaration

The change is principled, not piecemeal. Three primitives carry the design:

1. **`source_ds` is a wire-level field on every embedding row.** Parquet adds a
   `source_ds: string` column; every JSON response that today returns a list of
   `cell_ids` adds a parallel `source_ds` array (or a `ds` field per row). For
   single-ds embeddings, every value equals the request's `ds`. Frontend reads
   `row.ds ?? workspaceDs` whenever it needs to route a cell.

2. **Manifest schema v3 declares the participating datastacks.** A `datastacks:`
   block (list, possibly with per-ds `cell_id_source_table` override) lifts the
   source-table coupling out of the datastack YAML. A single-ds manifest is just
   a one-element list. A joint manifest has N elements; the parquet's
   `source_ds` column is constrained to be one of them.

3. **The resolver becomes shard-by-ds.** `POST /resolve_roots` accepts a body of
   `[{ds, cell_id}, ...]`. Internally it groups by ds and calls the existing
   per-ds `cell_id.py` resolver in parallel (it's already keyed per-ds, just
   never called in parallel for different ds today). Response carries `ds` on
   each resolution.

With those three primitives, the existing single-ds endpoints, caches, and
Neuroglancer-link templates do **not** need to change shape — they keep operating
on one ds at a time. The orchestration layer that fans out to per-ds calls
lives in the new resolver wrapper and a multi-ds-aware variant of the
`embedding_cells` plot data source.

### Wire-format choice

Use **`(cell_id, ds)` as separate fields**, not a delimited string like
`"ds:cell_id"`. Reasons:

- Preserves the existing `cell_id: string` shape — no parse logic at every read
  site (TanStack-Table key extractors, URL serializers, kNN endpoint).
- Lets the frontend treat `ds` as a sortable / filterable column.
- Single-ds responses look identical to today; multi-ds adds a new field that
  single-ds consumers can ignore.

URL state for multi-ds *scope* (which datastacks are active in `/explore`) does
need a comma-separated form: introduce `?dss=ds1,ds2`, with `?ds=ds1` continuing
to work as a one-element shorthand (the existing `useSwitchDatastack()` becomes
a special case of `useSetDatastacks([ds])`). `/neuron`, `/tables` continue to
read `?ds` only.

## Phased plan

### Phase 1 — Plumb the identity primitive (no user-visible change)

The "do no harm" pass. Single-ds workflows behave identically; every code path
is now generic.

**Backend:**
- `cave_data_viewer/api/services/embeddings/manifest.py` — schema v3 with
  `datastacks: [ds, ...]` (default: `[<parent datastack>]`). v2 manifests load
  unchanged via a defaulting layer.
- `cave_data_viewer/api/services/embeddings/loader.py` — read optional
  `source_ds` parquet column; fill with the embedding's sole declared ds when
  absent.
- `cave_data_viewer/api/services/embeddings/__init__.py` /
  `cave_data_viewer/api/endpoints/embeddings.py` — every `/scatter`, `/cells`,
  `/knn` response carries `source_ds` (parallel array or per-row field).
- `cave_data_viewer/api/services/embeddings/resolver.py` — internal API gains a
  `(ds, cell_id)`-tuple form. The existing per-ds form stays for the old
  endpoint path.
- `cave_data_viewer/api/services/datastack_config.py` — `cell_id_source_table`
  becomes optional in the YAML; manifest takes precedence when both are set.

**Frontend:**
- `frontend/src/api/types.ts` — `PartnerRecord`,
  `EmbeddingScatterResponse`, `FeatureTableCellsResponse`,
  `CellRootResolution` gain optional `ds?: string` (or `source_ds`).
- `frontend/src/api/embeddings.ts` — response decoders read the new field if
  present; single-ds callers ignore it.
- `frontend/src/hooks/useCrossNavHref.ts` — accept a per-row `ds`; fall back to
  the workspace `ds` when absent. Cross-nav still produces a single-ds
  `/neuron?ds=…&root=…` URL — the only change is *which* ds wins.

**Verification:** existing single-ds flows produce identical URLs and identical
JSON (up to the new optional field). Any v2 manifest still loads.

### Phase 2 — Joint embedding `/explore` (the headline feature)

**Backend:**
- `embeddings.py` accepts manifests with `len(datastacks) > 1`. The parquet's
  `source_ds` column is enforced to be a subset of declared datastacks.
- New endpoint shape `POST /resolve_roots` accepts `[{ds, cell_id}, ...]` and
  returns resolutions with per-row `ds`. The old path-scoped endpoint is
  preserved for the single-ds explorer code path; the new explorer code uses
  the body-scoped form unconditionally.
- kNN index: built over the full parquet; query returns rows with `source_ds`.
  Index cache key (`knn.py:210`) already includes `ft.id`, which is manifest-
  scoped, so no collision.

**Frontend:**
- `frontend/src/hooks/useUrlState.ts` — introduce `?dss` (comma-separated set
  of active datastacks). For multi-ds manifests `?dss` selects the visible
  scope; for single-ds, `?ds` continues to work and is internally read as a
  one-element `?dss`.
- `frontend/src/components/Sidebar.tsx` — multi-select datastack picker visible
  only when the active manifest declares multiple datastacks; otherwise
  unchanged.
- `frontend/src/components/explore/FeatureExplorer.tsx` — when the embedding
  spans multiple ds, fetch resolutions in one batched `/resolve_roots` call,
  driving the `rootByCellId` map (`FeatureExplorer.tsx:395–401`) off
  `(ds, cell_id)` keys rather than bare `cell_id`.
- `frontend/src/components/explore/UniverseScatter.tsx` — built-in
  "color by source dataset" mode; categorical palette derived from the active
  `?dss` scope.
- `frontend/src/components/explore/SavedSetsPanel.tsx` — saved sets store
  `[{ds, cellId}, ...]` (or are scoped per-ds when single).
- Cross-nav from a row picks `row.source_ds`, lands in single-ds `/neuron`
  for that ds. View snapshots (`hooks/useViewSnapshot.ts:115`) already key by
  ds, so jumping between ds in cross-nav restores the right snapshot.

**Verification:** publish a sample multi-ds manifest in the dev config (e.g.
two minnie65 mat-versions standing in as separate datastacks); confirm scatter
renders the union, kNN returns mixed neighbors, and cross-nav from a row goes
to that row's ds.

### Phase 3 — Decoration column aliases ("parallel but distinct")

Manifest gains:

```yaml
decoration_columns:
  cell_type:
    minnie65_public:
      table: aibs_metamodel_celltypes_v661
      column: cell_type
    sister_dataset:
      table: m1_celltype_v3
      column: predicted_class
```

**Backend:**
- `cave_data_viewer/api/services/plots.py` — when the `embedding_cells` data
  source is asked for column `cell_type` on a multi-ds embedding, it shards
  rows by `source_ds`, dispatches per-ds decoration queries via the existing
  `services/decoration.py` machinery, and stitches results back into a single
  unified column. Existing single-ds decoration is the special case where the
  manifest's `decoration_columns` is empty and the request resolves directly
  against the active ds's table.

**Frontend:**
- `frontend/src/components/explore/ColumnPicker.tsx` — for multi-ds embeddings,
  list manifest-declared virtual columns; for single-ds embeddings, list raw
  CAVE tables as today.

**Verification:** scatter colored by a virtual `cell_type` column on a multi-ds
embedding renders the per-ds palette consistently and the legend reflects the
union of categories.

### Phase 4 — Side-by-side comparison (falls out)

Already covered by phase 2: a manifest declaring two datastacks with
non-overlapping `source_ds` regions in the parquet is the natural data model
for "two embeddings side by side." The AnalyticsRail's existing per-panel
mechanism can render two scatter panels with linked `?cells=` filters; no new
machinery required.

## Critical files to modify (anchors)

**Backend:**
- `cave_data_viewer/api/services/embeddings/manifest.py` — manifest v3 schema.
- `cave_data_viewer/api/services/embeddings/loader.py` — read `source_ds`
  parquet column.
- `cave_data_viewer/api/services/embeddings/resolver.py` — accept `(ds, cell_id)`
  tuples; reuse `services/cell_id.py` per-ds calls.
- `cave_data_viewer/api/endpoints/embeddings.py` — `/scatter`, `/cells`, `/knn`,
  `/resolve_roots` carry per-row `source_ds`.
- `cave_data_viewer/api/services/plots.py` — `embedding_cells` data source
  with per-row ds dispatch and manifest-driven decoration aliases.
- `cave_data_viewer/api/services/datastack_config.py` — `cell_id_source_table`
  becomes optional (manifest takes precedence).

**Frontend:**
- `frontend/src/api/types.ts` — `source_ds?: string` on rows; parallel array
  on scatter response.
- `frontend/src/api/embeddings.ts` — new `/resolve_roots` body shape; per-row
  ds in response decoders.
- `frontend/src/hooks/useUrlState.ts` — `?dss` alongside `?ds`.
- `frontend/src/hooks/useCrossNavHref.ts` — per-row ds wins over URL ds.
- `frontend/src/components/Sidebar.tsx` — multi-select when manifest supports.
- `frontend/src/components/explore/FeatureExplorer.tsx` — multi-ds awareness
  in selection / resolver / saved-sets paths.
- `frontend/src/components/explore/UniverseScatter.tsx` — color-by-source-ds.
- `frontend/src/components/explore/ColumnPicker.tsx` — virtual decoration
  columns from manifest.

**Reuse:**
- `cave_data_viewer/api/services/cell_id.py` — unchanged; called N times by the
  shard-by-ds wrapper.
- `cave_data_viewer/api/cave.py` — unchanged; already takes `datastack_name`.
- `cave_data_viewer/api/services/decoration.py` — unchanged; called per-ds
  shard.
- `frontend/src/components/PartnersTable.tsx`,
  `frontend/src/components/CellFilterPanel.tsx`,
  `frontend/src/components/AnalyticsRail.tsx` — unchanged shape; just see an
  optional `ds` column on rows.

## Non-goals (explicit)

- `/neuron` stays single-ds. Cross-nav from a multi-ds embedding row jumps into
  the cell's home ds; you cannot view connectivity from two datastacks in one
  `/neuron` view in v1.
- "Connectivity in joint embedding space" requires choosing one ds to anchor the
  partner set. Deferred.
- Multi-ds Neuroglancer state (segmentation layers from two datasets in one
  viewer) is deferred to a later phase.
- Cell-ID collisions between datastacks are structurally impossible once
  `source_ds` is part of identity; no separate dedup needed.

## Verification (end-to-end)

After phase 1: every existing single-ds test path passes unchanged; v2
manifests load without modification.

After phase 2: a hand-rolled multi-ds manifest (initial candidate: two
materialization versions of `minnie65_public`, since they share a CAVE table
schema — useful even before a second physical datastack is available) drives a
working scatter, kNN, and cross-nav. The cross-nav check is the load-bearing
one: clicking a cell whose `source_ds` differs from the current `?dss` URL
should land in `/neuron?ds=<row.source_ds>` with the right snapshot restored.

After phase 3: a virtual `cell_type` decoration column on a multi-ds manifest
renders the union of categories with the per-ds source tables resolved
correctly.

No automated test suite exists today, so verification is the
`CDV_DEV_AUTH_BYPASS=1` SPA walk-through described in
`docs/feature-explorer-v2-status.md`, extended with a multi-ds dev manifest.
