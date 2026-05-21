import { useEffect, useState } from "react";
import {
  getPendingDeletions,
  restorePending,
  subscribePendingDeletions,
  type PendingDeletion,
} from "../tours/personalRecipes";

/**
 * Bottom-right toast stack surfacing the undo window for personal-recipe
 * deletions. Mounted once in the app shell (Workspace); reads its state
 * via subscribePendingDeletions so it doesn't need props or a context.
 *
 * Each toast renders a thin countdown bar at the bottom whose CSS
 * animation duration is computed from `expiresAt - now` at mount time —
 * which keeps the bar honest even if the toast first appears late in the
 * undo window (e.g., the user navigates between routes mid-window and the
 * toast remounts).
 *
 * Toasts stack rather than queue: a second delete during the first
 * toast's window adds a new row at the top of the stack; both run their
 * own timers. Stack growth is bounded by the user's tolerance for
 * clicking delete repeatedly — recipe deletion is rare enough that this
 * is not a real concern.
 */
export function UndoToast() {
  const [pending, setPending] = useState<PendingDeletion[]>(() => getPendingDeletions());
  useEffect(
    () => subscribePendingDeletions(() => setPending(getPendingDeletions())),
    [],
  );
  if (pending.length === 0) return null;
  return (
    <div className="undo-toast-stack" aria-live="polite">
      {pending.map((p) => (
        <ToastRow key={`${p.ds} ${p.recipe.id}`} pending={p} />
      ))}
    </div>
  );
}

function ToastRow({ pending }: { pending: PendingDeletion }) {
  const remainingMs = Math.max(0, pending.expiresAt - Date.now());
  const onUndo = () => restorePending(pending.ds, pending.recipe.id);
  return (
    <div className="undo-toast" role="status">
      <div className="undo-toast-body">
        <span className="undo-toast-text">
          Deleted <strong>{pending.recipe.title}</strong>
        </span>
        <button type="button" className="undo-toast-action" onClick={onUndo}>
          Undo
        </button>
      </div>
      <div
        className="undo-toast-countdown"
        style={{ animationDuration: `${remainingMs}ms` }}
      />
    </div>
  );
}
