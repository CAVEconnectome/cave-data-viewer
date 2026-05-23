"""SWR (stale-while-revalidate) and immutable cache primitives.

Two families of cache:

- :class:`SwrCache` / :class:`LayeredSwrCache` — mutable, TTL-gated.
  Suitable for data that changes over time but for which serving slightly
  stale is acceptable while a background revalidation refreshes.

- :class:`ImmutableCache` / :class:`LayeredImmutableCache` — immutable
  by-key. Suitable for data whose key pins enough invariants that any
  hit is bit-identical to a fresh fetch (e.g. ``(ds, mat_version,
  table)`` for materialized snapshots, or ``(ds, ft_id, parquet_uri)``
  for parquet-pinned embedding frames). No soft/hard TTL gating; hits
  always read "fresh"; bucket lifecycle on the L2 layer is the single
  source of L2 expiry.

The L1 storage shape (an ``LRUCache`` keyed by tuple → ``(value,
fetched_at)``) is shared via :class:`_BaseCacheStorage`. The two
families implement their own read-time semantics on top.

The Layered variants compose: ``LayeredSwrCache`` wraps an internal
``SwrCache`` as its L1; ``LayeredImmutableCache`` wraps an internal
``ImmutableCache`` as its L1. Both inherit the L1+L2 read/write fan-out
from :class:`_BaseLayeredCache` and differ only in (a) what TTL gate
applies to L2 entries and (b) which L1 type they instantiate.

The deprecated ``immutable=True`` constructor flag on the old
``SwrCache`` / ``LayeredSwrCache`` raises ``TypeError`` — use the
sibling immutable classes instead.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from cachetools import LRUCache


logger = logging.getLogger("cdv.cache")


_DEPRECATED_IMMUTABLE_FLAG = (
    "{cls_name} no longer accepts immutable=True — use {immutable_name} "
    "for immutable-data semantics. See cave_data_viewer/api/services/swr.py."
)


# ============================================================================
# Shared L1 storage
# ============================================================================


class _BaseCacheStorage:
    """Shared L1 storage for :class:`SwrCache` and :class:`ImmutableCache`.

    Owns the ``LRUCache`` + lock and the write paths (``set`` /
    ``set_with_timestamp``) plus simple membership / clear semantics.
    Read-time methods (``get`` and friends) live on the concrete
    subclasses because their TTL semantics differ.
    """

    def __init__(self, *, maxsize: int):
        self._cache: LRUCache = LRUCache(maxsize=maxsize)
        self._lock = threading.Lock()

    def set(self, key: Any, value: Any) -> None:
        with self._lock:
            self._cache[key] = (value, time.time())

    def set_with_timestamp(self, key: Any, value: Any, fetched_at: float) -> None:
        """Set with an explicit `fetched_at`. Used to promote an L2 entry
        to L1 without resetting freshness — a 3-hour-old L2 snapshot
        must appear 3-hours-old on the new pod (potentially stale →
        schedules revalidation for SwrCache; informational only for
        ImmutableCache), not freshly minted.
        """
        with self._lock:
            self._cache[key] = (value, fetched_at)

    def __contains__(self, key: Any) -> bool:
        # Defers to the subclass's `get` so the TTL gate (SwrCache) or
        # always-fresh shortcut (ImmutableCache) applies correctly.
        return self.get(key) is not None  # type: ignore[attr-defined]

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


# ============================================================================
# Mutable, TTL-gated caches
# ============================================================================


class SwrCache(_BaseCacheStorage):
    """Stale-while-revalidate cache.

    `get(key)` returns ``(value, "fresh"|"stale")`` if the entry is
    within hard TTL, ``None`` if absent or past hard TTL. Stale hits are
    the caller's signal to queue a background revalidation; the cached
    value is still served immediately.

    L1-only — values are stored as live Python objects, no serialization
    overhead. The L2 layer (when present, via :class:`LayeredSwrCache`)
    does its own pickle round-trip in :class:`GcsObjectStore`.

    For data whose key pins enough invariants that any hit is
    bit-identical to a fresh fetch, use :class:`ImmutableCache` instead.
    """

    def __init__(
        self,
        *,
        soft_ttl: float,
        hard_ttl: float,
        maxsize: int = 1024,
        immutable: bool = False,
    ):
        if immutable:
            raise TypeError(
                _DEPRECATED_IMMUTABLE_FLAG.format(
                    cls_name="SwrCache", immutable_name="ImmutableCache",
                )
            )
        super().__init__(maxsize=maxsize)
        self.soft_ttl = soft_ttl
        self.hard_ttl = hard_ttl

    def get(self, key: Any) -> tuple[Any, str] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        return value, ("fresh" if age <= self.soft_ttl else "stale")

    def get_with_layer(self, key: Any) -> tuple[Any, str, str] | None:
        """Like `get`, but returns `(value, freshness, layer)` so a caller
        timing the lookup can attribute the latency. `layer` is always
        `"l1"` here — the SwrCache itself has no L2; the field exists so
        consumers don't have to type-narrow between SwrCache and
        :class:`LayeredSwrCache` (which overrides this and may return
        `"l2"`).
        """
        result = self.get(key)
        if result is None:
            return None
        value, freshness = result
        return value, freshness, "l1"

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        """Like `get`, but exposes the absolute `fetched_at` timestamp.

        Used by the poll endpoint to decide whether the cache entry is
        newer than a given ticket — independent of soft/hard TTL state.
        """
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
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
        value, fetched_at = entry
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        return value, ("fresh" if age <= self.soft_ttl else "stale"), fetched_at


# ============================================================================
# Immutable caches
# ============================================================================


class ImmutableCache(_BaseCacheStorage):
    """Immutable-by-key cache.

    Used for data whose cache key pins enough invariants that any hit is
    bit-identical to a fresh fetch — e.g. ``(ds, mat_version, table)``
    for materialized synapse / soma snapshots, or ``(ds, ft_id,
    parquet_uri)`` for parquet-pinned embedding frames.

    Reads always report ``"fresh"`` and never auto-evict; entries are
    bounded only by ``maxsize`` LRU pressure. There is no TTL — on the
    L1 side, the value stays until LRU evicts it; on the L2 side, the
    bucket lifecycle rule is the single source of expiry. See
    :class:`LayeredImmutableCache` for the L2-backed variant.

    Distinct from :class:`SwrCache` because the immutable contract is
    visible in the type — call sites and reviewers don't have to
    inspect a constructor flag to know which read semantics apply.
    """

    def __init__(self, *, maxsize: int = 1024):
        super().__init__(maxsize=maxsize)

    def get(self, key: Any) -> tuple[Any, str] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, _fetched_at = entry
        return value, "fresh"

    def get_with_layer(self, key: Any) -> tuple[Any, str, str] | None:
        result = self.get(key)
        if result is None:
            return None
        value, freshness = result
        return value, freshness, "l1"

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        return value, fetched_at

    def get_full(self, key: Any) -> tuple[Any, str, float] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        return value, "fresh", fetched_at


# ============================================================================
# Layered (L1 + L2) caches
# ============================================================================


class _BaseLayeredCache:
    """Shared L1+L2 fan-out for :class:`LayeredSwrCache` and
    :class:`LayeredImmutableCache`.

    Owns the L2 store resolution, the read-promotion path, and the
    write-with-executor path. Subclasses provide:

    - The L1 cache instance (:class:`SwrCache` vs
      :class:`ImmutableCache`) at construction.
    - The :meth:`_l2_entry_within_ttl` hook deciding whether an L2 hit
      with a given `fetched_at` is recent enough to promote.

    L2 shape: ``None`` (no L2), a bare ``GcsObjectStore``, or a
    ``dict[str, GcsObjectStore]`` keyed by retention class with a
    ``retention_resolver(key)`` callable. The dict-with-resolver shape
    is the production path for decoration mat caches under retention
    classes.
    """

    def __init__(
        self,
        *,
        l1: _BaseCacheStorage,
        l2=None,
        executor=None,
        retention_resolver=None,
    ):
        self._l1 = l1
        self._l2 = l2
        self._executor = executor
        self._retention_resolver = retention_resolver

    def _l2_entry_within_ttl(self, fetched_at: float) -> bool:
        """Decide whether an L2 hit at ``fetched_at`` should be promoted
        to L1. Subclass hook — :class:`LayeredSwrCache` consults
        ``hard_ttl``; :class:`LayeredImmutableCache` always returns True
        (bucket lifecycle is the single expiry source).
        """
        raise NotImplementedError

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
        absent, the entry doesn't exist, or it's past the subclass's
        TTL gate.

        Defense in depth: :meth:`GcsObjectStore.get` already swallows
        internally, but we wrap anyway so any future L2 implementation
        that *does* raise still degrades to a miss instead of
        propagating an error through every cache reader.
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
        if not self._l2_entry_within_ttl(fetched_at):
            return False
        self._l1.set_with_timestamp(key, value, fetched_at)
        return True

    def get(self, key: Any) -> tuple[Any, str] | None:
        result = self._l1.get(key)  # type: ignore[attr-defined]
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get(key)  # type: ignore[attr-defined]
        return None

    def get_with_layer(self, key: Any) -> tuple[Any, str, str] | None:
        """Layer-aware variant of `get`. Returns `(value, freshness, layer)`
        where `layer` is `"l1"` for an in-memory hit and `"l2"` for a
        hit promoted from GCS this call. None on miss.

        Why callers want this: the L1 path is microseconds, the L2 path
        is a GCS round-trip (tens to hundreds of ms). Routing the same
        value through both indistinguishably hides where time went on
        a cold-pod warmup. Per-request timing instrumentation reads
        `layer` to pick between `<thing>_l1_hit` and `<thing>_l2_hit`
        stage labels.
        """
        result = self._l1.get(key)  # type: ignore[attr-defined]
        if result is not None:
            value, freshness = result
            return value, freshness, "l1"
        if self._try_l2(key):
            promoted = self._l1.get(key)  # type: ignore[attr-defined]
            if promoted is not None:
                value, freshness = promoted
                return value, freshness, "l2"
        return None

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        result = self._l1.get_with_meta(key)  # type: ignore[attr-defined]
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get_with_meta(key)  # type: ignore[attr-defined]
        return None

    def get_full(self, key: Any) -> tuple[Any, str, float] | None:
        result = self._l1.get_full(key)  # type: ignore[attr-defined]
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get_full(key)  # type: ignore[attr-defined]
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
            # CLAUDE.md warns about applies here too. Plain
            # `executor.submit(fn)` signature: L2 writes are idempotent
            # and need no per-key dedup (writes for the same key produce
            # bit-identical bytes since the input value is the same).
            def _write(_store=store, _key=key, _value=value, _ts=fetched_at):
                _store.set(_key, _value, _ts)
            executor.submit(_write)
        else:
            store.set(key, value, fetched_at)

    def __contains__(self, key: Any) -> bool:
        return self._l1.__contains__(key)

    def clear(self) -> None:
        self._l1.clear()


class LayeredSwrCache(_BaseLayeredCache):
    """SwrCache + optional GCS L2. Drop-in replacement for :class:`SwrCache`.

    Read path: L1 first → L2 on miss → promote to L1 with the original
    `fetched_at` preserved (so freshness still reflects when CAVE was
    queried, not when this pod read from GCS).

    Write path: L1 synchronously, L2 via the supplied executor as a
    fire-and-forget job. The executor's submit signature is ``(fn)``;
    L2 writes are idempotent and need no per-key dedup.

    For data whose key pins enough invariants that any hit is
    bit-identical to a fresh fetch, use :class:`LayeredImmutableCache`
    instead.
    """

    def __init__(
        self,
        *,
        soft_ttl: float,
        hard_ttl: float,
        maxsize: int = 1024,
        l2=None,
        executor=None,
        retention_resolver=None,
        immutable: bool = False,
    ):
        if immutable:
            raise TypeError(
                _DEPRECATED_IMMUTABLE_FLAG.format(
                    cls_name="LayeredSwrCache",
                    immutable_name="LayeredImmutableCache",
                )
            )
        super().__init__(
            l1=SwrCache(soft_ttl=soft_ttl, hard_ttl=hard_ttl, maxsize=maxsize),
            l2=l2,
            executor=executor,
            retention_resolver=retention_resolver,
        )
        self.soft_ttl = soft_ttl
        self.hard_ttl = hard_ttl

    def _l2_entry_within_ttl(self, fetched_at: float) -> bool:
        return time.time() - fetched_at <= self.hard_ttl


class LayeredImmutableCache(_BaseLayeredCache):
    """ImmutableCache + optional GCS L2.

    Read path: L1 first → L2 on miss → promote to L1 with the original
    `fetched_at` preserved (informational only — :class:`ImmutableCache`
    doesn't gate on it).

    The L2 path skips any TTL check: the cache key pins immutability
    invariants (e.g. ``mat_version``, ``parquet_uri``), so any hit is
    bit-identical to what the source would return today. Bucket
    lifecycle is the single source of L2 expiry.

    The composed L1 cache is always an :class:`ImmutableCache` — never
    an :class:`SwrCache` — so freshness reads stay consistent across
    L1+L2 promotion.
    """

    def __init__(
        self,
        *,
        maxsize: int = 1024,
        l2=None,
        executor=None,
        retention_resolver=None,
    ):
        super().__init__(
            l1=ImmutableCache(maxsize=maxsize),
            l2=l2,
            executor=executor,
            retention_resolver=retention_resolver,
        )

    def _l2_entry_within_ttl(self, fetched_at: float) -> bool:
        # Immutable contract: bucket lifecycle is the single source of
        # L2 expiry. Any entry that came back from L2 is, by
        # construction, bit-identical to a fresh fetch.
        return True
