import time

from flask import Blueprint, jsonify

from ... import __version__

bp = Blueprint("health", __name__)


# Process-start timestamp recorded at module import. Cheap; one float per
# process. The uptime field on /healthz uses this to give ops a quick
# "how long has this pod been up" without scraping K8s status.
_STARTED_AT = time.time()


@bp.route("/healthz")
def healthz():
    """Liveness probe — unauthenticated, no external calls.

    Intentionally does NOT check CAVE / middle-auth reachability:
    - K8s liveness restarts the pod when this fails. If we tied
      liveness to CAVE health, a CAVE outage would kill every pod
      instead of letting them serve cached data + return 502s for
      uncacheable requests.
    - Auth provider downtime shouldn't restart the pod either.

    The endpoint succeeds whenever Flask is responsive. Any 5xx coming
    from this route means the process itself is wedged (event loop
    blocked, deadlock, OOM-near-miss) and a restart is the right move.

    Response includes version + uptime as a freebie — same endpoint
    answers "is it up" and "what's running" without needing to gate
    /version or scrape pod metadata.
    """
    return jsonify({
        "status": "ok",
        "version": __version__,
        "uptime_s": round(time.time() - _STARTED_AT, 1),
    })


@bp.route("/version")
def version():
    return jsonify({"version": __version__})
