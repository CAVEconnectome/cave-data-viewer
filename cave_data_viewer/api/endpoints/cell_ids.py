from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.cell_id import cell_ids_to_root_ids, root_ids_to_cell_ids
from ..services.datastack_config import check_live_allowed, load_datastack_config

bp = Blueprint("cell_ids", __name__, url_prefix="/datastacks")


@bp.route("/<ds>/cell-ids/lookup", methods=["POST"])
@auth_required
def lookup(ds: str):
    """Body: `{cell_ids?: [...], root_ids?: [...]}`. Returns the corresponding
    mapping(s), with unmapped entries set to null.

    Both directions in one endpoint so the SPA can post whichever it has;
    the response shape always carries both keys (one will be empty)."""
    body = request.get_json(silent=True) or {}
    cell_ids = body.get("cell_ids") or []
    root_ids = body.get("root_ids") or []
    if not cell_ids and not root_ids:
        raise ApiError(422, "missing_ids", "request body must include cell_ids or root_ids")

    mat_version = request.args.get("mat_version") or None
    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    try:
        client = request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )
    except ValueError as exc:
        raise ApiError(401, "no_auth_token", str(exc)) from exc

    cfg = load_datastack_config(ds)

    forward: dict[str, str | None] = {}
    reverse: dict[str, str | None] = {}
    try:
        if cell_ids:
            mapping = cell_ids_to_root_ids(
                client=client, cfg=cfg, mat_version=mat_version,
                datastack=ds,
                cell_ids=[int(x) for x in cell_ids],
            )
            # Stringify root_ids for the wire (int64 / JS Number precision).
            forward = {str(k): (str(v) if v is not None else None) for k, v in mapping.items()}
        if root_ids:
            mapping = root_ids_to_cell_ids(
                client=client, cfg=cfg, mat_version=mat_version,
                datastack=ds,
                root_ids=[int(x) for x in root_ids],
            )
            reverse = {str(k): (str(v) if v is not None else None) for k, v in mapping.items()}
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(502, "cave_upstream",
                       f"{type(exc).__name__}: {exc}") from exc

    return jsonify({"cell_to_root": forward, "root_to_cell": reverse})
