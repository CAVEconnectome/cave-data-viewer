"""Tests for `cache_datastack` and `retention_class_for`."""

from __future__ import annotations

from unittest.mock import patch

from cave_data_viewer.api.services.cache_lifecycle import (
    cache_datastack,
    retention_class_for,
)
from cave_data_viewer.api.services.datastack_config import DatastackConfig


class FakeRegistry:
    def __init__(self, sets: dict[str, set[int]] | None = None) -> None:
        self._sets = sets or {}
        self.queried_for: list[str] = []

    def longlived_set(self, datastack: str) -> set[int]:
        self.queried_for.append(datastack)
        return self._sets.get(datastack, set())


def test_cache_datastack_no_alias_returns_self():
    """When YAML doesn't set `cache_alias`, the helper returns the
    datastack name unchanged."""
    cfg = DatastackConfig()  # no cache_alias
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert cache_datastack("ds_x") == "ds_x"


def test_cache_datastack_with_alias_redirects():
    """`cache_alias: ds_y` makes `cache_datastack(ds_x)` return `ds_y`."""
    cfg = DatastackConfig(cache_alias="ds_y")
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert cache_datastack("ds_x") == "ds_y"


def test_cache_datastack_loader_failure_falls_back_to_self():
    """A malformed/missing YAML must not break every cache lookup —
    the helper degrades to 'no alias' on any loader exception."""
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        side_effect=RuntimeError("synthetic config load failure"),
    ):
        assert cache_datastack("ds_x") == "ds_x"


def test_retention_class_default_when_version_not_marked():
    reg = FakeRegistry({"ds_x": {1764}})
    cfg = DatastackConfig()
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert retention_class_for(reg, "ds_x", 1850) == "default"


def test_retention_class_longlived_when_version_marked():
    reg = FakeRegistry({"ds_x": {1764, 1850}})
    cfg = DatastackConfig()
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert retention_class_for(reg, "ds_x", 1764) == "longlived"


def test_retention_class_consults_alias_namespace():
    """When `ds_x` aliases to `ds_y`, the longlived registry is
    consulted for `ds_y` — that's where the marker file lives."""
    reg = FakeRegistry({"ds_y": {1764}})
    cfg = DatastackConfig(cache_alias="ds_y")
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert retention_class_for(reg, "ds_x", 1764) == "longlived"
        assert reg.queried_for == ["ds_y"]


def test_retention_class_non_int_version_falls_to_default():
    """`mat_version='live'` (or any non-castable value) returns
    `default`. Live mode never reaches L2 anyway, but the guard keeps
    the function total."""
    reg = FakeRegistry()
    cfg = DatastackConfig()
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert retention_class_for(reg, "ds_x", "live") == "default"
        assert retention_class_for(reg, "ds_x", None) == "default"
        assert retention_class_for(reg, "ds_x", "garbage") == "default"


def test_retention_class_string_int_version_works():
    """Mat version may arrive as a string (URL parsing). String-int
    coerces and routes correctly."""
    reg = FakeRegistry({"ds_x": {1764}})
    cfg = DatastackConfig()
    with patch(
        "cave_data_viewer.api.services.cache_lifecycle.load_datastack_config",
        return_value=cfg,
    ):
        assert retention_class_for(reg, "ds_x", "1764") == "longlived"
