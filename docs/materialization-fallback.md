# Materialization fallback (live-at-timestamp)

A future implementation plan. Not yet built.

## Context

Materialized versions in CAVE get pruned on a retention schedule. A user
who shares `/neuron?ds=minnie65_phase3_v1&mv=1718&...` with a colleague
hits a broken link the moment v1718 is dropped: the SPA passes the int
version to `/connectivity`, the backend asks
`client.materialize.tables[...](pt_root_id=...)` against a version that
no longer exists, and the request fails.

The data the user wants isn't lost, though — CAVE retains live-queryable
state forever, and `qf.live_query(timestamp=...)` against the original
freeze time of v1718 returns *exactly* what `qf.query()` would have
returned at that version. The only thing missing is a server-side path
that recognizes "this int version is gone, but I know its timestamp,
fall back to live."

Worth doing because:

- **Shared links survive long after the materialization horizon.** Today
  a slide deck or Slack message linking to a specific cell silently rots
  in 30–60 days. With the fallback, the link works as long as the
  underlying CAVE proofreading state is reachable.
- **The cache invariant holds.** The result of `live_query(ts=T)` is
  deterministic for a given T, so the L1+L2 cache can hold these
  responses keyed by the same integer version that was originally
  requested. No new key shape, no GCS path drift, no operator
  cache-bust at deploy time.

## Design (high level)

Today, `is_live(mat_version)` does double duty: it's both "use
`live_query()` instead of `materialize.query`" and "skip the cache."
That conflation is fine for `mv="live"` but blocks the fake-mat path
where we want one but not the other.

Resolution: the **request resolves the materialization mode at the
endpoint**, not deep inside `NeuronQuery`. Three modes:

| Mode | Triggered by | CAVE call | Cache? |
| --- | --- | --- | --- |
| `MATERIALIZED` | `mv=int` and version is in `get_versions_metadata()` | `qf.query(...)` | yes, key includes int version |
| `LIVE_AT_TIMESTAMP` | `mv=int` and version is NOT in `get_versions_metadata()` (pruned) | `qf.live_query(timestamp=<freeze_ts>, ...)` | **yes**, key still includes int version (deterministic for that ts) |
| `LIVE_NOW` | `mv="live"` (or unset) | `qf.live_query(timestamp=<request_now>, ...)` | no, key is None |

The new mode is the middle row. It uses live machinery for the CAVE call
but is treated as materialized by every cache layer.

## Touch points

### `services/keys.py`

Today:
```python
def is_live(mat_version) -> bool:
    return mat_version in (None, "", "live")
```

Add a sibling predicate that splits the dispatch from the cache decision:

```python
def pin_timestamp(mat_version, materialization_exists: bool) -> bool:
    """True when the CAVE call must use `live_query(timestamp=...)`.
    Distinct from `is_live` because a fake-materialization request
    pins a timestamp but is otherwise cacheable.
    """
    return is_live(mat_version) or not materialization_exists
```

Or — cleaner — replace `is_live` calls inside neuron.py / decoration.py
with checks on the `materialization_exists` flag the request sets, and
keep `is_live` only for the cache-skip decision.

### `services/neuron.py:NeuronQuery`

Constructor gains a `materialization_exists: bool = True` parameter
(default keeps today's behavior for any caller that doesn't pass it).
Stored on `self`. `_cache_key` doesn't change — already keyed by the
int `mat_version`, which stays correct in all three modes.

The synapse fetch's `live=` flag flips:

```python
# Today:
df = run_query(qf, live=is_live(self.mat_version), timestamp=...)
# Future:
df = run_query(qf, live=pin_timestamp(self.mat_version, self.materialization_exists),
               timestamp=...)
```

Same for `soma_summary` and any other CAVE call inside NeuronQuery.

The `timestamp_for_consistency` field needs to widen too: today it's set
from `current_timestamp()` (the request's pinned now-time) only when
`is_live(mat_version)`. In `LIVE_AT_TIMESTAMP` mode, it should be the
**version's freeze timestamp**, not now. Probably cleanest to pass it in
as an explicit constructor arg and let the endpoint compute it via
`version_timestamp(client, mat_version)`.

### `services/decoration.py`

Same pattern — every site that does `is_live(mat_version)` to choose
between `qf.query()` and `qf.live_query(timestamp=...)` becomes a
check against the request's resolved mode. The `cache_for(kind, live)`
dispatcher (decoration.py:112) needs to know: in `LIVE_AT_TIMESTAMP`
mode, use the **mat** caches (`*_mat`), not the live caches. So
`cache_for` takes the mode, not just a bool.

Concretely the dispatcher becomes:

```python
def cache_for(self, kind, mode):  # mode in {"materialized", "live_at_ts", "live_now"}
    cache_set = "live" if mode == "live_now" else "mat"
    return getattr(self, f"{kind}_{cache_set}")
```

That's the seam where the fake-mat request slots into L1+L2 just like a
real materialized one.

### Endpoint resolution

At the top of each cave-touching endpoint (connectivity, plots, links,
table_rows), after constructing the client:

```python
mat_version = parse_int_or_live(request.args.get("mat_version"))

if is_live(mat_version):
    materialization_exists = False  # but the mode is LIVE_NOW, not LIVE_AT_TIMESTAMP
    timestamp = current_timestamp()  # pinned per-request
else:
    versions = client.materialize.get_versions_metadata()
    materialization_exists = any(int(v["version"]) == mat_version for v in versions)
    timestamp = (
        None
        if materialization_exists
        else version_timestamp(client, mat_version)
    )
    if not materialization_exists and timestamp is None:
        raise ApiError(410, "version_unrecoverable",
                       f"Materialized version {mat_version} not found and "
                       "no freeze timestamp available — link is unrecoverable.")
```

`version_timestamp(client, mat_version)` already exists in
`services/datastack_config.py:516` and reads
`client.materialize.get_versions_metadata()`'s `time_stamp` field.

### SPA-side changes

Probably zero. The SPA continues passing `?mv=1718` as today. The
backend transparently falls back. A small UX improvement worth adding
later: surface a `version_disposition` field in the bundle response
(`materialized` / `live_at_timestamp`) so the SPA can render a subtle
"this version has been archived; serving from snapshot" badge. Not a
functional requirement.

## Metadata retention (confirmed)

`client.materialize.get_versions_metadata()` returns entries for **all
historical versions**, including those whose underlying data has been
pruned. The `time_stamp` field stays available on every entry forever,
so the freeze timestamp lookup works without any operator-side archive.

This is the load-bearing assumption that keeps the cache key invariant
clean (same int version → same hash → same GCS path across the
materialized and live-at-timestamp modes).

If this assumption ever changes upstream, the recovery is to build a
local `version → timestamp` snapshot store, sourced from periodic dumps
of `get_versions_metadata()`. The endpoint resolver would then check
local store first, fall back to CAVE. Not needed today.

## Test approach

- **Unit**: mock CAVE responses to drive each of the three modes through
  `NeuronQuery._synapse_df` and assert the right CAVE method is called
  with the right timestamp, and that the cache key matches the
  materialized case for `LIVE_AT_TIMESTAMP`.
- **Integration (manual)**: reproduce the broken-link scenario by
  setting up a request with a known-pruned version, observe the bundle
  comes back populated, observe the L2 cache writes happen with the
  same key shape as a real materialized request would have produced.
- **Cache shadow check**: a cached entry for `mv=1718` written under
  `LIVE_AT_TIMESTAMP` mode must be readable in `MATERIALIZED` mode if
  v1718 is later restored. Same key → same hit. Test by toggling the
  resolver's mode mid-test and asserting the read.

## What this plan deliberately does NOT change

- Cache key shape — already keyed by int `mat_version`; covers both the
  materialized and the live-at-timestamp cases without touching
  `_cache_key` or the GCS object paths.
- GCS L2 lifecycle rules — same retention applies.
- Existing materialized requests — pure additive code path; default
  values keep today's behavior intact for any caller that doesn't pass
  `materialization_exists`.
- The `LIVE_NOW` skip-cache path — stays as today.

## Estimated effort

About a half-day. Seam is clean, cache layer doesn't move, no operator
archive needed since CAVE retains the version metadata.
