"""Per-user recipe storage endpoints.

YAML on the wire AND on disk (matches operator recipe storage in
`config/datastacks/<ds>.yaml`'s `recipes:` section). Errors are JSON via
the standard `ApiError` machinery — uniform across the API.

Auth model:
- `/me/recipes/config` is unauth so the SPA can probe it before any
  cookie exists. It only reports availability; no per-user data leaks.
- All other routes require `@auth_required` AND a real (non-anonymous)
  user id. Anonymous (`auth_user.id == 0`) is rejected with 401.

Body bounds (defense against DoS / quota abuse, not schema validation —
we own both ends of the YAML, see services/recipes.py):
- 64 KB max body size per PUT
- 100 recipes per (user, datastack) max
- per-field length caps in services/recipes.py
"""

from flask import Blueprint, Response, current_app, jsonify, request

import yaml

from ..auth import auth_required, current_user_id, is_dev_bypass
from ..errors import ApiError
from ..services import recipes as recipes_svc

bp = Blueprint("recipes", __name__, url_prefix="/me/recipes")

# 64 KB. A recipe is a few KB at most; this caps YAML billion-laughs
# expansion targets and accidental megabyte payloads. Checked at the
# endpoint top so we never feed a huge string into safe_load.
MAX_PUT_BYTES = 64 * 1024


def _resolve_user() -> int:
    """Return the authenticated user id or raise an ApiError. Translates
    the service-layer ValueErrors into the right HTTP shape."""
    try:
        return recipes_svc.assert_real_user(current_user_id())
    except ValueError as exc:
        # No-user (dev-bypass / no auth_user) and id==0 (anonymous) both
        # land here. 401 covers both — they're indistinguishable to the
        # client and both mean "this endpoint isn't usable without a
        # logged-in identity."
        raise ApiError(401, "auth_required", str(exc)) from exc


def _resolve_store() -> "recipes_svc.GcsObjectStore":
    store = current_app.extensions.get("dcv_userdata_store")
    if store is None:
        raise ApiError(
            503, "recipes_unavailable",
            "user-recipe storage is not configured on this server",
            hint="set CDV_GCS_CACHE_BUCKET to enable cross-device recipes",
        )
    return store


def _check_datastack(ds: str) -> None:
    allowed = current_app.config.get("DATASTACKS_ALLOWED") or []
    if ds not in allowed:
        raise ApiError(400, "unknown_datastack", f"datastack {ds!r} is not in the allowlist")


def _yaml_response(value: dict | list, status: int = 200) -> Response:
    body = yaml.safe_dump(value, sort_keys=False, default_flow_style=False)
    resp = current_app.response_class(body, status=status,
                                      mimetype="application/yaml")
    return resp


@bp.route("/config", methods=["GET"])
def config():
    """SPA probes this once at app load to know whether server-side
    recipes are available. No auth gate so the SPA can call it before
    any cookie exists; the response carries no per-user data.

    `schema_version` and `supported_schema_versions` are negotiation
    hooks: a future SPA can read them to decide whether to send v1 or v2
    PUT bodies, and to surface a "your client is older than the server"
    notice if the SPA only knows about earlier schemas. Sent on every
    response (including disabled) so the SPA can introspect even when
    storage is off — useful for the UX message "recipes work in
    production but not in dev-bypass mode."
    """
    base = {
        "schema_version": recipes_svc.CURRENT_SCHEMA_VERSION,
        "supported_schema_versions": sorted(recipes_svc.SUPPORTED_SCHEMA_VERSIONS),
    }
    if is_dev_bypass():
        return jsonify({**base, "enabled": False, "reason": "dev_bypass"})
    if current_app.extensions.get("dcv_userdata_store") is None:
        return jsonify({**base, "enabled": False, "reason": "no_bucket"})
    return jsonify({**base, "enabled": True})


@bp.route("/<ds>", methods=["GET"])
@auth_required
def list_for_ds(ds: str):
    """Return all of the calling user's recipes for `ds` as a YAML
    document with a top-level `recipes:` list (mirrors operator-config
    shape exactly, so a user could literally paste the body under
    `recipes:` in a datastack YAML)."""
    _check_datastack(ds)
    user_id = _resolve_user()
    store = _resolve_store()
    items = recipes_svc.list_recipes(store, user_id, ds)
    return _yaml_response({"recipes": items})


@bp.route("/<ds>/<recipe_id>", methods=["PUT"])
@auth_required
def put(ds: str, recipe_id: str):
    """Upsert a single recipe. Body is a YAML mapping with the recipe
    fields. The URL-path id wins over any `id` field in the body."""
    _check_datastack(ds)
    user_id = _resolve_user()
    store = _resolve_store()

    # Body size cap — checked before reading bytes so a huge payload
    # doesn't even get buffered. content_length can be None for chunked
    # encoding; in that case we still get protected by the read cap below.
    content_length = request.content_length
    if content_length is not None and content_length > MAX_PUT_BYTES:
        raise ApiError(413, "recipe_too_large",
                       f"recipe body exceeds {MAX_PUT_BYTES} bytes")

    raw = request.get_data(cache=False, as_text=False)
    if len(raw) > MAX_PUT_BYTES:
        raise ApiError(413, "recipe_too_large",
                       f"recipe body exceeds {MAX_PUT_BYTES} bytes")

    try:
        parsed = yaml.safe_load(raw.decode("utf-8"))
    except (yaml.YAMLError, UnicodeDecodeError) as exc:
        raise ApiError(400, "recipe_parse_failed",
                       f"could not parse YAML body: {exc}") from exc

    if not isinstance(parsed, dict):
        raise ApiError(400, "recipe_shape", "recipe body must be a YAML mapping")

    try:
        stored = recipes_svc.put_recipe(store, user_id, ds, recipe_id, parsed)
    except recipes_svc.RecipeValidationError as exc:
        raise ApiError(400, "recipe_invalid", str(exc)) from exc
    except recipes_svc.TooManyRecipesError as exc:
        raise ApiError(413, "recipe_count_cap", str(exc)) from exc
    except Exception as exc:
        raise ApiError(500, "recipe_storage_failed",
                       f"{type(exc).__name__}: {exc}") from exc

    return _yaml_response(stored)


@bp.route("/<ds>/<recipe_id>", methods=["DELETE"])
@auth_required
def delete(ds: str, recipe_id: str):
    """Idempotent — deleting a missing recipe returns 200, not 404."""
    _check_datastack(ds)
    user_id = _resolve_user()
    store = _resolve_store()
    try:
        recipes_svc.delete_recipe(store, user_id, ds, recipe_id)
    except recipes_svc.RecipeValidationError as exc:
        raise ApiError(400, "recipe_invalid", str(exc)) from exc
    except Exception as exc:
        raise ApiError(500, "recipe_storage_failed",
                       f"{type(exc).__name__}: {exc}") from exc
    return jsonify({"ok": True})
