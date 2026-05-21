"""Schema tests for `DatastackConfig` — focuses on the configurable
cell_id / root_id join-column fields and the bare-string ↔ block-form
coercion that preserves backwards compatibility for pre-existing
deployment YAMLs.
"""

from __future__ import annotations

import pytest

from cave_data_viewer.api.services.datastack_config import (
    CellIdLookup,
    DatastackConfig,
    RootIdLookupAltTable,
    RootIdLookupTable,
)


def test_cell_id_lookup_default_column() -> None:
    """`cell_id_column` defaults to "id" when omitted from the YAML —
    matches every pre-existing deployment's hardcoded behavior.
    """
    lookup = CellIdLookup.model_validate({"kind": "view", "name": "nuc_view"})
    assert lookup.cell_id_column == "id"


def test_cell_id_lookup_explicit_column() -> None:
    lookup = CellIdLookup.model_validate(
        {"kind": "view", "name": "nuc_view", "cell_id_column": "nucleus_id"}
    )
    assert lookup.cell_id_column == "nucleus_id"


def test_main_table_bare_string_coerces() -> None:
    """Pre-existing YAMLs write `root_id_lookup_main_table: <table>` as
    a bare string. After the schema change to `RootIdLookupTable`, the
    `mode="before"` validator coerces it transparently so old YAMLs
    keep parsing without an edit.
    """
    cfg = DatastackConfig.model_validate(
        {"root_id_lookup_main_table": "nucleus_detection_v0"}
    )
    assert isinstance(cfg.root_id_lookup_main_table, RootIdLookupTable)
    assert cfg.root_id_lookup_main_table.name == "nucleus_detection_v0"
    assert cfg.root_id_lookup_main_table.cell_id_column == "id"
    assert cfg.root_id_lookup_main_table.pt_root_column == "pt_root_id"


def test_main_table_block_form_with_overrides() -> None:
    cfg = DatastackConfig.model_validate(
        {
            "root_id_lookup_main_table": {
                "name": "alt_table",
                "cell_id_column": "nucleus_id",
                "pt_root_column": "root_id_native",
            }
        }
    )
    main = cfg.root_id_lookup_main_table
    assert main is not None
    assert main.name == "alt_table"
    assert main.cell_id_column == "nucleus_id"
    assert main.pt_root_column == "root_id_native"


def test_alt_tables_bare_string_coerces() -> None:
    cfg = DatastackConfig.model_validate(
        {"root_id_lookup_alt_tables": ["legacy_points", "older_alt"]}
    )
    alts = cfg.root_id_lookup_alt_tables
    assert len(alts) == 2
    assert all(isinstance(a, RootIdLookupAltTable) for a in alts)
    assert alts[0].name == "legacy_points"
    # Alt-table defaults match the historical hardcoded rename
    # (`target_id` payload, filtered by `pt_ref_root_id`).
    assert alts[0].cell_id_column == "target_id"
    assert alts[0].pt_root_column == "pt_ref_root_id"


def test_alt_tables_mixed_list_parses() -> None:
    """A YAML list mixing bare-string and block-form entries — common
    transitional state when promoting one entry to a custom-column
    schema while leaving siblings as-is.
    """
    cfg = DatastackConfig.model_validate(
        {
            "root_id_lookup_alt_tables": [
                "legacy_points",
                {
                    "name": "new_alt",
                    "cell_id_column": "alt_target",
                    "pt_root_column": "alt_root",
                },
            ]
        }
    )
    alts = cfg.root_id_lookup_alt_tables
    assert alts[0].name == "legacy_points"
    assert alts[0].cell_id_column == "target_id"  # defaulted
    assert alts[1].name == "new_alt"
    assert alts[1].cell_id_column == "alt_target"
    assert alts[1].pt_root_column == "alt_root"


def test_main_table_absent_yields_none() -> None:
    """Omitting the field entirely leaves it as None — datastacks
    without a reverse lookup (the SPA hides the cell-id input) are
    represented by absence, not by an empty block.
    """
    cfg = DatastackConfig.model_validate({})
    assert cfg.root_id_lookup_main_table is None
    assert cfg.root_id_lookup_alt_tables == []


def test_cell_id_lookup_resource_includes_column() -> None:
    """`cell_id_lookup_resource()` returns `(name, kind, cell_id_column)`
    — three elements, not two. The resolver uses the third to drive
    both the filter and the dataframe-index column.
    """
    cfg = DatastackConfig.model_validate(
        {
            "cell_id_lookup": {
                "kind": "view",
                "name": "nuc_lookup",
                "cell_id_column": "nucleus_id",
            }
        }
    )
    resolved = cfg.cell_id_lookup_resource()
    assert resolved == ("nuc_lookup", "view", "nucleus_id")


def test_cell_id_lookup_resource_none_when_unset() -> None:
    cfg = DatastackConfig.model_validate({})
    assert cfg.cell_id_lookup_resource() is None
