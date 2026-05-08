import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query — returns `true` while it matches,
 * `false` otherwise. Reactive to viewport / orientation changes via
 * `matchMedia` listeners (no resize-event polling).
 *
 * Used to flip the workbench between side-by-side panes (wide) and
 * a tabbed view (narrow), but useful for any layout decision that
 * a media query alone can't drive (e.g. when a JS-controlled state
 * change accompanies the layout flip).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    // Sync once on mount in case the query state changed between
    // initial render and effect attach.
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}
