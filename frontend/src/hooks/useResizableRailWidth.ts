import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "cdv:v1:explore_rail_width";

/** Min keeps select boxes + summary plots readable; smaller than ~260
 *  and channel option labels start truncating mid-name. */
const MIN_WIDTH = 260;
/** Max prevents the rail from dominating the workspace. The scatter is
 *  the primary canvas, the rail is metadata-shaped — north of ~640 the
 *  ratio inverts in an unhelpful way. */
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 340;

function clamp(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
}

function loadStored(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return clamp(n);
  } catch {
    return DEFAULT_WIDTH;
  }
}

function persist(n: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // private-mode Safari / quota / SSR — degrade silently. The width
    // still works for the session; we just won't remember it.
  }
}

export interface UseResizableRailWidth {
  /** Current width in px. Always within [MIN_WIDTH, MAX_WIDTH]. */
  width: number;
  /** Start a drag. Wire to the handle's `onMouseDown`. The hook
   *  installs document-level mousemove + mouseup listeners (so drag
   *  works even when the cursor leaves the handle) and unbinds them
   *  on mouseup. */
  beginDrag: (e: React.MouseEvent) => void;
  /** True while a drag is in progress — host can apply a visual
   *  "dragging" class to the handle. */
  isDragging: boolean;
}

/**
 * Draggable-width state for the Feature Explorer's left rail.
 *
 * Width persists in localStorage so it survives reloads + cross-nav.
 * The drag installs document-level listeners (mousemove + mouseup) so
 * the user can drag past the handle's bounds without losing the gesture
 * — standard pattern for resize handles where the cursor often gets
 * ahead of the element while moving.
 *
 * Body styling is temporarily mutated during the drag: `cursor:
 * col-resize` so the cursor stays consistent over child elements (which
 * would otherwise reset to their own cursors), and `user-select: none`
 * so accidentally crossing text doesn't trigger a selection. Both are
 * restored on mouseup.
 */
export function useResizableRailWidth(): UseResizableRailWidth {
  const [width, setWidth] = useState<number>(loadStored);
  const [isDragging, setIsDragging] = useState(false);
  // Refs hold the drag-anchor state so the document-level handlers
  // (registered in `beginDrag` and torn down in `endDrag`) don't have
  // to read it from React state — closure captures would race the
  // `setWidth` updates and re-create the handlers each tick.
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const endDrag = useCallback(() => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", endDrag);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setIsDragging(false);
    // Persist the final width once, not on every mousemove tick —
    // localStorage writes are cheap but burst-writing on every pixel
    // is wasteful and a private-mode quota error would spam the
    // console.
    setWidth((current) => {
      persist(current);
      return current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMove = useCallback((e: MouseEvent) => {
    const delta = e.clientX - startXRef.current;
    const next = clamp(startWidthRef.current + delta);
    setWidth(next);
  }, []);

  const beginDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", endDrag);
    },
    [width, onMove, endDrag],
  );

  // Defensive cleanup: if the component unmounts mid-drag (route
  // change, hot reload), tear down the listeners. The handlers are
  // captured in refs so this matches whatever was registered.
  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", endDrag);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [onMove, endDrag]);

  return { width, beginDrag, isDragging };
}
