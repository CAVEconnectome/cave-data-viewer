"""Typed accessors for the per-app cache extensions.

Each cache lives at ``current_app.extensions["dcv_*"]``. Without this
module, call sites do the lookup inline with a string key and have to
guess the concrete cache type from context. That has two costs:

- A renamed extension key degrades silently to ``None`` rather than
  raising at import time.
- The :class:`SwrCache` / :class:`ImmutableCache` distinction (and
  whether L2 is in play) isn't visible at the call site.

This module exports one ``get_<kind>_cache()`` function per extension
that returns the cache typed as the correct sibling class. A missing
extension raises ``RuntimeError`` with the extension name, so a config
mistake fails at the first request rather than degrading to "every
read missed."

For caches whose key construction includes the datastack name, this
module also exports a sibling ``<kind>_cache_key(...)`` builder. The
builder applies :func:`cache_datastack` so the per-datastack alias is
handled in one place. Calling sites should always go through the
builder — manual key construction with raw ``ds`` is a bug.

**DecorationService asymmetry.** The four ``DecorationService`` caches
(``num_soma_mat``, ``num_soma_live``, ``table_decorations_mat``,
``table_decorations_live``) live as instance attributes on the service,
NOT in ``app.extensions``. This module deliberately does NOT export
``get_decoration_cache()`` — the instance lookup stays
``current_app.extensions["dcv_decoration"].cache_for(kind, live)``. Only
the **key builder** :func:`decoration_cache_key` lives here, so callers
that read from the service still go through a single key-construction
path. Do not add a phantom ``get_decoration_cache()``; the asymmetry is
intentional.
"""

from __future__ import annotations

from typing import Any

from flask import current_app

from .cache_lifecycle import cache_datastack
from .swr import ImmutableCache, LayeredImmutableCache, SwrCache


# ============================================================================
# Accessor helpers
# ============================================================================


def _require(extension_key: str):
    """Look up `extension_key` on the running app, raise loudly if absent.

    The fast-fail is the point of the accessor module — silent ``None``
    on a renamed key means every read silently misses.
    """
    cache = current_app.extensions.get(extension_key)
    if cache is None:
        raise RuntimeError(
            f"{extension_key!r} not initialized on current_app.extensions. "
            "Cache extensions are built by `_init_l2_immutable_caches` in "
            "cave_data_viewer/api/__init__.py at create_app() time. A None "
            "here means either the app wasn't fully constructed or the "
            "extension key was renamed without updating the accessor."
        )
    return cache


# ============================================================================
# Synapse cache (L1+L2 immutable)
# ============================================================================


def get_synapse_cache() -> LayeredImmutableCache:
    return _require("dcv_synapse_cache")


def synapse_cache_key(ds: str, mat_version: Any, query_hash: str) -> tuple:
    """Key shape: ``(cache_ds, mat_version, canonical_query_hash)``.

    Leading ``(ds, mv)`` lets the retention resolver pick the right L2
    partition without re-deriving from a hashed payload; the canonical
    query hash bakes in every knob that shapes the cached DataFrame
    (synapse columns, position prefix, desired resolution).
    """
    return (cache_datastack(ds), mat_version, query_hash)


# ============================================================================
# Spatial-features cache (L1+L2 immutable)
# ============================================================================


def get_spatial_features_cache() -> LayeredImmutableCache:
    return _require("dcv_spatial_features_cache")


def spatial_features_cache_key(
    ds: str,
    mat_version: Any,
    root_id: int,
    soma_table: str,
    *,
    config_digest: str,
) -> tuple:
    """Key shape: ``(cache_ds, mat_version, root_id, soma_table, digest)``.

    The digest is built by :func:`caches.cache_key_with_config` from the
    caller's config bundle (syn_position_prefix, desired_resolution,
    spatial_provider cache key).
    """
    return (cache_datastack(ds), mat_version, root_id, soma_table, config_digest)


# ============================================================================
# Unique values cache (L1+L2 immutable)
# ============================================================================


def get_unique_values_cache() -> LayeredImmutableCache:
    return _require("dcv_unique_values_cache")


def unique_values_cache_key(ds: str, mat_version: Any, table: str) -> tuple:
    """Key shape: ``(cache_ds, mat_version, table)``.

    Shared between the ``/values`` endpoint and the categorical color
    resolver — both consumers route through here so a renamed call site
    can't drift onto a differently-prefixed key.
    """
    return (cache_datastack(ds), mat_version, table)


# ============================================================================
# Cell-id universe cache (L1+L2 immutable)
# ============================================================================


def get_cell_id_universe_cache() -> LayeredImmutableCache:
    return _require("dcv_cell_id_universe_cache")


def cell_id_universe_cache_key(
    ds: str,
    mat_version: int,
    view: str,
    kind: str,
    cell_id_column: str,
    schema_version: str = "v3",
) -> tuple:
    """Key shape: ``(cache_ds, mat_version, view, kind, cell_id_column, schema_version)``.

    ``schema_version`` is a manually-bumped suffix that invalidates
    pre-configurable-column entries. Defaults to ``"v3"`` — bump when
    the universe payload's shape changes in a way the
    ``_KINDS``/``_CACHE_VERSIONS`` GCS-path version can't catch alone
    (e.g. a CellUniverse field rename).
    """
    return (cache_datastack(ds), int(mat_version), view, kind, cell_id_column, schema_version)


# ============================================================================
# Column histogram cache (L1+L2 immutable)
# ============================================================================


def get_column_histogram_cache() -> LayeredImmutableCache:
    return _require("dcv_column_histogram_cache")


def column_histogram_cache_key(
    ds: str,
    ft_id: str,
    column: str,
    decoration_tables: tuple[str, ...],
    mat_version: Any,
    n_bins: int,
    binning: str,
    seed: Any = None,
) -> tuple:
    """Key shape: ``(cache_ds, ft_id, column, dec_tuple, mat_version, n_bins, binning, seed)``.

    ``decoration_tables`` must be a tuple (sorted by the caller so two
    callers naming the same set in different order share an entry).
    ``seed`` is the optional connectivity seed root_id, included only
    for ``seed_*`` columns since they're seed-derived.
    """
    return (
        cache_datastack(ds),
        ft_id,
        column,
        tuple(decoration_tables),
        mat_version,
        n_bins,
        binning,
        seed,
    )


# ============================================================================
# Embedding frame / matrix / PCA caches (L1-only immutable)
# ============================================================================


def get_embedding_frame_cache() -> ImmutableCache:
    return _require("dcv_embedding_frame_cache")


def embedding_frame_cache_key(ds: str, ft_id: str, parquet_uri: str) -> tuple:
    """Key shape: ``(cache_ds, ft_id, parquet_uri)``.

    URI pins the parquet content; ft_id is in the key so two tables
    that share a URI during dev don't alias.
    """
    return (cache_datastack(ds), ft_id, parquet_uri)


def get_embedding_matrix_cache() -> ImmutableCache:
    return _require("dcv_embedding_matrix_cache")


def embedding_matrix_cache_key(ds: str, ft_id: str, feature_digest: str) -> tuple:
    """Key shape: ``(cache_ds, ft_id, feature_subset_digest)``."""
    return (cache_datastack(ds), ft_id, feature_digest)


def get_embedding_pca_cache() -> ImmutableCache:
    return _require("dcv_embedding_pca_cache")


def embedding_pca_cache_key(ds: str, ft_id: str, feature_digest: str) -> tuple:
    """Key shape: ``(cache_ds, ft_id, feature_subset_digest)``.

    Same triple as :func:`embedding_matrix_cache_key` — one SVD per
    matrix; the components matrix is reused for any ``k_pca`` slice.
    """
    return (cache_datastack(ds), ft_id, feature_digest)


# ============================================================================
# Datastack info + embedding manifest caches (L1-only SWR; no alias)
# ============================================================================


def get_datastack_info_cache() -> SwrCache:
    return _require("dcv_datastack_info_cache")


def get_embedding_manifest_cache() -> SwrCache:
    return _require("dcv_embedding_manifest_cache")


# ============================================================================
# Decoration cache: key builder only (instance lookup stays via service)
# ============================================================================


def decoration_cache_key(ds: str, mat_version: Any, table: str) -> tuple:
    """Key shape for both ``num_soma_*`` and ``table_decorations_*``
    caches: ``(cache_ds, mat_version, table)``.

    Note no ``get_decoration_cache()`` accessor — the four decoration
    caches live as instance attributes on
    ``current_app.extensions["dcv_decoration"]``, not as extensions
    themselves. Read with
    ``current_app.extensions["dcv_decoration"].cache_for(kind, live)``;
    write through ``DecorationService.refresh_cache(...)``. See the
    module docstring for why the asymmetry is intentional.
    """
    return (cache_datastack(ds), mat_version, table)
