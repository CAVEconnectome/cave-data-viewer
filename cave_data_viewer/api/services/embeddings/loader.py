"""Parquet → DataFrame loader for feature-table data.

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

from .manifest import FeatureTableSpec
from .uri import fetch_bytes, local_path_for

logger = logging.getLogger(__name__)


def load_feature_table_frame(
    datastack: str,
    ft: FeatureTableSpec,
    *,
    cache_ds: str | None = None,
) -> pd.DataFrame:
    """Return the parquet for ``ft`` as a pandas DataFrame, cached.

    Parameters
    ----------
    datastack
        The datastack this load was made on behalf of. Used only for cache
        key construction; not for any CAVE call.
    ft
        Resolved ``FeatureTableSpec`` from the manifest.
    cache_ds
        Cache-namespace override (defaults to ``datastack``). Lets two
        datastacks that point at the same parquet share cache entries —
        mirrors the ``DatastackConfig.cache_alias`` pattern used by the
        existing immutable caches.

    Notes
    -----
    Cache key shape is ``(cache_ds, None, feature_table_id, parquet_uri)``.
    The second slot mirrors the ``(cache_ds, mat_version, ...)`` convention
    used by the other immutable caches so the shared retention resolver in
    ``api/__init__.py`` short-circuits to the ``"default"`` partition
    without a per-cache branch. ``feature_table_id`` is in the key so two
    tables that happen to share a parquet URI (unusual, but possible
    during dev) don't alias.
    """
    cache_ds = cache_ds or datastack
    key = _cache_key(cache_ds, ft)

    cache = current_app.extensions.get("dcv_embedding_frame_cache")
    if cache is not None:
        t0 = time.perf_counter()
        hit = cache.get(key)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if hit is not None:
            value, _freshness = hit
            logger.debug(
                "feature_table_frame cache hit ds=%s ft=%s in %.1fms",
                cache_ds, ft.id, elapsed_ms,
            )
            return value

    df = _read_parquet(ft.source.uri)
    _validate_frame(df, ft)
    if cache is not None:
        cache.set(key, df)
    return df


def _cache_key(cache_ds: str, ft: FeatureTableSpec) -> tuple:
    return (cache_ds, None, ft.id, ft.source.uri)


def _read_parquet(uri: str) -> pd.DataFrame:
    """Materialize a parquet URI as a DataFrame.

    Local file:// URIs go straight to pyarrow so the parquet can be
    memory-mapped — meaningful for ~500MB frames. Remote URIs fetch into
    memory and feed through ``io.BytesIO``.
    """
    local = local_path_for(uri)
    if local is not None:
        return pd.read_parquet(local)
    body = fetch_bytes(uri)
    return pd.read_parquet(io.BytesIO(body))


def _validate_frame(df: pd.DataFrame, ft: FeatureTableSpec) -> None:
    """Verify the parquet has the columns the manifest claims.

    Missing ``id_column`` is fatal — without it the table can't be
    keyed. Missing entries in ``feature_columns`` / ``categorical_columns``
    / ``depth_columns`` are downgraded to warnings; downstream paths
    handle column absence gracefully and one mistyped column name in
    the manifest shouldn't break the whole table.

    Embedding axes are validated lazily — they're checked when the
    embedding is actually rendered, not at table load time. The same
    parquet can host multiple embeddings, and a typo'd axis on one
    shouldn't take down the others.
    """
    if ft.id_column not in df.columns:
        raise ValueError(
            f"parquet at {ft.source.uri!r}: missing required id_column "
            f"{ft.id_column!r} (have {list(df.columns)})"
        )

    def _warn_missing(label: str, cols: list[str] | None) -> None:
        if not cols:
            return
        missing = [c for c in cols if c not in df.columns]
        if missing:
            logger.warning(
                "feature_table %r: %s missing from parquet: %s",
                ft.id, label, missing,
            )

    _warn_missing("feature_columns", ft.feature_columns)
    _warn_missing("categorical_columns", ft.categorical_columns)
    _warn_missing("depth_columns", ft.depth_columns)
