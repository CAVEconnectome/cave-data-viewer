# Deployment plan: dynamic datastack discovery + pluggable cache backend

> Living document. Captures the architectural intent for moving this app
> from "ships a curated registry of datastacks" to "thin shell over the
> user's CAVE access," and the deployment shape that follows. Concrete
> implementation lands in separate PRs against this plan.

## Context

Today the deployment is "we ship a curated registry of datastacks":
`KNOWN_DATASTACKS = ["minnie65_public"]` in the SPA, per-datastack YAMLs
bundled in the Python package, every config field operator-required. For
the multi-datastack rollout on GKE — where users arrive via
datastack-specific landing pages, have different CAVE access scopes, and
the deployment runs on pre-emptible nodes with vertical autoscaling —
that posture doesn't fit. The deployment should know only:

1. The global CAVE address (already env-configured).
2. Middle-auth wiring.
3. An optional ConfigMap of operator overrides for spatial info /
   policy.

Everything else — which datastacks exist, what tables they have, what
versions are available — comes from CAVE at request time, gated by the
user's token. The YAML registry becomes an *optional override* layer
for things CAVE doesn't know (spatial transforms, layer bounds, operator
preferences).

Two execution waves: **discovery + cache-backend swap together** (Phase
1+2 in this plan), **Helm/Terragrunt deployment infrastructure** deferred
to a follow-up once the application changes are exercised locally.

### Reference implementation

`~/Work/Code/Guidebook/` (the Tourguide service) is a working Flask +
middle-auth + flask_caching app on GKE that does exactly this dynamic-
discovery pattern. Patterns to lift:

- `auth_requires_permission("view", table_id=datastack_name,
  resource_namespace="datastack")` from middle-auth-client gates per-
  datastack access *natively* — we don't have to roll our own ACL.
- `make_global_client(server_address, auth_token=flask.g.auth_token)`
  builds the discovery client with the user's token. **No service-side
  CAVE secret. The user's token IS the secret.**
- `flask_caching.Cache(config={"CACHE_TYPE": "SimpleCache", ...})` with
  `CACHE_TYPE` env override — already-validated swap path for Redis.
- `caveclient.tools.caching.CachedClient` wraps info calls so we don't
  hand-roll a TTL cache around `get_datastack_info`. Centralizing the
  client wrapper means upstream caveclient improvements flow through
  without our intervention.
- gunicorn baseline: `workers=2, threads=4, worker_class=gthread,
  graceful_timeout=90` — gthread (not sync) so a slow CAVE call doesn't
  block the worker. Not sacred; switching to uvicorn or similar is fine
  if a future need surfaces.
- `loguru` for app logs — JSON output flows directly into Cloud Logging.

Patterns we're **skipping** vs. Tourguide:

- Prometheus / metrics sidecar (`Dockerfile.metrics`,
  `prometheus_client` multiprocess collector). At our expected load
  (peak ~100 concurrent users) the metrics pipeline is heavier than
  the value it provides. GKE VPA samples kubelet stats directly, and
  Cloud Logging picks up structured logs for whatever dashboards we
  want. Add later if a real need surfaces.

## North-star architecture

### Source of truth, per concern

| Concern | Source | Rationale |
| --- | --- | --- |
| Datastack list | CAVE (`client.info.get_datastacks()`, user-scoped) | Auth gates which datastacks the user sees |
| `synapse_table` | CAVE datastack_info | Always current |
| `soma_table` | CAVE datastack_info (when published) | Always current |
| Versions, tables/views | CAVE (already on-demand) | Already CAVE-driven |
| Spatial transform name + layer config | YAML override | Not in CAVE — operator-curated |
| Aggregation rules, cell-id-lookup tables | YAML override | Operator preference |
| `live_mode`, decoration warmup | YAML override | Operator policy |

### Entry-point semantics

- **Datastack-specific landing pages** are the primary entry. Links carry
  `?ds=<name>` and immediately drive the bundle fetch.
- **Anonymous deep-link** works when the datastack is public — CAVE
  call succeeds without a token. No login needed for read-only browsing
  of public data.
- **Private datastack deep-link** triggers a 401 from CAVE → SPA shows
  a "Sign in to CAVE" CTA → middle-auth redirect → user returns to the
  same URL.
- **Bare SPA load** (no `?ds=`) shows an empty dropdown with the same
  Sign-in CTA. Post-login, the dropdown populates from
  `/api/v1/datastacks`.

### Failure mode for YAML-less datastacks

Serve everything CAVE provides; spatial-dependent features (soma_depth,
layer guides, depth profile, depth-axis stripplot of `median_syn_depth`)
silently don't appear. The SPA's existing "no spatial transform → no
spatial columns in the bundle" path already handles this; the change
is just that more datastacks land on it by default.

## Phase 1: dynamic datastack discovery

### Backend — new `GET /api/v1/datastacks` endpoint

`cave_data_viewer/api/endpoints/datastacks.py` (existing file,
add the index route):

```python
@bp.route("", methods=["GET"])  # /api/v1/datastacks
@auth_required
def list_datastacks():
    # Mirrors Tourguide's pattern: global CAVE client, user's token,
    # filtered by what they can see. The deployment knows only
    # `GLOBAL_SERVER_ADDRESS` (already env-configured); per-datastack
    # access checks happen on the *bundle* / *plot* endpoints via
    # `auth_requires_permission("view", table_id=ds,
    # resource_namespace="datastack")` — middle-auth gates natively.
    gclient = make_global_client(
        server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
        auth_token=flask.g.get("auth_token"),
    )
    names = gclient.info.get_datastacks()
    return jsonify({
        "datastacks": [
            {"name": ds, "has_operator_config": _has_operator_yaml(ds)}
            for ds in names
        ],
    })
```

`make_global_client` is the helper signature Tourguide uses; we already
have `make_client_with_token` / `make_client_anonymous` in
`api/cave.py` — add a `make_global_client(auth_token=...)` sibling that
calls `CAVEclient(datastack_name=None, global_only=True, ...)`.

Per-datastack endpoints (existing `/datastacks/<ds>/*` family) gain
`@auth_requires_permission("view", table_id=ds, resource_namespace="datastack")`
on top of the existing `@auth_required` so middle-auth enforces ACL
without any code in our service. Today these only check `auth_required`.

When `CDV_DEV_AUTH_BYPASS=1` the client is anonymous (current dev
behavior); production requires the token.

Per-user TTL cache around the discovery call (15 min, keyed by
sha256(token)) — `client.info.get_datastacks()` is fast but spamming it
from every page load is wasteful.

### Backend — YAML shrinkage

`cave_data_viewer/api/services/datastack_config.py` —
every `DatastackConfig` field becomes optional with a sensible default.
Most are already `Optional[…]` or have factory defaults; the change is
behavioural: `load_datastack_config(ds)` returns a populated config
*even when no YAML exists*, with CAVE-derived fields lazily resolved.

```python
def load_datastack_config(datastack: str) -> DatastackConfig:
    bundled = _DATASTACKS_DIR / f"{datastack}.yaml"
    override_dir = current_app.config.get("CDV_DATASTACK_CONFIG_DIR")
    paths = [bundled]
    if override_dir:
        paths.append(Path(override_dir) / f"{datastack}.yaml")
    raw = {}
    for p in paths:
        if p.is_file():
            raw = _deep_merge(raw, yaml.safe_load(p.read_text()) or {})
    # raw may be {} when no YAML exists — DatastackConfig handles defaults.
    return DatastackConfig.model_validate(raw)
```

Services that need a CAVE-derived field (synapse_table, soma_table)
read it from `client.info.get_datastack_info()` when the YAML didn't
override:

```python
# services/neuron.py — example
synapse_table = cfg.synapse_table or client.info.get_datastack_info()["synapse_table"]
```

For consistency, add a `resolve_synapse_table(cfg, client)` helper so
the fallback rule lives in one place. Same for `resolve_soma_table`.

### Frontend — discovery + login CTA

**`frontend/src/api/queries.ts`** — new `useDatastacks()` hook.
Returns `{ data: [{name, has_operator_config}], isUnauthenticated }`. A
401 surfaces as `isUnauthenticated: true` rather than `error` — the SPA
treats it as a UX state, not a fault.

**`frontend/src/components/Workspace.tsx`** — replace
`KNOWN_DATASTACKS = ["minnie65_public"]` with a fetch:

```tsx
const datastacks = useDatastacks();
// dropdown options come from datastacks.data (post-login)
// when datastacks.isUnauthenticated → show Sign-in CTA
// deep-link with ?ds=<X> works regardless of fetch state — SPA uses URL value
```

The SPA already drives state from the URL, so a deep-link `?ds=foo` proceeds
to fetch the bundle without waiting on `/api/v1/datastacks`. If the bundle
fetch returns 401 → render Sign-in CTA in `NeuronView` (small change to
that component).

**`frontend/src/components/SignInCTA.tsx` (NEW)** — small component
showing a "Sign in to CAVE" button that points to the configured
middle-auth flow URL. The URL comes from a build-time env (`VITE_LOGIN_URL`)
or, cleanly, a runtime config endpoint. Default: middle-auth's
`/auth/login?redirect=<current-href>` convention used by Tourguide.

### Files (Phase 1)

Backend:
- `cave_data_viewer/api/endpoints/datastacks.py` (+ index route)
- `cave_data_viewer/api/services/datastack_config.py` (graceful no-YAML)
- `cave_data_viewer/api/services/neuron.py` (resolve fallbacks)
- `cave_data_viewer/api/services/plots.py` (same fallback rule)
- `cave_data_viewer/api/cave.py` (add `make_global_client`)

Frontend:
- `frontend/src/api/queries.ts` (`useDatastacks` hook)
- `frontend/src/api/types.ts` (`DatastackListItem` type)
- `frontend/src/components/Workspace.tsx` (drop the constant)
- `frontend/src/components/SignInCTA.tsx` (NEW)
- `frontend/src/components/NeuronView.tsx` (401-aware error path)

Reuses:
- `make_client_with_token` / `make_client_anonymous`
  (`cave_data_viewer/api/cave.py`) — auth-correct CAVE client.
- `caveclient.tools.caching.CachedClient` — info-call caching at the
  client layer (replaces our home-grown `_LazyTTLCache` for that
  specific use case).
- The existing `useUrlParam`/`useSetUrlParams` hooks for state.

## Phase 2: pluggable cache backend (flask_caching)

### Wrap the existing cache instances

`cave_data_viewer/api/caches.py` currently exposes three
`_LazyTTLCache` instances. Replace with a single `flask_caching.Cache`
configured per env:

```python
# api/__init__.py
from flask_caching import Cache
cache = Cache()

def create_app(...):
    app = Flask(...)
    cache.init_app(app, config={
        "CACHE_TYPE": app.config.get("CACHE_TYPE", "SimpleCache"),
        "CACHE_REDIS_URL": app.config.get("CACHE_REDIS_URL"),
        "CACHE_DEFAULT_TIMEOUT": 0,  # we set TTLs explicitly per call
    })
    ...
```

```python
# api/caches.py
from .. import cache

def query_get(key): return cache.get(f"query:{key}")
def query_set(key, value, ttl): cache.set(f"query:{key}", value, timeout=ttl)
# ... mirroring for table_meta:, unique_values:
```

Each former `_LazyTTLCache` becomes a key-prefix discipline ("query:",
"table_meta:", "unique_values:") in a single shared backend. Per-call
TTL stays — we pass it on `cache.set`.

`CACHE_TYPE` env vars:
- Dev (single pod, fast iteration): `SimpleCache` (in-process dict). Same
  as today.
- Prod (multi-pod or pre-emption-resistant): `RedisCache` with
  `CACHE_REDIS_URL` from a Secret.

### SWR cache adaptation

`services/swr.py` is more than a key/value store — it's a state
machine over `(fetched_at, minted_at, value)` triples. Keep the
state-machine logic, swap its storage primitive to flask_caching:

```python
class SwrCache:
    def __init__(self, prefix: str): self.prefix = prefix
    def _key(self, k): return f"{self.prefix}:{k}"
    def get_entry(self, k): return cache.get(self._key(k))
    def set_entry(self, k, entry, ttl): cache.set(self._key(k), entry, timeout=ttl)
    # freshness, ticket logic stays unchanged
```

Sticky-session ingress remains the simple operational path; Redis is the
"go horizontally" lever, opt-in via env. Both work without code change
once the backend is pluggable.

### Files (Phase 2)

- `cave_data_viewer/api/__init__.py` (init `flask_caching.Cache`)
- `cave_data_viewer/api/caches.py` (wrap as prefix-namespaced
  helpers)
- `cave_data_viewer/api/services/swr.py` (SWR storage swap)
- `cave_data_viewer/api/config.py` (`CACHE_TYPE`,
  `CACHE_REDIS_URL` defaults)
- `pyproject.toml` (`flask-caching` dep; `redis` extra for prod)

Reuses:
- The TTL config keys already in `config.py` (`CACHE_*_TTL_SECONDS`) —
  per-call TTLs continue to come from those.
- All callers of the current cache instances; the public API of
  `caches.py` stays mostly the same (just `get`/`set` methods on
  prefix-namespaced facades).

## Verification

### Phase 1
1. Boot dev with `CDV_DEV_AUTH_BYPASS=1`. `GET /api/v1/datastacks` returns
   the public list.
2. Drop a non-bundled YAML into `CDV_DATASTACK_CONFIG_DIR/<custom>.yaml`
   with only `spatial.transform`. Visit `?ds=<custom>` — bundle works,
   spatial features work, no error from missing other fields.
3. Visit `?ds=<custom-no-yaml>` (a real CAVE datastack but with no YAML)
   — bundle works, spatial features absent, no error.
4. Toggle a YAML field at runtime (e.g. add a layer_boundaries to an
   existing datastack); since `load_datastack_config` is mtime-keyed,
   no restart needed.
5. Frontend: cold load with no token → empty dropdown + Sign-in CTA.
   Deep-link `?ds=minnie65_public&root=...` works without sign-in
   (public datastack). Deep-link to a private datastack → CAVE 401 →
   Sign-in CTA in the neuron view.

### Phase 2
1. Default `CACHE_TYPE=SimpleCache` — behavior identical to today.
2. Set `CACHE_TYPE=RedisCache` + `CACHE_REDIS_URL=redis://localhost:6379`
   against a local Redis. Two pods (separate processes) share cached
   data; observe second-request latency across pods.
3. Restart one pod: cached data persists in Redis. Without Redis
   (SimpleCache) the cache cold-starts as expected.
4. Pre-emption simulation: `kill -9` the worker, verify the parent
   respawns and serves immediately from Redis (when configured).

### Type check & smoke
`cd frontend && npx tsc -b` clean. `uv run python -c "from
cave_data_viewer.api import create_app; create_app()"` boots
without YAML when `CDV_DATASTACK_CONFIG_DIR` is empty.

## Deferred to follow-up: deployment infrastructure

This wave intentionally stops at the application layer. The Helm chart
+ Terragrunt module land in a separate PR once Phase 1+2 are exercised
locally. Sketch of what that follow-up will contain:

Likely lives in a separate deployments repo (Tourguide ships only
`Dockerfile`, `cloudbuild.yaml`, `gunicorn.conf.py` from the app repo;
the Helm/Terragrunt manifests are elsewhere). Mirror that split.

### Cloud Build (`cloudbuild.yaml` in this repo)
- Mirror Tourguide's pattern: build, tag, push the app image. One
  image — no metrics sidecar.
- Build secrets (Docker Hub user/pass) from Google Secret Manager via
  `availableSecrets.secretManager` — same shape Tourguide uses.

### Dockerfile (in this repo)
- `uv sync --frozen --no-default-groups` two-stage build, exactly like
  Tourguide. Final image is `python:3.12-slim-bookworm` + the venv +
  the package, `CMD ["gunicorn", "run:app"]`.

### gunicorn.conf.py (in this repo)
- Baseline: `workers=2, threads=4, worker_class=gthread,
  graceful_timeout=90, keepalive=10, forwarded_allow_ips="*"`. No
  multiprocess prometheus collector hooks.

### Helm chart (separate repo, mirror project conventions)
- Backend Deployment (Flask app via gunicorn).
- Frontend Deployment (nginx serving the built SPA, separate from
  backend pods).
- Service + Ingress (sticky sessions enabled — the SWR ticket flow
  needs them).
- ConfigMap mounted at `CDV_DATASTACK_CONFIG_DIR` for operator
  overrides (spatial + policy YAML).
- **No Secret manifest for CAVE access.** Confirmed via Tourguide. The
  user's token rides middle-auth-client's cookie, lands on
  `flask.g.auth_token`, gets passed to `CAVEclient(auth_token=...)`
  per-request. The deployment never holds a CAVE token. The existing
  `CDV_WARMUP_AUTH_TOKEN` env var becomes unused once the warmer
  shifts to user-trigger-driven (the user's own token does the work).
- ExternalSecret only for `CACHE_REDIS_URL` (when Redis is in play).
- HPA disabled by default (vertical autoscaling preferred); VPA in
  recommendation mode initially. VPA reads kubelet stats directly —
  no Prometheus dependency.
- Cloud Logging ingests gunicorn / loguru JSON output; build a
  log-based metric or two if dashboarding is needed.

### Terragrunt module (separate repo)
- GKE node-pool config (pre-emptible).
- Workload Identity binding (only if Memorystore or other Google
  resources are reached from the pod — for Redis cache scaling, yes;
  for CAVE alone, no).
- Optional Memorystore Redis instance.
- DNS + cert-manager wiring per environment.

### Periodic warmer — re-shape, don't remove

The current `PeriodicWarmer` is timer-driven (every N minutes, fetch
the configured tables). Better fit for this app: trigger warming on
**first user interaction with a datastack** — when the SPA picks a
datastack (deep-link or dropdown), it pings a `POST /datastacks/<ds>/warm`
endpoint that kicks off a background fetch of the cell-type universe
+ decoration tables for that ds. Fire-and-forget; the response is 202
immediately. By the time the user starts brushing plots, caches are
warm.

Keep the current periodic-warmer machinery in `services/warmup.py` but
*don't* schedule it from `create_app()` anymore. The fetch helpers
inside it are the reusable bits; the timer driver gets replaced with
the trigger-driven path.

**Defer the actual rewrite.** The existing periodic timer works today.
Worth re-shaping when we've measured cold-start cost in production;
over-optimizing now is premature. Phase 1+2 leave it as-is.

### Operational

- Liveness probe: `/api/v1/health` (exists / minimal).
- Readiness probe: `/api/v1/health/ready` (verifies CAVE global address
  reachable + cache backend reachable).
- Structured logging (JSON) via loguru → Cloud Logging.
- Pre-emption signal handler: graceful shutdown on SIGTERM, drain
  in-flight requests for the configured `graceful_timeout`.

## Out of scope for this plan

- Plot template overrides per datastack (`CDV_PLOT_TEMPLATE_DIR` is
  global today). Revisit when a real datastack-specific preset need
  appears.
- The synapse-depth-profile work in progress (a separate parallel
  feature). Both can land independently.
- Multi-region failover, observability dashboards, on-call runbooks —
  ops-team concerns separate from this app's plan.
- A "datastack admin UI" for operators to edit YAML overrides through
  the SPA. Operators edit ConfigMaps via the deploy pipeline for now.
- A Prometheus / metrics stack. Skipping unless a need surfaces.
