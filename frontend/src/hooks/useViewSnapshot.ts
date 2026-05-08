import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { migrateStorageKey } from "./storageMigration";

/**
 * Per-tab cached URL state for the major views, so navigating away
 * (e.g. to the landing page or applying a recipe) and back doesn't destroy
 * a complex Neuron view or Table browser configuration.
 *
 * Stored in sessionStorage rather than localStorage — per-tab semantics are
 * the right default: two tabs don't fight over a shared cached URL, and a
 * fresh tab gets a fresh slate. Survives reload of the same tab, which is
 * the useful property.
 *
 * `tables` collapses both `/tables` and `/tables/<name>` because the
 * "Table browser" nav button is a single entry point — restoring to the
 * specific table the user was on is friendlier than dumping them back to
 * the list.
 */
export type ViewFamily = "neuron" | "tables";

export function pathFamily(pathname: string): ViewFamily | null {
  if (pathname === "/neuron") return "neuron";
  if (pathname === "/tables" || pathname.startsWith("/tables/")) return "tables";
  return null;
}

const VIEW_SNAPSHOT_PREFIX = "cdv:v1:view:";

// One-shot forward-migration of the two known view families from the
// unversioned prefix. Runs at module load — idempotent and best-effort.
migrateStorageKey("cdv:view:neuron", "cdv:v1:view:neuron", sessionStorage);
migrateStorageKey("cdv:view:tables", "cdv:v1:view:tables", sessionStorage);

interface ViewSnapshot {
  pathname: string;
  search: string;
}

function writeViewSnapshot(pathname: string, search: string): void {
  const family = pathFamily(pathname);
  if (!family) return;
  try {
    sessionStorage.setItem(
      `${VIEW_SNAPSHOT_PREFIX}${family}`,
      JSON.stringify({ pathname, search } satisfies ViewSnapshot),
    );
  } catch {
    // sessionStorage can throw in private mode / quota — silently degrade
    // to the no-snapshot path; it's a UX nicety, not a correctness feature.
  }
}

export function readViewSnapshot(family: ViewFamily): ViewSnapshot | null {
  try {
    const raw = sessionStorage.getItem(`${VIEW_SNAPSHOT_PREFIX}${family}`);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<ViewSnapshot>;
    if (typeof obj?.pathname === "string" && typeof obj?.search === "string") {
      return { pathname: obj.pathname, search: obj.search };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Snapshot-aware navigation between view families.
 *
 * Subscribes to location changes and persists each visit's URL into
 * sessionStorage keyed by family. Returns `navigateToView(family)` which
 * restores the snapshot when one exists for the current datastack;
 * otherwise it falls back to a bare `?ds=&mv=` URL on the family's root.
 *
 * `ds`/`mv` always reflect the *current* sidebar state, not the snapshot's —
 * the sidebar is the user's lever for those, and a stale snapshot mustn't
 * override their explicit choice. `from` (the transient breadcrumb marker)
 * is dropped on restore.
 */
export function useViewSnapshot(
  ds: string | null,
  mv: string | null,
): { navigateToView: (family: ViewFamily) => void } {
  const location = useLocation();
  const navigate = useNavigate();

  // Pin-cushioning the snapshot write on every render is fine —
  // sessionStorage writes are cheap and the pathFamily gate skips writes
  // for the landing page / 404. The snapshot overwrites itself, so no
  // growth.
  useEffect(() => {
    writeViewSnapshot(location.pathname, location.search);
  }, [location.pathname, location.search]);

  const navigateToView = (family: ViewFamily) => {
    const fallbackPath = family === "neuron" ? "/neuron" : "/tables";
    const snapshot = readViewSnapshot(family);
    const snapshotDs = snapshot
      ? new URLSearchParams(snapshot.search).get("ds")
      : null;
    let pathname = fallbackPath;
    let params: URLSearchParams;
    if (snapshot && snapshotDs === ds) {
      pathname = snapshot.pathname;
      params = new URLSearchParams(snapshot.search);
    } else {
      params = new URLSearchParams();
    }
    if (ds) params.set("ds", ds); else params.delete("ds");
    if (mv) params.set("mv", mv); else params.delete("mv");
    params.delete("from");
    const qs = params.toString();
    // navigateToView changes pathname (not just search), so it goes
    // through `navigate()` rather than `useSetUrlParams`. The chained-
    // setSearchParams race the hook protects against doesn't apply here.
    navigate(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  return { navigateToView };
}
