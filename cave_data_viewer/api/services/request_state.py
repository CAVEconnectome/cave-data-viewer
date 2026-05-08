"""Per-request scratch state on `flask.g`.

Why this exists: certain pieces of state need to be consistent across
*every CAVE call within one request*, but they're consumed by code paths
deep in the service layer that have no direct line to the endpoint
handler. The clearest example is the "timestamp for consistency" that
pins all live-mode CAVE reads to the same point in time — see
`pin_timestamp` below.

Pattern: endpoints pin once at handler entry; service-layer code reads
via `current_timestamp` whenever it's about to hit CAVE. Outside a
request context (e.g. background warmup workers, unit tests) the
readers return `None` and call sites fall back to the default behavior
(usually `datetime.now()` or "no consistency contract").
"""

from __future__ import annotations

import datetime as _dt

from flask import g, request


_TIMESTAMP_KEY = "timestamp_for_consistency"


def pin_timestamp(timestamp: _dt.datetime | None) -> None:
    """Pin the request's consistency timestamp.

    Endpoints call this once at handler entry so that every CAVE read
    later in the request — synapse, soma, decoration, cell-id lookup —
    can fix on a single point in time.

    For live mode: pass `datetime.now(utc)`. Every live CAVE call in
    this request will use this exact timestamp, guaranteeing that
    synapse data and decoration data reflect the same world state.

    For materialized mode: pass `None` (the default). Materialized
    queries are implicitly consistent via the version number, so no
    timestamp is needed for query consistency. (For features like
    `suggest_latest_root` that need a timestamp regardless of mode,
    derive it from version metadata at the call site rather than pinning
    at entry — keeps the pin path simple.)
    """
    g.timestamp_for_consistency = timestamp


def current_timestamp() -> _dt.datetime | None:
    """Read the request's consistency timestamp.

    Returns `None` when (a) outside a Flask request context, (b) the
    handler hasn't pinned one (e.g., a non-CAVE endpoint), or (c) the
    request is materialized-mode (timestamp pinning is a live-mode
    construct). Callers fall back to per-call `datetime.now()` in
    those cases.
    """
    try:
        return g.get(_TIMESTAMP_KEY)
    except RuntimeError:
        return None


def init_request_state(app) -> None:
    """Wire a `before_request` hook that auto-pins the consistency
    timestamp for live-mode requests.

    Detection: any request whose query string carries `mat_version=live`
    (the SPA convention for live mode) is treated as live. Materialized
    requests pin `None` (still settable, just no-op for query consistency).
    Non-CAVE endpoints (`/api/v1/healthz`, `/api/v1/version`) get
    `None` — they don't query CAVE so it doesn't matter.

    This central hook lets every CAVE-touching service call site read
    via `current_timestamp()` without endpoints having to remember to
    pin manually.
    """
    @app.before_request
    def _pin_consistency_timestamp() -> None:
        mv = request.args.get("mat_version") or None
        if mv == "live":
            pin_timestamp(_dt.datetime.now(_dt.timezone.utc))
        else:
            pin_timestamp(None)
