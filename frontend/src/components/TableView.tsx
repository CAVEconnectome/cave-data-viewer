import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTables } from "../api/queries";
import { parseMatVersion, useUrlParam } from "../hooks/useUrlState";
import type { TableListItem } from "../api/types";
import { TableDescription } from "./TableMetadata";

// CAVE descriptions are long enough that showing them inline in full would
// blow the cards out vertically — most are ≥ 200 chars. Cards use a tighter
// preview than the per-table banner because tile width caps the line count
// before content shifts the grid.
const CARD_PREVIEW_CHARS = 180;

export function TableView() {
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const matVersion = parseMatVersion(mv);
  const tables = useTables(ds, matVersion);
  const [filter, setFilter] = useState("");

  // The schema_type chip doubles as a quick-filter trigger — clicking it sets
  // the text filter to the schema name so users can find "every cell_type
  // reference" or "every synapse table" without having to remember names.
  const visible = useMemo(() => {
    if (!tables.data) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return tables.data.tables;
    return tables.data.tables.filter((t) => {
      if (t.name.toLowerCase().includes(needle)) return true;
      if (t.description && t.description.toLowerCase().includes(needle)) return true;
      if (t.schema_type && t.schema_type.toLowerCase().includes(needle)) return true;
      if (t.reference_table && t.reference_table.toLowerCase().includes(needle)) return true;
      return false;
    });
  }, [tables.data, filter]);

  const carry = (table: string) => {
    const params = new URLSearchParams();
    if (ds) params.set("ds", ds);
    if (mv) params.set("mv", mv);
    return `/tables/${encodeURIComponent(table)}?${params}`;
  };

  if (!ds) return <p>Pick a datastack.</p>;

  return (
    <div className="table-view">
      <div className="root-form">
        <label>
          Filter
          <input
            type="text"
            placeholder="search names, descriptions, schema…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            size={42}
          />
        </label>
        <span className="hint">
          {tables.data
            ? `${visible.length} of ${tables.data.tables.length} ${
                tables.data.mat_version === null ? "tables (live)" : "tables + views"
              }`
            : "loading…"}
        </span>
      </div>

      {tables.isFetching && !tables.data && <p>Loading…</p>}
      {tables.error && <p className="error">{(tables.error as Error).message}</p>}

      {tables.data && (
        <div className="tables-grid">
          {visible.map((t) => (
            <TableCard
              key={t.name}
              item={t}
              href={carry(t.name)}
              onSchemaClick={(s) => setFilter(s)}
            />
          ))}
          {visible.length === 0 && (
            <p className="empty">No tables match {`"${filter}"`}.</p>
          )}
        </div>
      )}
    </div>
  );
}

interface TableCardProps {
  item: TableListItem;
  href: string;
  onSchemaClick: (schema: string) => void;
}

function TableCard({ item, href, onSchemaClick }: TableCardProps) {
  return (
    <article className={`table-card kind-${item.kind}`}>
      <header className="table-card-header">
        <Link to={href} className="table-card-title">{item.name}</Link>
        <span className={`chip chip-kind chip-kind-${item.kind}`}>{item.kind}</span>
        {item.schema_type && (
          <button
            type="button"
            className="chip chip-schema"
            onClick={() => onSchemaClick(item.schema_type!)}
            title={`Filter to ${item.schema_type} tables`}
          >
            {item.schema_type}
          </button>
        )}
      </header>

      <TableDescription
        description={item.description}
        previewChars={CARD_PREVIEW_CHARS}
        className="table-card-desc"
        emptyText={item.kind === "view" ? "view (no description available)" : "no description"}
      />

      <footer className="table-card-footer">
        {item.reference_table && (
          <span className="meta" title="reference table this points at">
            ↗ {item.reference_table}
          </span>
        )}
        {item.row_count !== null && item.row_count !== undefined && (
          <span className="meta">
            {item.row_count.toLocaleString()} rows
          </span>
        )}
        {item.voxel_resolution && (
          <span className="meta" title="voxel resolution (nm/voxel)">
            {item.voxel_resolution.join("×")} nm
          </span>
        )}
      </footer>
    </article>
  );
}
