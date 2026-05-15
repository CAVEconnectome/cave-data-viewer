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
    FeatureTableQuery,
    FeatureTableSpec,
    get_index,
    load_feature_table_frame,
    resolve_cell_ids_to_root_ids,
    reverse_resolve_root_id_to_cell_id,
    source_for,
)
from ..services.plots import _apply_cell_filters, _parse_cells_param

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


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/embeddings/<embedding_id>/scatter",
    methods=["GET"],
)
@auth_required
def scatter(ds: str, feature_table_id: str, embedding_id: str):
    """Universe scatter payload for one embedding view.

    Returns parallel arrays — ``cell_ids`` + the two axis columns the
    embedding declares — for *every* cell in the parquet, with no filter
    and no decoration merge applied. This is the universe layer the SPA's
    ``UniverseScatter`` renders as its base trace; highlight overlays
    (``?cells=`` filter result, ``?sel_<id>=`` brush, lasso selection)
    are computed client-side as Set<cell_id> intersections over the
    universe's ``cell_ids`` array, no extra round-trip per filter change.

    No CAVE call. Backed by ``dcv_embedding_frame_cache`` (immutable L1
    + L2 GCS), so cold pods see a one-time parquet read and every
    subsequent request is dict-fast.

    Response shape::

        {
          "cell_ids": ["12345", "12346", ...],
          "x": [1.23, 2.34, ...],
          "y": [-0.12, 4.21, ...],
          "n_cells": 1000,
          "axes": {"x": "umap_x", "y": "umap_y"}
        }

    ``cell_ids`` is stringified at the JSON boundary per the project's
    int64-as-string convention, even though cell_ids fit comfortably in
    JS Number — keeps the wire shape symmetric with root_id payloads.
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
        ft, emb = src.resolve_embedding(feature_table_id, embedding_id)
    except KeyError as exc:
        raise ApiError(404, "embedding_not_found", str(exc)) from exc

    frame = load_feature_table_frame(ds, ft, cache_ds=cfg.cache_alias or ds)
    x_col, y_col = emb.axes[0], emb.axes[1]
    missing = [c for c in (ft.id_column, x_col, y_col) if c not in frame.columns]
    if missing:
        # Axes are declared by the manifest but the parquet doesn't have
        # them — surfaces a manifest/parquet mismatch as a 422 rather
        # than a confusing KeyError deep inside numpy.
        raise ApiError(
            422,
            "embedding_axes_missing",
            f"embedding {embedding_id!r} on feature_table {feature_table_id!r} "
            f"references columns {missing!r} which are not in the parquet at "
            f"{ft.source.uri!r} (have {list(frame.columns)})",
        )

    # `.tolist()` lands as native Python types so jsonify's default encoder
    # handles them without the NumpyJSONProvider's scalar-coercion path.
    # Cell_ids stringified individually to preserve int64 precision and
    # match the partner-frame wire shape — even though cell_ids fit in
    # JS Number, downstream code that compares ids in URL params expects
    # strings throughout.
    return jsonify(
        {
            "cell_ids": [str(int(c)) for c in frame[ft.id_column].tolist()],
            "x": frame[x_col].astype(float).tolist(),
            "y": frame[y_col].astype(float).tolist(),
            "n_cells": int(len(frame)),
            "axes": {"x": x_col, "y": y_col},
        }
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/cells",
    methods=["GET"],
)
@auth_required
def cells(ds: str, feature_table_id: str):
    """Row payload for the explorer's cell-list table.

    Mirrors the partners-frame ``{rows, column_groups}`` shape that
    ``PartnersTable`` consumes, so the same component renders both
    ``/neuron``'s partners and ``/explore``'s cells.

    Query params:

    - ``mat_version`` — drives the resolver for any decoration joins.
      Required when ``dec`` is non-empty.
    - ``dec`` — comma-separated decoration table names to join onto the
      frame. Same syntax as ``/connectivity``'s ``dec``.
    - ``cells`` — filter expression, same syntax as the partners
      endpoints (``<table>.<col>:<op>:<val>[,...]``). Filters reference
      either parquet columns or attached decoration columns.
    - ``limit`` — server-side cap on returned rows. Defaults to a high
      enough value to fit a feature table (~few hundred thousand rows)
      while keeping the response under JSON-encoder time pressure.

    Response::

        {
          "cell_ids": [...],     (echo of primary key column for convenience)
          "rows": [{cell_id, ...parquet/decoration columns...}, ...],
          "column_groups": [...PartnerRecord-style groups...],
          "matched_count": N,    (post-filter)
          "total_count": M,      (pre-filter; for "N of M" indicator)
          "limit": L,
          "limit_hit": bool
        }
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

    mat_version_raw = request.args.get("mat_version")
    mat_version: int | str | None
    if mat_version_raw is None or mat_version_raw == "":
        mat_version = None
    elif mat_version_raw == "live":
        mat_version = "live"
    else:
        try:
            mat_version = int(mat_version_raw)
        except ValueError as exc:
            raise ApiError(
                422, "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mat_version_raw!r}",
            ) from exc

    decoration_tables: list[str] = []
    dec_raw = request.args.get("dec") or ""
    if dec_raw:
        decoration_tables = [t.strip() for t in dec_raw.split(",") if t.strip()]

    try:
        cell_filters = _parse_cells_param(request.args.get("cells"))
    except ValueError as exc:
        raise ApiError(422, "cells_invalid", str(exc)) from exc
    # Auto-extend decoration_tables to cover every table referenced by a
    # cell filter — the user's intent is "filter by these columns"; they
    # shouldn't also have to remember to attach the table. Clauses that
    # reference the feature_table itself are skipped — those columns are
    # parquet columns that live on the frame natively, no join needed.
    for f in cell_filters:
        if f.table == feature_table_id:
            continue
        if f.table not in decoration_tables:
            decoration_tables.append(f.table)

    # check_live_allowed + mat_version are only meaningful when we'll
    # actually call CAVE (decoration join). A parquet-only request runs
    # without a mat_version — the frame is pinned by parquet_uri.
    if decoration_tables:
        if mat_version is None:
            raise ApiError(
                422,
                "missing_mat_version",
                "mat_version is required when decoration tables are attached",
            )
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    try:
        limit = int(request.args.get("limit", "500000"))
    except ValueError as exc:
        raise ApiError(
            422, "invalid_limit", f"limit must be an integer: {exc}"
        ) from exc

    def _client_factory():
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )

    ft_query = FeatureTableQuery(
        datastack=ds,
        mat_version=mat_version,
        feature_table=ft,
        cfg=cfg,
        client_factory=_client_factory if decoration_tables else None,
    )
    frame = ft_query.frame(decoration_tables=decoration_tables or None)
    total_count = int(len(frame))

    if cell_filters:
        frame = _apply_cell_filters(frame, cell_filters)
    matched_count = int(len(frame))

    limit_hit = matched_count > limit
    if limit_hit:
        frame = frame.head(limit)

    # Stringify primary key at the JSON boundary — matches the partners
    # convention (root_id-as-string) so PartnersTable's getRowId reads
    # a string regardless of source.
    frame = frame.copy()
    frame["cell_id"] = frame["cell_id"].astype(int).astype(str)
    rows = frame.to_dict(orient="records")

    # column_groups mirror the partners-frame schema so the SPA's column
    # visibility / collapsed-group machinery works unchanged. Parquet
    # columns are prefixed with the feature_table_id inside
    # FeatureTableQuery.frame() so they share the `<table>.<col>`
    # namespace with decoration columns. Layout:
    #   - "id" intrinsic group with just cell_id
    #   - one feature-table group ("<ft.id>") with parquet columns
    #   - one "table" group per attached decoration table
    feature_cols = [
        f"{ft.id}.{c}" for c in (ft.feature_columns or [])
        if f"{ft.id}.{c}" in frame.columns
    ]
    categorical_cols = [
        f"{ft.id}.{c}" for c in (ft.categorical_columns or [])
        if f"{ft.id}.{c}" in frame.columns
    ]
    column_groups: list[dict] = [
        {"name": "id", "kind": "intrinsic", "columns": ["cell_id"]},
    ]
    parquet_cols = feature_cols + categorical_cols
    if parquet_cols:
        column_groups.append(
            {"name": ft.id, "kind": "table", "columns": parquet_cols}
        )
    for table in decoration_tables:
        cols = [c for c in frame.columns if c.startswith(f"{table}.")]
        if cols:
            column_groups.append(
                {"name": table, "kind": "table", "columns": cols}
            )

    return jsonify(
        {
            "cell_ids": [row["cell_id"] for row in rows],
            "rows": rows,
            "column_groups": column_groups,
            "matched_count": matched_count,
            "total_count": total_count,
            "limit": limit,
            "limit_hit": limit_hit,
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
