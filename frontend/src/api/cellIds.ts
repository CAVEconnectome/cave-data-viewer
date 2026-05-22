import { useQuery, type QueryKey } from "@tanstack/react-query";
import { apiFetch } from "./client";

/** Response shape from `POST /api/v1/datastacks/<ds>/cell-ids/lookup`.
 *  Always carries both directions; the side opposite to what the caller
 *  posted is an empty object. Values are stringified ints to honor the
 *  int64 / JS Number precision convention. Unmapped or ambiguous inputs
 *  surface as `null`. */
export interface CellIdLookupResponse {
  cell_to_root: Record<string, string | null>;
  root_to_cell: Record<string, string | null>;
}

const PATH = (ds: string) => `/api/v1/datastacks/${ds}/cell-ids/lookup`;

function buildQuery(mv: number | "live" | null | undefined): string {
  if (mv === "live") return "?mat_version=live";
  if (mv === null || mv === undefined) return "";
  return `?mat_version=${mv}`;
}

// ---- root_id -> cell_id (reverse) ------------------------------------------

export interface ResolveCellIdsArgs {
  ds: string;
  matVersion: number | "live" | null;
  rootIds: string[];
}

/** Resolve a batch of root_ids to their cell_ids. Used by the seed
 *  widget (one root_id) and by the connectivity → explorer cross-nav
 *  path (selected partner root_ids → cell_ids for the named-selection
 *  payload). Backed by the cross-pod universe cache once warm. */
export function useResolveCellIds(args: ResolveCellIdsArgs | null) {
  const queryKey: QueryKey = args
    ? [
        "cell_ids_lookup_reverse",
        args.ds,
        args.matVersion ?? "",
        // Ordered join — different orderings reuse server-side resolutions
        // but cut distinct client cache entries, which is fine.
        args.rootIds.join(","),
      ]
    : ["cell_ids_lookup_reverse", "disabled"];
  return useQuery<CellIdLookupResponse>({
    queryKey,
    queryFn: () =>
      apiFetch<CellIdLookupResponse>(
        `${PATH(args!.ds)}${buildQuery(args!.matVersion)}`,
        {
          method: "POST",
          body: { root_ids: args!.rootIds },
        },
      ),
    enabled:
      !!args && !!args.ds && args.rootIds.length > 0 && args.matVersion !== null,
    // Frozen mat_version → resolution is immutable. Mirror useResolveRoots.
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ---- cell_id -> root_id (forward) ------------------------------------------

export interface ResolveRootIdsArgs {
  ds: string;
  matVersion: number | "live" | null;
  cellIds: string[];
}

/** Resolve a batch of cell_ids to their root_ids. Mirrors
 *  `useResolveRoots` from `api/embeddings.ts` but routes through the
 *  generic /cell-ids/lookup endpoint so callers that don't have a
 *  feature_table in scope (e.g. /neuron's PartnersTable resolving
 *  partner root_ids back to cell_ids before cross-nav) don't need to
 *  pass a feature_table_id. */
export function useResolveRootIds(args: ResolveRootIdsArgs | null) {
  const queryKey: QueryKey = args
    ? [
        "cell_ids_lookup_forward",
        args.ds,
        args.matVersion ?? "",
        args.cellIds.join(","),
      ]
    : ["cell_ids_lookup_forward", "disabled"];
  return useQuery<CellIdLookupResponse>({
    queryKey,
    queryFn: () =>
      apiFetch<CellIdLookupResponse>(
        `${PATH(args!.ds)}${buildQuery(args!.matVersion)}`,
        {
          method: "POST",
          body: { cell_ids: args!.cellIds },
        },
      ),
    enabled:
      !!args && !!args.ds && args.cellIds.length > 0 && args.matVersion !== null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
