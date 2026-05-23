"""Tests for the request-context propagation helper.

The helper consolidates the `copy_current_request_context` + capture
`current_stages()` + capture `current_timestamp()` dance that every
parallelization site used to do by hand. The contracts under test:

- Capture-time fields reflect the request thread's `flask.g` state.
- The wrapped callable sees `current_app` from a worker thread (so
  cache extensions resolve) and receives the captured stages dict +
  timestamp via injected kwargs.
- Outside a request context, capture returns a no-op wrapper that
  injects `None` for both fields without raising.
- Per-kwarg suppression (inject_stages=False / inject_timestamp=False)
  works for sites whose worker callable doesn't accept either kwarg.
"""

from __future__ import annotations

import datetime as _dt
from concurrent.futures import ThreadPoolExecutor

from flask import current_app, g

from cave_data_viewer.api.services.request_context import (
    RequestContext,
    capture_request_context,
)
from cave_data_viewer.api.services.request_state import pin_timestamp
from cave_data_viewer.api.services.timing import current_stages


def test_capture_returns_stages_and_timestamp_from_g(app):
    """Capture must reflect the request thread's `flask.g` state at
    call time. Outside a real request the timestamp may be None, but
    the stages dict is always materialized (a default-mutable dict
    `g.setdefault(...)`); both come back accessible on the context
    object."""
    with app.test_request_context("/?mat_version=live"):
        ts = _dt.datetime(2026, 5, 23, tzinfo=_dt.timezone.utc)
        pin_timestamp(ts)
        # Touch the stages dict so it's instantiated on `g`.
        stages = current_stages()
        stages["pre_capture"] = 1.0

        ctx = capture_request_context()

        assert ctx.timestamp == ts
        assert ctx.stages is stages, (
            "ctx.stages must be the SAME dict reference, not a copy — "
            "worker timer() writes must reach the request thread."
        )
        assert ctx.stages["pre_capture"] == 1.0


def test_capture_outside_request_context_degrades_cleanly(app):
    """The helper must degrade cleanly outside a request context — e.g.
    in the periodic warmer or a unit test that didn't set up a request.

    Two distinct scopes to cover:

    1. **App context only** (the warmer's situation): `current_stages()`
       returns an empty dict via `g.setdefault(...)` because the app
       context provides a `g`; `current_timestamp()` returns `None`
       because nothing pinned it.
    2. **No context at all** (a bare unit test): both helpers swallow
       the `RuntimeError` and return `None`.

    Either way, the resulting RequestContext is callable — the wrapper
    just injects whatever was captured."""
    # Case 1: app context only.
    with app.app_context():
        ctx = capture_request_context()
    assert ctx.stages == {}  # materialized via `g.setdefault`
    assert ctx.timestamp is None

    # Case 2: no context at all.
    ctx = capture_request_context()
    assert ctx.stages is None
    assert ctx.timestamp is None


def test_wrap_propagates_app_context_to_worker_thread(app):
    """The worker callable must be able to read `current_app` — this is
    the load-bearing reason `copy_current_request_context` is in the
    helper. Without it, `current_app.extensions[...]` raises in the
    worker."""
    captured_extensions = {}

    def worker(*, stages, timestamp):
        # If `copy_current_request_context` weren't applied, this line
        # would raise `RuntimeError: Working outside of application
        # context.`
        captured_extensions["dcv_synapse_cache"] = (
            "dcv_synapse_cache" in current_app.extensions
        )
        return (stages, timestamp)

    with app.test_request_context("/?mat_version=live"):
        pin_timestamp(_dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc))
        ctx = capture_request_context()
        wrapped = ctx.wrap(worker)
        with ThreadPoolExecutor(max_workers=1) as pool:
            stages_out, ts_out = pool.submit(wrapped).result()

    assert captured_extensions["dcv_synapse_cache"] is True
    assert ts_out == _dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc)
    assert isinstance(stages_out, dict)


def test_wrap_injects_stages_and_timestamp_kwargs(app):
    """A worker that takes `stages=` and `timestamp=` kwargs gets them
    populated from the captured context. Workers don't have to think
    about how to dig them out of `flask.g` (which is a fresh
    thread-local copy and wouldn't carry the request state anyway)."""
    received: dict = {}

    def worker(*, stages, timestamp):
        received["stages"] = stages
        received["timestamp"] = timestamp

    with app.test_request_context("/?mat_version=live"):
        ts = _dt.datetime(2026, 6, 1, tzinfo=_dt.timezone.utc)
        pin_timestamp(ts)
        stages = current_stages()
        stages["beforehand"] = 42.0
        ctx = capture_request_context()
        ctx.wrap(worker)()  # call synchronously — wrap doesn't require a pool

    assert received["timestamp"] == ts
    assert received["stages"] is stages


def test_wrap_does_not_overwrite_explicit_kwargs(app):
    """Callers that pass an explicit `stages=` or `timestamp=` at submit
    time take precedence over the auto-injection. Lets a worker run with
    a custom stages dict (e.g., a child-job-specific sub-dict) without
    losing the wrapping behavior."""
    received: dict = {}

    def worker(*, stages, timestamp):
        received["stages"] = stages
        received["timestamp"] = timestamp

    explicit_stages = {"custom": True}
    explicit_ts = _dt.datetime(2030, 1, 1, tzinfo=_dt.timezone.utc)

    with app.test_request_context("/?mat_version=live"):
        pin_timestamp(_dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc))
        ctx = capture_request_context()
        ctx.wrap(worker)(stages=explicit_stages, timestamp=explicit_ts)

    assert received["stages"] is explicit_stages
    assert received["timestamp"] == explicit_ts


def test_wrap_can_suppress_per_kwarg_injection(app):
    """`inject_stages=False` / `inject_timestamp=False` let a site whose
    worker callable doesn't accept those kwargs still get the app-context
    propagation. Without these flags the worker would TypeError on
    unexpected keyword argument."""
    received: dict = {}

    def worker_no_kwargs():
        received["called"] = True

    with app.test_request_context("/?mat_version=live"):
        pin_timestamp(_dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc))
        ctx = capture_request_context()
        ctx.wrap(
            worker_no_kwargs, inject_stages=False, inject_timestamp=False,
        )()

    assert received["called"] is True


def test_stages_dict_is_shared_across_worker_writes(app):
    """The whole point of capturing the stages reference is that worker
    timer() calls accumulate into the REQUEST thread's dict, not a
    thread-local copy that vanishes when the worker exits."""
    def worker(*, stages, timestamp):
        stages["from_worker"] = 99.9

    with app.test_request_context("/?mat_version=live"):
        pin_timestamp(_dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc))
        request_stages = current_stages()
        ctx = capture_request_context()
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(ctx.wrap(worker)).result()

        # The request thread's `flask.g.timing_stages` must contain the
        # worker's write.
        assert request_stages["from_worker"] == 99.9
