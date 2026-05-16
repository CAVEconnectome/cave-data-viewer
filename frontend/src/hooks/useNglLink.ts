import { useCallback, useMemo } from "react";
import {
  useMakeLinkMutation,
  useMakeSegmentsLinkMutation,
} from "../api/queries";

/**
 * Request shape for "open these specific segments in Neuroglancer."
 *
 * No focal neuron — just a flat list of root_ids the user has selected
 * (a table row, a lasso polygon, a column-filter result). The optional
 * `position` lets us open the viewer centered on a meaningful point
 * (synapse coordinate, soma center) when the source row has one.
 */
export interface NglSegmentsRequest {
  kind: "segments";
  ds: string;
  matVersion: number | "live";
  rootIds: string[];
  /** Center the viewer on this voxel coordinate (typically pulled from
   *  a row's `<prefix>_pt_position_x/y/z` triple). */
  position?: [number, number, number];
  /** Voxel resolution (nm/voxel) for the table the position came from.
   *  Used as the data dimension so `position` reads as voxel coords;
   *  omit to fall back to nglui's inferred coordinates. */
  voxelResolution?: [number, number, number];
}

/**
 * Request shape for "open this focal neuron + its connections."
 *
 * The backend renders a Neuroglancer state for a named template
 * (`inputs`, `outputs`, `connectivity`) with the focal neuron's
 * segment + (optionally) a curated partner list. Used by the neuron
 * view and its cell panel.
 */
export interface NglTemplateRequest {
  kind: "template";
  ds: string;
  matVersion: number | "live" | null;
  /** Template id — matches a file in `templates/links/*.yaml`. */
  template: string;
  rootId: string;
  /** Subset of partner segments to highlight; falls back to the full
   *  template behavior when undefined/empty. */
  selectedPartnerIds?: string[];
}

export type NglLinkRequest = NglSegmentsRequest | NglTemplateRequest;

export interface UseNglLinkResult {
  /** Build the Neuroglancer state for `request`, open it in a new tab,
   *  and resolve `true` on success. On failure resolves `false` and
   *  the error is surfaced via `error` for inline display by the
   *  caller. The caller doesn't need to `try/catch` — error state is
   *  declarative. */
  open: (request: NglLinkRequest) => Promise<boolean>;
  /** True while either underlying mutation is in flight. */
  isPending: boolean;
  /** True after a failed `open`; cleared on `reset` or the next
   *  successful `open`. */
  isError: boolean;
  /** Most recent error message from either underlying mutation, or
   *  null. Stringified so the caller doesn't need to discriminate the
   *  error class. */
  error: Error | null;
  /** Clear error state on both underlying mutations. */
  reset: () => void;
}

/**
 * Unified hook for opening Neuroglancer from anywhere in the SPA.
 *
 * Two endpoint shapes live behind this hook:
 *   - **template** (`POST /links`): focal-neuron + named template
 *     (inputs / outputs / connectivity). Used by the neuron view's cell
 *     panel and partners table NGL buttons.
 *   - **segments** (`POST /links/segments`): flat root-id list with
 *     optional view position. Used by the cell-list table, the raw
 *     table-rows view, and the global "open neutral viewer" link.
 *
 * Centralising both means the call sites only think about "what cells
 * do I want to open?" and the hook handles dispatch, in-flight state,
 * and error surface uniformly. The pending/error state aggregates
 * across both underlying mutations so callers wire a single error
 * banner regardless of which endpoint they hit.
 *
 * Subsampling — capping a request to avoid Neuroglancer sluggishness on
 * thousand-segment scenes — is *not* in the hook on purpose. Each call
 * site knows its own cap policy ("visible vs selected", "all rows vs
 * filtered"); use `randomSubsample` from this module to apply one
 * before passing to `open`.
 */
export function useNglLink(): UseNglLinkResult {
  const segmentsMutation = useMakeSegmentsLinkMutation();
  const templateMutation = useMakeLinkMutation();

  const open = useCallback(
    async (request: NglLinkRequest): Promise<boolean> => {
      try {
        let result: { url: string };
        if (request.kind === "segments") {
          result = await segmentsMutation.mutateAsync({
            ds: request.ds,
            matVersion: request.matVersion,
            rootIds: request.rootIds,
            position: request.position,
            voxelResolution: request.voxelResolution,
          });
        } else {
          result = await templateMutation.mutateAsync({
            ds: request.ds,
            matVersion: request.matVersion,
            template: request.template,
            rootId: request.rootId,
            selectedPartnerIds: request.selectedPartnerIds,
          });
        }
        window.open(result.url, "_blank");
        return true;
      } catch {
        // Error state surfaces through `isError`/`error` for inline
        // display — the caller doesn't need to catch.
        return false;
      }
    },
    [segmentsMutation, templateMutation],
  );

  const reset = useCallback(() => {
    segmentsMutation.reset();
    templateMutation.reset();
  }, [segmentsMutation, templateMutation]);

  // Aggregate state across both mutations: pending if either is in
  // flight, error if either has one (most recent wins on the error
  // object). One source of truth for "is there a Neuroglancer
  // request happening / did it fail?" regardless of which endpoint
  // the call site used.
  return useMemo(
    () => ({
      open,
      isPending: segmentsMutation.isPending || templateMutation.isPending,
      isError: segmentsMutation.isError || templateMutation.isError,
      error:
        (segmentsMutation.error as Error | null) ??
        (templateMutation.error as Error | null) ??
        null,
      reset,
    }),
    [
      open,
      reset,
      segmentsMutation.isPending,
      segmentsMutation.isError,
      segmentsMutation.error,
      templateMutation.isPending,
      templateMutation.isError,
      templateMutation.error,
    ],
  );
}

/**
 * Reservoir-sample `arr` down to at most `cap` items, preserving the
 * original order of the picked subset. O(n) single-pass, uniform
 * without replacement. Returns the array unchanged when already at or
 * below cap.
 *
 * Lives next to `useNglLink` because the only current users are NGL
 * call sites capping segment lists to a Neuroglancer-friendly size
 * (sub-thousand-ish — the viewer starts feeling sluggish past that and
 * the user rarely needs every cell in a 50k filter result anyway).
 */
export function randomSubsample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const out = arr.slice(0, cap);
  for (let i = cap; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < cap) out[j] = arr[i];
  }
  return out;
}
