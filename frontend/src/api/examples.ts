import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { Example, ExamplesListResponse } from "./types";

/** Fetch the lightweight examples list for a datastack (optionally
 *  filtered by kind). Server strips selection payloads for the list. */
export async function fetchExamples(
  ds: string,
  kind?: "connectivity" | "explorer",
): Promise<ExamplesListResponse> {
  return apiFetch<ExamplesListResponse>("/api/v1/examples", {
    query: { ds, ...(kind ? { kind } : {}) },
  });
}

/** Fetch one example's full payload (incl. selection). Used at Open time
 *  by the card click handler. */
export async function fetchExample(ds: string, eid: string): Promise<Example> {
  return apiFetch<Example>(
    `/api/v1/examples/${encodeURIComponent(ds)}/${encodeURIComponent(eid)}`,
  );
}

/** React Query hook for the list endpoint. Disabled when `ds` is null. */
export function useExamples(ds: string | null, kind?: "connectivity" | "explorer") {
  return useQuery({
    queryKey: ["examples", ds, kind ?? "all"],
    queryFn: () => fetchExamples(ds as string, kind),
    enabled: !!ds,
  });
}

/** Build the URL for a thumbnail asset. Returns null when the example
 *  carries no thumbnail (caller renders a placeholder). */
export function thumbnailUrl(ds: string, filename: string | undefined): string | null {
  if (!filename) return null;
  return `/api/v1/examples/${encodeURIComponent(ds)}/_assets/${encodeURIComponent(filename)}`;
}
