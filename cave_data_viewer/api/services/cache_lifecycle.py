"""Cache-lifecycle helpers: datastack aliasing + retention class lookup.

Both helpers are consulted at every cache-key construction site, so the
discipline is "if you're touching the cache, you go through here."
That makes adding a new datastack alias or changing the retention
policy a single-edit operation, not a hunt across the codebase.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .datastack_config import load_datastack_config

if TYPE_CHECKING:
    from .longlived_registry import LonglivedRegistry


def cache_datastack(datastack: str) -> str:
    """Resolve a datastack to its cache namespace.

    When per-datastack YAML sets ``cache_alias: <other_ds>``, every cache
    lookup, write, and marker-file read for `datastack` redirects to
    `<other_ds>`. When unset, returns the datastack as-is (today's
    behavior).

    Use case: ``minnie65_public`` is a view of ``minnie65_phase3_v1``
    filtered to long-lived materializations; their cache values for
    shared `(mat_version, root_id, ...)` tuples are identical, so the
    bucket should hold one copy. Setting `cache_alias` redirects
    ``minnie65_public``'s cache traffic without changing the CAVE call
    routing or any other behavior.

    Single source of truth for the alias is `load_datastack_config`,
    which is mtime-cached, so an alias edit propagates to a running pod
    on next request without a restart.
    """
    try:
        cfg = load_datastack_config(datastack)
    except Exception:
        # Defensive: a malformed YAML or missing-file failure should
        # degrade to "no alias" rather than break every cache lookup.
        return datastack
    return cfg.cache_alias or datastack


def retention_class_for(
    registry: "LonglivedRegistry",
    datastack: str,
    mat_version,
) -> str:
    """Return ``"longlived"`` if `mat_version` is in the registry's set
    for this datastack's *cache namespace* (post-alias);
    ``"default"`` otherwise.

    Live mode never gets here because live cache entries skip L2
    entirely (`NeuronQuery._cache_key` returns None for live, the SWR
    `*_live` caches are plain SwrCache). Non-int `mat_version` (e.g.
    "live", malformed strings) falls through to "default" defensively.
    """
    try:
        v = int(mat_version)
    except (TypeError, ValueError):
        return "default"
    cache_ds = cache_datastack(datastack)
    return "longlived" if v in registry.longlived_set(cache_ds) else "default"
