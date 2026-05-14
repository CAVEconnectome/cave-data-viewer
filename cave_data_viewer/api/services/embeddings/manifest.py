"""Feature-table catalog manifest: schema, fetch, parse, validate, SWR cache.

The manifest is a single YAML file in GCS (or anywhere the URI resolver can
reach) that describes the feature dataframes available for a datastack and
the embeddings declared over each one. The datastack YAML carries only
``manifest_uri:`` — the catalog lives here, so adding a new feature table or
embedding is an edit-in-GCS workflow rather than a backend redeploy.

Schema v2 separates **data** (a feature table — the parquet, id column,
feature columns, categoricals, etc.) from **view** (embeddings — pairs of
axis columns over that data). One feature table can declare multiple
embeddings: a whole-population UMAP, an inhibitory-only UMAP computed over
a subset, a t-SNE, etc. Embeddings share the table's rows + features; only
the axes (and optionally a kNN-feature override) differ.

Caching strategy:

- Cache key is ``(datastack, manifest_uri)``. Two datastacks pointing at the
  same manifest get independent cache entries — useful for the ``cache_alias``
  flow where two datastacks share underlying data but route cache reads
  separately.
- SWR semantics via ``services.swr.SwrCache``. Soft TTL ~5 min: stale
  entries are served immediately while a background thread refetches.
  Hard TTL ~1 h bounds how long we'll serve stale data if refresh keeps
  failing — after that, the next caller pays a synchronous fetch and any
  error surfaces loudly.
- Validation is layered: manifest-level structural errors (bad YAML,
  unknown schema_version) raise hard; per-entry validation failures are
  soft — invalid feature_tables / embeddings are dropped with a logged
  warning, valid ones surface. One bad row should not take down the
  catalog.
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

# v1 was a flat ``embeddings:`` list with each entry carrying its own
# source/id_column/feature_columns. v2 splits data (FeatureTableSpec) from
# view (EmbeddingSpec). No real users on v1 yet, so no migration path —
# the manifests in the repo and on GCS get updated to v2 directly.
SUPPORTED_SCHEMA_VERSIONS: frozenset[int] = frozenset({2})


class FeatureTableSourceRef(BaseModel):
    """How the backend finds a feature table's underlying data.

    v1 only ships ``kind: parquet``. A future catalog service would add
    ``kind: catalog`` (or similar) without changing this file's downstream
    consumers — the loader dispatches on ``kind``.
    """

    kind: Literal["parquet"]
    uri: str


class FeatureTableAudit(BaseModel):
    """Names of optional audit columns in the parquet.

    When set, the SPA's cell-detail tooltip surfaces ``source_root_id`` and
    ``source_mat_version`` so a user can see which root_id the features
    were computed against — useful when the parquet is months older than
    the materialization the user is currently looking at.
    """

    source_root_column: str | None = None
    source_mat_version_column: str | None = None


class EmbeddingSpec(BaseModel):
    """One ``embeddings:`` entry under a feature table. Describes a single
    2D scatter view onto the table's rows.

    Multiple embeddings per table are the point of the v2 schema: one
    feature dataframe can have a whole-population UMAP + an
    inhibitory-only UMAP + a t-SNE, all sharing rows, features, and
    decorations.

    Display-level only — the data (id column, feature columns, source
    parquet) lives on the parent ``FeatureTableSpec``.

    ``axes`` must be exactly two columns (2D scatter). Cells with null
    values in either axis column are dropped from the scatter naturally
    by plotly; that's the mechanism for subset embeddings like
    "inhibitory only" (non-inhibitory cells get null axes in the
    parquet).

    ``knn_features`` overrides the parent table's ``feature_columns`` for
    kNN computed on this embedding. Useful when the embedding was built
    over a feature subset (e.g. inhibitory-relevant features) and kNN
    should use the same subset for consistency. ``None`` (default) →
    inherit the table's ``feature_columns``.

    ``depth_axis`` names which axis (if any) is depth-shaped so plots.py
    can flip the axis + add layer markers automatically. Typically null —
    UMAP axes aren't depth-shaped — but a scatter binding the user picks
    over a real depth column will surface depth-axis treatment through
    the same machinery the connectivity plots use.
    """

    id: str
    title: str
    description: str | None = None
    axes: list[str] = Field(min_length=2, max_length=2)
    default_color_by: str | None = None
    knn_features: list[str] | None = None
    depth_axis: Literal["x", "y", None] = None


class FeatureTableSpec(BaseModel):
    """One ``feature_tables:`` entry. Owns the data (a parquet keyed by
    cell_id) plus all the columns the explorer can plot / filter / kNN
    over. Embeddings nested under this entry share the same row set and
    feature universe; they differ only in which two columns they bind
    to the axes.

    ``feature_columns`` are numeric columns eligible for kNN + range
    filtering (None → infer at load time from non-axis non-audit
    numerics). ``categorical_columns`` are usable for color and equality
    filters but are excluded from kNN by default.

    ``depth_columns`` declares which numeric columns are
    depth-shaped — when one is bound on a plot's axis the rendering
    pipeline auto-flips the axis and overlays layer-boundary markers
    (the same machinery the connectivity-side plots use, via
    ``services/plots.py::_is_depth_column``). Typically a single column
    name (e.g. ``soma_depth_y``).
    """

    id: str
    title: str
    description: str | None = None
    source: FeatureTableSourceRef
    id_column: str = "cell_id"
    feature_columns: list[str] | None = None
    categorical_columns: list[str] = Field(default_factory=list)
    depth_columns: list[str] = Field(default_factory=list)
    audit: FeatureTableAudit | None = None
    embeddings: list[EmbeddingSpec] = Field(default_factory=list)


class KnnDefaults(BaseModel):
    """Manifest-level kNN configuration. Applies to every embedding in the
    manifest unless an embedding overrides ``knn_features``."""

    default_k: int = 25
    max_k: int = 200
    standardize: bool = True


class Manifest(BaseModel):
    """Parsed + validated manifest."""

    schema_version: int
    knn: KnnDefaults = Field(default_factory=KnnDefaults)
    feature_tables: list[FeatureTableSpec]


def fetch_and_parse_manifest(uri: str, *, project: str | None = None) -> Manifest:
    """Fetch the manifest at ``uri``, parse YAML, validate, return a ``Manifest``.

    Hard-fail conditions (raise ``ValueError``):

    - Bytes don't parse as YAML.
    - Top-level isn't a mapping.
    - ``schema_version`` is missing or not in ``SUPPORTED_SCHEMA_VERSIONS``.
    - ``feature_tables`` is present but isn't a list.

    Soft-fail conditions (skip with a warning, keep going):

    - An individual feature_tables entry fails Pydantic validation.
    - Two tables share an ``id`` (first wins).
    - Two embeddings within one table share an ``id`` (first wins).
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

    raw_tables = data.get("feature_tables") or []
    if not isinstance(raw_tables, list):
        raise ValueError(
            f"manifest at {uri!r}: `feature_tables` must be a list, "
            f"got {type(raw_tables).__name__}"
        )

    valid: list[FeatureTableSpec] = []
    seen_table_ids: set[str] = set()
    for i, entry in enumerate(raw_tables):
        try:
            ft = _validate_feature_table(entry, manifest_uri=uri, index=i)
        except ValidationError as e:
            logger.warning(
                "manifest %s: skipping feature_tables entry %d (%s)", uri, i, e
            )
            continue
        if ft.id in seen_table_ids:
            logger.warning(
                "manifest %s: duplicate feature_table id %r, keeping first occurrence",
                uri, ft.id,
            )
            continue
        seen_table_ids.add(ft.id)
        valid.append(ft)

    try:
        knn = KnnDefaults.model_validate(data.get("knn") or {})
    except ValidationError as e:
        logger.warning(
            "manifest %s: `knn` block invalid (%s); falling back to defaults",
            uri, e,
        )
        knn = KnnDefaults()

    return Manifest(schema_version=schema_version, knn=knn, feature_tables=valid)


def _validate_feature_table(
    entry, *, manifest_uri: str, index: int
) -> FeatureTableSpec:
    """Validate one feature_tables entry plus its nested embeddings.

    Embeddings are validated individually; bad embeddings are dropped
    (with a logged warning) so a typo on one of them doesn't sink the
    table. Duplicate embedding ids within a table are also dropped.
    """
    # First validate the parent shape without the embeddings list — that
    # gives us a clear error if `source` or `id_column` is malformed,
    # without conflating it with embedding-entry issues.
    if not isinstance(entry, dict):
        # Surface as a ValidationError via Pydantic's own machinery so
        # the upstream handler's `except ValidationError` catches it.
        FeatureTableSpec.model_validate(entry)  # raises

    raw_embeddings = entry.get("embeddings") or []
    skeleton = {k: v for k, v in entry.items() if k != "embeddings"}
    # Validate the parent (with embeddings=[] so the model field is
    # present); we'll attach the validated embeddings below.
    parent = FeatureTableSpec.model_validate({**skeleton, "embeddings": []})

    valid_embeddings: list[EmbeddingSpec] = []
    seen_emb_ids: set[str] = set()
    for j, raw in enumerate(raw_embeddings):
        try:
            emb = EmbeddingSpec.model_validate(raw)
        except ValidationError as e:
            logger.warning(
                "manifest %s: feature_table %r — skipping embeddings entry %d (%s)",
                manifest_uri, parent.id, j, e,
            )
            continue
        if emb.id in seen_emb_ids:
            logger.warning(
                "manifest %s: feature_table %r — duplicate embedding id %r, "
                "keeping first occurrence",
                manifest_uri, parent.id, emb.id,
            )
            continue
        seen_emb_ids.add(emb.id)
        valid_embeddings.append(emb)

    return parent.model_copy(update={"embeddings": valid_embeddings})


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
        manifest = fetch_and_parse_manifest(uri, project=project)
        cache.set(key, manifest)
        return manifest

    value, freshness = hit
    if freshness == "stale":
        _schedule_refresh(cache, key, uri, project=project)
    return value


def _schedule_refresh(cache, key, uri: str, *, project: str | None) -> None:
    """Refresh a stale manifest entry in a daemon thread.

    Failures are logged and the stale entry stays in place; we never wipe
    a stale entry just because refresh failed (a transient GCS hiccup
    shouldn't surface as a broken /feature_tables to the SPA).
    """

    def _refresh() -> None:
        try:
            manifest = fetch_and_parse_manifest(uri, project=project)
            cache.set(key, manifest)
        except Exception as e:
            logger.warning(
                "manifest %s: background refresh failed (%s); keeping stale entry",
                uri, e,
            )

    threading.Thread(
        target=_refresh, daemon=True, name="cdv-manifest-refresh"
    ).start()
