import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useResolveRoots } from "../../api/embeddings";
import type {
  CellRootResolution,
  EmbeddingColumnBlock,
  EmbeddingPointsResponse,
} from "../../api/types";

interface Props {
  /** Same /points response the scatter draws from. Reusing it means the
   *  table is in lockstep with the plot — no second fetch, no column
   *  drift, and the cached payload covers both. */
  data: EmbeddingPointsResponse | null | undefined;
  ds: string;
  matVersion: number | "live";
  embeddingId: string;
  /** Focus cell highlights as a stickied / accent-bordered row. */
  focusCellId: string | null;
  /** Lasso/box selection from the scatter. When non-empty, the table
   *  filters to just these cell_ids (the "brush masks the table"
   *  behavior). User clears via the "Show all" affordance in the
   *  header so unfiltering doesn't require another lasso. */
  brushCellIds: string[];
  /** Clicking a row focuses its cell in the scatter. */
  onCellClick: (cellId: string) => void;
  onClearBrush: () => void;
  /** Same href factory as SelectionPane: preserves ds/mv/dec/cells
   *  and sets ?root + ?from=explore:<emb>. Passed in so the table
   *  doesn't duplicate the URL-shaping logic. */
  buildNeuronHref: (rootId: string) => string;
}

type SortDir = "asc" | "desc";
type SortState = { columnKey: string; dir: SortDir } | null;

const PAGE_SIZE = 100;

/**
 * Sortable table view of the cells in the current /points response.
 *
 * Columns are derived from whatever channels the user has bound on the
 * scatter (cell_id is always present; x / y / color / size each
 * contribute a column when active). Sortable by clicking a header; null
 * values sort to the end regardless of direction.
 *
 * Bidirectional interactions with the scatter:
 *   - Lasso/box on the scatter (?sel=) → rows here filter down to that
 *     set so the user can sort + jump into one of the lassoed cells.
 *   - Click a row here → ?cell= sets, the scatter's focus marker
 *     follows. The focused row stays highlighted in the table.
 *
 * Per-row "→" cross-navs to /neuron via the resolver (same shape as
 * SelectionPane). Rows whose cell_id can't be resolved at the current
 * mat_version render the arrow greyed-out with a tooltip — better than
 * sending the user to a 404.
 */
export function ExplorerTable({
  data,
  ds,
  matVersion,
  embeddingId,
  focusCellId,
  brushCellIds,
  onCellClick,
  onClearBrush,
  buildNeuronHref,
}: Props) {
  const [sort, setSort] = useState<SortState>(null);
  const [pageCount, setPageCount] = useState(1);

  // Derive the column descriptors from the currently-bound channels.
  // cell_id always appears; the active channels (x, y, color, size)
  // contribute one column each — this is the v1 column set; a "+ add
  // column" picker is a near-term follow-up.
  const columns = useMemo(() => buildColumns(data), [data]);

  // Build row data once. Each row is `{cellId, values: {channelKey: v}}`
  // — the lookup is by channel key so sort comparators can index it
  // without scanning the column list.
  const allRows = useMemo(() => buildRows(data, columns), [data, columns]);

  // Apply the brush filter. When ?sel is empty, the full row set is
  // visible; non-empty narrows to just those cell_ids.
  const filteredRows = useMemo(() => {
    if (brushCellIds.length === 0) return allRows;
    const allowed = new Set(brushCellIds);
    return allRows.filter((r) => allowed.has(r.cellId));
  }, [allRows, brushCellIds]);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    return sortRows(filteredRows, sort);
  }, [filteredRows, sort]);

  const visibleRows = useMemo(
    () => sortedRows.slice(0, pageCount * PAGE_SIZE),
    [sortedRows, pageCount],
  );

  // Batched cell_id -> root_id resolution for ONLY the visible rows.
  // Re-runs when paging or sorting changes the visible window; the
  // TanStack-Query cache holds resolutions across windows so paging
  // forward and back doesn't refetch.
  const visibleCellIds = useMemo(
    () => visibleRows.map((r) => r.cellId),
    [visibleRows],
  );
  const resolveQuery = useResolveRoots(
    visibleCellIds.length > 0
      ? { ds, embeddingId, matVersion, cellIds: visibleCellIds }
      : null,
  );
  const resolutionByCellId = useMemo(() => {
    const m = new Map<string, CellRootResolution>();
    for (const r of resolveQuery.data?.resolutions ?? []) {
      m.set(r.cell_id, r);
    }
    return m;
  }, [resolveQuery.data]);

  if (!data) {
    return <div className="explore-table-empty">Loading rows…</div>;
  }

  return (
    <div className="explore-table-wrap">
      <header className="explore-table-header">
        <span>
          {filteredRows.length.toLocaleString()} of {allRows.length.toLocaleString()} cell
          {allRows.length === 1 ? "" : "s"}
          {brushCellIds.length > 0 && " (filtered by brush)"}
        </span>
        {brushCellIds.length > 0 && (
          <button
            type="button"
            className="explore-table-clear-brush"
            onClick={onClearBrush}
          >
            Show all
          </button>
        )}
      </header>
      <div className="explore-table-scroll">
        <table className="explore-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`explore-table-head ${
                    sort?.columnKey === col.key ? `sort-${sort.dir}` : ""
                  }`}
                  onClick={() => {
                    setSort((prev) => {
                      if (prev?.columnKey !== col.key) return { columnKey: col.key, dir: "asc" };
                      if (prev.dir === "asc") return { columnKey: col.key, dir: "desc" };
                      return null;  // third click clears the sort
                    });
                  }}
                  title={col.label}
                >
                  {col.label}
                  {sort?.columnKey === col.key && (
                    <span className="explore-table-sort-arrow">
                      {sort.dir === "asc" ? " ▲" : " ▼"}
                    </span>
                  )}
                </th>
              ))}
              <th className="explore-table-head explore-table-action-head" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const resolution = resolutionByCellId.get(row.cellId) ?? null;
              const isFocused = row.cellId === focusCellId;
              return (
                <Row
                  key={row.cellId}
                  row={row}
                  columns={columns}
                  isFocused={isFocused}
                  resolution={resolution}
                  resolving={resolveQuery.isPending}
                  buildNeuronHref={buildNeuronHref}
                  onCellClick={onCellClick}
                />
              );
            })}
          </tbody>
        </table>
        {sortedRows.length > visibleRows.length && (
          <div className="explore-table-pager">
            <button
              type="button"
              className="explore-table-show-more"
              onClick={() => setPageCount((n) => n + 1)}
            >
              Show {Math.min(PAGE_SIZE, sortedRows.length - visibleRows.length)} more
              <span className="explore-table-pager-total">
                {" "}({visibleRows.length} / {sortedRows.length})
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- columns + rows -------------------------------------------------------

interface ColumnDescriptor {
  key: string;
  label: string;
  kind: "id" | "categorical" | "numeric";
}

interface RowData {
  cellId: string;
  values: Record<string, string | number | boolean | null>;
}

function buildColumns(data: EmbeddingPointsResponse | null | undefined): ColumnDescriptor[] {
  if (!data) return [{ key: "cell_id", label: "cell_id", kind: "id" }];
  const cols: ColumnDescriptor[] = [
    { key: "cell_id", label: "cell_id", kind: "id" },
  ];
  const addChannel = (block: EmbeddingColumnBlock | undefined, prefix: string) => {
    if (!block) return;
    cols.push({
      key: `${prefix}:${block.column}`,
      label: `${block.column} (${prefix})`,
      kind: block.kind,
    });
  };
  addChannel(data.x, "x");
  addChannel(data.y, "y");
  addChannel(data.color, "color");
  addChannel(data.size, "size");
  return cols;
}

function buildRows(
  data: EmbeddingPointsResponse | null | undefined,
  columns: ColumnDescriptor[],
): RowData[] {
  if (!data) return [];
  // Build a per-channel-key → values array lookup once. Each row's
  // value pluck is then an O(1) indexed read.
  const channelArrays = new Map<string, Array<string | number | boolean | null>>();
  if (data.x) channelArrays.set(`x:${data.x.column}`, data.x.values);
  if (data.y) channelArrays.set(`y:${data.y.column}`, data.y.values);
  if (data.color) channelArrays.set(`color:${data.color.column}`, data.color.values);
  if (data.size) channelArrays.set(`size:${data.size.column}`, data.size.values);

  const channelCols = columns.filter((c) => c.key !== "cell_id");
  return data.cell_ids.map((cellId, i) => {
    const values: RowData["values"] = {};
    for (const col of channelCols) {
      const arr = channelArrays.get(col.key);
      values[col.key] = arr ? arr[i] : null;
    }
    return { cellId, values };
  });
}

function sortRows(rows: RowData[], sort: NonNullable<SortState>): RowData[] {
  const { columnKey, dir } = sort;
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (columnKey === "cell_id") {
      // Sort cell_ids as integers, not lexicographically. Less surprising
      // because the user reads cell_ids as numbers throughout the rest of
      // the app.
      const ai = Number(a.cellId);
      const bi = Number(b.cellId);
      if (Number.isFinite(ai) && Number.isFinite(bi)) return (ai - bi) * factor;
      return a.cellId.localeCompare(b.cellId) * factor;
    }
    const av = a.values[columnKey];
    const bv = b.values[columnKey];
    // Null sorts to the end regardless of direction — surfaces the
    // populated values first whether the user wanted ascending or
    // descending, which is consistent with seaborn/pandas defaults.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
    return String(av).localeCompare(String(bv)) * factor;
  });
}

// ---- row component ---------------------------------------------------------

interface RowProps {
  row: RowData;
  columns: ColumnDescriptor[];
  isFocused: boolean;
  resolution: CellRootResolution | null;
  resolving: boolean;
  buildNeuronHref: (rootId: string) => string;
  onCellClick: (cellId: string) => void;
}

function Row({
  row,
  columns,
  isFocused,
  resolution,
  resolving,
  buildNeuronHref,
  onCellClick,
}: RowProps) {
  const status = resolution?.status;
  const canNavigate = !!resolution && status === "ok" && !!resolution.root_id;
  return (
    <tr
      className={`explore-table-row ${isFocused ? "is-focused" : ""}`}
      onClick={() => onCellClick(row.cellId)}
    >
      {columns.map((col) => {
        if (col.key === "cell_id") {
          return (
            <td key={col.key} className="explore-table-cell explore-table-cell-id">
              {row.cellId}
            </td>
          );
        }
        const v = row.values[col.key];
        return (
          <td
            key={col.key}
            className={`explore-table-cell explore-table-cell-${col.kind}`}
            title={v == null ? "(null)" : String(v)}
          >
            {renderValue(v, col.kind)}
          </td>
        );
      })}
      <td
        className="explore-table-cell explore-table-action-cell"
        onClick={(e) => e.stopPropagation()}  // don't double-trigger row focus
      >
        {canNavigate ? (
          <Link
            to={buildNeuronHref(resolution!.root_id!)}
            className="explore-table-nav"
            title={`Open /neuron for root_id ${resolution!.root_id}`}
          >
            →
          </Link>
        ) : (
          <span
            className="explore-table-nav explore-table-nav-disabled"
            title={
              resolving
                ? "Resolving root_id…"
                : status === "missing"
                ? "No current root_id at this mat_version"
                : status === "ambiguous"
                ? "Resolves to multiple roots; cross-nav disabled"
                : ""
            }
          >
            {resolving ? "…" : status === "ambiguous" ? "⚠" : "—"}
          </span>
        )}
      </td>
    </tr>
  );
}

function renderValue(
  v: string | number | boolean | null,
  kind: ColumnDescriptor["kind"],
): string {
  if (v == null) return "—";
  if (kind === "numeric" && typeof v === "number") {
    // Trim long fractional tails — 8 digits is enough resolution for any
    // morphology feature without overflowing a narrow cell.
    if (Math.abs(v) < 1e-4 || Math.abs(v) > 1e6) return v.toExponential(2);
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  return String(v);
}
