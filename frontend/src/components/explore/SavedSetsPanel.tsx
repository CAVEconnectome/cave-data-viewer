import { useState } from "react";
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
 * Left-rail panel listing saved cell sets for the current (ds, ft).
 *
 * Each row is one set with inline rename + a compact action bar:
 *
 * - **Load** — replaces the current live selection (set becomes the
 *   working set). The most-common operation; default click target.
 * - **+** (Add / union) — adds the saved set's cells to the live
 *   selection. The cellxgene-flavored "I have a working selection, and
 *   I want to grow it by reuniting with a labeled cluster I saved
 *   earlier" pattern.
 * - **−** (Subtract / difference) — drops the saved set's cells from
 *   the live selection. Subtractive companion to **+**.
 * - **×** — delete the saved set. No confirmation; sets are cheap to
 *   recreate from a re-lasso and the action is in an out-of-the-way
 *   spot on the row.
 *
 * Set algebra is implemented in the FeatureExplorer (one place that
 * owns the live-selection mutator); this component is presentational +
 * dispatches to props. Keeping the algebra out of the panel means the
 * future "two-set diff" UI for differential features can reuse the
 * same hook + the same panel without rewriting set semantics here.
 */
export function SavedSetsPanel({
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

  return (
    <div className="saved-sets-panel">
      <div className="explore-picker-label">Saved cell sets</div>
      {selections.length === 0 ? (
        <div className="saved-sets-empty">
          No saved sets yet. Lasso or check rows, then click <strong>Save selection</strong>{" "}
          in the drawer.
        </div>
      ) : (
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
      )}
    </div>
  );
}
