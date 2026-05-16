import { useEffect, useRef, useState } from "react";
import type { NamedSelection } from "../../hooks/useNamedSelections";

interface Props {
  selections: NamedSelection[];
  /** Cell_ids currently in the live (ad-hoc) selection. Drives the
   *  contextual labels: "Add to current selection (N → N+M)" etc. */
  currentSelection: string[];
  /** Apply a saved set as the new live selection (replaces). */
  onLoad: (set: NamedSelection) => void;
  /** Union the saved set into the live selection. */
  onAdd: (set: NamedSelection) => void;
  /** Difference: drop the saved set's cells from the live selection. */
  onSubtract: (set: NamedSelection) => void;
  onRename: (set: NamedSelection, name: string) => void;
  onRemove: (set: NamedSelection) => void;
}

/**
 * Pill-shaped trigger + popover for saved cell sets, mounted in the
 * explorer drawer toolbar next to "★ Save selection."
 *
 * Mirrors `CellFilterMenu`'s trigger + popover pattern: pill style
 * cribbed from `.explore-save-pill` (the warm amber tint pairs with
 * "Save selection" so the two read as siblings), outside-click +
 * Escape close, propagation guard against the drawer-handle button
 * the pill sits inside.
 *
 * Lives in the toolbar (rather than the rail it used to occupy)
 * because every other selection-touching action — Save selection,
 * Clear selection, Find cells, "selected" NGL pill — already lives
 * here. Moving Saved Sets to the same cluster gives the user one
 * always-visible "everything about selection" surface; the rail
 * could otherwise scroll the panel off-screen when the table drawer
 * narrows the rail's height.
 */
export function SavedSetsMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const count = props.selections.length;

  // Close on outside click + Escape. Same pattern as CellFilterMenu so
  // every popover in the explorer behaves identically.
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

  // Disabled trigger when there are no sets *and* no current selection
  // — at that point the user has nothing saved AND nothing to discover
  // by opening the popover. Once they save anything, the trigger
  // becomes the durable shortcut to it. (Save itself lives in the
  // sibling "★ Save selection" pill.)
  const triggerDisabled = count === 0;

  return (
    <div ref={containerRef} className="saved-sets-menu">
      <button
        type="button"
        className={`saved-sets-menu-trigger${count > 0 ? " has-sets" : ""}${
          triggerDisabled ? " disabled" : ""
        }`}
        aria-disabled={triggerDisabled}
        aria-expanded={open}
        title={
          count === 0
            ? "No saved sets yet — use ★ Save selection to save the current selection"
            : `${count} saved set${count === 1 ? "" : "s"} — load, add, or subtract`
        }
        onClick={(e) => {
          // Stop propagation so the surrounding drawer-handle button
          // doesn't toggle the drawer open/closed when the popover
          // opens.
          e.stopPropagation();
          if (triggerDisabled) return;
          setOpen((v) => !v);
        }}
      >
        ★ Sets{count > 0 ? ` (${count})` : ""}
      </button>
      {open && !triggerDisabled && (
        <div
          className="saved-sets-menu-popover cell-filter-menu-popover-up"
          onClick={(e) => e.stopPropagation()}
        >
          <SavedSetsList {...props} />
        </div>
      )}
    </div>
  );
}

/**
 * Bare list-of-saved-sets rendering. Rows show per-set load/add/
 * subtract/rename/remove affordances; the algebra (replace / union /
 * difference) is implemented in FeatureExplorer so this component
 * stays presentational. The future "two-set diff" UI for differential
 * features can reuse this list verbatim.
 *
 * Renders an empty-state line when there are no sets — but the menu
 * trigger above is disabled in that case, so this is reached only
 * during the brief window between mount and first save (e.g. the
 * popover was open when the last set was deleted).
 */
function SavedSetsList({
  selections,
  currentSelection,
  onLoad,
  onAdd,
  onSubtract,
  onRename,
  onRemove,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const startRename = (set: NamedSelection) => {
    setRenamingId(set.id);
    setDraftName(set.name);
  };
  const commitRename = (set: NamedSelection) => {
    if (draftName.trim() && draftName.trim() !== set.name) {
      onRename(set, draftName);
    }
    setRenamingId(null);
  };
  const cancelRename = () => {
    setRenamingId(null);
  };

  if (selections.length === 0) {
    return (
      <div className="saved-sets-empty">
        No saved sets yet. Use <strong>★ Save selection</strong> on the
        current selection to save one.
      </div>
    );
  }

  return (
    <div className="saved-sets-list">
      {selections.map((s) => (
        <div key={s.id} className="saved-sets-row">
          <span
            className="saved-sets-swatch"
            style={{ background: s.color }}
            title={`Cell set "${s.name}" — ${s.cellIds.length.toLocaleString()} cells`}
          />
          {renamingId === s.id ? (
            <input
              className="saved-sets-rename-input"
              type="text"
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => commitRename(s)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(s);
                if (e.key === "Escape") cancelRename();
              }}
            />
          ) : (
            <button
              type="button"
              className="saved-sets-name"
              onClick={() => onLoad(s)}
              onDoubleClick={() => startRename(s)}
              title={`Load (replace current selection) — ${s.cellIds.length.toLocaleString()} cells. Double-click to rename.`}
            >
              <span className="saved-sets-name-label">{s.name}</span>
              <span className="saved-sets-count">
                {s.cellIds.length.toLocaleString()}
              </span>
            </button>
          )}
          <div className="saved-sets-actions">
            <button
              type="button"
              className="saved-sets-action"
              onClick={() => onAdd(s)}
              title={`Add to current selection (union) — ${s.cellIds.length.toLocaleString()} cells${currentSelection.length > 0 ? `, into the ${currentSelection.length.toLocaleString()} cells you have selected` : ""}`}
            >
              +
            </button>
            <button
              type="button"
              className="saved-sets-action"
              onClick={() => onSubtract(s)}
              disabled={currentSelection.length === 0}
              title={
                currentSelection.length === 0
                  ? "Nothing in the current selection to subtract from"
                  : `Subtract from current selection (difference)`
              }
            >
              −
            </button>
            <button
              type="button"
              className="saved-sets-action saved-sets-action-rename"
              onClick={() => startRename(s)}
              title="Rename"
            >
              ✎
            </button>
            <button
              type="button"
              className="saved-sets-action saved-sets-action-delete"
              onClick={() => onRemove(s)}
              title="Delete this set"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
