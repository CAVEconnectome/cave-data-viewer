"""SVD of the standardized feature matrix, cached.

One SVD serves both similarity spaces that need decorrelation:

- **PCA top-K**: project onto the first ``k_pca`` right-singular vectors,
  measure Euclidean there. Decorrelates AND truncates noise.
- **Mahalanobis (whitened)**: project onto **all** components and divide
  each axis by its singular value. Euclidean in whitened space is
  Mahalanobis distance on the original z-scored features
  (``d² = (x − μ)ᵀ Σ⁻¹ (x − μ)`` for standardized x). No truncation, full
  correlation correction.

The cache stores the SVD output (components matrix + singular values),
not any specific projection. A request with ``k_pca=5`` and another with
``k_pca=20`` both hit the same cache entry and slice differently. This
avoids a refit when the user changes k.

No sklearn dependency — ``np.linalg.svd`` on a few-hundred-feature
matrix is fast enough and avoids a ~30MB wheel cost for two utility
functions. Mirrors the rationale in the prior knn module.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np
from flask import current_app

from .feature_matrix import EmbeddingMatrix, feature_subset_digest
from .manifest import FeatureTableSpec
from ..timing import record_stage, timer

logger = logging.getLogger(__name__)


# Singular values below ``SINGULAR_VALUE_EPS * S.max()`` are treated as
# zero when whitening. Without this guard, dividing by a near-zero
# singular value would explode the corresponding whitened axis and make
# distances diverge for any near-degenerate feature direction.
SINGULAR_VALUE_EPS = 1e-8


@dataclass
class EmbeddingPcaSvd:
    """Cached SVD of one feature matrix.

    ``components_full`` is the full ``(n_features, n_features)`` right-
    singular-vector matrix (``Vt`` transposed once for downstream use:
    each row is a component direction). ``singular_values`` aligns to
    ``components_full`` rows; the same row index gives a component and
    its variance scale.

    ``feature_columns`` is the resolved feature set the SVD was computed
    on — the same digest that keyed the cache. Stored so consumers can
    sanity-check they're projecting the right space.
    """

    components_full: np.ndarray  # (d, d), each row a component direction
    singular_values: np.ndarray  # (d,)
    feature_columns: tuple[str, ...]


def build_svd(matrix: EmbeddingMatrix) -> EmbeddingPcaSvd:
    """Run the SVD on a standardized feature matrix.

    ``matrix.X`` is already z-scored, so the SVD is effectively over
    the correlation matrix's eigenstructure (up to scale). The full
    ``components_full`` matrix is square; for typical feature tables
    (a few dozen columns) that's negligible memory.

    When the matrix carries clip bounds (the build_matrix default),
    they're translated into the standardized space and applied to a
    temporary copy of ``X`` before SVD. This keeps a handful of outlier
    cells with 50-sigma z-scores from pulling PC1 to point at them
    instead of at the bulk distribution's principal axes. The clipping
    is for-the-fit-only; ``matrix.X`` stays unmodified so downstream
    distance computations still see the cells' actual values.
    """
    X = matrix.X
    # Pre-SVD clipping helps when the standardized matrix can still
    # carry outliers — true for zscore and robust modes. For percentile
    # the output is bounded [0, 1] by construction; for raw the matrix
    # hasn't been standardized at all so the stored clip bounds (if
    # any) don't translate. Skip in those cases.
    if (
        matrix.scaling in ("zscore", "robust")
        and matrix.clip_lo is not None
        and matrix.clip_hi is not None
    ):
        scale_safe = np.where(matrix.scale == 0, 1.0, matrix.scale)
        lo_std = (matrix.clip_lo - matrix.loc) / scale_safe
        hi_std = (matrix.clip_hi - matrix.loc) / scale_safe
        # Clip in standardized space — matrix.X has had loc/scale
        # applied, so the original-space clip bounds translate the
        # same way every cell's values did.
        X = np.clip(X, lo_std, hi_std)
    # full_matrices=False keeps Vt at shape (min(n, d), d). For n >> d
    # (typical: ~94k cells × ~13 features) this is the d×d component
    # matrix we want; we just transpose so each row is a component.
    _, S, Vt = np.linalg.svd(X, full_matrices=False)
    return EmbeddingPcaSvd(
        components_full=Vt,
        singular_values=S,
        feature_columns=matrix.feature_columns,
    )


def get_pca_svd(
    cache_ds: str,
    ft: FeatureTableSpec,
    matrix: EmbeddingMatrix,
) -> EmbeddingPcaSvd:
    """Cached SVD lookup keyed on ``(cache_ds, ft_id, feature_subset_digest)``.

    The cache key intentionally omits ``k_pca`` — the cached SVD stores
    every component, and ``project_pca`` slices to k_pca at use time. A
    user toggling the k slider on the SPA gets instant re-projection.
    """
    digest = feature_subset_digest(
        matrix.feature_columns,
        scaling=matrix.scaling,
        clip_percentiles=matrix.clip_percentiles,
    )
    key = (cache_ds, ft.id, digest)

    cache = current_app.extensions.get("dcv_embedding_pca_cache")
    if cache is not None:
        t0 = time.perf_counter()
        hit = cache.get(key)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if hit is not None:
            value, _ = hit
            record_stage("embedding_pca_l1_hit", elapsed_ms)
            logger.debug(
                "embedding_pca cache hit ds=%s ft=%s in %.1fms",
                cache_ds, ft.id, elapsed_ms,
            )
            return value

    with timer("embedding_pca_build"):
        t0 = time.perf_counter()
        svd = build_svd(matrix)
        build_ms = (time.perf_counter() - t0) * 1000.0
        logger.info(
            "built embedding_pca ds=%s ft=%s d=%d in %.1fms",
            cache_ds, ft.id, len(svd.singular_values), build_ms,
        )
    if cache is not None:
        cache.set(key, svd)
    return svd


def project_pca(svd: EmbeddingPcaSvd, X: np.ndarray, k_pca: int) -> np.ndarray:
    """Project ``X`` (shape ``(_, d)``) onto the top-``k_pca`` components.

    ``k_pca`` is clamped to the available component count so callers can
    pass a generous upper bound (e.g. the manifest's default) without
    crashing on small feature subsets.
    """
    return X @ pca_components(svd, k_pca).T


def pca_components(svd: EmbeddingPcaSvd, k_pca: int) -> np.ndarray:
    """Top-``k_pca`` PCA component matrix, clamped to available count.
    Returned without applying the projection — callers that want to
    chunk the matmul themselves (e.g. distance.compute_distance_to_set
    streaming the universe to bound transient memory) consume the
    components directly. Equivalent to slicing ``project_pca`` apart.
    """
    k = max(1, min(int(k_pca), svd.components_full.shape[0]))
    return svd.components_full[:k]  # (k, d)


def resolve_k_for_variance(
    svd: EmbeddingPcaSvd, target_variance: float
) -> tuple[int, float]:
    """Pick the smallest ``k`` whose top-``k`` components explain at least
    ``target_variance`` of the total variance.

    Returns ``(k, actual_variance_explained)``. The actual fraction can
    exceed the target (e.g. requesting 0.9 might land at 0.94 if adding
    the next component pushes it past), and that's the right behavior —
    we never want to undershoot the user's variance ask, and PCA is
    discrete in components.

    Variance per component is ``S_i² / Σ S_j²`` (singular values squared
    are proportional to variance for centered data; our matrix is
    standardized which is centered + scaled).

    ``target_variance`` is clamped to ``(0, 1]``; values <= 0 yield
    ``k=1`` (you need at least one component for a meaningful subspace),
    values >= 1 yield all components.
    """
    S = svd.singular_values
    n = len(S)
    if n == 0:
        raise ValueError("cannot resolve variance on an empty SVD")
    if target_variance <= 0:
        return 1, float(S[0] ** 2 / (S ** 2).sum())
    variance_per = (S ** 2) / (S ** 2).sum()
    cumulative = np.cumsum(variance_per)
    if target_variance >= 1.0:
        return n, float(cumulative[-1])
    # First index where cumulative >= target. searchsorted with "left"
    # gives the smallest index satisfying the predicate; +1 to convert
    # to a component count.
    k = int(np.searchsorted(cumulative, target_variance, side="left")) + 1
    k = max(1, min(k, n))
    return k, float(cumulative[k - 1])


def project_whitened(svd: EmbeddingPcaSvd, X: np.ndarray) -> np.ndarray:
    """Project ``X`` onto **all** components and divide each by its
    singular value (whitening). Euclidean in the result is Mahalanobis on
    the original z-scored features.
    """
    components, scales = whitened_components(svd)
    return (X @ components.T) / scales  # (_, k_keep)


def whitened_components(
    svd: EmbeddingPcaSvd,
) -> tuple[np.ndarray, np.ndarray]:
    """Components + singular-value scales for whitened (Mahalanobis)
    projection, with near-zero singular values dropped.

    Returned without applying the projection so callers (notably the
    chunked distance loop) can apply ``X @ components.T / scales`` per
    chunk and avoid materializing the full ``N × k_keep`` projection in
    memory. The threshold ``SINGULAR_VALUE_EPS * S.max()`` drops
    components whose direction has effectively no variance — keeping
    them would let one near-degenerate axis dominate every distance.
    """
    S = svd.singular_values
    threshold = SINGULAR_VALUE_EPS * S.max() if len(S) else 0.0
    keep = S > threshold
    if not keep.any():
        # Degenerate matrix — no useful direction. Caller falls back to
        # the raw space (whitening is undefined here).
        raise ValueError(
            "whitening: every singular value is below the numerical "
            "threshold; matrix has no usable variance"
        )
    return svd.components_full[keep], S[keep]
