# Environment Variables

Every runtime knob exposed by the CAVE Diver (CDV) backend. Every
variable in this document is read directly by the application; none are
read by Vite/the frontend (frontend config is baked at `npm run build`
time).

## At-a-glance: what to set

For a **minimum viable** local Docker run:

```bash
docker run --rm -p 8000:8000 \
  -v /host/config:/app/config \
  -e GLOBAL_SERVER=global.daf-apis.com \
  cdv
```

For **production**, additionally set: `CDV_FEATURE_TABLES_BASE_URI`
(GCS), `CDV_GCS_CACHE_BUCKET` (L2 cache), and the `PYTHONUNBUFFERED=1`
runtime knob — already baked into the image. Mount a service-account
cave-secret at `/app/.cloudvolume/secrets/cave-secret.json` if any
datastack YAML enables `decoration_warmup.enabled: true`.

For **local development** (no Docker), additionally set:
`CDV_DEV_AUTH_BYPASS=1` and `CDV_PORT=5001` (AirPlay squats on 5000).

## Required at runtime

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `GLOBAL_SERVER` *or* `CDV_GLOBAL_SERVER_ADDRESS` | string (host or URL) | none | CAVE global discovery server. The app cannot resolve any datastack info without it. `GLOBAL_SERVER` accepts a bare host (`global.daf-apis.com`); the `CDV_…` form accepts a full URL (`https://global.daf-apis.com`). Set one or the other — not both. |

Everything else has a default suitable for either local dev or a
plain-vanilla single-pod deployment.

## Networking and process

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CDV_PORT` | int | `8000` (Docker), `5001` (`run_api.py`) | Bind port. Docker image's gunicorn CMD reads this; the dev runner reads this. |
| `CDV_WORKERS` | int | `1` | Gunicorn worker count. **Leave at 1.** The SWR ticket/poll flow is per-process — a ticket minted in worker A isn't visible to worker B, so a poll that lands on the wrong worker reports "no such ticket". The GCS L2 cache covers cross-pod and cross-restart sharing (cold workers promote from L2 in ~30 ms instead of refetching from CAVE), but ticket locality is still per-process. Multi-pod scaling uses sticky-session ingress; within a pod, stay single-worker. |
| `CDV_TIMEOUT` | int (seconds) | `120` | Gunicorn worker timeout. Sized for cold CAVE fetches on heavily-connected neurons (synapse + cell-type + soma fetches can stack to 30s+ on first request). |
| `CDV_SPA_DIR` | path | `frontend/dist` (relative to `WORKDIR`) | Where the built React SPA lives. Override if you've built into a non-default path. |
| `CDV_CORS_ORIGINS` | comma-separated list | `http://localhost:5173` | Allowed cross-origin origins for the API. Vite dev server is the local-dev default; production deployments override with the public frontend origin(s). |
| `CDV_SPELUNKER_URL` | URL | `https://spelunker.cave-explorer.org` | Base URL the backend uses when minting Neuroglancer links. |

## Auth

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CDV_DEV_AUTH_BYPASS` | bool | `false` | Skip middle-auth-client checks on every endpoint. **Never** set this in a production deployment — it bypasses the entire user-auth boundary. Local dev only. Truthy values: `1`, `true`, `yes`, `on`. |
| `GLOBAL_SERVER` | host or URL | unset | Standard middle-auth-client / CAVEclient discovery env var. The app reads it as a fallback for `CDV_GLOBAL_SERVER_ADDRESS` so middle-auth and CDV share one source of truth. |

The background decoration warmer (`PeriodicWarmer`) and the
`cdv-warm-cache` CLI authenticate via the cave-secret file at
`~/.cloudvolume/secrets/cave-secret.json` (i.e. `/app/.cloudvolume/secrets/`
inside the image). Mount a service-account CAVE credential at that path
in any deployment where `decoration_warmup.enabled: true` is set or where
`cdv-warm-cache` will run.

The app never reads `~/.cloudvolume/secrets/cave-secret.json` from a
request-handling path — that fallback is gated to the dev-bypass and
warmer paths only, with audit logging on every use. See
`cave_data_viewer/api/cave.py` for the guarantee.

## Configuration directories

The app loads YAML config from a repo-relative `config/` tree (the
`/app/config` bind-mount target inside the Docker image). Each
sub-area also has an override env var for layering deployment-specific
YAMLs on top.

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CDV_FEATURE_TABLES_BASE_URI` | URI (`file://`, `gs://`) | `file://<repo>/config/` | Base for the feature-table catalog. The loader joins this with `feature_tables/<datastack>/` to find per-datastack feature-table YAMLs. Default points at the repo's `config/`; override with `gs://my-bucket/` to host the catalog in GCS. Trailing slash optional. |
| `CDV_DATASTACK_CONFIG_DIR` | dir path | unset | Extra datastack YAMLs. Each `<ds>.yaml` here wins over the same-named file under `<repo>/config/datastacks/`. Useful for ConfigMap injection. |
| `CDV_ALIGNED_VOLUME_CONFIG_DIR` | dir path | unset | Same pattern, for `aligned_volumes/<av>.yaml`. |
| `CDV_RECIPES_CONFIG_DIR` | dir path | unset | Built-in recipes override. Replaces (not merges) the per-datastack list under `<repo>/config/recipes/<ds>/`. |
| `CDV_EXAMPLES_CONFIG_DIR` | dir path | unset | Operator examples override. Same replace-not-merge semantics as recipes. |
| `CDV_LINK_TEMPLATE_DIR` | dir path | unset | Extra `templates/links/*.yaml` (Neuroglancer link templates). Searched after the built-in templates. |
| `CDV_PLOT_TEMPLATE_DIR` | dir path | unset | Extra `templates/plots/*.yaml` (PlotSpec definitions). Searched after the built-in templates. |
| `CDV_DEFAULT_DATASTACK` | string | unset | Initial selection for the SPA picker. Only a hint; the SPA also honors `?ds=` in the URL. |

The image ships no bundled YAMLs (see [Dockerfile](../Dockerfile)
preamble) — without a `config/` bind-mount the picker is empty by
design. The `CDV_*_CONFIG_DIR` overrides exist for layered deployment
scenarios (K8s ConfigMap-per-datastack) on top of the base mount.

## GCS L2 cache

The L2 cache persists decoration and synapse-df cache entries to GCS so
cold pods promote L2 entries to L1 in ~30ms instead of paying a
multi-second CAVE refetch. Off by default; turn on by setting the
bucket.

| Variable | Type | Default | Notes |
|---|---|---|---|
| `CDV_GCS_CACHE_BUCKET` | string (bucket name, no `gs://`) | unset | When set, enables the L2 cache. ADC supplies auth. |
| `CDV_GCS_CACHE_PREFIX` | string | `cache/` | Object-name prefix inside the bucket. Use distinct prefixes (`cdv-prod/cache/`, `cdv-staging/cache/`) to share one bucket across environments. |
| `CDV_GCS_CACHE_PROJECT` | string (GCP project ID) | unset | Billing/quota project for GCS calls. Needed when the runtime auth identity does not embed a project (e.g. end-user ADC from `gcloud auth application-default login`); service accounts and Workload Identity bindings carry a project natively and don't need this. |

Standard Google-library env vars also apply when the L2 cache (or the
`gs://` feature-table catalog) is in use: `GOOGLE_APPLICATION_CREDENTIALS`
for service-account keyfile auth, etc. These are read by `google-cloud-storage`
directly, not by CDV.

## Cache TTLs

All optional. Defaults are tuned for a single-pod deployment with
sticky-session ingress; production deployments rarely need to tune
them. All values are in seconds.

| Variable | Default | Notes |
|---|---|---|
| `CDV_CACHE_QUERY_TTL_SECONDS` | `900` (15m) | Soft TTL for `/connectivity` synapse-df query results. |
| `CDV_CACHE_TABLE_META_TTL_SECONDS` | `3600` (1h) | Table-list + version metadata. Cheap upstream calls, but cache rolls quickly so new versions appear within the hour. |
| `CDV_CACHE_UNIQUE_VALUES_TTL_SECONDS` | `604800` (7d) | Distinct-string-values per (datastack, mat_version, table). Materializations are frozen so this is effectively forever; the finite TTL exists only because `cachetools.TTLCache` requires one and bounds memory if many datastacks accumulate. |
| `CDV_CACHE_INFO_TTL_SECONDS` | `86400` (24h) | Per-datastack `info` dict. |
| `CDV_CACHE_SPATIAL_FEATURES_TTL_SECONDS` | `1800` (30m) | Per-partner spatial features (soma_depth, etc.). Invariant for a frozen mat version; live mode short-circuits the cache via the `mat_version="live"` key. |
| `CDV_CACHE_DECORATION_SOFT_TTL_SECONDS` | `14400` (4h) | Soft TTL for materialized decoration tables. |
| `CDV_CACHE_DECORATION_HARD_TTL_SECONDS` | `86400` (24h) | Hard TTL — past this, next caller pays a synchronous fetch. |
| `CDV_CACHE_DECORATION_LIVE_SOFT_TTL_SECONDS` | `300` (5m) | Same, for live-mode decoration reads. |
| `CDV_CACHE_DECORATION_LIVE_HARD_TTL_SECONDS` | `1800` (30m) | Same, hard. |
| `CDV_CACHE_EMBEDDING_MANIFEST_SOFT_TTL_SECONDS` | `300` (5m) | Feature-table catalog freshness window. Lower this when iterating on a `feature_tables/<ds>/` directory; manifest edits propagate within this interval. |
| `CDV_CACHE_EMBEDDING_MANIFEST_HARD_TTL_SECONDS` | `3600` (1h) | Manifest hard TTL. Past this, next caller pays a synchronous fetch and any error surfaces loudly. |
| `CDV_DECORATION_REVALIDATION_WORKERS` | `4` | Thread pool size for background SwrCache revalidations. |
| `CDV_LONGLIVED_VERSIONS_TTL_SECONDS` | `300` (5m) | Staleness window for the per-pod long-lived-versions marker-file cache. Lower = operator's `cdv-warm-cache` mark takes effect faster across pods; higher = fewer GCS reads. Served values are always correct; only the choice of L2 partition lags. |

## Type coercion rules

When a `CDV_*` env var is read into `app.config`, the value is coerced
based on the type of the default in `cave_data_viewer/api/config.py`:

| Default type | Coercion |
|---|---|
| `bool` | Truthy on `1`, `true`, `yes`, `on` (case-insensitive); falsy otherwise. |
| `int` | `int(raw)`. Raises if the value isn't an integer literal. |
| `list` | Comma-split, whitespace-trimmed, empty entries dropped. |
| anything else (string, `None`) | Used verbatim. |

So `CDV_CORS_ORIGINS=http://localhost:5173,https://cdv.example.com`
produces `["http://localhost:5173", "https://cdv.example.com"]`.

## Variables read outside `_DEFAULTS`

A handful of env vars are read directly rather than going through the
`_DEFAULTS`-and-coerce mechanism in `config.py`. They are otherwise
identical in spirit but skip the type coercion (all string-valued):

- `CDV_DEV_AUTH_BYPASS` — bool, read with explicit truthy-set check.
- `CDV_FEATURE_TABLES_BASE_URI` — URI string, normalized to end in `/`.
- `CDV_SPA_DIR` — path string.
- `CDV_RECIPES_CONFIG_DIR`, `CDV_EXAMPLES_CONFIG_DIR` — directory paths.
- `CDV_PORT`, `CDV_WORKERS`, `CDV_TIMEOUT` — runtime knobs read by the
  Dockerfile's gunicorn CMD and by `run_api.py`.

## Worked examples

### Local development (no Docker)

```bash
CDV_DEV_AUTH_BYPASS=1 \
CDV_PORT=5001 \
GLOBAL_SERVER=global.daf-apis.com \
uv run python run_api.py
```

`config/` in the repo is the live config source. Edits hot-reload (the
loader is mtime-keyed; no server restart needed for datastack /
aligned-volume YAML edits).

### Minimum-viable Docker run

```bash
docker run --rm -p 8000:8000 \
  -v /host/config:/app/config \
  -e GLOBAL_SERVER=global.daf-apis.com \
  cdv
```

Host's `/host/config` mirrors the repo's `config/` layout:
`datastacks/`, `aligned_volumes/`, `feature_tables/<ds>/`.

### Production-ish Docker run

```bash
docker run --rm -p 8000:8000 \
  -v /host/config:/app/config \
  -v /host/cave-secret:/app/.cloudvolume/secrets:ro \
  -e GLOBAL_SERVER=global.daf-apis.com \
  -e CDV_CORS_ORIGINS=https://cdv.example.com \
  -e CDV_FEATURE_TABLES_BASE_URI=gs://cdv-prod-feature-tables/ \
  -e CDV_GCS_CACHE_BUCKET=cdv-prod-cache \
  -e CDV_GCS_CACHE_PREFIX=cdv-prod/cache/ \
  cdv
```

ADC for GCS auth comes from the service account attached to the pod
(or `GOOGLE_APPLICATION_CREDENTIALS` for a keyfile). CAVE auth for the
warmer comes from the mounted `cave-secret.json` (a service-account
credential).

### K8s ConfigMap injection (overlaid on a base config mount)

```yaml
env:
  - name: GLOBAL_SERVER
    value: global.daf-apis.com
  - name: CDV_DATASTACK_CONFIG_DIR
    value: /etc/cdv/datastacks-overlay
  - name: CDV_FEATURE_TABLES_BASE_URI
    value: gs://cdv-prod-feature-tables/
volumeMounts:
  - name: base-config
    mountPath: /app/config
  - name: ds-overlay
    mountPath: /etc/cdv/datastacks-overlay
```

The overlay wins per `<ds>.yaml` collision; datastacks present only in
the base mount remain visible. Same pattern works for
`CDV_ALIGNED_VOLUME_CONFIG_DIR`, `CDV_RECIPES_CONFIG_DIR`, etc.

## Build-time only

These are set in the `Dockerfile` (or by uv during the build) and have
no runtime effect:

- `UV_LINK_MODE=copy`, `UV_COMPILE_BYTECODE=1`, `UV_PYTHON_DOWNLOADS=never` —
  uv build-stage knobs.
- `PYTHONDONTWRITEBYTECODE=1`, `PYTHONUNBUFFERED=1` — standard Python
  runtime knobs already baked into the image.
- `PATH` — extended in the runtime stage to put `/app/.venv/bin` first.

Listed here for completeness; you don't override these in deployment.
