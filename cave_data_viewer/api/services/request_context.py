"""Helper for propagating request-thread state into worker threads.

Several services parallelize CAVE-bound work via ``ThreadPoolExecutor``
(synapse pre/post in :mod:`services.neuron`, cold decoration fetches in
:mod:`services.decoration`, the live-mode delta fill-in in
:mod:`services.decoration`). Each worker needs:

- An app context so ``current_app.extensions[...]`` resolves.
- Access to the request's timing-stages dict so per-stage timers
  accumulate into the *request's* dict, not a worker-thread-private
  copy.
- Access to the request's pinned consistency timestamp so live-mode
  CAVE calls all hit the same point in time.

``flask.g`` is thread-local, so ``copy_current_request_context`` gives
each worker its own ``g`` — writes never reach the request thread.
This helper captures the stages dict + timestamp ONCE on the request
thread and provides a wrap function that:

1. Wraps the worker callable with ``copy_current_request_context`` so
   ``current_app`` works.
2. Injects ``stages=`` and ``timestamp=`` into the worker call so
   workers don't have to know how to dig them out of the (now-detached)
   ``flask.g``.

Without this helper, each parallelization site re-implements the same
five-line dance, and the next site that forgets to capture the stages
dict silently drops timing while the next site that forgets to capture
the timestamp silently breaks per-request consistency. Both are
production bugs (or have been historically) — see CLAUDE.md's
"`flask.g.timing_stages` isn't shared across threads" callout.
"""

from __future__ import annotations

from typing import Any, Callable

from flask import copy_current_request_context

from .request_state import current_timestamp
from .timing import current_stages


class RequestContext:
    """Captured request-thread state for use across worker threads.

    Build via :func:`capture_request_context` on the request thread,
    then call :meth:`wrap` to wrap any worker callable. The worker:

    - Runs inside a ``copy_current_request_context`` so
      ``current_app.extensions[...]`` and (a copy of) ``flask.g`` are
      reachable.
    - Receives the captured ``stages`` dict and ``timestamp`` as
      injected kwargs, so it can call ``timer(label, stages=stages)``
      and pass ``timestamp=`` to CAVE-fetching helpers without
      consulting ``g`` (which would be a fresh copy on the worker
      thread).

    Use ``inject_stages=False`` / ``inject_timestamp=False`` to
    suppress either injection when the worker doesn't accept those
    kwargs.
    """

    __slots__ = ("stages", "timestamp")

    def __init__(self, *, stages: dict | None, timestamp: Any) -> None:
        self.stages = stages
        self.timestamp = timestamp

    def wrap(
        self,
        fn: Callable,
        *,
        inject_stages: bool = True,
        inject_timestamp: bool = True,
    ) -> Callable:
        """Return a worker-runnable copy of ``fn`` carrying this context.

        The returned callable can be passed straight to
        ``executor.submit(...)``.
        """
        stages = self.stages
        timestamp = self.timestamp

        @copy_current_request_context
        def _runner(*args, **kwargs):
            if inject_stages and "stages" not in kwargs:
                kwargs["stages"] = stages
            if inject_timestamp and "timestamp" not in kwargs:
                kwargs["timestamp"] = timestamp
            return fn(*args, **kwargs)

        return _runner


def capture_request_context() -> RequestContext:
    """Snapshot the current request's timing-stages dict + pinned
    consistency timestamp.

    Must be called on the request thread (typically once, just before
    dispatching work to a pool). Outside a request context — e.g. in
    the periodic warmer, in tests — both fields come back as ``None``
    and the returned :class:`RequestContext` is a no-op wrapper.
    """
    return RequestContext(
        stages=current_stages(),
        timestamp=current_timestamp(),
    )
