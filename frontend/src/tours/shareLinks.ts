/**
 * URL builders for the Share menu.
 *
 *   buildQueryLink()                                 — exact current view
 *   buildRecipeLink(searchParams, stripKeys, ...)    — recipe overlay
 *
 * "Recipe link" deliberately omits per-kind navigation keys so the
 * recipe applies cleanly into a fresh workspace. Each ShareMenu
 * supplies the strip lists appropriate to its kind:
 *
 *   - Connectivity: strip `mv`, `root`, `from`, plus the `sel_`
 *     prefix (panel-id-keyed brushing state that doesn't belong in
 *     an overlay configuration).
 *   - Explorer: strip `mv`, `from`, `table` (drawer open/close). The
 *     explorer's `sel_filters` is part of the recipe state itself
 *     (active column-filter chips); it's NOT a per-panel selection
 *     and should NOT be stripped.
 */

export function buildQueryLink(): string {
  return window.location.href;
}

export function buildRecipeLink(
  searchParams: URLSearchParams,
  stripKeys: readonly string[],
  stripPrefixes: readonly string[],
  base?: string,
): string {
  const next = new URLSearchParams(searchParams);
  for (const key of stripKeys) next.delete(key);
  if (stripPrefixes.length > 0) {
    for (const key of [...next.keys()]) {
      if (stripPrefixes.some((p) => key.startsWith(p))) next.delete(key);
    }
  }
  const origin = base ?? `${window.location.origin}${window.location.pathname}`;
  const qs = next.toString();
  return qs ? `${origin}?${qs}` : origin;
}

/** Default strip list for connectivity ShareMenu. Exported so the
 *  per-kind share menus stay declarative — each just imports the
 *  constant rather than hand-typing keys at the call site. */
export const CONNECTIVITY_RECIPE_STRIP_KEYS = ["mv", "root", "from"] as const;
export const CONNECTIVITY_RECIPE_STRIP_PREFIXES = ["sel_"] as const;

export const EXPLORER_RECIPE_STRIP_KEYS = ["mv", "from", "table"] as const;
export const EXPLORER_RECIPE_STRIP_PREFIXES: readonly string[] = [];
