"""Tests for `cache_key_with_config` — supports the C1 fix.

The helper builds a cache key tuple of `(*positional, digest)` where digest
is a stable hash of the `config_bundle` dict. These tests assert:
  - Identical bundles produce identical keys (regardless of dict order).
  - Differing bundles produce differing keys.
  - Positional parts pass through unchanged.
"""

from __future__ import annotations

from cave_data_viewer.api.caches import cache_key_with_config


def test_identical_bundles_match():
    a = cache_key_with_config("ds", 1, 1234, "soma", config_bundle={"a": 1, "b": 2})
    b = cache_key_with_config("ds", 1, 1234, "soma", config_bundle={"b": 2, "a": 1})
    assert a == b


def test_different_bundles_differ():
    a = cache_key_with_config("ds", 1, 1234, "soma", config_bundle={"a": 1})
    b = cache_key_with_config("ds", 1, 1234, "soma", config_bundle={"a": 2})
    assert a != b


def test_positional_parts_preserved():
    key = cache_key_with_config("ds", 1, 1234, "soma", config_bundle={"a": 1})
    assert key[:4] == ("ds", 1, 1234, "soma")
    # The digest is the last element and is a hex string.
    assert isinstance(key[-1], str)
    assert len(key[-1]) > 0


def test_nested_values_are_serialized():
    """Bundles with list / dict values must hash deterministically."""
    a = cache_key_with_config(
        "ds", 1, config_bundle={"cols": ["x", "y"], "rules": {"r1": {"agg": "sum"}}}
    )
    b = cache_key_with_config(
        "ds", 1, config_bundle={"cols": ["x", "y"], "rules": {"r1": {"agg": "sum"}}}
    )
    c = cache_key_with_config(
        "ds", 1, config_bundle={"cols": ["x", "y"], "rules": {"r1": {"agg": "mean"}}}
    )
    assert a == b
    assert a != c
