import { useCallback, useEffect, useState } from "react";

/**
 * One persisted cell-set scoped to a `(datastack, feature_table)` pair.
 *
 * Saved selections live in localStorage rather than URL state. The
 * underlying cell_id list can run into the tens of thousands on a
 * lasso (overflowing Node's 8KB request-line header limit at refresh),
 * and these are inherently per-device artifacts — they survive page
 * reloads but don't travel through a shared link. The future recipes
 * feature is what'll make them shareable, via a server-side selection-
 * token pattern.
 */
export interface NamedSelection {
  /** Stable id, generated at save time. Recipes will reference this
   *  later by name; the id makes rename + reference decoupled. */
  id: string;
  name: string;
  /** Auto-assigned hex from a fixed palette. Lets the panel's row
   *  swatch + future scatter-overlay treatment use a consistent
   *  color per set. */
  color: string;
  createdAt: number;
  /** cell_ids as strings — same shape the FeatureExplorer's
   *  `selTableLocal` carries. */
  cellIds: string[];
}

/** Distinct from the D3 Category10 palette the project reuses for
 *  categorical channel colors — saved-set badges read as a separate
 *  affordance rather than as "another category." Tailwind-600 ramp;
 *  saturated enough to read against a light background. */
const SET_PALETTE = [
  "#dc2626", // red-600
  "#ea580c", // orange-600
  "#ca8a04", // yellow-600
  "#16a34a", // green-600
  "#0891b2", // cyan-600
  "#2563eb", // blue-600
  "#7c3aed", // violet-600
  "#db2777", // pink-600
];

/** Localstorage soft cap. ~700KB JSON for a 100k cell_id list at
 *  ~7 bytes per id, so 20 sets is well under the 5-10MB browser limit
 *  even at the worst-case all-universe slot. Hit on save → oldest set
 *  is dropped. */
const MAX_SETS_PER_SCOPE = 20;

function storageKey(ds: string, ft: string): string {
  return `cdv:selections:${ds}:${ft}`;
}

function readAll(ds: string, ft: string): NamedSelection[] {
  // localStorage can throw in private-mode Safari and is undefined in
  // SSR; the try/catch keeps a brief outage from breaking the rail.
  // We return an empty list rather than re-throwing so the picker UI
  // renders the empty state.
  try {
    const raw = window.localStorage.getItem(storageKey(ds, ft));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidSelection) as NamedSelection[];
  } catch {
    return [];
  }
}

function writeAll(ds: string, ft: string, sets: NamedSelection[]): boolean {
  try {
    window.localStorage.setItem(storageKey(ds, ft), JSON.stringify(sets));
    return true;
  } catch (err) {
    // Quota / private mode — surface the failure to the caller so it
    // can show a one-line warning. Don't throw; the rail should keep
    // working even if persistence is unavailable this session.
    console.warn("[useNamedSelections] localStorage write failed", err);
    return false;
  }
}

function isValidSelection(v: unknown): v is NamedSelection {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.color === "string" &&
    typeof o.createdAt === "number" &&
    Array.isArray(o.cellIds) &&
    o.cellIds.every((c) => typeof c === "string")
  );
}

function newId(): string {
  // `crypto.randomUUID` is universal on modern browsers; the fallback
  // keeps the hook usable in older environments without bringing in
  // a uuid dependency.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pickColor(existing: NamedSelection[]): string {
  // Round-robin through the palette so back-to-back saves get visibly
  // distinct colors. Counting usage per hex (rather than going off the
  // length alone) means deleting a set frees its color for reuse.
  const counts = new Map<string, number>();
  for (const c of SET_PALETTE) counts.set(c, 0);
  for (const s of existing) {
    counts.set(s.color, (counts.get(s.color) ?? 0) + 1);
  }
  let best = SET_PALETTE[0];
  let bestCount = counts.get(best) ?? 0;
  for (const c of SET_PALETTE) {
    const n = counts.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

function suggestName(existing: NamedSelection[]): string {
  // "Selection 1", "Selection 2", … skipping names already taken so a
  // user who renames "Selection 2" to "Pyramidals" doesn't see the
  // next save become "Selection 2" again.
  const used = new Set(existing.map((s) => s.name));
  for (let i = 1; i <= existing.length + 1; i++) {
    const name = `Selection ${i}`;
    if (!used.has(name)) return name;
  }
  return `Selection ${existing.length + 1}`;
}

export interface UseNamedSelections {
  /** Newest-first; empty array if disabled or storage is unreadable. */
  selections: NamedSelection[];
  /** Saves a new set under the given name. Returns the created
   *  selection (so the caller can immediately apply UI feedback like
   *  scrolling to its row). When ``cellIds`` is empty, returns null
   *  without persisting. */
  save: (name: string, cellIds: string[]) => NamedSelection | null;
  rename: (id: string, name: string) => void;
  /** Rewrites the underlying cell list — used by the "update this set
   *  with the current selection" affordance. */
  update: (id: string, cellIds: string[]) => void;
  remove: (id: string) => void;
  /** Convenience: produce the next auto-suggested name. Useful for
   *  pre-filling a rename input. */
  suggestName: () => string;
}

/**
 * React hook over a (ds, ft)-scoped localStorage store of named cell sets.
 *
 * Pass null ds/ft to disable — the hook returns an empty list and
 * no-op writers. This makes the call-site terse: it can mount the hook
 * unconditionally and let nullable URL state filter through.
 *
 * The hook listens for the `storage` event so a save in another tab on
 * the same scope shows up live in this tab. Within-tab updates rebroadcast
 * via component state.
 */
export function useNamedSelections(
  ds: string | null,
  ft: string | null,
): UseNamedSelections {
  const enabled = !!ds && !!ft;
  const [selections, setSelections] = useState<NamedSelection[]>(() =>
    enabled ? readAll(ds!, ft!) : [],
  );

  // Reload when scope changes (datastack switch, feature-table switch).
  useEffect(() => {
    if (!enabled) {
      setSelections([]);
      return;
    }
    setSelections(readAll(ds!, ft!));
  }, [enabled, ds, ft]);

  // Cross-tab sync — `storage` fires in every other tab when one tab
  // writes. Reload when the matching key changes. Same-tab writes
  // don't fire this event; we sync those by calling setSelections
  // directly in save/rename/remove.
  useEffect(() => {
    if (!enabled) return;
    const key = storageKey(ds!, ft!);
    const onStorage = (ev: StorageEvent) => {
      if (ev.key !== key) return;
      setSelections(readAll(ds!, ft!));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [enabled, ds, ft]);

  const persist = useCallback(
    (next: NamedSelection[]) => {
      if (!enabled) return;
      // Sort newest-first for both the in-memory + persisted views so
      // the panel rendering doesn't have to re-sort on every change.
      const sorted = [...next].sort((a, b) => b.createdAt - a.createdAt);
      // Apply the FIFO cap — oldest entries fall off if we exceed it.
      // Newest-first sort means the slice keeps the recent ones.
      const capped = sorted.slice(0, MAX_SETS_PER_SCOPE);
      writeAll(ds!, ft!, capped);
      setSelections(capped);
    },
    [enabled, ds, ft],
  );

  const save = useCallback(
    (name: string, cellIds: string[]): NamedSelection | null => {
      if (!enabled) return null;
      if (cellIds.length === 0) return null;
      const trimmed = name.trim() || suggestName(selections);
      const created: NamedSelection = {
        id: newId(),
        name: trimmed,
        color: pickColor(selections),
        createdAt: Date.now(),
        cellIds: [...cellIds],
      };
      persist([created, ...selections]);
      return created;
    },
    [enabled, selections, persist],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      if (!enabled) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      const next = selections.map((s) =>
        s.id === id ? { ...s, name: trimmed } : s,
      );
      persist(next);
    },
    [enabled, selections, persist],
  );

  const update = useCallback(
    (id: string, cellIds: string[]) => {
      if (!enabled) return;
      const next = selections.map((s) =>
        s.id === id ? { ...s, cellIds: [...cellIds] } : s,
      );
      persist(next);
    },
    [enabled, selections, persist],
  );

  const remove = useCallback(
    (id: string) => {
      if (!enabled) return;
      const next = selections.filter((s) => s.id !== id);
      persist(next);
    },
    [enabled, selections, persist],
  );

  const suggestNameImpl = useCallback(
    () => suggestName(selections),
    [selections],
  );

  return {
    selections,
    save,
    rename,
    update,
    remove,
    suggestName: suggestNameImpl,
  };
}
