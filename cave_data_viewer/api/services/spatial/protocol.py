"""SpatialProvider — anatomy-aware spatial feature extractor.

A `SpatialProvider` owns *all* knowledge of a coordinate frame: which features
it produces, how to compute them, what summary panels it emits, and what
metadata the SPA needs to render labels/axes correctly. Concrete providers
(`CortexSpatialProvider`, `NullSpatialProvider`, future `ThalamusSpatialProvider`)
are selected by name in the aligned-volume YAML.

The bundle assembler (in `api/services/neuron.py`) iterates `feature_manifest()`
to enrich partner records and register column groups, instead of hardcoding
column names. This is the seam that lets a new anatomy plug in without
edits to `neuron.py`/`connectivity.py`/generic SPA components.

`median_dist_to_target_soma` (plain 3D Euclidean) intentionally lives *outside*
the provider — it doesn't depend on an oriented frame, so the bundle assembler
computes it directly. The provider's contract is "anything that requires a
spatial frame."
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import pandas as pd


@dataclass(frozen=True)
class FeatureSpec:
    """One spatial column the provider produces.

    The bundle assembler iterates these instead of hardcoding column names.
    Adding/removing a column is a change inside the provider only.

    `role` classifies the axis kind for SPA rendering — the depth axis flips
    sign on plots (pia at the top), the tangential axes pair into a 2D
    scatter, etc. Frontend reads provider `meta()` to map roles to columns.

    `scope`:
      - `partner_intrinsic` — one value per partner, same for both directions
        (e.g. partner soma depth)
      - `partner_per_direction` — per-partner per-direction value, surfaced
        as `<name>_in` / `<name>_out` on the unified Both tab
        (e.g. median synapse depth in each direction)
    """
    name: str
    label: str
    unit: str
    role: str  # "depth" | "tangential" | "distance" | "radial" | "other"
    scope: str  # "partner_intrinsic" | "partner_per_direction"
    directions: tuple[str, ...] = ()


@dataclass(frozen=True)
class SummaryPanel:
    """Per-cell summary visualization data emitted by the provider.

    `kind` is the renderer key the SPA uses to pick a component (e.g.
    `"synapse_depth_profile"` for the cortex histogram). `data` is the
    payload the renderer consumes — schema is renderer-specific.
    """
    kind: str
    data: dict[str, Any]


class SpatialProvider(ABC):
    """Anatomy-aware spatial feature extractor.

    Stateless across requests; one instance per `(provider_name, params)`
    tuple, constructed at request time from the aligned-volume config.
    """

    @abstractmethod
    def feature_manifest(self) -> Sequence[FeatureSpec]:
        """Columns this provider can produce. Order is the SPA column order
        within the spatial group."""

    @abstractmethod
    def soma_position_from_row(self, row: Mapping[str, Any]) -> list[float] | None:
        """Decide whether a cell-id-table row's position is an anatomically
        meaningful soma vs. just a `root_id ↔ cell_id` anchor.

        Returns the 3-tuple `[x, y, z]` (in nm — same unit as the row's
        `pt_position`) when the row represents a real soma; `None` when
        it's just a lookup anchor (e.g. a future axon-only entry whose
        soma lives outside the volume). Rows that return `None` stay in
        the bundle's `cell_id ↔ root_id` mapping but don't contribute
        spatial features.

        Default cortex impl returns `row.get("pt_position")` when it's a
        valid 3-tuple — preserves Minnie behavior since every
        `nucleus_neuron_svm` row is a soma. A future variant that ingests
        an axon-tracking column would override this to consult the
        indicator field.
        """

    @abstractmethod
    def intrinsic_features(
        self,
        *,
        root_soma_position_nm: list[float] | None,
        partner_soma_positions: dict[int, list[float]],
    ) -> dict[int, dict[str, float]]:
        """Per-partner scalar features that don't depend on synapses.

        Returns `{partner_root_id: {feature_name: value}}`. Partners
        without a usable soma position are simply absent from the dict.

        `root_soma_position_nm` enables features that compare partner
        somas to the queried cell's soma (e.g. radial distance). When
        None, those features are silently omitted from each record —
        same null-graceful pattern as the rest.
        """

    @abstractmethod
    def per_direction_features(
        self,
        *,
        direction: str,
        syn_df: pd.DataFrame | None,
        partner_root_id_column: str,
        syn_position_prefix: str,
    ) -> dict[str, dict[int, float]]:
        """Per-partner per-direction features keyed first by feature name.

        Returns `{feature_name: {partner_root_id: value}}`. The bundle
        assembler routes each entry into the partner record under
        `<feature_name>` (single-direction tabs) or `<feature_name>_in`/
        `<feature_name>_out` (Both tab).

        `direction` is `"in"` or `"out"` — same semantic as the bundle's
        `partners_in`/`partners_out`.
        """

    @abstractmethod
    def summary_panels(
        self,
        *,
        syn_df_in: pd.DataFrame | None,
        syn_df_out: pd.DataFrame | None,
        syn_position_prefix: str,
    ) -> Sequence[SummaryPanel]:
        """Per-cell summary panels (e.g. depth histograms, radial profiles).

        Empty list when the provider has nothing to summarize for this
        cell. Each panel has a `kind` the SPA dispatches on.
        """

    @abstractmethod
    def meta(self) -> dict[str, Any]:
        """Frontend-facing spatial metadata: axis-role → column name,
        per-column label overrides, supported summary-panel kinds.

        Phase 2 surfaces this on the bundle as `bundle.spatial_meta` so
        the SPA can drive axis treatment (depth flip, layer guides) and
        column labels from a single source instead of hardcoded strings.
        """

    @abstractmethod
    def cache_key(self) -> str:
        """Deterministic hash of provider identity (name + params).

        Folded into the `compute_spatial_features_cached` cache key so a
        provider/params change invalidates cleanly without manual eviction.
        """
