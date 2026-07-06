import Papa from "papaparse";
import { App, TFile } from "obsidian";
import { CSVRow } from "./types";

// Column-name aliases that mark a cell as holding an image, for card/kanban
// thumbnails. Matched case-insensitively against headers (see getImageCol).
export const IMAGE_COL_ALIASES = ["Image", "image", "Cover", "cover", "Poster", "poster", "Thumbnail", "thumbnail", "Thumb", "thumb", "Photo", "photo", "Picture", "picture", "Img", "img"];

// Column-name aliases for the four other name-detected roles (see
// titleKey/getCategoryCol/getStatusCol/getNotesCol). Shared between main.ts,
// inline-view.ts, and the ⚙ Config modal's auto-detected role indicator, so
// the modal's "this is auto-detected" badge always agrees with what the
// views actually resolve at render time.
export const TITLE_COL_ALIASES = ["Title", "title", "Name", "name"];
export const CATEGORY_COL_ALIASES = [
  "Category","category","Categories","categories",
  "Genre","genre","Genres","genres",
  "Type","type","Types","types",
  "Tag","tag","Tags","tags",
  "Topic","topic","Topics","topics",
  "Subject","subject",
  "Section","section",
];
export const STATUS_COL_ALIASES = [
  "Status","status",
  "State","state",
  "Progress","progress",
  "Stage","stage",
  "Read","read",
  "Watched","watched","Seen","seen",
  "Done","done","Completed","completed",
];
export const NOTES_COL_ALIASES = [
  "Notes","notes","Note","note",
  "Summary","summary",
  "Review","review",
  "Quote","quote","Quotes","quotes",
  "Comment","comment","Comments","comments",
  "Description","description",
  "Annotation","annotation",
];

/**
 * Resolve a cell value into an <img> src, or null if it isn't resolvable.
 * Accepts: http(s)/data URLs (used as-is), `![[wikilink]]` / `[[wikilink]]`,
 * `![](path)` markdown images, and bare vault paths / filenames (resolved
 * relative to the CSV's own path via the link cache → getResourcePath).
 */
export function resolveImageSrc(app: App, raw: string, sourcePath: string): string | null {
  let v = (raw ?? "").trim();
  if (!v) return null;
  // Absolute URLs / data URIs pass through untouched.
  if (/^(https?:|data:)/i.test(v)) return v;
  // Unwrap ![[wikilink]] / [[wikilink]] and ![](path) markdown image syntax.
  const wiki = v.match(/!?\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
  if (wiki) v = wiki[1].trim();
  else {
    const md = v.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (md) v = md[1].trim();
  }
  if (/^(https?:|data:)/i.test(v)) return v; // an md-image whose target was a URL
  // Resolve as a vault link relative to the CSV file, then to a usable src.
  const file = app.metadataCache.getFirstLinkpathDest(v, sourcePath);
  if (file instanceof TFile) return app.vault.getResourcePath(file);
  return null;
}

// Largest distinct-value count at which a column still "looks categorical" —
// i.e. worth an option picker rather than a free-text input. The single source
// of truth for the add form, the entry editor, and the mobile add form, so all
// three offer the same pseudo-categorical columns (e.g. Watched, Format) the
// same way, not just the names configured in settings.selectColumns.
export const CATEGORICAL_MAX_DISTINCT = 15;
export function looksCategorical(distinctCount: number): boolean {
  return distinctCount >= 1 && distinctCount <= CATEGORICAL_MAX_DISTINCT;
}

// Boolean/habit-column value vocabulary — the single source of truth for
// auto-detecting 0/1-style toggle columns (dashboard habits, add-form
// toggles). Requires at least one existing row: `[].every(...)` is vacuously
// true, which would otherwise misclassify every column on a brand-new/empty
// sheet as boolean (every field would render as a toggle instead of its real
// input type).
const BOOLEAN_PATTERNS = ["0", "1", "true", "false", "yes", "no", ""];
export function looksBoolean(values: string[]): boolean {
  return values.length > 0 && values.every(v => BOOLEAN_PATTERNS.includes(v));
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g,"").replace(/\s+/g," ").trim().slice(0,100);
}

/**
 * Turn an arbitrary field value into a valid Obsidian tag body (the part
 * after `#`). Obsidian tags can't contain spaces or most punctuation, so we
 * lower-case, collapse whitespace/illegal chars to single hyphens, and trim
 * stray hyphens. "Kitchen Reno!" → "kitchen-reno". Returns "" if nothing
 * usable survives (caller should skip emitting a tag in that case).
 */
export function tagify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
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

/**
 * Sort rows by a column for the table view's click-to-sort. Numeric-aware
 * ("9" before "10"; works for years, ratings, scores) with a natural-order
 * string fallback. Empty cells always sort last, regardless of direction —
 * an ascending sort that leads with 50 blank rows reads as broken.
 * Returns a new array; the caller's row order is untouched.
 */
export function sortRowsByColumn(rows: CSVRow[], col: string, dir: "asc" | "desc"): CSVRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = (a[col] ?? "").trim();
    const vb = (b[col] ?? "").trim();
    if (!va && !vb) return 0;
    if (!va) return 1;
    if (!vb) return -1;
    const na = parseFloat(va), nb = parseFloat(vb);
    const bothNumeric = !isNaN(na) && !isNaN(nb) && /^-?[\d.]/.test(va) && /^-?[\d.]/.test(vb);
    const cmp = bothNumeric ? na - nb : va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" });
    return cmp * sign;
  });
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

/**
 * Heuristic for "this column holds years": either the name says so, or at
 * least 80% of the non-empty values are 4-digit years. Used by the kanban
 * group-by selector to bucket into decades instead of one column per year.
 */
export function isYearLikeColumn(col: string, values: string[]): boolean {
  if (/^(year|released|decade)$/i.test((col ?? "").trim())) return true;
  const nonEmpty = values.map(v => (v ?? "").trim()).filter(Boolean);
  if (nonEmpty.length < 3) return false;
  const yearish = nonEmpty.filter(v => /^(1[89]|20)\d{2}$/.test(v));
  return yearish.length / nonEmpty.length >= 0.8;
}

/**
 * Decade bucket label for a year-ish value: "1994" → "1990s". Picks the
 * first 4-digit year found, so full dates ("1994-06-12") work too.
 * Returns null when no year can be extracted.
 */
export function decadeLabel(value: string): string | null {
  const m = (value ?? "").match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (!m) return null;
  return `${Math.floor(parseInt(m[1], 10) / 10) * 10}s`;
}

/**
 * Pick a sensible grouping column for files with no category-like column,
 * so Cards/Kanban stay available everywhere (the group-by selector lets the
 * user switch immediately if the guess is off). Scores every non-excluded
 * column by how close its distinct-value count lands to a "good board" size
 * (~8 columns); columns that are all-unique (IDs, free text) or single-valued
 * are skipped. Returns null when nothing groupable exists.
 */
export function pickFallbackGroupCol(headers: string[], rows: CSVRow[], exclude: Set<string>): string | null {
  if (!rows.length) return null;
  const maxGroups = Math.max(12, rows.length / 3);
  let best: string | null = null;
  let bestScore = Infinity;
  for (const h of headers) {
    if (exclude.has(h)) continue;
    const values = new Set<string>();
    for (const r of rows) {
      (r[h] ?? "").split(",").forEach(v => { const t = v.trim(); if (t) values.add(t); });
    }
    if (values.size < 2 || values.size > maxGroups) continue;
    const score = Math.abs(Math.log(values.size / 8));
    if (score < bestScore) { bestScore = score; best = h; }
  }
  return best;
}

/**
 * Columns whose value is a comma-separated *list* (genres, tags…) rather than
 * a single pick. Name-based on purpose: every picker call site knows the
 * header name, so no plumbing through view/modal constructors is needed.
 * The kanban/library views already comma-split these on the read side.
 */
export function isMultiValueColName(h: string): boolean {
  return /^(categor(y|ies)|genres?|tags?|themes?|topics?)$/i.test((h ?? "").trim());
}

export function showSelectPicker(
  anchor: HTMLElement,
  currentValue: string,
  allValues: string[],
  onSelect: (val: string) => void,
  _container: HTMLElement,
  opts?: { multi?: boolean }
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
  // Scrolling *inside* the picker itself (dragging the list, or the
  // cursor auto-scrolling via paintCursor's scrollIntoView while typing)
  // must NOT dismiss — capture-phase listeners see every scroll in the
  // document, including the picker's own list, and without this guard the
  // picker closed itself the instant its list scrolled or a keystroke
  // moved the keyboard cursor, which also stole focus back to the modal.
  const onScroll = (e: Event) => {
    if (picker.contains(e.target as Node)) return;
    dismiss();
  };
  const dismiss = () => {
    picker.remove();
    document.removeEventListener("mousedown", onOutside);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", dismiss);
  };

  const search = picker.createEl("input", { cls: "csv-picker-search", type: "text", placeholder: "Search or add…" });
  search.focus();
  const listEl = picker.createDiv({ cls: "csv-picker-list" });

  // Multi mode: the cell value is a comma-separated list; items toggle in/out
  // of a Set and every toggle live-commits the joined string via onSelect
  // (so the chip + debounced save track each click). The picker stays open
  // until Done / Esc / outside-click. Existing multi-values in the data are
  // themselves comma-joined, so split them into individual options.
  const multi = !!opts?.multi;
  const splitVals = (s: string) => s.split(",").map(v => v.trim()).filter(Boolean);
  const selected = new Set(multi ? splitVals(currentValue) : []);
  const emit = () => onSelect([...selected].join(", "));
  const unique = multi
    ? Array.from(new Set(allValues.flatMap(splitVals)))
    : Array.from(new Set(allValues.filter(Boolean)));

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

  const commit = (item: { value: string; isClear?: boolean; isAdd?: boolean }) => {
    if (!multi) {
      onSelect(item.isClear ? "" : item.value);
      dismiss();
      return;
    }
    // Multi: toggle and stay open.
    if (item.isClear) {
      selected.clear();
    } else {
      if (selected.has(item.value)) selected.delete(item.value);
      else selected.add(item.value);
      // A just-created value must stay visible in the list after the search
      // box clears, or un-toggling it again would be impossible.
      if (item.isAdd && !unique.includes(item.value)) unique.push(item.value);
    }
    emit();
    if (item.isAdd) { search.value = ""; renderList(""); }
    else renderList(search.value);
  };

  const isActive = (val: string) => multi ? selected.has(val) : val === currentValue;
  const hasValue = () => multi ? selected.size > 0 : !!currentValue;

  const renderList = (filter: string) => {
    listEl.empty();
    selectableValues = [];
    const filtered = filter ? unique.filter(v => v.toLowerCase().includes(filter.toLowerCase())) : unique;
    if (hasValue()) {
      selectableValues.push({ value: "", isClear: true });
      const clearItem = listEl.createDiv({ cls: "csv-picker-item csv-picker-clear" });
      clearItem.setText(multi ? "✕ Clear all" : "✕ Clear");
      clearItem.addEventListener("mousedown", e => { e.preventDefault(); commit({ value: "", isClear: true }); });
    }
    filtered.forEach(val => {
      selectableValues.push({ value: val });
      const item = listEl.createDiv({ cls: `csv-picker-item ${isActive(val) ? "active" : ""}` });
      item.setText(multi ? `${selected.has(val) ? "✓ " : ""}${val}` : val);
      item.addEventListener("mousedown", e => { e.preventDefault(); commit({ value: val }); });
    });
    if (filter && !unique.some(v => v.toLowerCase() === filter.toLowerCase())) {
      selectableValues.push({ value: filter, isAdd: true });
      const addItem = listEl.createDiv({ cls: "csv-picker-item csv-picker-add" });
      addItem.setText(`+ Add "${filter}"`);
      addItem.addEventListener("mousedown", e => { e.preventDefault(); commit({ value: filter, isAdd: true }); });
    }
    if (!filtered.length && !filter) {
      listEl.createDiv({ cls: "csv-picker-empty", text: "No options yet. Type to add." });
    }
    // Reset the cursor — when the filter narrows, jumping to a stale index
    // would leave the highlight invisible or off-screen.
    cursor = Math.min(cursor, Math.max(selectableValues.length - 1, 0));
    paintCursor();
  };

  // Multi pickers don't dismiss on item click, so they need an explicit
  // close affordance (especially on touch, where Esc doesn't exist).
  if (multi) {
    picker.createEl("button", { cls: "csv-picker-done", text: "Done" })
      .addEventListener("mousedown", e => { e.preventDefault(); dismiss(); });
  }

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
