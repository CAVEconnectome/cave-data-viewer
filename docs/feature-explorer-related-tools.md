# Feature Explorer — relevant patterns from single-cell omics tools

A survey of UX patterns from genomics single-cell exploration tools (Vitessce,
cellxgene, ScanPy plotting, ABC Atlas) and what translates to a
connectomics-feature explorer over per-cell morphology + classification
metadata. The data model is different (no expression matrix; per-cell features
are bounded in number, not 30k genes) but the user task is structurally
similar: *given a population of cells with multivariate annotations and a
2D embedding, identify, characterize, and act on subsets of interest.*

The connectomics layer adds one twist genomics tools lack — every cell has a
**root_id at a materialization version**, so any selection has a "view in 3D
EM via Neuroglancer / inspect connectivity via /neuron" cross-nav.

What follows is organized by feature family, with notes on what's already in
the explorer, what's a natural next extension, and what would be a stretch.

---

## Tools surveyed

### [Vitessce](http://vitessce.io)

Multi-modal single-cell viewer (HuBMAP, Chan Zuckerberg). Notable patterns:

- **Coordinated multi-view linked panels**: brush in one panel, highlight
  everywhere. Spatial + UMAP + heatmap reading the same `cellSelection`.
- **Cell sets** as first-class: named, hierarchical, addressable. Sets can
  intersect / union / difference visually.
- **JSON config schema** describing a layout — multiple linked scatter
  plots, a heatmap, a cell-set browser. Reproducible "view configurations"
  much like the recipes concept.
- **Spatial layer over image**: not directly relevant for us (we delegate to
  Neuroglancer), but the *concept* — that the embedding scatter is one of
  several coordinate spaces a cell lives in — is.
- **Per-cell-type counts** in a sidebar with a hierarchical tree.

### [cellxgene](https://cellxgene.cziscience.com)

Probably the closest analog. Workflow-focused, opinionated single-page app.
Notable patterns:

- **Single dominant UMAP** with a left rail of metadata controls. Same shape
  as our explorer's cinematic A layout.
- **Categorical metadata sidebar**: for each categorical column, a
  collapsible panel showing per-category counts in (universe, current
  selection). Click a category to filter.
- **Continuous metadata histograms**: per-feature with a brush handle so the
  user can *both view the distribution and filter by it* in the same widget.
- **Named subsets**: save the current selection by name; recall later.
  Supports comparison ("Compute Differential Expression Between Two Cell
  Sets").
- **Annotation panel**: user creates a new categorical column, assigns
  cells to labels. Labels persist server-side for the dataset.
- **Reembedding**: subset the data, recompute UMAP on just that subset.
  Not v1 for us, but conceptually clean.
- **Gene search bar** with autocomplete — replaced in our domain by a
  "feature search" over the manifest's feature_columns.

### [ScanPy](https://scanpy.readthedocs.io) (Python plotting + analysis)

Static, but the *analytical patterns* are influential:

- `sc.pl.umap(adata, color="leiden")` — color by any column trivially.
- `sc.tl.rank_genes_groups` — differential expression. The connectomics
  analog: *differential features* — given two selections, which morphology
  features best discriminate them?
- Trajectory / pseudotime — not applicable.
- Marker gene tables — equivalent to "top differential features" output.

### ABC Atlas / Allen Brain viewers

Brain-specific. Notable:

- **Linked spatial + UMAP + heatmap** like Vitessce.
- **Cell-type hierarchy** as a navigable tree (class → subclass → cluster).
- **Cluster boundary overlay** on the embedding.
- **Marker-gene panels** per cluster.

### [Cosmograph](https://cosmograph.app)

WebGL graph viewer. Visual perf reference more than UX. Relevant pieces:
- Density-based level-of-detail
- Lasso / box selection at million-point scale (deck.gl envelope)

### [scvi-tools / latentdb](https://docs.scvi-tools.org)

Library-side. Mention only for the **shared latent space** workflow —
embed many datasets into one latent space, browse by dataset of origin.
Not v1 for us; relevant if we want a "feature-explore across multiple
mat_versions" or "across two datastacks" view.

---

## Feature families and how they map

### 1. Per-feature linked histograms in the summary bar

**State**: histogram view exists for currently-bound color/size channels;
user just requested manual toggling of arbitrary features.

**Translation**: cellxgene's continuous-metadata sidebar is exactly this.
Each numeric column gets its own small histogram with universe vs selection
density overlaid. Add via picker; remove via ×. URL state tracks the
selected feature list.

**Stretch**: a brush handle *on the histogram itself* that pushes a
`?cells=column:between:lo,hi` filter clause. Combines distribution view +
filter authoring into one widget. Cellxgene does this.

### 2. Categorical metadata breakdown in the summary bar

**State**: stacked-bar view exists for *the bound color channel* when
categorical.

**Translation**: same widget, but mountable for *any* categorical column,
not just the bound color. cellxgene's left rail has one of these per
categorical metadata column, collapsible. Each row clickable as a
filter add.

**Stretch**: hierarchical categoricals — `predicted_class` →
`predicted_subclass` rendered as a tree, with rollup counts at the
class level.

### 3. Named cell sets (recipes)

**State**: not implemented. User flagged as a near-term direction.

**Translation**: the project already has a `Recipe` / `Example` system for
the connectivity view (`api/services/recipes.py`, `frontend/src/tours/`).
That covers "save a `?ds`/`?root`/`?cells`/`?dec`/plot-layout combo by
name." For the explorer the same shape applies: save `?ft`/`?emb`/`?cells`/
`?dec`/channel-bindings + (optionally) a snapshot of the current selection
by name.

The hardest piece is selection persistence: the URL-state approach broke
on big selections (HTTP 431). The clean solution is:

1. POST the selection cell_id list to a server-side store.
2. Server returns a short token (UUID or similar).
3. URL stores just the token.
4. Recipe references the token.

This is the same selection-token pattern Vitessce uses for its
`cellSetSelections` JSON config — the actual id lists are kept out of
URL state, referenced by name/id.

**Stretch**: shareable recipe URLs that reproduce a saved selection across
users. Already the pattern for the existing connectivity recipes.

### 4. Subset → reanalysis / "compute on the selection"

**State**: not implemented.

**Translation**: once you have a selection, what can you do with it
besides "open in NGL" and "cross-nav to /neuron"? cellxgene's killer
feature is **differential expression between two cell sets**. The
connectomics analog: **differential features** — given selection A and
selection B (or "the rest"), rank the morphology features by their
discriminating power. Conceptually a Welch's t-test per feature, ranked
by effect size; show top-N in a table.

Cheap to implement: client-side compute over the cellList rows (which
already have all parquet feature values). No new endpoint needed for v1.

**Stretch**: cell-type enrichment — given a selection, which
`predicted_subclass` categories are over-represented? Fisher's exact /
hypergeometric per category. Same backend pattern.

### 5. Two-selection comparison

**State**: not implemented.

**Translation**: cellxgene allows "selection A" and "selection B" with a
single-button differential expression. For our explorer:
- Two named cell sets (Set 1, Set 2)
- Visual: color the scatter by membership (A only, B only, both, neither)
- Summary: feature histograms with three traces — A, B, universe
- Action: "Open A in NGL", "Open B in NGL"

Could share the recipe machinery — Set 1 and Set 2 are each a named
selection.

### 6. Density overlay on the scatter

**State**: planned (task 29, deferred). deck.gl has `HeatmapLayer` and
`HexagonLayer` for this.

**Translation**: standard in genomics tools (scanpy's `density` plot,
cellxgene's contour overlay). The "where are the cells dense" answer is
useful regardless of domain. Toggle in the channel rail; multiple
density modes (KDE, hexbin, contour).

**Stretch**: density of the *selection*, not the universe — "where are
my selected cells distributed in the embedding?" Highlights a cluster
when the selection is concentrated, a smear when it's not. Useful for
characterizing what kind of cells the user has picked.

### 7. Spatial coordinate axes

**State**: any pair of feature columns can be bound to x/y via the
channel pickers — including `soma_depth_x/y/z` which IS the anatomical
position.

**Translation**: cellxgene + Vitessce have a dedicated "spatial view"
mode. For us, that's just "bind soma_depth_x to x and soma_depth_z to y"
— the existing channel-binding machinery covers it.

**Adjacent niceties**:
- A preset "spatial view" toggle in the rail that sets the axes in one
  click + applies depth-axis flipping (we already have
  `depth_columns` declared in the manifest)
- Multiple bound spatial views side-by-side as linked panels (multi-
  scatter)
- Layer-boundary lines overlaid on the scatter when y is a depth column
  — the `spatial_meta` on the connectivity bundle already carries
  `layer_boundaries` for cortex; same data could feed the explorer

### 8. Linked small multiples (multiple scatters)

**State**: single primary scatter.

**Translation**: Vitessce's "spatial + UMAP" side-by-side is essentially
two scatters with linked selection. For us: a "+ add view" affordance
that mounts a second `UniverseScatter` with its own channel bindings
but reading the same selection set.

Useful for:
- UMAP next to "soma_depth_y vs nucleus_volume" — see how the
  embedding cluster maps to anatomical depth
- Comparing two embeddings (UMAP vs t-SNE) of the same feature table
- Anatomical + abstract simultaneously

**Stretch**: full Vitessce-style declarative layout where multiple
panels can be arranged. Probably overkill for v1; one "add a sibling
scatter" affordance covers 80% of the value.

### 9. Search / find

**State**: not implemented.

**Translation**: cellxgene has a gene search bar; we'd want **cell ID
search** (paste a cell_id or root_id, the scatter pans/zooms to it and
highlights it).

The "fit-to-highlight" piece is already wired. Combined with a one-cell
selection, search is just:
- Input box accepting cell_id or root_id
- Reverse-resolve root_id → cell_id if needed (existing endpoint)
- Set as the selection
- Fit view to highlight

Tiny feature, big usability win. Especially useful when a user has a
cell_id from another tool and wants to find it on the embedding.

### 10. Set algebra on selections

**State**: a selection is one cell_id list.

**Translation**: in Vitessce, two named cell sets can be combined via
union/intersection/difference. For us, once we have named cell sets,
this is straightforward; before that, it's a "you only get one
selection" limitation.

For pre-recipes v1, a lighter version: when a user has a row-selection
+ does a lasso, the lasso could *add* to the selection rather than
replacing it. (Currently it replaces.) Modifier key: shift+lasso to
add, alt+lasso to subtract. Standard pattern in image-editing /
data-viz tools.

### 11. Annotation UI

**State**: not implemented; probably not v2.

**Translation**: cellxgene lets users create a new categorical column,
assign cells to labels, save back to the dataset. The connectomics
analog: "I found a sub-cluster of cells with weird soma volume; let me
label them as `my_weird_subclass` and add them to a future analysis."

For us, this would be:
- A new "user labels" column the user can create
- Per-cell label assignment (paint a region, all those cells get the
  label)
- Persistence: localStorage / sessionStorage for v1, server-side later

The thing this enables long-term: collaborative annotation of feature
clusters that aren't yet in the manifest's `categorical_columns`.

### 12. "Top features" / marker discovery

**State**: not implemented.

**Translation**: scanpy's `rank_genes_groups`. Given a selection, output:
- "Which features have means most-different from the rest?"
- Show as a ranked list
- Each row clickable to bind that feature to color or open as a
  histogram in the summary

Cheap to implement: t-statistic or rank-biserial per feature, computed
in JS over the cellList rows. No backend work needed.

### 13. Cluster boundary overlay

**State**: not implemented.

**Translation**: Vitessce / cellxgene draw a contour around each cell
type's cluster on the UMAP. For us, the `predicted_subclass` (or any
categorical) could drive convex hulls or alpha-shape contours per
category. Useful when the user is color-coding by class — the boundary
makes class membership crisp where overlapping points are hard to read.

**Stretch**: density contours per category (like a 2D KDE per class).
More expensive but visually informative.

### 14. Cross-comparison across mat_versions / datastacks

**State**: not implemented. The Feature Explorer keys cell_ids to a
single `cell_id_source_table` per datastack.

**Translation**: in scvi-tools, this is "shared latent space across
datasets." Probably out of scope for connectomics in the short term,
but the architectural foundation is solid: cell_ids are namespace-
scoped, the resolver handles per-(ds, mat_version) translation, and
the manifest discovery model could support multiple datastacks pointing
at related embeddings.

---

## Suggested prioritization

Approximate "build effort × impact" sort. Effort is rough; impact assumes
the feature explorer is going to be a regular part of someone's workflow.

**Tier 1 — low effort, high impact:**

- (4) **Differential features panel** — "What features distinguish my
  selection?" Cheap (client-side t-stat per feature). High impact for
  the "I selected a cluster, what's it about?" workflow.
- (9) **Cell ID search** — input box; reverse-resolve if root_id;
  set as selection; fit-to-highlight. ~50 lines.
- (10) **Modifier-key lasso (add/subtract from selection)** — same
  lasso wiring, branch on `event.shiftKey` / `event.altKey`. Standard
  pattern; almost no new code.

**Tier 2 — medium effort, high impact:**

- (1) **Manual histogram add for any numeric column** (the in-progress
  follow-up).
- (2) **Categorical breakdown panels** — same UI primitive as the
  existing color-bound stacked bars; just allow mounting one per
  categorical column.
- (3) **Recipes** — extend the existing `Recipe` machinery for the
  explorer config. Selection-token pattern for big selection lists.
- (6) **Density toggle** (the deferred task 29) — `HeatmapLayer` /
  `HexagonLayer` underlay.

**Tier 3 — higher effort or larger-scope:**

- (5) **Two-selection comparison** — needs the recipes/cell-set
  machinery first.
- (8) **Linked small multiples (multi-scatter)** — non-trivial UI
  shell change but enables the "anatomical + abstract simultaneously"
  workflow.
- (7) **Spatial-view preset + layer overlays** — easier than it sounds
  because the manifest already declares depth columns and the
  spatial_meta carries layer boundaries; mostly a presentation
  refinement.
- (13) **Cluster boundary overlay** — convex hulls per category.
  Cheap geometrically; the UX question is "when does this read as
  useful vs visually noisy."

**Tier 4 — defer or skip:**

- (11) **Annotation UI** — significant scope; depends on a persistence
  story. Probably worth doing once the rest of the surface stabilizes.
- (14) **Cross-mat-version / cross-datastack** — architecturally
  possible but premature.

---

## Pattern transplants vs invented features

Most of what's above is *transplanting* a single-cell-omics pattern
into a connectomics context. The few things that don't come from
single-cell tools and would be genuinely native to our domain:

- **Per-row "→ /neuron" + "↗ NGL" cross-nav** (already shipped). The
  connectomics layer where every cell is also a graph node + a 3D
  segmentation; genomics tools don't have an analog because the per-
  cell data ends at the metadata.
- **Resolution-status surfacing**: cells that don't resolve at the
  current mat_version. Single-cell tools never have this because
  metadata is timeless.
- **Synapse-bridged comparisons**: "find cells whose features cluster
  here AND who are post-synaptic to cell X." Bridges the
  feature explorer with the partner view. Not a v2 feature, but worth
  noting as a long-term differentiator.
- **Anatomical layer/region awareness**: cortex has a meaningful
  vertical axis; the explorer's depth_axis declaration in the manifest
  already lets us flip + overlay layers. Genomics has no such
  privileged anatomical axis.

---

## What this means for the immediate next step

The user just asked for "manually toggled plots in the summary bar." That's
**Tier 2 item (1)** above, and it's also the smallest cellxgene-style
pattern transplant. Implementing it well unlocks several adjacent features
without much extra work:

- Same picker UI seeds the "differential features" panel (Tier 1, #4) — a
  ranked-by-discriminating-power list is just an automated version of
  "which features to add a histogram for."
- The per-column endpoint (`/feature_tables/<ft>/column/<col>`) needed for
  "full universe vs selection" histograms also feeds the differential-
  features computation (it can compute on universe values directly).
- Multiple histograms in a column rail is one step removed from "linked
  small multiples" (Tier 3, #8) — both want a layout shell that mounts N
  visualizations sharing a selection.

So the in-progress "manually toggle plots" work is a load-bearing
foundation, not a one-off polish item.
