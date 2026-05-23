"""Batched cell_id → root_id resolution + find_cells (root_id →
cell_id with stale-root alignment).

Both routes are thin shells over services in this module. The lazy
CAVEclient used by ``resolve_roots`` skips the ~500ms client build on
universe-cache hits — the proxy below defers construction to first
attribute access.
"""

from __future__ import annotations

from typing import Any

from ..cell_id import root_ids_to_cell_ids
from ..datastack_config import check_live_allowed
from ..neuron import suggest_current_roots
from ...errors import ApiError
from .resolver import Resolution, resolve_cell_ids_to_root_ids


class LazyClient:
    """Proxy that defers a CAVEclient construction until first
    attribute access. Used by ``resolve_roots`` so cache-hit requests
    skip the ~500ms client-build overhead entirely. On a miss, the
    first ``client.materialize.views[...]`` access triggers the
    underlying factory call exactly once."""

    __slots__ = ("_factory", "_built")

    def __init__(self, factory):
        self._factory = factory
        self._built = None

    def __getattr__(self, name):
        if self._built is None:
            self._built = self._factory()
        return getattr(self._built, name)


def _resolution_to_json(r: Resolution, *, ds: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "cell_id": str(r.cell_id),
        "source_ds": ds,
        "root_id": str(r.root_id) if r.root_id is not None else None,
        "status": r.status,
    }
    if r.candidates:
        out["candidates"] = [str(c) for c in r.candidates]
    return out


def compute_resolve_roots(
    *,
    ds: str,
    cfg,
    body: dict[str, Any],
    client_factory,
) -> dict[str, Any]:
    """Cell_id → root_id resolve at one mat_version.

    Order of the returned ``resolutions`` mirrors the input order.
    Raises :class:`ApiError` with the same code strings the inline
    handler used (``missing_cell_ids``, ``invalid_cell_ids``,
    ``missing_mat_version``, ``live_mode_disallowed``,
    ``lookup_unavailable``, ``cave_upstream``)."""
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
        return {"mat_version": body.get("mat_version"), "resolutions": []}

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

    client = LazyClient(client_factory)
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

    return {
        "mat_version": str(mat_version) if mat_version is not None else None,
        "resolutions": [_resolution_to_json(r, ds=ds) for r in resolutions],
    }


def compute_find_cells(
    *,
    ds: str,
    cfg,
    body: dict[str, Any],
    client_factory,
) -> dict[str, Any]:
    """Cross-version root_id → cell_id lookup.

    Three-step pipeline (universe direct lookup → chunkedgraph
    alignment for misses → re-lookup aligned roots). Per-input failures
    (``unaligned`` / ``unresolved`` status) are not top-level errors;
    partial-success batches are the common case.

    ``client_factory`` is invoked lazily AFTER all body validation
    passes, so a bogus ``mat_version`` in the body raises a 422 before
    any CAVEclient is built (preserves the existing pre-client error
    ordering).

    Raises :class:`ApiError` with the same code strings the inline
    handler used (``missing_root_ids``, ``invalid_root_ids``,
    ``missing_mat_version``, ``invalid_mat_version``,
    ``live_mode_disallowed``, ``lookup_unavailable``, ``cave_upstream``).
    """
    raw_ids = body.get("root_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ApiError(
            422,
            "missing_root_ids",
            "body must include a non-empty `root_ids` list",
        )
    try:
        original_root_ids = [int(r) for r in raw_ids]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_root_ids",
            f"all root_ids must be integers: {exc}",
        ) from exc

    if "mat_version" not in body:
        raise ApiError(
            422,
            "missing_mat_version",
            "body must include `mat_version` (int or \"live\")",
        )
    mat_version_raw = body["mat_version"]
    if mat_version_raw == "live":
        mat_version: int | str = "live"
    else:
        try:
            mat_version = int(mat_version_raw)
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422,
                "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mat_version_raw!r}",
            ) from exc

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client = client_factory()

    try:
        direct_lookup = root_ids_to_cell_ids(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            root_ids=original_root_ids,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502,
            "cave_upstream",
            f"universe lookup failed: {type(exc).__name__}: {exc}",
        ) from exc

    missing_inputs = [
        r for r in original_root_ids if direct_lookup.get(r) is None
    ]
    alignment: dict[int, int | None] = {}
    aligned_lookup: dict[int, int | None] = {}
    if missing_inputs:
        try:
            alignment = suggest_current_roots(
                client, missing_inputs, mat_version=mat_version
            )
        except Exception as exc:
            raise ApiError(
                502,
                "cave_upstream",
                f"chunkedgraph alignment failed: {type(exc).__name__}: {exc}",
            ) from exc

        aligned_to_lookup: list[int] = []
        seen: set[int] = set()
        for orig in missing_inputs:
            aligned = alignment.get(orig)
            if aligned is None or aligned in seen:
                continue
            if aligned == orig:
                continue
            aligned_to_lookup.append(aligned)
            seen.add(aligned)

        if aligned_to_lookup:
            try:
                aligned_lookup = root_ids_to_cell_ids(
                    client=client,
                    cfg=cfg,
                    mat_version=mat_version,
                    datastack=ds,
                    root_ids=aligned_to_lookup,
                )
            except ValueError as exc:
                raise ApiError(422, "lookup_unavailable", str(exc)) from exc
            except Exception as exc:
                raise ApiError(
                    502,
                    "cave_upstream",
                    f"nucleus lookup failed: {type(exc).__name__}: {exc}",
                ) from exc

    results: list[dict[str, Any]] = []
    for orig in original_root_ids:
        direct_cid = direct_lookup.get(orig)
        if direct_cid is not None:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": str(orig),
                    "cell_id": str(int(direct_cid)),
                    "aligned": False,
                    "status": "ok",
                }
            )
            continue
        aligned = alignment.get(orig)
        if aligned is None:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": None,
                    "cell_id": None,
                    "aligned": False,
                    "status": "unaligned",
                }
            )
            continue
        if aligned == orig:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": str(aligned),
                    "cell_id": None,
                    "aligned": False,
                    "status": "unresolved",
                }
            )
            continue
        cell_id = aligned_lookup.get(aligned)
        if cell_id is None:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": str(aligned),
                    "cell_id": None,
                    "aligned": True,
                    "status": "unresolved",
                }
            )
            continue
        results.append(
            {
                "original_root_id": str(orig),
                "root_id": str(aligned),
                "cell_id": str(int(cell_id)),
                "aligned": True,
                "status": "ok",
            }
        )

    return {
        "mat_version": str(mat_version) if mat_version is not None else None,
        "results": results,
    }
