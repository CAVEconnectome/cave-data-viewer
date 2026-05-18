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
# view (EmbeddingSpec). v3 adds an optional top-level ``datastacks:`` list
# declaring the datastacks this manifest spans — empty/absent means
# "single-ds, parent datastack" and is the default for v2 → v3 upgrades.
# The lift is forward-compatible: v2 manifests load under v3 semantics
# unchanged because the new field is optional.
SUPPORTED_SCHEMA_VERSIONS: frozenset[int] = frozenset({2, 3})


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


class FeatureCategorySpec(BaseModel):
    """A named subset of a feature table's columns, used purely for UI
    organization (channel-picker optgroups, "+ add plot" menus, bulk
    select/deselect).

    ``columns`` references bare parquet column names — the same namespace
    ``feature_columns`` and ``categorical_columns`` live in. A column may
    appear in multiple categories (overlap is allowed and useful: a depth
    column can sit in both ``morphology`` and ``spatial``). Columns not
    listed in any category render under an implicit "Uncategorized" group
    on the frontend; categories that reference columns not present in
    the parquet are pruned at the picker layer with a warning.

    No backend semantics depend on categories — they're projected through
    ``_feature_table_summary`` and consumed by the SPA's picker UI. That
    keeps the manifest one-way: edit categories in GCS, reload the
    catalog, organization updates without a redeploy.
    """

    id: str
    title: str
    description: str | None = None
    columns: list[str] = Field(default_factory=list)


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

    ``spatial_columns`` declares which numeric columns have a spatial
    interpretation — coordinates, depths, distances, radial offsets.
    Overlaps with ``feature_columns`` the way ``depth_columns`` does
    (a spatial column is still a feature and participates in kNN /
    range filtering). Reserved for UI groupings and future
    spatial-aware visualizations — the rendering pipeline doesn't
    consume the field yet, but the scaffold script populates it via
    name heuristics (``*_x`` / ``*_y`` / ``*_z`` suffixes, ``radial_*``
    / ``*_dist*`` patterns, anything that ends up in ``depth_columns``).

    ``depth_columns`` declares which numeric columns are
    depth-shaped — a *special case* of spatial that the rendering
    pipeline does consume: when a depth column is bound to a plot's
    axis, the renderer auto-flips the axis and overlays layer-boundary
    markers (the same machinery the connectivity-side plots use, via
    ``services/plots.py::_is_depth_column``). Every column in
    ``depth_columns`` SHOULD also appear in ``spatial_columns`` — the
    loader doesn't enforce this today, but consumers may rely on the
    invariant later.
    """

    id: str
    title: str
    description: str | None = None
    source: FeatureTableSourceRef
    id_column: str = "cell_id"
    feature_columns: list[str] | None = None
    categorical_columns: list[str] = Field(default_factory=list)
    spatial_columns: list[str] = Field(default_factory=list)
    depth_columns: list[str] = Field(default_factory=list)
    audit: FeatureTableAudit | None = None
    categories: list[FeatureCategorySpec] = Field(default_factory=list)
    embeddings: list[EmbeddingSpec] = Field(default_factory=list)


class KnnDefaults(BaseModel):
    """Manifest-level similarity configuration. Applies to every embedding
    in the manifest.

    Wire key is ``knn:`` for backward compatibility with manifest YAMLs
    in the wild — the block predates the kNN→distance_to_set rewrite.
    The fields control the standardization + outlier-handling pipeline
    that drives both raw-space distance and the PCA / Mahalanobis
    projections.

    The intent of exposing ``scaling`` and ``clip_percentiles`` in the
    manifest (rather than baking tool defaults into the code) is to let
    each feature dataset's similarity behavior match the conventions
    of its source — a parquet whose features were generated by a paper
    using robust scaling can declare ``scaling: robust`` and have the
    explorer compute similarity *the way the paper assumed it would*,
    not the way the tool's defaults happen to land."""

    # Standardization mode applied to numeric features before any
    # similarity computation. Authoritative values match the
    # ``Scaling`` enum in services/embeddings/feature_matrix.py.
    # Default ``zscore`` matches the conventional PCA pipeline and
    # what the explorer used historically.
    scaling: Literal["zscore", "robust", "percentile", "raw"] = "zscore"

    # Legacy boolean — kept so manifests authored before ``scaling``
    # existed still validate. When ``scaling`` is left at its default
    # and this field is ``false``, the endpoint translates that to
    # ``scaling: raw``; otherwise the explicit ``scaling`` value wins.
    standardize: bool = True

    # Per-feature winsorize bounds applied before computing the
    # standardization stats and before the PCA SVD. A single
    # biological / segmentation outlier (e.g. a soma_volume_um that
    # came back as 1e6 for one cell) otherwise inflates that feature's
    # spread by orders of magnitude and lets PCA fixate on the outlier
    # direction. The clip is *stats-only*: outlier cells stay in the
    # matrix at their actual standardized values, so they remain
    # findable in similarity space — they just no longer distort the
    # standardization or PCA components everyone else sees.
    #
    # No-op under ``scaling: percentile`` (the transform is already
    # nonparametric / bounded) and ``scaling: raw`` (the matrix isn't
    # standardized). Set to ``null`` in a manifest to disable when
    # the input parquet is known to be clean. (0.1, 99.9) is the
    # empirically-validated default for connectomics morphology
    # features.
    clip_percentiles: tuple[float, float] | None = (0.1, 99.9)


class DatastackEntry(BaseModel):
    """One datastack participating in a manifest.

    Phase 1 of the multi-dataset generalization uses only ``name``; the
    field exists so a single-ds manifest can be authored explicitly
    (``datastacks: [{name: foo}]``) and so the loader has a stable place
    to read per-ds metadata when phase 2 adds ``cell_id_source_table``
    overrides and decoration-column aliases.

    ``cell_id_source_table``, when set, overrides the parent datastack
    YAML's ``feature_explorer.cell_id_source_table``. Multi-ds manifests
    need this because the datastack YAML can only declare one source
    table per datastack — but a joint manifest can span datastacks with
    different source tables, and the per-row resolution path needs to
    pick the right one. Not exercised by the v1 single-ds endpoints
    (phase 1 keeps them on the YAML-declared value); the field is in
    place for phase 2.
    """

    name: str
    cell_id_source_table: str | None = None


class Manifest(BaseModel):
    """Parsed + validated manifest.

    ``datastacks`` declares the set of datastacks this manifest spans.
    Empty list (the default, and the v2-manifest shape) means "single-ds,
    inferred from the parent datastack that referenced this manifest" —
    every consumer that needs the effective list passes the parent
    datastack name through :func:`effective_datastacks`. Multi-ds
    manifests (phase 2) list each participant explicitly.
    """

    schema_version: int
    datastacks: list[DatastackEntry] = Field(default_factory=list)
    knn: KnnDefaults = Field(default_factory=KnnDefaults)
    feature_tables: list[FeatureTableSpec]


def effective_datastacks(
    manifest: Manifest, parent_datastack: str
) -> list[DatastackEntry]:
    """Return the declared datastacks, defaulting to ``[parent_datastack]``.

    Single-ds (or v2) manifests omit the ``datastacks`` block; this helper
    fills in the implicit single-element list so downstream code can
    treat every manifest as having an explicit datastack set.
    """
    if manifest.datastacks:
        return manifest.datastacks
    return [DatastackEntry(name=parent_datastack)]


def effective_cell_id_source_table(
    manifest: Manifest, datastack: str, fallback: str | None
) -> str | None:
    """Pick the cell_id source table for a given datastack within this manifest.

    Precedence: manifest's per-datastack override > datastack YAML's
    ``feature_explorer.cell_id_source_table`` (``fallback``). The YAML
    field stays the canonical place to declare it for the single-ds
    case; the manifest override exists for joint manifests where one
    datastack YAML can't represent the right source for every row.
    """
    for entry in manifest.datastacks:
        if entry.name == datastack and entry.cell_id_source_table:
            return entry.cell_id_source_table
    return fallback


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

    datastacks = _coerce_datastacks(data.get("datastacks"), manifest_uri=uri)

    return Manifest(
        schema_version=schema_version,
        datastacks=datastacks,
        knn=knn,
        feature_tables=valid,
    )


def _coerce_datastacks(
    raw, *, manifest_uri: str
) -> list[DatastackEntry]:
    """Parse the optional ``datastacks:`` block into ``DatastackEntry`` rows.

    YAML ergonomics: a participant may be written as a bare name string
    (``- minnie65_public``) or as a mapping (``- {name: minnie65_public,
    cell_id_source_table: nucleus_detection_v0}``). Both forms coerce to
    the same model. An invalid entry is dropped with a warning (mirrors
    the soft-fail policy for feature_tables / embeddings).

    Returns an empty list when ``raw`` is absent / null; the caller falls
    back to ``[parent_datastack]`` via :func:`effective_datastacks`.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        logger.warning(
            "manifest %s: `datastacks` must be a list, got %s; ignoring",
            manifest_uri, type(raw).__name__,
        )
        return []

    valid: list[DatastackEntry] = []
    seen: set[str] = set()
    for i, item in enumerate(raw):
        if isinstance(item, str):
            payload = {"name": item}
        elif isinstance(item, dict):
            payload = item
        else:
            logger.warning(
                "manifest %s: skipping datastacks entry %d "
                "(expected str or mapping, got %s)",
                manifest_uri, i, type(item).__name__,
            )
            continue
        try:
            entry = DatastackEntry.model_validate(payload)
        except ValidationError as e:
            logger.warning(
                "manifest %s: skipping datastacks entry %d (%s)",
                manifest_uri, i, e,
            )
            continue
        if entry.name in seen:
            logger.warning(
                "manifest %s: duplicate datastacks entry %r, keeping first",
                manifest_uri, entry.name,
            )
            continue
        seen.add(entry.name)
        valid.append(entry)
    return valid


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
    raw_categories = entry.get("categories") or []
    skeleton = {
        k: v for k, v in entry.items() if k not in ("embeddings", "categories")
    }
    # Validate the parent (with embeddings/categories=[] so the model
    # fields are present); we'll attach the validated lists below.
    parent = FeatureTableSpec.model_validate(
        {**skeleton, "embeddings": [], "categories": []}
    )

    valid_categories: list[FeatureCategorySpec] = []
    seen_cat_ids: set[str] = set()
    for j, raw in enumerate(raw_categories):
        try:
            cat = FeatureCategorySpec.model_validate(raw)
        except ValidationError as e:
            logger.warning(
                "manifest %s: feature_table %r — skipping categories entry %d (%s)",
                manifest_uri, parent.id, j, e,
            )
            continue
        if cat.id in seen_cat_ids:
            logger.warning(
                "manifest %s: feature_table %r — duplicate category id %r, "
                "keeping first occurrence",
                manifest_uri, parent.id, cat.id,
            )
            continue
        seen_cat_ids.add(cat.id)
        valid_categories.append(cat)

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

    return parent.model_copy(
        update={"embeddings": valid_embeddings, "categories": valid_categories}
    )


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
