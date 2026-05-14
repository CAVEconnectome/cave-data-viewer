"""Embedding-catalog manifest: schema, fetch, parse, validate, and SWR cache.

The manifest is a single YAML file in GCS (or anywhere the URI resolver can
reach) that lists every embedding available for a datastack. The datastack
YAML carries only ``manifest_uri:`` — the embedding catalog itself lives
here, so adding a new embedding is an edit-in-GCS workflow rather than a
backend redeploy.

Caching strategy:

- Cache key is ``(datastack, manifest_uri)``. Two datastacks pointing at the
  same manifest get independent cache entries — useful for the ``cache_alias``
  flow where two datastacks share underlying data but route cache reads
  separately.
- SWR semantics via ``services.swr.SwrCache``. Soft TTL ~5 min: stale
  entries are served immediately while a background thread refetches.
  Hard TTL ~1 h: bounds how long we'll serve stale data if refresh keeps
  failing — after that, the next caller pays a synchronous fetch and any
  error surfaces loudly.
- Validation is layered: manifest-level structural errors (bad YAML,
  unknown schema_version) raise hard; per-entry validation failures are
  soft — invalid rows are dropped with a logged warning, valid rows
  surface. One bad row should not take down the catalog.
"""

from __future__ import annotations

import logging
import threading
from typing import Literal

import yaml
from flask import current_app
from pydantic import BaseModel, Field, ValidationError

from .uri import fetch_bytes

logger = logging.getLogger(__name__)

SUPPORTED_SCHEMA_VERSIONS: frozenset[int] = frozenset({1})


class EmbeddingSourceRef(BaseModel):
    """How the backend finds a single embedding's underlying data.

    v1 only ships ``kind: parquet``. A future catalog service would add
    ``kind: catalog`` (or similar) without changing this file's downstream
    consumers — the loader dispatches on ``kind``.
    """

    kind: Literal["parquet"]
    uri: str


class EmbeddingAudit(BaseModel):
    """Names of optional audit columns in the parquet.

    When set, the SPA's cell-detail tooltip surfaces ``source_root_id`` and
    ``source_mat_version`` so a user can see which root_id the features
    were computed against — useful when the parquet is months older than
    the materialization the user is currently looking at.
    """

    source_root_column: str | None = None
    source_mat_version_column: str | None = None


class EmbeddingSpec(BaseModel):
    """One entry in the manifest's ``embeddings:`` list.

    All knobs the explorer needs to render this embedding. The split
    between ``feature_columns`` and ``categorical_columns`` is important:

    - ``feature_columns`` are the numeric features eligible for kNN +
      range filtering. If omitted, the loader will default to "every
      non-axis numeric column".
    - ``categorical_columns`` are *not* eligible for kNN; they're surfaced
      for color-by and equality filters.

    ``axes`` must be exactly two columns (2D scatter). Higher-dimensional
    embeddings would need a different visualization and a different spec
    shape.
    """

    id: str
    title: str
    description: str | None = None
    source: EmbeddingSourceRef
    id_column: str = "cell_id"
    axes: list[str] = Field(min_length=2, max_length=2)
    default_color_by: str | None = None
    # `None` is a sentinel that means "infer from the parquet at load time
    # (every non-axis non-audit numeric column)". An empty list explicitly
    # disables kNN for this embedding (the picker still works for color/filter
    # over `categorical_columns` only).
    feature_columns: list[str] | None = None
    categorical_columns: list[str] = Field(default_factory=list)
    audit: EmbeddingAudit | None = None


class KnnDefaults(BaseModel):
    """Manifest-level kNN configuration. Applies to every embedding in the
    manifest unless an embedding overrides individual fields (not in v1)."""

    default_k: int = 25
    max_k: int = 200
    standardize: bool = True


class Manifest(BaseModel):
    """Parsed + validated manifest."""

    schema_version: int
    knn: KnnDefaults = Field(default_factory=KnnDefaults)
    embeddings: list[EmbeddingSpec]


def fetch_and_parse_manifest(uri: str, *, project: str | None = None) -> Manifest:
    """Fetch the manifest at ``uri``, parse YAML, validate, return a ``Manifest``.

    Hard-fail conditions (raise ``ValueError``):

    - Bytes don't parse as YAML.
    - Top-level isn't a mapping.
    - ``schema_version`` is missing or not in ``SUPPORTED_SCHEMA_VERSIONS``.
    - ``embeddings`` is present but isn't a list.

    Soft-fail conditions (skip with a warning, keep going):

    - An individual entry in ``embeddings`` fails Pydantic validation.
    - Two entries share an ``id`` (first wins).
    - The ``knn`` block fails validation (falls back to ``KnnDefaults()``).

    The caller (typically the SWR cache wrapper) decides whether to
    propagate a hard failure: cold path → propagate (so a misconfigured
    manifest_uri is visible); background refresh → swallow + log + keep
    the stale entry.
    """
    body = fetch_bytes(uri, project=project)

    try:
        data = yaml.safe_load(body)
    except yaml.YAMLError as e:
        raise ValueError(f"manifest at {uri!r} is not valid YAML: {e}") from e

    if not isinstance(data, dict):
        raise ValueError(
            f"manifest at {uri!r} did not parse as a mapping "
            f"(got {type(data).__name__})"
        )

    schema_version = data.get("schema_version")
    if schema_version not in SUPPORTED_SCHEMA_VERSIONS:
        raise ValueError(
            f"manifest at {uri!r}: unsupported schema_version={schema_version!r} "
            f"(supported: {sorted(SUPPORTED_SCHEMA_VERSIONS)})"
        )

    raw_embeddings = data.get("embeddings") or []
    if not isinstance(raw_embeddings, list):
        raise ValueError(
            f"manifest at {uri!r}: `embeddings` must be a list, "
            f"got {type(raw_embeddings).__name__}"
        )

    valid: list[EmbeddingSpec] = []
    seen_ids: set[str] = set()
    for i, entry in enumerate(raw_embeddings):
        try:
            spec = EmbeddingSpec.model_validate(entry)
        except ValidationError as e:
            logger.warning(
                "manifest %s: skipping embedding entry %d (%s)", uri, i, e
            )
            continue
        if spec.id in seen_ids:
            logger.warning(
                "manifest %s: duplicate embedding id %r, keeping first occurrence",
                uri, spec.id,
            )
            continue
        seen_ids.add(spec.id)
        valid.append(spec)

    try:
        knn = KnnDefaults.model_validate(data.get("knn") or {})
    except ValidationError as e:
        logger.warning(
            "manifest %s: `knn` block invalid (%s); falling back to defaults",
            uri, e,
        )
        knn = KnnDefaults()

    return Manifest(schema_version=schema_version, knn=knn, embeddings=valid)


def get_manifest(
    datastack: str, uri: str, *, project: str | None = None
) -> Manifest:
    """Return the manifest, cached.

    Cache hit, fresh: return immediately. Cache hit, stale: return
    immediately and schedule a background refresh. Cache miss: synchronous
    fetch; first-fetch errors propagate so a misconfigured manifest_uri
    is obvious from the very first request.

    When no cache is registered on the app (e.g. unit-test context with
    no full app-context setup), falls through to a direct fetch every
    time.
    """
    cache = current_app.extensions.get("dcv_embedding_manifest_cache")
    if cache is None:
        return fetch_and_parse_manifest(uri, project=project)

    key = (datastack, uri)
    hit = cache.get(key)
    if hit is None:
        # Cold path: synchronous fetch. Any error here is a configuration
        # problem the operator needs to see immediately.
        manifest = fetch_and_parse_manifest(uri, project=project)
        cache.set(key, manifest)
        return manifest

    value, freshness = hit
    if freshness == "stale":
        _schedule_refresh(cache, key, uri, project=project)
    return value


def _schedule_refresh(cache, key, uri: str, *, project: str | None) -> None:
    """Refresh a stale manifest entry in a daemon thread.

    Manifests are small + infrequent, so a per-refresh daemon thread is
    fine — no need for a dedicated executor. Failures are logged and the
    stale entry stays in place; we never wipe a stale entry just because
    refresh failed (a transient GCS hiccup shouldn't surface as a broken
    /embeddings to the SPA).
    """

    def _refresh() -> None:
        try:
            manifest = fetch_and_parse_manifest(uri, project=project)
            cache.set(key, manifest)
        except Exception as e:  # broad on purpose: this is a daemon
            logger.warning(
                "manifest %s: background refresh failed (%s); keeping stale entry",
                uri, e,
            )

    threading.Thread(
        target=_refresh, daemon=True, name="cdv-manifest-refresh"
    ).start()
