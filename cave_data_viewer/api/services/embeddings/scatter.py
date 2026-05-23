"""Universe scatter payload for one embedding view, with optional
channel bindings.

Extracted from ``endpoints/embeddings.py``: the handler parses the
request and dispatches here; this module owns the frame work, channel
projections, and response shaping. Wire shape (parallel arrays + axes +
color/size blocks) and 422 error codes are unchanged.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from ..categorical import (
    get_unique_values as _categorical_get_unique_values,
    resolve_categorical_color_map,
)
from ..datastack_config import check_live_allowed
from ..timing import timer
from ...errors import ApiError
from .loader import SOURCE_DS_COLUMN
from .manifest import EmbeddingSpec, FeatureTableSpec
from .runtime import (
    auto_attach_decoration_tables,
    load_universe_frame,
    stringify_cell_ids,
)


def compute_scatter(
    *,
    ds: str,
    cfg,
    ft: FeatureTableSpec,
    emb: EmbeddingSpec,
    mat_version: int | str | None,
    x_override: str | None,
    y_override: str | None,
    color_col: str | None,
    size_col: str | None,
    decoration_tables: list[str],
    seed_root_id: int | None,
    client_factory,
) -> dict[str, Any]:
    """Build the scatter payload. Raises :class:`ApiError` (422) for
    invalid channel bindings; the handler bubbles it up unchanged."""
    default_x = f"{ft.id}.{emb.axes[0]}"
    default_y = f"{ft.id}.{emb.axes[1]}"
    x_col = x_override or default_x
    y_col = y_override or default_y

    decoration_tables = auto_attach_decoration_tables(
        decoration_tables, x_col, y_col, color_col, size_col, ft=ft,
    )

    if decoration_tables and mat_version is None:
        raise ApiError(
            422,
            "missing_mat_version",
            "mat_version is required when a channel references a "
            "decoration column",
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

    channels_use_seed = any(
        (c and c.startswith("seed_")) for c in (x_col, y_col, color_col, size_col)
    )
    if (
        seed_root_id is not None
        and channels_use_seed
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

    missing_axes = [c for c in (x_col, y_col) if c not in frame.columns]
    if missing_axes:
        if (
            any(m and m.startswith("seed_") for m in missing_axes)
            and seed_root_id is None
        ):
            raise ApiError(
                422,
                "channel_requires_seed",
                f"axis references seed-derived column(s) {missing_axes!r} "
                f"— set a connectivity seed in the left rail first.",
            )
        raise ApiError(
            422,
            "channel_column_missing",
            f"axis references unknown column(s) {missing_axes!r} "
            f"(have {list(frame.columns)})",
        )
    if color_col and color_col not in frame.columns:
        color_col = None
    if size_col and size_col not in frame.columns:
        size_col = None

    color_block = _color_block(
        color_col=color_col,
        frame=frame,
        ft=ft,
        client_factory=client_factory,
        ds=ds,
        mat_version=mat_version,
    )
    size_block = _size_block(size_col=size_col, frame=frame)

    return {
        "cell_ids": stringify_cell_ids(frame),
        "source_ds": [str(v) for v in frame[SOURCE_DS_COLUMN].tolist()],
        "x": [
            None if pd.isna(v) else float(v) for v in frame[x_col].tolist()
        ],
        "y": [
            None if pd.isna(v) else float(v) for v in frame[y_col].tolist()
        ],
        "axes": {"x": x_col, "y": y_col},
        "color": color_block,
        "size": size_block,
        "n_cells": int(len(frame)),
    }


def _color_block(
    *,
    color_col: str | None,
    frame: pd.DataFrame,
    ft: FeatureTableSpec,
    client_factory,
    ds: str,
    mat_version: int | str | None,
) -> dict | None:
    if not color_col:
        return None
    series = frame[color_col]
    if pd.api.types.is_numeric_dtype(series):
        return {
            "column": color_col,
            "kind": "numeric",
            "values": [
                None if pd.isna(v) else float(v) for v in series.tolist()
            ],
        }
    table_name = color_col.split(".", 1)[0] if "." in color_col else None
    bare_col = color_col.split(".", 1)[1] if "." in color_col else color_col
    universe: list[str]
    if table_name == ft.id:
        universe = series.dropna().astype(str).unique().tolist()
    elif table_name:
        universe = _categorical_get_unique_values(
            client_factory=client_factory,
            ds=ds,
            mat_version=mat_version,
            table=table_name,
            column=bare_col,
        )
        if not universe:
            universe = series.dropna().astype(str).unique().tolist()
    else:
        universe = series.dropna().astype(str).unique().tolist()
    color_map = resolve_categorical_color_map(
        universe=universe,
        observed=series.dropna().tolist(),
    )
    return {
        "column": color_col,
        "kind": "categorical",
        "values": [None if pd.isna(v) else str(v) for v in series.tolist()],
        "color_map": {str(k): v for k, v in color_map.items() if k is not None},
    }


def _size_block(
    *,
    size_col: str | None,
    frame: pd.DataFrame,
) -> dict | None:
    if not size_col:
        return None
    series = frame[size_col]
    if not pd.api.types.is_numeric_dtype(series):
        raise ApiError(
            422,
            "channel_size_non_numeric",
            f"size channel {size_col!r} is not numeric "
            f"(dtype={series.dtype}); size only supports numeric columns",
        )
    finite = pd.to_numeric(series, errors="coerce").dropna()
    if finite.empty:
        raw_range = [0.0, 0.0]
    else:
        raw_range = [float(finite.min()), float(finite.max())]
    coerced = pd.to_numeric(series, errors="coerce")
    return {
        "column": size_col,
        "values": [
            None if pd.isna(v) else float(v) for v in coerced.tolist()
        ],
        "raw_range": raw_range,
    }
