/**
 * Connectivity-kind adapter — façade over the existing helpers in
 * `recipeFromUrl.ts`, `urlMint.ts`, `recipeYaml.ts`. No logic moves
 * here; the wrapping exists so consumers can dispatch on
 * `recipe.kind` without an `if (kind === 'connectivity')` branch at
 * every call site.
 *
 * The connectivity recipe's payload is identical to what ships
 * today: decoration_tables, plots, cells, hide/show/coll. There are
 * no extras — connectivity state all lives in the URL.
 */
import type { ConnectivityRecipe, TourPlot, TourPlotBindings } from "../../api/types";
import {
  applyRecipeToParams,
  buildRecipeOpenParams,
  diffRecipe,
} from "../urlMint";
import { parseRecipeFromUrl, urlHasRecipeContent } from "../recipeFromUrl";
import { recipeToYaml } from "../recipeYaml";
import { parseScopeBlock } from "../recipeFromYaml";
import type { RecipeKindAdapter, RecipeDiffSummary } from "./types";

export const connectivityAdapter: RecipeKindAdapter<ConnectivityRecipe> = {
  kind: "connectivity",
  openRoute: "/neuron",

  parseFromUrl(params, meta) {
    return parseRecipeFromUrl(params, meta);
  },

  urlHasContent(params) {
    return urlHasRecipeContent(params);
  },

  applyToParams(prev, recipe) {
    return applyRecipeToParams(prev, recipe);
  },

  buildOpenParams(ds, recipe, mv) {
    return buildRecipeOpenParams(ds, recipe, mv);
  },

  hasNavContext(prev) {
    // Connectivity recipes apply onto a loaded neuron. Without a
    // root id the apply has nothing to overlay onto — useApplyRecipe
    // routes through the Open path instead.
    return Boolean(prev.get("root"));
  },

  toYaml(recipe) {
    return recipeToYaml(recipe);
  },

  fromYaml(parsed, meta) {
    return coerceConnectivityFromYaml(parsed, meta);
  },

  diff(prev, recipe): RecipeDiffSummary {
    const d = diffRecipe(prev, recipe);
    const lines: string[] = [];
    if (d.decorationsAdded.length)
      lines.push(`+${d.decorationsAdded.length} decoration table(s)`);
    if (d.decorationsRemoved.length)
      lines.push(`−${d.decorationsRemoved.length} decoration table(s)`);
    if (d.panelsBefore !== d.panelsAfter)
      lines.push(`panels: ${d.panelsBefore} → ${d.panelsAfter}`);
    if (d.cellsChanged) lines.push("cells filter changed");
    if (d.hideChanged) lines.push("column visibility changed");
    const headline =
      lines.length === 0
        ? "No changes from current state"
        : `${lines.length} change${lines.length === 1 ? "" : "s"} to apply`;
    return { headline, lines };
  },
};

/** Coerce a parsed YAML mapping into a ConnectivityRecipe. Permissive
 *  — missing optional fields default to empty. Returns null when the
 *  shape is fundamentally wrong (not an object, missing id/title,
 *  or carrying connectivity-incompatible keys). */
export function coerceConnectivityFromYaml(
  parsed: unknown,
  meta: { id: string; title?: string; description?: string },
): ConnectivityRecipe | null {
  if (!isObject(parsed)) return null;
  const id = typeof parsed.id === "string" ? parsed.id : meta.id;
  const title =
    typeof parsed.title === "string" ? parsed.title : meta.title ?? id;
  const where = typeof parsed.id === "string" ? `recipe "${parsed.id}"` : meta.id;
  const scope = parseScopeBlock(parsed.scope, where);
  return {
    id,
    kind: "connectivity",
    title,
    description:
      typeof parsed.description === "string"
        ? parsed.description
        : meta.description ?? null,
    decoration_tables: arrOfStrings(parsed.decoration_tables),
    plots: coercePlots(parsed.plots),
    cells: typeof parsed.cells === "string" ? parsed.cells : null,
    hide: arrOfStrings(parsed.hide),
    show: arrOfStrings(parsed.show),
    coll: arrOfStrings(parsed.coll),
    ...(scope !== undefined ? { scope } : {}),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arrOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function coercePlots(v: unknown): TourPlot[] {
  if (!Array.isArray(v)) return [];
  const out: TourPlot[] = [];
  for (const item of v) {
    if (!isObject(item)) continue;
    const plot: TourPlot = {};
    if (typeof item.id === "string") plot.id = item.id;
    if (typeof item.summary_kind === "string") plot.summary_kind = item.summary_kind;
    if (isObject(item.bindings)) plot.bindings = item.bindings as TourPlotBindings;
    if (typeof item.unfiltered === "boolean") plot.unfiltered = item.unfiltered;
    out.push(plot);
  }
  return out;
}
