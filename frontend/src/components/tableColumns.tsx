/**
 * Shared bits for the rich-table widgets (PartnersTable, TableRowsView).
 *
 * Anything two-or-more grids need lives here:
 *   - column-kind inference (category / number / string)
 *   - per-column filter input widgets (dropdown / range / contains)
 *   - cell formatting
 *
 * Extending: a new kind goes here once and both widgets pick it up.
 */

import { useState, type MouseEvent } from "react";
import { classify, profileToFilterKind, type FilterKind } from "../plots/columns";

/**
 * Legacy alias — the new shared classifier (`plots/columns.ts`) returns
 * `FilterKind`. Re-exported as `ColumnKind` so existing imports compile
 * without churn.
 */
export type ColumnKind = FilterKind;

export function inferKind(col: string, rows: Record<string, unknown>[]): ColumnKind {
  return profileToFilterKind(classify(col, rows));
}

/**
 * Short display labels for column names whose canonical form is so long
 * it bullies the column wider than its data needs. Operator-curated
 * map — only applies to *known* names; everything else falls through
 * unchanged.
 *
 * Directional `_in` / `_out` suffixes (added by the unifier on the
 * Both tab) are matched against the bare stem, then re-appended on the
 * shortened name — so `median_dist_to_target_soma_out` shortens to
 * `dist_to_targ_out`.
 *
 * Companion principle for *table* names (where the operator chose the
 * name and we shouldn't second-guess): handled via CSS truncation on
 * the group-header span (see `.partners .group-label` in styles.css).
 * Together: the rename map covers what we control, CSS handles what
 * we don't.
 */
// Anatomy-independent column label overrides. Anatomy-specific overrides
// (currently only `radial_dist_root_soma`) live on the spatial provider's
// `meta().label_overrides` and layer on top via the `providerOverrides`
// param to `displayName`.
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  median_dist_to_target_soma: "dist_to_targ",
  num_soma: "soma",
};

const DIRECTIONAL_SUFFIXES = ["_in", "_out"] as const;

export function displayName(
  bare: string,
  providerOverrides?: Record<string, string>,
): string {
  const merged = providerOverrides
    ? { ...DISPLAY_NAME_OVERRIDES, ...providerOverrides }
    : DISPLAY_NAME_OVERRIDES;
  if (bare in merged) return merged[bare];
  for (const suffix of DIRECTIONAL_SUFFIXES) {
    if (bare.endsWith(suffix)) {
      const stem = bare.slice(0, -suffix.length);
      const short = merged[stem];
      if (short) return `${short}${suffix}`;
    }
  }
  return bare;
}

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Click-to-copy renderer for opaque-id cells (root_id, cell_id).
 *
 * Long int64 ids are tedious to select-and-copy by hand because their
 * monospace text spans multiple table columns visually and cell selection
 * easily overruns. A click writes the full id to the clipboard and shows
 * a brief "copied" indicator in place of the text. Falls back to displaying
 * the value untouched when navigator.clipboard is unavailable (older
 * browsers, file:// origins).
 */
export function CopyableId({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const display = formatCell(value);
  if (display === "") return null;

  const onCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(display);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API unavailable — leave the cell as plain text.
    }
  };

  return (
    <span
      className={`copyable-id${copied ? " copied" : ""}`}
      onClick={onCopy}
      title={copied ? "copied!" : "click to copy"}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCopy(e as unknown as MouseEvent);
        }
      }}
    >
      {copied ? "copied!" : display}
    </span>
  );
}

interface FilterInputProps {
  kind: ColumnKind;
  options?: string[];
  value: unknown;
  onChange: (next: unknown) => void;
}

export function FilterInput({ kind, options, value, onChange }: FilterInputProps) {
  if (kind === "category") {
    return (
      <select
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      >
        <option value="">all</option>
        {options?.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (kind === "number") {
    return <NumberRangeInput value={value} onChange={onChange} />;
  }
  return (
    <input
      type="text"
      placeholder="contains…"
      value={(value as string) ?? ""}
      onChange={(e) => onChange(e.target.value || undefined)}
    />
  );
}

/**
 * Single-input numeric filter that accepts terse range syntax. Examples:
 *   `5`        → ≥ 5
 *   `>5`       → > 5
 *   `<10` `≤10` → ≤ 10
 *   `=5`       → exactly 5
 *   `5-10` `5..10` → 5 ≤ x ≤ 10
 */
function NumberRangeInput({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const [text, setText] = useState(() => rangeToText(value));
  return (
    <input
      type="text"
      placeholder="e.g. 5  or  5-10"
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        if (next.trim() === "") {
          onChange(undefined);
          return;
        }
        const parsed = parseRange(next);
        if (parsed) onChange(parsed);
      }}
    />
  );
}

function rangeToText(v: unknown): string {
  if (!v || typeof v !== "object") return "";
  const { min, max } = v as { min?: number; max?: number };
  if (min !== undefined && max !== undefined) {
    return min === max ? `=${min}` : `${min}-${max}`;
  }
  if (min !== undefined) return `≥${min}`;
  if (max !== undefined) return `≤${max}`;
  return "";
}

/** Position columns (`*_position_x`, `*_position_y`, `*_position_z`) can
 *  only be filtered on the server via CAVE's `filter_spatial_dict` (a bbox
 *  of `[[x_min,y_min,z_min],[x_max,y_max,z_max]]`), not via per-axis range
 *  params. We don't surface a bbox UI yet, so per-axis filters degrade to
 *  client-side range filtering on whatever rows are loaded; we just don't
 *  push a misshapen `pt_position_x__gte=N` to CAVE that it would reject. */
const POSITION_COLUMN_PATTERN = /_position_[xyz]$/;

/**
 * Decide whether a column-filter value should be dispatched to the backend
 * for server-side narrowing, or kept entirely client-side. Used by the
 * per-table view's "server mode" — server-side filters narrow the whole
 * table; client-side filters narrow only the loaded slice.
 *
 * Category and number kinds are server-eligible *if* their column name
 * isn't a per-axis position component. CAVE supports `filter_in_dict`,
 * `filter_equal_dict`, and the `filter_*_dict` range operators on regular
 * data columns; spatial points need bbox dispatch which we don't expose yet.
 *
 * String kind is purely client-side: CAVE has no LIKE, and exposing
 * free-text regex via the SPA's filter input is risky.
 */
export function isServerEligibleColumn(col: string, kind: ColumnKind): boolean {
  if (POSITION_COLUMN_PATTERN.test(col)) return false;
  return kind === "category" || kind === "number";
}

/**
 * Translate a TanStack column filter value into URL query-param entries
 * matching the backend's `parse_filters` Django-suffix convention:
 *
 *   category, single value → `?col=value`
 *   number range:
 *     `=N`           → `?col=N`
 *     `min only`      → `?col__gte=min` (or `__gt` if exclusive — see below)
 *     `max only`      → `?col__lte=max`
 *     `min and max`   → `?col__gte=min&col__lte=max`
 *
 * Exclusivity (`>` vs `>=`) isn't captured by the local `{min, max}` shape
 * so we always emit the inclusive forms. The filter input syntax (`>5` vs
 * `≥5`) parses to the same `{min: 5}` upstream of this point — that's a
 * known imprecision we accept; the alternative would be threading exclusive
 * flags through every layer for a marginal UX gain.
 *
 * Returns an empty object for substring filters (kept client-side) and for
 * empty / null filter values (no narrowing).
 */
export function filterValueToParams(
  col: string,
  kind: ColumnKind,
  value: unknown,
): Record<string, string> {
  if (value === null || value === undefined || value === "") return {};
  if (kind === "category") {
    return { [col]: String(value) };
  }
  if (kind === "number") {
    const range = value as { min?: number; max?: number };
    if (range.min !== undefined && range.min === range.max) {
      // Exact-equal shape (`=5`): emit a plain equality so the backend
      // routes through filter_equal_dict, which is a faster CAVE path
      // than a range with min==max.
      return { [col]: String(range.min) };
    }
    const out: Record<string, string> = {};
    if (range.min !== undefined) out[`${col}__gte`] = String(range.min);
    if (range.max !== undefined) out[`${col}__lte`] = String(range.max);
    return out;
  }
  return {};
}

/**
 * Inverse of `filterValueToParams` — given a URL params object, recover the
 * TanStack filter value for one column. Returns `undefined` when no params
 * apply (so the caller can skip setting the filter).
 *
 * Handles the same shapes the encoder produces. Round-trips lossless for
 * categorical and inclusive-range numeric filters; substring filters never
 * round-trip because they don't go to the URL.
 */
export function filterValueFromParams(
  col: string,
  kind: ColumnKind,
  params: URLSearchParams,
): unknown {
  if (kind === "category") {
    const v = params.get(col);
    return v ?? undefined;
  }
  if (kind === "number") {
    const eq = params.get(col);
    const gte = params.get(`${col}__gte`);
    const lte = params.get(`${col}__lte`);
    if (eq !== null) {
      const n = Number(eq);
      if (Number.isFinite(n)) return { min: n, max: n };
    }
    const range: { min?: number; max?: number } = {};
    if (gte !== null) {
      const n = Number(gte);
      if (Number.isFinite(n)) range.min = n;
    }
    if (lte !== null) {
      const n = Number(lte);
      if (Number.isFinite(n)) range.max = n;
    }
    if (range.min !== undefined || range.max !== undefined) return range;
    return undefined;
  }
  return undefined;
}

function parseRange(s: string): { min?: number; max?: number } | null {
  const t = s.trim();
  // =5  →  exactly 5  (encoded as min=max so the existing range filter handles it)
  const eq = t.match(/^=\s*(-?\d+(?:\.\d+)?)$/);
  if (eq) {
    const n = Number(eq[1]);
    return { min: n, max: n };
  }
  const range = t.match(/^(-?\d+(?:\.\d+)?)\s*(?:-|\.\.|to)\s*(-?\d+(?:\.\d+)?)$/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const lt = t.match(/^[<≤]=?\s*(-?\d+(?:\.\d+)?)$/);
  if (lt) return { max: Number(lt[1]) };
  const gt = t.match(/^[>≥]=?\s*(-?\d+(?:\.\d+)?)$/);
  if (gt) return { min: Number(gt[1]) };
  if (/^-?\d+(\.\d+)?$/.test(t)) return { min: Number(t) };
  return null;
}
