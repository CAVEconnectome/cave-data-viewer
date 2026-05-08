import datetime as _dt
from typing import Any


def run_query(qf, *, live: bool, timestamp: _dt.datetime | None = None, **kwargs: Any):
    if live:
        ts = timestamp or _dt.datetime.now(_dt.timezone.utc)
        # live_query has a tighter signature than query — drop kwargs it doesn't accept.
        # Notable absences: `select_columns`, `materialization_version`, `get_counts`.
        # Live mode therefore returns the full table column set; we never cache live
        # results so the wider response is a per-request cost only.
        kwargs.pop("materialization_version", None)
        kwargs.pop("get_counts", None)
        kwargs.pop("select_columns", None)
        return qf.live_query(ts, **kwargs)
    return qf.query(**kwargs)
