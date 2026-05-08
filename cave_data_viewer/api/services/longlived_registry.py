"""Per-pod TTL-cached reader of the longlived-versions marker files.

A marker file at ``gs://<bucket>/<prefix>info/<datastack>-longlived-versions.json``
names which mat versions of `datastack` should be treated as long-lived
(retained ~2 years instead of swept after 2 days). Operators write the
file via ``cdv-warm-cache``; the running service reads it here to route
L2 cache reads/writes to the right partition.

Per-pod, in-process cache. Same shape as the decoration snapshot caching
but smaller (a few integers per datastack) and read-only. Falls back to
"empty set" on every error so a missing/broken marker file never breaks
the request path — it just means everything is treated as default-class
until the marker reappears.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

from cachetools import TTLCache

if TYPE_CHECKING:
    from .object_store import GcsObjectStore

logger = logging.getLogger("cdv.cache.longlived")


class LonglivedRegistry:
    """TTL-cached longlived-versions lookup, keyed by datastack.

    The registry stores `set[int]` per datastack (the long-lived
    version numbers). A `None` cached value means "checked recently and
    found no marker file" — distinct from "not yet checked" so a missing
    marker doesn't trigger a GCS round-trip on every request.

    Thread-safe — the cache write happens under a lock, but reads after
    cache population are lock-free for the common path.
    """

    def __init__(self, info_store: "GcsObjectStore | None", ttl_seconds: float):
        self._store = info_store
        self._cache: TTLCache = TTLCache(maxsize=64, ttl=ttl_seconds)
        self._lock = threading.Lock()

    def longlived_set(self, datastack: str) -> set[int]:
        """Return the set of long-lived mat versions for `datastack`.
        Empty set when the marker file is missing, parse fails, GCS is
        unreachable, or the registry isn't configured (no info_store).
        """
        if self._store is None:
            return set()
        with self._lock:
            cached = self._cache.get(datastack)
        if cached is not None:
            return cached
        result = self._fetch(datastack)
        with self._lock:
            self._cache[datastack] = result
        return result

    def invalidate(self, datastack: str) -> None:
        """Drop the cached entry for `datastack`. Used by the warming
        script after writing a marker file so the next read sees the
        new state immediately."""
        with self._lock:
            self._cache.pop(datastack, None)

    def _fetch(self, datastack: str) -> set[int]:
        filename = f"{datastack}-longlived-versions.json"
        if self._store is None:
            return set()
        try:
            data = self._store.get_json(filename)
        except Exception as exc:
            # Defense in depth: GcsObjectStore.get_json swallows
            # internally, but a custom / future store implementation
            # might leak. Treating any exception here as "no marker
            # found" keeps the request path safe.
            logger.warning(
                "longlived_registry_fetch_failed datastack=%r: %s: %s",
                datastack, type(exc).__name__, exc,
            )
            return set()
        if not isinstance(data, dict):
            return set()
        versions = data.get("longlived_versions") or []
        out: set[int] = set()
        for entry in versions:
            # Tolerate two shapes: legacy [int, int, ...] and current
            # [{"version": int, ...}, ...]. The script writes the
            # current shape; this code reads either.
            if isinstance(entry, int):
                out.add(entry)
            elif isinstance(entry, dict) and "version" in entry:
                try:
                    out.add(int(entry["version"]))
                except (TypeError, ValueError):
                    logger.warning(
                        "longlived_registry parse: ignoring entry with non-int version: %r",
                        entry,
                    )
        return out
