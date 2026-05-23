"""Shared endpoint plumbing — request-bound CAVEclient construction
and Feature-Explorer source/feature-table/embedding resolution.

Kept separate from `api/cave.py` (which is intentionally Flask-free)
so route handlers dispatch through one function rather than
re-implementing the same try / except in every endpoint module.

CAVEclient helpers:

- :func:`request_client_or_401` — one-shot per-request client; the
  missing-token ``ValueError`` is translated into the API's standard
  401 shape. The route owns ``mat_version`` parsing (query string vs
  JSON body) and passes it in explicitly, so the dependence stays
  visible at the call site rather than hidden in the helper.

- :func:`make_request_client_factory` — closure that constructs a
  CAVEclient on demand. Captures auth state at *construction* time so
  the closure remains usable after the Flask request context is gone
  (needed by background revalidators that outlive their originating
  request — see `services/decoration.py`).

Feature-Explorer resolution helpers consolidate the
config → source → feature-table / embedding lookup that ~every
``endpoints/embeddings.py`` handler runs at the top. Each translates
the underlying ``KeyError`` (or ``None`` source) into the appropriate
404 ``ApiError`` with the wire-contract code string.
"""

from flask import current_app

from ..auth import current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import load_datastack_config
from ..services.embeddings import (
    EmbeddingSpec,
    FeatureTableSpec,
    source_for,
)


def request_client_or_401(ds: str, mat_version: int | str | None):
    """Per-request CAVEclient; raises ``ApiError(401)`` if no auth is
    available. ``mat_version`` is explicit so the route handler keeps
    visible control over where it came from (query string vs body)."""
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


def resolve_ft_or_404(ds: str, feature_table_id: str):
    """Standard Feature-Explorer feature-table resolution.

    Returns ``(cfg, src, ft)``. Raises ``ApiError(404,
    "feature_explorer_disabled")`` when the datastack hasn't enabled
    the explorer, or ``ApiError(404, "feature_table_not_found")``
    when the ID doesn't match any table. Handlers that don't need
    ``src`` (most) can destructure with ``cfg, _, ft = ...``;
    distance_to_set and resolve_roots use ``src`` for downstream
    lookups.
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
        ft: FeatureTableSpec = src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc
    return cfg, src, ft


def resolve_embedding_or_404(
    ds: str, feature_table_id: str, embedding_id: str
):
    """Standard Feature-Explorer embedding resolution.

    Returns ``(cfg, ft, emb)``. Raises ``ApiError(404,
    "feature_explorer_disabled")`` when the datastack hasn't enabled
    the explorer, or ``ApiError(404, "embedding_not_found")`` when
    the ``(feature_table_id, embedding_id)`` pair doesn't match.
    ``src`` is intentionally not returned: every current caller
    discards it after the embedding resolves.
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
    ft_typed: FeatureTableSpec = ft
    emb_typed: EmbeddingSpec = emb
    return cfg, ft_typed, emb_typed


def make_request_client_factory(ds: str, mat_version: int | str | None):
    """Build a closure that constructs a CAVEclient for ``ds`` at
    ``mat_version``. Auth state (token, dev_bypass flag, server
    address) is captured at construction time so the factory remains
    usable after the Flask request context is gone."""
    token = current_token()
    bypass = is_dev_bypass()
    server_address = current_app.config["GLOBAL_SERVER_ADDRESS"]

    def factory():
        return request_client(
            datastack_name=ds,
            server_address=server_address,
            auth_token=token,
            dev_bypass=bypass,
            materialize_version=mat_version,
        )

    return factory
