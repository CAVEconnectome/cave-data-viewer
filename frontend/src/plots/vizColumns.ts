/**
 * Compatibility shim over `columns.ts` — preserved so existing callers in
 * `AnalyticsRail` (column-bound plots) keep working without churn while the
 * dynamic plot panel takes the richer API.
 *
 * New code should import from `columns.ts` directly.
 */

import type { ColumnGroup } from "../api/types";
import { CATEGORICAL_MAX_CARDINALITY, classify } from "./columns";

export const BAR_MAX_CARDINALITY = CATEGORICAL_MAX_CARDINALITY;

export type VizKind = "bar" | "histogram" | "exclude";

export function classifyColumn(
  rows: Record<string, unknown>[],
  col: string,
): VizKind {
  const profile = classify(col, rows);
  if (profile.isIdShaped || profile.vocabulary === "string") return "exclude";
  if (profile.vocabulary === "continuous-numeric") return "histogram";
  // discrete-numeric, categorical-palette, categorical-greyscale → bar.
  return "bar";
}

export interface ColumnChoice {
  group: string;
  key: string;
  display: string;
  kind: "bar" | "histogram";
}

export function listVizColumns(
  rows: Record<string, unknown>[],
  groups: ColumnGroup[],
): ColumnChoice[] {
  const choices: ColumnChoice[] = [];
  for (const g of groups) {
    if (g.kind === "intrinsic") continue;
    for (const col of g.columns) {
      const kind = classifyColumn(rows, col);
      if (kind === "exclude") continue;
      const display = col.includes(".") ? col.slice(col.indexOf(".") + 1) : col;
      choices.push({ group: g.name, key: col, display, kind });
    }
  }
  return choices;
}
