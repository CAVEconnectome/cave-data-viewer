"""Tests for `LayeredSwrCache` — the L1 (SwrCache) + optional L2 wrapper.

Use a fake L2 store (an in-memory dict matching `GcsObjectStore`'s
`get`/`set` surface) so the tests stay pure-Python and don't require a
GCS client / network.
"""

from __future__ import annotations

import time

from cave_data_viewer.api.services.swr import LayeredSwrCache, SwrCache


class FakeL2:
    """In-memory stand-in for `GcsObjectStore`. Same `get` / `set` shape."""

    def __init__(self) -> None:
        self.store: dict = {}
        self.get_calls: list = []
        self.set_calls: list = []

    def get(self, key):
        self.get_calls.append(key)
        return self.store.get(key)

    def set(self, key, value, fetched_at: float) -> None:
        self.set_calls.append((key, value, fetched_at))
        self.store[key] = (value, fetched_at)


class RaisingL2:
    """L2 stand-in whose `get` raises. Used to confirm the wrapper does
    not propagate L2 errors. (`GcsObjectStore.get` swallows internally,
    but a hostile substitute proves the boundary regardless.)
    """

    def __init__(self) -> None:
        self.get_calls = 0

    def get(self, key):
        self.get_calls += 1
        raise RuntimeError("synthetic L2 outage")

    def set(self, key, value, fetched_at: float) -> None:
        pass


def test_l1_only_mode_behaves_like_swr_cache():
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=20, l2=None)
    cache.set("k", "v")
    assert cache.get("k") == ("v", "fresh")
    assert "k" in cache


def test_l1_miss_then_l2_hit_promotes_with_preserved_timestamp():
    """Pod B has a cold L1; the entry is in L2 with a 5-second-old
    `fetched_at`. Promotion must preserve the original timestamp so
    soft-TTL freshness is computed correctly.
    """
    soft_ttl, hard_ttl = 10, 100
    l2 = FakeL2()
    pod_b = LayeredSwrCache(soft_ttl=soft_ttl, hard_ttl=hard_ttl, l2=l2)

    five_seconds_ago = time.time() - 5
    l2.store[("ds", 1, "tbl")] = ("payload", five_seconds_ago)

    result = pod_b.get(("ds", 1, "tbl"))
    assert result is not None
    value, freshness = result
    assert value == "payload"
    assert freshness == "fresh"  # 5s < 10s soft TTL

    # Verify timestamp was preserved (not reset to "now")
    meta = pod_b.get_with_meta(("ds", 1, "tbl"))
    assert meta is not None
    _, fetched_at = meta
    assert abs(fetched_at - five_seconds_ago) < 0.01


def test_l1_miss_l2_hit_with_old_timestamp_marks_as_stale():
    """A 15-second-old L2 entry is past soft TTL but inside hard TTL —
    promotion succeeds and the consumer sees `stale`, which is the
    signal to schedule a background refresh.
    """
    l2 = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=l2)
    l2.store["k"] = ("v", time.time() - 15)
    result = cache.get("k")
    assert result == ("v", "stale")


def test_l2_entry_past_hard_ttl_is_discarded():
    """An L2 entry older than hard_ttl is treated as a miss — promotion
    is rejected and the caller sees None (so it falls through to a
    fresh CAVE fetch). This protects against stale data lingering in
    the bucket between deploys.
    """
    l2 = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=20, l2=l2)
    l2.store["k"] = ("v", time.time() - 100)  # way past hard_ttl
    assert cache.get("k") is None


def test_l2_get_error_degrades_to_miss():
    """A raising L2 must never propagate — the request path falls
    through as if L2 weren't configured.
    """
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=RaisingL2())
    # No exception — just a clean miss. Note: GcsObjectStore catches
    # internally, but LayeredSwrCache must also not blow up if a custom
    # L2 leaks an error.
    try:
        result = cache.get("k")
    except Exception:
        result = "raised"
    # The wrapper's contract: L1 result OR fall-through. A raised
    # exception fails the test.
    assert result is None or result == "raised"
    # Document the gap: if `result == "raised"` here, the wrapper is
    # NOT shielding callers from L2 errors and a future refactor
    # should add a try/except in `_try_l2`.
    assert result is None, "LayeredSwrCache must catch L2 errors"


def test_set_writes_through_to_l2():
    """Without an executor, `set` calls L2 synchronously."""
    l2 = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=l2)
    cache.set(("ds", 1, "tbl"), {"42": "row"})
    assert len(l2.set_calls) == 1
    key, value, ts = l2.set_calls[0]
    assert key == ("ds", 1, "tbl")
    assert value == {"42": "row"}
    assert abs(ts - time.time()) < 1


class FakeExecutor:
    """Minimal `RevalidationExecutor` substitute. Records submissions
    and runs them synchronously so the test can observe the L2 write."""

    def __init__(self) -> None:
        self.submissions = []

    def submit(self, key, fn) -> None:
        self.submissions.append((key, fn))
        fn()  # run synchronously so we can assert on the L2 store after


def test_set_uses_executor_when_provided():
    l2 = FakeL2()
    executor = FakeExecutor()
    cache = LayeredSwrCache(
        soft_ttl=10, hard_ttl=100, l2=l2, executor=executor
    )
    cache.set("k", "v")
    # L2 write was submitted as a job, namespaced under `gcs_write`
    assert len(executor.submissions) == 1
    job_key, _ = executor.submissions[0]
    assert job_key == ("gcs_write", "k")
    # Executor ran the job synchronously, so L2 should now hold it
    assert l2.store["k"][0] == "v"


def test_get_with_meta_promotes_from_l2():
    l2 = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=l2)
    l2.store["k"] = ("v", time.time() - 3)
    meta = cache.get_with_meta("k")
    assert meta is not None
    value, fetched_at = meta
    assert value == "v"
    assert abs(fetched_at - (time.time() - 3)) < 0.01


def test_get_full_promotes_from_l2_with_freshness():
    l2 = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=l2)
    l2.store["k"] = ("v", time.time() - 3)
    full = cache.get_full("k")
    assert full is not None
    value, freshness, fetched_at = full
    assert value == "v"
    assert freshness == "fresh"
    assert abs(fetched_at - (time.time() - 3)) < 0.01


def test_clear_only_clears_l1():
    """`clear()` must not delete L2 — that would defeat the cross-pod
    share. L2 entries time out via `fetched_at` and are swept by bucket
    lifecycle rules.
    """
    l2 = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=l2)
    cache.set("k", "v")
    cache.clear()
    # L1 is empty — L2 still holds the entry, so a subsequent `get`
    # promotes it back.
    result = cache.get("k")
    assert result is not None
    assert result[0] == "v"


def test_swr_cache_set_with_timestamp_preserves_explicit_age():
    """The new SwrCache method that LayeredSwrCache uses for promotion."""
    cache = SwrCache(soft_ttl=10, hard_ttl=100)
    fetched_at = time.time() - 7
    cache.set_with_timestamp("k", "v", fetched_at)
    # 7s old → past soft_ttl=10? no, still fresh
    result = cache.get("k")
    assert result == ("v", "fresh")
    meta = cache.get_with_meta("k")
    assert meta is not None
    _, ts = meta
    assert abs(ts - fetched_at) < 0.01


# ----- Retention-class dispatch ----------------------------------------------
#
# When `l2` is a `dict[str, store]` keyed by retention class plus a
# `retention_resolver(key) -> str` callable, the wrapper picks the inner
# store at every read/write. The decoration mat caches use this shape in
# production; these tests exercise the seam without touching GCS.


def test_retention_dispatch_routes_writes_to_resolved_class():
    default_l2 = FakeL2()
    longlived_l2 = FakeL2()
    cache = LayeredSwrCache(
        soft_ttl=10,
        hard_ttl=100,
        l2={"default": default_l2, "longlived": longlived_l2},
        retention_resolver=lambda key: "longlived" if key.startswith("ll-") else "default",
    )
    cache.set("ll-key", "value-A")
    cache.set("regular-key", "value-B")
    # Only longlived store received the ll-key write
    assert ("ll-key", "value-A", longlived_l2.set_calls[0][2]) == longlived_l2.set_calls[0]
    assert len(longlived_l2.set_calls) == 1
    # Only default store received the regular-key write
    assert ("regular-key", "value-B", default_l2.set_calls[0][2]) == default_l2.set_calls[0]
    assert len(default_l2.set_calls) == 1


def test_retention_dispatch_routes_reads_to_resolved_class():
    default_l2 = FakeL2()
    longlived_l2 = FakeL2()
    longlived_l2.store["ll-key"] = ("longlived-value", time.time() - 1)
    default_l2.store["regular-key"] = ("default-value", time.time() - 1)
    cache = LayeredSwrCache(
        soft_ttl=10,
        hard_ttl=100,
        l2={"default": default_l2, "longlived": longlived_l2},
        retention_resolver=lambda key: "longlived" if key.startswith("ll-") else "default",
    )
    assert cache.get("ll-key") == ("longlived-value", "fresh")
    assert cache.get("regular-key") == ("default-value", "fresh")
    # Each store was queried only for the keys whose class matched.
    assert "ll-key" in longlived_l2.get_calls
    assert "regular-key" not in longlived_l2.get_calls
    assert "regular-key" in default_l2.get_calls
    assert "ll-key" not in default_l2.get_calls


def test_retention_dispatch_resolver_failure_falls_back_to_default():
    """A resolver that raises must not break the cache layer — falling
    back to `default` is the safe choice (worst case is an entry lands
    on the wrong-but-still-functional partition)."""
    default_l2 = FakeL2()
    longlived_l2 = FakeL2()
    cache = LayeredSwrCache(
        soft_ttl=10,
        hard_ttl=100,
        l2={"default": default_l2, "longlived": longlived_l2},
        retention_resolver=lambda key: (_ for _ in ()).throw(RuntimeError("synthetic")),
    )
    cache.set("k", "v")
    # The default store received the write despite the resolver erroring.
    assert len(default_l2.set_calls) == 1
    assert len(longlived_l2.set_calls) == 0


def test_retention_dispatch_no_resolver_uses_default_class():
    """If the caller provides l2 as a dict but no resolver, every
    operation routes to `default`. This is the safe degenerate case."""
    default_l2 = FakeL2()
    longlived_l2 = FakeL2()
    cache = LayeredSwrCache(
        soft_ttl=10,
        hard_ttl=100,
        l2={"default": default_l2, "longlived": longlived_l2},
        # no retention_resolver
    )
    cache.set("k", "v")
    assert len(default_l2.set_calls) == 1
    assert len(longlived_l2.set_calls) == 0


def test_bare_l2_store_still_works_for_compat():
    """The pre-retention shape (single store, no resolver) is preserved
    so non-retention-aware callers keep working."""
    bare = FakeL2()
    cache = LayeredSwrCache(soft_ttl=10, hard_ttl=100, l2=bare)
    cache.set("k", "v")
    assert len(bare.set_calls) == 1
    bare.store["k2"] = ("hello", time.time() - 1)
    assert cache.get("k2") == ("hello", "fresh")
