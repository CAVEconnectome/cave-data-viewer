# Cache Lifecycle Management

The GCS-backed L2 cache (`CDV_GCS_CACHE_BUCKET`) introduces a deployment-side
concern that didn't exist with the in-process L1 caches: **objects in the
bucket persist across pod restarts and across deployments unless something
explicitly removes them.** This document describes how lifecycle is split
between app code and deployment configuration, what an operator needs to
set up once, and what manual operations exist for the cases that fall
outside the automated path.

## TL;DR

- **Freshness correctness** lives in the app (`fetched_at` checks at every
  read). A misconfigured bucket lifecycle does not serve stale data — it
  just wastes storage.
- **Storage hygiene** lives in the bucket (two lifecycle rules):
  `cache/default/` swept after 2 days (today's typical materialization
  lifetime), `cache/longlived/` swept after 730 days (public releases).
- **Retention class is dynamic.** A small JSON marker file at
  `cache/info/<datastack>-longlived-versions.json` names which mat
  versions get the long retention. Operators write it via
  `cdv-warm-cache`; the running service reads it with TTL caching and
  routes L2 reads/writes accordingly. **No service redeploy** required
  when a new public release lands.
- **Datastack aliases** let two datastacks (e.g. `minnie65_public` and
  `minnie65_phase3_v1`) share one cache namespace when they describe the
  same underlying data — set `cache_alias: <other_ds>` in per-datastack
  YAML.
- **Manual cache invalidation** is `gsutil rm`. There is no app endpoint
  for it. Most cases self-heal within an hour because the warmer
  overwrites the same object names on every fire.

## Where lifecycle is owned

| Concern | Owner | Mechanism |
| --- | --- | --- |
| Per-entry freshness (is this snapshot too old to serve?) | App | `fetched_at` check in `LayeredSwrCache._try_l2` and `NeuronQuery._try_synapse_l2` against `hard_ttl` (decorations) or `CACHE_QUERY_TTL_SECONDS` (synapse) |
| Per-pod L1 eviction | App | `cachetools.TTLCache` and `cachetools.LRUCache`; in-process only |
| Same-key overwrite (warmer rewrite) | App | `LayeredSwrCache.set` → fire-and-forget L2 write replaces the prior object at the same name |
| Storage hygiene (delete tombstones, bound bucket size) | **Deployment** | GCS bucket lifecycle rule |
| Manual invalidation (drop a poisoned snapshot now) | **Operator** | `gsutil rm` against a specific object path |
| Per-deployment isolation in a shared bucket | Deployment | `CDV_GCS_CACHE_PREFIX` |

The deliberate split: GCS is good at "store these bytes cheaply and let me
sweep them on a schedule." App code is good at "decide whether this byte
blob is still trustworthy." Each side owns what it's good at.

## Object layout in the bucket

Every L2 entry is a single pickled `(value, fetched_at)` tuple at a
deterministic path:

```
<GCS_CACHE_PREFIX><retention_class>/<kind>/<key-component-1>/.../<final>.pkl
```

`retention_class` is `default` (2-day sweep) or `longlived` (730-day
sweep), chosen at write time based on whether the request's
`mat_version` is named in the marker file (see *Retention classes*
below).

Concrete examples (default `GCS_CACHE_PREFIX=cache/`):

```
cache/default/cell_type/minnie65_public/1718/aibs_cell_info.pkl
cache/default/num_soma/minnie65_public/1718/nucleus_neuron_svm.pkl
cache/default/table/minnie65_public/1718/proofreading_status_and_strategy.pkl
cache/default/synapse/<sha1-hex>.pkl

cache/longlived/cell_type/minnie65_public/1764/aibs_cell_info.pkl
cache/longlived/synapse/<sha1-hex>.pkl

cache/info/minnie65_public-longlived-versions.json   ← marker file (NOT swept)
```

The synapse path uses a SHA-1 of the canonical query payload (datastack,
mat_version, root_id, columns, position prefix, desired resolution, …)
rather than a human-readable tuple — too many fields to encode in a
filename, and the hash collapses them into a stable identifier.

Tuple key components are URL-encoded so a partner table named e.g.
`proofreading/status_v1` doesn't accidentally introduce a path separator.

## Bucket setup (one-time, per deployment)

> **Production deploys:** the canonical IaC for the bucket lives in
> the separate shared deployment repo. The commands here are the
> *manual* path — useful for ad-hoc setup, validation, and as the
> reference shape that the production module wraps.
>
> **Local development:** use `scripts/setup_local_cache_bucket.sh`
> (see *Local development* below). It runs the same `gcloud` calls
> documented here, idempotently, with a per-developer prefix and a
> short retention.

Create the bucket if you don't have one:

```bash
gcloud storage buckets create gs://my-cdv-cache \
  --location=us-central1 \
  --uniform-bucket-level-access
```

Set the **two** lifecycle rules — one per retention class. JSON form:

```json
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": {
          "age": 2,
          "matchesPrefix": ["cache/default/"]
        }
      },
      {
        "action": { "type": "Delete" },
        "condition": {
          "age": 730,
          "matchesPrefix": ["cache/longlived/"]
        }
      }
    ]
  }
}
```

`cache/info/` is intentionally not matched — marker files (longlived-
versions registry) live there and must persist indefinitely.

Apply with `gcloud storage buckets update`:

```bash
gcloud storage buckets update gs://my-cdv-cache \
  --lifecycle-file=lifecycle.json
```

Verify:

```bash
gcloud storage buckets describe gs://my-cdv-cache --format="value(lifecycle)"
```

### Why these two retention classes

The lifecycle rules are **not** what enforce freshness — the app's
`fetched_at` check does that. The rules are storage hygiene. The two
classes track CAVE's two materialization-version regimes:

| Regime | Typical lifetime | Cache class | Lifecycle age |
| --- | --- | --- | --- |
| Working materializations (most versions) | ~2 days before pruned | `default` | 2 days |
| Public-release materializations (~4× year) | 1–2 years intentional | `longlived` | 730 days |

For non-working bases, an operator can pick different ages via the
`--default-age-days` / `--longlived-age-days` flags on
`scripts/setup_local_cache_bucket.sh`. Rule of thumb: each class's age
should exceed the largest `hard_ttl` for caches in that class plus
some margin. Default 2 days is overkill for a 24-h decoration `hard_ttl`,
which is intentional — gives operators a one-day grace window to
investigate before deletion.

Lifecycle scheduling is **daily-granularity** — Google evaluates rules
once per day per bucket — so a 1-hour TTL effectively means "stays in
the bucket for up to ~25 hours before the next sweep." That's fine;
reads still respect the true TTL via `fetched_at`.

### Per-kind retention tuning

If you want different retention for synapse dfs vs decoration tables,
split into multiple rules using the prefix:

```json
{
  "lifecycle": {
    "rule": [
      {
        "action": { "type": "Delete" },
        "condition": { "age": 14, "matchesPrefix": ["cache/synapse/"] }
      },
      {
        "action": { "type": "Delete" },
        "condition": { "age": 7,  "matchesPrefix": ["cache/cell_type/", "cache/num_soma/", "cache/table/"] }
      }
    ]
  }
}
```

A bucket can have up to 100 rules, so this is forward-compatible with
fine-grained policy if it ever becomes useful.

### Service account / IAM

Two distinct identities show up:

- **The cdv API runtime** (the GKE pod) needs read+write on the bucket.
  Bind its workload service account with `roles/storage.objectUser`
  scoped to the bucket — it covers `get`/`create`/`delete`/`list` on
  objects, which is the union of normal app traffic plus any operator
  `gsutil rm` cache-busts that run as the same SA.

  ```bash
  gcloud storage buckets add-iam-policy-binding gs://my-cdv-cache \
    --member="serviceAccount:cdv-workload@PROJECT.iam.gserviceaccount.com" \
    --role="roles/storage.objectUser"
  ```

  On GKE this is wired through Workload Identity, so the pod's KSA
  impersonates the GSA above:

  ```bash
  gcloud iam service-accounts add-iam-policy-binding \
    cdv-workload@PROJECT.iam.gserviceaccount.com \
    --member="serviceAccount:PROJECT.svc.id.goog[NAMESPACE/KSA]" \
    --role="roles/iam.workloadIdentityUser"

  kubectl annotate serviceaccount KSA \
    iam.gke.io/gcp-service-account=cdv-workload@PROJECT.iam.gserviceaccount.com
  ```

  No new SA is required if the project already has one bound to the cdv
  workload — `roles/storage.objectUser` slots onto the existing identity.

- **Developers** running locally use ADC tied to their personal account
  (`gcloud auth application-default login`). Project-level IAM grants
  read+write through whatever role the developer already has
  (`roles/storage.admin`, `roles/storage.objectUser`, etc.). No
  per-developer GSA is required.

Least-privilege variant: split into `roles/storage.objectCreator` +
`roles/storage.objectViewer` for the runtime SA. The app never needs
`delete` (lifecycle rule does its own deletes; routine traffic only
gets/sets). Trade-off is operators lose the ability to `gsutil rm` as
the same SA — usually not worth it, but cleanest for projects with strict
IAM policy.

### Sharing one bucket across deployments

Set a different `CDV_GCS_CACHE_PREFIX` per environment so prod and staging
don't collide. Lifecycle rules can scope to each prefix independently:

```
CDV_GCS_CACHE_PREFIX=cdv-prod/cache/      # production
CDV_GCS_CACHE_PREFIX=cdv-staging/cache/   # staging
```

```json
{
  "lifecycle": {
    "rule": [
      { "action": { "type": "Delete" }, "condition": { "age": 7,  "matchesPrefix": ["cdv-prod/cache/"] } },
      { "action": { "type": "Delete" }, "condition": { "age": 1,  "matchesPrefix": ["cdv-staging/cache/"] } }
    ]
  }
}
```

### Local development

Use `scripts/setup_local_cache_bucket.sh` to bootstrap a personal-scope
bucket. The script is idempotent (safe to re-run), creates the bucket
if needed, applies a short-retention lifecycle rule, and prints the
env-var snippet to copy into your shell.

```bash
scripts/setup_local_cache_bucket.sh \
  --project my-gcp-project \
  --bucket  cdv-dev-cache-myname \
  --user    myname
```

After it runs:

```bash
export CDV_GCS_CACHE_BUCKET=cdv-dev-cache-myname
export CDV_GCS_CACHE_PREFIX=dev-myname/cache/
export CDV_GCS_CACHE_PROJECT=my-gcp-project
gcloud auth application-default login   # one-time, ADC for runtime
CDV_DEV_AUTH_BYPASS=1 CDV_PORT=5001 uv run python run_api.py
```

`CDV_GCS_CACHE_PROJECT` names the GCP project used as the GCS quota /
billing target. Required for **end-user ADC** (which doesn't embed a
project) and for **Workload Identity** setups where the bound GSA is
in a different project than the bucket. Service accounts whose home
project matches the bucket can leave it unset — the client falls back
to whatever the auth identity carries.

Why a per-developer prefix:

- **Multiple developers in one project** can share a single dev bucket
  without cross-pollution — each writes under its own
  `dev-<username>/cache/` path.
- **Sharing a real (non-dev) bucket from local** is also possible
  (handy for testing against the same data prod is hitting). Set
  `CDV_GCS_CACHE_PREFIX=dev-myname/cache/` so your dev objects are
  namespaced; the lifecycle rule on the prod bucket can ignore the
  `dev-*/` paths or sweep them faster than the production `cache/`
  prefix.

The script's lifecycle rule scopes to `dev-<username>/cache/` only, so
re-running for one developer doesn't disturb another's prefix or any
other top-level paths in a shared bucket.

To wipe between sessions:

```bash
gsutil -m rm -r gs://my-dev-bucket/dev-myname/cache/
```

Costs for local dev are negligible — typical sessions touch a few
neurons and a handful of decoration tables, so storage is in the MB
range and the lifecycle rule sweeps overnight regardless. Pennies per
month per developer.

## Retention classes (default vs longlived)

The list of long-lived versions lives in a small JSON marker file in
the bucket itself, not in per-datastack YAML:

```
gs://<bucket>/<prefix>info/<datastack>-longlived-versions.json
```

Shape:

```json
{
  "datastack": "minnie65_public",
  "longlived_versions": [
    {"version": 1764, "marked_at": "2026-01-15T17:30:00Z", "expires_at": "2028-01-15"},
    {"version": 1850, "marked_at": "2026-04-01T12:00:00Z", "expires_at": "2028-04-01"}
  ]
}
```

The running service reads it with TTL caching (`LONGLIVED_VERSIONS_TTL_SECONDS`
config knob, default 5 min) and uses it to route every L2 read/write
to the right partition:

- mat_version is in the marker's list → `cache/longlived/...`
- mat_version is not in the list → `cache/default/...`
- Live mode → no L2 at all (in-process only)

**Service-side propagation is automatic.** When `cdv-warm-cache` writes
or updates the marker file, the running service picks up the change
within one TTL window (5 min by default). No service redeploy required.

**Staleness window after marking.** For up to one TTL window after a
new version is marked, individual pods may still see the old (empty)
longlived set. Behavior during that window:

- **Reads** for the newly-marked version look up `cache/default/`
  paths. Warming-script writes are under `cache/longlived/`, so the
  lookup misses → request falls through to CAVE for one round-trip.
  Annoying, not broken.
- **Writes** by request handlers go to `cache/default/`. Those
  duplicate objects get swept by the 2-day rule. Wasted bytes; no
  correctness impact.
- **No stale data is ever served.** The retention class only governs
  *where* data lives, not *what* data is correct. Values are
  deterministic for a given mat_version regardless of which partition
  serves the lookup.

`cdv-warm-cache` calls the registry's `invalidate(...)` method after
writing the marker file so the script's own process doesn't suffer
this window.

## Datastack aliasing

Some datastacks describe the same underlying data. The most common
case: `minnie65_public` is a view of `minnie65_phase3_v1` filtered to
long-lived materializations. Their cache values for shared
`(mat_version, root_id, …)` tuples are *identical*, so the bucket
should hold one copy.

Set `cache_alias` in the per-datastack YAML to redirect cache traffic:

```yaml
# config/datastacks/minnie65_public.yaml
cache_alias: minnie65_phase3_v1
```

When set:

- Every L2 read, L2 write, and marker-file lookup for `minnie65_public`
  substitutes `minnie65_phase3_v1` as the cache namespace component.
- The actual CAVE call still uses `minnie65_public` — the alias is
  purely about cache pathing, not about which CAVE endpoint to hit.
- Marking v1764 as longlived for *either* datastack writes to
  `cache/info/minnie65_phase3_v1-longlived-versions.json` and both
  datastacks' requests honor it.

The alias propagates through every cache-key construction site (synapse
df, decoration tables, soma summary, spatial features) via the
`cache_datastack(...)` helper in `services/cache_lifecycle.py`. One
edit to the YAML, every cache layer agrees.

## Pre-warming with `cdv-warm-cache`

For public releases, the operator runs the warming script once per
release to populate the `cache/longlived/` partition before users
arrive:

```bash
CDV_GCS_CACHE_BUCKET=...                    \
CDV_GCS_CACHE_PREFIX=cache/                 \
CDV_GCS_CACHE_PROJECT=...                   \
CDV_WARMUP_AUTH_TOKEN=...                   \
uv run cdv-warm-cache                       \
    --datastack    minnie65_public          \
    --mat-version  1764                     \
    --expires      2028-01-15
```

Two operations, default both run in sequence:

1. **Mark.** Writes/updates the marker file to add v1764 to the
   longlived set. Idempotent merge — existing entries are preserved.
2. **Warm.** For each cell in the proofread set, fetches both
   directions of the synapse df via `NeuronQuery._synapse_df`. The L2
   write happens automatically as a side effect. Parallelized
   (default 8 workers); ~25 min for 2000 cells.

The cell list comes from the per-datastack YAML's `synapse_warmup`
block (which proofreading table to query and how to filter), or from
an explicit `--root-ids-file <path>` for ad-hoc lists. The script
refuses to warm if the version isn't marked longlived — passes the
operator's intent through the safety check rather than silently
warming into a 2-day-sweep partition.

Re-runs are cheap: cells already in L2 return instantly via the SWR
read path; only failed cells from the prior run pay CAVE again.

## What happens during typical scenarios

### A new materialization version is published

Cache keys include `mat_version`, so a new version writes objects under a
new path (`cache/cell_type/minnie65_public/<new_version>/...`). Old
version's objects remain in the bucket but are never read again — they're
swept by the lifecycle rule on its normal schedule.

**No manual action required.** Storage cost grows by ~one decoration
snapshot per version per kind until the rule sweeps; trivial at typical
release cadences.

### Pod loss mid-render

The replacement pod boots cold L1, hits L2, promotes entries with
preserved `fetched_at`. User sees one ~30ms tax per L2 read instead of a
multi-second CAVE refetch. **No action required.**

### Schema change to a pickled value (deploy-time risk)

If a deploy changes the shape of a cached value (e.g. adds a column to
the partner-record dict, changes a class path, bumps pickle protocol),
the new code reads an old object from L2 and fails to deserialize.

App behavior on deserialization failure:

- **L1**: `SwrCache._safe_loads` evicts the entry, logs `swr_deserialize_failed`,
  treats as a cache miss.
- **L2 (`GcsObjectStore.get`)**: catches the exception, logs
  `gcs_get_failed`, returns None — also treated as a miss.

The next CAVE fetch repopulates with the new shape and overwrites the
poisoned object. **No action required.** Watch for `gcs_get_failed` log
spikes immediately after deploy as a normal sign that the cache is
rolling forward.

If the poisoned objects are large and you don't want to wait for the
self-heal, see *Manual invalidation* below.

### GCS outage

`GcsObjectStore.get` and `set` swallow all exceptions. Reads degrade to
"L1 miss → CAVE refetch" (the path that exists today without L2). Writes
just don't happen. **Service stays up; ops sees `gcs_get_failed` /
`gcs_set_failed` warnings in logs.**

### Class / tutorial: many users hitting the same data

A frequent and intentional win of this design. 30 students on 30
sticky-pinned pods hitting the same demo neuron:

- Student 1 (or the warmer, see below): cold L1 + cold L2 → CAVE round-trip
  → populates L1 + writes L2.
- Students 2–30: cold L1 + warm L2 → ~30ms × 2 GCS reads per decoration
  snapshot, plus ~30ms × 2 for the synapse dfs. Total decoration
  amortization: roughly one CAVE round-trip across the whole class.

Without L2, every pod was cold and every student paid the full CAVE price.

**Pre-warming for a known class window**: hit the demo neuron(s) once
before class starts so the bucket is populated before the first student
arrives. A `curl` against `/connectivity` for each demo cell ID is enough.
For recurring-class deployments, register the relevant tables in
`decoration_warmup` (per-datastack YAML) and let `PeriodicWarmer` keep
them hot continuously.

### Bucket-wide TTL config change

Changing the lifecycle rule takes effect within ~24 hours on the next
schedule run. App-side reads are unaffected — `fetched_at` continues to
gate freshness.

## Manual operations

### Inspect what's in the cache

```bash
# List by kind
gsutil ls -lh gs://my-cdv-cache/cache/cell_type/

# List for a specific datastack + version
gsutil ls -lh gs://my-cdv-cache/cache/cell_type/minnie65_public/1718/

# Pull one object and look at it (debugging only — pickled)
gsutil cp gs://my-cdv-cache/cache/cell_type/minnie65_public/1718/aibs_cell_info.pkl /tmp/snap.pkl
python -c "import pickle; v, ts = pickle.load(open('/tmp/snap.pkl','rb')); print(type(v), 'rows:', len(v), 'fetched_at:', ts)"
```

### Bust one snapshot (poisoned data, urgent invalidation)

```bash
gsutil rm gs://my-cdv-cache/cache/cell_type/minnie65_public/1718/aibs_cell_info.pkl
```

The next request that needs that decoration falls through to CAVE,
populates L1, and writes a fresh L2 object on the way back. If the warmer
runs that table on a periodic schedule, it'll also rewrite within the
warmer's interval (default 1 hour) without any user request.

There is no app endpoint for this. If it becomes a frequent operation, a
small `cdv-cache-evict <key>` CLI is a 30-line addition wired off
`build_l2_stores`.

### Wipe everything (e.g. before a major deploy)

```bash
gsutil -m rm -r gs://my-cdv-cache/cache/
```

Subsequent reads all become CAVE round-trips until the warmer + on-demand
fetches refill. **Do this carefully** — until L2 is populated, every cold
pod pays a full CAVE fetch on every decoration request. For a low-traffic
deploy window this is fine; for a high-traffic one, prefer per-kind
selective wiping.

### Wipe one kind (e.g. forced re-warm of cell_type tables)

```bash
gsutil -m rm -r gs://my-cdv-cache/cache/cell_type/
```

The `PeriodicWarmer` will repopulate within `interval_seconds` (typically
1 hour). User requests during the window pay CAVE round-trips and
populate as a side effect.

## Monitoring

Watch these log signatures on the API:

| Log line | Meaning | Action |
| --- | --- | --- |
| `gcs_get_failed` (sustained) | L2 reads failing — auth, network, bucket missing | Check bucket name, ADC / Workload Identity, GCS service status |
| `gcs_set_failed` (sustained) | L2 writes failing — same as above, plus possibly bucket permissions | Same |
| `layered_l2_get_failed` | Any L2 implementation raised — `GcsObjectStore` swallows internally, so this only fires on a custom / test L2 | Check L2 wiring |
| `swr_deserialize_failed` | L1 entry couldn't be unpickled — likely a deploy that changed value shape | Watch for resolution within an hour; if persistent, wipe affected prefix |
| `synapse_l2_hit[<dir>]` (timer) | A synapse df came from L2 instead of CAVE | Normal; expected on cold pods |
| `synapse_query[<dir>]` (timer) | Full CAVE round-trip for synapse df | Normal on first fetch; investigate if persistent under steady load |

A sensible first-pass alert: `gcs_get_failed` rate > 1/min sustained for
5 minutes. Routine 404s (cold-cache misses) are intentionally **not**
logged at warning level — they happen on every cold pod start.

### Bucket-side observability

GCS Console (or `gcloud storage buckets describe`) shows total object
count and storage size. Useful sanity checks:

- Object count under `cache/cell_type/` should bound at `~(number of
  configured cell-type tables) × (number of recent mat versions
  retained by the lifecycle rule)`. A runaway number suggests the
  rule isn't firing or the prefix is wrong.
- Object size: a single decoration table is typically 1–50 MB pickled.
  Synapse dfs are 1–5 MB. Wildly larger objects suggest a value-shape
  change worth investigating.

## Backup and disaster recovery

**The cache is fully regenerable from CAVE.** Backups are not required.
If the bucket is lost:

- Decoration mat caches: `PeriodicWarmer` repopulates on its next fire.
- Synapse dfs: repopulate on demand as users hit neurons.
- During the window: every request pays CAVE round-trips. Same as today's
  L1-only deployment, just without the cross-pod share. No data loss.

If you want belt-and-suspenders, GCS native `versioning: enabled` keeps
overwritten objects for a configurable retention. Not recommended for the
cache use case — it doubles storage with no real benefit, since old
versions are stale-by-construction (the warmer only overwrites with
fresher data). Skip it.

## Things this design intentionally does not do

- **Synchronous L1 → L2 deletion.** `LayeredSwrCache.clear()` clears L1
  only. Propagating to L2 would defeat the cross-pod share — the next
  pod that needs the value would refetch from CAVE rather than reading
  the still-good GCS object.
- **Read-time deletion of expired entries.** When a reader detects an
  L2 entry past `hard_ttl`, it returns None (treats as miss) but does
  not issue a `gsutil rm` against the object. The lifecycle rule
  handles cleanup; doing it on the read path would couple every cache
  read to a write request and a billable Class A operation.
- **App-side bucket creation.** The app does not create or manage the
  bucket. An operator provisions the bucket and the lifecycle rule once;
  the app only reads and writes objects.
- **Per-environment cache busting on deploy.** A deploy that changes
  pickled shapes will self-heal — old objects fail to deserialize,
  new objects get written. If you want a clean cut at deploy time,
  bump `CDV_GCS_CACHE_PREFIX` (e.g. include the app version) and let
  the lifecycle rule sweep the old prefix on its normal schedule.
