from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services import state as ngl
from ..services.datastack_config import (
    aligned_volume_config_for,
    check_live_allowed,
    load_datastack_config,
    resolve_synapse_config,
)
from ..services.links import load_templates, resolve_link
from ..services.neuron import NeuronQuery

bp = Blueprint("links", __name__, url_prefix="/datastacks")


@bp.route("/<ds>/links", methods=["POST"])
@auth_required
def make_link(ds: str):
    body = request.get_json(silent=True) or {}
    template_name = body.get("template")
    if not template_name:
        raise ApiError(422, "missing_template", "request body must include 'template'")
    query = body.get("query") or {}
    root_id = query.get("root_id")
    if root_id is None:
        raise ApiError(422, "missing_root_id", "query.root_id is required")
    selected_partner_ids = query.get("selected_partner_ids")
    mat_version = request.args.get("mat_version") or None

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    templates = load_templates()
    template = templates.get(template_name)
    if template is None:
        raise ApiError(404, "template_not_found",
                       f"No link template named {template_name!r}",
                       hint=f"available: {sorted(templates.keys())}")

    # Same hardened auth dispatch as /connectivity. No silent cave-secret fallback.
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
    av_cfg = aligned_volume_config_for(ds, client)
    syn_cfg = resolve_synapse_config(av_cfg, cfg)
    nq = NeuronQuery(
        client,
        root_id=int(root_id),
        datastack=ds,
        mat_version=mat_version,
        synapse_columns=syn_cfg.merged_columns(),
        synapse_position_prefix=syn_cfg.position_prefix,
    )
    try:
        result = resolve_link(
            template=template,
            nq=nq,
            client=client,
            selected_partner_ids=selected_partner_ids,
            spelunker_url=current_app.config["SPELUNKER_URL"],
        )
    except Exception as exc:
        raise ApiError(502, "link_render_failed",
                       f"Failed to render link: {type(exc).__name__}: {exc}") from exc
    return jsonify(result)


# Cap on the number of segments we'll pin in one Neuroglancer link. Big tables
# (cell-type lookups across the whole volume) easily run into 100k+ rows; a
# pinned-segment list that long would crash the viewer and isn't useful as a
# survey anyway. The SPA already gates "open in NGL" behind a filtered or
# selected scope for big tables, so this is a defense-in-depth ceiling.
_SEGMENTS_LINK_MAX_IDS = 1000


@bp.route("/<ds>/links/segments", methods=["POST"])
@auth_required
def make_segments_link(ds: str):
    """Open Neuroglancer with a flat list of segments pinned.

    Used by the per-table view: pick rows / apply a filter / select the whole
    page, then ship the union of `*_root_id` values here to get an NGL URL.
    Distinct from `/links` (which is focal-neuron + direction shaped) because
    a generic table has no concept of "focal cell" or "direction."

    Body:
        { "root_ids": ["123", "456", ...] }
    """
    body = request.get_json(silent=True) or {}
    raw_ids = body.get("root_ids") if body.get("root_ids") is not None else []
    if not isinstance(raw_ids, list):
        raise ApiError(422, "invalid_root_ids", "root_ids must be a list")

    # Optional view position. The frontend pulls these from the first
    # `*_pt_position` triple in the row scope and the table metadata's
    # voxel_resolution; both arrive in raw form (voxel coordinates +
    # nm-per-voxel) and we hand them to nglui as a CoordSpace so
    # Neuroglancer opens centered on the row instead of at (0,0,0).
    position_raw = body.get("position")
    voxel_resolution_raw = body.get("voxel_resolution")
    position = _parse_3vector(position_raw, "position") if position_raw is not None else None
    voxel_resolution = (
        _parse_3vector(voxel_resolution_raw, "voxel_resolution")
        if voxel_resolution_raw is not None
        else None
    )
    # Deduplicate while preserving the caller's order — a sorted-by-num_syn
    # list arrives ranked, and the user tends to scan top-down in the viewer.
    # Empty list is intentionally allowed: opens a neutral viewer with just
    # the datastack's default image + segmentation layers and nothing
    # selected, which is what the sidebar "Open in Neuroglancer" button
    # renders.
    seen: set[int] = set()
    segment_ids: list[int] = []
    for raw in raw_ids:
        try:
            rid = int(raw)
        except (TypeError, ValueError):
            raise ApiError(422, "invalid_root_id", f"root_id is not an integer: {raw!r}")
        if rid <= 0 or rid in seen:
            continue
        seen.add(rid)
        segment_ids.append(rid)
    if len(segment_ids) > _SEGMENTS_LINK_MAX_IDS:
        raise ApiError(
            422, "too_many_segments",
            f"At most {_SEGMENTS_LINK_MAX_IDS} segments per link; got {len(segment_ids)}.",
            hint="Filter or select a smaller subset before opening in Neuroglancer.",
        )

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

    try:
        viewer = ngl.new_viewer_state(client)
        ngl.pin_segments(viewer, segment_ids)
        if position is not None:
            ngl.set_view_position(viewer, position=position, dimensions=voxel_resolution)
        url, shortened = ngl.render_url(
            viewer,
            target_url=current_app.config["SPELUNKER_URL"],
            shorten="if_long",
            client=client,
        )
    except Exception as exc:
        raise ApiError(502, "link_render_failed",
                       f"Failed to render link: {type(exc).__name__}: {exc}") from exc
    return jsonify({"url": url, "shortened": shortened})


def _parse_3vector(raw, name: str) -> list[float]:
    """Validate a 3-element numeric vector from the request body.

    Used by both `position` (voxel coords from a row) and `voxel_resolution`
    (nm-per-voxel from table metadata). Strict on shape and numeric type so
    a malformed body returns a clear 422 instead of confusing nglui or
    silently centering the viewer at the wrong place.
    """
    if not isinstance(raw, list) or len(raw) != 3:
        raise ApiError(422, f"invalid_{name}", f"{name} must be a list of 3 numbers")
    out: list[float] = []
    for v in raw:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ApiError(422, f"invalid_{name}", f"{name} must be numeric; got {v!r}")
        out.append(float(v))
    return out
