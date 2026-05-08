"""Per-request timing instrumentation.

Why this exists: most of the latency in this service is spent in CAVE
round-trips (synapse / soma / decoration-table fetches), and the cost of
each varies wildly across datastacks, materialization versions, and
neuron sizes. Without per-stage breakdowns it's impossible to tell
whether a slow `/connectivity` request is bottlenecked on synapse fetch,
decoration enrichment, or in-process aggregation. This module emits one
structured log line per request with a stage-name → ms map.

Usage:

    from .services.timing import timer

    with timer("synapse_query[post]"):
        df = client.materialize.tables.synapses_pni_2(...)

Stages with the same name within one request accumulate into a list, so
two `synapse_query[post]` calls produce `[12.3, 11.8]` rather than
overwriting. Easier to spot duplicate work that way.

The Flask `before_request` hook initializes a per-request stages dict on
`flask.g`; the `after_request` hook emits a JSON payload tagged
`request_timing`. Outside a request context (e.g. unit tests calling
services directly) the timer is a no-op — it doesn't error, just doesn't
record. That keeps tests free of Flask scaffolding.

Logger name: `cdv.timing`. Configured at INFO with its own StreamHandler
so the timing line is greppable independently of Flask's request log.
Production deployments can override with their own `dictConfig`.
"""

import json
import logging
import time
from contextlib import contextmanager

from flask import g, request


logger = logging.getLogger("cdv.timing")


# Stage-name prefixes that count as "CAVE round-trips" for the rollup.
# Cache hits (e.g. `synapse_cache_hit[post]`, `soma_cache_hit`) are NOT
# CAVE-touching even though they share a prefix word — explicit suffix
# match keeps them out. Decoration queries are CAVE-bound but the SWR
# cache means they often warm-hit a per-pod dict; those short-circuit
# before any timer wraps them, so anything that does emit a
# `decoration_query[*]` is a real round-trip.
_CAVE_STAGE_PREFIXES = ("synapse_query", "soma_query", "decoration_query")


def _classify_cave_ms(stages: dict) -> float:
    """Sum every stage value matching a CAVE-query prefix into a single
    rollup. Stages may be scalars (single call) or lists (multiple calls
    of the same name accumulated)."""
    total = 0.0
    for name, value in stages.items():
        if not name.startswith(_CAVE_STAGE_PREFIXES):
            continue
        # Skip cache-hit variants which share the prefix word.
        if "cache_hit" in name:
            continue
        if isinstance(value, list):
            total += sum(value)
        else:
            total += float(value)
    return round(total, 2)


@contextmanager
def timer(stage: str, *, stages: dict | None = None):
    """Time a code block and accumulate the result into a stages dict.

    Default behavior reads/writes `flask.g.timing_stages` — fine for code
    that runs in the request's main thread. Outside a request context,
    silently no-ops.

    `stages` parameter for cross-thread use: when work runs inside a
    `ThreadPoolExecutor`, `flask.g` isn't propagated to worker threads,
    so the default path silently drops the timing. Capture
    `flask.g.timing_stages` at the orchestrator (in the request thread)
    and pass it explicitly into worker code paths so their timings still
    flow back into the request log line.

    Repeated calls with the same `stage` name accumulate as a list —
    useful for spotting per-direction duplication or repeated fetches
    of the same decoration table. CPython's GIL makes single-key dict
    writes safe without an explicit lock; the read-modify-write for the
    list-accumulation case has a theoretical race that's vanishingly
    unlikely at our volumes (< few-dozen worker writes per request).
    """
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        target = stages
        if target is None:
            try:
                target = g.setdefault("timing_stages", {})
            except RuntimeError:
                target = None  # no request context — drop the recording
        # NB: do NOT `return` from inside this finally block. A bare
        # `return` here would silently suppress any in-flight exception
        # raised inside the `yield` — see Python's "exception suppression
        # by return-in-finally" gotcha. Gate the recording on `target`
        # being available instead.
        if target is not None:
            existing = target.get(stage)
            if existing is None:
                target[stage] = elapsed_ms
            elif isinstance(existing, list):
                existing.append(elapsed_ms)
            else:
                target[stage] = [existing, elapsed_ms]


def current_stages() -> dict | None:
    """Return the current request's stages dict, or None when outside a
    request context. Helper for orchestrator code that needs to capture
    the dict reference once and pass it to worker threads (where
    `flask.g` access would raise).
    """
    try:
        return g.setdefault("timing_stages", {})
    except RuntimeError:
        return None


def _configure_logger() -> None:
    """Idempotent logger setup. Always sets level + propagation (so a host
    that attaches its own handler before `init_timing` still gets INFO
    lines through). Only the default StreamHandler is conditional —
    skipped when the host has already attached one to avoid double output.
    """
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    ))
    logger.addHandler(handler)


def init_timing(app) -> None:
    """Wire the request-lifecycle hooks. Called from the app factory."""
    _configure_logger()

    @app.before_request
    def _start_timer():  # noqa: ANN202
        # Skip CORS preflight — the request lifecycle for OPTIONS is
        # very short and not interesting to log.
        if request.method == "OPTIONS":
            return
        g.timing_started = time.perf_counter()
        g.timing_stages = {}

    @app.after_request
    def _emit_timing(response):
        started = g.pop("timing_started", None)
        if started is None:
            return response
        total_ms = round((time.perf_counter() - started) * 1000, 2)
        stages = g.pop("timing_stages", {})
        # CAVE-vs-other rollup. `cave_ms` sums every stage tagged as a
        # CAVE round-trip (synapse / soma / decoration), excluding cache
        # hits. `processing_ms` is the residual — wall time spent on
        # everything else (in-process aggregation, plot building, JSON
        # serialization, network, framework overhead). Together they
        # answer "is this slow request CAVE-bound or CPU-bound?" without
        # needing to scan every stage.
        cave_ms = _classify_cave_ms(stages)
        processing_ms = round(max(total_ms - cave_ms, 0), 2)
        # Single JSON payload — easy to grep, easy to parse for charting
        # later. Path includes the query string-less URL; methods + status
        # round out the surface.
        payload = {
            "endpoint": request.path,
            "method": request.method,
            "status": response.status_code,
            "total_ms": total_ms,
            "cave_ms": cave_ms,
            "processing_ms": processing_ms,
            "stages": stages,
        }
        logger.info("request_timing %s", json.dumps(payload, default=str))
        return response
