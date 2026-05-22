import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCellIdLookupMutation } from "../api/queries";
import { writePendingApplyExtras } from "../tours/useApplyRecipe";

interface Props {
  /** Datastack the focal neuron lives in. */
  ds: string;
  /** Materialization version — needed for the cell_id resolver. */
  matVersion: number | "live";
  /** Focal neuron root_id — becomes the `?seed=` value. */
  rootId: string;
  /** Selected partner root_ids. Empty → seed-only navigation. */
  selectedRootIds: string[];
}

/** Cross-nav action: hop from /neuron's PartnersTable to /explore with
 *  the focal neuron set as the connectivity seed. When the user has a
 *  selection, resolve the selected partner root_ids → cell_ids and
 *  stage them in localStorage; the explorer consumes the payload on
 *  arrival (setting the selection bag and persisting as a named
 *  selection via useNamedSelections.save()). When the selection is
 *  empty, the navigation carries only the seed — the user can filter
 *  on `seed_is_partner` in the explorer to recover the partner set
 *  there. */
export function OpenInExplorerButton({
  ds,
  matVersion,
  rootId,
  selectedRootIds,
}: Props) {
  const navigate = useNavigate();
  const lookup = useCellIdLookupMutation();
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setError(null);
    const seedQuery = `?ds=${encodeURIComponent(ds)}` +
      (matVersion === "live" ? "" : `&mv=${matVersion}`) +
      `&seed=${encodeURIComponent(rootId)}`;

    if (selectedRootIds.length === 0) {
      navigate(`/explore${seedQuery}`);
      return;
    }

    // Resolve root_ids → cell_ids before navigating so the destination
    // can stage a named selection from cell_id-keyed data. Live mode
    // doesn't support the universe cache that backs this resolver, so
    // we degrade to seed-only navigation with a warning toast.
    if (matVersion === "live") {
      setError("Selection handoff requires a materialization version (live mode not supported).");
      navigate(`/explore${seedQuery}`);
      return;
    }

    try {
      const resp = await lookup.mutateAsync({
        ds,
        matVersion,
        rootIds: selectedRootIds,
      });
      const cellIds: string[] = [];
      for (const rid of selectedRootIds) {
        const cell = resp.root_to_cell?.[rid];
        if (cell) cellIds.push(cell);
      }
      const dropped = selectedRootIds.length - cellIds.length;
      const dateLabel = new Date().toISOString().slice(0, 16).replace("T", " ");
      const name = `From connectivity ${dateLabel}`;
      writePendingApplyExtras(ds, "explorer", {
        selection: cellIds,
        save_as_named: { name, source: `connectivity:${rootId}` },
      });
      const droppedNote = dropped > 0 ? ` (${dropped} of ${selectedRootIds.length} had no cell_id)` : "";
      // Brief toast surfaced inline; the navigation happens regardless.
      if (dropped > 0) setError(`Dropped ${dropped} partner(s) without cell_id.${droppedNote}`);
      navigate(`/explore${seedQuery}&apply=connectivity`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Lookup failed; landing in explorer with seed only.",
      );
      navigate(`/explore${seedQuery}`);
    }
  };

  const label = selectedRootIds.length > 0
    ? `→ Explorer (${selectedRootIds.length} sel + seed)`
    : `→ Explorer (seeded)`;
  const tooltip = selectedRootIds.length > 0
    ? `Open in Feature Explorer with the focal neuron as the seed and the ${selectedRootIds.length} selected partner(s) as a named selection`
    : `Open in Feature Explorer with the focal neuron as the connectivity seed`;

  return (
    <>
      <button
        type="button"
        className="open-in-explorer"
        onClick={handleClick}
        disabled={lookup.isPending}
        title={tooltip}
      >
        {lookup.isPending ? "Resolving…" : label}
      </button>
      {error && (
        <span className="open-in-explorer-warning" title={error}>
          ⚠
        </span>
      )}
    </>
  );
}
