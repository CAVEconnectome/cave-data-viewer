import type { FeatureTableListItem } from "../../api/types";

interface Props {
  featureTables: FeatureTableListItem[];
  value: string | null;
  onChange: (id: string) => void;
}

/**
 * Picker for which feature table the explorer is viewing.
 *
 * v1 manifests typically declare a single feature table per datastack
 * (one parquet, multiple embeddings inside it). For that common case
 * the picker degrades to a static label — no point in a single-option
 * select. Multi-table datastacks render a real `<select>`.
 *
 * Mirrors the EmbeddingPicker rendering convention so the left rail
 * has a consistent shape.
 */
export function FeatureTablePicker({ featureTables, value, onChange }: Props) {
  if (featureTables.length === 0) {
    return (
      <div className="explore-picker explore-picker-empty">
        No feature tables configured.
      </div>
    );
  }
  if (featureTables.length === 1) {
    const ft = featureTables[0];
    return (
      <div className="explore-picker">
        <label className="explore-picker-label">Feature table</label>
        <div
          className="explore-picker-static"
          title={ft.description ?? undefined}
        >
          {ft.title}
        </div>
      </div>
    );
  }
  return (
    <div className="explore-picker">
      <label
        className="explore-picker-label"
        htmlFor="explore-feature-table-select"
      >
        Feature table
      </label>
      <select
        id="explore-feature-table-select"
        className="explore-picker-select"
        value={value ?? ""}
        onChange={(ev) => onChange(ev.target.value)}
      >
        {value == null && <option value="">— pick one —</option>}
        {featureTables.map((ft) => (
          <option
            key={ft.id}
            value={ft.id}
            title={ft.description ?? undefined}
          >
            {ft.title}
          </option>
        ))}
      </select>
    </div>
  );
}
