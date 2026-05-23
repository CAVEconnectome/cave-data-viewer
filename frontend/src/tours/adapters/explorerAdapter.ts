/**
 * Explorer-kind adapter.
 *
 * Bridges /explore's URL params + the in-memory Selection bag to/from
 * an `ExplorerRecipe`. Most fields round-trip the URL one-for-one;
 * `selection` is the cell_id bag that doesn't fit in the URL — it
 * lives in component state in FeatureExplorer and threads through
 * `RecipeMeta.extras` here.
 *
 * Extras contract:
 * - `selection: string[]` — Selection bag at save time. Empty
 *   ([]) means "no selection saved." Absent (no key in extras)
 *   means "saving from a context where the bag isn't available";
 *   the resulting recipe carries an empty selection.
 * - `applyExtras` callback receives `{ selection: string[] }` at
 *   apply time so the consumer (FeatureExplorer or its router) can
 *   push the bag back into component state. Adapters that don't
 *   supply the callback get URL-only restoration; the Selection
 *   bag is simply not restored.
 *
 * YAML format mirrors the backend's nested-block layout: top-level
 * `kind: explorer` plus an `explorer:` sub-mapping holding the
 * ExplorerState. js-yaml is used (rather than the hand-rolled
 * connectivity emitter) because the nested + many-numeric-fields
 * shape is well outside the emitter's tractable range.
 */
import { dump as yamlDump, JSON_SCHEMA } from "js-yaml";

import type { ExplorerRecipe, ExplorerState } from "../../api/types";
import type { RecipeKindAdapter, RecipeDiffSummary } from "./types";

/**
 * Single source of truth for the explorer recipe's fields. `applyToParams`
 * (URL write), `stateFromParams` (URL read), `coerceExplorerFromYaml` (YAML
 * import) and `urlHasContent` all derive from this table — adding an
 * explorer field is one line here, not four hand-synced lists.
 *
 * `url` omitted: the field has no URL representation (`selection` rides in
 * RecipeMeta.extras instead). `dec` and `cells` are shared navigation keys
 * written by both adapters; they're listed so the explorer round-trips
 * them, but they aren't explorer-exclusive.
 */
type FieldKind = "str" | "num" | "int" | "csv";

interface ExplorerField {
  state: keyof ExplorerState;
  url?: string;
  kind: FieldKind;
  /** Closed enum for a "str" field — values outside the set read back as null. */
  enumValues?: readonly string[];
}

const EXPLORER_FIELDS: readonly ExplorerField[] = [
  { state: "ft", url: "ft", kind: "str" },
  { state: "emb", url: "emb", kind: "str" },
  { state: "decoration_tables", url: "dec", kind: "csv" },
  { state: "cells", url: "cells", kind: "str" },
  { state: "scope_mode", url: "scope_mode", kind: "str", enumValues: ["hide", "ghost"] },
  { state: "sel_filters", url: "sel_filters", kind: "csv" },
  { state: "x", url: "x", kind: "str" },
  { state: "y", url: "y", kind: "str" },
  { state: "color", url: "color", kind: "str" },
  { state: "size", url: "size", kind: "str" },
  { state: "cmap", url: "cmap", kind: "str" },
  { state: "color_min", url: "color_min", kind: "num" },
  { state: "color_max", url: "color_max", kind: "num" },
  { state: "color_center", url: "color_center", kind: "num" },
  { state: "size_min", url: "size_min", kind: "num" },
  { state: "size_max", url: "size_max", kind: "num" },
  { state: "size_data_min", url: "size_data_min", kind: "num" },
  { state: "size_data_max", url: "size_data_max", kind: "num" },
  { state: "growth_space", url: "growth_space", kind: "str" },
  { state: "growth_variance", url: "growth_variance", kind: "num" },
  { state: "growth_reduction", url: "growth_reduction", kind: "str" },
  { state: "growth_threshold", url: "growth_threshold", kind: "num" },
  { state: "growth_features", url: "growth_features", kind: "csv" },
  { state: "growth_topn", url: "growth_topn", kind: "int" },
  { state: "selection", kind: "csv" },
];

export const explorerAdapter: RecipeKindAdapter<ExplorerRecipe> = {
  kind: "explorer",
  openRoute: "/explore",

  parseFromUrl(params, meta) {
    const extras = meta.extras ?? {};
    const selection = Array.isArray(extras.selection)
      ? (extras.selection.filter((x) => typeof x === "string") as string[])
      : [];
    return {
      id: meta.id,
      title: meta.title,
      description: meta.description ?? null,
      kind: "explorer",
      explorer: stateFromParams(params, selection),
    };
  },

  urlHasContent(params, meta) {
    const sel = meta?.extras?.selection;
    if (Array.isArray(sel) && sel.length > 0) return true;
    for (const f of EXPLORER_FIELDS) {
      if (!f.url) continue;
      const v = params.get(f.url);
      if (v && v.length > 0) return true;
    }
    return false;
  },

  applyToParams(prev, recipe, applyExtras) {
    const next = new URLSearchParams(prev);
    // Clear every owned/shared key first so a recipe with no `x` clears a
    // dangling `?x=` instead of leaving it. Shared keys (`dec`, `cells`)
    // are re-set below from the recipe, so clearing them is safe.
    for (const f of EXPLORER_FIELDS) {
      if (f.url) next.delete(f.url);
    }
    const s = recipe.explorer;
    for (const f of EXPLORER_FIELDS) {
      if (f.url) writeField(next, f.url, f.kind, s[f.state]);
    }
    // Hand the Selection bag back to the consumer via the extras
    // callback. URL-only consumers (no callback) simply don't restore
    // the bag — the URL state still lands correctly.
    if (applyExtras && s.selection && s.selection.length > 0) {
      applyExtras({ selection: s.selection });
    }
    return next;
  },

  buildOpenParams(ds, recipe, mv) {
    const params = new URLSearchParams();
    params.set("ds", ds);
    if (mv) params.set("mv", mv);
    return explorerAdapter.applyToParams(params, recipe);
  },

  hasNavContext(prev) {
    // Explorer doesn't require a loaded neuron — `?ds=` is the only
    // navigation precondition. The route's pickers (feature table +
    // embedding) come from the recipe itself.
    return Boolean(prev.get("ds"));
  },

  toYaml(recipe) {
    // NOTE: Only fields meaningful for re-import are listed here. Server-set
    // metadata (version, tags, saved_at) is intentionally omitted from YAML
    // export — if you add a new user-facing field to ExplorerRecipe, add it
    // to this object too or it will silently drop on download.
    return yamlDump(
      {
        recipes: [
          {
            id: recipe.id,
            kind: recipe.kind,
            title: recipe.title,
            description: recipe.description ?? undefined,
            explorer: stripUndefined(recipe.explorer as Record<string, unknown>),
          },
        ],
      },
      { schema: JSON_SCHEMA, sortKeys: false, lineWidth: 120 },
    );
  },

  fromYaml(parsed, meta) {
    return coerceExplorerFromYaml(parsed, meta);
  },

  diff(prev, recipe): RecipeDiffSummary {
    const lines: string[] = [];
    const s = recipe.explorer;

    const prevDec = (prev.get("dec") ?? "").split(",").filter(Boolean);
    const nextDec = s.decoration_tables ?? [];
    const decAdded = nextDec.filter((d) => !prevDec.includes(d)).length;
    const decRemoved = prevDec.filter((d) => !nextDec.includes(d)).length;
    if (decAdded) lines.push(`+${decAdded} decoration table(s)`);
    if (decRemoved) lines.push(`−${decRemoved} decoration table(s)`);

    const scatterKeys = ["x", "y", "color", "size", "cmap"] as const;
    const scatterChanged = scatterKeys.filter(
      (k) => (prev.get(k) ?? "") !== ((s[k] as string | null | undefined) ?? ""),
    ).length;
    if (scatterChanged) lines.push(`${scatterChanged} scatter binding(s) changed`);

    const growthChanged = ["growth_space", "growth_reduction", "growth_threshold", "growth_topn"]
      .some((k) => (prev.get(k) ?? "") !== String(((s as Record<string, unknown>)[k] ?? "")));
    if (growthChanged) lines.push("growth settings changed");

    if ((prev.get("cells") ?? "") !== (s.cells ?? "")) lines.push("cells filter changed");

    const selN = (s.selection ?? []).length;
    if (selN > 0) lines.push(`restore selection (${selN} cell${selN === 1 ? "" : "s"})`);

    const headline =
      lines.length === 0
        ? "No changes from current state"
        : `${lines.length} change${lines.length === 1 ? "" : "s"} to apply`;
    return { headline, lines };
  },
};

/** Write one field's value into a URLSearchParams, skipping empty/invalid
 *  values so the URL stays clean. */
function writeField(p: URLSearchParams, key: string, kind: FieldKind, v: unknown): void {
  switch (kind) {
    case "str":
      if (typeof v === "string" && v.length > 0) p.set(key, v);
      break;
    case "num":
    case "int":
      if (typeof v === "number" && Number.isFinite(v)) p.set(key, String(v));
      break;
    case "csv":
      if (Array.isArray(v) && v.length > 0) {
        const items = (v as unknown[]).filter((x): x is string => typeof x === "string");
        if (items.length > 0) p.set(key, items.join(","));
      }
      break;
  }
}

/** Read one field's value from a URLSearchParams, normalized to the field's
 *  kind. Missing/invalid scalars → null; missing csv → []. */
function readField(params: URLSearchParams, f: ExplorerField): string | number | string[] | null {
  const raw = f.url ? params.get(f.url) : null;
  switch (f.kind) {
    case "str":
      if (!raw) return null;
      if (f.enumValues && !f.enumValues.includes(raw)) return null;
      return raw;
    case "num": {
      if (!raw) return null;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "int": {
      if (!raw) return null;
      const n = parseFloat(raw);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case "csv":
      return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
}

/** Coerce one field's value out of a parsed YAML mapping. Returns undefined
 *  when the runtime shape disagrees with the field's kind (the field is
 *  then dropped — tolerant import; server-side PUT does the strict check). */
function coerceYamlField(
  kind: FieldKind,
  enumValues: readonly string[] | undefined,
  v: unknown,
): string | number | string[] | undefined {
  switch (kind) {
    case "str":
      if (typeof v !== "string") return undefined;
      if (enumValues && !enumValues.includes(v)) return undefined;
      return v;
    case "num":
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    case "int":
      return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
    case "csv":
      return Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : undefined;
  }
}

function stateFromParams(params: URLSearchParams, selection: string[]): ExplorerState {
  const state: Record<string, unknown> = {};
  for (const f of EXPLORER_FIELDS) {
    if (!f.url) continue;
    state[f.state] = readField(params, f);
  }
  state.selection = selection;
  return state as ExplorerState;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function coerceExplorerFromYaml(
  parsed: unknown,
  meta: { id: string; title?: string; description?: string },
): ExplorerRecipe | null {
  if (!isObject(parsed)) return null;
  const id = typeof parsed.id === "string" ? parsed.id : meta.id;
  const title =
    typeof parsed.title === "string" ? parsed.title : meta.title ?? id;
  const explorer = isObject(parsed.explorer) ? parsed.explorer : {};

  // Tolerant coercion — drop any field whose runtime shape disagrees
  // with the type. The upload UI flags the recipe overall; per-field
  // policing happens server-side at PUT time.
  const state: Record<string, unknown> = {};
  for (const f of EXPLORER_FIELDS) {
    const coerced = coerceYamlField(f.kind, f.enumValues, explorer[f.state]);
    if (coerced !== undefined) state[f.state] = coerced;
  }

  return {
    id,
    kind: "explorer",
    title,
    description:
      typeof parsed.description === "string"
        ? parsed.description
        : meta.description ?? null,
    explorer: state as ExplorerState,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
