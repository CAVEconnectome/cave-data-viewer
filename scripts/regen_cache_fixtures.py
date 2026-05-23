"""Regenerate `tests/fixtures/cache/v<N>/<kind>/sample.pkl` fixtures.

Each L2-backed cache kind gets one committed pickle fixture per active
version. The fixtures are consumed by
``tests/test_cache_pickle_compat.py`` to assert that today's reader
can still unpickle yesterday's bytes.

Two modes:

- **Synthesized** (default; no CAVE round-trip): builds values from
  primitive Python types with the same dtypes a CAVE query would
  produce. Suitable for catching dataclass / dtype regressions, which
  is the canary's whole job. Runs offline; CI uses this mode.

- **Real CAVE** (``--datastack <ds> --root-id <rid>`` + ``--kind
  synapse`` and/or ``--kind spatial_features``): replaces the
  synapse and spatial_features fixtures with bytes captured from an
  actual CAVE query. Requires CAVE auth + network. Useful when a
  pandas major-version bump changes pickle format and you want
  production-shaped bytes baked in.

Output path: ``tests/fixtures/cache/v<N>/<kind>/sample.pkl``, where
``<N>`` is the current ``_CACHE_VERSIONS[kind]`` value.

The fixture format matches what ``GcsObjectStore`` writes to L2: a
pickled ``(value, fetched_at)`` tuple, pickle protocol 5.
"""

from __future__ import annotations

import argparse
import pickle
import sys
import time
from pathlib import Path
from typing import Any, Callable


# Repository root (script lives in <repo>/scripts/).
REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_ROOT = REPO_ROOT / "tests" / "fixtures" / "cache"

# Default real-mode arguments. Pinning these keeps fixture regeneration
# boring and reproducible — see tests/fixtures/cache/README.md.
DEFAULT_DATASTACK = "minnie65_public"
DEFAULT_ROOT_ID = 864691135885917808


# ---------------------------------------------------------------------------
# Synthesizers — one per cache kind. Each returns a Python value whose
# shape matches what the live fetcher would return; the dtypes are
# chosen to mirror real CAVE output so a pandas regression is caught.
# ---------------------------------------------------------------------------


def synthesize_num_soma() -> dict:
    """`_fetch_num_soma_table` output: `{root_id_int: {"num_soma": int,
    "cell_id"?: str, "pt_position"?: [x, y, z]}}`."""
    return {
        864691135000000001: {
            "num_soma": 1,
            "cell_id": "100001",
            "pt_position": [123456.0, 234567.0, 50000.0],
        },
        864691135000000002: {
            "num_soma": 2,  # multi-nucleus → no cell_id / pt_position
        },
        864691135000000003: {
            "num_soma": 1,
            "cell_id": "100003",
            "pt_position": [654321.0, 765432.0, 60000.0],
        },
    }


def synthesize_table() -> dict:
    """`_fetch_decoration_table` output: `{root_id_int: {col: val, ...}}`
    where col types include str (cell_type), int (score), float
    (confidence)."""
    return {
        864691135000000001: {
            "cell_type": "L4_pyramidal",
            "status": "open",
            "confidence": 0.92,
        },
        864691135000000002: {
            "cell_type": "Vip",
            "status": "closed",
            "confidence": 0.55,
        },
    }


def synthesize_synapse() -> Any:
    """`_synapse_df` output: pandas DataFrame with int64 root id columns,
    int64 synapse id, int64 size, float64 split positions."""
    import numpy as np
    import pandas as pd

    return pd.DataFrame({
        "id": pd.array([1001, 1002, 1003, 1004], dtype="int64"),
        "pre_pt_root_id": pd.array(
            [864691135000000001, 864691135000000001, 864691135000000002, 864691135000000003],
            dtype="int64",
        ),
        "post_pt_root_id": pd.array(
            [864691135000000010, 864691135000000020, 864691135000000010, 864691135000000010],
            dtype="int64",
        ),
        "size": pd.array([512, 384, 1024, 256], dtype="int64"),
        "ctr_pt_position_x": np.array([100.0, 200.0, 300.0, 400.0], dtype="float64"),
        "ctr_pt_position_y": np.array([110.0, 220.0, 330.0, 440.0], dtype="float64"),
        "ctr_pt_position_z": np.array([10.0, 20.0, 30.0, 40.0], dtype="float64"),
    })


def synthesize_spatial_features() -> Any:
    """`CachedSpatialFeatures` instance with realistic structure: a few
    partner_intrinsic features, a per-direction feature pair, and an
    empty summary panel tuple."""
    from cave_data_viewer.api.services.spatial.cache import (
        CachedSpatialFeatures,
    )
    return CachedSpatialFeatures(
        intrinsic={
            864691135000000010: {
                "soma_depth": 350.0,
                "soma_x": 1200.5,
                "soma_z": -45.0,
                "radial_dist_root_soma": 87.2,
            },
            864691135000000020: {
                "soma_depth": 420.0,
                "soma_x": 1500.0,
                "soma_z": 12.0,
                "radial_dist_root_soma": 234.1,
            },
        },
        per_direction_in={
            "median_syn_depth": {
                864691135000000010: 340.0,
                864691135000000020: 410.0,
            },
        },
        per_direction_out={
            "median_syn_depth": {},
        },
        summary_panels=(),
    )


def synthesize_unique_values() -> dict:
    """`{column_name: [str_values...]}`. The full column-value universe
    for one materialization."""
    return {
        "cell_type": ["L2_pyramidal", "L4_pyramidal", "L5_pyramidal", "Vip", "Sst", "Pvalb"],
        "status": ["open", "closed", "review"],
    }


def synthesize_cell_id_universe() -> Any:
    """`CellUniverse` dataclass: dense `cell_to_root`, partial
    `root_to_cell` (dedup'd), partial `cell_to_pos`."""
    from cave_data_viewer.api.services.cell_id import CellUniverse
    return CellUniverse(
        cell_to_root={
            100001: 864691135000000001,
            100002: 864691135000000002,
            100003: None,  # row exists but root rolled over to 0
        },
        root_to_cell={
            864691135000000001: 100001,
            864691135000000002: 100002,
        },
        cell_to_pos={
            100001: (123.4, 234.5, 50.0),
            100002: (345.6, 456.7, 60.0),
            100003: None,
        },
    )


def synthesize_column_histograms() -> dict:
    """`histogram_to_json` output for a numeric column. Two-key cache:
    most callers store the numeric shape, categorical is the rarer
    variant. Pin numeric here since the dtype surface is what we worry
    about; add a categorical fixture later if a regression motivates it."""
    return {
        "kind": "numeric",
        "bin_min": 0.0,
        "bin_max": 100.0,
        "bin_edges": [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0],
        "bin_counts": [12, 18, 25, 30, 22, 17, 11, 8, 4, 2],
        "binning": "linear",
        "n_finite": 149,
        "n_null": 3,
        "log_fallback": False,
    }


SYNTHESIZERS: dict[str, Callable[[], Any]] = {
    "num_soma": synthesize_num_soma,
    "table": synthesize_table,
    "synapse": synthesize_synapse,
    "spatial_features": synthesize_spatial_features,
    "unique_values": synthesize_unique_values,
    "cell_id_universe": synthesize_cell_id_universe,
    "column_histograms": synthesize_column_histograms,
}


# ---------------------------------------------------------------------------
# Real-CAVE captures — only invoked when the user passes --root-id +
# --datastack and asks for one of these kinds. Optional; the script
# runs to completion in offline mode without these dependencies.
# ---------------------------------------------------------------------------


def capture_synapse_from_cave(datastack: str, root_id: int) -> Any:
    """Real CAVE pre-side synapse fetch for `root_id`. Mirrors what
    `NeuronQuery._synapse_df('post')` would cache."""
    from cave_data_viewer.api.cave import make_client_anonymous
    from cave_data_viewer.api.services.datastack_config import load_datastack_config
    cfg = load_datastack_config(datastack)
    client = make_client_anonymous(
        datastack,
        # `GLOBAL_SERVER_ADDRESS` lives in app config; use the CDV default for the
        # script context since we're not running a Flask app.
        "https://global.daf-apis.com",
        materialize_version=None,
        reason="regen_cache_fixtures",
    )
    syn_table = client.info.get_datastack_info().get("synapse_table")
    qf = client.materialize.tables[syn_table](post_pt_root_id=root_id)
    df = qf.query(split_positions=True, desired_resolution=[1, 1, 1])
    print(f"  captured synapse df for {datastack}/{root_id}: "
          f"rows={len(df)}, cols={list(df.columns)}")
    # Trim to a representative subset so the committed fixture stays small.
    if len(df) > 50:
        df = df.head(50).copy()
    return df


def capture_spatial_features_from_cave(*_args, **_kwargs) -> Any:
    """Real spatial features capture requires constructing a full
    NeuronQuery + decoration_lookup + SpatialProvider, which is a
    nontrivial chunk of request scaffolding. The synthesized fixture
    catches the dataclass-shape regression we care about; defer real
    capture to a future iteration when a regression motivates it.
    """
    print(
        "  [skip] real spatial_features capture is not implemented — "
        "the synthesized CachedSpatialFeatures fixture covers the "
        "dataclass-shape regressions this fixture is for. Add real "
        "capture when a pandas dtype drift in this kind motivates it."
    )
    return synthesize_spatial_features()


REAL_CAPTURERS: dict[str, Callable[[str, int], Any]] = {
    "synapse": capture_synapse_from_cave,
    "spatial_features": capture_spatial_features_from_cave,
}


# ---------------------------------------------------------------------------
# Fixture writer
# ---------------------------------------------------------------------------


def write_fixture(kind: str, value: Any) -> Path:
    """Pickle `(value, fetched_at)` and write under the kind's current
    version directory. Mirrors `GcsObjectStore.set`'s wire format."""
    from cave_data_viewer.api.services.object_store import _CACHE_VERSIONS
    version = _CACHE_VERSIONS[kind]
    target_dir = FIXTURE_ROOT / version / kind
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "sample.pkl"
    fetched_at = time.time()
    blob = pickle.dumps((value, fetched_at), protocol=5)
    target.write_bytes(blob)
    print(f"  wrote {target.relative_to(REPO_ROOT)} ({len(blob)} bytes)")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--kind",
        action="append",
        choices=sorted(SYNTHESIZERS.keys()),
        help="Regenerate only this kind. Repeatable. Default: all kinds.",
    )
    parser.add_argument(
        "--datastack",
        default=DEFAULT_DATASTACK,
        help=f"Datastack for real-CAVE capture (default: {DEFAULT_DATASTACK}).",
    )
    parser.add_argument(
        "--root-id",
        type=int,
        default=DEFAULT_ROOT_ID,
        help=f"Root id for real-CAVE capture (default: {DEFAULT_ROOT_ID}).",
    )
    parser.add_argument(
        "--real-cave",
        action="store_true",
        help="For kinds that have a real-CAVE capturer (currently: "
             "synapse), query CAVE instead of synthesizing. Requires "
             "CAVE auth. Other kinds remain synthesized.",
    )
    args = parser.parse_args(argv)

    kinds_to_write = args.kind or list(SYNTHESIZERS.keys())
    print(
        f"Regenerating {len(kinds_to_write)} cache fixture(s): "
        f"{sorted(kinds_to_write)}"
    )

    for kind in kinds_to_write:
        print(f"[{kind}]")
        if args.real_cave and kind in REAL_CAPTURERS:
            value = REAL_CAPTURERS[kind](args.datastack, args.root_id)
        else:
            value = SYNTHESIZERS[kind]()
        write_fixture(kind, value)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
