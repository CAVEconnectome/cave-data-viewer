"""Runtime helpers shared across the feature-explorer routes.

These functions take typed arguments (no Flask request introspection)
and return Python objects, so the GET / POST routes in
``endpoints/embeddings.py`` share one universe-frame loader, one
seed-column join, and one set of arg-parsing helpers. The route module
owns request parsing — pulling the raw values from Flask — and these
helpers coerce them; everything downstream operates on typed Python
objects.
"""

from __future__ import annotations

import pandas as pd

from ..timing import timer
from .manifest import FeatureTableSpec
from .query import FeatureTableQuery


def stringify_cell_ids(frame: pd.DataFrame) -> list[str]:
    """Wire-shape cell_id rendering: int64 column → list[str].

    Cell ids exceed JS Number precision (2**53), so the SPA expects
    them as strings end-to-end. Every endpoint that emits a parallel
    arrays payload routes through here for consistency.
    """
    return [str(int(c)) for c in frame["cell_id"].tolist()]


def load_universe_frame(
    *,
    ds: str,
    cfg,
    ft: FeatureTableSpec,
    mat_version: int | str | None,
    decoration_tables: list[str],
    client_factory,
) -> pd.DataFrame:
    """Universe frame for one feature table at one mat_version.

    Builds a :class:`FeatureTableQuery` and returns ``ft_query.frame()``
    with the requested decoration tables joined. Every endpoint that
    operates on the per-feature-table frame (``/scatter``, ``/column``,
    ``/cells``, ``/column_histogram``, ``/seed_summary``) routes through
    here so the decoration-tables coercion lives in one place.
    """
    ft_query = FeatureTableQuery(
        datastack=ds,
        mat_version=mat_version,
        feature_table=ft,
        cfg=cfg,
        client_factory=client_factory,
    )
    return ft_query.frame(decoration_tables=decoration_tables or None)


def parse_mat_version(raw: str | int | None) -> int | str | None:
    """Coerce a raw ``mat_version`` value (from query string or JSON
    body) into the int / "live" / None tri-state every route uses.

    Raises :class:`ValueError` for non-empty values that aren't ``"live"``
    and don't parse as ints; the route handler translates that to
    ``ApiError(422, "invalid_mat_version", ...)``.
    """
    if raw is None or raw == "":
        return None
    if raw == "live":
        return "live"
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"mat_version must be an integer or 'live', got {raw!r}"
        ) from exc


def parse_decoration_tables(raw: str | list | None) -> list[str]:
    """Coerce the ``dec`` parameter (either a comma-separated query
    string or a JSON list body field) into a stripped list of table
    names. Empty / missing yields an empty list."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(t).strip() for t in raw if str(t).strip()]
    if isinstance(raw, str):
        return [t.strip() for t in raw.split(",") if t.strip()]
    return []


def auto_attach_decoration_tables(
    decoration_tables: list[str],
    *cols: str | None,
    ft: FeatureTableSpec,
) -> list[str]:
    """Extend ``decoration_tables`` with any decoration tables referenced
    by ``cols`` that aren't already listed.

    Columns that live natively on the feature-table frame (``<ft.id>.*``,
    ``nucleus.*``, ``seed_*``) don't trigger an attach — the frame has
    them already. The returned list preserves the original order with
    newly-attached tables appended (matches what the inline implementations
    did before the extraction).
    """
    out = list(decoration_tables)
    for col in cols:
        if not col:
            continue
        if "." not in col:
            continue
        table = col.split(".", 1)[0]
        if table in (ft.id, "nucleus"):
            continue
        if table not in out:
            out.append(table)
    return out


def parse_seed_root(seed_raw: str | None) -> int | None:
    """Coerce a raw ``?seed=`` value to a positive int root_id, or None.

    Tolerant by design — every route accepts a seed param and the same
    rejection rules (missing, non-int, non-positive) apply uniformly.
    """
    if seed_raw is None or seed_raw == "":
        return None
    try:
        v = int(seed_raw)
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


def join_seed_columns(
    frame: pd.DataFrame,
    *,
    ds: str,
    cfg,
    mat_version: int | str | None,
    seed_raw: str | None,
    client_factory,
) -> pd.DataFrame:
    """Left-join the connectivity-seed ``seed_*`` columns onto an
    embedding frame. No-op when no valid seed is set, in live mode (no
    universe cache backs the resolver), or on an empty frame. Shared by
    the ``/cells``, ``/column`` and ``/column_histogram`` endpoints;
    ``/scatter`` keeps its own channel-gated copy because it only does
    the join when one of the scatter channels references a ``seed_*``
    column.
    """
    seed_root_id = parse_seed_root(seed_raw)
    if (
        seed_root_id is None
        or mat_version is None
        or mat_version == "live"
        or frame.empty
    ):
        return frame
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
    return frame.join(seed_df, on="cell_id", how="left")
