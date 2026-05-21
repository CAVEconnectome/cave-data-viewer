/**
 * Module-level state for the Feature Explorer's Selection bag.
 *
 * The bag lifted out of FeatureExplorer's local component state so the
 * global Sidebar's ExplorerShareMenu can read it. The bag is NOT in URL
 * state — large lassos overflow Node's 8KB request-line cap on page
 * refresh (HTTP 431) — and was previously stuck inside FeatureExplorer.
 *
 * Behavior change vs the old useState: the bag now PERSISTS across
 * route navigation (/explore → /neuron → /explore preserves the
 * selection). Component-state would have reset to [] on each remount.
 * The new behavior matches user expectation: hopping between views to
 * cross-check a partner shouldn't destroy a curated lasso.
 *
 * Pattern mirrors `personalRecipes.ts` — event-based subscription with
 * a hook that reads the singleton.
 */
import { useEffect, useState } from "react";

let _bag: string[] = [];
const EVENT = "cdv:explorer-selection-changed";

export function getExplorerSelection(): string[] {
  return _bag;
}

export function setExplorerSelection(
  next: string[] | ((prev: string[]) => string[]),
): void {
  _bag = typeof next === "function" ? next(_bag) : next;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeExplorerSelection(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Drop-in replacement for `useState<string[]>([])` in FeatureExplorer.
 *  Returns the same `[bag, setBag]` tuple shape; supports both direct
 *  values and updater functions so existing call sites work unchanged. */
export function useExplorerSelection(): [
  string[],
  (next: string[] | ((prev: string[]) => string[])) => void,
] {
  const [bag, setBag] = useState(() => getExplorerSelection());
  useEffect(
    () => subscribeExplorerSelection(() => setBag(getExplorerSelection())),
    [],
  );
  return [bag, setExplorerSelection];
}
