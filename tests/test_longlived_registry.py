"""Tests for `LonglivedRegistry`.

Use a fake `GcsObjectStore`-shaped object (in-memory) so the tests stay
hermetic — no GCS client, no network. The contract under test is:
- TTL caching: repeated reads inside the window hit the cache
- Missing marker file → empty set
- Parse failure → log + empty set
- GCS error → empty set (graceful degrade)
- `invalidate(ds)` drops the cached entry so next read re-fetches
"""

from __future__ import annotations

import time

from cave_data_viewer.api.services.longlived_registry import LonglivedRegistry


class FakeStore:
    """In-memory `GcsObjectStore`-shaped object. Tracks how many times
    `get_json` is called so we can assert TTL caching behavior."""

    def __init__(self) -> None:
        self.contents: dict = {}
        self.get_json_calls = 0
        self.raise_on_get = False

    def get_json(self, filename: str):
        self.get_json_calls += 1
        if self.raise_on_get:
            raise RuntimeError("synthetic GCS outage")
        return self.contents.get(filename)


def test_missing_marker_file_returns_empty_set():
    store = FakeStore()
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    assert reg.longlived_set("ds_x") == set()
    # Two reads, only one fetch (the empty result is cached for the TTL).
    reg.longlived_set("ds_x")
    assert store.get_json_calls == 1


def test_returns_set_of_versions():
    store = FakeStore()
    store.contents["ds_x-longlived-versions.json"] = {
        "datastack": "ds_x",
        "longlived_versions": [
            {"version": 1764, "marked_at": "2026-01-15T17:30:00Z"},
            {"version": 1850},
        ],
    }
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    assert reg.longlived_set("ds_x") == {1764, 1850}


def test_legacy_int_list_shape_supported():
    """An older marker file written as a flat list of ints should still
    parse — defensive against any external tools that might emit that
    shape."""
    store = FakeStore()
    store.contents["ds_x-longlived-versions.json"] = {
        "datastack": "ds_x",
        "longlived_versions": [1764, 1850],
    }
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    assert reg.longlived_set("ds_x") == {1764, 1850}


def test_ttl_cache_blocks_repeated_fetches():
    store = FakeStore()
    store.contents["ds_x-longlived-versions.json"] = {
        "longlived_versions": [{"version": 1}],
    }
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    for _ in range(5):
        reg.longlived_set("ds_x")
    assert store.get_json_calls == 1


def test_invalidate_forces_refetch():
    store = FakeStore()
    store.contents["ds_x-longlived-versions.json"] = {
        "longlived_versions": [{"version": 1}],
    }
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    reg.longlived_set("ds_x")
    assert store.get_json_calls == 1
    reg.invalidate("ds_x")
    reg.longlived_set("ds_x")
    assert store.get_json_calls == 2


def test_no_info_store_returns_empty_set():
    """When GCS is unconfigured, the registry should return an empty
    set without trying to fetch (no fetch counter to bump)."""
    reg = LonglivedRegistry(info_store=None, ttl_seconds=300)
    assert reg.longlived_set("ds_x") == set()


def test_gcs_error_does_not_propagate():
    """A raising store (which `GcsObjectStore` shouldn't ever do, but a
    test or future implementation might) must not blow up the request
    path. The registry catches at its boundary by reading None and
    treating that as empty."""
    store = FakeStore()
    store.raise_on_get = True
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    # `_fetch` calls `store.get_json(...)` directly. The current
    # implementation wraps this implicitly via FakeStore returning None
    # on error path — but if a real store raises, the result is the
    # same: empty set. Defensively assert no exception escapes.
    try:
        result = reg.longlived_set("ds_x")
    except Exception:
        result = "raised"
    assert result == set(), "registry must not propagate L2 errors"


def test_malformed_payload_returns_empty_set():
    """A marker file that's syntactically valid JSON but doesn't match
    the expected shape (e.g. a list at the top level instead of a dict)
    falls through to empty set."""
    store = FakeStore()
    store.contents["ds_x-longlived-versions.json"] = ["not", "a", "dict"]
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    assert reg.longlived_set("ds_x") == set()


def test_partial_entries_skipped():
    """A version entry with a non-int `version` field is logged and
    skipped — other entries in the same file are still respected."""
    store = FakeStore()
    store.contents["ds_x-longlived-versions.json"] = {
        "longlived_versions": [
            {"version": 1764},
            {"version": "not-an-int"},
            {"no_version_field": True},
            {"version": 1850},
        ],
    }
    reg = LonglivedRegistry(info_store=store, ttl_seconds=300)
    assert reg.longlived_set("ds_x") == {1764, 1850}
