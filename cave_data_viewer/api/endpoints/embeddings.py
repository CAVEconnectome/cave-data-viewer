"""Feature Explorer endpoints — thin shells over
``services/embeddings/*``.

Mounted at ``/api/v1/datastacks/<ds>/feature_tables/...``. Each handler
parses Flask request state, dispatches to a service ``compute_*``
function, and ``jsonify``s the result. Wire shape, error codes, and
cache keys are owned by the service modules — see ``scatter.py``,
``column.py``, ``column_histogram.py``, ``cells.py``,
``seed_summary.py``, ``distance.py``, ``resolve.py`` (which holds both
``resolve_roots`` and ``find_cells``).

Auth gates everything at the same boundary as the rest of the API;
``CDV_DEV_AUTH_BYPASS=1`` covers local dev.

**GET vs POST convention.** Endpoints that may carry a variable-length
``cell_ids`` / ``root_ids`` list (``/cells``, ``/distance_to_set``,
``/resolve_roots``, ``/find_cells``) are POST so the payload lives in
the body and isn't bounded by Node's ~8 KB header limit. Fixed-size
parameter routes (``/scatter``, ``/column``, ``/column_histogram``,
``/seed_summary``) are GET so they stay CDN-cacheable.
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, jsonify, request

from ..auth import auth_required
from ._helpers import (
    make_request_client_factory,
    request_client_or_401,
    resolve_embedding_or_404,
    resolve_ft_or_404,
)
from ..errors import ApiError
from ..services.datastack_config import load_datastack_config
from ..services.embeddings import (
    EmbeddingSpec,
    FeatureTableSpec,
    source_for,
)
from ..services.embeddings.cells import compute_cells
from ..services.embeddings.column import compute_column
from ..services.embeddings.column_histogram import compute_column_histogram
from ..services.embeddings.distance import compute_distance_to_set_payload
from ..services.embeddings.resolve import compute_find_cells, compute_resolve_roots
from ..services.embeddings.runtime import (
    parse_decoration_tables,
    parse_mat_version,
    parse_seed_root,
)
from ..services.embeddings.scatter import compute_scatter
from ..services.embeddings.seed_summary import compute_seed_summary


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
            "feature_tables": [_feature_table_summary(ft) for ft in manifest.feature_tables],
        }
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/embeddings/<embedding_id>/scatter",
    methods=["GET"],
)
@auth_required
def scatter(ds: str, feature_table_id: str, embedding_id: str):
    """Universe scatter payload for one embedding view, with optional
    channel bindings. Thin parse + dispatch over
    :func:`compute_scatter`.

    Query params (all optional): ``x``, ``y`` (axis columns, default
    the embedding's declared axes); ``color`` (per-point color column);
    ``size`` (numeric per-point size column); ``dec`` (comma-separated
    decoration tables, required when a channel references a
    ``<table>.<col>``); ``mat_version`` (required when ``dec`` is set);
    ``seed`` (connectivity-seed root_id — enables ``seed_*`` channels).

    Response: parallel arrays ``cell_ids`` (string, JS-safe) + ``x`` +
    ``y`` + ``source_ds``, plus ``axes`` echo and optional ``color`` /
    ``size`` blocks. See :func:`compute_scatter` for the full block
    layout (categorical color_map, numeric raw_range).
    """
    cfg, ft, emb = resolve_embedding_or_404(ds, feature_table_id, embedding_id)
    try:
        mat_version = parse_mat_version(request.args.get("mat_version"))
    except ValueError as exc:
        raise ApiError(422, "invalid_mat_version", str(exc)) from exc
    decoration_tables = parse_decoration_tables(request.args.get("dec"))

    client_factory = make_request_client_factory(ds, mat_version)
    return jsonify(
        compute_scatter(
            ds=ds,
            cfg=cfg,
            ft=ft,
            emb=emb,
            mat_version=mat_version,
            x_override=request.args.get("x") or None,
            y_override=request.args.get("y") or None,
            color_col=request.args.get("color") or None,
            size_col=request.args.get("size") or None,
            decoration_tables=decoration_tables,
            seed_root_id=parse_seed_root(request.args.get("seed")),
            client_factory=client_factory,
        )
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/column/<path:column>",
    methods=["GET"],
)
@auth_required
def column(ds: str, feature_table_id: str, column: str):
    """Universe-aligned values for one column. Thin parse + dispatch
    over :func:`compute_column`.

    Same ``cell_ids`` row order as ``/scatter`` so the SPA can index
    the response by position when overlaying selection masks or
    cross-comparing with ``/cells`` rows.

    Path-routed ``<path:column>`` so dotted column names
    (``<table>.<col>``) survive without query-string escaping. Column
    resolves to a parquet column (``<ft>.<col>``), a decoration column
    (``<table>.<col>`` from ``?dec=``), a nucleus position
    (``nucleus.x|y|z``), or a connectivity-seed column (``seed_*``).

    Query params: ``mat_version`` (required for decoration / nucleus
    columns), ``dec`` (decoration tables; auto-extended to include the
    column's table), ``seed`` (root_id, required for ``seed_*``
    columns).

    Response: ``{column, kind, values, cell_ids, source_ds, n_cells}``
    plus ``raw_range`` (numeric) or ``color_map`` (categorical — same
    palette resolution as ``/scatter``).
    """
    cfg, _, ft = resolve_ft_or_404(ds, feature_table_id)
    try:
        mat_version = parse_mat_version(request.args.get("mat_version"))
    except ValueError as exc:
        raise ApiError(422, "invalid_mat_version", str(exc)) from exc
    decoration_tables = parse_decoration_tables(request.args.get("dec"))

    client_factory = make_request_client_factory(ds, mat_version)
    return jsonify(
        compute_column(
            ds=ds,
            cfg=cfg,
            ft=ft,
            column=column,
            mat_version=mat_version,
            decoration_tables=decoration_tables,
            seed_raw=request.args.get("seed"),
            client_factory=client_factory,
        )
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/cells",
    methods=["POST"],
)
@auth_required
def cells(ds: str, feature_table_id: str):
    """Row payload for the explorer's cell-list table. Thin parse +
    dispatch over :func:`compute_cells`.

    Mirrors the partners-frame ``{rows, column_groups}`` shape so
    ``PartnersTable`` renders both ``/neuron`` partners and ``/explore``
    cells unchanged.

    **POST** because the optional ``cell_ids`` lasso list can hold
    tens of thousands of ints (Node's 8KB query-string limit
    overflows).

    Body (all optional): ``mat_version``, ``dec`` (decoration tables),
    ``cells`` (filter expression — same syntax as partners endpoints),
    ``cell_ids`` (lasso subset, ANDed with the filter), ``seed``
    (connectivity-seed root_id), ``limit``.
    """
    cfg, _, ft = resolve_ft_or_404(ds, feature_table_id)
    body = request.get_json(silent=True) or {}
    try:
        mat_version = parse_mat_version(body.get("mat_version"))
    except ValueError as exc:
        raise ApiError(422, "invalid_mat_version", str(exc)) from exc
    decoration_tables = parse_decoration_tables(body.get("dec"))

    client_factory = make_request_client_factory(ds, mat_version)
    return jsonify(
        compute_cells(
            ds=ds,
            cfg=cfg,
            ft=ft,
            feature_table_id=feature_table_id,
            body=body,
            seed_raw_fallback=request.args.get("seed"),
            client_factory=client_factory,
            mat_version=mat_version,
            decoration_tables=decoration_tables,
        )
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/seed_summary",
    methods=["GET"],
)
@auth_required
def seed_summary(ds: str, feature_table_id: str):
    """Connectivity-seed summary *restricted to this feature table*.
    Thin parse + dispatch over :func:`compute_seed_summary`.

    The whole-connectome partner counts (from ``/connectivity``)
    over-count for the explorer because the scatter only renders cells
    in the feature table; this endpoint projects partner counts onto
    that universe and warms the seed's connectivity bundle so the
    first seed-channel plot lands fast.

    Query params: ``seed`` (root_id, required), ``mat_version``
    (materialized only — the resolver has no live-mode universe).
    Returns ``{n_in, n_out, n_partners, n_universe}``.
    """
    cfg, _, ft = resolve_ft_or_404(ds, feature_table_id)
    seed_root_id = parse_seed_root(request.args.get("seed"))
    if seed_root_id is None:
        raise ApiError(
            422, "missing_seed", "seed_summary requires a ?seed=<root_id> param"
        )

    mv_raw = request.args.get("mat_version")
    if mv_raw is None or mv_raw == "" or mv_raw == "live":
        raise ApiError(
            422,
            "seed_requires_materialized",
            "seed_summary requires a materialized ?mat_version= "
            "(the cell_id resolver has no live-mode universe cache)",
        )
    try:
        mat_version: int | str = int(mv_raw)
    except ValueError as exc:
        raise ApiError(
            422, "invalid_mat_version",
            f"mat_version must be an integer, got {mv_raw!r}",
        ) from exc

    client_factory = make_request_client_factory(ds, mat_version)
    return jsonify(
        compute_seed_summary(
            ds=ds,
            cfg=cfg,
            ft=ft,
            seed_root_id=seed_root_id,
            mat_version=mat_version,
            client_factory=client_factory,
        )
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/column/<path:column>/histogram",
    methods=["GET"],
)
@auth_required
def column_histogram(ds: str, feature_table_id: str, column: str):
    """Tiny histogram summary of one column. Thin parse + dispatch
    over :func:`compute_column_histogram`.

    Where ``/column`` ships the full universe-aligned values (~750KB
    for a 94k-row column), this returns a few-hundred-byte digest: bin
    counts + min/max for numeric, per-value counts for categorical.
    Drives first-paint of the Selection Builder predicate widgets.

    Backed by ``LayeredImmutableCache`` keyed on
    ``(cache_ds, ft_id, column, dec_tuple, mat_version, n_bins,
    binning, seed)``; the parquet-URI + mat_version contract makes the
    entry effectively immutable.

    Query params: ``bins`` (1..500, default 60; numeric only),
    ``binning`` (``linear`` | ``log``; numeric only, default
    ``linear``), ``dec``, ``mat_version`` (required for decoration /
    nucleus columns), ``seed``.
    """
    cfg, _, ft = resolve_ft_or_404(ds, feature_table_id)
    try:
        mat_version = parse_mat_version(request.args.get("mat_version"))
    except ValueError as exc:
        raise ApiError(422, "invalid_mat_version", str(exc)) from exc
    decoration_tables = parse_decoration_tables(request.args.get("dec"))

    n_bins_raw = request.args.get("bins", "60")
    try:
        n_bins = int(n_bins_raw)
    except ValueError as exc:
        raise ApiError(
            422, "invalid_bins", f"bins must be an integer, got {n_bins_raw!r}"
        ) from exc
    if n_bins < 1 or n_bins > 500:
        raise ApiError(422, "invalid_bins", "bins must be in [1, 500]")

    binning_raw = request.args.get("binning", "linear")
    if binning_raw not in ("linear", "log"):
        raise ApiError(
            422,
            "invalid_binning",
            f"binning must be 'linear' or 'log', got {binning_raw!r}",
        )

    client_factory = make_request_client_factory(ds, mat_version)
    return jsonify(
        compute_column_histogram(
            ds=ds,
            cfg=cfg,
            ft=ft,
            column=column,
            mat_version=mat_version,
            decoration_tables=decoration_tables,
            n_bins=n_bins,
            binning=binning_raw,  # type: ignore[arg-type]
            seed_raw=request.args.get("seed"),
            client_factory=client_factory,
        )
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/distance_to_set", methods=["POST"]
)
@auth_required
def distance_to_set(ds: str, feature_table_id: str):
    """Distance from a seed cell-id set to every universe cell. Thin
    parse + dispatch over :func:`compute_distance_to_set_payload`.

    Backs "grow my selection by similarity"; single-seed is a bag of
    one. Four spaces: ``raw`` (Euclidean on z-scored features),
    ``pca`` (top-K components), ``mahalanobis`` (whitened — corrects
    for correlated dimensions), ``embedding`` (Euclidean in the
    embedding's own 2-D scatter coordinates; requires ``embedding_id``).

    Body: ``{cell_ids, space, [embedding_id], variance, reduction,
    [feature_columns], [limit]}``. ``variance`` (0..1, default 0.9)
    sets the PCA component count by explained-variance fraction; the
    server resolves K and echoes it. ``reduction`` is ``centroid`` |
    ``nearest`` | ``mean``.

    Response is universe-aligned: ``cell_ids[i]`` matches
    ``distances[i]`` in feature-matrix row order, pre-sorted ascending.
    """
    cfg, src, ft = resolve_ft_or_404(ds, feature_table_id)
    body = request.get_json(silent=True) or {}
    return jsonify(
        compute_distance_to_set_payload(
            ds=ds,
            cfg=cfg,
            src=src,
            ft=ft,
            feature_table_id=feature_table_id,
            body=body,
        )
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
    resolution. See ``services/embeddings/resolve.py`` for the body.
    """
    cfg, _, _ = resolve_ft_or_404(ds, feature_table_id)
    body = request.get_json(silent=True) or {}
    mat_version = body.get("mat_version")
    return jsonify(
        compute_resolve_roots(
            ds=ds,
            cfg=cfg,
            body=body,
            client_factory=lambda: request_client_or_401(ds, mat_version),
        )
    )


@bp.route("/<ds>/feature_tables/<feature_table_id>/find_cells", methods=["POST"])
@auth_required
def find_cells(ds: str, feature_table_id: str):
    """Cross-version root_id → cell_id lookup for the explorer's
    search box. Thin parse + dispatch over :func:`compute_find_cells`.

    Universe-first pipeline: direct lookup against the cached nucleus
    view at ``mat_version``, then ``suggest_current_roots`` for stale
    inputs, then a re-lookup on the aligned roots. Inputs already
    canonical at the requested mv resolve in <1ms with no CAVE calls.

    The endpoint only serves root_id input; cell_id-mode search is
    validated locally in the SPA against the loaded universe array.

    Body: ``{root_ids: [str|int, ...], mat_version: int | "live"}``.

    Returns one ``results[]`` entry per input, in input order:
    ``{original_root_id, root_id, cell_id, aligned, status}`` where
    ``status`` is ``ok`` | ``unaligned`` | ``unresolved``. Per-input
    failures are not top-level errors — partial-success batches are
    the common case (Neuroglancer segment paste w/ proofreading drift).

    Same chunkedgraph code path as ``/connectivity``'s stale-root
    recovery — a root aligned here produces the same
    ``root_id_updated.current`` in ``/connectivity``.
    """
    cfg, _, _ = resolve_ft_or_404(ds, feature_table_id)
    body = request.get_json(silent=True) or {}
    return jsonify(
        compute_find_cells(
            ds=ds,
            cfg=cfg,
            body=body,
            client_factory=lambda: request_client_or_401(
                ds, body.get("mat_version")
            ),
        )
    )


# -- internals ----------------------------------------------------------------


def _feature_table_summary(ft: FeatureTableSpec) -> dict[str, Any]:
    """Public-API projection of a FeatureTableSpec — drops the storage URI
    (internal) and renders the audit block as a boolean flag (the audit
    *values* per cell ship through the rows endpoint, not the catalog).

    Categories are projected as-is so the SPA can render category-grouped
    pickers (channel selector, "+ add plot" menu, kNN feature subset).
    Validation that the referenced columns exist in the parquet happens
    on the SPA side (it already has the column list); the catalog
    response just relays the declared structure.
    """
    return {
        "id": ft.id,
        "title": ft.title,
        "description": ft.description,
        "id_column": ft.id_column,
        "cell_id_source_table": ft.cell_id_source_table,
        "feature_columns": ft.feature_columns,
        "categorical_columns": ft.categorical_columns,
        "spatial_pre_columns": list(ft.spatial_pre_columns),
        "spatial_post_columns": list(ft.spatial_post_columns),
        "depth_columns": ft.depth_columns,
        "has_audit": ft.audit is not None,
        "categories": [
            {
                "id": c.id,
                "title": c.title,
                "description": c.description,
                "columns": list(c.columns),
            }
            for c in ft.categories
        ],
        "embeddings": [_embedding_summary(e) for e in ft.embeddings],
        # Similarity controls moved from the manifest-level `knn:` block
        # to per-table in schema v1. Surfaced for SPA inspection (the
        # similarity computation itself happens server-side and reads
        # the same fields).
        "knn": {
            "scaling": ft.scaling,
            "standardize": ft.standardize,
            "clip_percentiles": (
                list(ft.clip_percentiles) if ft.clip_percentiles is not None else None
            ),
        },
    }


def _embedding_summary(emb: EmbeddingSpec) -> dict[str, Any]:
    return {
        "id": emb.id,
        "title": emb.title,
        "description": emb.description,
        "axes": emb.axes,
        "default_color_by": emb.default_color_by,
        "depth_axis": emb.depth_axis,
    }
