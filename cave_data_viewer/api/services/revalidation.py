import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from flask import Flask


class RevalidationExecutor:
    """Background worker pool for SWR revalidations.

    `submit(key, fn)` runs `fn()` once on a background thread inside a fresh Flask
    app context. Re-submitting the same key while a revalidation is in flight is a
    no-op — duplicate work is skipped. Failures are logged and swallowed; SWR is
    self-healing because the next stale-hit will re-queue.
    """

    def __init__(self, app: Flask, *, max_workers: int):
        self._app = app
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="cdv-reval",
        )
        self._in_flight: set[Any] = set()
        self._lock = threading.Lock()

    def submit(self, key: Any, fn: Callable[[], None]) -> bool:
        with self._lock:
            if key in self._in_flight:
                return False
            self._in_flight.add(key)

        def _run() -> None:
            print(f"[reval] start {key!r}", flush=True)
            try:
                with self._app.app_context():
                    fn()
                print(f"[reval] done  {key!r}", flush=True)
            except Exception as exc:
                print(f"[reval] FAIL  {key!r}: {type(exc).__name__}: {exc}", flush=True)
            finally:
                with self._lock:
                    self._in_flight.discard(key)

        self._executor.submit(_run)
        return True

    def is_in_flight(self, key: Any) -> bool:
        with self._lock:
            return key in self._in_flight

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
