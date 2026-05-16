import { useEffect, useMemo, useRef, useState } from "react";
import { useUrlParam } from "../hooks/useUrlState";
import type { ColumnGroup, FeatureCategory, PartnerRecord } from "../api/types";
import { CellFilterPanel } from "./CellFilterPanel";

interface Props {
  /** Forwarded to the inner CellFilterPanel — same data the panel needs
   *  when mounted in a rail. */
  columnGroups?: ColumnGroup[];
  sampleRows?: PartnerRecord[];
  /** Optional extra className on the trigger button so the host can size
   *  it to match its neighbors (drawer-header pills, tab-bar tools). */
  className?: string;
  /** Which direction the popover should extend from the trigger.
   *  Defaults to "down" (the NeuronView placement — header pill with
   *  the rail beneath). The explorer mounts at the bottom of the
   *  viewport (drawer header), so it passes "up" to avoid the popover
   *  rendering below the fold. */
  placement?: "down" | "up";
  /** Forwarded to CellFilterPanel — manifest-declared category
   *  structure keyed by table name. When the user picks a table that
   *  has categories, the column dropdown renders as optgroups. */
  categoriesByTable?: Record<string, FeatureCategory[]>;
}

/**
 * Drawer-header / toolbar wrapper around `CellFilterPanel`.
 *
 * Renders a small button labeled `Filter (N)` where N is the active
 * predicate count. Clicking pops open a panel that contains the same
 * filter UI that used to live in the left rail — so filter editing
 * happens visually next to the table the filter affects, rather than
 * across the page.
 *
 * Count is read from the URL state directly (cheap parse: split on
 * commas) so the button stays in sync regardless of which surface
 * mutates `?cells=`. Click-outside closes the popover; Escape closes;
 * mounting the panel inside a popover means the existing component
 * doesn't need to know it lives in a different context.
 */
export function CellFilterMenu({ columnGroups, sampleRows, className, placement = "down", categoriesByTable }: Props) {
  const [raw] = useUrlParam("cells");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Active-predicate count for the button label. We split-and-trim
  // here rather than reach into the panel's parser to avoid a circular
  // import; the grammar is comma-separated clauses so a naive split is
  // accurate enough for a count badge.
  const count = useMemo(() => {
    if (!raw) return 0;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
  }, [raw]);

  // Close on outside click + Escape. Same pattern as the colormap picker
  // so behavior is consistent across the app's popovers.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="cell-filter-menu">
      <button
        type="button"
        className={`cell-filter-menu-trigger${count > 0 ? " has-filter" : ""}${
          className ? ` ${className}` : ""
        }`}
        onClick={(e) => {
          // Stop propagation so clicks inside a parent that's also a
          // button (e.g. the drawer handle) don't toggle the drawer.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title={
          count > 0
            ? `Cell filter — ${count} active predicate${count === 1 ? "" : "s"}`
            : "Open the cell filter"
        }
      >
        ⏚ Filter{count > 0 ? ` (${count})` : ""}
      </button>
      {open && (
        <div
          className={`cell-filter-menu-popover cell-filter-menu-popover-${placement}`}
          onClick={(e) => e.stopPropagation()}
        >
          <CellFilterPanel
            columnGroups={columnGroups}
            sampleRows={sampleRows}
            categoriesByTable={categoriesByTable}
          />
        </div>
      )}
    </div>
  );
}
