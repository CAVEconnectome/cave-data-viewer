"""NullSpatialProvider — graceful no-op for datastacks without a spatial frame.

Selected when the aligned-volume YAML doesn't configure any spatial frame
(e.g. `brain_and_nerve_cord`). Bundle assembler iterates an empty manifest;
no spatial columns appear in the response, no summary panels are emitted.
The bundle's `median_dist_to_target_soma` (computed outside the provider)
still works because it only needs raw soma positions.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

import pandas as pd

from .protocol import FeatureSpec, SpatialProvider, SummaryPanel


class NullSpatialProvider(SpatialProvider):
    def __init__(self, params: Mapping[str, Any] | None = None):
        # Params accepted but ignored — keeps the constructor uniform with
        # other providers so the registry can build any provider the same way.
        pass

    def feature_manifest(self) -> Sequence[FeatureSpec]:
        return ()

    def soma_position_from_row(self, row: Mapping[str, Any]) -> list[float] | None:
        # No spatial features computed → no need to surface positions.
        # `median_dist_to_target_soma` reads positions from `decoration_lookup`
        # directly in the bundle assembler, not via this hook.
        return None

    def intrinsic_features(
        self, *, root_soma_position_nm, partner_soma_positions,
    ) -> dict[int, dict[str, float]]:
        return {}

    def per_direction_features(
        self, *, direction, syn_df, partner_root_id_column, syn_position_prefix,
    ) -> dict[str, dict[int, float]]:
        return {}

    def summary_panels(
        self, *, syn_df_in, syn_df_out, syn_position_prefix,
    ) -> Sequence[SummaryPanel]:
        return ()

    def meta(self) -> dict[str, Any]:
        return {
            "provider": "null",
            "axes": {},
            "column_roles": {},
            "label_overrides": {},
            "summary_kinds": [],
        }

    def cache_key(self) -> str:
        return "null"
