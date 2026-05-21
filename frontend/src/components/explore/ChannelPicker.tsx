import { useEffect, useMemo } from "react";
import type { ColumnGroup, FeatureTableListItem } from "../../api/types";
import { columnDisplayName } from "../tableColumns";
import { getColormap } from "./colormaps";
import { ColormapPicker } from "./ColormapPicker";
import { RangeSlider } from "./RangeSlider";

interface ChannelOption {
  /** URL/query value — `<table>.<col>` (always dotted, since parquet
   *  columns are prefixed with the feature_table id and decoration
   *  columns are `<dec_table>.<col>`). */
  value: string;
  /** Display label — the bare column name. */
  label: string;
  /** Source group, for the optgroup header. */
  source: "features" | "categoricals" | string;
  /** Whether the option supports the size channel (numeric only). */
  isNumeric?: boolean;
}

interface Props {
  /** The currently-selected feature table — used to enumerate parquet
   *  columns. */
  featureTable: FeatureTableListItem | null;
  /** Column_groups from the /cells response — used to surface
   *  decoration-table columns once a decoration table is attached.
   *  Pass undefined if /cells hasn't loaded yet; the picker degrades
   *  to parquet-only options. */
  cellsColumnGroups?: ColumnGroup[];
  /** When true, the synthetic ``__distance`` channel is offered in the
   *  color + size pickers. Set by FeatureExplorer when a
   *  selection-growth probe has populated the in-memory distance map. */
  hasDistanceProbe?: boolean;
  x: string | null;
  y: string | null;
  colorBy: string | null;
  sizeBy: string | null;
  /** Current px range for the size channel (defaults applied by the
   *  parent — typically 2/18). */
  sizeMinPx: number;
  sizeMaxPx: number;
  /** Numeric size channel data-range clipping. Mirrors colorBound /
   *  colorMin / colorMax for size. ``sizeBound`` is the underlying
   *  data extent (from the response); ``sizeDataMin`` / ``sizeDataMax``
   *  are the user-clamped values within it. Only meaningful when a
   *  size channel is bound. */
  sizeBound?: { lo: number; hi: number } | null;
  sizeDataMin?: number | null;
  sizeDataMax?: number | null;
  /** Numeric color channel clipping. ``colorBound`` is the underlying
   *  data extent (from the response); ``colorMin``/``colorMax`` are
   *  the user-clamped values within it. Only meaningful when color is
   *  bound to a numeric column. */
  colorBound?: { lo: number; hi: number } | null;
  colorMin?: number | null;
  colorMax?: number | null;
  /** Whether the color channel is currently numeric. The slider only
   *  renders for numeric bindings — clipping a categorical palette
   *  doesn't make sense. */
  colorIsNumeric?: boolean;
  /** Selected colormap id. Only meaningful for numeric color bindings;
   *  for categorical, the palette comes from the server's color_map
   *  and the picker is hidden. */
  colormapId?: string | null;
  /** Data value anchored to the colormap's midpoint. Null defers to
   *  the midpoint of the current [colorMin, colorMax] range. Only
   *  surfaced when the active colormap's category is "diverging" —
   *  the renderer ignores centering for non-diverging maps. */
  colorCenter?: number | null;
  defaultXLabel?: string; // shown when x is null (the embedding's declared axis)
  defaultYLabel?: string;
  defaultColorLabel?: string | null; // embedding's default_color_by
  /** Uniform fill color (hex `#rrggbb`) for the explicit no-color
   *  state (colorBy === "__none__"). When unset, falls back to the
   *  project's default base hue. Surfaced as a swatch picker inline
   *  next to the color select. */
  colorValue?: string | null;
  /** When provided, renders a "Restore defaults" link at the bottom of
   *  the picker. Caller clears all channel URL keys (x, y, color, cv,
   *  size, size_min/max, size_data_min/max, color_min/max, cmap,
   *  color_center) so the scatter falls back to manifest defaults. */
  onRestoreDefaults?: () => void;
  onChange: (next: {
    x?: string | null;
    y?: string | null;
    colorBy?: string | null;
    sizeBy?: string | null;
    sizeMinPx?: number;
    sizeMaxPx?: number;
    sizeDataMin?: number | null;
    sizeDataMax?: number | null;
    colorMin?: number | null;
    colorMax?: number | null;
    colormapId?: string | null;
    colorCenter?: number | null;
    colorValue?: string | null;
  }) => void;
}

/** Default uniform color for color=__none__. Matches BASE_RGBA_NO_HIGHLIGHT
 *  in UniverseScatter so the swatch picker's initial value matches what
 *  the scatter already paints. */
const DEFAULT_UNIFORM_COLOR = "#5b8bd1";

/**
 * Seaborn-style x/y/color/size channel pickers.
 *
 * Four selectors that bind to the universe scatter. Each option carries
 * its provenance (feature-table parquet column or decoration table
 * column) and a numeric-vs-categorical hint so the size picker shows
 * only numeric options.
 *
 * The bindings travel in URL state (`?x`, `?y`, `?color`, `?size`)
 * which is parsed by `FeatureExplorer` and threaded into the
 * `useEmbeddingScatter` hook. The backend's /scatter endpoint
 * substitutes the bound columns into its parallel-array payload and
 * (for categorical color) attaches a `color_map` derived from the
 * project's shared categorical-palette resolver.
 */
export function ChannelPicker({
  featureTable,
  cellsColumnGroups,
  hasDistanceProbe,
  x,
  y,
  colorBy,
  sizeBy,
  sizeMinPx,
  sizeMaxPx,
  sizeBound,
  sizeDataMin,
  sizeDataMax,
  colorBound,
  colorMin,
  colorMax,
  colorIsNumeric,
  colormapId,
  colorCenter,
  defaultXLabel,
  defaultYLabel,
  defaultColorLabel,
  colorValue,
  onRestoreDefaults,
  onChange,
}: Props) {
  const { axisOptions, colorOptions, sizeOptions } = useMemo(() => {
    // Build per-column option records (numeric flag from
    // feature_columns vs categorical_columns), then re-group by
    // manifest categories if any are declared. Otherwise fall back to
    // the original `features` / `categoricals` split.
    const numericSet = new Set(featureTable?.feature_columns ?? []);
    const categoricalSet = new Set(featureTable?.categorical_columns ?? []);
    const allParquetCols = featureTable
      ? Array.from(new Set([...numericSet, ...categoricalSet]))
      : [];

    const baseRecord = (col: string): Omit<ChannelOption, "source"> => ({
      value: `${featureTable!.id}.${col}`,
      label: col,
      // A column declared in feature_columns wins as numeric; if it's
      // only in categorical_columns it's non-numeric. Columns referenced
      // by a category but absent from both lists fall through as
      // unknown-numeric (matches the decoration-column treatment).
      isNumeric: numericSet.has(col)
        ? true
        : categoricalSet.has(col)
          ? false
          : undefined,
    });

    let parquetOptions: ChannelOption[] = [];
    const categories = featureTable?.categories ?? [];
    if (categories.length > 0) {
      // Manifest-declared categories. A column may belong to multiple
      // categories — we emit one option per (column, category) so the
      // user sees the column under every relevant header. The dedupe
      // happens visually (different optgroup labels) and in the picker
      // state (the URL holds the dotted column path, not the category).
      const referenced = new Set<string>();
      for (const cat of categories) {
        for (const col of cat.columns) {
          if (!featureTable || !allParquetCols.includes(col)) continue;
          referenced.add(col);
          parquetOptions.push({ ...baseRecord(col), source: cat.title });
        }
      }
      // Implicit "Uncategorized" bucket for parquet columns the manifest
      // forgot to file. Skipping this would silently hide columns
      // present in the parquet but absent from any category — worse
      // than a slightly noisy fallback group.
      const uncategorized = allParquetCols.filter((c) => !referenced.has(c));
      for (const col of uncategorized) {
        parquetOptions.push({ ...baseRecord(col), source: "Uncategorized" });
      }
    } else if (featureTable) {
      // Legacy flat layout: numeric features under `features`, label
      // columns under `categoricals`. Preserves the previous look for
      // manifests that don't opt in to categories.
      for (const col of featureTable.feature_columns ?? []) {
        parquetOptions.push({ ...baseRecord(col), source: "features" });
      }
      for (const col of featureTable.categorical_columns ?? []) {
        parquetOptions.push({ ...baseRecord(col), source: "categoricals" });
      }
    }
    // Decoration tables show up in the /cells response's column_groups
    // as `kind: "table"` entries with the table name. We surface all
    // columns from those groups — we don't know which are numeric until
    // a row sample arrives, so the size channel treats them all as
    // candidates and the backend 422s on non-numeric (caught + shown).
    const decorationOptions: ChannelOption[] = [];
    for (const g of cellsColumnGroups ?? []) {
      if (g.kind !== "table") continue;
      if (g.name === featureTable?.id) continue; // already covered above
      for (const fullCol of g.columns) {
        const bare = fullCol.includes(".") ? fullCol.slice(fullCol.indexOf(".") + 1) : fullCol;
        decorationOptions.push({
          value: fullCol,
          label: bare,
          source: g.name,
          // Unknown without a sample; the size channel falls back to a
          // type check on the backend.
        });
      }
    }
    // Synthetic ``__distance`` channel — surfaced only when a growth
    // probe is active. The sentinel value is plain ``__distance`` (no
    // table prefix) so the backend's bound-column resolver can detect
    // it and refuse to forward it as a real column. Numeric by
    // construction so the size picker accepts it.
    const distanceOption: ChannelOption | null = hasDistanceProbe
      ? {
          value: "__distance",
          label: columnDisplayName("__distance"),
          source: "growth",
          isNumeric: true,
        }
      : null;
    const all = [...parquetOptions, ...decorationOptions];
    const allWithDistance = distanceOption ? [distanceOption, ...all] : all;
    return {
      // x/y axes are scatter-only (no bar/strip path yet), so categorical
      // columns aren't a valid binding — filter them out. `isNumeric !==
      // false` keeps numeric AND unknown columns (decoration columns
      // we haven't sampled); the backend rejects non-numeric at fetch
      // time. Distance is excluded — it's color/size only.
      axisOptions: all.filter((o) => o.isNumeric !== false),
      colorOptions: allWithDistance,
      sizeOptions: allWithDistance.filter((o) => o.isNumeric !== false),
    };
  }, [featureTable, cellsColumnGroups, hasDistanceProbe]);

  // Auto-clear stale axis bindings. If x or y is set to a column that
  // isn't in the (filtered) axisOptions — typically a categorical
  // column from an older URL or recipe back when categoricals were
  // allowed — null it out so the dropdown stops showing "default" for
  // a value the user can't pick from the menu anymore. Gated on
  // featureTable being loaded so we don't clobber during the load tick
  // when axisOptions is transiently empty.
  useEffect(() => {
    if (!featureTable) return;
    const valid = new Set(axisOptions.map((o) => o.value));
    const updates: { x?: null; y?: null } = {};
    if (x && !valid.has(x)) updates.x = null;
    if (y && !valid.has(y)) updates.y = null;
    if (updates.x !== undefined || updates.y !== undefined) {
      onChange(updates);
    }
  }, [featureTable, axisOptions, x, y, onChange]);

  return (
    <div className="explore-channels">
      {/* Section title comes from the enclosing CollapsibleSection's
          header — no need to repeat it inside the panel. */}
      <ChannelSelect
        label="x"
        value={x}
        emptyOptionLabel={defaultXLabel ? "Embedding (x)" : undefined}
        options={axisOptions}
        onChange={(v) => onChange({ x: v })}
      />
      <ChannelSelect
        label="y"
        value={y}
        emptyOptionLabel={defaultYLabel ? "Embedding (y)" : undefined}
        options={axisOptions}
        onChange={(v) => onChange({ y: v })}
      />
      <ChannelSelect
        label="color"
        value={colorBy}
        defaultLabel={defaultColorLabel ?? "—"}
        options={colorOptions}
        allowNone
        explicitNoneLabel="(no color)"
        onChange={(v) =>
          onChange({
            colorBy: v,
            // Reset color-range clipping when the column changes —
            // the old min/max bounds are meaningless for a new column.
            colorMin: null,
            colorMax: null,
          })
        }
      />
      {colorBy === "__none__" && (
        /* Uniform color picker — analog of the size slider for sizeBy=null.
           When the user explicitly picks "(no color)", the channel is
           uninformative; they pick the literal fill instead. */
        <label className="explore-channel">
          <span className="explore-channel-label">fill</span>
          <input
            type="color"
            className="explore-color-swatch"
            value={colorValue ?? DEFAULT_UNIFORM_COLOR}
            onChange={(e) => onChange({ colorValue: e.target.value })}
            title="Uniform color for all points (no channel)"
          />
        </label>
      )}
      {colorBy && colorBy !== "__none__" && colorIsNumeric && colorBound && (() => {
        const isDiverging = getColormap(colormapId).category === "diverging";
        const lo = colorMin ?? colorBound.lo;
        const hi = colorMax ?? colorBound.hi;
        // Treat NaN colorCenter (e.g. stale URL state from a hand-typed
        // value) as "no explicit pick" so the slider always gets a finite
        // value and the thumb lands at the range midpoint rather than at
        // some browser-default fallback position.
        const explicitCenter =
          typeof colorCenter === "number" && Number.isFinite(colorCenter)
            ? colorCenter
            : null;
        const effectiveCenter =
          isDiverging
            ? explicitCenter !== null
              ? explicitCenter
              : (lo + hi) / 2
            : null;
        const centerIsExplicit = isDiverging && explicitCenter !== null;
        return (
          <>
            <RangeSlider
              label="range"
              bound={colorBound}
              min={lo}
              max={hi}
              formatValue={formatNumericTick}
              center={effectiveCenter}
              centerLabel="center"
              centerIsExplicit={centerIsExplicit}
              onCenterChange={(v) => onChange({ colorCenter: v })}
              onCenterReset={() => onChange({ colorCenter: null })}
              onChange={(next) =>
                onChange({
                  ...(next.min !== undefined ? { colorMin: next.min } : {}),
                  ...(next.max !== undefined ? { colorMax: next.max } : {}),
                })
              }
            />
            <div className="explore-channel">
              <span className="explore-channel-label">scale</span>
              <ColormapPicker
                value={colormapId}
                onChange={(id) => onChange({ colormapId: id })}
              />
            </div>
          </>
        );
      })()}
      <ChannelSelect
        label="size"
        value={sizeBy}
        defaultLabel="—"
        options={sizeOptions}
        allowNone
        onChange={(v) =>
          onChange({
            sizeBy: v,
            // Reset the data-range clip when the column changes —
            // the old min/max bounds are meaningless for a new
            // column. Same pattern as colorBy → colorMin/colorMax.
            sizeDataMin: null,
            sizeDataMax: null,
          })
        }
      />
      {/* Size data range — only when a size channel is bound. Mirrors
          color's range slider: out-of-range cells clamp to the size
          endpoints so a long-tail outlier doesn't squash the size
          gradient onto a few cells. */}
      {sizeBy && sizeBound && (() => {
        const lo = sizeDataMin ?? sizeBound.lo;
        const hi = sizeDataMax ?? sizeBound.hi;
        return (
          <RangeSlider
            label="range"
            bound={sizeBound}
            min={lo}
            max={hi}
            formatValue={formatNumericTick}
            onChange={(next) =>
              onChange({
                ...(next.min !== undefined ? { sizeDataMin: next.min } : {}),
                ...(next.max !== undefined ? { sizeDataMax: next.max } : {}),
              })
            }
          />
        );
      })()}
      {/* Size slider is always present. Single-thumb when no size
          channel is bound (controls uniform point size); dual-thumb
          range when a channel is bound (rank-scaled px endpoints).
          Floor is 0.25 — high-density displays render sub-pixel
          sizes cleanly and dense embeddings benefit from very
          small points. */}
      <RangeSlider
        label="size"
        mode={sizeBy ? "range" : "single"}
        bound={{ lo: 0.25, hi: 24 }}
        min={sizeMinPx}
        max={sizeMaxPx}
        step={0.25}
        formatValue={(v) => `${v.toFixed(2)} px`}
        onChange={(next) =>
          onChange({
            ...(next.min !== undefined ? { sizeMinPx: next.min } : {}),
            ...(next.max !== undefined ? { sizeMaxPx: next.max } : {}),
          })
        }
      />
      {onRestoreDefaults && (
        <button
          type="button"
          className="explore-channels-restore"
          onClick={onRestoreDefaults}
          title="Reset all channel bindings, clipping, and the colormap to manifest defaults"
        >
          Restore defaults
        </button>
      )}
    </div>
  );
}

function formatNumericTick(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0))
    return n.toExponential(1);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(2);
}

function ChannelSelect({
  label,
  value,
  defaultLabel,
  emptyOptionLabel,
  options,
  allowNone,
  explicitNoneLabel,
  onChange,
}: {
  label: string;
  value: string | null;
  defaultLabel?: string;
  /** When set, completely replaces the empty option's rendered text
   *  (no "default (...)" wrap). Used by x/y where "Embedding (x)" is
   *  more readable than the verbose "default (umap_embedding_x)" —
   *  the channel name already signals what the default is. Color
   *  doesn't pass this because the user can't predict the default
   *  column name without seeing it. */
  emptyOptionLabel?: string;
  options: ChannelOption[];
  allowNone?: boolean;
  /** When set, renders an explicit option that writes the literal
   *  string `__none__` to the binding. Distinct from clearing to the
   *  empty option (which means "fall back to default"). Used on the
   *  color channel so the user can pick "no color" even when a
   *  default_color_by is defined. */
  explicitNoneLabel?: string;
  onChange: (next: string | null) => void;
}) {
  // Group options by source for an optgroup-style render.
  const grouped: Record<string, ChannelOption[]> = {};
  for (const o of options) {
    (grouped[o.source] ??= []).push(o);
  }
  return (
    <label className="explore-channel">
      <span className="explore-channel-label">{label}</span>
      <select
        className="explore-channel-select"
        value={value ?? ""}
        onChange={(ev) => {
          const v = ev.target.value;
          onChange(v === "" ? null : v);
        }}
      >
        <option value="">
          {emptyOptionLabel
            ? emptyOptionLabel
            : allowNone
              ? defaultLabel && defaultLabel !== "—"
                ? `default (${defaultLabel})`
                : "none"
              : defaultLabel
                ? `default (${defaultLabel})`
                : "—"}
        </option>
        {explicitNoneLabel && (
          <option value="__none__">{explicitNoneLabel}</option>
        )}
        {Object.entries(grouped).map(([source, opts]) => (
          <optgroup key={source} label={source}>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
