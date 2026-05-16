import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnGroup, FeatureTableListItem } from "../../api/types";

export interface ColumnPickerOption {
  /** Dotted column path used in URL state and `useEmbeddingColumn` keys. */
  value: string;
  /** Bare column name shown in the row. */
  label: string;
  /** Source section the column is grouped under (category title,
   *  "Uncategorized", a decoration table name, or "nucleus"). */
  section: string;
  /** Whether the column is numeric. ``undefined`` means unknown — the
   *  source didn't declare it (decoration columns) so callers that only
   *  accept numeric should treat unknown as "let the user try and
   *  surface the error if it fails." */
  isNumeric?: boolean;
  /** Optional tooltip for the row (e.g. category description). */
  description?: string | null;
}

interface Props {
  featureTable: FeatureTableListItem | null;
  /** Column_groups from the /cells response. Lets the picker surface
   *  attached decoration tables alongside parquet columns. */
  cellsColumnGroups?: ColumnGroup[];
  /** Columns the caller has already picked. Greyed out (still
   *  clickable to remove, depending on the consumer). */
  selectedValues: ReadonlySet<string>;
  /** Restrict to numeric columns. Categoricals are still rendered
   *  but disabled with a tooltip so users see the option exists. */
  numericOnly?: boolean;
  onAdd: (value: string) => void;
  onRemove?: (value: string) => void;
  onClose?: () => void;
}

/**
 * Picker for binding additional columns into a multi-column surface
 * (manual histograms in the summary panel, future "feature subset for
 * kNN" picker, etc).
 *
 * Surface vs `ChannelPicker`:
 * - `ChannelPicker` is a one-column picker per channel (x/y/color/size)
 *   rendered as a single `<select>`. The user binds one column per
 *   channel and switches between them.
 * - `ColumnPicker` is multi-add: the user mounts N columns one at a
 *   time (or whole categories at once). Lives inside a popover with a
 *   search box + category sections + per-category "add all" action.
 *
 * Both consume the same `categories` declaration on `FeatureTableListItem`,
 * so a manifest's category structure drives both surfaces. The picker
 * also surfaces decoration tables from `cellsColumnGroups` as their own
 * sections — the user can mount a histogram of any column the cell
 * list shows.
 *
 * Mass selection: each section header has an "add all" link that emits
 * `onAdd` for every option in the section not currently in
 * `selectedValues`. Combined with `numericOnly`, this lets a user
 * mount "all morphology features as histograms" in one click.
 */
export function ColumnPicker({
  featureTable,
  cellsColumnGroups,
  selectedValues,
  numericOnly = false,
  onAdd,
  onRemove,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — same affordance as ChannelMenu /
  // ColormapPicker so the popover behavior is consistent app-wide.
  useEffect(() => {
    if (!onClose) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Build the section → options layout. Same column-routing logic as
  // ChannelPicker so the two surfaces stay in sync as the manifest
  // changes.
  const sections = useMemo(() => {
    const out: { section: string; description: string | null; options: ColumnPickerOption[] }[] = [];
    if (!featureTable) return out;

    const numericSet = new Set(featureTable.feature_columns ?? []);
    const categoricalSet = new Set(featureTable.categorical_columns ?? []);
    const allParquet = Array.from(new Set([...numericSet, ...categoricalSet]));

    const makeOption = (
      col: string,
      section: string,
      description: string | null,
    ): ColumnPickerOption => ({
      value: `${featureTable.id}.${col}`,
      label: col,
      section,
      description,
      isNumeric: numericSet.has(col)
        ? true
        : categoricalSet.has(col)
          ? false
          : undefined,
    });

    const categories = featureTable.categories ?? [];
    if (categories.length > 0) {
      const referenced = new Set<string>();
      for (const cat of categories) {
        const opts: ColumnPickerOption[] = [];
        for (const col of cat.columns) {
          if (!allParquet.includes(col)) continue;
          referenced.add(col);
          opts.push(makeOption(col, cat.title, cat.description ?? null));
        }
        if (opts.length > 0) {
          out.push({
            section: cat.title,
            description: cat.description ?? null,
            options: opts,
          });
        }
      }
      const uncategorized = allParquet.filter((c) => !referenced.has(c));
      if (uncategorized.length > 0) {
        out.push({
          section: "Uncategorized",
          description: null,
          options: uncategorized.map((c) => makeOption(c, "Uncategorized", null)),
        });
      }
    } else {
      const numeric = featureTable.feature_columns ?? [];
      const categorical = featureTable.categorical_columns ?? [];
      if (numeric.length > 0) {
        out.push({
          section: "features",
          description: null,
          options: numeric.map((c) => makeOption(c, "features", null)),
        });
      }
      if (categorical.length > 0) {
        out.push({
          section: "categoricals",
          description: null,
          options: categorical.map((c) => makeOption(c, "categoricals", null)),
        });
      }
    }

    // Synthetic nucleus position columns + decoration tables, surfaced
    // via /cells column_groups. nucleus.* are numeric; decoration
    // columns are unknown-numeric (we don't sample them at picker time).
    const seenDecorationCols = new Set<string>();
    for (const g of cellsColumnGroups ?? []) {
      if (g.kind !== "table") continue;
      if (g.name === featureTable.id) continue;
      const opts: ColumnPickerOption[] = [];
      for (const fullCol of g.columns) {
        if (seenDecorationCols.has(fullCol)) continue;
        seenDecorationCols.add(fullCol);
        const bare = fullCol.includes(".")
          ? fullCol.slice(fullCol.indexOf(".") + 1)
          : fullCol;
        opts.push({
          value: fullCol,
          label: bare,
          section: g.name,
          isNumeric: g.name === "nucleus" ? true : undefined,
        });
      }
      if (opts.length > 0) {
        out.push({ section: g.name, description: null, options: opts });
      }
    }

    return out;
  }, [featureTable, cellsColumnGroups]);

  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((s) => ({
        ...s,
        options: s.options.filter((o) =>
          o.label.toLowerCase().includes(q) ||
          o.section.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.options.length > 0);
  }, [sections, query]);

  const addAllInSection = (opts: ColumnPickerOption[]) => {
    for (const o of opts) {
      if (selectedValues.has(o.value)) continue;
      if (numericOnly && o.isNumeric === false) continue;
      onAdd(o.value);
    }
  };

  return (
    <div ref={containerRef} className="column-picker">
      <div className="column-picker-header">
        <input
          type="text"
          className="column-picker-search"
          placeholder="filter columns…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        {onClose && (
          <button
            type="button"
            className="column-picker-close"
            onClick={onClose}
            title="Close"
          >
            ×
          </button>
        )}
      </div>
      <div className="column-picker-body">
        {visibleSections.length === 0 && (
          <div className="column-picker-empty">no matching columns</div>
        )}
        {visibleSections.map((s) => {
          const addable = s.options.filter(
            (o) =>
              !selectedValues.has(o.value) &&
              !(numericOnly && o.isNumeric === false),
          );
          return (
            <div key={s.section} className="column-picker-section">
              <div className="column-picker-section-header">
                <span
                  className="column-picker-section-title"
                  title={s.description ?? undefined}
                >
                  {s.section}
                </span>
                {addable.length > 1 && (
                  <button
                    type="button"
                    className="column-picker-add-all"
                    onClick={() => addAllInSection(s.options)}
                    title={`Add all ${addable.length} columns in ${s.section}`}
                  >
                    + add all
                  </button>
                )}
              </div>
              <div className="column-picker-section-rows">
                {s.options.map((o) => {
                  const isSelected = selectedValues.has(o.value);
                  const disallowed = numericOnly && o.isNumeric === false;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      className={`column-picker-row${
                        isSelected ? " selected" : ""
                      }${disallowed ? " disallowed" : ""}`}
                      title={
                        disallowed
                          ? "Categorical column — histograms require numeric"
                          : isSelected
                            ? onRemove
                              ? "Click to remove"
                              : "Already added"
                            : "Click to add"
                      }
                      disabled={disallowed || (isSelected && !onRemove)}
                      onClick={() => {
                        if (disallowed) return;
                        if (isSelected) {
                          if (onRemove) onRemove(o.value);
                        } else {
                          onAdd(o.value);
                        }
                      }}
                    >
                      <span className="column-picker-row-mark">
                        {isSelected ? "✓" : "+"}
                      </span>
                      <span className="column-picker-row-label">{o.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
