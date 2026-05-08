"""Cell-id ↔ root-id lookup.

A cell id is a persistent identifier (typically a nucleus row id) that survives
proofreading splits/merges. Root ids do not. To go between them we follow the
pattern from `ceesem/cortical-tools` (common.py + microns_public.py):

  cell_id → root_id  (forward)
    Query a materialized view (`cell_id_lookup_view`) keyed on `id`.
    - In materialized mode the view's `pt_root_id` is what we want.
    - In live mode we resolve `pt_supervoxel_id` → current root via the
      chunkedgraph (the view itself doesn't update with edits).

  root_id → cell_id  (reverse)
    Query a `main_table` keyed on `pt_root_id`. Drop ambiguous rows where the
    root id appears more than once (those aren't safely a single cell id).
    Try `alt_tables` for any root ids the main table missed (split/merge edge
    cases the dataset operator chose to cover). Each alt table is expected to
    expose `pt_ref_root_id` + `target_id` columns; we rename to the main-table
    schema before merging.

Datastacks without these resources omit the config keys; the corresponding
endpoint refuses with 422 and the SPA hides the cell-id input.
"""

import datetime as _dt
import threading
from typing import Iterable

from cachetools import TTLCache

from .keys import is_live
from .query_runner import run_query
from .request_state import current_timestamp


# ----- caches -----------------------------------------------------------------
#
# `root_id → cell_id` is constant once known — a root id is a frozen identifier
# that points to whatever cell it pointed to when first observed. Cache keyed
# `(ds, root_id)`, very long TTL.
#
# `cell_id → root_id` materialized: stable per (ds, mat_version) — the mat
# version is a frozen snapshot. Long TTL.
#
# `cell_id → root_id` live: moves as proofreading lands. Short TTL is the
# mitigation; consumers that need authoritative current roots should pin to a
# mat version anyway.

_ROOT_TO_CELL_TTL = 7 * 24 * 3600       # 1 week
_CELL_TO_ROOT_MAT_TTL = 7 * 24 * 3600   # 1 week
_CELL_TO_ROOT_LIVE_TTL = 5 * 60         # 5 minutes

_root_to_cell: TTLCache = TTLCache(maxsize=100_000, ttl=_ROOT_TO_CELL_TTL)
_cell_to_root_mat: TTLCache = TTLCache(maxsize=100_000, ttl=_CELL_TO_ROOT_MAT_TTL)
_cell_to_root_live: TTLCache = TTLCache(maxsize=10_000, ttl=_CELL_TO_ROOT_LIVE_TTL)
_lock = threading.Lock()


def clear_caches() -> None:
    """Test/admin entry point. The TTLs are otherwise self-managing."""
    with _lock:
        _root_to_cell.clear()
        _cell_to_root_mat.clear()
        _cell_to_root_live.clear()


def cell_ids_to_root_ids(
    *,
    client,
    cfg,                          # DatastackConfig
    mat_version: int | str | None,
    datastack: str,
    cell_ids: Iterable[int],
) -> dict[int, int | None]:
    """Resolve cell ids → current root ids. Unmapped → None."""
    view = cfg.cell_id_lookup_view
    if not view:
        raise ValueError("This datastack has no cell_id_lookup_view configured.")
    cell_ids = [int(x) for x in cell_ids]
    if not cell_ids:
        return {}

    live = is_live(mat_version)
    cache = _cell_to_root_live if live else _cell_to_root_mat
    out: dict[int, int | None] = {}
    misses: list[int] = []
    with _lock:
        for cid in cell_ids:
            key = (datastack, cid) if live else (datastack, int(mat_version), cid)
            hit = cache.get(key, _SENTINEL)
            if hit is _SENTINEL:
                misses.append(cid)
            else:
                out[cid] = hit

    if not misses:
        return out

    # Materialized views don't support live_query (and the cell-id view is small
    # and stable per mat_version), so we always read at the pinned version.
    qf = client.materialize.views[view](id=misses)
    df = qf.query(split_positions=False)

    if live and not df.empty:
        # Live mode: the view's pt_root_id is at-mat-version; resolve supervoxels
        # to current roots via the chunkedgraph. Use the request's pinned
        # consistency timestamp so this lookup matches synapse / soma / decoration
        # reads done in the same request. Falls back to now() outside a request
        # context (e.g. tests calling this helper directly).
        ts = current_timestamp() or _dt.datetime.now(_dt.timezone.utc)
        sv_ids = df["pt_supervoxel_id"].astype("int64").tolist()
        roots = client.chunkedgraph.get_roots(sv_ids, timestamp=ts)
        df = df.assign(pt_root_id=roots)

    indexed = df.set_index("id") if not df.empty else df
    fresh: dict[int, int | None] = {}
    for cid in misses:
        if not df.empty and cid in indexed.index:
            r = indexed.at[cid, "pt_root_id"]
            fresh[cid] = int(r) if r and int(r) != 0 else None
        else:
            fresh[cid] = None

    # Populate caches. cell→root cache: short for live, long for mat.
    # Also opportunistically populate root→cell cache (it's always stable).
    with _lock:
        for cid, rid in fresh.items():
            key = (datastack, cid) if live else (datastack, int(mat_version), cid)
            cache[key] = rid
            if rid is not None:
                _root_to_cell[(datastack, rid)] = cid

    out.update(fresh)
    return out


_SENTINEL = object()
# NB: The cell-id caches above are also pre-populated as a side effect of the
# soma-table warmup in services/decoration.py — every single-soma row in the
# soma table is exactly a (root_id, cell_id) pair, and the soma fetch already
# scans the whole table for `num_soma` decoration. See
# `_populate_cell_id_caches_from_soma` there.


def root_ids_to_cell_ids(
    *,
    client,
    cfg,
    mat_version: int | str | None,
    datastack: str,
    root_ids: Iterable[int],
) -> dict[int, int | None]:
    """Resolve current root ids → cell ids. Unmapped or ambiguous → None.

    `root → cell` is invariant once known — we cache `(ds, root_id) → cell_id`
    with a long TTL regardless of mat_version. Even unmapped (None) results are
    cached: a root id that genuinely has no nucleus row stays that way.
    """
    main = cfg.root_id_lookup_main_table
    if not main:
        raise ValueError("This datastack has no root_id_lookup_main_table configured.")
    root_ids = [int(x) for x in root_ids if int(x) != 0]
    if not root_ids:
        return {}

    out: dict[int, int | None] = {}
    misses: list[int] = []
    with _lock:
        for rid in root_ids:
            hit = _root_to_cell.get((datastack, rid), _SENTINEL)
            if hit is _SENTINEL:
                misses.append(rid)
            else:
                out[rid] = hit

    if not misses:
        return out

    fresh: dict[int, int | None] = {rid: None for rid in misses}
    live = is_live(mat_version)
    # Pinned consistency timestamp from the request (live mode only).
    # See `services/request_state.py`. None outside a request context;
    # `run_query` falls back to `now()` in that case.
    pinned_ts = current_timestamp()

    # 1) Main table: pt_root_id → id. Drop rows where the same root appears
    #    multiple times — that's an ambiguous mapping; leave None.
    qf = client.materialize.tables[main](pt_root_id=misses)
    df = run_query(qf, live=live, timestamp=pinned_ts, split_positions=False)
    if not df.empty:
        df = df.drop_duplicates(subset="pt_root_id", keep=False)
        for _, row in df.iterrows():
            rid = int(row["pt_root_id"])
            if rid in fresh:
                fresh[rid] = int(row["id"])

    # 2) Alt tables for any root ids still unmapped. Schema rename matches the
    #    upstream pattern (pt_ref_root_id→pt_root_id, target_id→id).
    for alt in cfg.root_id_lookup_alt_tables:
        unmapped = [rid for rid, cid in fresh.items() if cid is None]
        if not unmapped:
            break
        try:
            qf = client.materialize.tables[alt](pt_ref_root_id=unmapped)
            df = run_query(qf, live=live, timestamp=pinned_ts, split_positions=False)
        except Exception:
            continue
        if df.empty:
            continue
        df = df.rename(columns={"pt_ref_root_id": "pt_root_id", "target_id": "id"})
        if "pt_root_id" not in df.columns or "id" not in df.columns:
            continue
        df = df.drop_duplicates(subset="pt_root_id", keep=False)
        for _, row in df.iterrows():
            rid = int(row["pt_root_id"])
            if rid in fresh and fresh[rid] is None:
                fresh[rid] = int(row["id"])

    # Populate caches. root→cell is forever-stable so we cache both successes
    # AND known-unmapped (None) — saves repeated misses for orphan root ids.
    # Also opportunistically populate cell→root_mat when materialized (the
    # mapping is stable per mat version).
    with _lock:
        for rid, cid in fresh.items():
            _root_to_cell[(datastack, rid)] = cid
            if cid is not None and not live:
                _cell_to_root_mat[(datastack, int(mat_version), cid)] = rid

    out.update(fresh)
    return out
