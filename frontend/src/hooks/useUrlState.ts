import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// Tiny typed wrapper around URLSearchParams. The connectivity viewer's URL is
// the source of truth — the backbutton works, links are shareable, everything
// flows from `?ds=...&mv=1300&root=864...&ct=aibs_metamodel_celltypes_v661`.
export function useUrlParam(
  key: string,
): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key);
  const setValue = useCallback(
    (next: string | null) => {
      setParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          if (next === null || next === "") {
            updated.delete(key);
          } else {
            updated.set(key, next);
          }
          return updated;
        },
        { replace: false },
      );
    },
    [key, setParams],
  );
  return [value, setValue];
}

/**
 * Resolve the `?mv=` URL parameter to a materialization-version value the
 * data-fetching hooks understand: an integer for a specific materialization,
 * or the string `"live"` for live mode.
 *
 * The picker writes `?mv=live` as an explicit URL value (rather than clearing
 * the param) so the auto-default-to-latest effect doesn't immediately
 * overwrite the user's choice — `mv` being null in the URL means "no
 * preference, default to latest", whereas `mv === "live"` means "the user
 * picked live."
 *
 * Null URL parameter: also resolves to `"live"`. The Workspace effect then
 * picks the latest valid version on first mount and writes it back to the
 * URL, so this fallback is only material on the first frame.
 */
export function parseMatVersion(mv: string | null): number | "live" {
  if (!mv || mv === "live") return "live";
  const n = Number(mv);
  return Number.isFinite(n) ? n : "live";
}


// Batch setter for multiple URL params in a single navigation. Necessary because
// react-router v6's setSearchParams reads the current params at *call* time, so
// two back-to-back calls (e.g. set ds, then clear mv) race — the second call
// computes from the pre-first-call URL and clobbers the first.
//
// Optional `{ replace }` mirrors react-router's `setSearchParams` second arg —
// pass `{ replace: true }` for transient state changes (e.g. rewriting a
// stale root_id to its current id) so back-button doesn't revisit the broken
// URL.
export function useSetUrlParams(): (
  updates: Record<string, string | null>,
  options?: { replace?: boolean },
) => void {
  const [, setParams] = useSearchParams();
  return useCallback(
    (updates, options) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === "") next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        options?.replace ? { replace: true } : undefined,
      );
    },
    [setParams],
  );
}

// Switching datastacks must clear every other URL key in the same batch,
// not as a follow-up effect. Decoration tables, plots, viz_<id> bindings,
// cells filter, hide/show/coll, root, mv, ct, from — all reference the
// previous datastack's tables/columns, so carrying them forward yields a
// broken view AND lets `useSessionRecipe` save the leaked overlay against
// the new datastack's session-recipe key on the very next render. Building
// fresh URLSearchParams with only `ds` set is the only shape that closes
// that window atomically.
export function useSwitchDatastack(): (
  nextDs: string | null,
  options?: { replace?: boolean },
) => void {
  const [, setParams] = useSearchParams();
  return useCallback(
    (nextDs, options) => {
      setParams(
        () => {
          const next = new URLSearchParams();
          if (nextDs) next.set("ds", nextDs);
          return next;
        },
        options?.replace ? { replace: true } : undefined,
      );
    },
    [setParams],
  );
}
