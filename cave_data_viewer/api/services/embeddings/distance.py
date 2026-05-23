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
from typing import Any, Literal, Sequence

import numpy as np

from .feature_matrix import EmbeddingMatrix, get_matrix
from .pca import EmbeddingPcaSvd, pca_components, resolve_k_for_variance, whitened_components, get_pca_svd
from ..timing import timer
from ...errors import ApiError
from .manifest import FeatureTableSpec


Space = Literal["raw", "pca", "mahalanobis"]
Reduction = Literal["centroid", "nearest", "mean"]

# Distance-to-set seed cap. The nearest/mean reductions allocate a
# pairwise (chunk, S, D) intermediate per chunk, so keeping S small
# bounds per-request transient memory predictably regardless of
# universe size.
_MAX_SEED_CELL_IDS = 20

# Top-K truncation defaults. The default is set high enough to ship
# the entire universe for every public connectome we know about; the
# ceiling stays in place as a guard against runaway client requests.
_DEFAULT_DISTANCE_LIMIT = 200000
_MAX_DISTANCE_LIMIT = 1000000


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


def compute_distance_to_set_payload(
    *,
    ds: str,
    cfg,
    src,
    ft: FeatureTableSpec,
    feature_table_id: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """End-to-end distance_to_set: parse body → resolve matrix/SVD →
    compute distances → sort + truncate → response dict.

    Raises :class:`ApiError` (422) with the same code strings the
    inline route did (``missing_cell_ids``, ``too_many_seeds``,
    ``invalid_cell_id``, ``invalid_space``, ``missing_embedding_id``,
    ``embedding_not_found`` [404], ``invalid_reduction``,
    ``invalid_limit``, ``invalid_variance``, ``invalid_feature_columns``,
    ``matrix_build_failed``, ``no_seeds_in_index``).
    """
    raw_ids = body.get("cell_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ApiError(
            422,
            "missing_cell_ids",
            "request body must include a non-empty `cell_ids` list",
        )
    if len(raw_ids) > _MAX_SEED_CELL_IDS:
        raise ApiError(
            422,
            "too_many_seeds",
            f"distance_to_set accepts at most {_MAX_SEED_CELL_IDS} seed "
            f"cell_ids; got {len(raw_ids)}. Narrow the selection (e.g. "
            "lasso a tighter kernel) before computing.",
        )
    seed_cell_ids: list[int] = []
    for sid in raw_ids:
        try:
            seed_cell_ids.append(int(sid))
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422,
                "invalid_cell_id",
                f"cell_ids must be ints or numeric strings; got {sid!r}",
            ) from exc

    space = body.get("space", "pca")
    if space not in ("raw", "pca", "mahalanobis", "embedding"):
        raise ApiError(
            422,
            "invalid_space",
            f"space must be one of raw | pca | mahalanobis | embedding; "
            f"got {space!r}",
        )

    embedding_axes: list[str] | None = None
    if space == "embedding":
        embedding_id = body.get("embedding_id")
        if not embedding_id:
            raise ApiError(
                422,
                "missing_embedding_id",
                "space 'embedding' requires 'embedding_id' in the request body",
            )
        try:
            _ft_e, emb = src.resolve_embedding(feature_table_id, embedding_id)
        except KeyError as exc:
            raise ApiError(404, "embedding_not_found", str(exc)) from exc
        embedding_axes = list(emb.axes)

    reduction = body.get("reduction", "centroid")
    if reduction not in ("centroid", "nearest", "mean"):
        raise ApiError(
            422,
            "invalid_reduction",
            f"reduction must be one of centroid | nearest | mean; "
            f"got {reduction!r}",
        )

    limit_raw = body.get("limit", _DEFAULT_DISTANCE_LIMIT)
    try:
        limit = int(limit_raw)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_limit", f"limit must be an integer, got {limit_raw!r}"
        ) from exc
    if limit < 1:
        raise ApiError(422, "invalid_limit", "limit must be >= 1")
    if limit > _MAX_DISTANCE_LIMIT:
        raise ApiError(
            422,
            "invalid_limit",
            f"limit may not exceed {_MAX_DISTANCE_LIMIT}; got {limit}",
        )

    variance_raw = body.get("variance", 0.9)
    try:
        variance = float(variance_raw)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_variance",
            f"variance must be a number in (0, 1], got {variance_raw!r}",
        ) from exc
    if not (0.0 < variance <= 1.0):
        raise ApiError(
            422,
            "invalid_variance",
            f"variance must be in (0, 1], got {variance}",
        )

    feature_columns = body.get("feature_columns")
    if feature_columns is not None:
        if not isinstance(feature_columns, list) or not all(
            isinstance(c, str) for c in feature_columns
        ):
            raise ApiError(
                422,
                "invalid_feature_columns",
                "feature_columns must be a list of column names",
            )
        if len(feature_columns) < 2:
            raise ApiError(
                422,
                "invalid_feature_columns",
                "feature_columns must include at least 2 columns "
                "(distance in 1D collapses to absolute difference and "
                "PCA / Mahalanobis are undefined)",
            )

    clip_setting = ft.clip_percentiles
    clip_percentiles: tuple[float, float] | None = (
        (float(clip_setting[0]), float(clip_setting[1]))
        if clip_setting is not None
        else None
    )
    if space == "embedding":
        matrix_feature_columns = embedding_axes
        matrix_scaling = "raw"
        matrix_clip = None
    else:
        matrix_feature_columns = feature_columns
        matrix_scaling = ft.scaling
        if not ft.standardize and matrix_scaling == "zscore":
            matrix_scaling = "raw"
        matrix_clip = clip_percentiles
    # `get_matrix` and `get_pca_svd` accept `cache_ds` as a parameter
    # and their internal accessor key builders apply `cache_datastack`
    # idempotently — passing the raw `ds` here is equivalent to (and
    # less brittle than) computing `cfg.cache_alias or ds` inline.
    try:
        matrix = get_matrix(
            ds,
            ft,
            feature_columns=matrix_feature_columns,
            scaling=matrix_scaling,
            clip_percentiles=matrix_clip,
            cache_ds=ds,
        )
    except ValueError as exc:
        raise ApiError(422, "matrix_build_failed", str(exc)) from exc

    svd = None
    resolved_k = None
    variance_explained = None
    if space not in ("raw", "embedding"):
        svd = get_pca_svd(ds, ft, matrix)
        if space == "pca":
            resolved_k, variance_explained = resolve_k_for_variance(svd, variance)

    compute_space = "raw" if space == "embedding" else space
    try:
        result = compute_distance_to_set(
            matrix,
            seed_cell_ids,
            space=compute_space,
            reduction=reduction,
            k_pca=resolved_k or 1,
            svd=svd,
        )
    except ValueError as exc:
        raise ApiError(422, "no_seeds_in_index", str(exc)) from exc

    n_universe = len(result.distances)
    effective_limit = min(limit, n_universe)
    with timer("distance_truncate_topk"):
        if effective_limit < n_universe:
            unsorted_top = np.argpartition(
                result.distances, effective_limit - 1
            )[:effective_limit]
            order = unsorted_top[np.argsort(result.distances[unsorted_top])]
        else:
            order = np.argsort(result.distances)
        top_cell_ids = result.cell_ids[order]
        top_distances = result.distances[order]

    return {
        "cell_ids": [str(cid) for cid in top_cell_ids.tolist()],
        "distances": top_distances.tolist(),
        "space": space,
        "variance": variance if space == "pca" else None,
        "k_pca": resolved_k,
        "variance_explained": variance_explained,
        "reduction": reduction,
        "n_seed_in_index": result.n_seed_in_index,
        "n_seed_missing": result.n_seed_missing,
        "n_returned": int(effective_limit),
        "n_universe": int(n_universe),
        "feature_columns": list(matrix.feature_columns),
    }
