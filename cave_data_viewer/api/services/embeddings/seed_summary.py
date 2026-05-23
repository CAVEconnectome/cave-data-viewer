"""Connectivity-seed summary restricted to a feature table's universe.

Backs ``GET /feature_tables/<ft>/seed_summary``. Counts the partners
that actually appear in the feature table (the whole-connectome counts
from ``/connectivity`` over-count for the explorer because cells absent
from the table are still counted in the connectivity bundle).
"""

from __future__ import annotations

from typing import Any

from ..timing import timer
from .manifest import FeatureTableSpec
from .runtime import load_universe_frame


def compute_seed_summary(
    *,
    ds: str,
    cfg,
    ft: FeatureTableSpec,
    seed_root_id: int,
    mat_version: int | str,
    client_factory,
) -> dict[str, Any]:
    """Universe-restricted partner counts for one seed root_id.

    Returns ``{n_in, n_out, n_partners, n_universe}``. ``n_in`` /
    ``n_out`` count cells with any input / output contact; reciprocals
    are counted in both. ``n_partners`` is the distinct partner count.
    """
    frame = load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=[],
        client_factory=client_factory,
    )
    if frame.empty:
        return {"n_in": 0, "n_out": 0, "n_partners": 0, "n_universe": 0}

    from ..seed import seed_columns
    with timer("seed_columns"):
        seed_df = seed_columns(
            client_factory=client_factory,
            cfg=cfg,
            datastack=ds,
            mat_version=mat_version,
            seed_root_id=seed_root_id,
            cell_ids=frame["cell_id"].astype("int64").tolist(),
        )
    direction = seed_df["seed_partner_dir"].astype("string")
    return {
        "n_in": int(direction.isin(["in", "both"]).sum()),
        "n_out": int(direction.isin(["out", "both"]).sum()),
        "n_partners": int((direction != "none").sum()),
        "n_universe": int(len(frame)),
    }
