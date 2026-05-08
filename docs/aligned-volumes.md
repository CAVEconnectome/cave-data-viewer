# Configuring Aligned Volumes

An *aligned volume* is the coordinate-space + segmentation-pipeline
identity that a datastack is mounted on. Several datastacks can share
one aligned volume — for example `minnie65_public` (release) and
`minnie65_phase3_v1` (working) both live on `minnie65_phase3`. Anything
that is a property of the *volume* rather than the *datastack* belongs
in this YAML so every datastack mounted on the same volume sees
identical depth axes, layer boundaries, and synapse-table conventions.

Two things are configured here:

- **Spatial frame** — the transform that orients raw CAVE coordinates
  into a depth-up frame, plus the depth range and cortical-layer
  boundaries used to decorate plots.
- **Synapse table conventions** — the column projection,
  position-column prefix, and per-partner aggregation rules that the
  segmentation pipeline drives. Lives here (not on each datastack)
  because every mat version of the same proofreading effort returns
  the same synapse columns.

Per-datastack YAMLs can still override anything in this file
field-by-field; see *Layered loading* below.

## Where the YAML lives

The loader checks three locations (last wins on conflict):

1. **Repo root** — `config/aligned_volumes/<aligned_volume>.yaml`.
   Bundled defaults that ship with the source tree and (via hatchling
   `force-include`) inside the wheel.
2. **In-wheel copy** — `cave_data_viewer/_bundled_config/aligned_volumes/<aligned_volume>.yaml`.
   Same content as the repo-root location; resolved this way for
   pure-wheel installs where the source tree isn't on disk.
3. **Operator override** — `$CDV_ALIGNED_VOLUME_CONFIG_DIR/<aligned_volume>.yaml`,
   if the env var is set. Wins over both bundled locations, so a
   deployment can ship its own spatial calibration without forking
   the package.

The `<aligned_volume>` filename matches the `aligned_volume` field
returned by `client.info.get_aligned_volume()` for the datastack — not
the datastack name. Cache is keyed on the mtimes of all candidate
paths, so editing any of them in dev invalidates on the next request
without a server restart.

Aligned volumes with no YAML in any location fall back to schema
defaults — i.e. no transform, no depth axis, no layer guides. That's
the right behavior for any volume the deployment hasn't characterized
yet (typical for non-cortex datasets); callers don't have to
special-case "is there a YAML for this volume."

## Field reference

The schema is defined in `services/datastack_config.py`
(`AlignedVolumeConfig` → `SpatialConfig` + `SynapseConfig`). Top-level
keys:

| Key | Type | Notes |
| --- | --- | --- |
| `spatial` | `SpatialConfig?` | Coordinate-frame configuration. Omit entirely or leave `transform` null on volumes that don't have a depth axis (e.g. fly nerve cord). |
| `synapse` | `SynapseConfig?` | Synapse-table conventions. Defaults to `{position_prefix: ctr_pt, columns: <minimal-set>, aggregation_rules: {}}`. |

### `spatial` fields

| Field | Type | Notes |
| --- | --- | --- |
| `transform` | `string?` | Name of a constructor in `standard_transform.datasets`. Currently supported: `minnie_vx`, `minnie_nm`, `v1dd_vx`, `v1dd_nm`, `identity`. The `_nm` variants take nm coordinates (what the connectivity service serves at `desired_resolution=[1,1,1]`); use those. |
| `depth_range` | `[float, float]?` | Depth-axis bounds in µm. Fixes the axis range on plots whose `x` or `y` is bound to a depth-shaped column, so different neurons share a coordinate system rather than each chart auto-fitting to its own data. |
| `layer_boundaries` | `[float]?` | Cortical-layer boundary depths in µm, ordered top (pia) to bottom (white matter). Drawn as dotted background lines on every depth-axis plot. |
| `layer_names` | `[string]?` | Parallel to `layer_boundaries`. `layer_names[i]` labels the region whose *bottom* is `layer_boundaries[i]` — so the first name labels the region between `depth_range[0]` and the first boundary. If the list is shorter than `layer_boundaries`, trailing regions render unlabeled (e.g. white matter below L6). |

When `transform` is null, the depth-axis fields are silently ignored —
the plot backend short-circuits all depth decoration when the frame
can't be calibrated. So leaving `depth_range` and `layer_boundaries`
set on a volume with no transform is a no-op, not an error.

### `synapse` fields

| Field | Type | Notes |
| --- | --- | --- |
| `position_prefix` | `string` | Column-name stem for the synapse-position triple (`<prefix>_position_x/y/z`). Default `ctr_pt`. Set to `anchor` / `post_anchor` / etc. for pipelines that emit different points. |
| `columns` | `[string]?` | Column projection for synapse queries. Default ships a minimal set (`id`, `pre_pt_root_id`, `post_pt_root_id`, `<prefix>_position`). Set to `~` (YAML null) to pull every column — fine for ad-hoc exploration, bad for production because it bloats the in-memory synapse cache. Any column referenced by an `aggregation_rules` entry is auto-appended to the projection, so you don't have to mirror it here. |
| `aggregation_rules` | `{string: AggregationRule}` | Per-partner summary stats. Each entry becomes a column on the partner table by grouping synapses on partner root_id and applying `agg` to `column`. |

Each `AggregationRule` is `{column: string, agg: string}` where `agg`
is anything pandas `.agg()` accepts (`mean`, `sum`, `max`, `count`,
`median`, ...).

## Examples

### Cortex with depth axis (Minnie phase3)

The shipped `config/aligned_volumes/minnie65_phase3.yaml`:

```yaml
spatial:
  transform: minnie_nm
  depth_range: [0, 775]
  layer_boundaries: [91.81, 261.22, 391.86, 537.05, 753.58]
  layer_names: [L1, L2/3, L4, L5, L6]

synapse:
  position_prefix: ctr_pt
  columns:
    - id
    - pre_pt_root_id
    - post_pt_root_id
    - size
    - ctr_pt_position
  aggregation_rules:
    mean_size:
      column: size
      agg: mean
    net_size:
      column: size
      agg: sum
```

Five layer boundaries → six labeled regions, but `layer_names` only
lists L1–L6, so anything below the last boundary renders as an
unlabeled depth band (white matter).

### Non-cortex / no depth axis

A volume with no oriented frame — fly nerve cord, sub-cortical regions,
anything where pia-to-white-matter doesn't apply. Skip the `spatial`
block entirely (or set `transform: ~` and leave the rest):

```yaml
# No spatial block — the connectivity bundle omits depth columns and
# the SPA renders without depth-axis decorations. The plot backend
# short-circuits depth guides because the frame isn't calibrated.

synapse:
  position_prefix: ctr_pt
  columns:
    - id
    - pre_pt_root_id
    - post_pt_root_id
    - ctr_pt_position
  # No aggregation_rules — this volume's synapse table doesn't ship
  # a `size` column, so we'd be aggregating over null otherwise.
```

### Minimal — relying entirely on defaults

For a volume whose only deviation from defaults is the synapse-position
prefix:

```yaml
synapse:
  position_prefix: anchor_pt
```

Everything else (`spatial`, `columns`, `aggregation_rules`) inherits
the schema defaults.

## Layered loading and per-datastack overrides

Datastack YAMLs (`config/datastacks/<datastack>.yaml`) can override
anything in the aligned-volume YAML field-by-field. The merge is
*field-level*, not block-level — a datastack that wants to change only
the position prefix doesn't have to re-state the column list:

```yaml
# config/datastacks/minnie65_special.yaml — overrides only the
# synapse aggregation rules, inherits position_prefix and columns
# from the aligned-volume YAML.
synapse:
  aggregation_rules:
    median_size:
      column: size
      agg: median
```

Use this when a single datastack mounted on a shared volume needs a
local tweak without disturbing the other datastacks on the same
volume.

## Validation and operational notes

- **The `<aligned_volume>` filename comes from CAVE, not from the
  datastack.** A `client.info.get_aligned_volume()` round-trip happens
  on the first request for any datastack to resolve the volume name;
  the result is process-cached. If you rename the YAML, restart the
  process or wait for the cache TTL.
- **No YAML at all is a valid configuration.** A volume with no
  matching file falls back to schema defaults: no transform, no
  depth-axis decoration, the minimal default synapse projection, and
  no aggregation rules. New deployments can start with empty
  `config/aligned_volumes/` and add a YAML once they need spatial
  calibration or a non-default synapse projection.
- **Pydantic validates the schema; CAVE state is NOT checked.** A typo
  in `transform` raises `ValueError` at YAML-load (the constructor
  lookup fails with a clear message); a typo in a synapse column
  surfaces later as an empty DataFrame or a CAVE 422 when the
  connectivity endpoint runs the query. Test against a real datastack
  before shipping.
- **Layer-boundary order matters.** The plot backend assumes
  monotonically increasing depths (pia=0 at the top). Reversing the
  list silently swaps the layer labels on the chart.
- **`columns: ~` is rarely the right choice.** Setting `columns` to
  null pulls every column the synapse table has on every query, and
  the result is cached in-memory per-pod. For tables with many
  optional columns (proofreading status, multiple position points)
  this can multiply the cache footprint several-fold. Prefer an
  explicit list.
