/**
 * Per-(datastack, kind) "current view" persistence. The URL is the source
 * of truth for an active workspace; this module mirrors the overlay
 * portion of that URL into **sessionStorage** so the user's configured
 * view survives:
 *
 *   - Cross-navigation that drops overlay — most notably, table-row
 *     clicks into /neuron land at `?ds=&mv=&root=` with no overlay
 *     params. Without this, the user's decorations and plots are lost
 *     on every cross-nav.
 *   - In-tab reloads — refreshing the page keeps the configured view.
 *   - Per-datastack switches — each datastack carries its own baseline,
 *     because recipes reference datastack-bound table names.
 *
 * Storage is **sessionStorage**, not localStorage: persistence is scoped
 * to the browser tab. A NEW tab starts fresh — it does not inherit the
 * previous tab's (or window's) configured view. This is deliberate:
 * localStorage made every new tab resurrect the last session's overlay,
 * which users found too sticky. sessionStorage keeps the within-tab
 * cross-nav restore that's genuinely useful while letting a new tab be
 * a clean slate.
 *
 * Per-kind: the connectivity view (/neuron) and the explorer view
 * (/explore) each have an independent baseline for the same datastack.
 * A user who narrows scope on /explore, hops to /neuron to add
 * decorations, then comes back to /explore (same tab) finds the
 * explorer state intact. Per-(ds, kind) keys make that work cleanly.
 *
 * Storage shape (per-(ds, kind) key, JSON-encoded):
 *
 *     cdv:v1:session_recipe:<datastack>:<kind>  →  { version: 1, recipe: Recipe | null }
 *
 * `recipe: null` is an explicit "user cleared everything" signal —
 * distinct from "no entry yet". Per-key shape keeps each save atomic.
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { Recipe, RecipeKind } from "../api/types";
import { adapterFor } from "./adapters/registry";

const KEY_PREFIX = "cdv:v1:session_recipe:";

interface StoredEntry {
  version: 1;
  recipe: Recipe | null;
}

function storageKey(ds: string, kind: RecipeKind): string {
  return `${KEY_PREFIX}${ds}:${kind}`;
}

// One-shot housekeeping. Session recipes used to live in localStorage,
// which made every new tab resurrect the previous session's overlay.
// They now live in sessionStorage (per-tab). Sweep any dead
// `cdv:v1:session_recipe:*` entries — current-shape and the older
// pre-discriminator `:<ds>` shape alike — out of localStorage so they
// don't linger. Not migrated into sessionStorage: carrying the old
// blob forward would defeat the "new tab is fresh" intent. Idempotent.
function purgeStaleLocalStorage(): void {
  if (typeof localStorage === "undefined") return;
  const dead: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX)) dead.push(k);
  }
  for (const k of dead) {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore — best-effort cleanup
    }
  }
}

purgeStaleLocalStorage();

/**
 * Read the saved session recipe for a (datastack, kind). Null when
 * nothing's saved yet, when the user explicitly cleared (saved-null),
 * or when JSON / shape validation fails. Callers treat null and a
 * content-less recipe identically — both mean "don't restore anything."
 */
export function loadSessionRecipe(ds: string, kind: RecipeKind): Recipe | null {
  if (!ds) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(ds, kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      (parsed.recipe === null ||
        (parsed.recipe && typeof parsed.recipe === "object"))
    ) {
      const r = (parsed.recipe ?? null) as Recipe | null;
      // Guard against kind mismatch in case a legacy migration deposited
      // a non-connectivity body into the connectivity slot. Treat the
      // mismatch as "no baseline" rather than silently apply the wrong
      // kind's payload.
      if (r && r.kind !== kind) return null;
      return r;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the current overlay for a (datastack, kind). `null` records
 * an explicit empty baseline (user cleared everything) so the next
 * restore is a no-op rather than resurrecting an earlier saved state.
 */
export function saveSessionRecipe(
  ds: string,
  kind: RecipeKind,
  recipe: Recipe | null,
): void {
  if (!ds) return;
  try {
    const entry: StoredEntry = { version: 1, recipe };
    sessionStorage.setItem(storageKey(ds, kind), JSON.stringify(entry));
  } catch {
    // Storage failure is non-fatal — the URL is still authoritative
    // for the current view; only cross-navigation persistence degrades.
  }
}

// Synthetic meta values for adapter.parseFromUrl — the Recipe type
// requires id/title but session recipes are private state, never
// displayed or referenced by id; these labels exist only to satisfy
// the type and aid debugging if someone inspects localStorage.
const SESSION_META = {
  id: "session",
  title: "Session view",
};

/**
 * Wire the per-(datastack, kind) save/restore behavior into a view
 * mount. Place a single call near the top of NeuronView
 * (kind="connectivity") and FeatureExplorer (kind="explorer"); the
 * hook owns all URL observation and localStorage I/O.
 *
 *   Save:    whenever `ds` is set and the URL has overlay content for
 *            this kind, snapshot the URL into the (ds, kind) storage
 *            key.
 *   Restore: when `ds` changes (fresh mount, cross-nav, or datastack
 *            switch) and the URL has no overlay AND a non-empty saved
 *            recipe exists for this (ds, kind), apply it via the
 *            adapter's applyToParams and rewrite the URL with
 *            `replace: true`.
 *   Empty:   when `ds` is the same as last seen but the URL no longer
 *            has overlay content, save `null` so the cleared state
 *            becomes the new baseline.
 *
 * Save and restore are mutually exclusive on any single URL state, so
 * the hook can't loop on itself: restore only fires on overlay-empty
 * URLs; overlay-empty URLs without a non-empty saved baseline don't
 * write anything that would change the URL.
 *
 * The explorer's Selection bag is NOT round-tripped through the
 * session recipe — it lives in component state and isn't worth
 * persisting across cross-nav. (Cross-session restore of a hand-
 * curated selection is what "Save as my recipe" is for.) Adapters
 * that don't carry extras handle this naturally; the explorer
 * adapter just ignores `meta.extras.selection` here because we don't
 * supply it.
 */
export function useSessionRecipe(kind: RecipeKind): void {
  const [params, setParams] = useSearchParams();
  const lastDsRef = useRef<string | null>(null);
  const adapter = adapterFor(kind);

  useEffect(() => {
    const ds = params.get("ds");
    if (!ds) return;

    const dsChanged = lastDsRef.current !== ds;
    lastDsRef.current = ds;

    if (adapter.urlHasContent(params)) {
      const recipe = adapter.parseFromUrl(params, SESSION_META);
      saveSessionRecipe(ds, kind, recipe);
      return;
    }

    if (dsChanged) {
      const saved = loadSessionRecipe(ds, kind);
      if (saved && adapter.urlHasContent(new URLSearchParams())) {
        // Defensive shouldn't-reach: urlHasContent on an empty URL is
        // false; we keep the branch for clarity that "non-empty saved"
        // is the trigger.
      }
      if (saved && hasAnyField(saved)) {
        const next = adapter.applyToParams(params, saved);
        setParams(next, { replace: true });
      }
      return;
    }

    saveSessionRecipe(ds, kind, null);
  }, [params, setParams, kind, adapter]);
}

/** True when the saved recipe carries any non-empty field. Kept tiny
 *  — adapter.urlHasContent is the URL-shaped predicate; this is the
 *  Recipe-shaped equivalent for the load path. Walks the recipe via
 *  Object.values rather than touching kind-specific fields so it
 *  stays correct for any future kind. */
function hasAnyField(r: Recipe): boolean {
  for (const [key, value] of Object.entries(r)) {
    if (key === "id" || key === "title" || key === "kind" || key === "version") continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && Object.keys(value as object).length === 0) continue;
    return true;
  }
  return false;
}
