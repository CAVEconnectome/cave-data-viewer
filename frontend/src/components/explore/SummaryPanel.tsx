import { useMemo } from "react";
import type { EmbeddingScatterResponse } from "../../api/types";

interface Props {
  /** Universe scatter response — provides `cell_ids` and the bound
   *  color channel's per-point values + color_map. Null while
   *  loading. */
  scatter?: EmbeddingScatterResponse | null;
  /** The highlight set — typically (filter ∩ lasso). Null when nothing
   *  narrows the universe; bars then show universe counts only. */
  highlightedCellIds?: Set<string> | null;
}

interface CategoryRow {
  label: string;
  hex: string;
  universeCount: number;
  highlightCount: number;
}

/**
 * Summary panel for the explorer's left rail.
 *
 * Renders a contextual readout based on what's *currently bound* to
 * the color channel:
 *
 * - **Categorical color** → one bar per category. Bar length scales
 *   to the largest universe count; the highlight portion fills from
 *   the left in the category's color. Lets the user see, at a glance,
 *   "I lassoed mostly L23_PYR cells" or "my filter is biased toward
 *   excitatory neurons."
 *
 * - **Numeric color** → deferred (histogram overlay is a follow-up).
 *
 * - **Nothing bound** → just the highlight/universe count text. Avoids
 *   an empty panel when there's nothing meaningful to summarize.
 *
 * Sits at the bottom of the left rail because the data it presents
 * mirrors what's bound *in the rail* (the color channel). Reading
 * top-to-bottom: pickers → channels → filter → "here's what's in
 * scope right now."
 */
export function SummaryPanel({ scatter, highlightedCellIds }: Props) {
  const totalCells = scatter?.n_cells ?? 0;
  const highlightSize = highlightedCellIds?.size ?? 0;

  // Compute category counts (universe + highlight). Memoized because
  // it's O(n) over potentially 100k+ values; the n_cells/highlight
  // identity captures everything that affects the result.
  const categories = useMemo<CategoryRow[] | null>(() => {
    const color = scatter?.color;
    if (!color || color.kind !== "categorical") return null;
    const cm = color.color_map ?? {};
    const universe = new Map<string, number>();
    const highlight = new Map<string, number>();
    const hl = highlightedCellIds;
    for (let i = 0; i < color.values.length; i++) {
      const raw = color.values[i];
      const key = raw === null || raw === undefined ? "(none)" : String(raw);
      universe.set(key, (universe.get(key) ?? 0) + 1);
      if (hl && hl.has(scatter!.cell_ids[i])) {
        highlight.set(key, (highlight.get(key) ?? 0) + 1);
      }
    }
    const out: CategoryRow[] = [];
    for (const [label, count] of universe.entries()) {
      // Drop the "(none)" / null slot from the displayed rows when it
      // would be visually noisy. Keep it when it's a meaningful slice
      // (>5% of the universe) so the user knows it exists.
      if (label === "(none)" && count / totalCells < 0.05) continue;
      out.push({
        label,
        hex: cm[label] ?? "#dcdcdc",
        universeCount: count,
        highlightCount: highlight.get(label) ?? 0,
      });
    }
    // Sort by universe count desc.
    out.sort((a, b) => b.universeCount - a.universeCount);
    return out;
  }, [scatter, highlightedCellIds, totalCells]);

  if (!scatter) return null;

  const maxUniverse = categories
    ? Math.max(...categories.map((c) => c.universeCount), 1)
    : 1;

  return (
    <div className="summary-panel">
      <div className="explore-picker-label">Summary</div>
      <div className="summary-panel-count">
        {highlightedCellIds && highlightSize > 0 ? (
          <>
            <strong>{highlightSize.toLocaleString()}</strong> of{" "}
            <strong>{totalCells.toLocaleString()}</strong> cells in scope
          </>
        ) : (
          <>
            <strong>{totalCells.toLocaleString()}</strong> cells total
          </>
        )}
      </div>
      {categories && categories.length > 0 && (
        <div
          className="summary-panel-categories"
          title={scatter.color?.column}
        >
          <div className="summary-panel-cat-title">{bareCol(scatter.color!.column)}</div>
          {categories.map((cat) => (
            <SummaryRow key={cat.label} cat={cat} maxUniverse={maxUniverse} />
          ))}
        </div>
      )}
      {scatter.color?.kind === "numeric" && (
        <div className="summary-panel-numeric">
          numeric color — histogram view coming soon
        </div>
      )}
    </div>
  );
}

function SummaryRow({
  cat,
  maxUniverse,
}: {
  cat: CategoryRow;
  maxUniverse: number;
}) {
  const universePct = (cat.universeCount / maxUniverse) * 100;
  const highlightPctOfMax = (cat.highlightCount / maxUniverse) * 100;
  return (
    <div className="summary-row">
      <div className="summary-row-label" title={cat.label}>
        <span
          className="summary-row-swatch"
          style={{ background: cat.hex }}
        />
        <span className="summary-row-name">{cat.label}</span>
      </div>
      <div className="summary-row-bar-wrap">
        <div
          className="summary-row-bar-universe"
          style={{ width: `${universePct}%` }}
        />
        {cat.highlightCount > 0 && (
          <div
            className="summary-row-bar-highlight"
            style={{
              width: `${highlightPctOfMax}%`,
              background: cat.hex,
            }}
          />
        )}
      </div>
      <div className="summary-row-count">
        {cat.highlightCount > 0 ? (
          <>
            {cat.highlightCount.toLocaleString()}
            <span className="summary-row-count-of">/</span>
            {cat.universeCount.toLocaleString()}
          </>
        ) : (
          cat.universeCount.toLocaleString()
        )}
      </div>
    </div>
  );
}

function bareCol(col: string): string {
  const dot = col.indexOf(".");
  return dot >= 0 ? col.slice(dot + 1) : col;
}
