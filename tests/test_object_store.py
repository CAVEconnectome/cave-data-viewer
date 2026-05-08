"""Tests for `GcsObjectStore` — mock the GCS Client so the tests stay
hermetic. The store's contract: never raise, swallow errors with
WARNING logs (except routine 404 / NotFound which stays quiet).
"""

from __future__ import annotations

import logging
import pickle
import time
from unittest.mock import MagicMock

import pytest

from cave_data_viewer.api.services.object_store import GcsObjectStore


def _build_store_with_mock_client() -> tuple[GcsObjectStore, MagicMock]:
    """Helper: returns `(store, mock_blob)` where the store's lazy
    client is pre-injected as a mock so we can stub blob behavior.
    """
    store = GcsObjectStore("test-bucket", prefix="cache/")
    mock_client = MagicMock()
    mock_bucket = MagicMock()
    mock_blob = MagicMock()
    mock_client.bucket.return_value = mock_bucket
    mock_bucket.blob.return_value = mock_blob
    store._client = mock_client
    return store, mock_blob


def test_object_name_tuple_key_url_encodes_each_part():
    store = GcsObjectStore("b", prefix="cache/")
    name = store._object_name(("ds", 1718, "aibs/cell_info"))
    # Slash inside a tuple element is percent-encoded so it doesn't
    # accidentally introduce a path separator.
    assert name == "cache/ds/1718/aibs%2Fcell_info.pkl"


def test_object_name_string_key_single_segment():
    store = GcsObjectStore("b", prefix="cache/synapse/")
    name = store._object_name("abc123def456")
    assert name == "cache/synapse/abc123def456.pkl"


def test_round_trip_get_returns_value_and_timestamp():
    store, mock_blob = _build_store_with_mock_client()
    # download_as_bytes returns whatever the matching set would have written
    fetched_at = time.time()
    mock_blob.download_as_bytes.return_value = pickle.dumps(
        ({"row1": 1}, fetched_at), protocol=5
    )
    result = store.get(("ds", 1, "tbl"))
    assert result is not None
    value, ts = result
    assert value == {"row1": 1}
    assert abs(ts - fetched_at) < 1e-6


def test_get_on_missing_object_returns_none_and_does_not_warn(caplog):
    """A 404 / NotFound is the routine cold-cache miss; logging it as a
    warning would spam the operational log on every cold pod start.
    """
    store, mock_blob = _build_store_with_mock_client()

    class NotFound(Exception):
        pass

    mock_blob.download_as_bytes.side_effect = NotFound("404 Not Found")
    with caplog.at_level(logging.WARNING, logger="cdv.cache.gcs"):
        result = store.get("missing")
    assert result is None
    assert not caplog.records  # silent on routine 404


def test_get_on_unexpected_error_returns_none_and_warns(caplog):
    """A real outage (auth, timeout) DOES log so ops can spot it."""
    store, mock_blob = _build_store_with_mock_client()
    mock_blob.download_as_bytes.side_effect = TimeoutError("connection timeout")
    with caplog.at_level(logging.WARNING, logger="cdv.cache.gcs"):
        result = store.get("k")
    assert result is None
    assert any("gcs_get_failed" in r.message for r in caplog.records)


def test_set_writes_pickle_bytes_via_upload():
    store, mock_blob = _build_store_with_mock_client()
    store.set(("ds", 1, "tbl"), {"row1": 1}, fetched_at=12345.0)
    assert mock_blob.upload_from_string.called
    call_args = mock_blob.upload_from_string.call_args
    payload = call_args[0][0]  # first positional
    value, ts = pickle.loads(payload)
    assert value == {"row1": 1}
    assert ts == 12345.0
    # Content-type set so a future GCS-side viewer doesn't render the
    # bytes as text.
    assert call_args.kwargs.get("content_type") == "application/octet-stream"


def test_set_swallows_errors(caplog):
    """A failed L2 write must not propagate — the L1 path already
    succeeded for the user, and the next pod that needs the value will
    fall back to CAVE on its own.
    """
    store, mock_blob = _build_store_with_mock_client()
    mock_blob.upload_from_string.side_effect = RuntimeError("503")
    with caplog.at_level(logging.WARNING, logger="cdv.cache.gcs"):
        store.set("k", "v", fetched_at=time.time())  # must not raise
    assert any("gcs_set_failed" in r.message for r in caplog.records)


def test_build_l2_stores_returns_empty_when_unconfigured():
    from cave_data_viewer.api.services.object_store import build_l2_stores

    class App:
        config = {}
    assert build_l2_stores(App()) == {}


def test_build_l2_stores_populates_all_kinds_per_retention_class():
    """Returns a 2-level dict: outer keys = retention classes, inner keys
    = decoration / synapse kinds. Each prefix is
    `<base><retention>/<kind>/`."""
    from cave_data_viewer.api.services.object_store import build_l2_stores

    class App:
        config = {"GCS_CACHE_BUCKET": "my-bucket", "GCS_CACHE_PREFIX": "cdv/"}
    stores = build_l2_stores(App())
    assert set(stores.keys()) == {"default", "longlived"}
    for retention in ("default", "longlived"):
        assert set(stores[retention].keys()) == {
            "num_soma", "table", "synapse",
        }
    assert stores["default"]["table"]._prefix == "cdv/default/table/"
    assert stores["longlived"]["synapse"]._prefix == "cdv/longlived/synapse/"


def test_build_l2_stores_normalizes_missing_trailing_slash():
    """An operator who sets `CDV_GCS_CACHE_PREFIX=foo` (no slash) gets
    `foo/<retention>/table/`, not `foo<retention>/table/`. Cheap
    defensive normalization."""
    from cave_data_viewer.api.services.object_store import build_l2_stores

    class App:
        config = {"GCS_CACHE_BUCKET": "b", "GCS_CACHE_PREFIX": "foo"}
    stores = build_l2_stores(App())
    assert stores["default"]["table"]._prefix == "foo/default/table/"
    assert stores["longlived"]["table"]._prefix == "foo/longlived/table/"


def test_build_l2_stores_threads_project_into_each_store():
    """`CDV_GCS_CACHE_PROJECT` flows into every store's constructor —
    end-user ADC needs an explicit project for the billing/quota field."""
    from cave_data_viewer.api.services.object_store import build_l2_stores

    class App:
        config = {
            "GCS_CACHE_BUCKET": "b",
            "GCS_CACHE_PREFIX": "cache/",
            "GCS_CACHE_PROJECT": "my-project",
        }
    stores = build_l2_stores(App())
    for retention_kinds in stores.values():
        for store in retention_kinds.values():
            assert store._project == "my-project"


def test_build_l2_stores_project_optional():
    """When `GCS_CACHE_PROJECT` is unset, every store carries `project=None`
    and the Client falls back to whatever the ADC identity provides."""
    from cave_data_viewer.api.services.object_store import build_l2_stores

    class App:
        config = {"GCS_CACHE_BUCKET": "b"}
    stores = build_l2_stores(App())
    for retention_kinds in stores.values():
        for store in retention_kinds.values():
            assert store._project is None


def test_build_info_store_returns_separate_prefix_outside_retention():
    """The marker-file store roots at `<base>info/`, OUTSIDE both the
    `default/` and `longlived/` subtrees so the lifecycle rules' prefix
    scopes never sweep marker files by accident."""
    from cave_data_viewer.api.services.object_store import build_info_store

    class App:
        config = {"GCS_CACHE_BUCKET": "b", "GCS_CACHE_PREFIX": "cache/"}
    info = build_info_store(App())
    assert info is not None
    assert info._prefix == "cache/info/"


def test_build_info_store_returns_none_when_unconfigured():
    from cave_data_viewer.api.services.object_store import build_info_store

    class App:
        config = {}
    assert build_info_store(App()) is None
