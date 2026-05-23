"""Per-user recipe storage endpoints.

YAML on the wire AND on disk (matches built-in recipe storage in
`config/datastacks/<ds>.yaml`'s `recipes:` section). Errors are JSON via
the standard `ApiError` machinery — uniform across the API.

Auth model:
- `/me/recipes/config` is unauth so the SPA can probe it before any
  cookie exists. It only reports availability; no per-user data leaks.
- All other routes require `@auth_required` AND a real (non-anonymous)
  user id. Anonymous (`auth_user.id == 0`) is rejected with 401.

Body bounds (defense against DoS / quota abuse, not schema validation —
we own both ends of the YAML, see services/recipes.py):
- 8 MB max body size per PUT (generous because explorer recipes can
  carry a Selection bag of ~10^5 cell_ids — the per-(user, ds) count
  cap is the primary quota; this is just the upper sanity bound)
- 100 recipes per (user, datastack) max
- per-field length caps in services/recipes.py
"""

from flask import Blueprint, Response, current_app, jsonify, request

import yaml

from ..auth import auth_required, current_user_id, is_dev_bypass
from ..errors import ApiError
from ..services import recipes as recipes_svc
from ..services.datastack_config import list_configured_datastacks

bp = Blueprint("recipes", __name__, url_prefix="/me/recipes")

# 8 MB. Explorer recipes carry a Selection bag of cell_ids that can
# legitimately run ~10^5 entries × ~20 chars each ≈ 2 MB raw + YAML
# overhead. The cap is set generously above that so a typical large
# saved selection never hits it, with the per-(user, ds) recipe count
# cap (100) acting as the primary quota. Beyond this size, the YAML
# upload / download path is the escape hatch.
#
# Checked at the endpoint top so we never feed a huge string into
# safe_load.
MAX_PUT_BYTES = 8 * 1024 * 1024


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
    if ds not in list_configured_datastacks():
        raise ApiError(400, "unknown_datastack",
                       f"datastack {ds!r} has no config YAML on this server")


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

    Reported even when storage is off so the SPA can surface the UX
    message "recipes work in production but not in dev-bypass mode."
    """
    if is_dev_bypass():
        return jsonify({"enabled": False, "reason": "dev_bypass"})
    if current_app.extensions.get("dcv_userdata_store") is None:
        return jsonify({"enabled": False, "reason": "no_bucket"})
    return jsonify({"enabled": True})


@bp.route("/<ds>", methods=["GET"])
@auth_required
def list_for_ds(ds: str):
    """Return all of the calling user's recipes for `ds` as a YAML
    document with a top-level `recipes:` list (mirrors operator-config
    shape exactly, so a user could literally paste the body under
    `recipes:` in a datastack YAML).

    Recipes missing a recognized `kind` are skipped server-side and
    reported via the `invalid_count` field. The SPA surfaces this as a
    banner ("N recipes from a previous schema are hidden") so the user
    understands why some of their saved items aren't visible — without
    blocking access to the still-valid ones."""
    _check_datastack(ds)
    user_id = _resolve_user()
    store = _resolve_store()
    items, invalid_count = recipes_svc.list_recipes(store, user_id, ds)
    return _yaml_response({"recipes": items, "invalid_count": invalid_count})


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
