"""Row payload for the explorer's cell-list table.

Backs ``POST /feature_tables/<ft>/cells``. Owns the universe frame
construction, filter + lasso intersection, and the ``column_groups``
layout that the partners-table renderer in the SPA consumes. Wire
shape (``rows`` + ``column_groups`` + count fields) and 422 codes are
unchanged from the inline route.
"""

from __future__ import annotations

import math
from typing import Any

from ..datastack_config import check_live_allowed
from ..plots import _apply_cell_filters, _parse_cells_param
from ..timing import timer
from ...errors import ApiError
from .loader import SOURCE_DS_COLUMN
from .manifest import FeatureTableSpec
from .runtime import load_universe_frame


def compute_cells(
    *,
    ds: str,
    cfg,
    ft: FeatureTableSpec,
    feature_table_id: str,
    body: dict[str, Any],
    seed_raw_fallback: str | None,
    client_factory,
    mat_version: int | str | None,
    decoration_tables: list[str],
) -> dict[str, Any]:
    """Build the cell-list payload.

    ``body`` is the request JSON (filters, ``cell_ids`` lasso, ``limit``,
    ``seed``). ``seed_raw_fallback`` is the query-string ``?seed=`` value
    used when the body doesn't carry one — preserves the existing
    fallback for parity with ``/scatter``.

    Raises :class:`ApiError` (422) for the same code strings the inline
    handler raised."""
    try:
        cell_filters = _parse_cells_param(body.get("cells"))
    except ValueError as exc:
        raise ApiError(422, "cells_invalid", str(exc)) from exc
    for f in cell_filters:
        if f.table in (feature_table_id, "nucleus", "seed"):
            continue
        if f.table not in decoration_tables:
            decoration_tables.append(f.table)

    sel_raw = body.get("cell_ids")
    sel_cell_ids: set[int] | None = None
    if sel_raw is not None:
        if not isinstance(sel_raw, list):
            raise ApiError(
                422, "invalid_cell_ids",
                "cell_ids must be a JSON list of integer-compatible values",
            )
        try:
            sel_cell_ids = {int(c) for c in sel_raw if c is not None and c != ""}
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422, "invalid_cell_ids",
                f"cell_ids must be a list of integer-compatible values: {exc}",
            ) from exc

    if decoration_tables:
        if mat_version is None:
            raise ApiError(
                422,
                "missing_mat_version",
                "mat_version is required when decoration tables are attached",
            )
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    try:
        limit = int(body.get("limit", 500000))
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_limit", f"limit must be an integer: {exc}"
        ) from exc

    frame = load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=decoration_tables,
        client_factory=client_factory,
    )
    total_count = int(len(frame))

    seed_raw = body.get("seed")
    if seed_raw is None:
        seed_raw = seed_raw_fallback
    seed_root_id: int | None = None
    if seed_raw is not None and seed_raw != "":
        try:
            seed_root_id = int(seed_raw)
        except (TypeError, ValueError):
            seed_root_id = None
        if seed_root_id is not None and seed_root_id <= 0:
            seed_root_id = None
    if (
        seed_root_id is not None
        and mat_version is not None
        and mat_version != "live"
        and not frame.empty
    ):
        from ..seed import seed_columns
        cell_ids_int = frame["cell_id"].astype("int64").tolist()
        with timer("seed_columns"):
            seed_df = seed_columns(
                client_factory=client_factory,
                cfg=cfg,
                datastack=ds,
                mat_version=mat_version,
                seed_root_id=seed_root_id,
                cell_ids=cell_ids_int,
            )
        frame = frame.join(seed_df, on="cell_id", how="left")

    if cell_filters:
        frame = _apply_cell_filters(frame, cell_filters)
    if sel_cell_ids is not None:
        frame = frame[frame["cell_id"].astype(int).isin(sel_cell_ids)]
    matched_count = int(len(frame))

    limit_hit = matched_count > limit
    if limit_hit:
        frame = frame.head(limit)

    frame = frame.copy()
    frame["cell_id"] = frame["cell_id"].astype(int).astype(str)
    rows = frame.to_dict(orient="records")
    for row in rows:
        for k, v in row.items():
            if isinstance(v, float) and not math.isfinite(v):
                row[k] = None

    feature_cols = [
        f"{ft.id}.{c}" for c in (ft.feature_columns or [])
        if f"{ft.id}.{c}" in frame.columns
    ]
    categorical_cols = [
        f"{ft.id}.{c}" for c in (ft.categorical_columns or [])
        if f"{ft.id}.{c}" in frame.columns
    ]
    id_columns: list[str] = ["cell_id"]
    if SOURCE_DS_COLUMN in frame.columns:
        id_columns.append(SOURCE_DS_COLUMN)
    column_groups: list[dict] = [
        {"name": "id", "kind": "intrinsic", "columns": id_columns},
    ]
    parquet_cols = feature_cols + categorical_cols
    if parquet_cols:
        column_groups.append(
            {"name": ft.id, "kind": "table", "columns": parquet_cols}
        )
    nucleus_cols = [
        c for c in ("nucleus.x", "nucleus.y", "nucleus.z") if c in frame.columns
    ]
    if nucleus_cols:
        column_groups.append(
            {"name": "nucleus", "kind": "table", "columns": nucleus_cols}
        )
    for table in decoration_tables:
        cols = [c for c in frame.columns if c.startswith(f"{table}.")]
        if cols:
            column_groups.append(
                {"name": table, "kind": "table", "columns": cols}
            )

    seed_cols = [c for c in frame.columns if c.startswith("seed_")]
    if seed_cols:
        canonical = [
            "seed_partner_dir", "seed_is_partner",
            "seed_n_syn_in", "seed_n_syn_out",
        ]
        ordered = [c for c in canonical if c in seed_cols] + [
            c for c in seed_cols if c not in canonical
        ]
        column_groups.append(
            {"name": "seed", "kind": "synthetic", "columns": ordered}
        )

    return {
        "cell_ids": [row["cell_id"] for row in rows],
        "rows": rows,
        "column_groups": column_groups,
        "matched_count": matched_count,
        "total_count": total_count,
        "limit": limit,
        "limit_hit": limit_hit,
    }
