import { useEffect, useRef, useState } from "react";
import type { PartnerRecord } from "../api/types";

/** Persisted preference key for the most-recently-used copy mode. Scoped
 *  globally because the affordance is conceptually one thing across all
 *  PartnersTable instances; switching from /neuron to /explore shouldn't
 *  reset the user's last choice. */
const LS_KEY = "cdv:copy_ids_mode";

export type CopyMode =
  | "root_space"
  | "root_comma"
  | "cell_comma"
  | "cell_newline";

interface ModeSpec {
  label: string;
  /** Source field to read off each row. */
  field: "root_id" | "cell_id";
  /** Separator between ids in the resulting clipboard text. */
  separator: string;
  /** Short blurb shown in the dropdown describing the use case. */
  hint: string;
}

const MODES: Record<CopyMode, ModeSpec> = {
  root_space: {
    label: "root_ids (spaces)",
    field: "root_id",
    separator: " ",
    hint: "Paste into Neuroglancer segments",
  },
  root_comma: {
    label: "root_ids (commas)",
    field: "root_id",
    separator: ", ",
    hint: "Paste into notebooks / docs",
  },
  cell_comma: {
    label: "cell_ids (commas)",
    field: "cell_id",
    separator: ", ",
    hint: "Paste into notebooks / docs",
  },
  cell_newline: {
    label: "cell_ids (newlines)",
    field: "cell_id",
    separator: "\n",
    hint: "Paste into spreadsheet columns",
  },
};

function readSavedMode(): CopyMode {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && saved in MODES) return saved as CopyMode;
  } catch {
    // SSR / disabled localStorage — fall through to default.
  }
  return "root_space";
}

function saveMode(mode: CopyMode): void {
  try {
    localStorage.setItem(LS_KEY, mode);
  } catch {
    // ignore — non-essential
  }
}

/** Best-effort clipboard write. Mirrors the fallback pattern in
 *  `tableColumns.tsx`'s CopyableId and `ShareMenu.tsx`. */
async function copyText(text: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to prompt below.
    }
  }
  if (typeof window !== "undefined" && "prompt" in window) {
    window.prompt("Copy the ids below:", text);
    return false; // user has to manually copy; we don't claim success
  }
  return false;
}

function extractIds(
  rows: PartnerRecord[],
  ids: string[],
  field: "root_id" | "cell_id",
  /** Selection ids are positions of the row by `keyColumn`. `keyColumn`
   *  tells us how to find the row given the selection id. */
  keyColumn: "root_id" | "cell_id",
): string[] {
  if (ids.length === 0) return [];
  const byKey = new Map<string, PartnerRecord>();
  for (const row of rows) {
    const key = String(row[keyColumn] ?? "");
    if (key) byKey.set(key, row);
  }
  const out: string[] = [];
  for (const id of ids) {
    const row = byKey.get(id);
    if (!row) continue;
    const value = row[field];
    if (value === null || value === undefined || value === "") continue;
    out.push(String(value));
  }
  return out;
}

interface Props {
  /** All rows currently in the table — used to extract the alternate id
   *  (e.g. cell_id when the row is keyed on root_id). */
  rows: PartnerRecord[];
  /** Rows that pass the active filters / sort, ACROSS pages. Used as
   *  the "visible" fallback when no selection is active. */
  visibleIds: string[];
  /** Rows the user explicitly selected via row checkboxes. Empty when
   *  no selection is active — the action then copies the visible set. */
  selectedIds: string[];
  /** Primary key the table uses, so we can find the right row record
   *  from a selection id. */
  keyColumn: "root_id" | "cell_id";
  /** Whether any row carries a `cell_id` value. When false the cell_id
   *  modes are disabled (e.g. /neuron without a cell-id decoration
   *  attached). */
  hasCellIds: boolean;
}

/** Compact split-button "Copy IDs" affordance. The main button copies
 *  the selection (or visible rows when no selection) using the
 *  currently-chosen mode; the small ▾ caret opens a popover with the
 *  four mode options. */
export function CopyIdsMenu({
  rows,
  visibleIds,
  selectedIds,
  keyColumn,
  hasCellIds,
}: Props) {
  const [mode, setMode] = useState<CopyMode>(() => readSavedMode());
  // If the last mode references cell_ids but the current table can't
  // provide them, fall back silently to root_space so the main button
  // does the right thing instead of copying an empty string.
  useEffect(() => {
    if (!hasCellIds && MODES[mode].field === "cell_id") {
      setMode("root_space");
    }
  }, [hasCellIds, mode]);

  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — same pattern as other small
  // popovers in the rail.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const useSelection = selectedIds.length > 0;
  const scopeIds = useSelection ? selectedIds : visibleIds;
  const spec = MODES[mode];
  const previewCount = extractIds(rows, scopeIds, spec.field, keyColumn).length;

  const handleCopy = async (chosen: CopyMode = mode) => {
    const chosenSpec = MODES[chosen];
    const ids = extractIds(rows, scopeIds, chosenSpec.field, keyColumn);
    if (ids.length === 0) {
      setFlash("nothing to copy");
      window.setTimeout(() => setFlash(null), 1500);
      return;
    }
    const ok = await copyText(ids.join(chosenSpec.separator));
    if (ok) {
      setFlash(`copied ${ids.length}`);
      window.setTimeout(() => setFlash(null), 1500);
    }
  };

  const tooltip = `Copy ${scopeIds.length} ${useSelection ? "selected" : "visible"} as ${spec.label}`;
  const buttonLabel = flash ?? `⧉ ${spec.label.replace(/\s*\(.*\)/, "")}`;

  return (
    <div className="copy-ids-menu" ref={popoverRef}>
      <button
        type="button"
        className="copy-ids-main"
        onClick={() => handleCopy()}
        title={tooltip}
        disabled={scopeIds.length === 0}
      >
        {buttonLabel}
      </button>
      <button
        type="button"
        className="copy-ids-caret"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose copy format"
      >
        ▾
      </button>
      {open && (
        <div className="copy-ids-popover" role="menu">
          <div className="copy-ids-scope">
            {useSelection
              ? `${selectedIds.length} selected (preview: ${previewCount})`
              : `${visibleIds.length} visible (preview: ${previewCount})`}
          </div>
          {(Object.keys(MODES) as CopyMode[]).map((key) => {
            const m = MODES[key];
            const disabled = m.field === "cell_id" && !hasCellIds;
            return (
              <button
                key={key}
                type="button"
                role="menuitem"
                className={`copy-ids-option${key === mode ? " active" : ""}`}
                onClick={() => {
                  setMode(key);
                  saveMode(key);
                  setOpen(false);
                  handleCopy(key);
                }}
                disabled={disabled}
                title={
                  disabled
                    ? "No cell_id column on these rows"
                    : `${m.label} — ${m.hint}`
                }
              >
                <div className="copy-ids-option-label">{m.label}</div>
                <div className="copy-ids-option-hint">{m.hint}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
