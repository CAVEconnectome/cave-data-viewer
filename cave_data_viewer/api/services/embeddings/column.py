"""Universe-aligned values for one feature-table column.

Backs ``GET /column/<col>``. The wire shape (``cell_ids`` + ``values``
+ kind-specific extras like ``raw_range`` / ``color_map`` + parallel
``source_ds`` tag) and 422 codes are unchanged from the inline version.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from ..categorical import (
    get_unique_values as _categorical_get_unique_values,
    resolve_categorical_color_map,
)
from ..datastack_config import check_live_allowed
from ...errors import ApiError
from .loader import SOURCE_DS_COLUMN
from .manifest import FeatureTableSpec
from .runtime import join_seed_columns, load_universe_frame, stringify_cell_ids


def compute_column(
    *,
    ds: str,
    cfg,
    ft: FeatureTableSpec,
    column: str,
    mat_version: int | str | None,
    decoration_tables: list[str],
    seed_raw: str | None,
    client_factory,
) -> dict[str, Any]:
    """Build the column payload. Raises :class:`ApiError` (422) for
    missing-column / missing-mat_version / live-disallowed errors with
    the same code strings as the inline route did."""
    if "." in column:
        table = column.split(".", 1)[0]
        if table not in (ft.id, "nucleus") and table not in decoration_tables:
            decoration_tables = [*decoration_tables, table]

    if decoration_tables and mat_version is None:
        raise ApiError(
            422,
            "missing_mat_version",
            "mat_version is required when the column lives in a "
            "decoration table or synthetic nucleus space",
        )
    if decoration_tables:
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    frame = load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=decoration_tables,
        client_factory=client_factory,
    )

    if column.startswith("seed_"):
        frame = join_seed_columns(
            frame,
            ds=ds,
            cfg=cfg,
            mat_version=mat_version,
            seed_raw=seed_raw,
            client_factory=client_factory,
        )

    if column not in frame.columns:
        raise ApiError(
            422,
            "column_not_found",
            f"column {column!r} not present in feature_table frame "
            f"(have {list(frame.columns)[:20]}…)",
        )

    source_ds_values = [str(v) for v in frame[SOURCE_DS_COLUMN].tolist()]
    series = frame[column]
    if pd.api.types.is_numeric_dtype(series):
        coerced = pd.to_numeric(series, errors="coerce")
        finite = coerced.dropna()
        raw_range = (
            [float(finite.min()), float(finite.max())]
            if not finite.empty
            else [0.0, 0.0]
        )
        return {
            "column": column,
            "kind": "numeric",
            "values": [
                None if pd.isna(v) else float(v) for v in coerced.tolist()
            ],
            "raw_range": raw_range,
            "cell_ids": stringify_cell_ids(frame),
            "source_ds": source_ds_values,
            "n_cells": int(len(frame)),
        }

    table_name = column.split(".", 1)[0] if "." in column else None
    bare_col = column.split(".", 1)[1] if "." in column else column
    universe: list[str]
    if table_name == ft.id or table_name is None:
        universe = series.dropna().astype(str).unique().tolist()
    elif table_name == "nucleus":
        universe = series.dropna().astype(str).unique().tolist()
    else:
        universe = _categorical_get_unique_values(
            client_factory=client_factory,
            ds=ds,
            mat_version=mat_version,
            table=table_name,
            column=bare_col,
        )
        if not universe:
            universe = series.dropna().astype(str).unique().tolist()
    color_map = resolve_categorical_color_map(
        universe=universe,
        observed=series.dropna().tolist(),
    )
    return {
        "column": column,
        "kind": "categorical",
        "values": [None if pd.isna(v) else str(v) for v in series.tolist()],
        "color_map": {str(k): v for k, v in color_map.items() if k is not None},
        "cell_ids": stringify_cell_ids(frame),
        "source_ds": source_ds_values,
        "n_cells": int(len(frame)),
    }
