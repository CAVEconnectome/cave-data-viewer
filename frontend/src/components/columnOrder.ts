/**
 * Column ordering for the per-table view.
 *
 * Tables come back from CAVE in schema-definition order, which is fine for
 * data layout but not for human reading: bookkeeping columns (`created`,
 * `valid`, bounding boxes) crowd out the columns people actually scan
 * (segment ids, points, payload values). This module imposes an opinionated
 * order so the most-useful-to-look-at columns sit on the left.
 *
 * The order is, left to right:
 *
 *   1. `id`                — primary key
 *   2. `*_root_id`         — segment ids, sorted alphabetically by prefix
 *   3. `*_supervoxel_id`   — supervoxel ids, same sort
 *   4. `*_position_x/y/z`  — point positions, by prefix then axis
 *   5. numeric columns     — sorted alphabetically
 *   6. string/categorical  — sorted alphabetically
 *   7. boolean columns     — sorted alphabetically
 *   8. demoted bookkeeping — `bb_start_position_*`, `bb_end_position_*`,
 *                            `created`, `created_ref`, `mat_create_time`,
 *                            `mat_create_time_ref`, `superceded_id`
 *
 * Dropped entirely: `target_id`, `valid`, `valid_ref`, `expired`
 *   - `target_id`: in a reference table this is just `id` again — the FK
 *     happens to point at the same row that owns it.
 *   - `valid`, `valid_ref`, `expired`: bookkeeping flags from the dynamic
 *     annotation engine, almost always trivially `true`/`false` and not
 *     useful for people browsing the data.
 *
 * The bucketing keys off column NAME for the structural buckets (id /
 * root_id / supervoxel / position) and only falls through to data-kind
 * inference for the leftover columns. That way a sparse sample of rows
 * doesn't accidentally re-bucket a `pre_pt_position_x` column into "string"
 * just because every row in the sample happened to be null.
 */

const DROPPED_COLUMNS = new Set([
  "target_id",      // always equals id in reference tables
  "valid",          // dynamic-annotation bookkeeping
  "valid_ref",
  "expired",        // live-mode counterpart to valid
]);

const DEMOTED_NAMES = new Set([
  "created",
  "created_ref",
  "mat_create_time",
  "mat_create_time_ref",
  // `superceded_id` is stripped server-side in the /rows endpoint, so it
  // shouldn't reach this code at all — listing it here would just be noise.
]);

const DEMOTED_PREFIXES = ["bb_start_position_", "bb_end_position_"];

const POSITION_SUFFIX = /^(.+)_position_([xyz])$/;
const ROOT_ID_SUFFIX = /^(.*)_root_id$/;
// Match both `_supervoxel_id` (CAVE canonical) and `_supervoxel` (occasional
// alias seen in older views) so the bucket catches either spelling.
const SUPERVOXEL_SUFFIX = /^(.*)_supervoxel(?:_id)?$/;

const BUCKET_ORDER = [
  "id",
  "root_id",
  "supervoxel",
  "position",
  "number",
  "string",
  "boolean",
  "demoted",
] as const;
export type Bucket = (typeof BUCKET_ORDER)[number];

/** Friendly group labels shown in the table header. Keep these short — they
 *  span their column count in the top header row, but a single-column group
 *  (e.g. just `id`) still has to fit its label without wrapping. */
export const BUCKET_LABELS: Record<Bucket, string> = {
  id: "id",
  root_id: "segments",
  supervoxel: "supervoxels",
  position: "positions",
  number: "metrics",
  string: "labels",
  boolean: "flags",
  demoted: "bookkeeping",
};

/** Buckets that start collapsed by default. The bookkeeping group is large,
 *  uninteresting for everyday browsing, and pushed to the right anyway —
 *  collapsed-by-default keeps it accessible without consuming the visual
 *  budget on every table the user opens. */
export const DEFAULT_COLLAPSED_BUCKETS: Set<Bucket> = new Set(["demoted"]);

export interface ColumnGroup {
  bucket: Bucket;
  label: string;
  columns: string[];
}

interface BucketAssignment {
  bucket: Bucket;
  // Sort key applied within a bucket. For the structural buckets this is
  // the name prefix (so `post_pt_root_id` and `pre_pt_root_id` sort by
  // `post_pt` / `pre_pt`); for position columns it concatenates prefix+axis
  // so the three axes of one prefix stay grouped in x/y/z order.
  sortKey: string;
}

const ROW_SAMPLE_FOR_KIND = 50;

function inferDataKind(
  col: string,
  rows: Record<string, unknown>[],
): "number" | "boolean" | "string" {
  let nBool = 0;
  let nNum = 0;
  let nNonNull = 0;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined) continue;
    nNonNull += 1;
    if (typeof v === "boolean") nBool += 1;
    else if (typeof v === "number") nNum += 1;
    if (nNonNull >= ROW_SAMPLE_FOR_KIND) break;
  }
  if (nNonNull === 0) return "string"; // unknown — string is the safest default
  if (nBool === nNonNull) return "boolean";
  if (nNum === nNonNull) return "number";
  return "string";
}

function bucketize(
  col: string,
  rows: Record<string, unknown>[],
): BucketAssignment | null {
  if (DROPPED_COLUMNS.has(col)) return null;
  if (col === "id") return { bucket: "id", sortKey: col };

  // Demoted bookkeeping. Bracketed names first, then prefix patterns.
  if (DEMOTED_NAMES.has(col)) return { bucket: "demoted", sortKey: col };
  for (const prefix of DEMOTED_PREFIXES) {
    if (col.startsWith(prefix)) return { bucket: "demoted", sortKey: col };
  }

  // Structural name-based buckets.
  const positionMatch = POSITION_SUFFIX.exec(col);
  if (positionMatch) {
    return { bucket: "position", sortKey: `${positionMatch[1]}_${positionMatch[2]}` };
  }
  const rootMatch = ROOT_ID_SUFFIX.exec(col);
  if (rootMatch) return { bucket: "root_id", sortKey: rootMatch[1] || col };
  const svMatch = SUPERVOXEL_SUFFIX.exec(col);
  if (svMatch) return { bucket: "supervoxel", sortKey: svMatch[1] || col };

  // Fallback: bucket by data kind.
  return { bucket: inferDataKind(col, rows), sortKey: col };
}

/**
 * Reorder a column-name list per the policy at the top of this file, then
 * return it segmented by bucket so the per-table view can render a grouped
 * header (one group per bucket) with per-group collapse handles.
 *
 * Empty buckets are omitted from the result — no point painting a header
 * for a group with zero columns. Pure: same input always yields same output.
 */
export function orderColumnsGrouped(
  columnNames: string[],
  rows: Record<string, unknown>[],
): ColumnGroup[] {
  const buckets: Record<Bucket, { col: string; sortKey: string }[]> = {
    id: [], root_id: [], supervoxel: [], position: [],
    number: [], string: [], boolean: [], demoted: [],
  };
  for (const c of columnNames) {
    const assignment = bucketize(c, rows);
    if (assignment === null) continue;
    buckets[assignment.bucket].push({ col: c, sortKey: assignment.sortKey });
  }
  const out: ColumnGroup[] = [];
  for (const bucket of BUCKET_ORDER) {
    const items = buckets[bucket];
    if (items.length === 0) continue;
    items.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    out.push({ bucket, label: BUCKET_LABELS[bucket], columns: items.map((i) => i.col) });
  }
  return out;
}

/**
 * Flat ordered column-name list, equivalent to `orderColumnsGrouped(...)
 * .flatMap(g => g.columns)`. Kept as a separate convenience for callers
 * that don't care about grouping.
 */
export function orderColumns(
  columnNames: string[],
  rows: Record<string, unknown>[],
): string[] {
  return orderColumnsGrouped(columnNames, rows).flatMap((g) => g.columns);
}
