/**
 * URL builders for the Share menu.
 *
 *   buildQueryLink()                       — exact current view (mv + root)
 *   buildRecipeLink(searchParams, origin)  — recipe overlay (no mv/root/from/sel_*)
 *
 * "Recipe link" deliberately omits `mv` so the existing blank-mv → latest
 * defaulting in Workspace.tsx kicks in at apply time. Operator recipes do
 * the same; this matches their semantics.
 */

const NAV_KEYS_TO_STRIP = ["mv", "root", "from"];

export function buildQueryLink(): string {
  return window.location.href;
}

export function buildRecipeLink(searchParams: URLSearchParams, base?: string): string {
  const next = new URLSearchParams(searchParams);
  for (const key of NAV_KEYS_TO_STRIP) next.delete(key);
  // sel_* keys reference panel ids that are valid in the current session
  // but encode brushing state, which doesn't belong in a recipe overlay
  // (it's per-cell selection state, not configuration).
  for (const key of [...next.keys()]) {
    if (key.startsWith("sel_")) next.delete(key);
  }
  const origin = base ?? `${window.location.origin}${window.location.pathname}`;
  const qs = next.toString();
  return qs ? `${origin}?${qs}` : origin;
}
