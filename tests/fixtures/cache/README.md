# Cache pickle compatibility fixtures

This directory holds committed pickle fixtures, one per L2-backed
cache kind, per active `_CACHE_VERSIONS` value. The fixtures are
consumed by `tests/test_cache_pickle_compat.py` to catch the class of
bug where a structural change to a cached value (a dataclass field
rename, a pandas dtype shift, a fetcher output-shape change) silently
breaks pods that try to unpickle entries written by other pods or by
prior deploys.

## Layout

```
tests/fixtures/cache/
├── README.md           ← this file
├── v1/
│   ├── num_soma/sample.pkl
│   ├── table/sample.pkl
│   ├── synapse/sample.pkl
│   ├── spatial_features/sample.pkl
│   ├── unique_values/sample.pkl
│   ├── cell_id_universe/sample.pkl
│   └── column_histograms/sample.pkl
└── v2/                 ← created when a kind bumps to v2; v1 stays
```

Each `sample.pkl` is a `pickle.dumps((value, fetched_at))` of a
representative cache entry — the same bytes shape `GcsObjectStore`
writes to L2 in production.

**Old version directories are NEVER deleted.** They're committed
so the canary test continues to assert that today's reader can still
unpickle yesterday's fixture for every still-supported version.
Deleting `v1/` after bumping a kind to `v2/` defeats the entire
purpose — the canary degrades to "test the current version against
itself," which the round-trip layer already does.

## What to do when the canary test fails

`tests/test_cache_pickle_compat.py::test_cross_version_canary` failed.
Here's the exact remediation:

### Step 1. Read the failure message

The test names the **kind** that failed (e.g. `spatial_features`) and
the **version** whose fixture stopped unpickling (e.g. `v1`). The
message also prints the exception that was raised during unpickling
— that usually tells you *what* changed (an `AttributeError` on a
dataclass field, a pandas dtype incompatibility, etc.).

### Step 2. Decide whether to bump the version

If the structural change is intentional — i.e., you renamed a field,
removed a column, changed a dtype, or did anything that would make a
production pod fail to unpickle an entry written by an older pod —
**bump the version**:

1. Open `cave_data_viewer/api/services/object_store.py`.
2. Find `_CACHE_VERSIONS[<kind>]` and bump it (e.g. `"v1"` → `"v2"`).
3. Run the regen script for that kind:
   ```bash
   uv run python scripts/regen_cache_fixtures.py --kind <kind>
   ```
   This writes `tests/fixtures/cache/v2/<kind>/sample.pkl`.
4. **Do not delete** `tests/fixtures/cache/v1/<kind>/sample.pkl`. It
   stays so the canary continues to assert today's reader can still
   handle it (or, after a future bump, can confirm v1 is no longer
   readable — at which point you'd remove v1 from `_CACHE_VERSIONS`
   *and* from this directory, in the same commit).
5. Commit both the version bump and the new fixture together.

### Step 3. If the failure is NOT intentional

The change that triggered the failure is a regression — pods deployed
with this commit would fail to unpickle production L2 entries, and
that's the bug. Revert the change, restore backward compatibility,
and the canary will pass.

## Regenerating fixtures

```bash
# Regenerate everything (synthesized values only; no CAVE round-trip).
uv run python scripts/regen_cache_fixtures.py

# Regenerate one kind.
uv run python scripts/regen_cache_fixtures.py --kind spatial_features

# Replace synapse + spatial_features with values captured from a real
# CAVE query against minnie65_public. Requires CAVE auth.
uv run python scripts/regen_cache_fixtures.py \
    --datastack minnie65_public --root-id 864691135885917808 \
    --kind synapse --kind spatial_features
```

The script uses **root_id 864691135885917808** (minnie65_public) by
default — a moderately-connected cell that exercises real pandas
dtypes without bloating the fixture. Override with `--root-id` if you
need a different cell. The choice should not change much over time;
bit-identical reproducibility isn't required (any reasonable cell
produces a fixture that catches the structural drift the canary is
looking for), but pinning the default keeps regeneration boring.

## Why this exists

Without committed fixtures, a refactor that renamed a `CachedSpatialFeatures`
field would silently land — every test would still pass against
freshly-built pickles — and the first sign of trouble would be cold
pods 5xx-ing in production when they try to read the prior version's
L2 entries.

See `cave_data_viewer/api/services/object_store.py` (the
`_CACHE_VERSIONS` block) for the policy on when to bump each kind's
version.
