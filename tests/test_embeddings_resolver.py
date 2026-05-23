"""Tests for `embeddings/resolver.py` — the cell_id -> root_id boundary
between the feature explorer (cell_id space) and connectivity (root_id
space).

`test_cell_id_resolver.py` covers the underlying `cell_id.py` lookup
primitive. This file covers the thin wrapper that turns the primitive's
`{cell_id: root_id}` mapping into the structured `Resolution` records
the `/resolve_roots` endpoint and the SPA's cross-nav prefetch consume:
order preservation, the ok/missing status assignment, the empty
short-circuit, and int coercion of the root id. The primitive is
monkeypatched so no CAVE access is needed.
"""

from __future__ import annotations

from cave_data_viewer.api.services import cell_id as cell_id_mod
from cave_data_viewer.api.services.embeddings.resolver import (
    Resolution,
    resolve_cell_ids_to_root_ids,
)


def _fake_primitive(mapping):
    """Stand-in for `cell_ids_to_root_ids`: returns `mapping` filtered to
    the requested cell_ids, ignoring client / cfg / version entirely so
    the tests can pass sentinel objects."""

    def _fake(*, client, cfg, mat_version, datastack, cell_ids):
        return {c: mapping[c] for c in cell_ids if c in mapping}

    return _fake


def test_empty_input_short_circuits(monkeypatch):
    called = {"hit": False}

    def _boom(**_kwargs):
        called["hit"] = True
        return {}

    monkeypatch.setattr(cell_id_mod, "cell_ids_to_root_ids", _boom)
    out = resolve_cell_ids_to_root_ids(
        client=object(), cfg=object(), mat_version=1,
        datastack="ds", cell_ids=[],
    )
    assert out == []
    assert called["hit"] is False  # primitive not even called


def test_ok_and_missing_in_input_order(monkeypatch):
    monkeypatch.setattr(
        cell_id_mod, "cell_ids_to_root_ids", _fake_primitive({10: 999, 20: 888})
    )
    out = resolve_cell_ids_to_root_ids(
        client=object(), cfg=object(), mat_version=1,
        datastack="ds", cell_ids=[20, 30, 10],
    )
    # output[i].cell_id == cell_ids[i] — positional order is the contract.
    assert [r.cell_id for r in out] == [20, 30, 10]
    assert out[0] == Resolution(cell_id=20, root_id=888, status="ok")
    assert out[1] == Resolution(cell_id=30, root_id=None, status="missing")
    assert out[2] == Resolution(cell_id=10, root_id=999, status="ok")


def test_only_ok_or_missing_emitted(monkeypatch):
    # `ambiguous` is a reserved-for-future status; the forward direction
    # never emits it. Pinning this lets callers branch on two values.
    monkeypatch.setattr(
        cell_id_mod, "cell_ids_to_root_ids", _fake_primitive({1: 100})
    )
    out = resolve_cell_ids_to_root_ids(
        client=object(), cfg=object(), mat_version="live",
        datastack="ds", cell_ids=[1, 2],
    )
    assert {r.status for r in out} == {"ok", "missing"}


def test_root_id_coerced_to_plain_int(monkeypatch):
    # The primitive may yield a numpy int / string id; Resolution.root_id
    # must be a plain int so the JSON layer stringifies it cleanly.
    monkeypatch.setattr(
        cell_id_mod, "cell_ids_to_root_ids",
        _fake_primitive({5: "864691135000000000"}),
    )
    out = resolve_cell_ids_to_root_ids(
        client=object(), cfg=object(), mat_version=1,
        datastack="ds", cell_ids=[5],
    )
    assert out[0].root_id == 864691135000000000
    assert type(out[0].root_id) is int
