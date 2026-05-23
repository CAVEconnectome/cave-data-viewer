"""In-process L1 TTL cache for CAVE-derived metadata.

Single survivor of the original three-cache module: `table_meta_cache`,
which holds short-lived per-(ds, mv) responses whose values legitimately
shift with mat_version (table list, version metadata) and need TTL
eviction rather than the immutable-data semantics of `LayeredSwrCache`.

Every other CAVE-derived cache moved to `LayeredImmutableCache` /
`ImmutableCache` instances on `app.extensions` — see
`_init_l2_immutable_caches` in `api/__init__.py`. Those carry their own
L1 LRU and an optional GCS L2 layer. Reach for that primitive for any
new cache-able CAVE-derived data; reach for `_LazyTTLCache` only when
the values genuinely need TTL invalidation.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from cachetools import TTLCache
from flask import current_app


logger = logging.getLogger("cdv.cache")


class _LazyTTLCache:
    """Lazy-init wrapper over `cachetools.TTLCache`. The Flask app config
    isn't readable at import time (`current_app` requires an app
    context); deferring construction until first access lets us read
    `CACHE_*_TTL_SECONDS` from the live app.
    """

    def __init__(self, ttl_config_key: str, maxsize: int = 1024) -> None:
        self.ttl_config_key = ttl_config_key
        self.maxsize = maxsize
        self._cache: TTLCache | None = None

    def _resolve(self) -> TTLCache:
        if self._cache is None:
            ttl = current_app.config[self.ttl_config_key]
            self._cache = TTLCache(maxsize=self.maxsize, ttl=ttl)
        return self._cache

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def __contains__(self, key) -> bool:
        return key in self._resolve()

    def __getitem__(self, key):
        return self._resolve()[key]

    def __setitem__(self, key, value) -> None:
        self._resolve()[key] = value

    def pop(self, key, default=None):
        return self._resolve().pop(key, default)


def config_digest(config_bundle: dict) -> str:
    """Stable BLAKE2b-8 digest of a config bundle.

    Used as a cache-key segment so every knob that shapes the cached
    payload (synapse aggregation rules, position prefix, desired
    resolution, …) participates in the key. Identical bundles produce
    identical digests; one extra field flips the key.

    Bundle values must be JSON-serializable primitives (handled via
    ``default=str`` for the few cases — like ``Path`` — that aren't).
    """
    from hashlib import blake2b
    blob = json.dumps(config_bundle, sort_keys=True, default=str, separators=(",", ":")).encode()
    return blake2b(blob, digest_size=8).hexdigest()


def cache_key_with_config(*positional: Any, config_bundle: dict) -> tuple:
    """Build a tuple cache key that includes a stable hash of the response-
    shaping config bundle.

    Thin wrapper over :func:`config_digest` for callers that want the
    key tuple constructed in one call. Reach for ``config_digest``
    directly when the surrounding key is built by an accessor's key
    builder.
    """
    return (*positional, config_digest(config_bundle))


table_meta_cache = _LazyTTLCache("CACHE_TABLE_META_TTL_SECONDS", maxsize=512)
