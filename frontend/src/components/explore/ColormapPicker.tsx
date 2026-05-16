import { useEffect, useMemo, useRef, useState } from "react";
import {
  COLORMAPS,
  type Colormap,
  FEATURED_COLORMAP_IDS,
  colormapCss,
  getColormap,
} from "./colormaps";

interface Props {
  /** Selected colormap id; resolved through `getColormap` so an unknown
   *  value lands on the default rather than rendering nothing. */
  value: string | null | undefined;
  onChange: (id: string) => void;
}

/**
 * Colormap picker for the universe scatter's numeric color channel.
 *
 * Closed state: a small button showing the active colormap's gradient
 * + name. Open state: a popover with two sections —
 *
 *   1. **Featured**: ~4 chunky swatches for the colormaps most users
 *      will reach for (viridis, plasma, magma, RdBu). Clicking
 *      commits and closes.
 *   2. **All**: a search input + scrollable list of every registry
 *      entry, with gradient previews. Free-text matches label, id, or
 *      category — so typing "div" surfaces diverging maps, "blue"
 *      surfaces Blues + RdBu + others with "blue" in the name.
 *
 * The picker only makes sense for numeric color bindings; the parent
 * (ChannelPicker) decides when to render it.
 */
export function ColormapPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => getColormap(value), [value]);
  const featured = useMemo(
    () =>
      FEATURED_COLORMAP_IDS.map((id) => COLORMAPS.find((c) => c.id === id))
        .filter((c): c is Colormap => !!c),
    [],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COLORMAPS;
    return COLORMAPS.filter(
      (c) =>
        c.id.includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.category.includes(q),
    );
  }, [query]);

  // Close on outside click. `mousedown` so the close fires before the
  // option's own onMouseDown (which we use for selection — same
  // pattern as the existing Combobox).
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Auto-focus the search input on open so the user can type
  // immediately without an extra click.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div ref={containerRef} className="cmap-picker">
      <button
        type="button"
        className="cmap-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`Colormap: ${selected.label}`}
      >
        <span
          className="cmap-picker-swatch"
          style={{ background: colormapCss(selected) }}
          aria-hidden
        />
        <span className="cmap-picker-trigger-label">{selected.label}</span>
        <span className="cmap-picker-chev" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="cmap-picker-popover" role="listbox">
          <div className="cmap-picker-section-label">Featured</div>
          <div className="cmap-picker-featured">
            {featured.map((cmap) => (
              <button
                key={cmap.id}
                type="button"
                className={`cmap-picker-featured-item${
                  cmap.id === selected.id ? " selected" : ""
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(cmap.id);
                }}
                title={cmap.label}
              >
                <span
                  className="cmap-picker-swatch tall"
                  style={{ background: colormapCss(cmap) }}
                  aria-hidden
                />
                <span className="cmap-picker-featured-label">{cmap.label}</span>
              </button>
            ))}
          </div>
          <input
            ref={searchRef}
            type="text"
            className="cmap-picker-search"
            value={query}
            placeholder="Search colormaps (e.g. diverging, blue)"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="cmap-picker-list">
            {filtered.length === 0 ? (
              <div className="cmap-picker-empty">No matching colormaps</div>
            ) : (
              filtered.map((cmap) => (
                <div
                  key={cmap.id}
                  className={`cmap-picker-row${
                    cmap.id === selected.id ? " selected" : ""
                  }`}
                  role="option"
                  aria-selected={cmap.id === selected.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(cmap.id);
                  }}
                >
                  <span
                    className="cmap-picker-swatch"
                    style={{ background: colormapCss(cmap) }}
                    aria-hidden
                  />
                  <span className="cmap-picker-row-label">{cmap.label}</span>
                  <span className="cmap-picker-row-cat">{cmap.category}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
