import time
from types import SimpleNamespace
from typing import Any

import numpy as np
import pandas as pd

from ..caches import cache_key_with_config, query_cache, soma_summary_cache
from .keys import canonical_query_hash, is_live
from .query_runner import run_query
from .request_state import current_timestamp
from .timing import timer


DEFAULT_DESIRED_RESOLUTION = [1, 1, 1]

# Sentinel used when no provider is supplied to `connectivity_bundle` (e.g.
# tests that don't bother wiring one). `build_spatial_provider` resolves it
# to `NullSpatialProvider`, so the bundle still assembles cleanly with no
# spatial columns.
_NULL_SPATIAL_CFG = SimpleNamespace(provider="null", provider_module=None, params={})


class NeuronQuery:
    def __init__(
        self,
        client,
        root_id: int,
        *,
        datastack: str,
        mat_version: int | str | None,
        synapse_table: str | None = None,
        soma_table: str | None = None,
        soma_root_id_column: str = "pt_root_id",
        synapse_aggregation_rules: dict[str, dict] | None = None,
        synapse_columns: list[str] | None = None,
        synapse_position_prefix: str = "ctr_pt",
        desired_resolution: list[int] | None = None,
    ):
        self.client = client
        self.root_id = int(root_id)
        self.datastack = datastack
        self.mat_version = mat_version
        info = client.info.get_datastack_info()
        self.synapse_table = synapse_table or info.get("synapse_table")
        self.soma_table = soma_table or info.get("soma_table")
        self.soma_root_id_column = soma_root_id_column
        self.synapse_aggregation_rules = synapse_aggregation_rules or {}
        self.synapse_columns = synapse_columns
        self.synapse_position_prefix = synapse_position_prefix
        self.desired_resolution = desired_resolution or DEFAULT_DESIRED_RESOLUTION
        # Pinned consistency timestamp captured at NQ construction. For
        # live mode the endpoint pins `datetime.now(utc)` on `flask.g`
        # before instantiating NQ; we read it here so every CAVE call
        # this NQ makes uses the same point in time. None for
        # materialized mode (queries are implicitly consistent via
        # version number) and outside a request context (warmup, tests).
        self.timestamp_for_consistency = current_timestamp() if is_live(mat_version) else None
        # Legacy field — `df.attrs["timestamp"]` from the synapse query
        # that CAVE echoes back. Kept for backwards-compat in callers
        # that still read `timestamp_used`, but `timestamp_for_consistency`
        # is now the source of truth surfaced on the response payload.
        self.timestamp_used = None

    def _cache_key(self, kind: str, **extra: Any) -> str | None:
        if is_live(self.mat_version):
            return None
        # Every knob that affects the returned dataframe shape goes in the
        # key — synapse_columns drives the projection, position_prefix
        # drives the split-position column names, desired_resolution drives
        # the unit of the position values. Forgetting any one of these
        # silently serves a previous-request shape from cache.
        #
        # `cache_datastack` resolves any per-datastack alias (e.g.
        # `minnie65_public` → `minnie65_phase3_v1`) so two datastacks
        # backed by the same underlying data share one cache entry. The
        # actual CAVE call still uses `self.datastack`; only the key
        # changes.
        from .cache_lifecycle import cache_datastack
        payload = {"kind": kind, "ds": cache_datastack(self.datastack), "mv": self.mat_version,
                   "syn": self.synapse_table, "rid": self.root_id,
                   "cols": tuple(self.synapse_columns) if self.synapse_columns else None,
                   "pos_prefix": self.synapse_position_prefix,
                   "desired_res": tuple(self.desired_resolution),
                   **extra}
        return canonical_query_hash(payload)

    def _synapse_df(self, direction: str) -> pd.DataFrame:
        if self.synapse_table is None:
            raise ValueError("synapse_table is not configured for this datastack")
        key = self._cache_key("synapses", direction=direction)
        if key and key in query_cache:
            # Cache hits are timed separately so the difference between a
            # warm and cold neuron is visible in the per-request log line.
            with timer(f"synapse_cache_hit[{direction}]"):
                return query_cache[key]
        # L2 (GCS) check, materialized mode only — `_cache_key` returns None
        # for live mode, so live requests skip the L2 layer entirely. The
        # L2 hit promotes into L1 so subsequent requests on this pod are
        # fast L1 reads. Falls through to a CAVE fetch on miss / outage.
        # Resolve retention class once: synapse keys are SHA-1 hashes,
        # so the LayeredSwrCache resolver pattern doesn't apply — pick
        # the right partition explicitly here and thread to read/write.
        retention = self._retention_class()
        if key:
            df = self._try_synapse_l2(key, direction, retention)
            if df is not None:
                return df
        partner_col = "pre_pt_root_id" if direction == "post" else "post_pt_root_id"
        own_col = "post_pt_root_id" if direction == "post" else "pre_pt_root_id"
        qf = self.client.materialize.tables[self.synapse_table](**{own_col: self.root_id})
        query_kwargs: dict[str, Any] = {
            "split_positions": True,
            "desired_resolution": self.desired_resolution,
        }
        if self.synapse_columns is not None:
            query_kwargs["select_columns"] = self.synapse_columns
        with timer(f"synapse_query[{direction}]"):
            df = run_query(
                qf,
                live=is_live(self.mat_version),
                timestamp=self.timestamp_for_consistency,
                **query_kwargs,
            )
        df = df[df[partner_col] != 0].copy()
        df = df[df[partner_col] != self.root_id].copy()  # drop autapses
        if df.attrs.get("timestamp"):
            self.timestamp_used = str(df.attrs["timestamp"])
        if key:
            query_cache[key] = df
            self._publish_synapse_l2(key, df, retention)
        return df

    def _retention_class(self) -> str:
        """Resolve which L2 partition (`default` / `longlived`) this
        request's writes should land on. Live mode never reaches the L2
        layer (`_cache_key` returns None first), but we still default to
        `default` defensively for any unexpected path."""
        from flask import current_app
        from .cache_lifecycle import retention_class_for
        registry = current_app.extensions.get("dcv_longlived_registry")
        if registry is None:
            return "default"
        return retention_class_for(registry, self.datastack, self.mat_version)

    @staticmethod
    def _try_synapse_l2(key: str, direction: str, retention: str) -> pd.DataFrame | None:
        """L2 read for the synapse df. Returns the df (and populates L1)
        on a within-TTL hit; None on miss, expired entry, missing config,
        or any GCS error. The TTL gate uses `CACHE_QUERY_TTL_SECONDS`
        (the same TTL that bounds L1) so L2 entries past their effective
        freshness are treated as misses.

        `dcv_synapse_l2` is now a `dict[str, GcsObjectStore]` keyed by
        retention class; the caller resolves which class once per call
        and passes it through.
        """
        from flask import current_app
        l2 = current_app.extensions.get("dcv_synapse_l2")
        if not l2:
            return None
        store = l2.get(retention) or l2.get("default")
        if store is None:
            return None
        hit = store.get(key)
        if hit is None:
            return None
        value, fetched_at = hit
        ttl = current_app.config["CACHE_QUERY_TTL_SECONDS"]
        if time.time() - fetched_at > ttl:
            return None
        with timer(f"synapse_l2_hit[{direction}]"):
            query_cache[key] = value
            return value

    @staticmethod
    def _publish_synapse_l2(key: str, df: pd.DataFrame, retention: str) -> None:
        """Fire-and-forget L2 write. The dedicated `dcv_l2_writer`
        ThreadPoolExecutor doesn't share with `RevalidationExecutor` —
        synapse writes are idempotent (the CAVE result is immutable for
        a given materialized key), need no app context, and don't
        benefit from per-key dedup.

        Default-arg-capture every variable the closure references — the
        same late-binding rule the decoration revalidation closures
        follow.
        """
        from flask import current_app
        l2 = current_app.extensions.get("dcv_synapse_l2")
        executor = current_app.extensions.get("dcv_l2_writer")
        if not l2 or executor is None:
            return
        store = l2.get(retention) or l2.get("default")
        if store is None:
            return
        ts = time.time()

        def _write(_store=store, _key=key, _df=df, _ts=ts):
            _store.set(_key, _df, _ts)
        executor.submit(_write)

    def _aggregate(self, syn_df: pd.DataFrame, partner_col: str, *, timer_label: str | None = None) -> pd.DataFrame:
        if syn_df.empty:
            return pd.DataFrame(columns=["root_id", "num_syn"])
        # Timer wraps just the groupby + per-rule aggregation work, NOT
        # the synapse fetch (already tagged separately as
        # `synapse_query[*]` / `synapse_cache_hit[*]`). Caller passes
        # `timer_label` to tag per-direction cost cleanly without the
        # implicit-overlap problem the earlier wrap had.
        if timer_label is not None:
            with timer(timer_label):
                return self._aggregate_inner(syn_df, partner_col)
        return self._aggregate_inner(syn_df, partner_col)

    def _aggregate_inner(self, syn_df: pd.DataFrame, partner_col: str) -> pd.DataFrame:
        grp = syn_df.groupby(partner_col, sort=False)
        out = grp.size().to_frame("num_syn")
        for new_col, rule in self.synapse_aggregation_rules.items():
            out[new_col] = grp[rule["column"]].agg(rule["agg"])
        out = out.reset_index().rename(columns={partner_col: "root_id"})
        return out.sort_values("num_syn", ascending=False).reset_index(drop=True)

    def partners_out(self) -> pd.DataFrame:
        return self._aggregate(self._synapse_df("pre"), "post_pt_root_id", timer_label="aggregate_partners[out]")

    def partners_in(self) -> pd.DataFrame:
        return self._aggregate(self._synapse_df("post"), "pre_pt_root_id", timer_label="aggregate_partners[in]")

    def soma_summary(self) -> dict:
        # Cross-request cache keyed on the invariants — (datastack,
        # mat_version, root_id, soma_table) plus a hash of the response-
        # shaping config (desired_resolution drives position units;
        # soma_root_id_column drives the lookup column). Live mode keeps
        # `mat_version` in the key as the literal string "live" so the
        # cache short-circuits naturally without a separate live-mode
        # branch. Saves ~200-300ms per warm plot request (the single-row
        # soma fetch otherwise re-fires on every fresh NeuronQuery instance).
        from .cache_lifecycle import cache_datastack
        cache_key = cache_key_with_config(
            cache_datastack(self.datastack), self.mat_version, self.root_id, self.soma_table,
            config_bundle={
                "desired_resolution": list(self.desired_resolution),
                "soma_root_id_column": self.soma_root_id_column,
            },
        )
        cached = soma_summary_cache.get(cache_key)
        if cached is not None:
            with timer("soma_cache_hit"):
                return cached
        if self.soma_table is None:
            result = {"num_soma": 0, "soma_pt_position": None}
            soma_summary_cache[cache_key] = result
            return result
        try:
            qf = self.client.materialize.tables[self.soma_table](
                **{self.soma_root_id_column: self.root_id}
            )
            with timer("soma_query"):
                df = run_query(
                    qf,
                    live=is_live(self.mat_version),
                    timestamp=self.timestamp_for_consistency,
                    split_positions=False,
                    desired_resolution=self.desired_resolution,
                )
        except Exception:
            # Don't cache failures — transient CAVE errors shouldn't
            # poison a 30-min cache window. The next request retries.
            return {"num_soma": 0, "soma_pt_position": None}
        if df.empty:
            result = {"num_soma": 0, "soma_pt_position": None}
            soma_summary_cache[cache_key] = result
            return result
        pt_col = next((c for c in df.columns if c.endswith("pt_position")), None)
        soma_pt = None
        if pt_col is not None:
            value = df.iloc[0][pt_col]
            if hasattr(value, "tolist"):
                value = value.tolist()
            soma_pt = list(value) if value is not None else None
        result = {"num_soma": int(len(df)), "soma_pt_position": soma_pt}
        soma_summary_cache[cache_key] = result
        return result


import logging as _logging
_root_xlate_logger = _logging.getLogger("cdv.root_translation")


def suggest_current_root(
    client,
    root_id: int,
    *,
    mat_version: int | str | None,
) -> int | None:
    """Ask the chunkedgraph what root_id `root_id` maps to at the
    request's "current" timestamp.

    Timestamp resolution:
      - Live mode: the request's pinned consistency timestamp
        (`current_timestamp()`), so the suggestion shares the same point
        in time as every other CAVE call in this request.
      - Materialized mode: the version's frozen timestamp, derived from
        `client.materialize.get_versions_metadata()` via
        `services.datastack_config.version_timestamp`. The suggested
        root is what was canonical at that materialization.

    Returns:
      - A new int root_id when the chunkedgraph thinks the input has
        been split/merged into something else, or
      - The same `root_id` when nothing changed (caller treats this as
        no-op), or
      - `None` when the chunkedgraph call fails or no timestamp can be
        derived (caller skips the translation).
    """
    from .datastack_config import version_timestamp
    from .request_state import current_timestamp

    if is_live(mat_version):
        ts = current_timestamp()
    else:
        ts = version_timestamp(client, mat_version)
    if ts is None:
        _root_xlate_logger.info(
            "suggest_current_root(%s, mv=%s): no usable timestamp — skipped",
            root_id, mat_version,
        )
        return None
    try:
        with timer("suggest_latest_roots"):
            # Method name is plural in caveclient (`suggest_latest_roots`)
            # even though we pass a single root and get a single root back.
            # An earlier attempt called the singular spelling, which
            # silently AttributeError'd through the broad except below
            # and degraded the whole feature to a no-op for weeks.
            suggested = client.chunkedgraph.suggest_latest_roots(int(root_id), timestamp=ts)
    except Exception as exc:
        # Chunkedgraph hiccup, or root_id unknown — caller falls back to
        # serving an empty bundle on the original root, which is safer
        # than failing the whole request.
        _root_xlate_logger.warning(
            "suggest_current_root(%s, mv=%s, ts=%s): exception %s: %s",
            root_id, mat_version, ts, type(exc).__name__, exc,
        )
        return None
    _root_xlate_logger.info(
        "suggest_current_root(%s, mv=%s, ts=%s) -> %r (type=%s)",
        root_id, mat_version, ts, suggested, type(suggested).__name__,
    )
    if suggested is None:
        return None
    return int(suggested)


def _partner_soma_positions(
    spatial_provider, decoration_lookup: dict[int, dict[str, Any]],
) -> dict[int, list[float]]:
    """Filter `decoration_lookup` rows down to those the spatial provider
    classifies as real somas. The provider's predicate (default cortex impl
    returns the position when `pt_position` is a 3-tuple) lets a future
    cell-id table mix axon-only entries in without leaking them into
    soma-anchored spatial features."""
    out: dict[int, list[float]] = {}
    for rid, rec in decoration_lookup.items():
        pos = spatial_provider.soma_position_from_row(rec)
        if pos is not None:
            out[int(rid)] = pos
    return out


def _compute_median_dist_to_target_soma(
    *,
    nq: "NeuronQuery",
    partner_soma_positions: dict[int, list[float]],
    root_soma_position_nm: list[float] | None,
    need_in: bool,
    need_out: bool,
) -> tuple[dict[int, float], dict[int, float]]:
    """Plain 3D Euclidean distance from each connecting synapse to the
    *target* (postsynaptic) soma, median per partner. Lives outside the
    SpatialProvider because it doesn't depend on a spatial frame — it's
    raw point-to-point distance over CAVE-served positions.

    Output direction → target = partner; needs partner soma.
    Input  direction → target = root;    needs root soma; partner soma optional.

    Distances come back in micrometers (the bundle's emitted unit). One
    vectorized norm + a pandas groupby-median per direction.
    """
    nm_per_um = 1000.0
    median_in: dict[int, float] = {}
    median_out: dict[int, float] = {}

    if need_in and root_soma_position_nm is not None:
        median_in = _median_partner_dist(
            syn_df=nq._synapse_df("post"),
            partner_root_id_column="pre_pt_root_id",
            syn_position_prefix=nq.synapse_position_prefix,
            target_soma_for=lambda _pid, _root=root_soma_position_nm: _root,
        )
        median_in = {rid: v / nm_per_um for rid, v in median_in.items()}

    if need_out and partner_soma_positions:
        median_out = _median_partner_dist(
            syn_df=nq._synapse_df("pre"),
            partner_root_id_column="post_pt_root_id",
            syn_position_prefix=nq.synapse_position_prefix,
            target_soma_for=lambda pid, _lookup=partner_soma_positions: _lookup.get(pid),
        )
        median_out = {rid: v / nm_per_um for rid, v in median_out.items()}

    return median_in, median_out


def _median_partner_dist(
    *,
    syn_df: pd.DataFrame,
    partner_root_id_column: str,
    syn_position_prefix: str,
    target_soma_for,
) -> dict[int, float]:
    """One vectorized norm over all synapse rows + a pandas groupby-median.
    Constant-target case (inputs) and per-partner-target case (outputs)
    share this single code path; the latter just builds a per-row target
    array via a one-time partner→soma map. Distances stay in input units
    (nm); the caller divides to µm."""
    if syn_df is None or syn_df.empty:
        return {}
    pos_cols = [f"{syn_position_prefix}_position_{a}" for a in ("x", "y", "z")]
    if any(c not in syn_df.columns for c in pos_cols):
        return {}

    partner_col_int = syn_df[partner_root_id_column].astype("int64")
    target_arrays: dict[int, np.ndarray] = {}
    for p in partner_col_int.unique():
        t = target_soma_for(int(p))
        if t is not None:
            target_arrays[int(p)] = np.asarray(t, dtype=float)
    if not target_arrays:
        return {}

    valid_mask = partner_col_int.isin(target_arrays.keys()).to_numpy()
    if not valid_mask.any():
        return {}
    sub_partner_col = partner_col_int.to_numpy()[valid_mask]
    sub_pts = syn_df.loc[valid_mask, pos_cols].to_numpy(dtype=float)
    targets = np.stack([target_arrays[int(p)] for p in sub_partner_col])
    dists = np.linalg.norm(sub_pts - targets, axis=1)

    return (
        pd.Series(dists, index=sub_partner_col)
        .groupby(level=0, sort=False)
        .median()
        .to_dict()
    )


def connectivity_bundle(
    nq: NeuronQuery,
    *,
    include: list[str] | None = None,
    decoration_tables: list[str] | None = None,
    client_factory=None,
    spatial_provider=None,
) -> dict:
    include = set(include or ["partners_in", "partners_out", "summary"])
    # All root_id values cross the wire as JSON strings: int64 root ids overflow
    # JavaScript's Number (float64; precise up to 2^53). The frontend keeps them
    # as strings throughout; the backend converts back via int() at the body
    # boundary. Same rule applies inside aggregated partner records below.
    payload: dict[str, Any] = {
        "datastack": nq.datastack,
        "root_id": str(nq.root_id),
        "version_used": nq.mat_version if not is_live(nq.mat_version) else "live",
        "synapse_table": nq.synapse_table,
        "soma_table": nq.soma_table,
    }
    need_in = "partners_in" in include or "summary" in include
    need_out = "partners_out" in include or "summary" in include
    # `partners_in()` / `partners_out()` time their own `_aggregate` step
    # internally as `aggregate_partners[in/out]` — synapse_query[*] and
    # the groupby are tagged separately so the breakdown is additive.
    pin = nq.partners_in() if need_in else None
    pout = nq.partners_out() if need_out else None

    decoration_lookup: dict[int, dict] = {}
    decoration_groups: list[dict] = []
    revalidation: dict[str, Any] | None = None
    if nq.soma_table or (decoration_tables or []):
        if client_factory is None:
            raise ValueError("connectivity_bundle requires client_factory when enriching")
        from .decoration import lookup_decorations
        # The lookup itself is timed; per-table CAVE round-trips inside
        # are tagged separately as decoration_query[<table>] (see
        # decoration.py).
        # Only enrich partners that will actually be in the response —
        # plus the queried root, which the SPA's "Cell" tab renders as a
        # standalone row alongside the partner tabs. Including the root
        # in this single lookup means the per-partner enrichment + the
        # root enrichment share one CAVE round-trip per decoration table.
        partner_ids: list[int] = []
        if pin is not None and "partners_in" in include:
            partner_ids.extend(int(x) for x in pin["root_id"].tolist())
        if pout is not None and "partners_out" in include:
            partner_ids.extend(int(x) for x in pout["root_id"].tolist())
        partner_ids = list(dict.fromkeys(partner_ids))  # preserve order, dedupe
        # Root included AFTER partners so it doesn't perturb the order
        # the partner enrichment iterates in. `dict.fromkeys` deduplicates
        # if the root happens to also appear as a partner (self-loop).
        decoration_ids = list(dict.fromkeys([*partner_ids, int(nq.root_id)]))
        if decoration_ids:
            with timer("lookup_decorations"):
                decoration_lookup, decoration_groups, revalidation = lookup_decorations(
                    client_factory=client_factory,
                    ds=nq.datastack,
                    mat_version=nq.mat_version,
                    soma_table=nq.soma_table,
                    soma_root_id_column=nq.soma_root_id_column,
                    root_ids=decoration_ids,
                    decoration_tables=decoration_tables or [],
                )

    # Spatial features split into three tiers:
    #
    # 1. `median_dist_to_target_soma` — plain 3D Euclidean over CAVE soma
    #    positions. Doesn't depend on a spatial frame, so it's computed here
    #    directly (kept out of the SpatialProvider contract).
    # 2. Provider-emitted features — partner-intrinsic + per-direction +
    #    summary panels, all driven by the SpatialProvider. The bundle
    #    iterates `provider.feature_manifest()` to enrich partner records
    #    and register column groups.
    # 3. The queried-root's own intrinsic features go onto `root_record`.
    from .spatial import (
        CachedSpatialFeatures,
        build_spatial_provider,
        compute_spatial_features_cached,
    )
    if spatial_provider is None:
        spatial_provider = build_spatial_provider(_NULL_SPATIAL_CFG)

    spatial_features: CachedSpatialFeatures = CachedSpatialFeatures.empty()
    median_dist_in: dict[int, float] = {}
    median_dist_out: dict[int, float] = {}

    if decoration_lookup:
        # `nq.soma_summary()` is cross-request cached, so the call is cheap.
        # Root soma seeds both the intrinsic-feature cache (so the SPA's Cell
        # tab gets intrinsic features even when only plot endpoints ran first)
        # and the input-direction `median_dist_to_target_soma` (target = root).
        root_soma = nq.soma_summary().get("soma_pt_position")
        partner_soma_positions = _partner_soma_positions(spatial_provider, decoration_lookup)
        median_dist_in, median_dist_out = _compute_median_dist_to_target_soma(
            nq=nq,
            partner_soma_positions=partner_soma_positions,
            root_soma_position_nm=root_soma,
            need_in=need_in, need_out=need_out,
        )
        spatial_features = compute_spatial_features_cached(
            nq=nq,
            provider=spatial_provider,
            decoration_lookup=decoration_lookup,
            root_soma_position_nm=root_soma,
        )

    # `spatial_meta` carries the SPA-facing axis-role / label-override /
    # summary-kind metadata so generic SPA components don't hardcode the
    # cortex column vocabulary. `summary_panels` is the typed list of
    # per-cell visualizations the provider emits; the SPA dispatches by
    # `kind`.
    payload["spatial_meta"] = spatial_provider.meta()
    payload["summary_panels"] = [
        {"kind": panel.kind, "data": panel.data}
        for panel in spatial_features.summary_panels
    ]

    manifest = list(spatial_provider.feature_manifest())
    intrinsic_specs = [s for s in manifest if s.scope == "partner_intrinsic"]
    per_direction_specs = [s for s in manifest if s.scope == "partner_per_direction"]

    def _enrich_records(df, direction: str):
        if df is None:
            return None
        per_direction = (
            spatial_features.per_direction_in if direction == "in"
            else spatial_features.per_direction_out
        )
        median_dist_lookup = (
            median_dist_in if direction == "in" else median_dist_out
        )
        records = df.to_dict(orient="records")
        for rec in records:
            rid = int(rec["root_id"])
            extra = decoration_lookup.get(rid)
            if extra:
                rec.update(extra)
            intrinsic_extra = spatial_features.intrinsic.get(rid)
            if intrinsic_extra:
                for spec in intrinsic_specs:
                    if spec.name in intrinsic_extra:
                        rec[spec.name] = intrinsic_extra[spec.name]
            for spec in per_direction_specs:
                lookup = per_direction.get(spec.name)
                if lookup and rid in lookup:
                    rec[spec.name] = lookup[rid]
            if rid in median_dist_lookup:
                rec["median_dist_to_target_soma"] = median_dist_lookup[rid]
            # `pt_position` is internal scaffolding for the spatial computation;
            # strip it so the wire payload stays tight and the SPA doesn't see
            # a column it has no place to render.
            rec.pop("pt_position", None)
            # Stringify after the int-keyed decoration lookup, so the wire
            # payload preserves int64 precision for the JS client.
            rec["root_id"] = str(rid)
        return records

    # `_enrich_records` is the per-partner Python loop that merges the
    # decoration + spatial dicts onto each partner row. Currently O(n)
    # over the partner count with a small constant factor; suspect of
    # hidden cost on heavily-connected neurons. Timed separately per
    # direction to surface a per-direction asymmetry if one exists.
    if "partners_in" in include and pin is not None:
        with timer("enrich_records[in]"):
            payload["partners_in"] = _enrich_records(pin, "in")
    if "partners_out" in include and pout is not None:
        with timer("enrich_records[out]"):
            payload["partners_out"] = _enrich_records(pout, "out")

    # The queried cell, shaped as a single partner-record so the SPA's
    # "Cell" tab can reuse PartnersTable's column rendering. Synapse
    # columns and per-edge stats don't apply here — they're per-partner
    # by construction. We include the cell-type / soma decoration and
    # intrinsic spatial features so the tab reads as a place to find
    # "what does CAVE know about this specific cell." `radial_dist_root_soma`
    # for the root would be 0 by definition (distance from itself), so
    # we drop it as noise.
    root_rid = int(nq.root_id)
    root_rec: dict[str, Any] = {"root_id": str(root_rid)}
    extra = decoration_lookup.get(root_rid)
    if extra:
        root_rec.update(extra)
    spatial_self = spatial_features.intrinsic.get(root_rid)
    if spatial_self:
        for spec in intrinsic_specs:
            if spec.role == "radial":
                continue  # zero by construction for the queried cell
            if spec.name in spatial_self:
                root_rec[spec.name] = spatial_self[spec.name]
    root_rec.pop("pt_position", None)
    payload["root_record"] = root_rec
    if "summary" in include:
        soma = nq.soma_summary()
        payload["summary"] = {
            "num_partners_in": int(pin.shape[0]) if pin is not None else None,
            "num_partners_out": int(pout.shape[0]) if pout is not None else None,
            "num_syn_in": int(nq._synapse_df("post").shape[0]),
            "num_syn_out": int(nq._synapse_df("pre").shape[0]),
            **soma,
        }
    # Prefer the pinned consistency timestamp when set (live mode); fall
    # back to the legacy CAVE-echoed value (df.attrs["timestamp"]) for
    # materialized mode where pinning is implicit via version number.
    if nq.timestamp_for_consistency is not None:
        payload["timestamp_used"] = nq.timestamp_for_consistency.isoformat()
    else:
        payload["timestamp_used"] = nq.timestamp_used
    payload["synapse_columns_meta"] = {
        "aggregation_rules": [
            {"name": k, **v} for k, v in nq.synapse_aggregation_rules.items()
        ],
        "synapse_table": nq.synapse_table,
    }

    # column_groups drives the SPA's two-row table header. Order matters: it's
    # the left-to-right column order. Each group has `kind` (intrinsic, synapse,
    # soma, cell_type, table, spatial) so the frontend can style them per-class.
    synapse_cols = ["num_syn"] + list(nq.synapse_aggregation_rules.keys())
    # Direction-specific stats live in the synapse group so the Both-tab
    # unifier splits each into `_in` / `_out` alongside num_syn / mean_size.
    # `median_dist_to_target_soma` is plain Euclidean (computed in this
    # module, not via the spatial provider); per-direction provider features
    # come from the manifest below.
    if median_dist_in or median_dist_out:
        synapse_cols.append("median_dist_to_target_soma")
    for spec in per_direction_specs:
        in_present = bool(spatial_features.per_direction_in.get(spec.name))
        out_present = bool(spatial_features.per_direction_out.get(spec.name))
        if in_present or out_present:
            synapse_cols.append(spec.name)
    column_groups = [
        {"name": "id",      "kind": "intrinsic", "columns": ["root_id"]},
        {"name": "synapse", "kind": "synapse",   "columns": synapse_cols},
        *decoration_groups,
    ]
    if spatial_features.intrinsic:
        # Partner-intrinsic spatial columns: same value for both directions,
        # so the unifier passes them through unchanged. Sample one record
        # to discover which manifest entries actually materialized (e.g.
        # `radial_dist_root_soma` is omitted when no root soma is present).
        sample_rec = next(iter(spatial_features.intrinsic.values()))
        intrinsic_spatial_cols = [
            spec.name for spec in intrinsic_specs if spec.name in sample_rec
        ]
        if intrinsic_spatial_cols:
            column_groups.append({
                "name": "spatial",
                "kind": "spatial",
                "columns": intrinsic_spatial_cols,
            })
    payload["column_groups"] = column_groups

    payload["decoration_revalidation"] = revalidation
    return payload
