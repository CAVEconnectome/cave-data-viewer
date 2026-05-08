/**
 * Unified column classification used by plot pickers + table filter widgets.
 *
 * Replaces two parallel systems that historically diverged:
 *   - `vizColumns.ts::classifyColumn` (returned "bar" | "histogram" | "exclude")
 *   - `tableColumns.ts::inferKind`   (returned "string" | "category" | "number")
 *
 * The new vocabulary matches the three-tier hue rule (≤12 / 13–30 / >30):
 *
 *   - "categorical-palette":     ≤12 distinct, non-numeric → palette colors
 *   - "categorical-greyscale":   13–30 distinct, non-numeric → greyscale ramp
 *   - "discrete-numeric":        ≤30 distinct, all numeric → bar / category
 *   - "continuous-numeric":      >30 distinct, all numeric → histogram / scale
 *   - "string":                  >30 distinct, non-numeric → free-text search,
 *                                NOT a useful plot binding (excluded from hue/x/y/size)
 *
 * `suitableFor` flags drive picker UIs:
 *   - x:      everything except "string" (id-shaped strings included via the
 *             explicit id-suffix check below — those are also excluded)
 *   - y:      same as x
 *   - hue:    any classified vocabulary except "string"
 *   - size:   numeric only (discrete or continuous)
 *   - weight: numeric only — sums on bar plots; same eligibility as size.
 *
 * Keep this file the single source of truth — when a new use site appears
 * (e.g. a "color-by" channel for histograms), add a flag here, not a parallel
 * heuristic.
 */

export type ColumnVocabulary =
  | "categorical-palette"
  | "categorical-greyscale"
  | "discrete-numeric"
  | "continuous-numeric"
  | "string";

export interface ColumnProfile {
  vocabulary: ColumnVocabulary;
  cardinality: number;        // distinct value count, capped by sample
  isNumeric: boolean;
  isIdShaped: boolean;        // *_id name pattern; opaque, never plotted
  suitableFor: {
    x: boolean;
    y: boolean;
    hue: boolean;
    size: boolean;
    weight: boolean;
  };
}

/** Canonical thresholds — tied to the backend's `_HUE_*_MAX` policy.
 *  Kept aligned: 10 = `--cat-1..--cat-10` and matplotlib's tab10. */
export const PALETTE_MAX_CARDINALITY = 10;
export const CATEGORICAL_MAX_CARDINALITY = 30;

/** Hand-pinned categorical column names (for older datastacks where
 *  inferred cardinality undercounts because the sample is too small). */
const HAND_PINNED_CATEGORIES = new Set(["cell_type", "classification_system", "valence"]);

const NUMBER_INFERENCE_SAMPLE = 50;

function bareName(col: string): string {
  const i = col.indexOf(".");
  return i >= 0 ? col.slice(i + 1) : col;
}

function isIdShaped(col: string): boolean {
  const bare = bareName(col);
  return col === "id" || /_id$/.test(col) || bare === "id" || /_id$/.test(bare);
}

export function classify(col: string, rows: Record<string, unknown>[]): ColumnProfile {
  const bare = bareName(col);
  const idShaped = isIdShaped(col);

  // Walk the column accumulating distinct values + numeric counts. Early
  // exit once we know we're past the cardinality threshold AND have
  // enough numeric/non-numeric evidence to decide the vocabulary.
  const distinct = new Set<unknown>();
  let nNumeric = 0;
  let nNonNull = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    distinct.add(v);
    if (typeof v === "number") nNumeric += 1;
    nNonNull += 1;
    if (distinct.size > CATEGORICAL_MAX_CARDINALITY && nNonNull >= NUMBER_INFERENCE_SAMPLE) break;
  }
  const cardinality = distinct.size;
  const allNumeric = nNonNull > 0 && nNumeric === nNonNull;
  const isHandPinned = HAND_PINNED_CATEGORIES.has(col) || HAND_PINNED_CATEGORIES.has(bare);

  let vocabulary: ColumnVocabulary;
  if (idShaped) {
    vocabulary = "string";
  } else if (nNonNull === 0) {
    // No data sampled — treat as opaque string.
    vocabulary = "string";
  } else if (allNumeric) {
    vocabulary = cardinality <= CATEGORICAL_MAX_CARDINALITY
      ? "discrete-numeric"
      : "continuous-numeric";
  } else if (isHandPinned || cardinality <= PALETTE_MAX_CARDINALITY) {
    vocabulary = "categorical-palette";
  } else if (cardinality <= CATEGORICAL_MAX_CARDINALITY) {
    vocabulary = "categorical-greyscale";
  } else {
    vocabulary = "string";
  }

  const isNumeric = allNumeric;

  return {
    vocabulary,
    cardinality,
    isNumeric,
    isIdShaped: idShaped,
    suitableFor: {
      x: !idShaped && vocabulary !== "string",
      y: !idShaped && vocabulary !== "string",
      hue: !idShaped && vocabulary !== "string",
      size: !idShaped && isNumeric,
      weight: !idShaped && isNumeric,
    },
  };
}

/**
 * Map a ColumnProfile to the legacy table-filter "kind" so existing filter
 * widgets keep working without rewriting their UI:
 *   - id-shaped → "string" (substring search; range filtering on opaque ids
 *     is rarely useful)
 *   - numeric → "number" (range filter `5-10` etc.)
 *   - categorical (any flavor) → "category" (dropdown of distinct values)
 *   - everything else → "string"
 */
export type FilterKind = "string" | "category" | "number";

export function profileToFilterKind(profile: ColumnProfile): FilterKind {
  if (profile.isIdShaped) return "string";
  if (profile.isNumeric) return "number";
  if (profile.vocabulary === "categorical-palette" || profile.vocabulary === "categorical-greyscale") {
    return "category";
  }
  return "string";
}
