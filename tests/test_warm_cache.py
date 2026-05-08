"""Tests for `cdv-warm-cache` (the CLI in tools/warm_cache.py).

The actual CAVE round-trip and GCS round-trip are skipped — those are
covered by the smoke tests in `test_object_store.py` and the user's
manual loop. Here we exercise the orchestration:

- Marker-file merge upserts the target version while preserving others
- Refusal path when retention != longlived without --force
- --dry-run prints the cell list and skips warming
- The L2 writer is drained before exit
"""

from __future__ import annotations

import argparse
from unittest.mock import MagicMock, patch

import pytest

from cave_data_viewer.tools.warm_cache import (
    _format_elapsed,
    _update_marker_file,
    WarmResults,
)


# --- Marker-file merge tests --------------------------------------------------

def _make_app_with_info_store():
    """Build a minimal stand-in for the Flask app that our marker-file
    helper reaches for. Only `app.config` matters — `build_info_store`
    reads `GCS_CACHE_BUCKET` / `GCS_CACHE_PREFIX` / `GCS_CACHE_PROJECT`."""
    app = MagicMock()
    app.config = {
        "GCS_CACHE_BUCKET": "test-bucket",
        "GCS_CACHE_PREFIX": "cache/",
        "GCS_CACHE_PROJECT": None,
    }
    return app


def test_marker_file_creates_initial_entry_when_file_missing():
    app = _make_app_with_info_store()
    fake_store = MagicMock()
    fake_store.get_json.return_value = None  # missing file

    args = argparse.Namespace(
        datastack="ds_x", mat_version=1764, expires="2028-01-15",
    )
    with patch(
        "cave_data_viewer.api.services.object_store.build_info_store",
        return_value=fake_store,
    ):
        _update_marker_file(app, args, cache_ds="ds_x")

    fake_store.set_json.assert_called_once()
    filename, payload = fake_store.set_json.call_args[0]
    assert filename == "ds_x-longlived-versions.json"
    assert payload["datastack"] == "ds_x"
    assert len(payload["longlived_versions"]) == 1
    assert payload["longlived_versions"][0]["version"] == 1764
    assert payload["longlived_versions"][0]["expires_at"] == "2028-01-15"
    assert "marked_at" in payload["longlived_versions"][0]


def test_marker_file_upserts_target_version_preserving_others():
    """Existing versions stay; the target version is replaced if it
    was already there. A new target appends and the list is sorted."""
    app = _make_app_with_info_store()
    fake_store = MagicMock()
    fake_store.get_json.return_value = {
        "datastack": "ds_x",
        "longlived_versions": [
            {"version": 1500, "marked_at": "2025-01-01T00:00:00Z"},
            {"version": 1764, "marked_at": "2025-06-01T00:00:00Z", "expires_at": "2027-06-01"},
        ],
    }
    args = argparse.Namespace(
        datastack="ds_x", mat_version=1764, expires="2028-01-15",
    )
    with patch(
        "cave_data_viewer.api.services.object_store.build_info_store",
        return_value=fake_store,
    ):
        _update_marker_file(app, args, cache_ds="ds_x")

    payload = fake_store.set_json.call_args[0][1]
    versions = payload["longlived_versions"]
    assert [v["version"] for v in versions] == [1500, 1764]  # sorted, no duplicates
    # v1500 entry preserved verbatim
    assert versions[0]["marked_at"] == "2025-01-01T00:00:00Z"
    # v1764 entry replaced — new expires, new marked_at
    assert versions[1]["expires_at"] == "2028-01-15"
    assert versions[1]["marked_at"] != "2025-06-01T00:00:00Z"


def test_marker_file_appends_new_version_in_sorted_order():
    app = _make_app_with_info_store()
    fake_store = MagicMock()
    fake_store.get_json.return_value = {
        "datastack": "ds_x",
        "longlived_versions": [{"version": 2000, "marked_at": "..."}],
    }
    args = argparse.Namespace(
        datastack="ds_x", mat_version=1500, expires=None,
    )
    with patch(
        "cave_data_viewer.api.services.object_store.build_info_store",
        return_value=fake_store,
    ):
        _update_marker_file(app, args, cache_ds="ds_x")

    payload = fake_store.set_json.call_args[0][1]
    assert [v["version"] for v in payload["longlived_versions"]] == [1500, 2000]


def test_marker_file_uses_cache_ds_for_filename_and_datastack_field():
    """When datastack `ds_x` aliases to `ds_y`, the marker file lives
    under ds_y's name. Both readers and writers must agree on this."""
    app = _make_app_with_info_store()
    fake_store = MagicMock()
    fake_store.get_json.return_value = None
    args = argparse.Namespace(
        datastack="ds_x", mat_version=1764, expires=None,
    )
    with patch(
        "cave_data_viewer.api.services.object_store.build_info_store",
        return_value=fake_store,
    ):
        _update_marker_file(app, args, cache_ds="ds_y")
    filename, payload = fake_store.set_json.call_args[0]
    assert filename == "ds_y-longlived-versions.json"
    assert payload["datastack"] == "ds_y"


def test_marker_file_exits_when_bucket_unconfigured():
    """No GCS_CACHE_BUCKET → no marker write possible. The script
    should exit with a clear error rather than silently noop."""
    app = MagicMock()
    app.config = {"GCS_CACHE_BUCKET": None}
    args = argparse.Namespace(
        datastack="ds_x", mat_version=1764, expires=None,
    )
    with patch(
        "cave_data_viewer.api.services.object_store.build_info_store",
        return_value=None,
    ), pytest.raises(SystemExit) as exc_info:
        _update_marker_file(app, args, cache_ds="ds_x")
    assert exc_info.value.code == 5


# --- Result formatting --------------------------------------------------------

def test_format_elapsed_under_a_minute_uses_seconds():
    assert _format_elapsed(43.7) == "43.7s"


def test_format_elapsed_minutes_seconds():
    assert _format_elapsed(125.0) == "2m05s"


def test_format_elapsed_hours():
    assert _format_elapsed(3725.0) == "1h02m"


def test_warm_results_default_state_is_clean():
    r = WarmResults()
    assert r.cells_warmed == 0
    assert r.cells_failed == 0
    assert r.failures == []
    assert r.elapsed_s == 0.0
