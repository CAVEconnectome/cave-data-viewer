"""CortexSpatialProvider — `standard_transform`-based cortical anatomy.

Wraps the existing `standard_transform` integration in the SpatialProvider
contract. All cortex-specific assumptions (axis 1 = depth, axes 0/2 =
tangential plane, the column vocabulary `soma_depth` / `soma_x` / `soma_z` /
`radial_dist_root_soma` / `median_syn_depth`, the `synapse_depth_profile`
summary) live behind this class so the rest of the codebase doesn't see them.

Output convention from `standard_transform`: axis 1 is depth (along the
pia-to-white-matter axis), axes 0 and 2 are tangential. Verified empirically
against `minnie_transform_nm` — a unit step in input y produces an
~equal-magnitude unit step in output[1] with negligible cross-talk.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from .protocol import FeatureSpec, SpatialProvider, SummaryPanel


# `standard_transform`'s transform sequence, by `transform` name in the
# aligned-volume YAML's `params`.
_TRANSFORM_LOADERS: dict[str, str] = {
    "minnie_nm": "minnie_transform_nm",
    "minnie_vx": "minnie_transform_vx",
    "v1dd_nm": "v1dd_transform_nm",
    "v1dd_vx": "v1dd_transform_vx",
    "identity": "identity_transform",
}

# Companion streamlines for each transform. Each Streamline is callable on the
# *transformed* coordinate space (we pass `transform_points=False` to skip
# re-applying the transform when we've already computed it). Streamlines let
# us follow local cortical-column orientation per-depth, which is more
# accurate for radial distance across long depth ranges than just stripping
# the depth axis.
_STREAMLINE_LOADERS: dict[str, Any] = {
    "minnie_nm": lambda st: st.minnie_ds.streamline_nm,
    "minnie_vx": lambda st: st.minnie_ds.streamline_vx,
    "v1dd_nm": lambda st: st.v1dd_ds.streamline_nm,
    "v1dd_vx": lambda st: st.v1dd_ds.streamline_vx,
    "identity": lambda st: st.identity_streamline,
}

_DEPTH_AXIS = 1
_TANGENTIAL_AXES = (0, 2)
_NM_PER_UM = 1000.0


def _load_transform(name: str | None):
    if not name:
        return None
    constructor = _TRANSFORM_LOADERS.get(name)
    if constructor is None:
        return None
    import standard_transform as st
    fn = getattr(st, constructor, None)
    return fn() if fn is not None else None


def _load_streamline(name: str | None):
    if not name:
        return None
    accessor = _STREAMLINE_LOADERS.get(name)
    if accessor is None:
        return None
    import standard_transform as st
    try:
        return accessor(st)
    except Exception:
        return None


def _apply_transform(transform, points: np.ndarray) -> np.ndarray:
    if points.ndim == 1:
        return np.atleast_2d(transform.apply(points))
    return transform.apply(points)


class CortexSpatialProvider(SpatialProvider):
    """Cortex anatomy: depth + tangential plane + cortical-column streamlines.

    Params (from aligned-volume YAML's `spatial.params`):
      - `transform` (str) — short name like `"minnie_nm"` selecting a
        `standard_transform` constructor. Required for any oriented-frame
        feature; absent → no transform → all spatial columns omitted.
      - `depth_range` ([float, float], µm) — fixes depth-axis range on
        plots so neurons share a coordinate system. Optional.
      - `layer_boundaries` (list[float], µm, top-to-bottom) — cortical
        layer dividers, drawn as guides on depth-axis plots. Optional.
      - `layer_names` (list[str]) — parallel to `layer_boundaries`.
        Optional.
    """

    def __init__(self, params: Mapping[str, Any] | None = None):
        params = dict(params or {})
        self._transform_name: str | None = params.get("transform")
        self._depth_range: list[float] | None = params.get("depth_range")
        self._layer_boundaries: list[float] | None = params.get("layer_boundaries")
        self._layer_names: list[str] | None = params.get("layer_names")
        self._params = params
        self._transform = _load_transform(self._transform_name)
        self._streamline = _load_streamline(self._transform_name)

    def feature_manifest(self) -> Sequence[FeatureSpec]:
        if self._transform is None:
            return ()
        return (
            FeatureSpec(
                name="soma_depth", label="Soma depth", unit="µm",
                role="depth", scope="partner_intrinsic",
            ),
            FeatureSpec(
                name="soma_x", label="Soma x", unit="µm",
                role="tangential", scope="partner_intrinsic",
            ),
            FeatureSpec(
                name="soma_z", label="Soma z", unit="µm",
                role="tangential", scope="partner_intrinsic",
            ),
            FeatureSpec(
                name="radial_dist_root_soma", label="Radial dist", unit="µm",
                role="radial", scope="partner_intrinsic",
            ),
            FeatureSpec(
                name="median_syn_depth", label="Median synapse depth", unit="µm",
                role="depth", scope="partner_per_direction",
                directions=("in", "out"),
            ),
        )

    def soma_position_from_row(self, row: Mapping[str, Any]) -> list[float] | None:
        pt = row.get("pt_position")
        if isinstance(pt, list) and len(pt) == 3:
            return pt
        return None

    def intrinsic_features(
        self,
        *,
        root_soma_position_nm: list[float] | None,
        partner_soma_positions: dict[int, list[float]],
    ) -> dict[int, dict[str, float]]:
        if self._transform is None or not partner_soma_positions:
            return {}

        rids = list(partner_soma_positions.keys())
        pts = np.array([partner_soma_positions[r] for r in rids], dtype=float)
        transformed = _apply_transform(self._transform, pts)

        radial: np.ndarray | None = None
        if root_soma_position_nm is not None:
            root_xyz = _apply_transform(
                self._transform, np.array(root_soma_position_nm, dtype=float)
            )[0]
            if self._streamline is not None:
                # `streamline.radial_distance`: xyz0 single 1-D point, xyz1 Nx3.
                # `transform_points=False` because we already applied the
                # transform — streamline expects post-transform coords here.
                radial = np.asarray(
                    self._streamline.radial_distance(
                        root_xyz, transformed,
                        transform_points=False, return_angle=False,
                    ),
                    dtype=float,
                )
            else:
                root_tangential = root_xyz[list(_TANGENTIAL_AXES)]
                radial = np.linalg.norm(
                    transformed[:, list(_TANGENTIAL_AXES)] - root_tangential,
                    axis=1,
                )

        out: dict[int, dict[str, float]] = {}
        for i, rid in enumerate(rids):
            rec: dict[str, float] = {
                "soma_depth": float(transformed[i, _DEPTH_AXIS]),
                "soma_x": float(transformed[i, _TANGENTIAL_AXES[0]]),
                "soma_z": float(transformed[i, _TANGENTIAL_AXES[1]]),
            }
            if radial is not None:
                rec["radial_dist_root_soma"] = float(radial[i])
            out[int(rid)] = rec
        return out

    def per_direction_features(
        self,
        *,
        direction: str,
        syn_df: pd.DataFrame | None,
        partner_root_id_column: str,
        syn_position_prefix: str,
    ) -> dict[str, dict[int, float]]:
        if self._transform is None or syn_df is None or syn_df.empty:
            return {}
        pos_cols = [f"{syn_position_prefix}_position_{a}" for a in ("x", "y", "z")]
        if any(c not in syn_df.columns for c in pos_cols):
            return {}

        # Vectorized: one transform.apply over all rows, then groupby-median
        # on the depth axis. Earlier per-partner loop called transform.apply
        # ~500 times per cell; flat call collapses ~4s → a few hundred ms.
        depths = _apply_transform(
            self._transform, syn_df[pos_cols].to_numpy(dtype=float)
        )[:, _DEPTH_AXIS]
        median_depth = (
            pd.Series(
                depths,
                index=syn_df[partner_root_id_column].astype("int64").to_numpy(),
            )
            .groupby(level=0, sort=False)
            .median()
            .to_dict()
        )
        return {"median_syn_depth": median_depth}

    def summary_panels(
        self,
        *,
        syn_df_in: pd.DataFrame | None,
        syn_df_out: pd.DataFrame | None,
        syn_position_prefix: str,
    ) -> Sequence[SummaryPanel]:
        if self._transform is None:
            return ()

        pos_cols = [f"{syn_position_prefix}_position_{a}" for a in ("x", "y", "z")]

        def _depths(syn_df: pd.DataFrame | None) -> np.ndarray:
            if syn_df is None or syn_df.empty:
                return np.empty(0, dtype=float)
            if any(c not in syn_df.columns for c in pos_cols):
                return np.empty(0, dtype=float)
            pts = syn_df[pos_cols].to_numpy(dtype=float)
            return _apply_transform(self._transform, pts)[:, _DEPTH_AXIS]

        depths_in = _depths(syn_df_in)
        depths_out = _depths(syn_df_out)
        if depths_in.size == 0 and depths_out.size == 0:
            return ()

        if self._depth_range and len(self._depth_range) == 2:
            lo, hi = float(self._depth_range[0]), float(self._depth_range[1])
        else:
            combined = np.concatenate(
                [depths_in if depths_in.size else np.empty(0),
                 depths_out if depths_out.size else np.empty(0)]
            )
            lo, hi = float(combined.min()), float(combined.max())
            if hi <= lo:
                lo, hi = lo - 1.0, hi + 1.0

        n_bins = 40
        edges = np.linspace(lo, hi, n_bins + 1)
        counts_in, _ = (
            np.histogram(depths_in, bins=edges)
            if depths_in.size else (np.zeros(n_bins, dtype=int), edges)
        )
        counts_out, _ = (
            np.histogram(depths_out, bins=edges)
            if depths_out.size else (np.zeros(n_bins, dtype=int), edges)
        )
        return (
            SummaryPanel(
                kind="synapse_depth_profile",
                data={
                    "bin_edges": edges.tolist(),
                    "counts_in": counts_in.astype(int).tolist(),
                    "counts_out": counts_out.astype(int).tolist(),
                    "depth_axis_name": "Synapse depth",
                    "depth_range": [lo, hi] if self._depth_range else None,
                    "layer_boundaries": (
                        list(self._layer_boundaries) if self._layer_boundaries else None
                    ),
                    "layer_names": (
                        list(self._layer_names) if self._layer_names else None
                    ),
                },
            ),
        )

    def meta(self) -> dict[str, Any]:
        if self._transform is None:
            return {
                "provider": "cortex",
                "axes": {},
                "column_roles": {},
                "label_overrides": {},
                "summary_kinds": [],
            }
        # `column_roles` covers every shape the SPA might see: bare names
        # (single-direction tabs and intrinsic columns) plus the unifier's
        # `_in` / `_out` suffix variants for per-direction features. Walking
        # the manifest keeps these in lockstep with whatever features the
        # provider actually declares — no risk of the SPA finding an
        # un-classified column when the manifest changes.
        column_roles: dict[str, str] = {}
        for spec in self.feature_manifest():
            column_roles[spec.name] = spec.role
            if spec.scope == "partner_per_direction":
                for direction in spec.directions:
                    column_roles[f"{spec.name}_{direction}"] = spec.role
        return {
            "provider": "cortex",
            "axes": {
                "depth": {"column": "soma_depth", "label": "Soma depth (µm)"},
                "tangential_x": {"column": "soma_x", "label": "Soma x (µm)"},
                "tangential_z": {"column": "soma_z", "label": "Soma z (µm)"},
            },
            "column_roles": column_roles,
            "label_overrides": {"radial_dist_root_soma": "radial_dist"},
            "summary_kinds": ["synapse_depth_profile"],
            "depth_range": self._depth_range,
            "layer_boundaries": self._layer_boundaries,
            "layer_names": self._layer_names,
        }

    def cache_key(self) -> str:
        canonical = json.dumps(
            {"provider": "cortex", "params": self._params},
            sort_keys=True, default=str,
        )
        return hashlib.sha1(canonical.encode()).hexdigest()[:16]

    def target_oriented_position(
        self, soma_position_nm: list[float] | None,
    ) -> dict[str, float] | None:
        """Single-point convenience used by the plot endpoint's cell-marker
        glyph. Returns `{soma_depth, soma_x, soma_z}` or None when no
        transform is configured / no position supplied. Mirrors the
        per-partner pipeline so the marker lands in the same frame."""
        if self._transform is None or soma_position_nm is None:
            return None
        try:
            transformed = _apply_transform(
                self._transform, np.array(soma_position_nm, dtype=float)
            )
            return {
                "soma_depth": float(transformed[0][_DEPTH_AXIS]),
                "soma_x": float(transformed[0][_TANGENTIAL_AXES[0]]),
                "soma_z": float(transformed[0][_TANGENTIAL_AXES[1]]),
            }
        except Exception:
            return None
