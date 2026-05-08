/**
 * Per-datastack "current view" persistence. The URL is the source of truth
 * for an active workspace; this module mirrors the overlay portion of that
 * URL (decoration tables, plots + bindings, cell filter, column visibility)
 * into localStorage so the user's configured view survives:
 *
 *   - Cross-navigation that drops overlay — most notably, table-row clicks
 *     into /neuron land at `?ds=&mv=&root=` with no overlay params. Without
 *     this, the user's decorations and plots are lost on every cross-nav.
 *   - Cross-session reloads — closing the browser and reopening picks up
 *     where the user left off.
 *   - Per-datastack switches — each datastack carries its own baseline,
 *     because recipes reference datastack-bound table names.
 *
 * The rule: the last-changed overlay on a datastack is the default for the
 * next /neuron view of that datastack. Save runs continuously; restore only
 * fires on a fresh entry where overlay is absent — never overwrites an
 * active view. A `(ds, root)` ref guard distinguishes "user just navigated
 * here via an entry path that dropped overlay" (restore baseline) from
 * "user just cleared all overlay on the current cell" (save the empty
 * baseline so the cleared state survives cross-nav).
 *
 * Storage shape (per-datastack key, JSON-encoded):
 *
 *     cdv:v1:session_recipe:<datastack>  →  { version: 1, recipe: Recipe | null }
 *
 * `recipe: null` is an explicit "user cleared everything" signal — distinct
 * from "no entry yet". Per-datastack keys (rather than a single byDs map)
 * keep each save atomic and avoid read-merge-write contention with other
 * tabs.
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { Recipe } from "../api/types";
import { applyTourConfigToParams } from "./urlMint";
import { parseRecipeFromUrl, urlHasRecipeContent } from "./recipeFromUrl";

const KEY_PREFIX = "cdv:v1:session_recipe:";

interface StoredEntry {
  version: 1;
  recipe: Recipe | null;
}

function storageKey(ds: string): string {
  return `${KEY_PREFIX}${ds}`;
}

/**
 * Read the saved session recipe for a datastack. Null when nothing's saved
 * yet, when the user explicitly cleared (saved-null), or when JSON / shape
 * validation fails. Callers treat null and a content-less recipe identically
 * — both mean "don't restore anything."
 */
export function loadSessionRecipe(ds: string): Recipe | null {
  if (!ds) return null;
  try {
    const raw = localStorage.getItem(storageKey(ds));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      (parsed.recipe === null ||
        (parsed.recipe && typeof parsed.recipe === "object"))
    ) {
      return (parsed.recipe ?? null) as Recipe | null;
    }
    return null;
  } catch {
    // Quota / private-mode / malformed JSON — treat as no entry.
    return null;
  }
}

/**
 * Persist the current overlay for a datastack. `null` records an explicit
 * empty baseline (user cleared everything) so the next restore is a no-op
 * rather than resurrecting an earlier saved state.
 */
export function saveSessionRecipe(ds: string, recipe: Recipe | null): void {
  if (!ds) return;
  try {
    const entry: StoredEntry = { version: 1, recipe };
    localStorage.setItem(storageKey(ds), JSON.stringify(entry));
  } catch {
    // Storage failure is non-fatal — the URL is still authoritative for the
    // current view; only cross-navigation persistence degrades.
  }
}

function recipeHasContent(r: Recipe | null): boolean {
  if (!r) return false;
  return (
    r.decoration_tables.length > 0 ||
    r.plots.length > 0 ||
    !!r.cells ||
    r.hide.length > 0 ||
    r.show.length > 0 ||
    r.coll.length > 0
  );
}

// Synthetic meta values for parseRecipeFromUrl — the Recipe type requires
// id/title/description but session recipes are private state, never displayed
// or referenced by id; these labels exist only to satisfy the type and aid
// debugging if someone inspects localStorage.
const SESSION_META = {
  id: "session",
  title: "Session view",
};

/**
 * Wire the per-datastack save/restore behavior into a /neuron page mount.
 * Place a single call near the top of NeuronView; the hook owns all URL
 * observation and localStorage I/O.
 *
 *   Save:    whenever `ds` is set and the URL has overlay content, snapshot
 *            the URL into the per-datastack storage key. Save fires
 *            regardless of whether `root` is set — overlay configuration is
 *            datastack-scoped, not cell-scoped.
 *
 *   Restore: when `ds` changes (fresh mount, cross-nav, or datastack switch)
 *            and the URL has no overlay AND a non-empty saved recipe exists,
 *            apply it via `applyTourConfigToParams` and rewrite the URL with
 *            `replace: true`. Tracking `lastDsRef` (not the prior ds+root
 *            pair) is what makes the datastack-picker case work: the picker
 *            clears `root` along with everything else, so a (ds, root)
 *            pair-key would never see "new ds" without also waiting for a
 *            cell to be picked.
 *
 *   Empty:   when `ds` is the same as last seen but the URL no longer has
 *            overlay content, save `null` so the cleared state survives the
 *            next cross-nav.
 *
 * Save and restore are mutually exclusive on any single URL state, so the
 * hook can't loop on itself: restore only fires on overlay-empty URLs;
 * overlay-empty URLs without a non-empty saved baseline don't write
 * anything that would change the URL.
 */
export function useSessionRecipe(): void {
  const [params, setParams] = useSearchParams();
  const lastDsRef = useRef<string | null>(null);

  useEffect(() => {
    const ds = params.get("ds");
    if (!ds) return;

    const dsChanged = lastDsRef.current !== ds;
    lastDsRef.current = ds;

    if (urlHasRecipeContent(params)) {
      // Capture current overlay — covers both fresh entry via overlay-
      // preserving paths (Apply, landing Open) and in-place edits. A
      // shared link landing with `?ds=B&dec=foo` lands here too: the URL
      // wins over a saved baseline, which is the right precedence.
      const recipe = parseRecipeFromUrl(params, SESSION_META);
      saveSessionRecipe(ds, recipe);
      return;
    }

    if (dsChanged) {
      const saved = loadSessionRecipe(ds);
      if (recipeHasContent(saved)) {
        // Fresh arrival on this ds with empty overlay + non-empty baseline
        // → restore. The next render will see the restored URL and save it
        // as-is (no-op since it already matches). Fires on first mount
        // (lastDsRef starts null) and on every datastack switch.
        const next = applyTourConfigToParams(params, saved!);
        setParams(next, { replace: true });
      }
      // Empty baseline → nothing to do; user gets a clean view.
      return;
    }

    // Same datastack, overlay just got cleared by the user — save empty so
    // the cleared state becomes the new baseline (matches the "last-changed
    // overlay is the default" rule). Without this, the next cross-nav would
    // restore the pre-clear state.
    saveSessionRecipe(ds, null);
  }, [params, setParams]);
}
