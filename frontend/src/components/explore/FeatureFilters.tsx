import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import type { DecorationColumnEntry } from "../../api/embeddings";
import type { EmbeddingColumnResponse, EmbeddingListItem } from "../../api/types";

/**
 * v1 filter clause language.
 *
 * Mirrors `services/plots.py:_parse_cells_param`'s wire format so a
 * clause expression composed here can be sent verbatim to `/neuron`'s
 * `?cells=` filter as part of cross-nav. v1 supports two operators:
 *
 * - ``eq``: categorical equality. ``predicted_subclass:eq:L23_PYR`` matches
 *   exactly that label; ``cell_type_x.cell_type:eq:23P`` works the same
 *   way over a decoration column.
 * - ``between``: numeric range, inclusive. ``soma_depth_y:between:100,300``
 *   matches values in [100, 300].
 *
 * Multiple clauses join via comma (AND semantics in this dialect; matches
 * the backend parser).
 */
export interface FilterClause {
  /** Full column name (`col` for parquet, `table.col` for decoration). */
  column: string;
  op: "eq" | "between";
  /** For `eq`: one categorical value. For `between`: `[min, max]`. */
  value: string | [number, number];
}

export interface FilterMask {
  /** One bool per cell_id, in positional order. `true` = passes all
   *  clauses (visible); `false` = fails at least one (dimmed/hidden). */
  passing: boolean[];
  /** Number of cells passing. Surfaced as a count in the rail. */
  count: number;
}

interface Props {
  embedding: EmbeddingListItem;
  ds: string;
  matVersion: number | "live";
  /** Attached decoration tables (from ?dec=). */
  attachedDecorations: string[];
  /** Categorical decoration columns discovered from attached tables.
   *  Numeric decoration columns are unsupported in v1. */
  decorationColumns: DecorationColumnEntry[];
  /** Total cell count (parquet length). Used to size the all-passing
   *  initial mask without waiting on /points to load. */
  totalCellCount: number;
  /** Current ?cells= URL value. */
  cellsExpression: string | null;
  onCellsChange: (next: string | null) => void;
  /** Emit the computed mask whenever clauses / column data update. */
  onMaskChange: (mask: FilterMask) => void;
}

/**
 * Clause-editor over the unified `?cells=` filter expression.
 *
 * Each clause fetches its column via `useEmbeddingColumn` and contributes
 * a passing-bitmask to the combined `FilterMask`. Combination is AND —
 * a cell passes only when every clause passes (or is still loading;
 * loading clauses contribute all-passing so the user doesn't see a
 * flapping "everything hidden" state).
 *
 * Filter evaluation is client-side: the column response carries
 * positional values aligned with `/points`, so the mask is one
 * `values[i]` comparison per cell. For 500k cells with 3 clauses this is
 * ~1.5M comparisons per filter edit — fast (<5ms in practice) and
 * avoids a backend round-trip per clause.
 */
export function FeatureFilters({
  embedding,
  ds,
  matVersion,
  attachedDecorations,
  decorationColumns,
  totalCellCount,
  cellsExpression,
  onCellsChange,
  onMaskChange,
}: Props) {
  const clauses = useMemo(() => parseClauses(cellsExpression), [cellsExpression]);

  // Tracks which clause is currently being edited (the "add a clause" UI
  // toggles this). Lives in component state because it's transient; the
  // moment the user picks a column it commits to ?cells= and the
  // open-editor closes.
  const [addingClause, setAddingClause] = useState<boolean>(false);

  // Per-clause column fetches via useQueries (the React-blessed way to
  // run N queries when N is dynamic; calling N hooks via a map() would
  // violate rules-of-hooks). useQueries returns an array of results in
  // the same order as the input.
  const filteredColumnsByClause = useQueries({
    queries: clauses.map((c) => ({
      queryKey: [
        "embedding_column",
        ds,
        embedding.id,
        c.column,
        attachedDecorations.join(","),
        matVersion,
      ],
      queryFn: () =>
        apiFetch<EmbeddingColumnResponse>(
          `/api/v1/datastacks/${ds}/embeddings/${embedding.id}/column/${encodeURI(c.column)}`,
          {
            query: {
              dec: attachedDecorations.length ? attachedDecorations.join(",") : undefined,
              mv: matVersion,
            },
          },
        ),
      enabled: !!c.column,
      staleTime: 5 * 60 * 1000,
    })),
  });

  // Stable digest of the per-clause data references. Spreading
  // `filteredColumnsByClause.map(r => r.data)` into the deps array
  // would change the deps length whenever clauses count changes,
  // which violates the rules-of-hooks. Hash to a string instead so
  // deps stay length-3 across all clause counts.
  const dataDigest = filteredColumnsByClause
    .map((r) => (r.data ? "1" : "0"))
    .join(",");

  // Recompute the mask whenever the underlying column data changes.
  // Effect rather than useMemo so we can emit upward via callback.
  useEffect(() => {
    if (totalCellCount === 0) return;
    const passing = new Array<boolean>(totalCellCount).fill(true);
    for (let ci = 0; ci < clauses.length; ci++) {
      const clause = clauses[ci];
      const result = filteredColumnsByClause[ci];
      if (!result?.data) {
        // Clause not yet loaded — contribute "all passing" so the
        // scatter doesn't flicker into "everything hidden" during load.
        continue;
      }
      const values = result.data.values;
      const match = clauseMatcher(clause, result.data);
      for (let i = 0; i < passing.length; i++) {
        if (passing[i] && !match(values[i])) passing[i] = false;
      }
    }
    const count = passing.reduce((a, b) => a + (b ? 1 : 0), 0);
    onMaskChange({ passing, count });
    // `filteredColumnsByClause` is read via `dataDigest`; that's the
    // stable-length dep that triggers re-runs on column loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCellCount, clauses, dataDigest]);

  const handleClauseEdit = (index: number, patch: Partial<FilterClause>) => {
    const next = clauses.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onCellsChange(serializeClauses(next));
  };

  const handleClauseRemove = (index: number) => {
    const next = clauses.filter((_, i) => i !== index);
    onCellsChange(next.length === 0 ? null : serializeClauses(next));
  };

  const handleClauseAdd = (clause: FilterClause) => {
    onCellsChange(serializeClauses([...clauses, clause]));
    setAddingClause(false);
  };

  return (
    <div className="explore-filters">
      <div className="explore-picker-label">Filters</div>
      {clauses.length === 0 && !addingClause && (
        <div className="explore-filters-empty">No filters. Showing all {totalCellCount} cells.</div>
      )}
      {clauses.map((clause, i) => (
        <ClauseEditor
          key={`${clause.column}-${i}`}
          clause={clause}
          columnData={filteredColumnsByClause[i].data ?? null}
          onChange={(patch) => handleClauseEdit(i, patch)}
          onRemove={() => handleClauseRemove(i)}
        />
      ))}
      {addingClause ? (
        <NewClause
          embedding={embedding}
          decorationColumns={decorationColumns}
          ds={ds}
          matVersion={matVersion}
          attachedDecorations={attachedDecorations}
          onCommit={handleClauseAdd}
          onCancel={() => setAddingClause(false)}
        />
      ) : (
        <button
          type="button"
          className="explore-filters-add"
          onClick={() => setAddingClause(true)}
        >
          + add filter
        </button>
      )}
    </div>
  );
}

// ---- clause editor row -----------------------------------------------------

interface ClauseEditorProps {
  clause: FilterClause;
  columnData: EmbeddingColumnResponse | null;
  onChange: (patch: Partial<FilterClause>) => void;
  onRemove: () => void;
}

function ClauseEditor({ clause, columnData, onChange, onRemove }: ClauseEditorProps) {
  return (
    <div className="explore-filters-clause">
      <div className="explore-filters-clause-head">
        <span className="explore-filters-clause-col" title={clause.column}>
          {clause.column}
        </span>
        <button
          type="button"
          className="explore-filters-clause-remove"
          aria-label={`Remove filter on ${clause.column}`}
          onClick={onRemove}
        >
          ×
        </button>
      </div>
      {clause.op === "eq" ? (
        <CategoricalControl
          clause={clause}
          columnData={columnData}
          onChange={(value) => onChange({ value })}
        />
      ) : (
        <NumericControl
          clause={clause}
          columnData={columnData}
          onChange={(value) => onChange({ value })}
        />
      )}
    </div>
  );
}

function CategoricalControl({
  clause,
  columnData,
  onChange,
}: {
  clause: FilterClause;
  columnData: EmbeddingColumnResponse | null;
  onChange: (next: string) => void;
}) {
  const options = useMemo(() => {
    if (!columnData) return [];
    const seen = new Set<string>();
    for (const v of columnData.values) {
      if (v != null) seen.add(String(v));
    }
    return [...seen].sort();
  }, [columnData]);

  return (
    <select
      className="explore-picker-select"
      value={typeof clause.value === "string" ? clause.value : ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={!columnData}
    >
      {!columnData && <option value="">loading…</option>}
      {columnData && options.length === 0 && <option value="">(no values)</option>}
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

function NumericControl({
  clause,
  columnData,
  onChange,
}: {
  clause: FilterClause;
  columnData: EmbeddingColumnResponse | null;
  onChange: (next: [number, number]) => void;
}) {
  const [min, max] = useMemo(() => extentOf(columnData), [columnData]);
  const value = Array.isArray(clause.value) ? clause.value : [min ?? 0, max ?? 0];

  return (
    <div className="explore-filters-range">
      <input
        type="number"
        value={value[0]}
        step="any"
        onChange={(e) => onChange([Number(e.target.value), value[1]])}
        disabled={!columnData}
      />
      <span>…</span>
      <input
        type="number"
        value={value[1]}
        step="any"
        onChange={(e) => onChange([value[0], Number(e.target.value)])}
        disabled={!columnData}
      />
      {columnData && (
        <span className="explore-filters-range-extent">
          ({min}…{max})
        </span>
      )}
    </div>
  );
}

// ---- "add a clause" form ---------------------------------------------------

interface NewClauseProps {
  embedding: EmbeddingListItem;
  decorationColumns: DecorationColumnEntry[];
  ds: string;
  matVersion: number | "live";
  attachedDecorations: string[];
  onCommit: (clause: FilterClause) => void;
  onCancel: () => void;
}

function NewClause({
  embedding,
  decorationColumns,
  ds: _ds,
  matVersion: _matVersion,
  attachedDecorations: _attachedDecorations,
  onCommit,
  onCancel,
}: NewClauseProps) {
  const [column, setColumn] = useState("");
  // Pre-classify each option's column kind so the commit can pick the
  // right operator without an extra round-trip.
  const options = useMemo(
    () => buildFilterColumnOptions(embedding, decorationColumns),
    [embedding, decorationColumns],
  );
  const selected = options.find((o) => o.value === column);

  return (
    <div className="explore-filters-newclause">
      <select
        className="explore-picker-select"
        value={column}
        onChange={(e) => setColumn(e.target.value)}
        autoFocus
      >
        <option value="">— pick a column —</option>
        {options.map((o) => (
          <optgroup key={o.group} label={o.group}>
            <option value={o.value}>{o.label}</option>
          </optgroup>
        ))}
      </select>
      <div className="explore-filters-newclause-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            // Default starting values: empty string for categorical (the
            // ClauseEditor's select will land on first option); zero
            // range for numeric (extent populates after the column loads).
            const op: FilterClause["op"] = selected.kind === "numeric" ? "between" : "eq";
            const value: FilterClause["value"] = op === "between" ? [0, 0] : "";
            onCommit({ column: selected.value, op, value });
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ---- helpers --------------------------------------------------------------

interface FilterColumnOption {
  value: string;
  label: string;
  kind: "categorical" | "numeric";
  group: string;
}

function buildFilterColumnOptions(
  embedding: EmbeddingListItem,
  decorationColumns: DecorationColumnEntry[],
): FilterColumnOption[] {
  const out: FilterColumnOption[] = [];
  for (const col of embedding.feature_columns ?? []) {
    out.push({ value: col, label: col, kind: "numeric", group: "Numeric (parquet)" });
  }
  for (const col of embedding.categorical_columns ?? []) {
    out.push({ value: col, label: col, kind: "categorical", group: "Categorical (parquet)" });
  }
  for (const dc of decorationColumns) {
    out.push({
      value: `${dc.table}.${dc.column}`,
      label: `${dc.table}.${dc.column}`,
      kind: "categorical",
      group: "Decoration tables",
    });
  }
  return out;
}

function clauseMatcher(
  clause: FilterClause,
  columnData: EmbeddingColumnResponse,
): (v: unknown) => boolean {
  if (clause.op === "eq") {
    const target = typeof clause.value === "string" ? clause.value : "";
    if (target === "") {
      // No target picked yet — treat as "all passing" so the user doesn't
      // see a sudden empty scatter while they configure the clause.
      return () => true;
    }
    return (v) => v != null && String(v) === target;
  }
  // between
  const [min, max] = Array.isArray(clause.value) ? clause.value : [0, 0];
  if (columnData.kind !== "numeric") {
    // Mismatch: a between clause on a non-numeric column shouldn't
    // happen via the UI, but if it does (e.g. user hand-edited URL),
    // fail-open rather than fail-closed.
    return () => true;
  }
  return (v) => typeof v === "number" && v >= min && v <= max;
}

function extentOf(columnData: EmbeddingColumnResponse | null): [number, number] {
  if (!columnData || columnData.kind !== "numeric") return [0, 0];
  let min = Infinity;
  let max = -Infinity;
  for (const v of columnData.values) {
    if (typeof v === "number") {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : [0, 0];
}

// ---- expression parsing ----------------------------------------------------

/**
 * Parse a `?cells=` URL value into clauses. Format mirrors the backend's
 * `CellFilter` parser: comma-separated clauses, each
 * `<column>:<op>:<value>` (between values are `min,max` but commas inside
 * a clause confuse the top-level comma split; we use `;` as the inner
 * separator and translate at the boundary).
 *
 * Unparseable clauses are dropped silently. Saves the scatter from a
 * crash when a user copy-pastes a malformed URL; the visible filter
 * list will just be missing the bad entry.
 */
function parseClauses(raw: string | null): FilterClause[] {
  if (!raw) return [];
  const out: FilterClause[] = [];
  for (const clauseStr of raw.split(",")) {
    const parts = clauseStr.split(":");
    if (parts.length !== 3) continue;
    const [column, op, rawValue] = parts;
    if (op === "eq") {
      out.push({ column, op, value: rawValue });
    } else if (op === "between") {
      const [minRaw, maxRaw] = rawValue.split(";");
      const min = Number(minRaw);
      const max = Number(maxRaw);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        out.push({ column, op, value: [min, max] });
      }
    }
  }
  return out;
}

function serializeClauses(clauses: FilterClause[]): string {
  return clauses
    .map((c) => {
      if (c.op === "eq") return `${c.column}:eq:${c.value}`;
      const [min, max] = c.value as [number, number];
      return `${c.column}:between:${min};${max}`;
    })
    .join(",");
}
