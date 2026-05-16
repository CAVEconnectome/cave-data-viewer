import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { isSelKey } from "../plots/urlState";

interface UseCrossNavHrefOptions {
  /** Datastack id, always asserted on the destination URL so cross-nav
   *  is self-consistent even if the source view re-renders with stale
   *  `searchParams`. */
  ds: string;
  /** Active materialization. `"live"` survives across the hop intact —
   *  we set the literal string rather than delete `?mv=` so the
   *  destination view doesn't silently fall back to the latest pinned
   *  materialization. */
  matVersion: number | "live";
  /** Optional resolver for keys that aren't already root_ids. /explore
   *  routes cell_ids through a resolver to land on the right root at
   *  the active materialization; raw-table views pass root_ids
   *  directly and skip this. A null/undefined return emits `"#"` so
   *  the link visually exists but doesn't navigate (the caller decides
   *  whether to render a tooltip explaining why). */
  resolveRoot?: (key: string) => string | null | undefined;
  /** Tag the destination view records in `?from=…`. Used for breadcrumb
   *  / back-nav semantics; format is up to the source view
   *  ("neuron:123", "table:syn", "explore:ft/emb", …). */
  from: string;
  /** Decoration tables to carry forward. Empty array clears any
   *  inherited `?dec=`; undefined leaves it alone. Set explicitly when
   *  the source view's decoration choices should travel with the user. */
  decorationTables?: string[];
  /** Cell-filter expression. Same explicit/clear/inherit semantics as
   *  decorationTables: empty string clears, undefined leaves whatever
   *  was inherited. Most cross-nav paths carry this so a user filter
   *  survives the hop. */
  cells?: string | null;
  /** When true, the destination URL starts from the caller's current
   *  `searchParams` (minus plot brushes — those are always stripped
   *  since they're source-scoped). Used for intra-view cross-nav like
   *  neuron → partner-neuron, where view state (plot bindings, column
   *  hide/show) should travel. Inter-view callers (table → neuron,
   *  explore → neuron) set false to land on a clean URL.
   *  Default true. */
  inheritParams?: boolean;
  /** Destination route. Defaults to "/neuron". */
  basePath?: string;
}

/**
 * Build `/neuron?root=…&from=…&…` URLs from a table row's id, carrying
 * forward the user's datastack / materialization / decoration / filter
 * context.
 *
 * Centralises the cross-nav URL grammar so every table-bearing view
 * (NeuronView's partners, /explore's cell list, the raw /tables/:name
 * browser) agrees on what travels between views. Returns a builder
 * function so callers can wire it into anchor `href` props or
 * `navigate()` calls indifferently — both consume strings.
 *
 * Three knobs cover the variation between callers:
 *   - `resolveRoot` for surface keys that aren't root_ids yet
 *   - `inheritParams` for intra- vs inter-view (preserve plot bindings
 *     and column visibility, or start clean)
 *   - explicit `decorationTables` / `cells` for forwarding source state
 *
 * The returned builder also accepts an optional per-row `dsOverride`
 * argument. /neuron remains single-datastack-per-view; multi-ds
 * embedding rows (phase 2) pass `row.source_ds` so cross-nav lands in
 * the cell's *home* datastack rather than whatever ds the workspace
 * happens to be focused on. Single-ds callers omit the second argument
 * and inherit the workspace's `ds`.
 */
export function useCrossNavHref(
  options: UseCrossNavHrefOptions,
): (key: string, dsOverride?: string) => string {
  const [searchParams] = useSearchParams();
  const {
    ds,
    matVersion,
    resolveRoot,
    from,
    decorationTables,
    cells,
    inheritParams = true,
    basePath = "/neuron",
  } = options;
  return useCallback(
    (key: string, dsOverride?: string) => {
      const root = resolveRoot ? resolveRoot(key) : key;
      if (!root) return "#";
      const params = inheritParams
        ? new URLSearchParams(searchParams)
        : new URLSearchParams();
      // Plot-brush selections are source-scoped and never carry: the
      // destination has a different bundle / different plot panels.
      for (const k of [...params.keys()]) {
        if (isSelKey(k)) params.delete(k);
      }
      // Per-row `dsOverride` lets a multi-ds embedding row route into
      // its own home datastack's /neuron view rather than the
      // workspace's. Falsy values (empty string, undefined) fall back
      // to the workspace ds — the single-ds default.
      params.set("ds", dsOverride || ds);
      params.set(
        "mv",
        matVersion === "live" ? "live" : String(matVersion),
      );
      params.set("root", String(root));
      params.set("from", from);
      if (decorationTables !== undefined) {
        if (decorationTables.length > 0) {
          params.set("dec", decorationTables.join(","));
        } else {
          params.delete("dec");
        }
      }
      if (cells !== undefined) {
        if (cells) params.set("cells", cells);
        else params.delete("cells");
      }
      return `${basePath}?${params.toString()}`;
    },
    [
      searchParams,
      ds,
      matVersion,
      resolveRoot,
      from,
      decorationTables,
      cells,
      inheritParams,
      basePath,
    ],
  );
}
