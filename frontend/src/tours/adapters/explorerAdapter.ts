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
import { dump as yamlDump, JSON_SCHEMA, load as yamlLoad } from "js-yaml";

import type { ExplorerRecipe, ExplorerState } from "../../api/types";
import type { RecipeKindAdapter, RecipeDiffSummary } from "./types";
import { parseScopeBlock } from "../recipeFromYaml";

/** URL keys owned by the explorer adapter. applyToParams clears these
 *  before re-setting from the recipe, so a recipe with no `x` clears
 *  any previously-set `?x=` instead of leaving it dangling. Shared
 *  keys (`cells`, `dec`, `mv`, `ds`) are NOT in this list — they
 *  belong to navigation / cross-view continuity and are written
 *  identically by both adapters, so neither one stomps the other on
 *  apply. */
const EXPLORER_OWNED_KEYS = [
  "ft",
  "emb",
  "scope_mode",
  "sel_filters",
  "x",
  "y",
  "color",
  "size",
  "cmap",
  "color_min",
  "color_max",
  "color_center",
  "size_min",
  "size_max",
  "size_data_min",
  "size_data_max",
  "growth_space",
  "growth_variance",
  "growth_reduction",
  "growth_threshold",
  "growth_features",
  "growth_topn",
] as const;

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
    if (Array.isArray(meta?.extras?.selection) && (meta!.extras!.selection as unknown[]).length > 0) {
      return true;
    }
    for (const key of EXPLORER_OWNED_KEYS) {
      const v = params.get(key);
      if (v && v.length > 0) return true;
    }
    // Shared keys: `cells` and `dec` count as content too — a user
    // who's set up a scope filter on /explore should be able to save
    // it even with no other configuration touched.
    if (params.get("cells")) return true;
    if (params.get("dec")) return true;
    return false;
  },

  applyToParams(prev, recipe, applyExtras) {
    const next = new URLSearchParams(prev);
    for (const key of EXPLORER_OWNED_KEYS) next.delete(key);
    next.delete("cells");
    next.delete("dec");

    const s = recipe.explorer;
    setIfStr(next, "ft", s.ft);
    setIfStr(next, "emb", s.emb);
    if (s.decoration_tables && s.decoration_tables.length > 0) {
      next.set("dec", s.decoration_tables.join(","));
    }
    setIfStr(next, "cells", s.cells);
    setIfStr(next, "scope_mode", s.scope_mode);
    if (s.sel_filters && s.sel_filters.length > 0) {
      next.set("sel_filters", s.sel_filters.join(","));
    }
    setIfStr(next, "x", s.x);
    setIfStr(next, "y", s.y);
    setIfStr(next, "color", s.color);
    setIfStr(next, "size", s.size);
    setIfStr(next, "cmap", s.cmap);
    setIfNum(next, "color_min", s.color_min);
    setIfNum(next, "color_max", s.color_max);
    setIfNum(next, "color_center", s.color_center);
    setIfNum(next, "size_min", s.size_min);
    setIfNum(next, "size_max", s.size_max);
    setIfNum(next, "size_data_min", s.size_data_min);
    setIfNum(next, "size_data_max", s.size_data_max);
    setIfStr(next, "growth_space", s.growth_space);
    setIfNum(next, "growth_variance", s.growth_variance);
    setIfStr(next, "growth_reduction", s.growth_reduction);
    setIfNum(next, "growth_threshold", s.growth_threshold);
    if (s.growth_features && s.growth_features.length > 0) {
      next.set("growth_features", s.growth_features.join(","));
    }
    setIfNum(next, "growth_topn", s.growth_topn);

    // Hand the Selection bag back to the consumer via the extras
    // callback. URL-only consumers (no callback) simply don't
    // restore the bag — the URL state still lands correctly.
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
            ...(recipe.scope !== undefined ? { scope: recipe.scope } : {}),
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

function setIfStr(p: URLSearchParams, key: string, v: string | null | undefined) {
  if (typeof v === "string" && v.length > 0) p.set(key, v);
}

function setIfNum(p: URLSearchParams, key: string, v: number | null | undefined) {
  if (typeof v === "number" && Number.isFinite(v)) p.set(key, String(v));
}

function stateFromParams(params: URLSearchParams, selection: string[]): ExplorerState {
  const csv = (k: string): string[] => {
    const raw = params.get(k);
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  };
  const num = (k: string): number | null => {
    const raw = params.get(k);
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  };
  const str = (k: string): string | null => {
    const v = params.get(k);
    return v && v.length > 0 ? v : null;
  };
  const scopeRaw = str("scope_mode");
  return {
    ft: str("ft"),
    emb: str("emb"),
    decoration_tables: csv("dec"),
    cells: str("cells"),
    scope_mode: scopeRaw === "hide" || scopeRaw === "ghost" ? scopeRaw : null,
    sel_filters: csv("sel_filters"),
    x: str("x"),
    y: str("y"),
    color: str("color"),
    size: str("size"),
    cmap: str("cmap"),
    color_min: num("color_min"),
    color_max: num("color_max"),
    color_center: num("color_center"),
    size_min: num("size_min"),
    size_max: num("size_max"),
    size_data_min: num("size_data_min"),
    size_data_max: num("size_data_max"),
    growth_space: str("growth_space"),
    growth_variance: num("growth_variance"),
    growth_reduction: str("growth_reduction"),
    growth_threshold: num("growth_threshold"),
    growth_features: csv("growth_features"),
    growth_topn: num("growth_topn") !== null ? Math.trunc(num("growth_topn")!) : null,
    selection,
  };
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
  const state: ExplorerState = {};
  for (const key of [
    "ft",
    "emb",
    "cells",
    "scope_mode",
    "x",
    "y",
    "color",
    "size",
    "cmap",
    "growth_space",
    "growth_reduction",
  ] as const) {
    const v = explorer[key];
    if (typeof v === "string") (state as Record<string, unknown>)[key] = v;
  }
  for (const key of [
    "color_min",
    "color_max",
    "color_center",
    "size_min",
    "size_max",
    "size_data_min",
    "size_data_max",
    "growth_variance",
    "growth_threshold",
    "growth_topn",
  ] as const) {
    const v = explorer[key];
    if (typeof v === "number" && Number.isFinite(v)) (state as Record<string, unknown>)[key] = v;
  }
  for (const key of ["decoration_tables", "sel_filters", "growth_features", "selection"] as const) {
    const v = explorer[key];
    if (Array.isArray(v)) {
      (state as Record<string, unknown>)[key] = v.filter((x): x is string => typeof x === "string");
    }
  }
  // scope_mode is a string-typed enum — narrow further.
  if (state.scope_mode !== "ghost" && state.scope_mode !== "hide") {
    state.scope_mode = null;
  }

  const where = typeof parsed.id === "string" ? `recipe "${parsed.id}"` : meta.id;
  const scope = parseScopeBlock(parsed.scope, where);

  return {
    id,
    kind: "explorer",
    title,
    description:
      typeof parsed.description === "string"
        ? parsed.description
        : meta.description ?? null,
    explorer: state,
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** Parse a YAML body that may contain a list of recipes (the standard
 *  upload format) OR a single recipe object. Used internally by
 *  fromYaml; exported for the upload handler to share the same
 *  parser without re-implementing the wrapper unwrapping. */
export function parseExplorerYamlBody(text: string): unknown {
  return yamlLoad(text, { schema: JSON_SCHEMA });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
