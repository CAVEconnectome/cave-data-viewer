from flask import Blueprint, jsonify, request

from ..auth import auth_required
from ..errors import ApiError
from ..services.decoration import get_decoration_service

bp = Blueprint("decorations", __name__, url_prefix="/decorations")


@bp.route("/poll", methods=["GET"])
@auth_required
def poll():
    ticket_id = request.args.get("ticket")
    if not ticket_id:
        raise ApiError(422, "missing_ticket", "ticket query param is required")
    service = get_decoration_service()
    return jsonify(service.poll_ticket(ticket_id))
