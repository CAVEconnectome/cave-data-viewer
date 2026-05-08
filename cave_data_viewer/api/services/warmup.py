"""Periodic background warmer for whole-table decoration caches.

In a multi-pod K8s deployment in-process caches are per-pod. The synapse cache is
unavoidably cold for any (root_id) the pod hasn't seen, but the much smaller
reference-data caches (cell-type tables, nucleus/soma table) can be kept warm by
periodically refreshing them. This module owns a single background thread that
fires registered refresh callables on per-job intervals.

Default off — register jobs explicitly in `init_decoration_service`.
"""

import random
import threading
import time
from typing import Callable

from flask import Flask


_FIRST_RUN_JITTER_SECONDS = 60.0


class PeriodicWarmer:
    def __init__(self, app: Flask):
        self._app = app
        # (name, fn, interval, startup_delay)
        self._jobs: list[tuple[str, Callable[[], None], float, float]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def register(self, name: str, fn: Callable[[], None],
                 interval_seconds: float, startup_delay_seconds: float = 0.0) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        if startup_delay_seconds < 0:
            raise ValueError("startup_delay_seconds must be >= 0")
        self._jobs.append((name, fn, float(interval_seconds), float(startup_delay_seconds)))

    def start(self) -> None:
        if not self._jobs or self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="cdv-warmer")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        # First fire = now + startup_delay + jitter. Random jitter (capped) absorbs
        # synchronized pod boots in autoscaling deployments so multiple pods don't all
        # hammer CAVE the same second.
        now = time.time()
        next_run: dict[str, float] = {
            name: now + delay + random.uniform(0, _FIRST_RUN_JITTER_SECONDS)
            for name, _, _, delay in self._jobs
        }
        while not self._stop.is_set():
            now = time.time()
            for name, fn, interval, _delay in self._jobs:
                if now >= next_run[name]:
                    next_run[name] = now + interval
                    print(f"[warmup] running {name}", flush=True)
                    try:
                        with self._app.app_context():
                            fn()
                        print(f"[warmup] done    {name}", flush=True)
                    except Exception as exc:
                        print(f"[warmup] FAILED  {name}: {type(exc).__name__}: {exc}", flush=True)
            # Wake every 30s to check; short enough that `stop()` shuts the warmer
            # down well before reasonable test timeouts.
            if self._stop.wait(timeout=30):
                return
