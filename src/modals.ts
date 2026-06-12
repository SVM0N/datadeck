import {
  App,
  Modal,
  Component,
  MarkdownRenderer,
  Notice,
} from "obsidian";
import { CSVRow, FileConfig, ViewMode } from "./types";
import { showSelectPicker, titleCase, isMultiValueColName } from "./utils";
import { suggestionsFor, isDateCol, ISO_DATE } from "./field-types";

// ─── Shared field input ─────────────────────────────────────────────────────
//
// Used by both the Add-entry modal and the inline (note-expander) editor so a
// given column type edits the same way everywhere. The name/value heuristics
// live in field-types.ts (pure, unit-tested).

/**
 * Build the <input> for a non-notes, non-select cell:
 *  - date-like columns get a native yyyy-mm-dd picker — but only when the
 *    current value is empty or already clean ISO, so partial/blank values
 *    like "2022-06-??" keep a plain text field and are never clobbered
 *  - columns with known options get a non-strict <datalist> dropdown
 *  - everything else is a plain text input
 * Empty values stay allowed throughout (intentional for undated trips).
 */
export function makeFieldInput(parent: HTMLElement, header: string, initial: string, cls: string): HTMLInputElement {
  const useDate = isDateCol(header) && (initial === "" || ISO_DATE.test(initial));
  const input = parent.createEl("input", { cls, type: useDate ? "date" : "text", value: initial });
  if (!useDate) input.placeholder = header;
  const sugg = suggestionsFor(header);
  if (sugg) {
    const id = `csv-dl-${header.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
    const dl = parent.createEl("datalist");
    dl.id = id;
    sugg.forEach(opt => dl.createEl("option", { value: opt }));
    input.setAttr("list", id);
  }
  return input;
}

// ─── Add Entry Modal ──────────────────────────────────────────────────────────

export class AddEntryModal extends Modal {
  headers: string[];
  isNotesCol: (h: string) => boolean;
  isSelectCol: (h: string) => boolean;
  getColumnValues: (h: string) => string[];
  onSubmit: (row: CSVRow) => void;

  constructor(
    app: App,
    headers: string[],
    isNotesCol: (h: string) => boolean,
    isSelectCol: (h: string) => boolean,
    getColumnValues: (h: string) => string[],
    onSubmit: (row: CSVRow) => void
  ) {
    super(app);
    this.headers = headers;
    this.isNotesCol = isNotesCol;
    this.isSelectCol = isSelectCol;
    this.getColumnValues = getColumnValues;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csv-add-modal");

    contentEl.createEl("h2", { text: "Add new entry", cls: "csv-modal-title" });

    const form = contentEl.createDiv({ cls: "csv-modal-form" });
    const values: CSVRow = {};
    this.headers.forEach(h => values[h] = "");

    // Duplicate check for the title field — typing a title that's already in
    // the file shows a non-blocking hint (the user may genuinely want a
    // duplicate, e.g. a rewatch row, so submission stays allowed).
    const titleCol = this.headers.find(h => ["title", "name"].includes(h.toLowerCase()));
    const existingTitles = new Map<string, string>(); // lowercase → original casing
    if (titleCol) {
      this.getColumnValues(titleCol).forEach(v => {
        const key = v.trim().toLowerCase();
        if (key && !existingTitles.has(key)) existingTitles.set(key, v.trim());
      });
    }

    this.headers.forEach(h => {
      const row = form.createDiv({ cls: "csv-modal-row" });
      // titleCase so the label reads "Author" / "Year" / "Notes" regardless of
      // how the CSV happens to capitalise its headers (Apple-style row labels).
      row.createEl("label", { text: titleCase(h), cls: "csv-modal-label" });

      if (this.isNotesCol(h)) {
        const ta = row.createEl("textarea", { cls: "csv-modal-textarea", placeholder: "Markdown supported…" });
        ta.addEventListener("input", () => { values[h] = ta.value; });

      } else if (this.isSelectCol(h)) {
        // Render as a chip that opens the picker, scoped to the modal
        const chipWrap = row.createDiv({ cls: "csv-modal-select-wrap" });
        const chip = chipWrap.createDiv({ cls: "csv-select-chip empty" });
        chip.setText("— click to select —");
        chip.addEventListener("click", e => {
          e.stopPropagation();
          showSelectPicker(chip, values[h], this.getColumnValues(h), (newVal) => {
            values[h] = newVal;
            chip.setText(newVal || "— click to select —");
            chip.toggleClass("empty", !newVal);
          }, contentEl, { multi: isMultiValueColName(h) });
        });

      } else {
        const input = makeFieldInput(row, h, "", "csv-modal-input");
        input.addEventListener("input", () => { values[h] = input.value; });
        // Submit on Enter for non-textarea fields
        input.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });

        if (h === titleCol && existingTitles.size) {
          const hint = row.createDiv({ cls: "csv-modal-dup-hint" });
          hint.hide();
          input.addEventListener("input", () => {
            const match = existingTitles.get(input.value.trim().toLowerCase());
            if (match) {
              hint.setText(`⚠ “${match}” is already in this file`);
              hint.show();
            } else {
              hint.hide();
            }
          });
        }
      }
    });

    const btnRow = contentEl.createDiv({ cls: "csv-modal-btns" });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "csv-modal-cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = btnRow.createEl("button", { text: "Add entry", cls: "csv-modal-submit" });
    submitBtn.addEventListener("click", () => submit());

    const submit = () => {
      // Require at least one field filled
      const hasAny = Object.values(values).some(v => v.trim());
      if (!hasAny) { new Notice("Fill in at least one field."); return; }
      this.onSubmit(values);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ─── Note Expander Modal ──────────────────────────────────────────────────────

export class NoteExpanderModal extends Modal {
  private row: CSVRow;
  private notesCol: string;
  private headers: string[];
  private filePath: string;
  private renderComponent: Component;
  private isNotesCol: (h: string) => boolean;
  private isSelectCol: (h: string) => boolean;
  private getColumnValues: (h: string) => string[];
  private onSave: (row: CSVRow) => void;
  private onDelete?: () => void;

  constructor(
    app: App,
    row: CSVRow,
    notesCol: string,
    headers: string[],
    filePath: string,
    isNotesCol: (h: string) => boolean,
    isSelectCol: (h: string) => boolean,
    getColumnValues: (h: string) => string[],
    onSave: (row: CSVRow) => void,
    onDelete?: () => void
  ) {
    super(app);
    // Work on a shallow copy so cancel doesn't mutate
    this.row = { ...row };
    this.notesCol = notesCol;
    this.headers = headers;
    this.filePath = filePath;
    this.renderComponent = new Component();
    this.isNotesCol = isNotesCol;
    this.isSelectCol = isSelectCol;
    this.getColumnValues = getColumnValues;
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.modalEl.addClass("csv-note-expander-modal");
  }

  // Bound handler so we can add/remove the same reference. Set in onOpen.
  private vvHandler: (() => void) | null = null;

  onOpen(): void {
    this.renderComponent.load();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csv-note-expander");

    // iOS keyboard handling. `dvh` should shrink the modal when the
    // virtual keyboard appears, but iOS Obsidian's WKWebView doesn't
    // always honour it. The visualViewport API is the reliable signal:
    // it reports the actually-visible viewport (i.e. screen minus
    // keyboard). Mirror it into a CSS variable on modalEl and let the
    // stylesheet clamp max-height off of that. Px is the unit so the
    // value is concrete; the clamp falls back to dvh/vh if the API
    // isn't available.
    const vv = (window as { visualViewport?: VisualViewport }).visualViewport;
    if (vv) {
      const update = () => {
        // visualViewport.height = screen minus iOS keyboard when open.
        // The CSS uses --csv-modal-vh to clamp the modal's max-height so
        // the modal always fits above the keyboard. Horizontal centering
        // is left to Obsidian's parent flex; the mobile media query
        // top-anchors the modal via align-self + margin-top instead of
        // overriding the transform (which would un-center it).
        this.modalEl.style.setProperty("--csv-modal-vh", `${vv.height}px`);
      };
      update();
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      this.vvHandler = update;
    }

    // ── Header ──────────────────────────────────────────────────────────────
    const header = contentEl.createDiv({ cls: "csv-expander-header" });
    header.createDiv({ cls: "csv-expander-title", text: this.row[this.headers.find(h => ["title","name","Title","Name"].includes(h)) ?? this.headers[0]] ?? "—" });
    const headerBtns = header.createDiv({ cls: "csv-expander-header-btns" });

    // ── Fields section (non-notes columns) ──────────────────────────────────
    const fieldsEl = contentEl.createDiv({ cls: "csv-expander-fields" });
    const titleKey = this.headers.find(h => ["title","name","Title","Name"].includes(h));
    const authorKey = this.headers.find(h => ["author","Author","director","Director","artist","Artist","creator","Creator"].includes(h));

    this.headers.forEach(h => {
      if (this.isNotesCol(h)) return; // notes rendered separately below
      const fieldRow = fieldsEl.createDiv({ cls: "csv-expander-field-row" });
      // titleCase: Apple-style row labels, independent of CSV header casing.
      fieldRow.createDiv({ cls: "csv-expander-field-label", text: titleCase(h) });

      if (this.isSelectCol(h)) {
        const chip = fieldRow.createDiv({ cls: `csv-select-chip ${this.row[h] ? "" : "empty"}` });
        chip.setText(this.row[h] || "—");
        chip.addEventListener("click", e => {
          e.stopPropagation();
          showSelectPicker(chip, this.row[h], this.getColumnValues(h), (newVal) => {
            this.row[h] = newVal;
            chip.setText(newVal || "—");
            chip.toggleClass("empty", !newVal);
          }, contentEl, { multi: isMultiValueColName(h) });
        });
      } else {
        const val = fieldRow.createDiv({ cls: "csv-expander-field-value", text: this.row[h] || "—" });
        val.addEventListener("click", () => {
          val.empty();
          const input = makeFieldInput(val, h, this.row[h] ?? "", "csv-inline-input");
          input.focus(); if (input.type === "text") input.select();
          const commit = () => { this.row[h] = input.value; val.empty(); val.setText(input.value || "—"); };
          input.addEventListener("blur", commit);
          input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { val.empty(); val.setText(this.row[h] || "—"); } });
        });
      }
    });

    // ── Notes section ────────────────────────────────────────────────────────
    // No "Edit" button: clicking the rendered area enters edit mode (same
    // click-to-edit pattern as the kanban card preview). Links and embeds
    // inside the markdown stay clickable — we suppress the edit-swap only
    // when the click landed on an anchor or the user is selecting text.
    const notesDivider = contentEl.createDiv({ cls: "csv-expander-divider" });
    notesDivider.createDiv({ cls: "csv-expander-notes-label", text: this.notesCol });

    let isEditing = false;
    let currentText = this.row[this.notesCol] ?? "";

    const rendered = contentEl.createDiv({ cls: "csv-expander-rendered markdown-rendered" });
    rendered.title = "Click to edit";
    const editorWrap = contentEl.createDiv({ cls: "csv-expander-editor" });
    editorWrap.style.display = "none";

    const renderMarkdown = () => {
      rendered.empty();
      if (currentText.trim()) {
        MarkdownRenderer.render(this.app, currentText, rendered, this.filePath, this.renderComponent);
      } else {
        rendered.createDiv({ cls: "csv-notes-empty", text: "+ Add note" });
      }
    };
    renderMarkdown();

    const ta = editorWrap.createEl("textarea", { cls: "csv-expander-textarea" });
    ta.value = currentText;
    ta.addEventListener("input", () => { currentText = ta.value; });

    const enterEdit = () => {
      if (isEditing) return;
      isEditing = true;
      rendered.style.display = "none";
      editorWrap.style.display = "flex";
      ta.value = currentText;
      ta.focus();
    };
    const exitEdit = () => {
      if (!isEditing) return;
      isEditing = false;
      editorWrap.style.display = "none";
      rendered.style.display = "";
      currentText = ta.value;
      renderMarkdown();
    };

    rendered.addEventListener("click", (e) => {
      // Don't hijack clicks on links, buttons, or other interactive children —
      // they should open as the user expects.
      const target = e.target as HTMLElement;
      if (target.closest("a, button, input, textarea, [contenteditable]")) return;
      // Don't enter edit mode if the user just finished a text selection inside
      // the rendered note; respects normal text-select semantics.
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      enterEdit();
    });
    // Esc inside the textarea returns to the preview. Click outside (blur)
    // also exits — keeps the modal feeling lightweight.
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); ta.blur(); } });
    ta.addEventListener("blur", exitEdit);

    // ── Footer buttons ───────────────────────────────────────────────────────
    // Layout: [Delete] ............... [Cancel] [Save & close]
    // Delete sits far left so it can't be hit by reflex when reaching for Save.
    const footer = contentEl.createDiv({ cls: "csv-expander-footer" });

    if (this.onDelete) {
      const titleVal = String(this.row[this.headers.find(h => ["title","name","Title","Name"].includes(h)) ?? this.headers[0]] ?? "").trim();
      footer.createEl("button", { cls: "csv-expander-delete-btn", text: "Delete" })
        .addEventListener("click", () => {
          const label = titleVal || "this entry";
          if (!window.confirm(`Delete "${label}"? This can't be undone.`)) return;
          this.onDelete!();
          this.close();
        });
    }

    const rightBtns = footer.createDiv({ cls: "csv-expander-footer-right" });
    rightBtns.createEl("button", { cls: "csv-modal-cancel", text: "Cancel" })
      .addEventListener("click", () => this.close()); // close without saving

    rightBtns.createEl("button", { cls: "csv-expander-save-btn", text: "Save & close" })
      .addEventListener("click", () => {
        // If still in edit mode (user clicked Save without blurring), grab
        // the live textarea content; otherwise currentText is already fresh.
        if (isEditing) currentText = ta.value;
        this.row[this.notesCol] = currentText;
        this.onSave(this.row);
        this.close();
      });
  }

  onClose(): void {
    const vv = (window as { visualViewport?: VisualViewport }).visualViewport;
    if (vv && this.vvHandler) {
      vv.removeEventListener("resize", this.vvHandler);
      vv.removeEventListener("scroll", this.vvHandler);
    }
    this.vvHandler = null;
    this.renderComponent.unload();
    this.contentEl.empty();
  }
}

// ─── Search Modal (mobile) ────────────────────────────────────────────────────
// On mobile, the toolbar 🔍 button opens this instead of expanding the search
// inline. The modal owns its own viewport — iOS keyboard layout quirks don't
// bleed into the kanban / table render underneath. Reuses the same
// visualViewport top-pinning pattern as NoteExpanderModal so the input
// sits above the keyboard.

export class SearchModal extends Modal {
  private initialQuery: string;
  private onInput: (query: string) => void;
  private resultCount: () => { matched: number; total: number };
  private getMatches: () => Array<{ title: string; subtitle?: string; row: CSVRow }>;
  private onPick: (row: CSVRow) => void;
  private vvHandler: (() => void) | null = null;

  constructor(
    app: App,
    initialQuery: string,
    onInput: (query: string) => void,
    resultCount: () => { matched: number; total: number },
    getMatches: () => Array<{ title: string; subtitle?: string; row: CSVRow }>,
    onPick: (row: CSVRow) => void,
  ) {
    super(app);
    this.initialQuery = initialQuery;
    this.onInput = onInput;
    this.resultCount = resultCount;
    this.getMatches = getMatches;
    this.onPick = onPick;
    this.modalEl.addClass("csv-search-modal");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csv-search-modal-content");

    // Transparent backdrop. Obsidian's default modal-bg dims the page
    // underneath to near-black, which hides the filter results — the
    // user types but can't see the table updating. Tag the container so
    // a CSS rule (`.mod-csv-search-bg .modal-bg`) zeroes out the dim.
    // Also defensively clear the inline opacity/background in case the
    // CSS rule loses the cascade to a later !important. Tap-outside still
    // closes because the bg element retains its click handler.
    this.containerEl.addClass("mod-csv-search-bg");
    const clearBg = () => {
      const bg = this.containerEl.querySelector<HTMLElement>(".modal-bg");
      if (bg) {
        bg.style.opacity = "0";
        bg.style.background = "transparent";
      }
    };
    clearBg();
    // Obsidian sometimes restyles the bg after onOpen runs; redo it on
    // the next frame and a tick later for good measure.
    requestAnimationFrame(clearBg);
    setTimeout(clearBg, 50);

    // visualViewport pinning — same trick as NoteExpanderModal. Without
    // it, Obsidian centers the modal in window.innerHeight and the iOS
    // keyboard hides the bottom of it. We write visualViewport.height
    // into --csv-modal-vh; the CSS uses align-self/margin-top on mobile
    // to dock the modal at the top of the visible viewport.
    const vv = (window as { visualViewport?: VisualViewport }).visualViewport;
    if (vv) {
      const update = () => {
        this.modalEl.style.setProperty("--csv-modal-vh", `${vv.height}px`);
      };
      update();
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
      this.vvHandler = update;
    }

    const row = contentEl.createDiv({ cls: "csv-search-modal-row" });
    const input = row.createEl("input", {
      cls: "csv-search-modal-input",
      type: "text",
      placeholder: "Search…",
      value: this.initialQuery,
      attr: { inputmode: "search", enterkeyhint: "search", autocomplete: "off" },
    });
    const closeBtn = row.createEl("button", { cls: "csv-search-modal-close", text: "✕", title: "Close" });
    closeBtn.addEventListener("click", () => this.close());

    const countEl = contentEl.createDiv({ cls: "csv-search-modal-count" });

    // Results preview list. iOS keyboard shrinks the underlying view to
    // ~50px of content area, so the user can't see filter results on the
    // page while typing. Render top matches inside the modal itself —
    // tap a row to open its expander.
    const listEl = contentEl.createDiv({ cls: "csv-search-modal-list" });
    const PREVIEW_LIMIT = 40;

    const refresh = () => {
      const { matched, total } = this.resultCount();
      countEl.setText(input.value.trim()
        ? `${matched} of ${total} entries match`
        : `${total} entries — start typing to search`);

      listEl.empty();
      if (!input.value.trim()) return;
      const matches = this.getMatches().slice(0, PREVIEW_LIMIT);
      matches.forEach(({ title, subtitle, row }) => {
        const item = listEl.createDiv({ cls: "csv-search-modal-item" });
        item.createDiv({ cls: "csv-search-modal-item-title", text: title || "—" });
        if (subtitle) item.createDiv({ cls: "csv-search-modal-item-sub", text: subtitle });
        item.addEventListener("click", () => {
          this.close();
          this.onPick(row);
        });
      });
      if (matched > PREVIEW_LIMIT) {
        listEl.createDiv({
          cls: "csv-search-modal-more",
          text: `+ ${matched - PREVIEW_LIMIT} more — close to see all in the view`,
        });
      }
    };
    refresh();

    // Debounced apply — matches the inline-search behaviour so big tables
    // don't re-render on every keystroke.
    let debounce: number | null = null;
    input.addEventListener("input", () => {
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        this.onInput(input.value);
        refresh();
      }, 120);
    });
    // Pressing Enter / Return on the on-screen keyboard closes the modal
    // so the user can see the filtered list. Filter stays applied.
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.close();
    });

    // Autofocus after one frame so iOS reliably opens the keyboard
    // (focus called synchronously sometimes gets dropped on modal-open).
    requestAnimationFrame(() => {
      input.focus();
      // Caret at the end of existing query so user can extend or backspace.
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  onClose(): void {
    const vv = (window as { visualViewport?: VisualViewport }).visualViewport;
    if (vv && this.vvHandler) {
      vv.removeEventListener("resize", this.vvHandler);
      vv.removeEventListener("scroll", this.vvHandler);
    }
    this.vvHandler = null;
    this.contentEl.empty();
  }
}

// ─── File Config Modal ────────────────────────────────────────────────────────
// Per-file column mapping — which column is the kanban group, notes, status

export class FileConfigModal extends Modal {
  headers: string[];
  filePath: string;
  current: FileConfig;
  autoDetectedHabits: string[];
  availableModes: { id: ViewMode; label: string }[];
  onSave: (cfg: FileConfig) => void;

  constructor(app: App, headers: string[], filePath: string, current: FileConfig, autoDetectedHabits: string[], availableModes: { id: ViewMode; label: string }[], onSave: (cfg: FileConfig) => void) {
    super(app);
    this.headers = headers;
    this.filePath = filePath;
    this.current = { ...current, habitColumns: current.habitColumns ? [...current.habitColumns] : undefined };
    this.autoDetectedHabits = autoDetectedHabits;
    this.availableModes = availableModes;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csv-add-modal");
    contentEl.createEl("h2", { text: "View settings for this file", cls: "csv-modal-title" });
    contentEl.createEl("p", { text: "These settings apply only to this file and override the global defaults.", cls: "csv-modal-desc" });

    const form = contentEl.createDiv({ cls: "csv-modal-form" });
    const none = "— use global default —";
    const opts = [none, ...this.headers];

    const makeDropdown = (label: string, currentVal: string | undefined, onChange: (v: string | undefined) => void) => {
      const row = form.createDiv({ cls: "csv-modal-row" });
      row.createEl("label", { text: label, cls: "csv-modal-label" });
      const sel = row.createEl("select", { cls: "csv-modal-select" });
      opts.forEach(o => {
        const opt = sel.createEl("option", { text: o, value: o });
        if ((currentVal ?? none) === o) opt.selected = true;
      });
      sel.addEventListener("change", () => onChange(sel.value === none ? undefined : sel.value));
    };

    makeDropdown("Category column (kanban grouping)", this.current.categoryColumn, v => { this.current.categoryColumn = v; });
    makeDropdown("Status column (row subgroups)", this.current.statusColumn, v => { this.current.statusColumn = v; });
    makeDropdown("Notes column", this.current.notesColumn, v => { this.current.notesColumn = v; });

    // Habit columns (multi-select with checkboxes)
    const habitRow = form.createDiv({ cls: "csv-modal-row" });
    habitRow.createEl("label", { text: "Habit columns (dashboard)", cls: "csv-modal-label" });
    const habitDesc = habitRow.createEl("p", { cls: "csv-modal-hint", text: "Select columns to track as habits. Auto-detected columns with binary values (0/1) are pre-selected." });
    const habitGrid = habitRow.createDiv({ cls: "csv-modal-checkbox-grid" });

    // Determine which columns are selected (use config if set, else auto-detected)
    const selectedHabits = new Set(this.current.habitColumns ?? this.autoDetectedHabits);

    this.headers.forEach(h => {
      const label = habitGrid.createEl("label", { cls: "csv-modal-checkbox-label" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = selectedHabits.has(h);
      if (this.autoDetectedHabits.includes(h) && !this.current.habitColumns) {
        label.addClass("auto-detected");
      }
      label.createSpan({ text: h });

      checkbox.addEventListener("change", () => {
        if (!this.current.habitColumns) {
          this.current.habitColumns = [...this.autoDetectedHabits];
        }
        if (checkbox.checked) {
          if (!this.current.habitColumns.includes(h)) {
            this.current.habitColumns.push(h);
          }
        } else {
          this.current.habitColumns = this.current.habitColumns.filter(c => c !== h);
        }
      });
    });

    // Card fields — which columns to surface on Library/Kanban cards.
    // If never set, defaults to auto-detected (author/year/rating/theme).
    // Once the user touches the checkboxes, an explicit list is stored.
    const cardRow = form.createDiv({ cls: "csv-modal-row" });
    cardRow.createEl("label", { text: "Card fields (Library / Kanban)", cls: "csv-modal-label" });
    cardRow.createEl("p", { cls: "csv-modal-hint", text: "Columns shown under each card title. Rating renders as stars, theme/tag columns as pills. Leave all unchecked for title-only cards." });
    const cardGrid = cardRow.createDiv({ cls: "csv-modal-checkbox-grid" });

    // Auto-detected defaults — used when cardFields is undefined.
    const autoDetect = (candidates: string[]) =>
      this.headers.find(h => candidates.some(c => c.toLowerCase() === h.toLowerCase()));
    const autoFields = [
      autoDetect(["Author","Authors","Director","Artist","Creator","By"]),
      autoDetect(["Year","Date","Released"]),
      autoDetect(["Rating","Score","Score /5","Stars"]),
      autoDetect(["Theme","Tags","Tag","Mood"]),
    ].filter((c): c is string => !!c);
    const selectedCard = new Set(this.current.cardFields ?? autoFields);
    const isCustom = !!this.current.cardFields;

    this.headers.forEach(h => {
      const label = cardGrid.createEl("label", { cls: "csv-modal-checkbox-label" });
      const checkbox = label.createEl("input", { type: "checkbox" });
      checkbox.checked = selectedCard.has(h);
      if (autoFields.includes(h) && !isCustom) label.addClass("auto-detected");
      label.createSpan({ text: h });

      checkbox.addEventListener("change", () => {
        // First touch promotes auto-detected defaults into an explicit list.
        if (!this.current.cardFields) this.current.cardFields = [...autoFields];
        if (checkbox.checked) {
          if (!this.current.cardFields.includes(h)) this.current.cardFields.push(h);
        } else {
          this.current.cardFields = this.current.cardFields.filter(c => c !== h);
        }
      });
    });

    // Default mode for this file. The list comes from availableModes (same
    // source as the toolbar dropdown), so it offers exactly the modes this
    // file's columns can render — Travel appears for travel logs, Stats only
    // when there's something chartable, etc. The old hardcoded list both
    // omitted Travel and offered modes the file couldn't actually show.
    const modeRow = form.createDiv({ cls: "csv-modal-row" });
    modeRow.createEl("label", { text: "Default view", cls: "csv-modal-label" });
    const modeSel = modeRow.createEl("select", { cls: "csv-modal-select" });
    const modeOptions: [string, string][] = [
      ["— use global default —", ""],
      ...this.availableModes.map(m => [m.label, m.id] as [string, string]),
    ];
    // A previously saved mode the file can no longer render (columns changed)
    // still shows up, flagged — so the user can see and clear the stale pick.
    const saved = this.current.defaultMode ?? "";
    if (saved && !this.availableModes.some(m => m.id === saved)) {
      modeOptions.push([`${saved} (no longer available)`, saved]);
    }
    modeOptions.forEach(([label, val]) => {
      const opt = modeSel.createEl("option", { text: label, value: val });
      if (saved === val) opt.selected = true;
    });
    modeSel.addEventListener("change", () => { this.current.defaultMode = modeSel.value ? modeSel.value as ViewMode : undefined; });

    const btnRow = contentEl.createDiv({ cls: "csv-modal-btns" });
    btnRow.createEl("button", { text: "Cancel", cls: "csv-modal-cancel" }).addEventListener("click", () => this.close());
    btnRow.createEl("button", { text: "Save", cls: "csv-modal-submit" }).addEventListener("click", () => {
      this.onSave(this.current);
      this.close();
    });
  }

  onClose(): void { this.contentEl.empty(); }
}
