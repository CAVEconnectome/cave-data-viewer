"""Tests for CDV_FEATURE_TABLES_BASE_URI wiring into app.config."""

import os
from pathlib import Path

import pytest

from cave_data_viewer.api import create_app


def test_base_uri_defaults_to_repo_config_when_env_unset(monkeypatch):
    """No env var => default to the repo's config/ as a file:// URI."""
    monkeypatch.delenv("CDV_FEATURE_TABLES_BASE_URI", raising=False)
    app = create_app()
    uri = app.config["FEATURE_TABLES_BASE_URI"]
    assert uri.startswith("file://")
    assert uri.endswith("/")  # convention: directory URIs end in /
    # The default points at one of the bundled config locations.
    path = uri[len("file://"):]
    assert Path(path).is_dir(), f"default base URI path does not exist: {path}"


def test_base_uri_from_env_overrides_default(monkeypatch):
    """When set, the env var wins verbatim."""
    monkeypatch.setenv("CDV_FEATURE_TABLES_BASE_URI", "gs://my-bucket/")
    app = create_app()
    assert app.config["FEATURE_TABLES_BASE_URI"] == "gs://my-bucket/"


def test_base_uri_normalized_to_trailing_slash(monkeypatch):
    """Trailing slash is added if missing — downstream join code expects it."""
    monkeypatch.setenv("CDV_FEATURE_TABLES_BASE_URI", "gs://my-bucket")
    app = create_app()
    assert app.config["FEATURE_TABLES_BASE_URI"] == "gs://my-bucket/"
