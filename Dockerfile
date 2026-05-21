# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   1. `frontend`   — Node 20 builds the React/Vite SPA into frontend/dist.
#   2. `backend`    — Debian-slim Python 3.13 + uv, syncs the locked deps
#                     into /app/.venv. uv binary is mixed in from
#                     ghcr.io/astral-sh/uv (recommended pattern — keeps
#                     the python image clean and uses the official uv
#                     release without a `pip install`).
#   3. final stage  — runtime image. Copies `.venv` from `backend` and
#                     `frontend/dist` from `frontend`, plus the backend
#                     source. Entry runs gunicorn with 1 worker (the
#                     SWR ticket/poll flow is per-process — a ticket
#                     minted by one worker can't be polled by another,
#                     since each gunicorn worker is its own process
#                     with its own in-memory ticket map. The GCS L2
#                     cache shares cached data across pods but does
#                     not share ticket state).
#
# Configuration model: the image ships with NO bundled config. Every
# deployment supplies its own datastack / aligned-volume / feature-table
# YAMLs by mounting a directory at /app/config. The layout mirrors the
# repo's config/ tree:
#
#   /app/config/
#     datastacks/<datastack>.yaml
#     aligned_volumes/<aligned_volume>.yaml
#     feature_tables/<datastack>/<feature_table>.yaml
#
# Without a mount the SPA loads but the datastack picker is empty and the
# /api/v1/datastacks endpoint returns []. That's by design — every deploy
# is expected to supply its own set of YAMLs.
#
# Build:   docker build -t cdv .
# Run:     docker run --rm -p 8000:8000 \
#            -v /local/config:/app/config \
#            -e GLOBAL_SERVER=global.daf-apis.com \
#            cdv
#
# Production feature-table catalog hosted in GCS instead of bind-mounted:
#   docker run ... -v /local/config:/app/config \
#     -e CDV_FEATURE_TABLES_BASE_URI=gs://my-bucket/ cdv
#
# Auth bypass for local testing only — never set in prod:
#   docker run ... -e CDV_DEV_AUTH_BYPASS=1 cdv

# ---------- Stage 1: Frontend build ------------------------------------------
FROM node:20-bookworm-slim AS frontend
WORKDIR /app/frontend
# Lockfile-first copy + `npm ci` for reproducible installs. Two-step copy
# means a code-only change doesn't bust the npm-install layer cache.
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- Stage 2: Backend deps (uv-managed) -------------------------------
FROM python:3.13-slim-bookworm AS backend
# uv mix-in: copy the uv binaries from the official image. Pinned to a
# specific version rather than `latest` for build determinism — bump as
# needed.
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/

# Build toolchain — `neuroglancer` (transitive via `nglui`) ships a C++
# extension that compiles from source on Linux/aarch64 (no published
# wheel). build-essential covers gcc/g++/make/libc-dev. Lives in this
# stage only; the runtime stage doesn't copy any of it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# uv knobs:
#   UV_LINK_MODE=copy       — works on bind-mounted source (no hardlink
#                             attempts that fail across filesystems).
#   UV_COMPILE_BYTECODE=1   — pre-compile .pyc; small CPU cost at build
#                             time, faster cold start in the runtime.
#   UV_PYTHON_DOWNLOADS=never — use the python from the base image; don't
#                             let uv download a different one.
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

# Sync locked deps WITHOUT installing the project itself yet. This lets a
# code-only change reuse this layer — the heavy pandas/plotly compile
# step only re-runs when pyproject.toml or uv.lock changes.
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev

# Now bring in the source and install the project itself (fast — no deps
# left to compile). The repo's `config/` directory is NOT copied: bundled
# YAMLs are dev-only convenience; the image ships empty and every
# deployment supplies its own config via a /app/config bind-mount.
COPY cave_data_viewer/ ./cave_data_viewer/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# ---------- Stage 3: Runtime --------------------------------------------------
FROM python:3.13-slim-bookworm

# tini for proper signal handling under K8s (PID 1 forwarding SIGTERM
# correctly so gunicorn shuts down cleanly on pod termination).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pull the prebuilt virtualenv + project source from the backend stage.
# The source copy (not the venv-installed wheel) is what Python actually
# imports here: `/app` is implicit on sys.path ahead of site-packages,
# so the source tree shadows the installed package.
COPY --from=backend /app/.venv /app/.venv
COPY --from=backend /app/cave_data_viewer /app/cave_data_viewer

# Built SPA assets — Flask serves these via the catch-all route in
# `api/__init__.py::_register_spa`. Path here matches the default
# `CDV_SPA_DIR` (frontend/dist relative to WORKDIR).
COPY --from=frontend /app/frontend/dist /app/frontend/dist

# `/app/config` is the deployment-supplied configuration mount point.
# Create it empty so the volume-mount target exists; without a mount,
# the loaders see an empty directory and the datastack picker is empty
# (intentional — every deploy supplies its own YAMLs).
RUN mkdir -p /app/config

# Run as a non-root user — defense in depth against container escape via
# any Python deserialization bug. uid/gid 1000 matches the conventional
# K8s `runAsUser` setting.
RUN groupadd --system --gid 1000 cdv \
 && useradd --system --uid 1000 --gid cdv --home-dir /app cdv \
 && chown -R cdv:cdv /app
USER cdv

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CDV_PORT=8000 \
    CDV_WORKERS=1 \
    CDV_TIMEOUT=120

EXPOSE 8000

# Liveness probe via the unauthenticated /api/v1/healthz endpoint. Uses
# python's stdlib `urllib` rather than installing curl — keeps the
# runtime image lean. Exit 1 on any non-200 (caught by the bare `except`),
# which docker/k8s reads as unhealthy. K8s users typically configure
# their own liveness/readiness probes against the same endpoint;
# HEALTHCHECK here is for plain-docker users and for k8s clusters that
# pick up image-defined probes via dockershim/podman compatibility.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys,os; \
        u='http://127.0.0.1:'+os.environ.get('CDV_PORT','8000')+'/api/v1/healthz'; \
        sys.exit(0 if urllib.request.urlopen(u, timeout=4).status==200 else 1)" \
        || exit 1

# tini reaps zombies and forwards signals; gunicorn runs the WSGI app
# factory directly. `--access-logfile -` sends access logs to stdout
# alongside the structured timing logs from `services/timing.py`.
# `--worker-tmp-dir /dev/shm` sidesteps an old K8s perf cliff where
# gunicorn's heartbeat file on a slow tmpfs caused worker timeouts.
# `--timeout` defaults to 30s; bumped to CDV_TIMEOUT=120 because cold
# CAVE round-trips on a heavily-connected neuron (synapse fetch ~5s
# per direction + cell-type table fetch ~10-15s + soma table fetch
# ~5-10s) can stack to 30s+ on the very first request after cache
# warmup expiry. K8s pod-level timeouts (ingress idle timeout, etc.)
# should be configured to match or exceed this.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "exec gunicorn \
        --bind 0.0.0.0:${CDV_PORT} \
        --workers ${CDV_WORKERS} \
        --timeout ${CDV_TIMEOUT} \
        --worker-tmp-dir /dev/shm \
        --access-logfile - \
        --error-logfile - \
        'cave_data_viewer.api:create_app()'"]
