import os
from pathlib import Path

from flask import Flask, send_from_directory
from flask_cors import CORS

from .auth import auth_required
from .config import configure_app
from .errors import register_error_handlers
from .endpoints import api_bp
from .json_provider import NumpyJSONProvider
from .services.decoration import init_decoration_service
from .services.longlived_registry import LonglivedRegistry
from .services.object_store import build_info_store, build_l2_stores, build_userdata_store
from .services.request_state import init_request_state
from .services.timing import init_timing


def create_app(config_overrides: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.json = NumpyJSONProvider(app)
    configure_app(app, overrides=config_overrides)
    CORS(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=True,
    )
    register_error_handlers(app)
    # Order matters: longlived registry must be ready before
    # init_decoration_service builds the retention-aware L2 wrappers.
    _init_longlived_registry(app)
    _init_userdata_store(app)
    init_decoration_service(app)
    _init_synapse_l2(app)
    init_timing(app)
    init_request_state(app)
    app.register_blueprint(api_bp, url_prefix="/api/v1")
    _register_spa(app)
    return app


def _init_longlived_registry(app: Flask) -> None:
    """TTL-cached reader of the per-datastack longlived-versions marker
    files. Single instance per app; consulted at every cache-key
    construction site that needs to know whether a mat_version should
    land in the longlived (1–2 year) or default (2 day) L2 partition.
    """
    info_store = build_info_store(app)
    ttl = float(app.config.get("LONGLIVED_VERSIONS_TTL_SECONDS", 300))
    app.extensions["dcv_longlived_registry"] = LonglivedRegistry(
        info_store=info_store, ttl_seconds=ttl,
    )


def _init_userdata_store(app: Flask) -> None:
    """Per-user JSON/YAML store (currently personal recipes). Sibling of the
    cache stores; lives at `<CDV_GCS_CACHE_PREFIX>userdata/`. None when GCS
    isn't configured — the recipes endpoints surface that as
    `{enabled: false, reason: "no_bucket"}` so the SPA falls back to a
    localStorage-only mode without UX friction."""
    app.extensions["dcv_userdata_store"] = build_userdata_store(app)


def _init_synapse_l2(app: Flask) -> None:
    """Wire the optional GCS L2 stores + writer for synapse DataFrames.

    Synapse L2 is independent of `DecorationService` because each write
    is idempotent (CAVE results are immutable for a given mat_version
    key) and runs without an app context — neither the dedup nor the
    request-context plumbing of `RevalidationExecutor` is needed.

    `dcv_synapse_l2` becomes `dict[str, GcsObjectStore]` keyed by
    retention class (`default`, `longlived`). `_synapse_df` resolves
    the retention class once per call and indexes into this dict.

    Both extensions are unset when `GCS_CACHE_BUCKET` isn't configured;
    `NeuronQuery._synapse_df` treats that as "no L2" and behaves
    identically to today.
    """
    from concurrent.futures import ThreadPoolExecutor

    l2 = build_l2_stores(app)
    if not l2:
        app.extensions["dcv_synapse_l2"] = None
        app.extensions["dcv_l2_writer"] = None
        return
    synapse_stores = {
        retention: l2[retention]["synapse"] for retention in l2
    }
    app.extensions["dcv_synapse_l2"] = synapse_stores
    app.extensions["dcv_l2_writer"] = ThreadPoolExecutor(
        max_workers=4, thread_name_prefix="cdv-l2-write"
    )


def _register_spa(app: Flask) -> None:
    """Serve the built React SPA for non-API routes when the build output
    is on disk.

    The Vite build produces `frontend/dist/` with `index.html` + an
    `assets/` subtree. In production (Docker) we copy that into the
    image and Flask serves it directly — same-origin with the API,
    which keeps the middle-auth cookie flow simple. In dev nobody has
    `frontend/dist/`, so this is a no-op and Vite's dev server (port
    5173, proxying `/api/*` to Flask on 5001) handles the SPA.

    Path resolution order: `CDV_SPA_DIR` env var → `frontend/dist`
    relative to CWD. The latter matches the dev repo layout when a
    developer runs `npm run build` for any reason.

    Routing:
      - `/<path>` returns the file at `frontend/dist/<path>` if it
        exists (covers `assets/*`, `vite.svg`, etc.).
      - Otherwise returns `index.html` so React Router can handle the
        client-side route (`/neuron/...`, `/table/...`, etc.).
      - `/api/*` is unaffected — Flask's URL matcher prefers the more
        specific blueprint route.

    Auth model — pattern borrowed from CAVEconnectome/Tourguide
    (`flask_app/api.py`):
      - SPA shell (`index.html`) is gated behind `@auth_required`. A
        user landing on a shared URL like `/neuron/864...` first hits
        middle-auth's redirect-to-login, signs in, and is bounced back
        to the same URL with a `middle_auth_token=...` query param.
        middle-auth-client cashes that into a cookie, redirects to the
        clean URL, and the SPA loads with the cookie set. Subsequent
        XHR calls to `/api/v1/...` carry the cookie automatically
        (same-origin).
      - Static assets (JS/CSS/icons referenced from index.html) are
        NOT auth-gated. Auth providers can't redirect-back through XHR
        asset loads — the redirect-and-callback flow only makes sense
        for top-level navigations. Asset requests carry the same cookie
        the original document carried, so they're effectively gated by
        the document's auth even without a per-request decorator.
      - Dev mode: `CDV_DEV_AUTH_BYPASS=1` makes `auth_required` a
        no-op (see `auth.py`), so local testing doesn't need a CAVE
        token in cookies.
    """
    spa_dir_str = os.environ.get("CDV_SPA_DIR") or "frontend/dist"
    spa_dir = Path(spa_dir_str).resolve()
    if not (spa_dir / "index.html").is_file():
        return  # dev mode — Vite serves the SPA

    # Auth-gated shell handler. Defined separately so the decorator only
    # wraps the index.html branch — assets stay public.
    @auth_required
    def _serve_spa_index():
        resp = send_from_directory(spa_dir, "index.html")
        # `index.html` references hashed asset filenames; the browser
        # MUST re-validate it on every load so a deploy that changes
        # those hashes is picked up immediately. Without this header,
        # browsers cache index.html (sometimes for hours) and continue
        # serving stale JS even after a docker push. The hashed assets
        # themselves are immutable per build, so they get cached long
        # by their default headers.
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def _serve_spa(path: str):
        # Static assets get streamed straight off disk, no auth gate.
        # SPA history routes (no matching file) flow through the
        # auth-required shell handler so the user lands logged in.
        if path and (spa_dir / path).is_file():
            resp = send_from_directory(spa_dir, path)
            # Hashed bundles (e.g. assets/index-DzLY8k3E.js) are
            # immutable per build — content-addressed by Vite. Long
            # max-age is correct here; the index.html `no-cache` above
            # ensures clients pick up new hash references on each
            # navigation, so they fetch the new bundle URL anyway.
            if path.startswith("assets/"):
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
        return _serve_spa_index()
