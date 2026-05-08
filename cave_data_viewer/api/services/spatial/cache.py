"""Cached SpatialProvider invocation.

Cache key: `(datastack, mat_version, root_id, soma_table, syn_position_prefix,
desired_resolution, provider_cache_key)` — the last component invalidates
when the provider name or its params change. Cortex hit rate is unchanged
under steady-state config.

Saves ~1.2s per warm plot request on a 5K-synapse cell. Failures are not
cached — a transient CAVE error during the first compute shouldn't poison
the cache for the TTL window.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from ...caches import cache_key_with_config, spatial_features_cache
from ..cache_lifecycle import cache_datastack
from ..timing import timer
from .protocol import SpatialProvider, SummaryPanel


@dataclass(frozen=True)
class CachedSpatialFeatures:
    """Provider output bundled for caching.

    `intrinsic` is `{partner_root_id: {feature_name: value}}` — partner-intrinsic
    features (same value for both directions).
    `per_direction_in` / `per_direction_out` are `{feature_name: {partner_root_id: value}}`
    — per-direction features that the bundle assembler routes into single- or
    Both-tab columns.
    `summary_panels` is the list of cell-level panels (e.g. depth histogram).
    """
    intrinsic: dict[int, dict[str, float]]
    per_direction_in: dict[str, dict[int, float]]
    per_direction_out: dict[str, dict[int, float]]
    summary_panels: tuple[SummaryPanel, ...]

    @classmethod
    def empty(cls) -> "CachedSpatialFeatures":
        return cls(intrinsic={}, per_direction_in={}, per_direction_out={}, summary_panels=())


def compute_spatial_features_cached(
    *,
    nq,
    provider: SpatialProvider,
    decoration_lookup: dict[int, dict[str, Any]],
    root_soma_position_nm: list[float] | None,
) -> CachedSpatialFeatures:
    """Run the provider, cached on `(nq identity, provider identity)`.

    Augments `decoration_lookup` with the queried root's soma position
    when missing, so the cache entry is reusable from either the
    connectivity endpoint (which includes the root in `decoration_lookup`)
    or the plot endpoint (which doesn't). The cortex provider's intrinsic
    features for the root then carry `soma_depth`/`soma_x`/`soma_z` on
    every cache hit.
    """
    key = cache_key_with_config(
        cache_datastack(nq.datastack), nq.mat_version, nq.root_id, nq.soma_table,
        config_bundle={
            "syn_position_prefix": nq.synapse_position_prefix,
            "desired_resolution": list(nq.desired_resolution),
            "spatial_provider": provider.cache_key(),
        },
    )
    cached = spatial_features_cache.get(key)
    if cached is not None:
        with timer("spatial_features_cache_hit"):
            return cached

    if (
        root_soma_position_nm is not None
        and int(nq.root_id) not in decoration_lookup
    ):
        decoration_lookup = {
            **decoration_lookup,
            int(nq.root_id): {"pt_position": root_soma_position_nm},
        }

    partner_soma_positions: dict[int, list[float]] = {}
    for rid, rec in decoration_lookup.items():
        pos = provider.soma_position_from_row(rec)
        if pos is not None:
            partner_soma_positions[int(rid)] = pos

    # Always pull both directions. `_synapse_df` is cached so the side the
    # caller doesn't want costs ~zero, and including it in the cached
    # result lets a future request that *does* want it skip the compute.
    syn_df_in = nq._synapse_df("post")
    syn_df_out = nq._synapse_df("pre")

    with timer("attach_spatial_features"):
        intrinsic = provider.intrinsic_features(
            root_soma_position_nm=root_soma_position_nm,
            partner_soma_positions=partner_soma_positions,
        )
        per_direction_in = provider.per_direction_features(
            direction="in",
            syn_df=syn_df_in,
            partner_root_id_column="pre_pt_root_id",
            syn_position_prefix=nq.synapse_position_prefix,
        )
        per_direction_out = provider.per_direction_features(
            direction="out",
            syn_df=syn_df_out,
            partner_root_id_column="post_pt_root_id",
            syn_position_prefix=nq.synapse_position_prefix,
        )
        with timer("synapse_depth_profile"):
            panels = tuple(provider.summary_panels(
                syn_df_in=syn_df_in,
                syn_df_out=syn_df_out,
                syn_position_prefix=nq.synapse_position_prefix,
            ))

    result = CachedSpatialFeatures(
        intrinsic=intrinsic,
        per_direction_in=per_direction_in,
        per_direction_out=per_direction_out,
        summary_panels=panels,
    )
    spatial_features_cache[key] = result
    return result
