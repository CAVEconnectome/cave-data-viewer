"""In-process TTL caches for CAVE-derived data.

Architecture note (Redis-readiness): every cache here goes through a
`_LazyTTLCache` instance with a pluggable `CacheSerializer`. Today the
default serializer is `IdentitySerializer` (pass-through, zero-cost) and
the storage is `cachetools.TTLCache` (in-process). When we migrate to
Redis, the swap is two-piece:

  1. Replace `cachetools.TTLCache` with a Redis-backed dict-like in
     `_LazyTTLCache._resolve()`.
  2. Switch the default serializer to `PickleSerializer` so values
     cross the wire as bytes.

Until then, setting `CDV_CACHE_SERIALIZE=pickle` flips every named
cache to pickle-on-set / unpickle-on-get for one-time validation that
the cached values round-trip cleanly through pickle. Run the app with
this flag, exercise the typical request flow, and confirm there are no
`PicklingError` / `TypeError` blowups before committing to the Redis
migration.
"""

from __future__ import annotations

import json
import logging
import os
import pickle
from abc import ABC, abstractmethod
from typing import Any

from cachetools import TTLCache
from flask import current_app


logger = logging.getLogger("cdv.cache")


# --- serializers --------------------------------------------------------------


class CacheSerializer(ABC):
    """Round-trip strategy for cached values.

    `dumps` produces whatever the storage layer accepts (bytes for Redis,
    arbitrary objects for an in-process dict); `loads` reverses it. The
    storage layer is opaque to the cache user — the only contract is that
    `loads(dumps(x)) == x` (value equality, not identity).
    """

    @abstractmethod
    def dumps(self, value: Any) -> Any: ...

    @abstractmethod
    def loads(self, data: Any) -> Any: ...


class IdentitySerializer(CacheSerializer):
    """Pass-through. Zero overhead — values are stored as live Python
    objects and returned by reference. Default for the in-process
    `cachetools.TTLCache` backend; preserves the current per-request
    cache-hit cost (microseconds).
    """

    def dumps(self, value: Any) -> Any:
        return value

    def loads(self, data: Any) -> Any:
        return data


class PickleSerializer(CacheSerializer):
    """Pickle-based serializer. Use when the storage layer requires bytes
    (Redis). Pickle protocol 5 supports DataFrames, numpy arrays, and
    most Python built-ins natively without extra hooks.

    Trusted-cache convention: pickle is fine for an in-cluster cache
    whose contents we control end-to-end. If the cache ever grows a
    cross-organization or untrusted writer, switch to a safer codec
    (msgpack, JSON+arrow) before that point.
    """

    def __init__(self, protocol: int = 5) -> None:
        self.protocol = protocol

    def dumps(self, value: Any) -> bytes:
        return pickle.dumps(value, protocol=self.protocol)

    def loads(self, data: bytes) -> Any:
        return pickle.loads(data)


# --- env-driven default selection --------------------------------------------


def _default_serializer() -> CacheSerializer:
    """Choose the global default based on `CDV_CACHE_SERIALIZE` env var.

    Values:
      - unset / "" / "identity"  → IdentitySerializer (today's behavior)
      - "pickle"                 → PickleSerializer (Redis-equivalent path)

    The env var is process-wide because the default applies at module
    import time. Per-cache override is still available via the
    `serializer=` constructor arg.
    """
    flavor = os.environ.get("CDV_CACHE_SERIALIZE", "").strip().lower()
    if flavor == "pickle":
        return PickleSerializer()
    if flavor in ("", "identity"):
        return IdentitySerializer()
    raise ValueError(
        f"CDV_CACHE_SERIALIZE={flavor!r} unrecognized — "
        f"expected 'identity' or 'pickle'"
    )


_DEFAULT_SERIALIZER: CacheSerializer = _default_serializer()


# --- cache wrapper ------------------------------------------------------------


class _LazyTTLCache:
    """Lazy-init wrapper over `cachetools.TTLCache`. The Flask app config
    isn't readable at import time (`current_app` requires an app
    context); deferring construction until first access lets us read
    `CACHE_*_TTL_SECONDS` from the live app.

    The serializer is applied around every set/get so the wire format
    matches whatever the storage layer expects. Today storage is an
    in-process dict and the default serializer is a no-op, so the
    overhead is zero. With `CDV_CACHE_SERIALIZE=pickle` (or, eventually,
    a Redis backend) every value pickles on set and unpickles on get.
    """

    def __init__(
        self,
        ttl_config_key: str,
        maxsize: int = 1024,
        *,
        serializer: CacheSerializer | None = None,
    ) -> None:
        self.ttl_config_key = ttl_config_key
        self.maxsize = maxsize
        self.serializer: CacheSerializer = serializer or _DEFAULT_SERIALIZER
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
        # Cheap existence check — does NOT attempt to deserialize. A
        # corrupted-on-deploy entry will still pass `key in cache` here,
        # but the subsequent `__getitem__` will detect the deserialize
        # failure, evict, and raise KeyError so the caller's
        # `if/in/getitem` pattern degrades to "cache miss" cleanly. The
        # alternative (deserialize-to-check) would multiply read cost
        # for the worst case nobody asks about.
        return key in self._resolve()

    def __getitem__(self, key):
        cache = self._resolve()
        raw = cache[key]  # may raise KeyError — that's the normal miss path
        try:
            return self.serializer.loads(raw)
        except Exception as exc:
            # Deploy-compat failure: pickle protocol changed, a class
            # moved, a major-version bump on pandas/numpy. Evict the
            # poisoned entry, log it for ops, and degrade to a cache
            # miss. The caller refetches/recomputes the canonical value.
            cache.pop(key, None)
            logger.warning(
                "cache_deserialize_failed key=%r serializer=%s error=%s: %s",
                key, type(self.serializer).__name__, type(exc).__name__, exc,
            )
            raise KeyError(key) from None

    def __setitem__(self, key, value) -> None:
        self._resolve()[key] = self.serializer.dumps(value)

    def pop(self, key, default=None):
        cache = self._resolve()
        if key not in cache:
            return default
        raw = cache.pop(key)
        try:
            return self.serializer.loads(raw)
        except Exception as exc:
            logger.warning(
                "cache_deserialize_failed[pop] key=%r serializer=%s error=%s: %s",
                key, type(self.serializer).__name__, type(exc).__name__, exc,
            )
            return default


def cache_key_with_config(*positional: Any, config_bundle: dict) -> tuple:
    """Build a tuple cache key that includes a stable hash of the response-
    shaping config bundle.

    Caches keyed by `(ds, mat_version, root_id, ...)` are correct only if every
    knob that changes the cached payload is part of the key. Knobs sourced from
    the request body or per-datastack YAML (synapse aggregation rules, position
    prefix, desired resolution, etc.) belong in the key too — but listing them
    by hand is error-prone and a future knob silently leaks a stale-shape hit.

    Pass the inputs as `config_bundle` (a dict of primitives — JSON-dump'd
    deterministically with `sort_keys=True`); the digest enters the key as a
    short BLAKE2b prefix. Identical bundles produce identical digests; one
    extra field flips the key.
    """
    from hashlib import blake2b
    blob = json.dumps(config_bundle, sort_keys=True, default=str, separators=(",", ":")).encode()
    digest = blake2b(blob, digest_size=8).hexdigest()
    return (*positional, digest)


query_cache = _LazyTTLCache("CACHE_QUERY_TTL_SECONDS", maxsize=4096)
table_meta_cache = _LazyTTLCache("CACHE_TABLE_META_TTL_SECONDS", maxsize=512)
# Universe of distinct string values per (ds, mat_version, table). One entry
# holds the entire `get_unique_string_values()` dict for a table; per-column
# slicing happens at the call site. Keyed by (ds, mat_version, table) so a
# single CAVE call answers every column on the table for free.
unique_values_cache = _LazyTTLCache("CACHE_UNIQUE_VALUES_TTL_SECONDS", maxsize=512)
# Per-(ds, mat_version, root_id, provider_identity) spatial-feature payload
# from `compute_spatial_features_cached`: a `CachedSpatialFeatures` carrying
# intrinsic + per-direction features + summary panels. Computing it costs
# ~1.2s for a 5K-synapse neuron in numpy and the result is invariant for a
# given materialized neuron + provider, so caching is safe. Plot panels
# re-fire connectivity-style requests on every binding change; without this
# cache each one paid the full 1.2s. Smaller maxsize than `query_cache`
# because each entry can be a few MB on heavily-connected neurons.
spatial_features_cache = _LazyTTLCache("CACHE_SPATIAL_FEATURES_TTL_SECONDS", maxsize=256)
# Per-(ds, mat_version, root_id) `soma_summary` payload — the single-row
# fetch was costing 200-300ms per plot request because each request spins
# up a fresh NeuronQuery whose memoization is per-instance only.
soma_summary_cache = _LazyTTLCache("CACHE_SOMA_SUMMARY_TTL_SECONDS", maxsize=2048)
