"""``EmbeddingSource`` Protocol + the v1 manifest-backed implementation.

The Protocol exists so the future "catalog service" path (an HTTP endpoint
hosting the catalog) is a drop-in replacement: same methods, different
backend. Endpoint and service code only depends on the Protocol.
"""

from __future__ import annotations

from typing import Protocol

from flask import current_app

from .manifest import EmbeddingSpec, Manifest, get_manifest


class EmbeddingSource(Protocol):
    """How the backend discovers + resolves embeddings for a specific
    datastack.

    Sources are constructed per-request from the datastack config; they
    hold the datastack name internally so call sites don't have to
    re-pass it.
    """

    def list(self) -> Manifest:
        """Return every embedding declared in the catalog. The full
        ``Manifest`` is returned (not just the list) so callers can
        access the ``knn`` defaults alongside ``embeddings``."""

    def resolve(self, embedding_id: str) -> EmbeddingSpec:
        """Look up one embedding by its stable id. Raises ``KeyError``
        when the id is unknown."""


class ManifestEmbeddingSource:
    """``EmbeddingSource`` backed by a manifest YAML referenced from the
    datastack config.

    This is v1. A future ``CatalogEmbeddingSource`` would implement the
    same Protocol by calling an HTTP catalog service instead — the
    endpoint code depends on ``EmbeddingSource`` and would not need to
    change.
    """

    def __init__(
        self,
        datastack: str,
        manifest_uri: str,
        *,
        gcs_project: str | None = None,
    ) -> None:
        self.datastack = datastack
        self.manifest_uri = manifest_uri
        self.gcs_project = gcs_project

    def list(self) -> Manifest:
        return get_manifest(
            self.datastack, self.manifest_uri, project=self.gcs_project
        )

    def resolve(self, embedding_id: str) -> EmbeddingSpec:
        manifest = self.list()
        for spec in manifest.embeddings:
            if spec.id == embedding_id:
                return spec
        raise KeyError(
            f"datastack {self.datastack!r}: no embedding with id={embedding_id!r} "
            f"in manifest at {self.manifest_uri!r} "
            f"(available: {[e.id for e in manifest.embeddings]})"
        )


def source_for(datastack: str, ds_cfg) -> ManifestEmbeddingSource | None:
    """Build a ``ManifestEmbeddingSource`` from a loaded ``DatastackConfig``,
    or return ``None`` when the feature explorer is disabled / unconfigured
    for the datastack.

    Endpoint code is expected to short-circuit on ``None`` (404 the request
    or omit the route from the listing). Keeping that contract on the
    caller rather than raising lets endpoints decide between "no embeddings
    available" and "explorer disabled" UX.

    ``ds_cfg`` is the result of ``load_datastack_config(datastack)``. Typed
    as ``Any`` here to avoid a circular import — ``datastack_config`` doesn't
    know about the embeddings package and shouldn't.
    """
    fe = getattr(ds_cfg, "feature_explorer", None)
    if fe is None or not fe.enabled or not fe.manifest_uri:
        return None
    project = current_app.config.get("GCS_CACHE_PROJECT")
    return ManifestEmbeddingSource(
        datastack, fe.manifest_uri, gcs_project=project
    )
