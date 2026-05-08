from typing import Any

import pandas as pd

from .keys import is_live
from .query_runner import run_query


def is_view_name(client, name: str) -> bool:
    """Return True if `name` is a CAVE view (vs a table) for this client.

    Probes ``get_tables()`` first, then ``get_views()``. Both are cached
    in `table_meta_cache` upstream, so this is essentially free after the
    first call per request. Defaults to False (table) when both probes
    fail — the caller's downstream query will surface a clearer error
    than this helper could.

    The same logic lives inline on `TableQuery._detect_is_view` for the
    table-rows endpoint; this module-level export lets the decoration
    fetchers in `services/decoration.py` dispatch to the right manager
    (``client.materialize.views`` vs ``.tables``) without duplicating the
    probe.
    """
    try:
        if name in client.materialize.get_tables():
            return False
    except Exception:
        pass
    try:
        if name in client.materialize.get_views():
            return True
    except Exception:
        pass
    return False


_RESERVED_PARAMS = {"offset", "limit", "mat_version", "is_view",
                    "select_columns", "split_positions"}

# Django-style suffixes for range / inequality filters. Map URL suffix → CAVE
# auto-detect operator key. CAVE's `client.materialize.tables[name](**kwargs)`
# accepts a per-column dict shaped `{">": 5, "<=": 10, ...}` and dispatches
# to filter_greater_dict / filter_less_equal_dict / etc. internally; we just
# have to coerce the URL into that dict shape.
_RANGE_SUFFIXES: dict[str, str] = {
    "__gt": ">",
    "__gte": ">=",
    "__lt": "<",
    "__lte": "<=",
}


def parse_filters(query_args: dict[str, str]) -> dict[str, Any]:
    """Build a CAVE filter kwargs dict from URL query params.

    Three URL shapes:
      `?col=val`                 → equality                  `{col: val}`
      `?col=a,b,c`               → IN                        `{col: [a, b, c]}`
      `?col__gt=5&col__lte=10`   → range                     `{col: {">": 5, "<=": 10}}`

    Equality and range-on-the-same-column compose: `?col=5&col__gt=5` would
    set both an equality and a `>` op (CAVE auto-detect rejects ambiguous
    combinations, so this is a user error rather than something we mediate).

    Reserved params (`offset`, `limit`, `mat_version`, `is_view`,
    `select_columns`, `split_positions`) are passed through unchanged to
    the request handler — they're for the endpoint, not for CAVE.
    """
    filters: dict[str, Any] = {}
    range_buckets: dict[str, dict[str, Any]] = {}
    for key, raw in query_args.items():
        if key in _RESERVED_PARAMS:
            continue
        # Range suffix? Strip and accumulate into a per-column op-dict.
        suffix_match = next(
            ((sfx, op) for sfx, op in _RANGE_SUFFIXES.items() if key.endswith(sfx)),
            None,
        )
        if suffix_match is not None:
            sfx, op = suffix_match
            col = key[: -len(sfx)]
            if not col:
                continue
            range_buckets.setdefault(col, {})[op] = _coerce(raw)
            continue
        # Plain equality / IN.
        if "," in raw:
            filters[key] = [_coerce(part) for part in raw.split(",") if part.strip()]
        else:
            filters[key] = _coerce(raw)

    # Merge range buckets into the result. If the user *also* sent an equality
    # filter for the same column we'd be conflating two semantics — favor the
    # range dict since the explicit suffix is the more deliberate signal.
    for col, op_dict in range_buckets.items():
        filters[col] = op_dict
    return filters


def _coerce(value: str):
    value = value.strip()
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    return value


class TableQuery:
    def __init__(
        self,
        client,
        name: str,
        *,
        filters: dict[str, Any] | None = None,
        is_view: bool | None = None,
        mat_version: int | str | None = None,
    ):
        self.client = client
        self.name = name
        self.filters = filters or {}
        self.is_view = is_view if is_view is not None else self._detect_is_view()
        self._mgr = client.materialize.views if self.is_view else client.materialize.tables
        self.mat_version = mat_version
        if self.is_view and is_live(mat_version):
            raise ValueError(
                "Views are only available in materialized mode; "
                "pass an explicit mat_version to query a view."
            )

    def _detect_is_view(self) -> bool:
        return is_view_name(self.client, self.name)

    def rows(
        self,
        *,
        offset: int = 0,
        limit: int = 500,
        split_positions: bool = True,
        select_columns: list[str] | None = None,
        desired_resolution: list[float] | None = None,
    ) -> pd.DataFrame:
        """Pull rows from the table or view.

        `desired_resolution` is forwarded to the CAVE materialization query so
        position columns come back rescaled to that voxel resolution. Pass the
        datastack's viewer_resolution (typically `[4, 4, 40]` for minnie) to
        get position values in the same units a stock Neuroglancer link uses —
        the SPA can paste them straight into a viewer state without any
        nm-conversion at our layer. Default `None` keeps the table's native
        resolution.
        """
        qf = self._mgr[self.name](**self.filters)
        kwargs: dict[str, Any] = {
            "offset": offset,
            "limit": limit,
            "split_positions": split_positions,
        }
        if select_columns:
            kwargs["select_columns"] = select_columns
        if desired_resolution is not None:
            kwargs["desired_resolution"] = desired_resolution
        # Views always use .query(); tables dispatch on live mode.
        live = (not self.is_view) and is_live(self.mat_version)
        # Pinned consistency timestamp from the request (live mode only).
        # Outside a request context `current_timestamp` returns None and
        # `run_query` falls back to `now()`.
        from .request_state import current_timestamp
        return run_query(qf, live=live, timestamp=current_timestamp(), **kwargs)
