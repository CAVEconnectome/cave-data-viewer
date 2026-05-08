import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Searchable dropdown — a typeable input bound to a list of options.
 * Built rather than relying on `<datalist>` because native datalist
 * styling is wildly inconsistent across browsers and accepts free-text
 * (we want strict selection from the list).
 *
 * Behavior:
 *   - Focus the input → popover opens with all options.
 *   - Type → filter by case-insensitive substring match against `label`
 *     and `hint` (so a user can search "view" to find views).
 *   - Arrow keys navigate; Enter selects the highlighted option;
 *     Escape closes without changing the value.
 *   - Click outside closes without changing the value.
 *   - The input shows the selected value's label when not focused;
 *     while focused, it shows the user's live query (cleared on each
 *     open so the user types from scratch rather than editing a long
 *     existing label).
 */

export interface ComboboxOption {
  value: string;
  label: string;
  /** Right-aligned subtle suffix (e.g. "view" to mark materialized views).
   *  Also searched against the user's query so typing "view" surfaces
   *  every view in the list. */
  hint?: string;
}

interface Props {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Shown in the popover when the query matches no options. Defaults
   *  to "No matches". */
  emptyText?: string;
  /** Style hook for embedding in different layouts (e.g. the
   *  decorations picker uses a fixed-width variant). */
  className?: string;
}

export function Combobox({
  value, options, onChange, disabled, placeholder, emptyText, className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const selectedLabel = useMemo(
    () => options.find((o) => o.value === value)?.label ?? "",
    [options, value],
  );

  // While the popover is open the input shows the user's live query
  // (so typing reads naturally); when closed it shows the selected
  // value's label.
  const inputValue = open ? query : selectedLabel;

  const filtered = useMemo(() => {
    if (!query) return options;
    const needle = query.toLowerCase();
    return options.filter((o) =>
      o.label.toLowerCase().includes(needle) ||
      (o.hint?.toLowerCase().includes(needle) ?? false),
    );
  }, [options, query]);

  // Click-outside closes the popover. Listen on `mousedown` (not
  // `click`) so the close fires before the option's own onMouseDown,
  // which we already use for selection.
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

  // Keep the highlighted option in view as the user arrows through a
  // long list. Scrolls the popover container, not the page.
  useEffect(() => {
    if (!open || !popoverRef.current) return;
    const node = popoverRef.current.querySelector<HTMLElement>(
      `[data-combobox-index="${highlight}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  // Clamp highlight when the filtered list shrinks under it (e.g. user
  // types more characters and the previous index falls off the end).
  useEffect(() => {
    if (highlight > filtered.length - 1) setHighlight(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlight]);

  const choose = (option: ComboboxOption) => {
    onChange(option.value);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  return (
    <div ref={containerRef} className={`combobox${className ? ` ${className}` : ""}${disabled ? " disabled" : ""}`}>
      <input
        ref={inputRef}
        type="text"
        className="combobox-input"
        value={inputValue}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => { setOpen(true); setQuery(""); setHighlight(0); }}
        onChange={(e) => { setQuery(e.target.value); setHighlight(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            if (filtered[highlight]) {
              e.preventDefault();
              choose(filtered[highlight]);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
            inputRef.current?.blur();
          }
        }}
        aria-expanded={open}
        aria-autocomplete="list"
        role="combobox"
      />
      {open && (
        <div ref={popoverRef} className="combobox-popover" role="listbox">
          {filtered.length === 0 ? (
            <div className="combobox-empty">{emptyText ?? "No matches"}</div>
          ) : (
            filtered.map((o, i) => (
              <div
                key={o.value}
                data-combobox-index={i}
                className={`combobox-option${i === highlight ? " highlight" : ""}${o.value === value ? " selected" : ""}`}
                role="option"
                aria-selected={o.value === value}
                onMouseDown={(e) => {
                  // `mousedown` (not `click`) so we beat the input's
                  // blur — otherwise the popover closes before the
                  // selection lands.
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span className="combobox-option-label">{o.label}</span>
                {o.hint && <span className="combobox-option-hint">{o.hint}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
