"""Tests for the typed cache accessor module.

Two responsibilities to cover:

1. ``get_<kind>_cache()`` returns the correct concrete cache type from
   ``app.extensions``, and fails loudly when the extension is absent.
2. ``<kind>_cache_key(...)`` builds a deterministic tuple that applies
   :func:`cache_datastack` for any caller that includes ``ds``.

The accessor functions are thin enough that the value of these tests
is in pinning the public contract — call sites depend on (a) the
return type and (b) the key shape, and a regression in either is the
sort of silent failure (cache always misses; or two callers race onto
different keys for the same data) that the cache layer has historically
been bitten by.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from cave_data_viewer.api.services import cache_accessors as ca
from cave_data_viewer.api.services.swr import (
    ImmutableCache,
    LayeredImmutableCache,
    SwrCache,
)


# ----- Return-type / fast-fail behavior --------------------------------------


@pytest.mark.parametrize(
    "accessor, expected_type",
    [
        (ca.get_synapse_cache, LayeredImmutableCache),
        (ca.get_spatial_features_cache, LayeredImmutableCache),
        (ca.get_unique_values_cache, LayeredImmutableCache),
        (ca.get_cell_id_universe_cache, LayeredImmutableCache),
        (ca.get_column_histogram_cache, LayeredImmutableCache),
        (ca.get_embedding_frame_cache, ImmutableCache),
        (ca.get_embedding_matrix_cache, ImmutableCache),
        (ca.get_embedding_pca_cache, ImmutableCache),
        (ca.get_datastack_info_cache, SwrCache),
        (ca.get_embedding_manifest_cache, SwrCache),
    ],
)
def test_accessor_returns_expected_type(app, accessor, expected_type):
    with app.app_context():
        cache = accessor()
    assert isinstance(cache, expected_type), (
        f"{accessor.__name__} returned {type(cache).__name__}, expected "
        f"{expected_type.__name__} — the accessor's return type lies in its "
        "docstring + signature; a mismatch breaks call sites that narrow on "
        "the freshness contract."
    )


def test_accessor_raises_clearly_when_extension_missing(app):
    """A renamed extension key must NOT silently degrade to a None cache —
    the fast-fail is the entire reason this module exists."""
    with app.app_context():
        # Pop the extension to simulate the misconfiguration.
        original = app.extensions.pop("dcv_synapse_cache")
        try:
            with pytest.raises(RuntimeError, match="dcv_synapse_cache"):
                ca.get_synapse_cache()
        finally:
            app.extensions["dcv_synapse_cache"] = original


# ----- Key construction: alias application + determinism --------------------


def test_synapse_cache_key_applies_alias(app):
    """The accessor's key builder must apply `cache_datastack`. A datastack
    with no alias rule returns its own name; a datastack with `cache_alias:
    other_ds` returns `other_ds`. Both contracts are tested with monkeypatched
    aliases so we don't depend on the live datastack YAMLs.
    """
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            side_effect=lambda ds: "alias_target" if ds == "aliased_ds" else ds,
        ):
            assert ca.synapse_cache_key("plain_ds", 1234, "abc") == (
                "plain_ds", 1234, "abc",
            )
            assert ca.synapse_cache_key("aliased_ds", 1234, "abc") == (
                "alias_target", 1234, "abc",
            )


def test_unique_values_cache_key_shape(app):
    """Key is exactly `(cache_ds, mat_version, table)` — pin the wire shape
    so the read-side and the write-side stay in lockstep."""
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            return_value="resolved",
        ):
            key = ca.unique_values_cache_key("orig", 42, "my_table")
    assert key == ("resolved", 42, "my_table")


def test_decoration_cache_key_shape(app):
    """Even though there's no `get_decoration_cache()` accessor, the
    key builder lives here for the same reason — so a future refactor
    that renames an attribute on `DecorationService` doesn't drift the
    write side away from the read side."""
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            return_value="resolved",
        ):
            key = ca.decoration_cache_key("orig", 99, "soma_table")
    assert key == ("resolved", 99, "soma_table")


def test_column_histogram_cache_key_normalizes_decoration_tuple(app):
    """The dec-tuple slot accepts any iterable but the cached key must
    be a tuple — callers that pass a list shouldn't collide with callers
    that pass a tuple of the same names."""
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            return_value="ds",
        ):
            key_from_list = ca.column_histogram_cache_key(
                "x", "ft1", "col", ["a", "b"], 1, 50, "linear", None,
            )
            key_from_tuple = ca.column_histogram_cache_key(
                "x", "ft1", "col", ("a", "b"), 1, 50, "linear", None,
            )
    assert key_from_list == key_from_tuple
    assert isinstance(key_from_list[3], tuple)


def test_embedding_frame_cache_key_includes_uri_and_ft_id(app):
    """Two feature tables that happen to share a parquet URI during dev
    must NOT alias — `ft_id` is part of the key precisely so a careless
    URI overlap doesn't poison either entry."""
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            return_value="ds",
        ):
            k1 = ca.embedding_frame_cache_key("ds", "ft_a", "gs://b/p.parquet")
            k2 = ca.embedding_frame_cache_key("ds", "ft_b", "gs://b/p.parquet")
    assert k1 != k2
    assert k1 == ("ds", "ft_a", "gs://b/p.parquet")


def test_cell_id_universe_key_schema_version_default(app):
    """Schema version defaults to "v3" — bumping it invalidates the
    pre-configurable-column entries. The default lives in one place
    (the accessor) so the bump is a single-edit operation."""
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            return_value="ds",
        ):
            key = ca.cell_id_universe_cache_key("orig", 100, "view", "kind", "col")
    assert key == ("ds", 100, "view", "kind", "col", "v3")


def test_key_builders_are_deterministic(app):
    """Same input → same key. Pin this because a hash-based key on a
    mutable container would break the property silently."""
    with app.app_context():
        with patch(
            "cave_data_viewer.api.services.cache_accessors.cache_datastack",
            return_value="ds",
        ):
            for _ in range(3):
                assert ca.synapse_cache_key("x", 1, "h") == ("ds", 1, "h")
                assert ca.unique_values_cache_key("x", 1, "t") == ("ds", 1, "t")
                assert ca.embedding_pca_cache_key("x", "ft", "d") == ("ds", "ft", "d")
