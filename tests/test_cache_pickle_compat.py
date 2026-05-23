"""Pickle compatibility for L2-backed cache values.

Three test layers, each catching a distinct class of regression:

1. **Round-trip** — pickle a freshly-synthesized value of each kind,
   unpickle it, assert structural equality. Catches `__reduce__`
   regressions, custom serialization breakage, and dataclass-field
   ordering issues that survive a single-process round-trip.

2. **Schema-shape** — unpickle the committed current-version fixture
   and assert the recovered object has the expected attributes /
   columns / dtypes. The real bite-detector — when a dataclass field
   gets renamed or a pandas dtype shifts, this test fails with a
   clear message naming the bad attribute or column.

3. **Cross-version canary** — for every active version directory in
   `tests/fixtures/cache/v<N>/`, unpickle every kind's fixture and
   run the schema-shape assertions. Catches the production-blocker
   case where a refactor lands and pods can no longer unpickle entries
   written by other pods or by prior deploys.

When the canary fails, the test message names the failing kind +
version and prints the remediation steps verbatim. See
`tests/fixtures/cache/README.md` for the full workflow.
"""

from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from cave_data_viewer.api.services.object_store import _CACHE_VERSIONS, _KINDS

FIXTURE_ROOT = Path(__file__).parent / "fixtures" / "cache"


# ---------------------------------------------------------------------------
# Schema-shape assertions — one per kind. Each takes an already-
# unpickled value and asserts the structural invariants that the
# production code depends on. If a refactor breaks one of these, the
# test message names the failed assertion clearly.
# ---------------------------------------------------------------------------


def _check_num_soma_shape(value: Any) -> None:
    """`_fetch_num_soma_table` returns `dict[int, dict]`. The inner
    dict always has `num_soma`; `cell_id` and `pt_position` are
    optional (only on single-nucleus roots)."""
    assert isinstance(value, dict), f"num_soma fixture must be dict, got {type(value).__name__}"
    for rid, rec in value.items():
        assert isinstance(rid, int), f"num_soma key must be int (got {type(rid).__name__} {rid!r})"
        assert isinstance(rec, dict), f"num_soma value must be dict (got {type(rec).__name__})"
        assert "num_soma" in rec, f"num_soma record missing 'num_soma' field: {rec!r}"
        assert isinstance(rec["num_soma"], int), (
            f"num_soma['num_soma'] must be int (got {type(rec['num_soma']).__name__})"
        )


def _check_table_shape(value: Any) -> None:
    """`_fetch_decoration_table` returns `dict[int, dict[str, Any]]` —
    one entry per root_id with the table's annotation columns."""
    assert isinstance(value, dict), f"table fixture must be dict, got {type(value).__name__}"
    for rid, rec in value.items():
        assert isinstance(rid, int), f"table key must be int (got {type(rid).__name__})"
        assert isinstance(rec, dict), f"table value must be dict (got {type(rec).__name__})"
        for col_name in rec:
            assert isinstance(col_name, str), (
                f"table inner key must be str column name (got {type(col_name).__name__})"
            )


def _check_synapse_shape(value: Any) -> None:
    """`_synapse_df` returns a pandas DataFrame with int64 root id /
    synapse id columns and float64 split-position columns. A pandas
    major version that drops int64 nullable support, or a fetcher that
    starts using a different dtype, fails here."""
    assert isinstance(value, pd.DataFrame), (
        f"synapse fixture must be pd.DataFrame, got {type(value).__name__}"
    )
    required_cols = {"id", "pre_pt_root_id", "post_pt_root_id"}
    missing = required_cols - set(value.columns)
    assert not missing, f"synapse df missing required columns: {missing}"
    for col in ("id", "pre_pt_root_id", "post_pt_root_id"):
        dtype = value[col].dtype
        assert "int" in str(dtype), (
            f"synapse df column {col!r} must be int dtype (got {dtype})"
        )


def _check_spatial_features_shape(value: Any) -> None:
    """`CachedSpatialFeatures` dataclass — attribute renames break this."""
    from cave_data_viewer.api.services.spatial.cache import CachedSpatialFeatures
    assert isinstance(value, CachedSpatialFeatures), (
        f"spatial_features fixture must be CachedSpatialFeatures, got {type(value).__name__}"
    )
    # Each documented attribute must exist; missing one means the
    # dataclass was refactored in a way that breaks unpickling for
    # prior-version entries.
    for attr in ("intrinsic", "per_direction_in", "per_direction_out", "summary_panels"):
        assert hasattr(value, attr), (
            f"CachedSpatialFeatures lost attribute {attr!r} — old fixtures will "
            "fail to unpickle on the new shape"
        )


def _check_unique_values_shape(value: Any) -> None:
    """Distinct-value universe: `dict[str, list[str]]`."""
    assert isinstance(value, dict), f"unique_values fixture must be dict, got {type(value).__name__}"
    for col, vals in value.items():
        assert isinstance(col, str), f"unique_values key must be str (got {type(col).__name__})"
        assert isinstance(vals, list), f"unique_values value must be list (got {type(vals).__name__})"
        for v in vals:
            assert isinstance(v, str), (
                f"unique_values inner value must be str (got {type(v).__name__})"
            )


def _check_cell_id_universe_shape(value: Any) -> None:
    """`CellUniverse` dataclass — three dict-valued attributes."""
    from cave_data_viewer.api.services.cell_id import CellUniverse
    assert isinstance(value, CellUniverse), (
        f"cell_id_universe fixture must be CellUniverse, got {type(value).__name__}"
    )
    for attr in ("cell_to_root", "root_to_cell", "cell_to_pos"):
        assert hasattr(value, attr), (
            f"CellUniverse lost attribute {attr!r} — old fixtures will fail "
            "to unpickle on the new shape"
        )
        sub = getattr(value, attr)
        assert isinstance(sub, dict), (
            f"CellUniverse.{attr} must be dict (got {type(sub).__name__})"
        )


def _check_column_histograms_shape(value: Any) -> None:
    """`histogram_to_json` output: numeric or categorical histogram dict."""
    assert isinstance(value, dict), (
        f"column_histograms fixture must be dict, got {type(value).__name__}"
    )
    assert "kind" in value, "column_histograms fixture missing 'kind'"
    if value["kind"] == "numeric":
        for k in ("bin_min", "bin_max", "bin_edges", "bin_counts", "binning"):
            assert k in value, f"numeric histogram missing {k!r}"
    elif value["kind"] == "categorical":
        for k in ("counts",):
            assert k in value, f"categorical histogram missing {k!r}"
    else:
        pytest.fail(f"unknown histogram kind {value['kind']!r}")


SCHEMA_CHECKERS = {
    "num_soma": _check_num_soma_shape,
    "table": _check_table_shape,
    "synapse": _check_synapse_shape,
    "spatial_features": _check_spatial_features_shape,
    "unique_values": _check_unique_values_shape,
    "cell_id_universe": _check_cell_id_universe_shape,
    "column_histograms": _check_column_histograms_shape,
}


# ---------------------------------------------------------------------------
# Layer 0: parity — every kind in _KINDS must have a schema checker
# and a fixture committed under the current version directory. A new
# cache kind added without its fixture would otherwise drift silently.
# ---------------------------------------------------------------------------


def test_every_kind_has_a_schema_checker():
    missing = set(_KINDS) - set(SCHEMA_CHECKERS.keys())
    assert not missing, (
        f"Schema-shape checker missing for cache kinds: {sorted(missing)}. "
        "Add an entry to SCHEMA_CHECKERS in tests/test_cache_pickle_compat.py."
    )


def test_every_kind_has_a_current_version_fixture():
    """The current `_CACHE_VERSIONS[kind]` value must have a committed
    fixture. Otherwise the cross-version canary degrades to "test the
    current version against itself," which the round-trip layer already
    does — defeats the canary's purpose."""
    missing: list[str] = []
    for kind in _KINDS:
        version = _CACHE_VERSIONS[kind]
        path = FIXTURE_ROOT / version / kind / "sample.pkl"
        if not path.is_file():
            missing.append(f"{version}/{kind}/sample.pkl")
    assert not missing, (
        "Missing current-version cache fixtures:\n  "
        + "\n  ".join(missing)
        + "\n\nRegenerate with:\n  uv run python scripts/regen_cache_fixtures.py"
    )


# ---------------------------------------------------------------------------
# Layer 1: round-trip — synthesize a fresh value, pickle, unpickle,
# assert schema. Catches single-process serialization regressions.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", sorted(_KINDS))
def test_round_trip_per_kind(kind: str):
    """Build a synthetic value via the regen script's synthesizer,
    pickle/unpickle (the same wire format `GcsObjectStore` uses),
    assert schema. Catches custom `__reduce__` regressions and
    dataclass-field-reordering issues."""
    from scripts.regen_cache_fixtures import SYNTHESIZERS
    value = SYNTHESIZERS[kind]()
    blob = pickle.dumps((value, 12345.0), protocol=5)
    recovered_value, recovered_ts = pickle.loads(blob)
    assert recovered_ts == 12345.0
    SCHEMA_CHECKERS[kind](recovered_value)


# ---------------------------------------------------------------------------
# Layer 2: schema-shape on the committed current-version fixture.
# This is what the regen script writes; failure here means the
# committed bytes don't match the schema assertions any more.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kind", sorted(_KINDS))
def test_committed_current_version_fixture_matches_schema(kind: str):
    version = _CACHE_VERSIONS[kind]
    path = FIXTURE_ROOT / version / kind / "sample.pkl"
    if not path.is_file():
        pytest.fail(
            f"Fixture {path.relative_to(FIXTURE_ROOT.parent.parent)} is missing.\n"
            f"Regenerate with: uv run python scripts/regen_cache_fixtures.py --kind {kind}"
        )
    blob = path.read_bytes()
    value, _fetched_at = pickle.loads(blob)
    SCHEMA_CHECKERS[kind](value)


# ---------------------------------------------------------------------------
# Layer 3: cross-version canary. Walk every committed version directory
# and assert every kind's fixture unpickles + passes schema checks
# under TODAY'S reader. When this fails, the test message tells the
# developer exactly what to do — see tests/fixtures/cache/README.md.
# ---------------------------------------------------------------------------


def _enumerate_committed_fixtures() -> list[tuple[str, str, Path]]:
    """Yield `(version, kind, path)` for every `<version>/<kind>/sample.pkl`
    found under FIXTURE_ROOT. Skips the README and any unexpected files."""
    out: list[tuple[str, str, Path]] = []
    if not FIXTURE_ROOT.is_dir():
        return out
    for version_dir in sorted(FIXTURE_ROOT.iterdir()):
        if not version_dir.is_dir() or not version_dir.name.startswith("v"):
            continue
        for kind_dir in sorted(version_dir.iterdir()):
            if not kind_dir.is_dir():
                continue
            sample = kind_dir / "sample.pkl"
            if sample.is_file():
                out.append((version_dir.name, kind_dir.name, sample))
    return out


CANARY_REMEDIATION = """\
============================================================================
CACHE PICKLE CANARY FAILURE
============================================================================
The committed fixture at
    tests/fixtures/cache/{version}/{kind}/sample.pkl
either failed to unpickle or no longer matches the schema-shape
contract under today's code. This means a pod deployed with this
commit would also fail to read production L2 entries written under
version {version!r} of cache kind {kind!r}.

What to do:

  1. Read the underlying error above — it usually names the missing
     attribute, the dtype that changed, or the dataclass that lost a
     field.

  2. If the structural change is INTENTIONAL (you renamed a field,
     removed a column, etc.), bump the version:

       a. Open cave_data_viewer/api/services/object_store.py.
       b. Find `_CACHE_VERSIONS[{kind!r}]` and bump it from "{version}"
          to the next version (e.g. "v2", "v3", ...).
       c. Regenerate the fixture for the new version:
            uv run python scripts/regen_cache_fixtures.py --kind {kind}
       d. DO NOT delete tests/fixtures/cache/{version}/{kind}/sample.pkl.
          It stays committed so this canary continues to assert today's
          code can still handle that prior version (or, when {version!r}
          is retired, you'll remove it from _CACHE_VERSIONS AND from
          this directory in the same commit).
       e. Commit the version bump and the new fixture together.

  3. If the structural change is NOT intentional, revert it — that
     change is a regression that would break production rollout.

See tests/fixtures/cache/README.md for the full workflow.
============================================================================
"""


@pytest.mark.parametrize(
    "version,kind,path",
    _enumerate_committed_fixtures(),
    ids=lambda v: v if isinstance(v, str) else str(v),
)
def test_cross_version_canary(version: str, kind: str, path: Path):
    """For every committed fixture under `tests/fixtures/cache/v<N>/<kind>/`,
    assert today's code can still unpickle it AND it still satisfies the
    schema-shape contract. Failure here is the bite the canary is for —
    the failure message tells the developer exactly what to do.

    The test parametrizes over the filesystem at collection time, so
    adding a new version directory automatically picks it up.
    """
    if kind not in SCHEMA_CHECKERS:
        pytest.skip(
            f"No schema checker for kind {kind!r} (fixture under "
            f"{version}/{kind}/ has no matching SCHEMA_CHECKERS entry). "
            "Add one or remove the orphan fixture."
        )
    try:
        blob = path.read_bytes()
        value, _fetched_at = pickle.loads(blob)
    except Exception as exc:
        pytest.fail(
            f"Fixture unpickle failed: {type(exc).__name__}: {exc}\n\n"
            + CANARY_REMEDIATION.format(version=version, kind=kind)
        )
    try:
        SCHEMA_CHECKERS[kind](value)
    except (AssertionError, Exception) as exc:
        pytest.fail(
            f"Schema check failed: {type(exc).__name__}: {exc}\n\n"
            + CANARY_REMEDIATION.format(version=version, kind=kind)
        )
