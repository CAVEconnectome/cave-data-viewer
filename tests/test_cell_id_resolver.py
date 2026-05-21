"""Resolver tests for `cell_id.py` — forward (cell_id → root_id) and
reverse (root_id → cell_id) paths under the new configurable-column
schema.

Uses a hand-rolled fake CAVEclient because the real `CAVEclient` is a
heavy dependency that requires auth + a live discovery endpoint. The
fake gives `client.materialize.views[name]` and
`client.materialize.tables[name]` the same callable-factory-with-
`.query()` shape the resolver depends on, and lets each test inject
the result frame the way the production view would return it.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pandas as pd
import pytest

from cave_data_viewer.api.services import cell_id as cell_id_mod
from cave_data_viewer.api.services.cell_id import (
    cell_ids_to_root_ids,
    root_ids_to_cell_ids,
)
from cave_data_viewer.api.services.datastack_config import DatastackConfig


# ---------- fake CAVEclient -------------------------------------------------


class _FakeQueryFactory:
    """Returned by `views[name](**filters)` / `tables[name](**filters)`.
    `.query(...)` returns the DataFrame the test handed in for this
    `(resource_name, filters)` invocation.
    """

    def __init__(self, df: pd.DataFrame) -> None:
        self._df = df

    def query(self, **_query_kwargs: Any) -> pd.DataFrame:
        # Resolver passes `split_positions=False` (+ `desired_resolution`
        # on the universe path). Tests don't care about the kwargs;
        # they care about the result frame.
        return self._df

    def live_query(self, _ts, **_query_kwargs: Any) -> pd.DataFrame:
        return self._df


class _FakeResource:
    """Subscript accessor: `views["nuc_lookup"]` → callable factory.

    The callable signature is `factory(**filter_kwargs)`. Tests register
    response builders that close over the expected resource name and
    return a DataFrame given the filter kwargs (so a test can verify
    the resolver passed the right column-name in the filter).
    """

    def __init__(
        self, response_builder: Callable[[str, dict[str, Any]], pd.DataFrame]
    ) -> None:
        self._build = response_builder

    def __getitem__(self, name: str) -> Callable[..., _FakeQueryFactory]:
        def factory(**filters: Any) -> _FakeQueryFactory:
            return _FakeQueryFactory(self._build(name, filters))
        return factory


class _FakeMaterialize:
    def __init__(
        self,
        views_builder: Callable[[str, dict[str, Any]], pd.DataFrame] | None = None,
        tables_builder: Callable[[str, dict[str, Any]], pd.DataFrame] | None = None,
    ) -> None:
        self.views = _FakeResource(views_builder or (lambda n, f: pd.DataFrame()))
        self.tables = _FakeResource(tables_builder or (lambda n, f: pd.DataFrame()))


class _FakeClient:
    def __init__(
        self,
        views_builder: Callable[[str, dict[str, Any]], pd.DataFrame] | None = None,
        tables_builder: Callable[[str, dict[str, Any]], pd.DataFrame] | None = None,
    ) -> None:
        self.materialize = _FakeMaterialize(views_builder, tables_builder)


# ---------- shared fixtures -------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_module_caches():
    """The resolver's module-level fallback caches survive across tests
    without an app context; clear before each test so cache-key
    behavior is observable.
    """
    cell_id_mod._universe_mat.clear()
    cell_id_mod._root_to_cell.clear()
    cell_id_mod._cell_to_root_live.clear()
    yield
    cell_id_mod._universe_mat.clear()
    cell_id_mod._root_to_cell.clear()
    cell_id_mod._cell_to_root_live.clear()


# ---------- forward direction: default column -------------------------------


def test_forward_universe_default_column_id():
    """Backwards-compat smoke: a YAML using the standard column `id`
    resolves cell_ids → root_ids exactly as before.
    """
    cfg = DatastackConfig.model_validate({
        "cell_id_lookup": {"kind": "view", "name": "nuc_view"},
    })
    universe_df = pd.DataFrame({
        "id": [10, 20, 30],
        "pt_root_id": [100, 200, 300],
    })

    seen_calls: list[tuple[str, dict[str, Any]]] = []

    def views_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        seen_calls.append((name, filters))
        if name == "nuc_view":
            return universe_df
        return pd.DataFrame()

    client = _FakeClient(views_builder=views_builder)
    out = cell_ids_to_root_ids(
        client=client, cfg=cfg, mat_version=42, datastack="ds_test",
        cell_ids=[10, 20, 99],
    )
    assert out == {10: 100, 20: 200, 99: None}
    # Universe-load path issues an unfiltered query.
    assert seen_calls == [("nuc_view", {})]


# ---------- forward direction: configurable column --------------------------


def test_forward_universe_non_default_column():
    """A YAML configuring `cell_id_column: nucleus_id` reads the parquet
    keys from the `nucleus_id` column of the lookup view instead of `id`.
    """
    cfg = DatastackConfig.model_validate({
        "cell_id_lookup": {
            "kind": "view",
            "name": "nuc_view",
            "cell_id_column": "nucleus_id",
        },
    })
    universe_df = pd.DataFrame({
        "nucleus_id": [10, 20, 30],
        "pt_root_id": [100, 200, 300],
        # Deliberately include a column literally named "id" with
        # bogus values; this catches a regression where the resolver
        # falls back to the hardcoded literal.
        "id": [-1, -1, -1],
    })

    def views_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        return universe_df if name == "nuc_view" else pd.DataFrame()

    client = _FakeClient(views_builder=views_builder)
    out = cell_ids_to_root_ids(
        client=client, cfg=cfg, mat_version=42, datastack="ds_test",
        cell_ids=[10, 30],
    )
    assert out == {10: 100, 30: 300}


def test_universe_cache_key_includes_column():
    """Two universes built off the same (datastack, mat_version, view)
    but with different `cell_id_column` values produce two distinct
    cache entries — no cross-contamination if an operator changes the
    column on a live deployment.
    """
    cfg_default = DatastackConfig.model_validate({
        "cell_id_lookup": {"kind": "view", "name": "nuc_view"},
    })
    cfg_custom = DatastackConfig.model_validate({
        "cell_id_lookup": {
            "kind": "view", "name": "nuc_view", "cell_id_column": "nucleus_id",
        },
    })

    # Each schema returns a frame keyed by its own column. The values
    # are deliberately different so cross-contamination would surface
    # as wrong root_ids in the output.
    default_df = pd.DataFrame({"id": [1, 2], "pt_root_id": [11, 22]})
    custom_df = pd.DataFrame({"nucleus_id": [1, 2], "pt_root_id": [99, 100]})

    state = {"call_count": 0}

    def views_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        state["call_count"] += 1
        return default_df if state["call_count"] == 1 else custom_df

    client = _FakeClient(views_builder=views_builder)
    out1 = cell_ids_to_root_ids(
        client=client, cfg=cfg_default, mat_version=7, datastack="ds_test",
        cell_ids=[1, 2],
    )
    out2 = cell_ids_to_root_ids(
        client=client, cfg=cfg_custom, mat_version=7, datastack="ds_test",
        cell_ids=[1, 2],
    )
    assert out1 == {1: 11, 2: 22}
    assert out2 == {1: 99, 2: 100}
    # Two universe fetches — confirms the cache key distinguishes the two.
    assert state["call_count"] == 2


def test_universe_cache_hits_on_repeat_with_same_column():
    """Sanity check: with column held constant, a second call to the
    same (datastack, mat_version, view, column) hits the cache and
    does NOT issue a second CAVE query.
    """
    cfg = DatastackConfig.model_validate({
        "cell_id_lookup": {"kind": "view", "name": "nuc_view"},
    })
    df = pd.DataFrame({"id": [1, 2], "pt_root_id": [10, 20]})

    state = {"call_count": 0}

    def views_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        state["call_count"] += 1
        return df

    client = _FakeClient(views_builder=views_builder)
    cell_ids_to_root_ids(
        client=client, cfg=cfg, mat_version=7, datastack="ds_test", cell_ids=[1],
    )
    cell_ids_to_root_ids(
        client=client, cfg=cfg, mat_version=7, datastack="ds_test", cell_ids=[2],
    )
    assert state["call_count"] == 1


# ---------- reverse direction: default columns ------------------------------


def test_reverse_main_default_columns():
    """Default schema: `root_id_lookup_main_table: nucleus_detection_v0`
    (bare string) filters on `pt_root_id`, reads `id`.
    """
    cfg = DatastackConfig.model_validate({
        "root_id_lookup_main_table": "nucleus_detection_v0",
    })
    main_df = pd.DataFrame({"pt_root_id": [100, 200], "id": [10, 20]})

    captured_filters: list[tuple[str, dict[str, Any]]] = []

    def tables_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        captured_filters.append((name, filters))
        return main_df

    client = _FakeClient(tables_builder=tables_builder)
    out = root_ids_to_cell_ids(
        client=client, cfg=cfg, mat_version=42, datastack="ds_test",
        root_ids=[100, 200],
    )
    assert out == {100: 10, 200: 20}
    # Filter column is `pt_root_id` (default).
    assert captured_filters == [
        ("nucleus_detection_v0", {"pt_root_id": [100, 200]}),
    ]


# ---------- reverse direction: configurable columns -------------------------


def test_reverse_main_custom_columns():
    """A YAML promoting `root_id_lookup_main_table` to the block form
    with custom column names drives the query through those columns —
    filter on `root_id_native`, read `nucleus_id`.
    """
    cfg = DatastackConfig.model_validate({
        "root_id_lookup_main_table": {
            "name": "custom_main",
            "cell_id_column": "nucleus_id",
            "pt_root_column": "root_id_native",
        },
    })
    main_df = pd.DataFrame({
        "root_id_native": [100, 200],
        "nucleus_id": [10, 20],
        # Decoy hardcoded-name columns to catch any regression:
        "pt_root_id": [-1, -1],
        "id": [-1, -1],
    })

    captured_filters: list[tuple[str, dict[str, Any]]] = []

    def tables_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        captured_filters.append((name, filters))
        return main_df

    client = _FakeClient(tables_builder=tables_builder)
    out = root_ids_to_cell_ids(
        client=client, cfg=cfg, mat_version=42, datastack="ds_test",
        root_ids=[100, 200],
    )
    assert out == {100: 10, 200: 20}
    assert captured_filters == [
        ("custom_main", {"root_id_native": [100, 200]}),
    ]


def test_reverse_alt_tables_custom_columns():
    """Alt-tables with mixed schemas — one default, one custom — both
    resolve correctly via the internal rename to `pt_root_id`/`id`.
    """
    cfg = DatastackConfig.model_validate({
        "root_id_lookup_main_table": "main_t",
        "root_id_lookup_alt_tables": [
            "legacy_alt",  # bare string → default schema
            {
                "name": "new_alt",
                "cell_id_column": "alt_cell_id",
                "pt_root_column": "alt_root",
            },
        ],
    })
    # Main table maps nothing → both root_ids fall through to alts.
    main_df = pd.DataFrame({"pt_root_id": [], "id": []})
    legacy_df = pd.DataFrame({  # default schema
        "pt_ref_root_id": [100], "target_id": [10],
    })
    new_df = pd.DataFrame({  # custom schema
        "alt_root": [200], "alt_cell_id": [20],
    })

    def tables_builder(name: str, filters: dict[str, Any]) -> pd.DataFrame:
        if name == "main_t":
            return main_df
        if name == "legacy_alt":
            return legacy_df
        if name == "new_alt":
            return new_df
        return pd.DataFrame()

    client = _FakeClient(tables_builder=tables_builder)
    out = root_ids_to_cell_ids(
        client=client, cfg=cfg, mat_version=42, datastack="ds_test",
        root_ids=[100, 200, 999],
    )
    assert out == {100: 10, 200: 20, 999: None}
