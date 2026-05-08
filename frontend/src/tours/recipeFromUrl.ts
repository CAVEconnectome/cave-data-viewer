/**
 * Inverse of `urlMint.ts`: read a URLSearchParams reflecting the current
 * workspace state and return a `Recipe` object suitable for storage in
 * localStorage or YAML emission.
 *
 * Recipes intentionally have no `mat_version` or `root` — they're
 * configuration overlays that re-bind to whatever cell is loaded at apply
 * time. The "latest mv" semantic is preserved by simply omitting `mv`;
 * the existing Workspace effect at Workspace.tsx:158-164 auto-defaults a
 * blank `mv` to the latest valid integer.
 *
 * Plot-id handling: panel ids in the URL are minted (`dyn-xxxxxx` or
 * `sum-<kind>-xxxxxx`); they're not stable across sessions and shouldn't
 * leak into a saved Recipe. We strip them and assign author-facing labels
 * (`plot-1`, `plot-2`, ...) for diff readability — they get re-minted
 * fresh by `applyTourConfigToParams` on apply.
 */
import type { Recipe, TourPlot, TourPlotBindings } from "../api/types";
import { parseVizParam, parsePlotsList, parseUnfilterList, vizParamKey } from "../plots/urlState";
import { parsePanelId } from "./urlMint";

export interface RecipeMeta {
  id: string;
  title: string;
  description?: string;
}

export function parseRecipeFromUrl(
  searchParams: URLSearchParams,
  meta: RecipeMeta,
): Recipe {
  const decoration_tables = csv(searchParams.get("dec"));
  const cells = searchParams.get("cells") || null;
  const hide = csv(searchParams.get("hide"));
  const show = csv(searchParams.get("show"));
  const coll = csv(searchParams.get("coll"));

  const panelIds = parsePlotsList(searchParams.get("plots"));
  const unfilteredIds = new Set(parseUnfilterList(searchParams.get("unfilter")));

  const plots: TourPlot[] = panelIds.map((panelId, i) => {
    const parsed = parsePanelId(panelId);
    const author_id = `plot-${i + 1}`;
    if (parsed.kind === "sum") {
      return {
        id: author_id,
        summary_kind: parsed.summaryKind ?? null,
        unfiltered: unfilteredIds.has(panelId) || undefined,
      };
    }
    const bindings = parseVizParam(searchParams.get(vizParamKey(panelId)));
    return {
      id: author_id,
      bindings: bindings as TourPlotBindings,
      unfiltered: unfilteredIds.has(panelId) || undefined,
    };
  });

  // Sanity check: warn if `cells` references a `<table>.<col>` whose table
  // isn't in `decoration_tables`. The apply path will silently fail to
  // resolve the column; better to surface this when the recipe is built.
  if (cells) {
    const referencedTables = new Set<string>();
    for (const clause of cells.split(",")) {
      const dotIdx = clause.indexOf(".");
      const colonIdx = clause.indexOf(":");
      if (dotIdx > 0 && (colonIdx < 0 || dotIdx < colonIdx)) {
        referencedTables.add(clause.slice(0, dotIdx));
      }
    }
    const decSet = new Set(decoration_tables);
    for (const t of referencedTables) {
      if (!decSet.has(t)) {
        // eslint-disable-next-line no-console
        console.warn(
          `parseRecipeFromUrl: cells filter references table "${t}" not in decoration_tables`,
        );
      }
    }
  }

  return {
    id: meta.id,
    title: meta.title,
    description: meta.description ?? null,
    decoration_tables,
    plots,
    cells,
    hide,
    show,
    coll,
  };
}

/** Whether a URL has any state worth saving as a recipe — at least one of
 *  the configuration keys is set. Used to disable the Save button before
 *  the user has built anything. */
export function urlHasRecipeContent(searchParams: URLSearchParams): boolean {
  for (const key of ["dec", "plots", "cells", "hide", "show", "coll"]) {
    const v = searchParams.get(key);
    if (v && v.length > 0) return true;
  }
  return false;
}

function csv(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
