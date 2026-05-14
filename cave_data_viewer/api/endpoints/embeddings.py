"""Feature Explorer endpoints — foundation slice.

Mounted at ``/api/v1/datastacks/<ds>/feature_tables/...``:

- ``GET  /feature_tables``                              catalog: tables +
                                                        nested embeddings
                                                        + kNN defaults
                                                        + cell_id_source_table.
- ``POST /feature_tables/<ft>/knn``                     kNN by cell_id (or by
                                                        root_id with server-
                                                        side reverse-resolve).
                                                        Data-level concern —
                                                        independent of which
                                                        embedding the SPA is
                                                        currently rendering.
- ``POST /feature_tables/<ft>/resolve_roots``           batched cell_id →
                                                        root_id at mat_version.

The plotting + table-rows endpoints land separately:
``services/plots.py`` gains an ``embedding_cells`` data source (served
through the existing ``/plots/<spec>`` machinery), and a sibling
``/feature_tables/<ft>/rows`` endpoint provides table-mode rows.

The auth decorator gates everything at the same boundary as the rest of
the API; ``CDV_DEV_AUTH_BYPASS=1`` covers local dev.
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import check_live_allowed, load_datastack_config
from ..services.embeddings import (
    EmbeddingSpec,
    FeatureTableSpec,
    get_index,
    resolve_cell_ids_to_root_ids,
    reverse_resolve_root_id_to_cell_id,
    source_for,
)

bp = Blueprint("embeddings", __name__, url_prefix="/datastacks")


@bp.route("/<ds>/feature_tables", methods=["GET"])
@auth_required
def list_feature_tables(ds: str):
    """List the feature tables (with their nested embeddings) for one datastack.

    Always returns 200 with an ``enabled`` flag — the SPA switches the
    /explore route on this flag rather than guessing from a 404. When the
    feature explorer is disabled or unconfigured for the datastack, only
    ``enabled: false`` is set.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        return jsonify({"enabled": False})

    try:
        manifest = src.list()
    except ValueError as exc:
        raise ApiError(
            502,
            "manifest_unavailable",
            f"could not load feature explorer manifest: {exc}",
        ) from exc

    return jsonify(
        {
            "enabled": True,
            "cell_id_source_table": cfg.feature_explorer.cell_id_source_table,
            "knn": manifest.knn.model_dump(),
            "feature_tables": [_feature_table_summary(ft) for ft in manifest.feature_tables],
        }
    )


@bp.route("/<ds>/feature_tables/<feature_table_id>/knn", methods=["POST"])
@auth_required
def knn(ds: str, feature_table_id: str):
    """k-nearest-neighbor query in feature space.

    Keyed on **feature table**, not embedding — the kNN index is built
    from the table's feature columns (or an explicit subset), so the
    same index serves every embedding declared on that table. Switching
    a UMAP for a t-SNE on the SPA doesn't refetch this.

    Body: ``{cell_id | root_id+mat_version, k?, feature_columns?}``.
    ``feature_columns`` defaults to the table's manifest declaration;
    when omitted the call may also pass through an embedding's
    ``knn_features`` override at the SPA layer.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    try:
        ft = src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}
    cell_id = _resolve_query_cell_id(ds, cfg, body)

    manifest = src.list()
    requested_k = body.get("k", manifest.knn.default_k)
    try:
        requested_k = int(requested_k)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_k", f"k must be an integer, got {requested_k!r}"
        ) from exc
    k = max(1, min(requested_k, manifest.knn.max_k))

    feature_columns = body.get("feature_columns")
    if feature_columns is not None and not isinstance(feature_columns, list):
        raise ApiError(
            422,
            "invalid_feature_columns",
            "feature_columns must be a list of column names",
        )

    try:
        index = get_index(
            ds,
            ft,
            feature_columns=feature_columns,
            standardize=manifest.knn.standardize,
            cache_ds=cfg.cache_alias or ds,
        )
    except ValueError as exc:
        raise ApiError(500, "index_build_failed", str(exc)) from exc

    try:
        neighbors = index.query(cell_id, k)
    except KeyError as exc:
        raise ApiError(404, "cell_id_not_in_index", str(exc)) from exc

    return jsonify(
        {
            "query_cell_id": str(cell_id),
            "neighbors": [
                {"cell_id": str(cid), "distance": d}
                for cid, d in neighbors
            ],
        }
    )


@bp.route("/<ds>/feature_tables/<feature_table_id>/resolve_roots", methods=["POST"])
@auth_required
def resolve_roots(ds: str, feature_table_id: str):
    """Batched cell_id → root_id resolve at a specific mat_version.

    Body: ``{cell_ids: [int|str, ...], mat_version: int | "live"}``.
    Response: ``{mat_version, resolutions: [{cell_id, root_id, status, ...}]}``.
    Order matches the request.

    Keyed on feature_table rather than embedding because the cell_id
    universe is owned by the table; embedding choice doesn't affect
    resolution.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    try:
        src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}

    raw_ids = body.get("cell_ids")
    if not isinstance(raw_ids, list):
        raise ApiError(
            422, "missing_cell_ids", "body must include a `cell_ids` list"
        )
    try:
        cell_ids = [int(c) for c in raw_ids]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_cell_ids", f"all cell_ids must be integers: {exc}"
        ) from exc

    if not cell_ids:
        return jsonify({"mat_version": body.get("mat_version"), "resolutions": []})

    if "mat_version" not in body:
        raise ApiError(
            422,
            "missing_mat_version",
            "body must include `mat_version` (int or \"live\")",
        )
    mat_version = body["mat_version"]

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client = _cave_client(ds, mat_version)

    try:
        resolutions = resolve_cell_ids_to_root_ids(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            cell_ids=cell_ids,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502, "cave_upstream", f"{type(exc).__name__}: {exc}"
        ) from exc

    return jsonify(
        {
            "mat_version": str(mat_version) if mat_version is not None else None,
            "resolutions": [_resolution_to_json(r) for r in resolutions],
        }
    )


# -- internals ----------------------------------------------------------------


def _resolve_query_cell_id(ds: str, cfg, body: dict[str, Any]) -> int:
    """Translate the /knn body's ``cell_id`` or ``root_id`` into a cell_id."""
    if "cell_id" in body:
        try:
            return int(body["cell_id"])
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422,
                "invalid_cell_id",
                f"cell_id must be an integer or numeric string, got {body['cell_id']!r}",
            ) from exc

    if "root_id" not in body:
        raise ApiError(
            422,
            "missing_id",
            "request body must include either `cell_id` or `root_id`+`mat_version`",
        )

    try:
        root_id = int(body["root_id"])
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_root_id",
            f"root_id must be an integer or numeric string, got {body['root_id']!r}",
        ) from exc

    if "mat_version" not in body:
        raise ApiError(
            422,
            "missing_mat_version",
            "root_id input requires `mat_version` (int or \"live\") so the "
            "reverse resolution knows which version to look up",
        )
    mat_version = body["mat_version"]

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client = _cave_client(ds, mat_version)

    try:
        cell_id = reverse_resolve_root_id_to_cell_id(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            root_id=root_id,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502, "cave_upstream", f"{type(exc).__name__}: {exc}"
        ) from exc

    if cell_id is None:
        raise ApiError(
            404,
            "root_id_unresolved",
            f"root_id {root_id!r} could not be reverse-resolved to a "
            f"cell_id at mat_version={mat_version!r} (no matching row in "
            "root_id_lookup_main_table or its alt tables)",
        )
    return cell_id


def _cave_client(ds: str, mat_version: int | str | None):
    """Build a CAVE client with the request's auth context."""
    try:
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )
    except ValueError as exc:
        raise ApiError(401, "no_auth_token", str(exc)) from exc


def _resolution_to_json(r) -> dict[str, Any]:
    out: dict[str, Any] = {
        "cell_id": str(r.cell_id),
        "root_id": str(r.root_id) if r.root_id is not None else None,
        "status": r.status,
    }
    if r.candidates:
        out["candidates"] = [str(c) for c in r.candidates]
    return out


def _feature_table_summary(ft: FeatureTableSpec) -> dict[str, Any]:
    """Public-API projection of a FeatureTableSpec — drops the storage URI
    (internal) and renders the audit block as a boolean flag (the audit
    *values* per cell ship through the rows endpoint, not the catalog).
    """
    return {
        "id": ft.id,
        "title": ft.title,
        "description": ft.description,
        "id_column": ft.id_column,
        "feature_columns": ft.feature_columns,
        "categorical_columns": ft.categorical_columns,
        "depth_columns": ft.depth_columns,
        "has_audit": ft.audit is not None,
        "embeddings": [_embedding_summary(e) for e in ft.embeddings],
    }


def _embedding_summary(emb: EmbeddingSpec) -> dict[str, Any]:
    return {
        "id": emb.id,
        "title": emb.title,
        "description": emb.description,
        "axes": emb.axes,
        "default_color_by": emb.default_color_by,
        "knn_features": emb.knn_features,
        "depth_axis": emb.depth_axis,
    }
