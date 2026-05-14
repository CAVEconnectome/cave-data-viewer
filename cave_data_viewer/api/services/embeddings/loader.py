"""Parquet → DataFrame loader for embedding data.

Reads happen once per unique ``parquet_uri`` and cache to
``dcv_embedding_frame_cache`` (immutable ``LayeredSwrCache``, L2 GCS-backed).
The parquet content is by-definition unique per URI, so cache hits are
bit-identical to a fresh read — no TTL gating needed.

The loader does *no* CAVE call. The plan calls for validating that the
parquet's cell_id namespace matches the datastack's
``cell_id_source_table`` (i.e. that cell_ids in the parquet really are rows
of that table), but the universally-correct path is to surface mismatches
at resolver time (cell_id → root_id returns ``status: missing`` for unknown
ids). Active load-time validation can be a future hardening pass; v1 trusts
the manifest.
"""

from __future__ import annotations

import io
import logging
import time

import pandas as pd
from flask import current_app

from .manifest import EmbeddingSpec
from .uri import fetch_bytes, local_path_for

logger = logging.getLogger(__name__)


def load_embedding_frame(
    datastack: str,
    spec: EmbeddingSpec,
    *,
    cache_ds: str | None = None,
) -> pd.DataFrame:
    """Return the parquet for ``spec`` as a pandas DataFrame, cached.

    Parameters
    ----------
    datastack
        The datastack this load was made on behalf of. Used only for cache
        key construction; not for any CAVE call.
    spec
        Resolved ``EmbeddingSpec`` from the manifest.
    cache_ds
        Cache-namespace override (defaults to ``datastack``). Lets two
        datastacks that point at the same parquet share cache entries —
        mirrors the ``DatastackConfig.cache_alias`` pattern used by the
        existing immutable caches.

    Notes
    -----
    Cache key shape is ``(cache_ds, None, embedding_id, parquet_uri)``. The
    second slot mirrors the ``(cache_ds, mat_version, ...)`` convention used
    by the other immutable caches so the shared retention resolver in
    ``api/__init__.py`` short-circuits to the ``"default"`` partition without
    a per-cache branch.
    """
    cache_ds = cache_ds or datastack
    key = _cache_key(cache_ds, spec)

    cache = current_app.extensions.get("dcv_embedding_frame_cache")
    if cache is not None:
        t0 = time.perf_counter()
        hit = cache.get(key)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if hit is not None:
            value, _freshness = hit
            logger.debug(
                "embedding_frame cache hit ds=%s id=%s in %.1fms",
                cache_ds, spec.id, elapsed_ms,
            )
            return value

    df = _read_parquet(spec.source.uri)
    _validate_frame(df, spec)
    if cache is not None:
        cache.set(key, df)
    return df


def _cache_key(cache_ds: str, spec: EmbeddingSpec) -> tuple:
    return (cache_ds, None, spec.id, spec.source.uri)


def _read_parquet(uri: str) -> pd.DataFrame:
    """Materialize a parquet URI as a DataFrame.

    Local file:// URIs go straight to pyarrow so the parquet can be
    memory-mapped — meaningful for ~500MB embedding frames. Remote URIs
    fetch into memory and feed through ``io.BytesIO``.
    """
    local = local_path_for(uri)
    if local is not None:
        return pd.read_parquet(local)
    body = fetch_bytes(uri)
    return pd.read_parquet(io.BytesIO(body))


def _validate_frame(df: pd.DataFrame, spec: EmbeddingSpec) -> None:
    """Verify the parquet has the columns the manifest claims.

    Missing ``id_column`` or any axis column is fatal — without those the
    embedding can't render. Missing entries in ``feature_columns`` or
    ``categorical_columns`` are downgraded to warnings; downstream paths
    handle column absence gracefully (the column simply doesn't appear in
    the picker), and one mistyped column name in the manifest shouldn't
    break the whole embedding.
    """
    missing_required: list[str] = []
    if spec.id_column not in df.columns:
        missing_required.append(spec.id_column)
    for ax in spec.axes:
        if ax not in df.columns:
            missing_required.append(ax)
    if missing_required:
        raise ValueError(
            f"parquet at {spec.source.uri!r}: missing required columns "
            f"{missing_required} (have {list(df.columns)})"
        )

    if spec.feature_columns:
        missing = [c for c in spec.feature_columns if c not in df.columns]
        if missing:
            logger.warning(
                "embedding %r: feature_columns missing from parquet: %s",
                spec.id, missing,
            )
    if spec.categorical_columns:
        missing = [c for c in spec.categorical_columns if c not in df.columns]
        if missing:
            logger.warning(
                "embedding %r: categorical_columns missing from parquet: %s",
                spec.id, missing,
            )
