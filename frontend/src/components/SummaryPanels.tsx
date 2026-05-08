/**
 * Summary-panel registry.
 *
 * The SPA's analytics rail dispatches summary panels (per-cell visualizations
 * emitted by the spatial provider) to dedicated renderer components keyed on
 * `panel.kind`. Adding a new kind is: write a renderer + register it here.
 *
 * Panel ids in the URL `?plots=` follow the convention `sum-<kind-with-dashes>-<random>`.
 * The kind portion uses dashes (URL-friendly) but matches the underscore form
 * via `SUMMARY_KIND_BY_ID_PREFIX`. Existing bookmarks survive this layout —
 * the prefix is unchanged from pre-Phase-2.
 */

import type { ConnectivityBundle, SummaryPanel } from "../api/types";
import { SynapseDepthProfile } from "./SynapseDepthProfile";

export interface SummaryPanelRendererProps {
  /** The matching panel from `bundle.summary_panels`, or null when the
   *  provider didn't emit data for this kind on the current cell (rail
   *  still mounts the renderer so a stale `?plots=` from a prior datastack
   *  doesn't crash a new datastack — the component renders null). */
  panel: SummaryPanel | null;
  bundle: ConnectivityBundle;
  onClose?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  height?: number;
}

export type SummaryKind = "synapse_depth_profile";

export const SUMMARY_PANEL_RENDERERS: Record<
  SummaryKind,
  React.ComponentType<SummaryPanelRendererProps>
> = {
  synapse_depth_profile: SynapseDepthProfile,
};

const SUMMARY_KIND_BY_ID_PREFIX: Record<string, SummaryKind> = {
  "sum-synapse-depth-profile-": "synapse_depth_profile",
};

/** Map a panel id (e.g. `sum-synapse-depth-profile-abc123`) to its summary
 *  kind, or null when the id isn't a summary-panel id. */
export function summaryKindFromPanelId(id: string): SummaryKind | null {
  for (const [prefix, kind] of Object.entries(SUMMARY_KIND_BY_ID_PREFIX)) {
    if (id.startsWith(prefix)) return kind;
  }
  return null;
}

/** Find the bundle's panel data for a given kind. Returns null when the
 *  provider didn't emit that kind for this cell (e.g. no synapses for a
 *  depth profile, or a non-cortex datastack). */
export function findSummaryPanel(
  bundle: ConnectivityBundle,
  kind: SummaryKind,
): SummaryPanel | null {
  return bundle.summary_panels.find((p) => p.kind === kind) ?? null;
}
