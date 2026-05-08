import logging
import threading
import time
from typing import Any

from cachetools import LRUCache

from ..caches import CacheSerializer, _DEFAULT_SERIALIZER


logger = logging.getLogger("cdv.cache")


class SwrCache:
    """Stale-while-revalidate cache.

    `get(key)` returns `(value, "fresh"|"stale")` if the entry is within hard TTL,
    `None` if absent or past hard TTL. Stale hits are the caller's signal to
    queue a background revalidation; the cached value is still served immediately.

    Like `_LazyTTLCache`, accepts an optional `CacheSerializer`. The default
    is the process-wide one (identity unless `CDV_CACHE_SERIALIZE=pickle`),
    so the SWR cache is also ready to swap to Redis without touching call
    sites — same two-piece migration as the TTL caches.
    """

    def __init__(
        self,
        *,
        soft_ttl: float,
        hard_ttl: float,
        maxsize: int = 1024,
        serializer: CacheSerializer | None = None,
    ):
        self._cache: LRUCache = LRUCache(maxsize=maxsize)
        self._lock = threading.Lock()
        self.soft_ttl = soft_ttl
        self.hard_ttl = hard_ttl
        self.serializer: CacheSerializer = serializer or _DEFAULT_SERIALIZER

    def _safe_loads(self, key: Any, stored_value: Any) -> tuple[bool, Any]:
        """Try to deserialize. Returns `(ok, value)` — on failure, evicts
        the poisoned entry and logs. Used by both read paths so a
        deploy-compat break (pickle protocol shift, class moved, major
        version bump on a deserialized lib) degrades to a cache miss
        rather than 500-ing every request.
        """
        try:
            return True, self.serializer.loads(stored_value)
        except Exception as exc:
            with self._lock:
                self._cache.pop(key, None)
            logger.warning(
                "swr_deserialize_failed key=%r serializer=%s error=%s: %s",
                key, type(self.serializer).__name__, type(exc).__name__, exc,
            )
            return False, None

    def get(self, key: Any) -> tuple[Any, str] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        stored_value, fetched_at = entry
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        ok, value = self._safe_loads(key, stored_value)
        if not ok:
            return None
        return value, ("fresh" if age <= self.soft_ttl else "stale")

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        """Like `get`, but exposes the absolute `fetched_at` timestamp.

        Used by the poll endpoint to decide whether the cache entry is newer
        than a given ticket — independent of soft/hard TTL state.
        """
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        stored_value, fetched_at = entry
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        ok, value = self._safe_loads(key, stored_value)
        if not ok:
            return None
        return value, fetched_at

    def get_full(self, key: Any) -> tuple[Any, str, float] | None:
        """Combined `get` + `get_with_meta`: returns `(value, freshness,
        fetched_at)` or None. Used by the live-mode delta path in
        `lookup_decorations`, which needs all three: freshness to decide
        whether to schedule a background refresh, and fetched_at to
        compute the get_delta_roots time window for targeted fill-in.
        Saves a second cache read.
        """
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        stored_value, fetched_at = entry
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        ok, value = self._safe_loads(key, stored_value)
        if not ok:
            return None
        return value, ("fresh" if age <= self.soft_ttl else "stale"), fetched_at

    def set(self, key: Any, value: Any) -> None:
        stored = self.serializer.dumps(value)
        with self._lock:
            self._cache[key] = (stored, time.time())

    def set_with_timestamp(self, key: Any, value: Any, fetched_at: float) -> None:
        """Set with an explicit `fetched_at`. Used by `LayeredSwrCache` to
        promote an L2 entry to L1 without resetting freshness — a 3-hour-old
        L2 snapshot must appear 3-hours-old on the new pod (potentially
        stale → schedules revalidation), not freshly minted.
        """
        stored = self.serializer.dumps(value)
        with self._lock:
            self._cache[key] = (stored, fetched_at)

    def __contains__(self, key: Any) -> bool:
        return self.get(key) is not None

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


class LayeredSwrCache:
    """SwrCache + optional GCS L2. Drop-in replacement for `SwrCache`.

    Read path: L1 first → L2 on miss → promote to L1 with the original
    `fetched_at` preserved (so freshness still reflects when CAVE was
    queried, not when this pod read from GCS).

    Write path: L1 synchronously, L2 via the supplied executor as a
    fire-and-forget job. Decoration mat caches use `RevalidationExecutor`
    (per-key dedup, app context); the executor's submit signature is
    `(key, fn)` so we namespace L2 writes under `("gcs_write", cache_key)`
    to avoid colliding with the executor's existing revalidation jobs.

    L2 can be:

    - ``None``: short-circuits to identical `SwrCache` semantics. Used
      when GCS isn't configured.
    - A bare `GcsObjectStore`: today's single-store path. All reads/writes
      go to that store.
    - A ``dict[str, GcsObjectStore]`` keyed by retention class
      (``"default"`` / ``"longlived"``) plus a ``retention_resolver(key)``
      callable. The resolver picks the inner store on every read/write,
      letting one cache instance route to different lifecycle partitions
      based on the key.

    The dict-with-resolver shape is the production path for decoration
    mat caches under retention classes. The bare-store shape is kept for
    backwards compatibility and for tests that don't care about
    retention dispatch.
    """

    def __init__(
        self,
        *,
        soft_ttl: float,
        hard_ttl: float,
        maxsize: int = 1024,
        serializer: CacheSerializer | None = None,
        l2=None,
        executor=None,
        retention_resolver=None,
    ):
        self._l1 = SwrCache(
            soft_ttl=soft_ttl,
            hard_ttl=hard_ttl,
            maxsize=maxsize,
            serializer=serializer,
        )
        self._l2 = l2
        self._executor = executor
        # When L2 is a dict-of-stores, the resolver is required to pick
        # which inner store to read from / write to. When L2 is a bare
        # store (or None), the resolver is unused.
        self._retention_resolver = retention_resolver
        self.soft_ttl = soft_ttl
        self.hard_ttl = hard_ttl

    def _resolve_l2_store(self, key: Any):
        """Return the active L2 store for `key`, or None if no L2 is
        configured. Handles the three l2-shape cases (None, bare,
        dict-with-resolver)."""
        if self._l2 is None:
            return None
        if not isinstance(self._l2, dict):
            return self._l2
        # Dict-of-stores: consult the resolver. Defensive defaulting
        # to "default" if the resolver isn't set or raises — the worst
        # case is that an entry lands in the default partition, which
        # is the "today's behavior" path.
        retention_class = "default"
        if self._retention_resolver is not None:
            try:
                retention_class = self._retention_resolver(key) or "default"
            except Exception as exc:
                logger.warning(
                    "layered_retention_resolver_failed key=%r: %s: %s",
                    key, type(exc).__name__, exc,
                )
        return self._l2.get(retention_class) or self._l2.get("default")

    def _try_l2(self, key: Any) -> bool:
        """Check L2; on a within-TTL hit, promote to L1 preserving the
        original `fetched_at` and return True. Returns False when L2 is
        absent, the entry doesn't exist, or it's past hard_ttl.

        Defense in depth: `GcsObjectStore.get` already swallows internally,
        but we wrap anyway so any future L2 implementation that *does*
        raise still degrades to a miss instead of propagating an error
        through every cache reader.
        """
        store = self._resolve_l2_store(key)
        if store is None:
            return False
        try:
            result = store.get(key)
        except Exception as exc:
            logger.warning(
                "layered_l2_get_failed key=%r: %s: %s",
                key, type(exc).__name__, exc,
            )
            return False
        if result is None:
            return False
        value, fetched_at = result
        if time.time() - fetched_at > self.hard_ttl:
            return False
        self._l1.set_with_timestamp(key, value, fetched_at)
        return True

    def get(self, key: Any) -> tuple[Any, str] | None:
        result = self._l1.get(key)
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get(key)
        return None

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        result = self._l1.get_with_meta(key)
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get_with_meta(key)
        return None

    def get_full(self, key: Any) -> tuple[Any, str, float] | None:
        result = self._l1.get_full(key)
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get_full(key)
        return None

    def set(self, key: Any, value: Any) -> None:
        self._l1.set(key, value)
        store = self._resolve_l2_store(key)
        if store is None:
            return
        fetched_at = time.time()
        executor = self._executor
        if executor is not None:
            # Default-arg-capture every variable — the late-binding bug
            # CLAUDE.md warns about applies here too. The executor key is
            # namespaced so this dedups against itself but not against the
            # decoration revalidation closures sharing the same executor.
            def _write(_store=store, _key=key, _value=value, _ts=fetched_at):
                _store.set(_key, _value, _ts)
            executor.submit(("gcs_write", key), _write)
        else:
            store.set(key, value, fetched_at)

    def __contains__(self, key: Any) -> bool:
        return self._l1.__contains__(key)

    def clear(self) -> None:
        self._l1.clear()
