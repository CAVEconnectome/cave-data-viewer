"""Distance from a seed set to every universe cell, vectorized.

Backs the ``/distance_to_set`` endpoint and the Feature Explorer's
"grow my selection by similarity" workflow. The same standardized
feature matrix used by every space ships from
:mod:`feature_matrix`; the PCA cache from :mod:`pca` provides the SVD
that PCA and Mahalanobis whitening share.

Three spaces:

- ``raw``           — Euclidean on z-scored features.
- ``pca``           — Euclidean on top-``k_pca`` PCA components.
- ``mahalanobis``   — Euclidean on whitened (all components, scaled by
  1/singular_value) features. Mathematically the Mahalanobis distance
  on the z-scored input.

Three seed reductions:

- ``centroid`` — distance to the seed centroid (one vector). Cheap;
  works well when the seeds are tight.
- ``nearest``  — min over seeds. Picks up cells near *any* seed; useful
  when the seed kernel is heterogeneous.
- ``mean``     — average distance to all seeds. Penalizes outliers in
  the universe by their distance to every seed.

Seeds not present in the matrix (e.g. a cell with a null feature value
was dropped on build) are silently filtered; the count is returned so
the SPA can surface "we used N of M seeds."
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np

from .feature_matrix import EmbeddingMatrix
from .pca import EmbeddingPcaSvd, pca_components, whitened_components
from ..timing import timer


Space = Literal["raw", "pca", "mahalanobis"]
Reduction = Literal["centroid", "nearest", "mean"]


@dataclass
class DistanceResult:
    """Distances from a seed set, aligned to the universe's cell-id order.

    ``cell_ids`` and ``distances`` are parallel arrays in the same order
    as the matrix's row order. The frontend joins them by index when
    building the in-memory distance map.

    ``n_seed_in_index`` / ``n_seed_missing`` let the SPA show "computed
    from N of M seeds" when the user's bag included cells that were
    dropped from the matrix (null features, etc.).
    """

    cell_ids: np.ndarray
    distances: np.ndarray
    n_seed_in_index: int
    n_seed_missing: int


def compute_distance_to_set(
    matrix: EmbeddingMatrix,
    seed_cell_ids: Sequence[int | str],
    *,
    space: Space,
    reduction: Reduction,
    k_pca: int = 10,
    svd: EmbeddingPcaSvd | None = None,
) -> DistanceResult:
    """Compute universe-aligned distances from the seed set.

    ``svd`` is required when ``space != "raw"`` and is otherwise unused.
    The endpoint handler is responsible for fetching the cached SVD when
    needed; threading it through here keeps this module pure (no Flask
    extensions lookup, no manifest plumbing).

    Raises ``ValueError`` when every seed is missing from the matrix —
    distance from an empty seed set is undefined and the SPA should
    surface that as a 422 rather than silently returning NaNs.
    """
    if space != "raw" and svd is None:
        raise ValueError(
            f"space={space!r} requires a precomputed SVD; pass svd=…"
        )

    rows: list[int] = []
    missing = 0
    for sid in seed_cell_ids:
        row = matrix.cell_id_to_row.get(int(sid))
        if row is None:
            missing += 1
        else:
            rows.append(row)
    if not rows:
        raise ValueError(
            "every seed cell_id is missing from the feature matrix "
            "(either the parquet doesn't contain them or they were dropped "
            "during null-filtering on build)"
        )

    seed_rows = np.array(rows, dtype=np.int64)

    # Choose projection helpers based on space. ``components`` and
    # ``scales`` being ``None`` means "consume matrix.X directly"
    # (raw / standardized space). The chunked loop below applies them
    # per chunk instead of materializing the full N×D_kept projection
    # in memory — at D=200, N=200k this is the difference between a
    # ~320 MB transient and a ~30 MB transient per request.
    components: np.ndarray | None = None
    scales: np.ndarray | None = None
    with timer(f"distance_project[{space}]"):
        if space == "raw":
            X_seed = matrix.X[seed_rows]
        elif space == "pca":
            assert svd is not None
            components = pca_components(svd, k_pca)
            X_seed = matrix.X[seed_rows] @ components.T
        elif space == "mahalanobis":
            assert svd is not None
            components, scales = whitened_components(svd)
            X_seed = (matrix.X[seed_rows] @ components.T) / scales
        else:
            raise ValueError(f"unknown space: {space!r}")

    with timer(f"distance_reduce[{reduction}]"):
        distances = _chunked_distance(
            matrix.X,
            X_seed,
            components=components,
            scales=scales,
            reduction=reduction,
        )
    return DistanceResult(
        cell_ids=matrix.cell_ids,
        distances=distances,
        n_seed_in_index=len(rows),
        n_seed_missing=missing,
    )


# Target peak transient memory per chunk. The chunked loop scales its
# row count to keep ``chunk_rows × (S + 1) × D_kept × 8`` under this
# ceiling — the ``+1`` accounts for the chunk's own projected matrix
# alongside the pairwise (chunk, S, D) tensor. ~32 MB is generous
# enough that loop overhead doesn't dominate yet small enough that
# concurrent requests don't summed-allocate into GB territory.
_CHUNK_TARGET_BYTES = 32 * 1024 * 1024
# Floor: chunks smaller than this would make the Python loop overhead
# noticeable. Ceiling: even at D=1 the chunk doesn't grow past this so
# the centroid path (no S multiplier) stays predictable.
_CHUNK_FLOOR = 512
_CHUNK_CEILING = 16384


def _chunk_for(seed_count: int, d_kept: int) -> int:
    """Universe-rows per chunk that keep per-chunk peak transient under
    ``_CHUNK_TARGET_BYTES``. Adapts to the post-projection
    dimensionality so a (200-feature, 20-seed) workload uses smaller
    chunks than a (13-feature, 1-seed) workload while delivering the
    same memory envelope.
    """
    per_row = max(1, (seed_count + 1) * d_kept * 8)
    return max(_CHUNK_FLOOR, min(_CHUNK_CEILING, _CHUNK_TARGET_BYTES // per_row))


def _chunked_distance(
    X_universe: np.ndarray,
    X_seed: np.ndarray,
    *,
    components: np.ndarray | None,
    scales: np.ndarray | None,
    reduction: Reduction,
) -> np.ndarray:
    """Per-row distance from each universe cell to the (already-
    projected) seed set, fused with on-the-fly per-chunk projection.

    Memory shape per iteration:

    - ``X_chunk``: ``chunk_rows × D`` — read directly from the matrix,
      no copy required by numpy slicing.
    - ``X_chunk_proj``: ``chunk_rows × D_kept`` — the projection
      result; allocated only when ``components is not None``.
    - For nearest / mean reductions an additional pairwise
      ``chunk_rows × S × D_kept`` diff tensor is allocated; for
      centroid only a single ``chunk_rows × D_kept`` diff.

    By chunking *and* fusing projection in, peak request transient
    becomes a function of chunk size and feature subset alone — not of
    universe size N. At our growth targets (N=200k, D=200, S=20) the
    peak per chunk lands at ~32 MB regardless of how large the universe
    grows or how many users hit the endpoint concurrently.
    """
    if reduction not in ("centroid", "nearest", "mean"):
        raise ValueError(f"unknown reduction: {reduction!r}")

    n = X_universe.shape[0]
    d_kept = X_seed.shape[1]
    seed_count = X_seed.shape[0]
    chunk_size = _chunk_for(seed_count, d_kept)

    centroid = X_seed.mean(axis=0) if reduction == "centroid" else None
    out = np.empty(n, dtype=np.float64)

    for start in range(0, n, chunk_size):
        end = min(start + chunk_size, n)
        X_chunk = X_universe[start:end]

        # Project the chunk into the same space the seed lives in. None
        # means raw / already-standardized → no projection, the chunk
        # itself is the working data.
        if components is None:
            X_chunk_proj = X_chunk
        else:
            X_chunk_proj = X_chunk @ components.T
            if scales is not None:
                X_chunk_proj = X_chunk_proj / scales

        if reduction == "centroid":
            out[start:end] = np.linalg.norm(X_chunk_proj - centroid, axis=1)
        else:
            # (chunk_rows, S, D_kept) — bounded by chunk_size, not by n.
            diffs = X_chunk_proj[:, None, :] - X_seed[None, :, :]
            d = np.linalg.norm(diffs, axis=2)
            if reduction == "nearest":
                out[start:end] = d.min(axis=1)
            else:  # "mean"
                out[start:end] = d.mean(axis=1)
    return out
