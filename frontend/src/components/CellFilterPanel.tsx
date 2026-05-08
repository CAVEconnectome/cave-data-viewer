import { useMemo, useState } from "react";
import { useUrlParam } from "../hooks/useUrlState";
import type { ColumnGroup, PartnerRecord } from "../api/types";

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notin", "nonnull", "null"] as const;
type Op = (typeof OPS)[number];

// Ops the picker exposes per inferred column kind. Numeric gets the full
// comparator set; strings get equality + membership only (range filters on
// strings are rarely useful and trip users up); booleans collapse to four
// pseudo-ops in the UI (handled separately, not in this map).
type ColumnKind = "boolean" | "numeric" | "string" | "unknown";

const OPS_FOR_KIND: Record<Exclude<ColumnKind, "boolean">, readonly Op[]> = {
  numeric: ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notin", "null", "nonnull"],
  string: ["eq", "ne", "in", "notin", "null", "nonnull"],
  // No type evidence — show everything so the user can still build a predicate.
  unknown: OPS,
};

// Boolean columns get a single "predicate" select with four mutually-exclusive
// options that map to backend op+value pairs. Avoids the awkward "eq + true"
// flow when the answer space is so small.
const BOOL_PREDICATES = [
  { label: "is true", op: "eq" as Op, value: "true" },
  { label: "is false", op: "eq" as Op, value: "false" },
  { label: "is null", op: "null" as Op, value: "" },
  { label: "is not null", op: "nonnull" as Op, value: "" },
];

/**
 * Sniff a column's type from a small sample of partner rows. Cheap because
 * partners arrays are bounded and we only inspect non-null cells until we
 * have enough evidence to decide. Falls back to "unknown" when the sample is
 * empty (e.g. column was just added to decoration_tables and no rows have
 * a value yet).
 */
function inferColumnKind(rows: PartnerRecord[], qualifiedKey: string): ColumnKind {
  let nNumeric = 0;
  let nBool = 0;
  let nString = 0;
  let nNonNull = 0;
  const SAMPLE_LIMIT = 200;
  for (let i = 0; i < rows.length && nNonNull < SAMPLE_LIMIT; i += 1) {
    const v = rows[i][qualifiedKey];
    if (v === null || v === undefined) continue;
    nNonNull += 1;
    if (typeof v === "boolean") nBool += 1;
    else if (typeof v === "number") nNumeric += 1;
    else nString += 1;
  }
  if (nNonNull === 0) return "unknown";
  if (nBool === nNonNull) return "boolean";
  if (nNumeric === nNonNull) return "numeric";
  if (nString === nNonNull) return "string";
  return "unknown";
}

interface Predicate {
  table: string;
  column: string;
  op: Op;
  value: string;
  /** When false, the predicate is encoded with a leading `~` so the backend
   *  parser drops it. Lets users build a filter, toggle it off to compare,
   *  then toggle it back on without retyping. */
  enabled: boolean;
}

// Parse `?cells=table.col:op:val[,table.col:op:val...]` into structured
// predicates. Mirrors the backend parser in services/plots.py — keeping the
// two in sync is the cost of a URL-driven design, but the gain is that the
// URL is the single source of truth and shareable. A leading `~` on a clause
// marks it disabled (parsed but ignored by the backend).
function parseCells(raw: string | null): Predicate[] {
  if (!raw) return [];
  const out: Predicate[] = [];
  for (const clause of raw.split(",")) {
    let trimmed = clause.trim();
    if (!trimmed) continue;
    let enabled = true;
    if (trimmed.startsWith("~")) {
      enabled = false;
      trimmed = trimmed.slice(1).trim();
      if (!trimmed) continue;
    }
    const firstColon = trimmed.indexOf(":");
    if (firstColon < 0) continue;
    const head = trimmed.slice(0, firstColon);
    const rest = trimmed.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    const opStr = secondColon < 0 ? rest : rest.slice(0, secondColon);
    const value = secondColon < 0 ? "" : rest.slice(secondColon + 1);
    const dot = head.indexOf(".");
    if (dot < 0) continue;
    const table = head.slice(0, dot);
    const column = head.slice(dot + 1);
    if (!table || !column || !OPS.includes(opStr as Op)) continue;
    out.push({ table, column, op: opStr as Op, value, enabled });
  }
  return out;
}

function encodeCells(preds: Predicate[]): string | null {
  if (preds.length === 0) return null;
  return preds
    .map((p) => `${p.enabled ? "" : "~"}${p.table}.${p.column}:${p.op}:${p.value}`)
    .join(",");
}

interface Props {
  // The connectivity bundle's column_groups; we surface decoration / cell-type
  // groups as the picker's table choices. Synapse / intrinsic / soma columns
  // aren't exposed here — they aren't `<table>.<col>` qualified, so the
  // backend parser would reject them.
  columnGroups?: ColumnGroup[];
  // Sample rows for column-type inference. Pass partners_in + partners_out
  // (or any subset). Used purely to decide which ops the picker exposes —
  // the actual filter still runs server-side.
  sampleRows?: PartnerRecord[];
}

/**
 * Sidebar panel for the global "cells" plot filter.
 *
 * Predicates are encoded into the `?cells=` URL param so the filter is part
 * of every shared link. Chips show the active predicates with a × to remove;
 * the + button opens a small builder for a new predicate (table → column →
 * op → value). The full predicate text is the chip label so users learn the
 * grammar by reading their own filters.
 */
export function CellFilterPanel({ columnGroups, sampleRows }: Props) {
  const [raw, setRaw] = useUrlParam("cells");
  const preds = useMemo(() => parseCells(raw), [raw]);
  const [adding, setAdding] = useState(false);

  // Annotation-table groups own the dotted column names that the backend
  // parser expects. Synapse / intrinsic / soma columns are excluded — they
  // aren't qualified by a table prefix.
  const tableGroups = useMemo(
    () => (columnGroups ?? []).filter((g) => g.kind === "table"),
    [columnGroups],
  );

  const removePredicate = (i: number) => {
    const next = preds.filter((_, j) => j !== i);
    setRaw(encodeCells(next));
  };
  const togglePredicate = (i: number) => {
    const next = preds.map((p, j) => (j === i ? { ...p, enabled: !p.enabled } : p));
    setRaw(encodeCells(next));
  };
  // New predicates default to enabled — the typical workflow is "build a
  // filter, see the result". Disable is a follow-up action via chip click.
  const addPredicate = (p: Omit<Predicate, "enabled">) => {
    setRaw(encodeCells([...preds, { ...p, enabled: true }]));
    setAdding(false);
  };

  return (
    <div className="cell-filter-panel">
      <div className="cell-filter-header">
        <span>Cell filter</span>
        {!adding && (
          <button
            type="button"
            className="cell-filter-add"
            onClick={() => setAdding(true)}
            disabled={tableGroups.length === 0}
            title={
              tableGroups.length === 0
                ? "Load a decoration table first"
                : "Add a predicate"
            }
          >+</button>
        )}
      </div>
      {preds.length === 0 && !adding && (
        <div className="cell-filter-empty">no filter</div>
      )}
      {preds.length > 0 && (
        <div className="cell-filter-chips">
          {preds.map((p, i) => (
            <span
              key={i}
              className={`cell-filter-chip${p.enabled ? "" : " disabled"}`}
            >
              <button
                type="button"
                className="chip-text"
                onClick={() => togglePredicate(i)}
                title={p.enabled ? "Click to disable" : "Click to enable"}
              >
                {p.table}.{p.column} {p.op}
                {p.op !== "nonnull" && p.op !== "null" ? ` ${p.value}` : ""}
              </button>
              <button
                type="button"
                onClick={() => removePredicate(i)}
                aria-label="remove"
                title="Remove this predicate"
              >×</button>
            </span>
          ))}
        </div>
      )}
      {adding && (
        <PredicateBuilder
          tableGroups={tableGroups}
          sampleRows={sampleRows ?? []}
          onCancel={() => setAdding(false)}
          onAdd={addPredicate}
        />
      )}
    </div>
  );
}

interface BuilderProps {
  tableGroups: ColumnGroup[];
  sampleRows: PartnerRecord[];
  onCancel: () => void;
  onAdd: (p: Omit<Predicate, "enabled">) => void;
}

// Bare column name from a possibly-dotted column key. Decoration columns ship
// as `<table>.<col>` in column_groups; cell-type columns sometimes ship bare.
function bareColumn(c: string): string {
  return c.includes(".") ? c.split(".").slice(1).join(".") : c;
}

function PredicateBuilder({ tableGroups, sampleRows, onCancel, onAdd }: BuilderProps) {
  const [table, setTable] = useState(tableGroups[0]?.name ?? "");
  const tableCols = useMemo(() => {
    const group = tableGroups.find((g) => g.name === table);
    if (!group) return [] as string[];
    return group.columns.map(bareColumn);
  }, [tableGroups, table]);
  const [column, setColumn] = useState(tableCols[0] ?? "");
  const [op, setOp] = useState<Op>("eq");
  const [value, setValue] = useState("");
  // Boolean-mode pseudo-op index (into BOOL_PREDICATES). Only consulted when
  // the picked column's inferred kind is "boolean".
  const [boolIdx, setBoolIdx] = useState(0);

  const columnKind = useMemo<ColumnKind>(() => {
    if (!table || !column) return "unknown";
    return inferColumnKind(sampleRows, `${table}.${column}`);
  }, [sampleRows, table, column]);

  const onTableChange = (next: string) => {
    setTable(next);
    const cols = (tableGroups.find((g) => g.name === next)?.columns ?? []).map(bareColumn);
    setColumn(cols[0] ?? "");
    setOp("eq");
    setValue("");
    setBoolIdx(0);
  };

  const onColumnChange = (next: string) => {
    setColumn(next);
    setOp("eq");
    setValue("");
    setBoolIdx(0);
  };

  const valueDisabled = op === "nonnull" || op === "null";
  const isBoolean = columnKind === "boolean";
  const canSubmit = table && column && (isBoolean || op && (valueDisabled || value !== ""));
  const allowedOps = isBoolean
    ? []  // boolean uses the BOOL_PREDICATES select instead of an op + value pair
    : OPS_FOR_KIND[columnKind];

  return (
    <form
      className="cell-filter-builder"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        if (isBoolean) {
          const choice = BOOL_PREDICATES[boolIdx];
          onAdd({ table, column, op: choice.op, value: choice.value });
        } else {
          onAdd({ table, column, op, value: valueDisabled ? "" : value });
        }
      }}
    >
      <select value={table} onChange={(e) => onTableChange(e.target.value)}>
        {tableGroups.map((g) => (
          <option key={g.name} value={g.name}>{g.name}</option>
        ))}
      </select>
      <select value={column} onChange={(e) => onColumnChange(e.target.value)}>
        {tableCols.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      {isBoolean ? (
        // Boolean: a single 4-option select replaces the op+value pair. Reads
        // naturally as "field <choice>" which is what the user asked for.
        <select value={boolIdx} onChange={(e) => setBoolIdx(Number(e.target.value))}>
          {BOOL_PREDICATES.map((p, i) => (
            <option key={i} value={i}>{p.label}</option>
          ))}
        </select>
      ) : (
        <>
          <select value={op} onChange={(e) => setOp(e.target.value as Op)}>
            {allowedOps.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <input
            type={columnKind === "numeric" && op !== "in" && op !== "notin" ? "number" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={valueDisabled}
            placeholder={op === "in" || op === "notin" ? "a|b|c" : "value"}
            size={10}
            // Numeric inputs accept any precision; don't force step.
            step={columnKind === "numeric" && op !== "in" && op !== "notin" ? "any" : undefined}
          />
        </>
      )}
      <button type="submit" disabled={!canSubmit}>add</button>
      <button type="button" onClick={onCancel}>cancel</button>
    </form>
  );
}
