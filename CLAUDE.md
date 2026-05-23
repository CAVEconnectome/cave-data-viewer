# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Flask API + React/TypeScript SPA for browsing CAVE (Connectome Annotation Versioning Engine) connectivity. The legacy three-Dash-app layout (`connectivity_table` / `cell_type_table` / `cell_type_connectivity`) was replaced by a single workspace SPA backed by one API service.

- `cave_data_viewer/api/` — Flask backend.
- `frontend/` — Vite + React + TypeScript SPA.

The package name `cave_data_viewer` is historical; the runtime no longer depends on Dash.

## Running

```bash
# Backend (uv-managed; auto-discovers CDV_DATASTACK_CONFIG_DIR for datastack YAMLs).
# AirPlay squats on port 5000 — use 5001 locally.
CDV_DEV_AUTH_BYPASS=1 CDV_PORT=5001 uv run python run_api.py

# Frontend
cd frontend
npm install
npm run dev      # vite dev server
npm run build    # tsc -b && vite build
```

`CDV_DEV_AUTH_BYPASS=1` skips middle-auth-client so a local dev environment doesn't need a CAVE token in cookies; production must run without it. Datastack and aligned-volume YAMLs live in the top-level `config/` directory (`config/datastacks/`, `config/aligned_volumes/`) — bundled into the wheel via hatchling `force-include`, with `CDV_DATASTACK_CONFIG_DIR` / `CDV_ALIGNED_VOLUME_CONFIG_DIR` for deployment overrides.

## Testing

```bash
uv run pytest             # backend — pytest, tests/ directory
cd frontend && npm test   # frontend — Vitest (test:watch for watch mode)
```

Both suites are pure unit tests — no CAVE, network, or GCS access (fake
clients and monkeypatched primitives throughout) — so they run fast and
offline. CI runs the same two commands via `.github/workflows/tests.yml`;
there is intentionally no CI-only test behavior.

Coverage is partial and concentrates on the layers where bugs are subtle
and expensive: the caching / stale-while-revalidate machinery, per-datastack
config loading, and the cell_id↔root_id resolver + recipe adapters that form
the interface between the connectivity (`/neuron`) and feature-explorer
(`/explore`) halves of the app. Feature-level verification is still a
browser pass: start the API + SPA and exercise it against `minnie65_public`.

## Design rules

Project-level rules that aren't obvious from the code. Following them
keeps future changes coherent.

**Persistence.** URLs and saved recipes are the only mechanisms that
carry cross-session continuity. **Never** add a localStorage auto-restore
of view state — sessionStorage for within-tab cross-route handoffs is the
only allowed extra. (`cdv:hidden_cols` / `cdv:shown_cols` are pre-existing
exceptions for column-visibility preferences; don't add more.)

**No wire-compat shims.** There are no deployed older-schema clients —
remove vestigial fields, aliases, and "kept for older versions" comments
outright. The reservation entries in `_KNOWN_FIELDS` are the one
exception: a small forward-compat allowlist for fields a future client
might write, not a back-compat shim for old ones.

**Connectivity + feature explorer are co-equal.** The two halves aren't
core-vs-secondary — feature-space identification of cells leads into
connectivity inspection and vice versa. Design the shared bridge cleanly
(seed linking, the cell_id↔root_id resolver, cross-nav), don't isolate
the explorer.

**Identity boundary.** Features are keyed by stable `cell_id`. `root_id`s
appear only at cross-navigation boundaries via
`services/embeddings/resolver.py`. Inside explorer data paths
(`/points`, `/column`, `/distance_to_set`), cell_ids only.

**`/neuron` stays minimal.** New modal / rich-interaction surfaces belong
in `/explore`. `/neuron` gets cross-nav *links* to /explore, not embedded
modes.

**Filter Scope vs Selection.** Distinct concepts: Filter Scope defines
the active set; Selection is a stable bag of cell_ids accumulated by the
user (lasso, table checkboxes, Cell-ID Search). They intersect at render
time. **Filter changes must never destroy the Selection bag.**

**Connectivity metric conventions.** Expose directional in/out primitives
plus the YAML-configured aggregation rules. "Net" is always a sum, never
out-minus-in. Don't invent derived columns.

**Seed-driven derivation.** For synthetic columns derivable from
server-cached data, use a URL seed param + on-demand projection — never a
client-posted value bag.

**Intentional abstractions** (don't flag as premature in reviews):

- The spatial provider protocol (`services/spatial/`) has one concrete
  implementation (`cortex.py`) today, but it's deliberate runway for a
  second, richer provider expected within months.
- `frontend/src/plots/registry.ts`'s `plotRegistry` is intentionally
  empty: every plot today is user-configured via "+ Add plot," but the
  static / column-bound branches in `AnalyticsRail` are kept for future
  "panels that should always mount" (e.g. a fixed cortical-depth plot for
  cortex datastacks).

## When modifying

A grepable index from "I'm touching X" to "read Y first." Each pointer
references a section in this file.

- **`services/decoration.py` / `services/swr.py` / `services/object_store.py`**
  → Caching strategy section. SWR ticket-readiness invariants and the
  late-binding closure rule are easy to break;
  `tests/test_revalidation_closure_binding.py` is the lint-style guard.
- **`services/embeddings/resolver.py`, cell_id↔root_id at any cross-nav**
  → Design rules: Identity boundary. Features stay in cell_id space; only
  the resolver crosses.
- **`frontend/src/tours/adapters/explorerAdapter.ts`, explorer URL state**
  → The `EXPLORER_FIELDS` descriptor table is the source of truth. The
  round-trip tests in `frontend/src/tours/adapters/adapters.test.ts` lock
  the contract.
- **Frontend URL state with 2+ keys**
  → `hooks/useUrlState.ts::useSetUrlParams`. Chained `setSearchParams`
  calls race because react-router v6 reads at call time.
- **`services/neuron.py`, connectivity metric columns**
  → Design rules: Connectivity metric conventions. In/out primitives;
  "net" = sum.
- **`config/datastacks/*.yaml`**
  → Per-datastack YAML config section. `uv run cdv-check-config` validates.
- **Recipe schema (any field on either kind)**
  → `services/recipes.py` (backend storage + caps) and `tours/adapters/`
  (frontend round-trip). Design rule: no wire-compat shims.
- **Anything that looks like dead code in `services/spatial/` or
  `plots/registry.ts`**
  → Design rules: Intentional abstractions. Don't cut.

## Architecture

### Backend: `cave_data_viewer/api/`

`create_app()` in `api/__init__.py` builds a Flask app with:
- `middle_auth_client` decorators (Tourguide-pattern) on every endpoint, except when `CDV_DEV_AUTH_BYPASS=1`
- a custom `NumpyJSONProvider` that handles numpy scalars and `pd.NA` (a `pd.NA → None` rule was added because pandas nullable dtypes leak into JSON otherwise)
- per-pod in-process caches (`api/caches.py`); horizontal scaling expects sticky-session ingress for the synapse cache and a `PeriodicWarmer` for reference tables (see `services/warmup.py`)

Endpoints live in `api/endpoints/`:
- `datastacks.py` — datastack list, info, materialization versions, table list (live → tables only; materialized → tables + views, merged into one list)
- `connectivity.py` — `/connectivity` is the workhorse: returns `partners_in` + `partners_out` joined with optional decoration tables in one call
- `decorations.py` — `/decorations/poll` for stale-while-revalidate ticket completion
- `cell_ids.py` — bidirectional `cell_id ↔ root_id` lookup
- `links.py` — Neuroglancer state generation; reads `templates/links/*.yaml` (one template per link "kind": `inputs`, `outputs`, `connectivity`)
- `plots.py` — server-side Plotly figure generation; reads `templates/plots/*.yaml` (PlotSpec)
- `table_rows.py` — generic table/view paginated reads

Services in `api/services/` are the orchestration layer: `neuron.py` builds the connectivity bundle, `decoration.py` glues the SWR cache to the per-table queries, `links.py` materializes Neuroglancer state via `nglui.statebuilder`, `plots.py` resolves a PlotSpec into a Plotly figure JSON.

### Per-datastack YAML config

`config/datastacks/<datastack>.yaml` overrides synapse columns, aggregation rules, position-column prefix, cell-id lookup tables/views, and warmup behavior. Loaded via `services/datastack_config.py`, which checks the repo-root `config/` (source installs), the in-wheel `_bundled_config/` (wheel installs), then `CDV_DATASTACK_CONFIG_DIR` (last-wins override). Adding a new dataset means dropping a YAML in `config/datastacks/`.

### Caching strategy (`api/caches.py` + `services/swr.py`)

- Stale-while-revalidate cache keyed by `(ds, mat_version, table)` for decoration data; the API returns stale data immediately + a poll ticket, the SPA polls `/decorations/poll` until fresh.
- Two ticket-readiness invariants worth remembering: (1) **freshness ≠ readiness** — readiness is `fetched_at >= minted_at`, not `freshness == "fresh"`; (2) revalidation closures must default-arg-capture all variables they reference, otherwise the cache reassign in the outer scope poisons every in-flight closure (this is the late-binding bug from phase c).
- `PeriodicWarmer` warms reference tables; `startup_delay_seconds` matters for K8s autoscaling — without it a scaling burst thunders the herd into CAVE.
- **Optional GCS L2 cache** (`services/object_store.py` + `services/swr.py:LayeredSwrCache`). When `CDV_GCS_CACHE_BUCKET` is set, three decoration mat caches (`cell_type_mat`, `num_soma_mat`, `table_decorations_mat`) and the synapse-df `query_cache` persist to GCS. The warmer becomes a single-writer; cold pods promote L2 entries to L1 with the **original `fetched_at` preserved** (via `SwrCache.set_with_timestamp`) so freshness still reflects the CAVE query time, not the GCS read time. Synapse L2 uses a separate `dcv_l2_writer` `ThreadPoolExecutor` (not `RevalidationExecutor`) — synapse writes need no app context or per-key dedup. With L2 in place, sticky-session ingress is a soft optimization (synapse/spatial caches still benefit) rather than load-bearing for decorations: a pod loss mid-render now costs ~30ms × 2 GCS reads instead of multi-second CAVE refetches. Bucket lifecycle rule of ~7 days handles housekeeping; per-entry TTL is enforced in-app via `fetched_at`.

### CAVEclient interaction

- Use `make_client_with_token()` / `make_client_anonymous(reason=...)` / `request_client()` from `api/cave.py`. **Never** call `CAVEclient(auth_token=None)` directly — silent fallback to `~/.cloudvolume/secrets/cave-secret.json` is a defense-in-depth hole.
- Live mode and materialized mode are distinct: `qf.live_query(timestamp, ...)` vs `qf.query(...)` are different methods with different signatures. Don't infer mode from `client.materialize.version`; track it via the request's `mat_version` query param.
- Views are unavailable in live mode and have no `live_query`. Enumerate via `get_tables()` / `get_views()`, not `list(client.materialize.tables)` (the latter raises a `TypeError` because the iterator yields ints, not strings).
- `caveclient` and `nglui` move ahead of installed versions — when checking API surface, look at the upstream master, not the installed copy.

### Frontend: `frontend/`

Vite + React 18 + TypeScript + react-router v6 + TanStack Query + TanStack Table v8. `react-plotly.js` + `plotly.js-cartesian-dist-min` are lazy-imported (`PlotPanel.tsx`) so the ~2MB plotly chunk only loads when a user actually views a plot.

Key conventions:
- **URL-first state**: every meaningful selection (`?ds`, `?mv`, `?root`, `?dec`, `?from` for breadcrumb origin, `?viz_<plot_id>` per column-bound plot, `?ct` for cell-type filter on table views) is in the URL. Sharing a link reproduces the view exactly. The `useSetUrlParams()` batch helper in `hooks/useUrlState.ts` is the right tool for two-or-more-key updates — react-router v6's `setSearchParams` reads at *call* time, so chained calls race.
- **Root IDs are strings end-to-end**. They exceed JS Number precision (2^53). The backend serializes them as JSON strings; the SPA never calls `Number()` on a root id.
- **Plot registry**: `frontend/src/plots/registry.ts` is the source of truth for the analytics rail. Adding a plot = appending a `PlotDescriptor` and dropping a YAML in `templates/plots/`. Static and column-bound variants are supported; column-bound plots auto-pick `barSpec` vs `histogramSpec` based on the chosen column's inferred kind.
- **Decoration is a parameter, not a page**. The SPA is one workspace with cross-navigation between tables ↔ neurons ↔ partners; cell-type filtering is a URL parameter, never a separate route.
- **Hidden columns** persist in `localStorage` under `cdv:hidden_cols` (user-hidden) + `cdv:shown_cols` (user-shown overrides for default-hidden columns, used by the Both partner-tab's directional aggregation columns).

### Connectomics-specific design notes

- The **Both** partner tab (unified view with `n_syn_out` + `n_syn_in` columns) is uniquely useful for reciprocal-pair analysis: filter `n_syn_in > 0` AND `n_syn_out > 0` to find reciprocal partners. Don't drop it in favor of the conventional dashboard advice of "keep populations separate" — the empirical workflow argument wins for connectomics.
- For "live" Neuroglancer links, the supervoxel-id-in-annotation-segments trick keeps links correct across proofreading; segment ids that come back from CAVE are root ids, but the chunkedgraph lookup happens in the viewer.

## Versioning

Driven by `bump-my-version` (`uv run bump-my-version`); `pyproject.toml` is the single source of truth, mirrored in `cave_data_viewer/__init__.py`.

```bash
uv run bump-my-version bump patch   # or minor / major; tags + commits
```
