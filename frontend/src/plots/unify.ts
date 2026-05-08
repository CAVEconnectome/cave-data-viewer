/**
 * Shared unification helpers — used by both the partners-table "Both" tab
 * and the dynamic plot panel, so the same column vocabulary is available
 * in both places without two parallel implementations.
 *
 * The unified row schema:
 *   - one row per unique partner root_id
 *   - `num_syn` → `n_syn_out` + `n_syn_in` (0 when the partner only
 *     appears in the other direction)
 *   - each `synapse_aggregation_rules` column → `<name>_out` + `<name>_in`
 *     (null in the missing direction; null is honest where 0 would be
 *     fabricated for averages)
 *   - decoration / soma / cell_type / spatial columns merge per root_id
 *     (deterministic; values agree across directions)
 *
 * The backend exposes the same shape via the `partners_both` data source
 * (see `services/plots.py::_build_unified_frame`); the SPA computes it
 * client-side here for table display.
 */

import type { ColumnGroup, PartnerRecord } from "../api/types";

/**
 * Names of synapse-group columns that need to split _in / _out under
 * unification. Driven off the backend's actual `column_groups[synapse]`
 * minus `num_syn` (which becomes `n_syn_out` + `n_syn_in`).
 */
export function directionalColumnNames(groups: ColumnGroup[]): string[] {
  const synapseGroup = groups.find((g) => g.kind === "synapse");
  if (!synapseGroup) return [];
  return synapseGroup.columns.filter((c) => c !== "num_syn");
}

export function unifyPartners(
  partnersOut: PartnerRecord[],
  partnersIn: PartnerRecord[],
  directional: string[],
): PartnerRecord[] {
  const byRoot = new Map<string, PartnerRecord>();

  for (const r of partnersOut) {
    const merged: PartnerRecord = {
      ...r,
      n_syn_out: r.num_syn ?? 0,
      n_syn_in: 0,
    };
    for (const name of directional) {
      merged[`${name}_out`] = r[name] ?? null;
      merged[`${name}_in`] = null;
    }
    byRoot.set(r.root_id, merged);
  }
  for (const r of partnersIn) {
    const existing = byRoot.get(r.root_id);
    if (existing) {
      existing.n_syn_in = r.num_syn ?? 0;
      for (const name of directional) {
        existing[`${name}_in`] = r[name] ?? null;
      }
      // Backfill any decoration / soma / cell_type fields the in-row carries
      // that the out-row didn't (defensive — values are per-root_id, so they
      // should agree, but missing fields would otherwise silently disappear).
      for (const [k, v] of Object.entries(r)) {
        if (k === "num_syn" || k === "root_id") continue;
        if (directional.includes(k)) continue;
        if (existing[k] === undefined) existing[k] = v;
      }
    } else {
      const merged: PartnerRecord = {
        ...r,
        n_syn_out: 0,
        n_syn_in: r.num_syn ?? 0,
      };
      for (const name of directional) {
        merged[`${name}_out`] = null;
        merged[`${name}_in`] = r[name] ?? null;
      }
      byRoot.set(r.root_id, merged);
    }
  }
  // Strip the directional source columns — they're replaced by the _in / _out
  // pairs and would only confuse downstream classifiers.
  for (const rec of byRoot.values()) {
    delete rec.num_syn;
    for (const name of directional) {
      delete rec[name];
    }
  }
  return [...byRoot.values()];
}

export function unifyColumnGroups(
  groups: ColumnGroup[],
  directional: string[],
): ColumnGroup[] {
  const synapseColumns: string[] = ["n_syn_out", "n_syn_in"];
  for (const name of directional) {
    synapseColumns.push(`${name}_out`);
    synapseColumns.push(`${name}_in`);
  }
  return groups.map((g) =>
    g.kind === "synapse" ? { ...g, columns: synapseColumns } : g,
  );
}
