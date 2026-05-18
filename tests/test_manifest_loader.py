"""Tests for the feature-table catalog loader."""

from cave_data_viewer.api.services.embeddings.manifest import resolve_manifest_uri


def test_resolve_manifest_uri_joins_base_and_datastack():
    """The convention is <base>feature_tables/<datastack>/."""
    uri = resolve_manifest_uri("gs://my-bucket/", "minnie65_public")
    assert uri == "gs://my-bucket/feature_tables/minnie65_public/"


def test_resolve_manifest_uri_handles_file_scheme():
    uri = resolve_manifest_uri("file:///app/config/", "minnie65_phase3_v1")
    assert uri == "file:///app/config/feature_tables/minnie65_phase3_v1/"


def test_resolve_manifest_uri_normalizes_missing_trailing_slash():
    """Robust to a base URI missing its trailing slash (although
    upstream wiring normalizes this, downstream callers should be
    defensive)."""
    uri = resolve_manifest_uri("gs://my-bucket", "minnie65_public")
    assert uri == "gs://my-bucket/feature_tables/minnie65_public/"
