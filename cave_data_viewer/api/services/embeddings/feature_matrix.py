"""Standardized feature matrix for one embedding table.

The Feature Explorer's similarity tooling (distance-to-set, top-K growth,
correlation correction) all read from the same standardized feature matrix.
Each request sweeps the whole universe vectorized rather than doing
single-seed k-nearest tree lookups, so we no longer hold a KDTree — the
matrix + a row-to-cell-id index is enough.

The cache shape mirrors what ``knn.py`` used to provide: built at most
once per ``(datastack, feature_table, feature_subset)``, L1-only (the
parquet frame underneath is the expensive cache, and it is itself L2
GCS-backed).

Why z-scoring lives here, not deferred:

- Every space (raw / pca / mahalanobis) operates on a standardized matrix.
  Raw distance is z-scored Euclidean; PCA and Mahalanobis whiten on top
  of that. Pushing the z-score into the cached object means every
  downstream consumer gets exactly the same scaling and the same
  null-handling rules.
- A zero-variance column is treated as ``std=1`` so its scaled values are
  zero, contributing nothing to distance. Matches the previous KDTree
  module's behavior; the alternative — refusing to build — is worse.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from hashlib import blake2b
from typing import Literal, Sequence

import numpy as np
import pandas as pd
from flask import current_app

from .loader import load_feature_table_frame
from .manifest import FeatureTableSpec
from ..timing import record_stage, timer

logger = logging.getLogger(__name__)


# Standardization modes the matrix layer supports. Authoritative list —
# the manifest schema mirrors these strings and the endpoint validates
# against them at the wire boundary.
#
# - ``zscore``     — (x - mean) / std. Mean/std computed from the
#                    clipped universe (see ``clip_percentiles``);
#                    original values then standardized with the robust
#                    stats. Default; matches the typical PCA pipeline.
# - ``robust``     — (x - median) / IQR. Already outlier-robust at the
#                    stat-computation level; clipping still helps the
#                    PCA fit but matters less. Useful when the feature
#                    distribution is heavy-tailed but not pathological.
# - ``percentile`` — each value → its per-feature percentile rank in
#                    the universe (0..1). Fully nonparametric; outliers
#                    collapse to their rank position. PCA fit doesn't
#                    need pre-clip because the output is bounded.
# - ``raw``        — no standardization. ``loc=0``, ``scale=1``, no clip.
#                    For matrices that are already pre-standardized by
#                    an upstream pipeline.
Scaling = Literal["zscore", "robust", "percentile", "raw"]


@dataclass
class EmbeddingMatrix:
    """Cached standardized feature matrix for one feature-table subset.

    ``X`` is shape ``(n_cells, n_features)`` after dropping rows with any
    null in ``feature_columns``. ``cell_ids`` and ``cell_id_to_row`` align
    that surviving subset back to cell-id space.

    ``loc`` / ``scale`` are the location + scale parameters of the
    active ``scaling`` mode. Their semantic depends on the mode:

    - ``zscore``     → ``loc=mean``, ``scale=std`` (both computed from
                       the clipped universe).
    - ``robust``     → ``loc=median``, ``scale=IQR``.
    - ``percentile`` → ``loc=0``, ``scale=1`` (vacuous — the percentile
                       transform is nonparametric, no per-feature
                       params to undo).
    - ``raw``        → ``loc=0``, ``scale=1``.

    ``clip_lo`` / ``clip_hi`` are per-feature winsorize bounds in
    **original feature space**, applied only to the values that drive
    the ``loc`` / ``scale`` computation — every cell's actual feature
    value is kept in ``X`` and standardized with those robust stats.
    Outlier cells therefore retain their identity in the similarity
    space (they show up with large standardized values), but the
    standardization itself isn't distorted by them. The downstream
    PCA fit re-applies the equivalent clipping in standardized space
    before SVD (for zscore / robust modes; percentile is already
    bounded so the pre-PCA clip is a no-op).

    ``feature_columns`` is the *resolved* tuple — manifest default or
    request override — so consumers don't have to re-resolve.
    """

    X: np.ndarray  # (n, d), standardized per ``scaling``
    cell_ids: np.ndarray  # (n,) int
    cell_id_to_row: dict[int, int]
    loc: np.ndarray  # (d,) — location param; semantic depends on scaling
    scale: np.ndarray  # (d,) — scale param; semantic depends on scaling
    # Per-feature winsorize bounds in ORIGINAL space, retained for the
    # downstream PCA fit (which derives equivalent bounds in
    # standardized space and clips before SVD). Both ``None`` when
    # clipping is disabled or scaling is ``percentile`` / ``raw``.
    clip_lo: np.ndarray | None
    clip_hi: np.ndarray | None
    scaling: Scaling
    feature_columns: tuple[str, ...]
    # Original ``clip_percentiles`` argument used to build this matrix,
    # retained so downstream caches (e.g. the PCA SVD) can derive a
    # digest that matches the matrix's own cache key. Distinct from
    # ``clip_lo`` / ``clip_hi``, which are the *resolved* per-feature
    # bounds in original space.
    clip_percentiles: tuple[float, float] | None


# Default winsorize bounds applied before z-scoring. A single biological
# outlier (e.g. a segmentation glitch yielding soma_volume_um in the
# millions for one cell) can inflate that feature's std by orders of
# magnitude, compressing every other cell to near-zero z-score and
# letting PCA fixate on the outlier's direction. Clipping the top and
# bottom 0.1% of each feature before computing mean/std keeps the
# standardization stats representative of the bulk distribution. The
# outlier cells stay in the matrix — their values get clamped to the
# percentile boundary, not dropped — so they're still findable in the
# similarity space, just no longer distorting it.
#
# Empirical: in the user's connectomics workflow, clipping is the
# critical step (more so than the choice of mean/std vs median/IQR
# scaling). Set ``clip_percentiles=None`` to disable when the input
# is already known to be clean.
DEFAULT_CLIP_PERCENTILES: tuple[float, float] = (0.1, 99.9)


def build_matrix(
    frame: pd.DataFrame,
    *,
    id_column: str,
    feature_columns: Sequence[str],
    scaling: Scaling = "zscore",
    clip_percentiles: tuple[float, float] | None = DEFAULT_CLIP_PERCENTILES,
) -> EmbeddingMatrix:
    """Construct an :class:`EmbeddingMatrix` from a cached parquet frame.

    Rows with any null in ``feature_columns`` are dropped — they can't
    participate in distance computations regardless, and including them
    would either crash linear algebra calls or produce nonsense.

    ``scaling`` selects the standardization mode (see the :type:`Scaling`
    enum for semantics). For ``zscore`` and ``robust`` modes, the
    ``clip_percentiles`` winsorize the universe values that drive the
    location/scale computation; the original cell values then get
    standardized with those robust stats. For ``percentile`` mode the
    transform itself is nonparametric (rank-based, output bounded
    [0, 1]) so clipping is silently no-op'd. For ``raw`` mode neither
    standardization nor clipping is applied.

    A feature column with zero variance is given ``scale=1`` so its
    standardized values are zero. Matches ``sklearn.StandardScaler``
    for degenerate columns.
    """
    missing = [c for c in feature_columns if c not in frame.columns]
    if missing:
        raise ValueError(
            f"feature columns not in frame: {missing} "
            f"(available: {list(frame.columns)})"
        )
    if id_column not in frame.columns:
        raise ValueError(f"id_column {id_column!r} not in frame")

    sub = frame[[id_column, *feature_columns]].dropna()
    if len(sub) == 0:
        raise ValueError(
            "no rows survive null filtering — every cell has at least one "
            "null feature value across the requested feature_columns"
        )

    cell_ids = sub[id_column].to_numpy()
    X = sub[list(feature_columns)].to_numpy(dtype=np.float64)
    n, d = X.shape

    # Clipping is meaningful only for parametric scalings (zscore,
    # robust) where the stat computation can be distorted by outliers.
    # Percentile and raw modes don't carry meaningful clip state.
    clip_lo: np.ndarray | None = None
    clip_hi: np.ndarray | None = None
    clip_for_stats = (
        scaling in ("zscore", "robust") and clip_percentiles is not None
    )
    if clip_for_stats:
        assert clip_percentiles is not None  # narrowed by guard
        lo_pct, hi_pct = clip_percentiles
        if not (0.0 <= lo_pct < hi_pct <= 100.0):
            raise ValueError(
                f"clip_percentiles must be a (lo, hi) pair with "
                f"0 <= lo < hi <= 100; got {clip_percentiles}"
            )
        clip_lo = np.percentile(X, lo_pct, axis=0)
        clip_hi = np.percentile(X, hi_pct, axis=0)

    if scaling == "zscore":
        X_for_stats = (
            np.clip(X, clip_lo, clip_hi)
            if clip_for_stats
            else X
        )
        loc = X_for_stats.mean(axis=0)
        scale = X_for_stats.std(axis=0)
        scale_safe = np.where(scale == 0, 1.0, scale)
        X = (X - loc) / scale_safe
    elif scaling == "robust":
        X_for_stats = (
            np.clip(X, clip_lo, clip_hi)
            if clip_for_stats
            else X
        )
        loc = np.median(X_for_stats, axis=0)
        q1 = np.percentile(X_for_stats, 25, axis=0)
        q3 = np.percentile(X_for_stats, 75, axis=0)
        scale = q3 - q1
        scale_safe = np.where(scale == 0, 1.0, scale)
        X = (X - loc) / scale_safe
    elif scaling == "percentile":
        # Per-feature rank-percentile transform. ``argsort.argsort``
        # gives the rank index (0..n-1); +1 then /n maps to (0, 1].
        # Ties get sequential ranks (consistent with numpy's default);
        # for our usage that's fine — tie-breaking doesn't materially
        # change distance computations downstream.
        ranks = X.argsort(axis=0).argsort(axis=0).astype(np.float64) + 1.0
        X = ranks / n
        loc = np.zeros(d)
        scale = np.ones(d)
    elif scaling == "raw":
        loc = np.zeros(d)
        scale = np.ones(d)
    else:
        raise ValueError(f"unknown scaling: {scaling!r}")

    row_map = {int(cid): i for i, cid in enumerate(cell_ids)}
    return EmbeddingMatrix(
        X=X,
        cell_ids=cell_ids,
        cell_id_to_row=row_map,
        loc=loc,
        scale=scale,
        clip_lo=clip_lo,
        clip_hi=clip_hi,
        scaling=scaling,
        feature_columns=tuple(feature_columns),
        clip_percentiles=clip_percentiles,
    )


def feature_subset_digest(
    feature_columns: Sequence[str],
    *,
    scaling: Scaling = "zscore",
    clip_percentiles: tuple[float, float] | None = DEFAULT_CLIP_PERCENTILES,
) -> str:
    """Stable digest for cache keys. Identical column lists hash the same
    regardless of how the caller assembled them; different
    ``scaling`` / ``clip_percentiles`` settings produce different
    digests so they cache separately.

    Order matters — column order changes the column index assignment in
    the SVD / distance computations downstream, so two callers that pass
    the same columns in different orders genuinely need separate caches.
    """
    raw = ",".join(feature_columns).encode() + f"|sc:{scaling}".encode()
    if clip_percentiles is None:
        raw += b"|clip:none"
    else:
        lo, hi = clip_percentiles
        raw += f"|clip:{lo:.3f},{hi:.3f}".encode()
    return blake2b(raw, digest_size=8).hexdigest()


def get_matrix(
    datastack: str,
    ft: FeatureTableSpec,
    *,
    feature_columns: Sequence[str] | None = None,
    scaling: Scaling = "zscore",
    clip_percentiles: tuple[float, float] | None = DEFAULT_CLIP_PERCENTILES,
    cache_ds: str | None = None,
) -> EmbeddingMatrix:
    """Cached lookup for one ``(feature_table, feature_subset)`` matrix.

    Resolution order for ``feature_columns``:

    1. Explicit argument (endpoint passes the request body's
       ``feature_columns`` here when set).
    2. Manifest-declared ``ft.feature_columns``.
    3. Auto-derived: every numeric column on the loaded frame that isn't
       the id column, an embedding axis, or an audit column.

    The cache key incorporates the column digest + standardize +
    clip_percentiles so distinct (columns, standardization, clip)
    triples cache separately — a manifest that bumps clipping from
    (0.1, 99.9) to (1, 99) routes to a fresh entry without colliding
    with anyone reading the prior setting.
    """
    cache_ds = cache_ds or datastack

    df = load_feature_table_frame(datastack, ft, cache_ds=cache_ds)

    if feature_columns is not None:
        cols = list(feature_columns)
    elif ft.feature_columns is not None:
        cols = list(ft.feature_columns)
    else:
        cols = _default_feature_columns(df, ft)

    if len(cols) < 2:
        # Distance / PCA paths need at least two features. The endpoint
        # also validates this at the request boundary, but enforcing
        # here closes the bypass for callers that go through
        # _default_feature_columns and could otherwise reach a 1-column
        # matrix that then crashes downstream (np.linalg.svd on a
        # single column is degenerate, distance math becomes |x - y|
        # which is fine in isolation but breaks the variance / k_pca
        # semantics every consumer assumes).
        raise ValueError(
            f"feature_table {ft.id!r}: need at least 2 feature columns "
            f"to build a matrix, got {len(cols)}"
        )

    digest = feature_subset_digest(
        cols, scaling=scaling, clip_percentiles=clip_percentiles
    )
    key = (cache_ds, ft.id, digest)

    cache = current_app.extensions.get("dcv_embedding_matrix_cache")
    if cache is not None:
        t0 = time.perf_counter()
        hit = cache.get(key)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if hit is not None:
            value, _ = hit
            # Use the `_l1_hit` suffix convention so this rolls up
            # alongside synapse / decoration L1 hits in the request
            # log's cache classification.
            record_stage("embedding_matrix_l1_hit", elapsed_ms)
            logger.debug(
                "embedding_matrix cache hit ds=%s ft=%s in %.1fms",
                cache_ds, ft.id, elapsed_ms,
            )
            return value

    with timer("embedding_matrix_build"):
        t0 = time.perf_counter()
        matrix = build_matrix(
            df,
            id_column=ft.id_column,
            feature_columns=cols,
            scaling=scaling,
            clip_percentiles=clip_percentiles,
        )
        build_ms = (time.perf_counter() - t0) * 1000.0
        logger.info(
            "built embedding_matrix ds=%s ft=%s n=%d k_features=%d in %.1fms",
            cache_ds, ft.id, len(matrix.cell_ids), len(cols), build_ms,
        )
    if cache is not None:
        cache.set(key, matrix)
    return matrix


def _default_feature_columns(df: pd.DataFrame, ft: FeatureTableSpec) -> list[str]:
    """Auto-derive feature columns when neither the call site nor the
    manifest names any. Every numeric column that isn't the id, an axis
    of any embedding on this table, an audit column, or a runtime-
    injected synthetic column qualifies.

    Booleans are excluded — picker-friendly for filter/color but useless
    for euclidean distance.

    ``nucleus.*`` columns are excluded: they're added by
    :meth:`FeatureTableQuery.frame` from the universe cache as a
    plotting/coloring convenience, not as feature data. Including them
    in a default distance computation lets cells' physical separation
    swamp every morphological / functional signal — two cells that are
    biologically identical but on opposite sides of the volume are
    ~1500µm apart in z, which dominates the Euclidean sum. Users who
    actually want spatial similarity can opt them in via an explicit
    ``feature_columns`` request body or by selecting them in the SPA's
    "Features in distance" picker.
    """
    excluded: set[str] = {ft.id_column}
    for emb in ft.embeddings:
        excluded.update(emb.axes)
    if ft.audit:
        if ft.audit.source_root_column:
            excluded.add(ft.audit.source_root_column)
        if ft.audit.source_mat_version_column:
            excluded.add(ft.audit.source_mat_version_column)
    return [
        c
        for c in df.columns
        if c not in excluded
        and not c.startswith("nucleus.")
        and pd.api.types.is_numeric_dtype(df[c])
        and not pd.api.types.is_bool_dtype(df[c])
    ]
