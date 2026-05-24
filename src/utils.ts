import Papa from "papaparse";
import { CSVRow } from "./types";

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g,"").replace(/\s+/g," ").trim().slice(0,100);
}

/**
 * Parse a CSV string into `{headers, rows}` using PapaParse. Values stay as
 * strings (no `dynamicTyping`) so they round-trip back to disk unchanged.
 * Missing trailing fields are filled with "" so every row carries every
 * declared header — downstream code reads `row[h]` directly without ?? "".
 *
 * Replaces the in-main-ts hand-rolled parser, which split on newlines first
 * and so silently truncated any cell containing an embedded `\n` inside
 * quotes (the long-form "Notes" / "Description" / "Quote" columns).
 */
export function parseCSV(raw: string): { headers: string[]; rows: CSVRow[] } {
  if (!raw || !raw.trim()) return { headers: [], rows: [] };
  const result = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });
  const headers = (result.meta.fields ?? []).map(String);
  const rows: CSVRow[] = (result.data ?? []).map(r => {
    const row: CSVRow = {};
    headers.forEach(h => { row[h] = (r as Record<string, unknown>)[h] != null ? String((r as Record<string, unknown>)[h]) : ""; });
    return row;
  });
  return { headers, rows };
}

/**
 * Resolve a path the user typed in a `csv-add file:` block against the folder
 * of the note that contains the block. Three forms accepted:
 *
 *   "data.xlsx"                      → sibling of current note
 *   "./data.xlsx"                    → same as sibling
 *   "../data.xlsx" / "../../foo.csv" → walked up from current folder
 *   "Knowledge/Test/data.xlsx"       → vault-relative (any other path with "/"
 *                                        and no leading "./" or "../" is treated
 *                                        as vault-relative for back-compat with
 *                                        existing dashboards)
 *
 * Returns the resolved vault-relative path. Walking past the vault root clamps
 * at the root rather than throwing — Obsidian's lookup will fail with a clear
 * "File not found" message in that case.
 */
export function resolvePath(input: string, baseFolder: string): string {
  if (!input) return input;
  const isRelative = input.startsWith("./") || input.startsWith("../") || input === "." || input === "..";
  // Vault-relative form: any path with "/" that isn't dot-relative.
  if (!isRelative && input.includes("/")) return input;
  // Sibling form: no "/" at all, no leading "./" or "../" → just join with baseFolder.
  if (!isRelative) return baseFolder ? `${baseFolder}/${input}` : input;
  // Dot-relative: walk the segments.
  const stack = baseFolder ? baseFolder.split("/").filter(Boolean) : [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { stack.pop(); continue; }
    stack.push(seg);
  }
  return stack.join("/");
}

export function titleCase(str: string): string {
  return str.split(/[\s_-]+/).map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

/**
 * Display-ready rating string for a card. Returns "" if the value should not
 * be shown (empty, "unrated", or unmappable). Three input shapes handled:
 *   - already-star glyphs: "★★★★☆" / "⭐️⭐️⭐️"     → returned as-is
 *   - numeric 1–5:          "4" / "5"                   → "★★★★" / "★★★★★"
 *   - text labels:          "excellent" / "good" / etc. → mapped via formatRating
 */
export function formatRatingForDisplay(raw: string, columnName: string): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  if (lower === "unrated" || v === "—" || v === "-") return "";
  if (/[★⭐☆]/.test(v)) return v; // already glyph-based, render as-is
  if (/^\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (n >= 1 && n <= 5) return "★".repeat(n);
  }
  const mapped = formatRating(v, columnName);
  return mapped && mapped !== v && mapped !== "—" ? mapped : "";
}

export function formatRating(value: string, columnName: string): string {
  const col = columnName.toLowerCase();
  if (!["rating", "score", "score /5"].includes(col)) return value;

  const val = value.toLowerCase().trim();
  const ratingMap: Record<string, string> = {
    "excellent": "★★★★★",
    "great": "★★★★★",
    "good": "★★★★☆",
    "fair": "★★★☆☆",
    "poor": "★★☆☆☆",
    "bad": "★☆☆☆☆",
    "5": "★★★★★",
    "4": "★★★★☆",
    "3": "★★★☆☆",
    "2": "★★☆☆☆",
    "1": "★☆☆☆☆",
    "0": "☆☆☆☆☆",
    "unrated": "—",
    "": "—",
  };
  return ratingMap[val] ?? value;
}

export function showSelectPicker(
  anchor: HTMLElement,
  currentValue: string,
  allValues: string[],
  onSelect: (val: string) => void,
  _container: HTMLElement
): void {
  // Always append to document.body so `position: fixed` is anchored to the
  // viewport. If we nested inside the caller's container, any ancestor with
  // `transform`, `filter`, or `backdrop-filter` (Obsidian's modal has these)
  // would become the containing block for `position: fixed`, and the
  // viewport-relative coords from getBoundingClientRect() would get applied
  // as offsets from that ancestor — making the dropdown appear far to the
  // right of the chip that opened it. `_container` is kept in the signature
  // for backward compatibility.
  document.body.querySelectorAll(".csv-select-picker").forEach(el => el.remove());
  const picker = document.body.createDiv({ cls: "csv-select-picker" });
  picker.style.position = "fixed";
  picker.style.zIndex = "9999";

  // Anchor below the chip by default, but flip above when there isn't room
  // below — keeps the dropdown inside the viewport on the bottom edge.
  const reposition = () => {
    const rect = anchor.getBoundingClientRect();
    const pickerH = picker.offsetHeight || 280; // first paint estimate
    const flipAbove = rect.bottom + 4 + pickerH > window.innerHeight && rect.top - 4 - pickerH > 0;
    picker.style.left = rect.left + "px";
    picker.style.top = flipAbove ? (rect.top - 4 - pickerH) + "px" : (rect.bottom + 4) + "px";
  };
  reposition();

  // Teardown — defined first so renderList's item handlers can capture it.
  // Every dismiss path (outside-click, Esc, Enter, scroll, resize, item-pick)
  // goes through here so the registered listeners are always cleaned up.
  const onOutside = (e: MouseEvent) => {
    if (!picker.contains(e.target as Node) && e.target !== anchor) dismiss();
  };
  // Capture-phase scroll: catches scrolling on any ancestor (table wrapper,
  // modal body, content area), not just window. Matches native <select>
  // behaviour — scroll dismisses the dropdown rather than letting it float.
  const onScroll = () => dismiss();
  const dismiss = () => {
    picker.remove();
    document.removeEventListener("mousedown", onOutside);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", dismiss);
  };

  const search = picker.createEl("input", { cls: "csv-picker-search", type: "text", placeholder: "Search or add…" });
  search.focus();
  const listEl = picker.createDiv({ cls: "csv-picker-list" });
  const unique = Array.from(new Set(allValues.filter(Boolean)));

  // Keyboard nav state — tracks which list item is "focused" via the
  // arrow keys. Selectable items get a numeric data-idx; the highlighted
  // one carries `.csv-picker-item--hover` to match real mouse hover.
  let selectableValues: Array<{ value: string; isClear?: boolean; isAdd?: boolean }> = [];
  let cursor = 0;

  const paintCursor = () => {
    listEl.querySelectorAll(".csv-picker-item").forEach((el, i) => {
      el.toggleClass("csv-picker-item--hover", i === cursor);
      if (i === cursor) (el as HTMLElement).scrollIntoView({ block: "nearest" });
    });
  };

  const commit = (item: { value: string; isClear?: boolean }) => {
    onSelect(item.isClear ? "" : item.value);
    dismiss();
  };

  const renderList = (filter: string) => {
    listEl.empty();
    selectableValues = [];
    const filtered = filter ? unique.filter(v => v.toLowerCase().includes(filter.toLowerCase())) : unique;
    if (currentValue) {
      selectableValues.push({ value: "", isClear: true });
      const clearItem = listEl.createDiv({ cls: "csv-picker-item csv-picker-clear" });
      clearItem.setText("✕ Clear");
      clearItem.addEventListener("mousedown", e => { e.preventDefault(); commit({ value: "", isClear: true }); });
    }
    filtered.forEach(val => {
      selectableValues.push({ value: val });
      const item = listEl.createDiv({ cls: `csv-picker-item ${val === currentValue ? "active" : ""}` });
      item.setText(val);
      item.addEventListener("mousedown", e => { e.preventDefault(); commit({ value: val }); });
    });
    if (filter && !unique.some(v => v.toLowerCase() === filter.toLowerCase())) {
      selectableValues.push({ value: filter, isAdd: true });
      const addItem = listEl.createDiv({ cls: "csv-picker-item csv-picker-add" });
      addItem.setText(`+ Add "${filter}"`);
      addItem.addEventListener("mousedown", e => { e.preventDefault(); commit({ value: filter }); });
    }
    if (!filtered.length && !filter) {
      listEl.createDiv({ cls: "csv-picker-empty", text: "No options yet. Type to add." });
    }
    // Reset the cursor — when the filter narrows, jumping to a stale index
    // would leave the highlight invisible or off-screen.
    cursor = Math.min(cursor, Math.max(selectableValues.length - 1, 0));
    paintCursor();
  };

  renderList("");
  // After first render the picker has its real height — recompute so the
  // flip-up decision uses the actual size rather than the 280px estimate.
  reposition();
  search.addEventListener("input", () => { cursor = 0; renderList(search.value); reposition(); });

  // Touch devices behave very differently here: focusing the picker's
  // search input pops the virtual keyboard, which fires a `resize` and
  // sometimes a `scroll` as the viewport reflows. If we dismiss on those,
  // the picker auto-closes a beat after it opens — the user sees a flicker
  // and nothing happens. On desktop the scroll/resize dismissal genuinely
  // fixes the picker-floating-detached-from-anchor case, so keep it there.
  const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside);
    if (!isTouch) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", dismiss);
    }
  }, 0);

  search.addEventListener("keydown", e => {
    if (e.key === "Escape") { dismiss(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (selectableValues.length) {
        cursor = (cursor + 1) % selectableValues.length;
        paintCursor();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (selectableValues.length) {
        cursor = (cursor - 1 + selectableValues.length) % selectableValues.length;
        paintCursor();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Prefer the keyboard cursor's pick — that's what the user just
      // navigated to. Fall back to "create new value from the search box"
      // only when there's nothing to select (empty filtered list).
      if (selectableValues[cursor]) {
        commit(selectableValues[cursor]);
      } else {
        const val = search.value.trim();
        if (val) { onSelect(val); dismiss(); }
      }
    }
  });
}

// `parseCSV` (Papa-backed) and `escapeCSV` previously lived here too. They
// were orphaned in an earlier refactor — never wired into main.ts. The new
// Papa wrapper at the top of this file replaces parseCSV; for serialization
// `Papa.unparse(...)` is called directly from main.ts (see doSave + csv-add).

/**
 * Move a per-file config entry from `oldPath` to `newPath` in-place,
 * returning the mutated object. Used by the vault rename/move hook so the
 * file's cardFields / categoryColumn / defaultMode picks follow the file
 * when the user reorganises their vault. No-op if there's no entry for
 * `oldPath`, or if `newPath` already has one (caller-set values win).
 */
export function migrateFileConfigKey<T>(
  configs: Record<string, T>,
  oldPath: string,
  newPath: string,
): Record<string, T> {
  if (!configs[oldPath]) return configs;
  if (oldPath === newPath) return configs;
  if (!configs[newPath]) configs[newPath] = configs[oldPath];
  delete configs[oldPath];
  return configs;
}
