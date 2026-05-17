/**
 * Hook that returns the set of recipe kinds applicable to the current
 * route. Drives Sidebar's per-route filtering and LandingPage's
 * (which shows everything but tags each card with its kind chip).
 *
 * Centralizing the policy here keeps each view unaware of recipe
 * kinds — the view declares its route, the hook decides what kinds
 * apply. Adding a new view + kind = update this map; consumers
 * don't change.
 */
import { useLocation } from "react-router-dom";

import type { RecipeKind } from "../api/types";

const ROUTE_TO_KINDS: Record<string, RecipeKind[]> = {
  "/neuron": ["connectivity"],
  "/explore": ["explorer"],
  // Landing shows both — the page renders a kind chip per card so the
  // user can tell which view a recipe opens in.
  "/": ["connectivity", "explorer"],
};

export function useApplicableRecipeKinds(): Set<RecipeKind> {
  const { pathname } = useLocation();
  const kinds = ROUTE_TO_KINDS[pathname] ?? [];
  return new Set(kinds);
}
