import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Recipe } from "../api/types";
import { applyRecipeToParams, diffRecipe, type RecipeDiff } from "./urlMint";

/**
 * Shared apply-recipe flow used by both the LandingPage RecipeCard and
 * the sidebar Recipes widget. Computes the diff, confirms with the user,
 * and navigates to the resulting URL.
 *
 * Confirmation uses `window.confirm` for v1. The plan accepted "replace
 * with confirmation" without specifying a component flavor; a native
 * confirm avoids a toast dependency and renders crisp summaries of the
 * change. Substitute a richer dialog component later if desired without
 * changing the caller surface.
 *
 * Returns a function that takes a recipe and applies it. The function
 * is a no-op (logs nothing, navigates nowhere) when no cell is loaded;
 * callers should disable their CTA in that case rather than rely on this
 * silently failing.
 */
export function useApplyRecipe(): (recipe: Recipe) => void {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  return useCallback(
    (recipe: Recipe) => {
      // Read the current URL fresh — searchParams is React state but the URL
      // is the source of truth. Either works here, but reading from state
      // keeps the diff stable against any in-flight URL updates.
      const prev = new URLSearchParams(searchParams);
      // Recipes overlay onto a loaded cell. Without ?root= there's nothing
      // to overlay onto; bail rather than navigating to a half-configured
      // workspace. Callers should already be disabling their button.
      if (!prev.get("root")) return;
      const next = applyRecipeToParams(prev, recipe);
      const diff = diffRecipe(prev, recipe);
      const summary = formatDiff(diff);
      if (summary && !window.confirm(`Apply recipe "${recipe.title}"?\n\n${summary}`)) {
        return;
      }
      navigate(`/neuron?${next.toString()}`);
    },
    [navigate, searchParams],
  );
}

function formatDiff(d: RecipeDiff): string {
  const lines: string[] = [];
  if (d.decorationsAdded.length > 0) {
    lines.push(`+ decorations: ${d.decorationsAdded.join(", ")}`);
  }
  if (d.decorationsRemoved.length > 0) {
    lines.push(`− decorations: ${d.decorationsRemoved.join(", ")}`);
  }
  if (d.panelsAfter !== d.panelsBefore) {
    lines.push(`plots: ${d.panelsBefore} → ${d.panelsAfter}`);
  } else if (d.panelsAfter > 0) {
    lines.push(`replacing ${d.panelsAfter} plot${d.panelsAfter === 1 ? "" : "s"}`);
  }
  if (d.cellsChanged) lines.push("cell filter changes");
  if (d.hideChanged) lines.push("column visibility changes");
  return lines.join("\n");
}
