from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import (
    aligned_volume_config_for,
    check_live_allowed,
    load_datastack_config,
    resolve_synapse_config,
)
from ..services.embeddings import FeatureTableQuery, source_for as feature_source_for
from ..services.neuron import NeuronQuery
from ..services.plots import _parse_cells_param, load_plot_specs, resolve_plot
from ..services.spatial import build_spatial_provider
from ..services.timing import timer

bp = Blueprint("plots", __name__, url_prefix="/datastacks")
catalog_bp = Blueprint("plot_catalog", __name__)


@catalog_bp.route("/plots/specs", methods=["GET"])
@auth_required
def list_plot_specs():
    """Catalog of available plot specs (loaded from YAML templates).

    Returned shape per entry: ``{name, kind, dynamic, description, source}``.
    No figure data — this is a metadata listing the SPA can hydrate its plot
    registry from. Drop a YAML in ``api/templates/plots/``, deploy, and the
    SPA picker reflects it on the next mount; no frontend code change.

    Auth-gated for parity with the rest of the API; it leaks no per-datastack
    information so a future ``allow_anonymous`` flag could relax this.
    """
    specs = load_plot_specs()
    payload = [
        {
            "name": spec.name,
            "kind": spec.kind,
            "dynamic": spec.dynamic,
            "description": spec.description,
            "source": spec.data_query.source,
        }
        for spec in sorted(specs.values(), key=lambda s: s.name)
    ]
    return jsonify({"specs": payload})


@bp.route("/<ds>/plots/<spec_name>", methods=["POST"])
@auth_required
def make_plot(ds: str, spec_name: str):
    body = request.get_json(silent=True) or {}
    decoration_tables = body.get("decoration_tables") or []
    column_override = body.get("column")
    # New multi-channel binding shape: {x?, y?, hue?, size?}. When present,
    # takes precedence over the legacy single `column` override; the resolver
    # auto-picks chart kind for `dynamic` specs based on which axes are bound.
    bindings = body.get("bindings") or None
    # `show_cell_depth` rides on the bindings payload (lives in the panel's
    # ?viz_<id>= URL state on the SPA). Default True so the marker shows up
    # without the user opting in. Accept it loosely so a malformed value
    # silently degrades to the default rather than 422-ing the whole plot.
    show_cell_depth = True
    if isinstance(bindings, dict) and "show_cell_depth" in bindings:
        show_cell_depth = bool(bindings.get("show_cell_depth"))
    mat_version = request.args.get("mat_version") or None
    # Connectivity-seed binding (embedding_cells source only). Shape:
    # `{root_id: "<int as string or int>", mat_version?: <number|"live">}`.
    # mat_version defaults to the request's mat_version when omitted, so
    # the typical case ("seed at the same mat_version as the embedding")
    # is the no-op default. Validated loosely — malformed root_id silently
    # disables the seed instead of 422-ing the whole plot.
    seed_payload: dict | None = None
    raw_seed = body.get("seed")
    if isinstance(raw_seed, dict):
        raw_root = raw_seed.get("root_id")
        try:
            seed_root_int = int(raw_root) if raw_root is not None else None
        except (TypeError, ValueError):
            seed_root_int = None
        if seed_root_int is not None and seed_root_int > 0:
            seed_payload = {
                "root_id": seed_root_int,
                "mat_version": raw_seed.get("mat_version", mat_version),
            }
    # Global cell filter — `?cells=<table>.<col>:<op>:<val>[,...]`. Applied as
    # a row mask after decoration columns are merged. Tables referenced by a
    # predicate are auto-added to decoration_tables so the user doesn't have
    # to also "show" them.
    try:
        cell_filters = _parse_cells_param(request.args.get("cells"))
    except ValueError as exc:
        raise ApiError(422, "cells_invalid", str(exc)) from exc

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    specs = load_plot_specs()
    spec = specs.get(spec_name)
    if spec is None:
        raise ApiError(404, "plot_not_found",
                       f"No plot spec named {spec_name!r}",
                       hint=f"available: {sorted(specs.keys())}")

    source = spec.data_query.source
    # Wraps CAVEclient instantiation, datastack/aligned-volume YAML
    # resolution, the row-context setup, and (partners path only) the
    # spatial-provider build. On a warm pod each piece is fast individually,
    # but `request_client` alone has historically taken 50–200ms from
    # auth-server discovery — without this timer that cost lands in
    # `processing_ms` looking like in-process compute.
    nq: NeuronQuery | None = None
    ft_query: FeatureTableQuery | None = None
    spatial_provider = None
    with timer("plot_endpoint_setup"):
        try:
            token = current_token()
            bypass = is_dev_bypass()
            server_address = current_app.config["GLOBAL_SERVER_ADDRESS"]

            def client_factory():
                return request_client(
                    datastack_name=ds,
                    server_address=server_address,
                    auth_token=token,
                    dev_bypass=bypass,
                    materialize_version=mat_version,
                )

            client = client_factory()
        except ValueError as exc:
            raise ApiError(401, "no_auth_token", str(exc)) from exc

        cfg = load_datastack_config(ds)

        if source == "embedding_cells":
            # Explorer path: row context is a FeatureTableQuery over a
            # parquet declared in the feature_explorer manifest. No
            # focal neuron, no spatial features, no synapse query.
            feature_table_id = body.get("feature_table_id")
            embedding_id = body.get("embedding_id")
            if not feature_table_id or not embedding_id:
                raise ApiError(
                    422,
                    "missing_embedding_target",
                    "source 'embedding_cells' requires both 'feature_table_id' "
                    "and 'embedding_id' in the request body",
                )
            src = feature_source_for(ds, cfg)
            if src is None:
                raise ApiError(
                    404,
                    "feature_explorer_disabled",
                    f"datastack {ds!r} does not enable the feature explorer",
                )
            try:
                ft, _emb = src.resolve_embedding(feature_table_id, embedding_id)
            except KeyError as exc:
                raise ApiError(404, "embedding_not_found", str(exc)) from exc
            ft_query = FeatureTableQuery(
                datastack=ds,
                mat_version=mat_version,
                feature_table=ft,
                cfg=cfg,
                client_factory=client_factory,
            )
            # show_cell_depth is a partners-path notion; there's no focal
            # cell to anchor the depth marker to, so force it off here.
            show_cell_depth = False
        else:
            # Partner path: existing /neuron behavior. Requires root_id.
            root_id = body.get("root_id")
            if root_id is None:
                raise ApiError(
                    422, "missing_root_id",
                    f"source {source!r} requires 'root_id' in the request body",
                )
            # Spatial + synapse config from the aligned_volume; see /connectivity
            # for the cross-datastack-sharing rationale.
            av_cfg = aligned_volume_config_for(ds, client)
            syn_cfg = resolve_synapse_config(av_cfg, cfg)
            nq = NeuronQuery(
                client,
                root_id=int(root_id),
                datastack=ds,
                mat_version=mat_version,
                synapse_aggregation_rules=syn_cfg.aggregation_rules_for_neuron_query(),
                synapse_columns=syn_cfg.merged_columns(),
                synapse_position_prefix=syn_cfg.position_prefix,
            )
            spatial_provider = build_spatial_provider(av_cfg.spatial)
    try:
        result = resolve_plot(
            spec=spec, nq=nq, ft_query=ft_query,
            decoration_tables=decoration_tables,
            column_override=column_override,
            bindings=bindings,
            client_factory=client_factory,
            spatial_provider=spatial_provider,
            cell_filters=cell_filters,
            show_cell_depth=show_cell_depth,
            seed=seed_payload,
        )
    except ValueError as exc:
        raise ApiError(422, "plot_invalid_request", str(exc)) from exc
    except Exception as exc:
        raise ApiError(502, "plot_render_failed",
                       f"Failed to render plot: {type(exc).__name__}: {exc}") from exc
    return jsonify(result)
