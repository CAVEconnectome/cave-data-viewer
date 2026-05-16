import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useFindCellsMutation } from "../../api/embeddings";
import type { FindCellResult, FindCellStatus } from "../../api/types";

type SearchMode = "root_id" | "cell_id";

interface ParseResult {
  ok: true;
  values: string[];
}
interface ParseError {
  ok: false;
  message: string;
}

/** Split on any combination of whitespace and commas, drop empties,
 *  require every token to parse as a non-negative integer.
 *
 *  Why this parser shape: root_ids come out of Neuroglancer in two
 *  natural formats — space-separated lists in the `segments=` URL
 *  fragment, and comma-separated lists from notebook clipboards. Both
 *  should "just work" without the user having to reformat. Newlines in
 *  pasted text (column copies, multi-line notebooks) are also tolerated
 *  via the whitespace split.
 *
 *  We validate token-by-token and reject the whole submission on the
 *  first bad token rather than silently dropping it — silently dropping
 *  garbage produces confusing "Found N of M" counts where M is smaller
 *  than the user thinks they pasted.
 */
function parseIds(raw: string): ParseResult | ParseError {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "Paste at least one id." };
  }
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, message: "No ids found in input." };
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!/^[0-9]+$/.test(tokens[i])) {
      return {
        ok: false,
        message: `Expected integer ids; got "${tokens[i]}" at position ${i + 1}.`,
      };
    }
  }
  // Dedup while preserving order — pasting the same id twice shouldn't
  // double-count it in the status row.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return { ok: true, values: out };
}

interface CellIdSummary {
  mode: "cell_id";
  total: number;
  hitCount: number;
  misses: string[];
}

interface RootIdSummary {
  mode: "root_id";
  total: number;
  hitCount: number;
  alignedCount: number;
  byStatus: Record<FindCellStatus, FindCellResult[]>;
}

type Summary = CellIdSummary | RootIdSummary;

interface Props {
  ds: string | null;
  featureTableId: string | null;
  matVersion: number | "live" | null;
  /** Universe cell_ids as a Set, sourced from the scatter response.
   *  cell_id-mode searches validate membership locally against this so
   *  the SPA never round-trips the server for cell_id input. */
  universeCellIds: Set<string> | null;
  /** Replace the current selection with the resolved cell_ids. Drives
   *  the unified highlight + table-checked state. */
  onReplaceSelection: (cellIds: string[]) => void;
  /** Union the resolved cell_ids into the current selection. Triggered
   *  when the user submits with Shift held — standard data-viz modifier
   *  for "add to selection". */
  onUnionIntoSelection: (cellIds: string[]) => void;
  /** Re-frame the scatter onto the newly-selected cells. The parent
   *  schedules this on the next animation frame so the scatter has
   *  committed its new highlight bounds before fitView reads them. */
  onFitToSelection: () => void;
}

/** Cell-id search trigger + modal for the Feature Explorer.
 *
 * The on-rail surface is a single compact button that says "Find
 * cells…"; clicking it opens a centered modal containing the actual
 * search UI. The modal hosts:
 *
 * - **Mode toggle** — explicit `by root_id` / `by cell_id` (no
 *   heuristic auto-detect; see the [[explicit-ui-modes-over-input-heuristics]]
 *   memory). `root_id` resolves via the `/find_cells` endpoint, which
 *   does an `is_latest_roots` fast-path then a `suggest_latest_roots`
 *   lineage walk for stale inputs, followed by a nucleus reverse-
 *   resolve. `cell_id` validates locally against the scatter's
 *   universe — no API call.
 * - **Multi-id input** — space-, comma-, or newline-separated paste
 *   so a Neuroglancer `segments=` fragment or a notebook clipboard
 *   works without reformatting (see the [[root-ids-arrive-as-neuroglancer-clipboard-paste]]
 *   memory).
 * - **Status row + expandable detail** — after submit, a one-line
 *   summary plus collapsible lists of the per-status results
 *   (translated, unaligned, unresolved, not-in-universe).
 *
 * Submit drops the resolved cell_ids onto the unified selection set
 * (replace by default; Shift unions). On the next animation frame the
 * scatter re-fits to the new highlight. The modal stays open after
 * submit so the user can read the status; it closes via the × button,
 * the backdrop, or Escape.
 *
 * Why a modal rather than an inline rail panel: the search is an
 * occasional action, not a constantly-bound surface like the channel
 * picker or color legend. A persistent inline panel competes for rail
 * real estate with affordances the user touches on every interaction;
 * a button-triggered modal keeps the surface visible (button is
 * obvious) but only consumes space when actively used.
 */
export function CellIdSearch({
  ds,
  featureTableId,
  matVersion,
  universeCellIds,
  onReplaceSelection,
  onUnionIntoSelection,
  onFitToSelection,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("root_id");
  const [text, setText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const findCells = useFindCellsMutation();

  // Disable conditions surfaced as a single string so the title attr
  // gives a one-glance explanation of why submit is greyed out.
  const disabledReason = useMemo<string | null>(() => {
    if (!ds || !featureTableId) return "Pick a feature table first.";
    if (mode === "root_id" && matVersion == null) {
      return "Root id lookup needs a materialization version (?mv).";
    }
    if (mode === "cell_id" && !universeCellIds) {
      return "Universe is still loading.";
    }
    return null;
  }, [ds, featureTableId, mode, matVersion, universeCellIds]);

  const applyHits = (
    hitIds: string[],
    additive: boolean,
  ) => {
    if (additive) onUnionIntoSelection(hitIds);
    else onReplaceSelection(hitIds);
    if (hitIds.length > 0) onFitToSelection();
  };

  /** Schedule auto-close when every input resolved cleanly. Anything
   *  less than full success (parse error, fetch error, partial hits,
   *  unaligned or unresolved results) keeps the modal open so the user
   *  can read the status detail.
   *
   *  A short delay (rather than closing on the same tick) gives the
   *  user a beat to register the success line before the modal
   *  disappears — closing instantly feels jarring because it looks
   *  like nothing happened. */
  const closeOnFullSuccess = (hitCount: number, total: number) => {
    if (hitCount > 0 && hitCount === total) {
      window.setTimeout(() => setOpen(false), 450);
    }
  };

  const submitCellIdMode = (parsed: string[], additive: boolean) => {
    const universe = universeCellIds!;
    const hits: string[] = [];
    const misses: string[] = [];
    for (const id of parsed) {
      if (universe.has(id)) hits.push(id);
      else misses.push(id);
    }
    setSummary({
      mode: "cell_id",
      total: parsed.length,
      hitCount: hits.length,
      misses,
    });
    applyHits(hits, additive);
    closeOnFullSuccess(hits.length, parsed.length);
  };

  const submitRootIdMode = async (parsed: string[], additive: boolean) => {
    try {
      const resp = await findCells.mutateAsync({
        ds: ds!,
        featureTableId: featureTableId!,
        rootIds: parsed,
        matVersion: matVersion as number | "live",
      });
      const byStatus: Record<FindCellStatus, FindCellResult[]> = {
        ok: [],
        unaligned: [],
        unresolved: [],
      };
      for (const r of resp.results) byStatus[r.status].push(r);
      const hits = byStatus.ok
        .map((r) => r.cell_id)
        .filter((c): c is string => !!c);
      const alignedCount = byStatus.ok.filter((r) => r.aligned).length;
      setSummary({
        mode: "root_id",
        total: resp.results.length,
        hitCount: hits.length,
        alignedCount,
        byStatus,
      });
      applyHits(hits, additive);
      closeOnFullSuccess(hits.length, resp.results.length);
    } catch (err) {
      // Mutation already exposes the error via findCells.error — clear
      // the local summary so the caller sees the mutation's error UI
      // path rather than a stale prior summary. Submit failures are
      // rare (network / 5xx) and warrant the loud red-error treatment
      // rather than the per-row status row.
      setSummary(null);
      // Re-raise is unnecessary; useMutation already captured it.
      console.warn("[CellIdSearch] find_cells failed", err);
    }
  };

  const onSubmit = (e: FormEvent, additive: boolean) => {
    e.preventDefault();
    if (disabledReason) return;
    const parsed = parseIds(text);
    if (!parsed.ok) {
      setParseError(parsed.message);
      setSummary(null);
      return;
    }
    setParseError(null);
    setExpanded({});
    if (mode === "cell_id") {
      submitCellIdMode(parsed.values, additive);
    } else {
      void submitRootIdMode(parsed.values, additive);
    }
  };

  // Enter submits; Shift+Enter on the textarea historically inserts a
  // newline, but for this form Shift submits in additive mode. Both
  // are useful; we route based on whether the user wants paste-many
  // newlines (rare — paste already handles them) vs additive submit.
  // Disambiguate via the explicit Shift+click on the submit button as
  // the "always additive" path; Enter alone always replaces.
  const onTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      onSubmit(e as unknown as FormEvent, false);
    }
  };

  const totalMisses =
    summary?.mode === "cell_id"
      ? summary.misses.length
      : summary?.mode === "root_id"
        ? summary.byStatus.unaligned.length + summary.byStatus.unresolved.length
        : 0;
  const showStatus = summary !== null || findCells.isPending || findCells.isError;

  // Focus the textarea on open + Esc-to-close.
  //
  // Auto-focus matters here because the typical session is "click the
  // trigger, paste a clipboard, press Enter" — three actions. Without
  // the autofocus the user has to click into the textarea between
  // opening the modal and pasting, which is wasted motion.
  //
  // Esc-to-close runs at the document level so it works whether or not
  // the textarea has focus (e.g. user clicked into the status detail
  // list and now wants to close).
  useEffect(() => {
    if (!open) return;
    // requestAnimationFrame so the portal has mounted by the time we
    // try to focus — synchronous .focus() inside the same tick the
    // modal opens often runs before the ref is attached.
    const id = requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="cell-id-search-trigger"
        onClick={() => setOpen(true)}
        title="Find cells by root_id or cell_id (one or many, pasted from Neuroglancer / a notebook)"
      >
        <span aria-hidden>⌕</span>
        <span>Find cells…</span>
      </button>
      {open &&
        createPortal(
          <div
            className="cell-id-search-modal-backdrop"
            role="presentation"
            onClick={() => setOpen(false)}
          >
            <div
              className="cell-id-search-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Find cells"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="cell-id-search-modal-header">
                <h2 className="cell-id-search-modal-title">Find cells</h2>
                <button
                  type="button"
                  className="cell-id-search-modal-close"
                  onClick={() => setOpen(false)}
                  title="Close (Esc)"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <form
                onSubmit={(e) => onSubmit(e, false)}
                className="cell-id-search-form"
              >
                <div
                  className="cell-id-search-mode"
                  role="radiogroup"
                  aria-label="Search by"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === "root_id"}
                    className={`cell-id-search-mode-btn${mode === "root_id" ? " active" : ""}`}
                    onClick={() => setMode("root_id")}
                    title="Resolve root_ids at the current materialization version"
                  >
                    by root_id
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={mode === "cell_id"}
                    className={`cell-id-search-mode-btn${mode === "cell_id" ? " active" : ""}`}
                    onClick={() => setMode("cell_id")}
                    title="Match cell_ids directly against the loaded universe"
                  >
                    by cell_id
                  </button>
                </div>
                <textarea
                  ref={textareaRef}
                  className="cell-id-search-input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onTextareaKeyDown}
                  placeholder={
                    mode === "root_id"
                      ? "Paste root_ids — space, comma, or newline separated"
                      : "Paste cell_ids — space, comma, or newline separated"
                  }
                  rows={3}
                  spellCheck={false}
                  autoComplete="off"
                />
                <div className="cell-id-search-actions">
                  <button
                    type="submit"
                    className="cell-id-search-submit"
                    disabled={!!disabledReason || findCells.isPending}
                    title={
                      disabledReason ??
                      "Submit (Shift-click or Shift+Enter to add to current selection)"
                    }
                    onClick={(e) => {
                      if (e.shiftKey) {
                        e.preventDefault();
                        onSubmit(e as unknown as FormEvent, true);
                      }
                    }}
                  >
                    {findCells.isPending ? "…" : "→"}
                  </button>
                </div>
              </form>
              {parseError && (
                <div className="cell-id-search-error" role="alert">
                  {parseError}
                </div>
              )}
              {findCells.isError && (
                <div className="cell-id-search-error" role="alert">
                  Lookup failed: {findCells.error?.message ?? "unknown error"}
                </div>
              )}
              {showStatus && summary && (
                <div className="cell-id-search-status">
                  {/* The at-a-glance summary line. Skip the redundant
                      "Found N of M" count — full success auto-closes the
                      modal (the user doesn't need the count when nothing
                      went wrong), and partial outcomes already surface
                      their counts in the detail-list summaries below.
                      Render the aligned and misses notes only when they
                      have something to say; the parent div hides
                      naturally if neither applies. */}
                  {summary.mode === "root_id" && summary.alignedCount > 0 && (
                    <div className="cell-id-search-aligned-note">
                      {summary.alignedCount} translated to current root via
                      chunkedgraph at mv={String(matVersion)}
                    </div>
                  )}
                  {totalMisses > 0 && (
                    <div className="cell-id-search-misses-note">
                      {summary.mode === "cell_id"
                        ? `${summary.misses.length} not in universe`
                        : [
                            summary.byStatus.unaligned.length > 0
                              ? `${summary.byStatus.unaligned.length} unaligned`
                              : null,
                            summary.byStatus.unresolved.length > 0
                              ? `${summary.byStatus.unresolved.length} unresolved`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                    </div>
                  )}
                  {summary.mode === "cell_id" && summary.misses.length > 0 && (
                    <CellIdMissList
                      ids={summary.misses}
                      label="Not in universe"
                      expanded={!!expanded.miss}
                      onToggle={() =>
                        setExpanded((p) => ({ ...p, miss: !p.miss }))
                      }
                    />
                  )}
                  {summary.mode === "root_id" &&
                    summary.byStatus.unaligned.length > 0 && (
                      <RootIdMissList
                        results={summary.byStatus.unaligned}
                        label="Unaligned (chunkedgraph couldn't walk lineage)"
                        expanded={!!expanded.unaligned}
                        onToggle={() =>
                          setExpanded((p) => ({ ...p, unaligned: !p.unaligned }))
                        }
                      />
                    )}
                  {summary.mode === "root_id" &&
                    summary.byStatus.unresolved.length > 0 && (
                      <RootIdMissList
                        results={summary.byStatus.unresolved}
                        label="Unresolved (no nucleus at this mat_version)"
                        expanded={!!expanded.unresolved}
                        onToggle={() =>
                          setExpanded((p) => ({ ...p, unresolved: !p.unresolved }))
                        }
                      />
                    )}
                  {summary.mode === "root_id" && summary.alignedCount > 0 && (
                    <RootIdAlignedList
                      results={summary.byStatus.ok.filter((r) => r.aligned)}
                      expanded={!!expanded.aligned}
                      onToggle={() =>
                        setExpanded((p) => ({ ...p, aligned: !p.aligned }))
                      }
                    />
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function CellIdMissList({
  ids,
  label,
  expanded,
  onToggle,
}: {
  ids: string[];
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <details
      className="cell-id-search-detail"
      open={expanded}
      onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
        if (isOpen !== expanded) onToggle();
      }}
    >
      <summary>
        {label} ({ids.length})
      </summary>
      <ul className="cell-id-search-detail-list">
        {ids.map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
    </details>
  );
}

function RootIdMissList({
  results,
  label,
  expanded,
  onToggle,
}: {
  results: FindCellResult[];
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <details
      className="cell-id-search-detail"
      open={expanded}
      onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
        if (isOpen !== expanded) onToggle();
      }}
    >
      <summary>
        {label} ({results.length})
      </summary>
      <ul className="cell-id-search-detail-list">
        {results.map((r) => (
          <li key={r.original_root_id}>
            <code>{r.original_root_id}</code>
            {r.root_id && r.root_id !== r.original_root_id && (
              <span className="cell-id-search-detail-aligned">
                → <code>{r.root_id}</code>
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function RootIdAlignedList({
  results,
  expanded,
  onToggle,
}: {
  results: FindCellResult[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <details
      className="cell-id-search-detail"
      open={expanded}
      onToggle={(e) => {
        const isOpen = (e.currentTarget as HTMLDetailsElement).open;
        if (isOpen !== expanded) onToggle();
      }}
    >
      <summary>Translated to current root ({results.length})</summary>
      <ul className="cell-id-search-detail-list">
        {results.map((r) => (
          <li key={r.original_root_id}>
            <code>{r.original_root_id}</code>
            <span className="cell-id-search-detail-aligned">
              → <code>{r.root_id}</code>
            </span>
            <span className="cell-id-search-detail-cell">
              (cell {r.cell_id})
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
