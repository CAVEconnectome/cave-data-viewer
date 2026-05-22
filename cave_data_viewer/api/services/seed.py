"""Connectivity-seed-derived per-cell columns.

Given a seed neuron ``(ds, mat_version, root_id)`` and a list of
``cell_id``s drawn from a feature-table parquet, produce a per-cell
DataFrame of ``seed_*`` columns that join onto the embedding frame and
become bindable channels in the explorer's scatter:

- ``seed_is_partner`` (binary)
- ``seed_partner_dir`` (categorical: none/in/out/both)
- ``seed_n_syn_in`` / ``seed_n_syn_out`` / ``seed_net_syn``
- ``seed_is_self``
- One ``seed_<agg>_in`` + ``seed_<agg>_out`` pair per synapse-aggregation
  rule the datastack config defines (e.g. ``seed_mean_size_in``).

Cells whose ``cell_id`` doesn't resolve to a root_id (or whose root_id
is not in the seed's partners bundle) get ``0`` for binary/count
columns and ``"none"`` for the categorical direction. That's
informative absence, not missingness — the explorer scatter colors
"not connected to the seed" as a distinct class instead of a hole.

Cache reuse: this module instantiates ``NeuronQuery`` with the same
synapse-config knobs that ``/connectivity`` uses
(``synapse_columns`` / ``synapse_position_prefix`` /
``synapse_aggregation_rules``), so the cached synapse DataFrames are
shared with the connectivity viewer — the seed projection itself adds
only a couple of pandas joins on the hot path.
"""

from __future__ import annotations

import logging
from typing import Iterable

import pandas as pd

from .cell_id import cell_ids_to_root_ids
from .datastack_config import (
    DatastackConfig,
    aligned_volume_config_for,
    resolve_synapse_config,
)
from .neuron import NeuronQuery
from .timing import timer

logger = logging.getLogger("cdv.seed")


SEED_DIR_CATEGORIES = ("none", "in", "out", "both")


def _aggregation_rule_names(syn_cfg) -> list[str]:
    return list(syn_cfg.aggregation_rules.keys())


def _build_seed_nq(
    *,
    client,
    cfg: DatastackConfig,
    datastack: str,
    mat_version: int | str | None,
    seed_root_id: int,
) -> NeuronQuery:
    """Build the seed's NeuronQuery using the same synapse-config knobs the
    /connectivity endpoint uses, so the cached synapse DataFrames are shared.
    """
    av_cfg = aligned_volume_config_for(datastack, client)
    syn_cfg = resolve_synapse_config(av_cfg, cfg)
    return NeuronQuery(
        client,
        root_id=int(seed_root_id),
        datastack=datastack,
        mat_version=mat_version,
        synapse_aggregation_rules=syn_cfg.aggregation_rules_for_neuron_query(),
        synapse_columns=syn_cfg.merged_columns(),
        synapse_position_prefix=syn_cfg.position_prefix,
    )


def seed_columns(
    *,
    client_factory,
    cfg: DatastackConfig,
    datastack: str,
    mat_version: int | str | None,
    seed_root_id: int,
    cell_ids: Iterable[int | str],
) -> pd.DataFrame:
    """Project the seed's connectivity bundle into per-cell columns.

    Returns a DataFrame indexed by ``cell_id`` (int64), with one row per
    input cell_id. Columns:

    - ``seed_is_partner`` : 0/1
    - ``seed_partner_dir`` : Categorical (``none``/``in``/``out``/``both``)
    - ``seed_n_syn_in`` / ``seed_n_syn_out`` : int (synapse counts)
    - ``seed_<rule>_in`` / ``seed_<rule>_out`` : per datastack-configured
      synapse-aggregation rule — e.g. ``seed_mean_size_in``,
      ``seed_net_size_out``; float, NaN where that direction has no
      synapse with the partner.

    There is intentionally no ``seed_is_self`` column: marking the seed
    cell itself is a client-side overlay toggle (it knows the resolved
    seed cell_id directly), not a per-cell plot channel.

    Caller is expected to ``df.join(seed_columns(...), on='cell_id')``
    on the embedding frame.
    """
    cell_ids_int: list[int] = []
    for cid in cell_ids:
        try:
            cell_ids_int.append(int(cid))
        except (TypeError, ValueError):
            continue
    cell_ids_int = list(dict.fromkeys(cell_ids_int))  # preserve order, dedupe

    seed_root_id = int(seed_root_id)
    client = client_factory()
    nq = _build_seed_nq(
        client=client,
        cfg=cfg,
        datastack=datastack,
        mat_version=mat_version,
        seed_root_id=seed_root_id,
    )
    rule_names = list(nq.synapse_aggregation_rules.keys())

    # Resolve cell_ids -> root_ids. Universe-cached at materialized
    # mat_versions; cheap once warm.
    with timer("seed_resolve_cell_ids"):
        cell_to_root = cell_ids_to_root_ids(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=datastack,
            cell_ids=cell_ids_int,
        )

    # Pull both partner directions from the cached synapse bundles.
    # `partners_in()` / `partners_out()` hit the per-NQ synapse cache —
    # warm whenever the /connectivity endpoint has been touched for this
    # seed at this mat_version with the same synapse-config knobs.
    with timer("seed_partners_in"):
        pin = nq.partners_in()
    with timer("seed_partners_out"):
        pout = nq.partners_out()

    # Build per-direction lookups keyed on partner root_id. Empty frames
    # produce empty dicts so the downstream zip-over-cells loop stays
    # uniform.
    def _to_lookup(df: pd.DataFrame) -> dict[int, dict]:
        if df is None or df.empty:
            return {}
        return df.set_index(df["root_id"].astype("int64")).to_dict(orient="index")

    in_by_root = _to_lookup(pin)
    out_by_root = _to_lookup(pout)

    # Construct per-cell column arrays. Order matches `cell_ids_int` so
    # the resulting DataFrame can be joined back by index.
    is_partner: list[int] = []
    direction: list[str] = []
    n_syn_in: list[int] = []
    n_syn_out: list[int] = []
    rule_in: dict[str, list] = {name: [] for name in rule_names}
    rule_out: dict[str, list] = {name: [] for name in rule_names}

    with timer("seed_project_columns"):
        for cid in cell_ids_int:
            rid = cell_to_root.get(cid)
            if rid is None:
                is_partner.append(0)
                direction.append("none")
                n_syn_in.append(0)
                n_syn_out.append(0)
                for name in rule_names:
                    rule_in[name].append(float("nan"))
                    rule_out[name].append(float("nan"))
                continue

            rid_int = int(rid)
            if rid_int == seed_root_id:
                # The seed itself is not its own partner; expose 0 syn
                # counts so it doesn't contaminate distributions. The
                # scatter overlay marks the seed cell separately via the
                # client-side toggle.
                is_partner.append(0)
                direction.append("none")
                n_syn_in.append(0)
                n_syn_out.append(0)
                for name in rule_names:
                    rule_in[name].append(float("nan"))
                    rule_out[name].append(float("nan"))
                continue

            rec_in = in_by_root.get(rid_int)
            rec_out = out_by_root.get(rid_int)
            has_in = rec_in is not None
            has_out = rec_out is not None

            if has_in and has_out:
                direction.append("both")
            elif has_in:
                direction.append("in")
            elif has_out:
                direction.append("out")
            else:
                direction.append("none")

            is_partner.append(1 if (has_in or has_out) else 0)
            n_syn_in.append(int(rec_in["num_syn"]) if has_in else 0)
            n_syn_out.append(int(rec_out["num_syn"]) if has_out else 0)
            for name in rule_names:
                rule_in[name].append(
                    float(rec_in[name]) if (has_in and name in rec_in) else float("nan")
                )
                rule_out[name].append(
                    float(rec_out[name]) if (has_out and name in rec_out) else float("nan")
                )

    data: dict[str, list] = {
        "seed_is_partner": is_partner,
        "seed_partner_dir": pd.Categorical(
            direction, categories=list(SEED_DIR_CATEGORIES)
        ),
        "seed_n_syn_in": n_syn_in,
        "seed_n_syn_out": n_syn_out,
    }
    # Per-direction synapse-aggregation columns (e.g. `seed_net_size_in`,
    # `seed_net_size_out`). These are the directional variables — there
    # is intentionally NO single derived `out - in` column: "net" in
    # this project's vocabulary means a *summed* aggregation (e.g. net
    # synapse size = sum of `size`), not a difference. A user who wants
    # the difference can compute it from the two directional columns.
    for name in rule_names:
        data[f"seed_{name}_in"] = rule_in[name]
        data[f"seed_{name}_out"] = rule_out[name]

    return pd.DataFrame(
        data, index=pd.Index(cell_ids_int, name="cell_id", dtype="int64")
    )
