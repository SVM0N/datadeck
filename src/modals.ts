import {
  App,
  Modal,
  Component,
  MarkdownRenderer,
  Notice,
} from "obsidian";
import { CSVRow, FileConfig, ViewMode } from "./types";
import { showSelectPicker, titleCase, isMultiValueColName, looksCategorical, isTruthyVal } from "./utils";
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
  // True for 0/1 habit-style columns — they render as a toggle instead of a
  // text field so logging a day is a tap, not typing "1". Optional so callers
  // that don't track habits can omit it (defaults to never-boolean).
  isBooleanCol: (h: string) => boolean;
  // Predefined options per column (keyed by header). Merged ahead of the
  // file's existing values in the dropdown — e.g. a tasks file passes
  // { Type: ["Task","Note","Idea"], Priority: ["Low","Medium","High"] } so a
  // brand-new file offers them before any row exists to harvest values from.
  optionPresets: Record<string, string[]>;
  // Whether a column should render as a dropdown rather than free text.
  // Optional so callers that don't have a per-file categorical list fall
  // back to the historical auto-detection (configured select column, or a
  // low-cardinality "pseudo-categorical" one).
  isCategoricalCol: (h: string) => boolean;
  // The title/index column, excluded from every dropdown branch below since
  // it's always a free-text identifier. Optional so callers that don't have
  // a resolved titleKey() (or older call sites/tests) fall back to the
  // historical by-name guess — but a caller passing its own resolved title
  // (which already honours FileConfig.titleColumn) is what makes a
  // per-file Title override actually take effect here too.
  titleCol: string | undefined;

  constructor(
    app: App,
    headers: string[],
    isNotesCol: (h: string) => boolean,
    isSelectCol: (h: string) => boolean,
    getColumnValues: (h: string) => string[],
    onSubmit: (row: CSVRow) => void,
    optionPresets: Record<string, string[]> = {},
    isBooleanCol: (h: string) => boolean = () => false,
    isCategoricalCol?: (h: string) => boolean,
    titleCol?: string,
  ) {
    super(app);
    this.headers = headers;
    this.isNotesCol = isNotesCol;
    this.isSelectCol = isSelectCol;
    this.getColumnValues = getColumnValues;
    this.onSubmit = onSubmit;
    this.optionPresets = optionPresets;
    this.isBooleanCol = isBooleanCol;
    this.isCategoricalCol = isCategoricalCol ?? ((h) => this.isSelectCol(h) || looksCategorical(this.getColumnValues(h).length));
    this.titleCol = titleCol ?? this.headers.find(h => ["title", "name"].includes(h.toLowerCase()));
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
    const titleCol = this.titleCol;
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

      const presets = this.optionPresets[h] ?? [];
      // The title/index column is always a free-text identifier — never a
      // dropdown, whether that's inferred (few distinct values / presets) or
      // configured (settings.selectColumns / a per-file categorical list).
      // It's excluded up front so none of the branches below can route it
      // into a select.
      const isTitleCol = h === titleCol;
      const isMulti = isMultiValueColName(h);
      // Single-value categorical columns (preset-backed, or via
      // isCategoricalCol — configured select / per-file categorical list /
      // pseudo-categorical low-cardinality) render as a native <select>.
      // Crucially this keeps focus *inside* the modal — the body-appended
      // showSelectPicker (used elsewhere) loses focus to the modal's
      // focus-trap, which on an empty column made the field unfillable (it
      // bounced back to the title). Multi-value columns (tags/genres) still
      // use the chip picker since a native select can't multi-select cleanly.
      const useNativeSelect = !isTitleCol && !this.isNotesCol(h) && !isMulti && (presets.length > 0 || this.isCategoricalCol(h));

      if (this.isBooleanCol(h)) {
        // Habit-style 0/1 column → a toggle. Off writes "0", on "1", so logging
        // a day is a tap per habit instead of typing each value. Self-contained
        // (own knob + CSS) rather than Obsidian's .checkbox-container so it
        // renders consistently across themes.
        values[h] = "0";
        const toggle = row.createDiv({ cls: "csv-toggle" });
        toggle.createDiv({ cls: "csv-toggle-knob" });
        toggle.addEventListener("click", () => {
          const on = !toggle.hasClass("is-on");
          toggle.toggleClass("is-on", on);
          values[h] = on ? "1" : "0";
        });

      } else if (this.isNotesCol(h)) {
        const ta = row.createEl("textarea", { cls: "csv-modal-textarea", placeholder: "Markdown supported…" });
        ta.addEventListener("input", () => { values[h] = ta.value; });

      } else if (useNativeSelect) {
        // Options: presets first (canonical order), then any extra existing
        // values from the file, then a "+ Custom…" escape hatch that reveals
        // an inline text input — so the column is never a closed vocabulary.
        const CUSTOM = "__custom__";
        const merged: string[] = [];
        [...presets, ...this.getColumnValues(h)].forEach(v => {
          const t = (v ?? "").trim();
          if (t && !merged.some(m => m.toLowerCase() === t.toLowerCase())) merged.push(t);
        });
        const sel = row.createEl("select", { cls: "csv-modal-select" });
        sel.createEl("option", { text: "—", value: "" });
        merged.forEach(v => sel.createEl("option", { text: v, value: v }));
        sel.createEl("option", { text: "+ Custom…", value: CUSTOM });

        const customInput = row.createEl("input", { cls: "csv-modal-input csv-modal-custom", type: "text", placeholder: `Custom ${titleCase(h).toLowerCase()}` });
        customInput.hide();
        customInput.addEventListener("input", () => { values[h] = customInput.value; });
        customInput.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });

        sel.addEventListener("change", () => {
          if (sel.value === CUSTOM) {
            customInput.show();
            customInput.focus();
            values[h] = customInput.value;
          } else {
            customInput.hide();
            values[h] = sel.value;
          }
        });

      } else if (!isTitleCol && isMulti && this.isSelectCol(h)) {
        // Multi-value select (tags/genres/themes): chip + picker, which the
        // picker's "+ Add" / existing-value clicks drive. Still works inside
        // the modal because the user clicks options rather than typing into a
        // focus-trapped search.
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
  private isCategoricalCol: (h: string) => boolean;
  // The title/index column. Optional so callers/tests that don't have a
  // resolved titleKey() fall back to the historical by-name guess — but a
  // caller passing its own resolved title (already honouring
  // FileConfig.titleColumn) is what makes a per-file Title override
  // actually take effect in the header, the field list, and the delete
  // confirmation, instead of always re-guessing by name internally.
  private titleCol: string | undefined;
  // True for Checkbox-typed (Type: Checkbox / habit) columns — rendered as a
  // toggle here too, same as the Add-entry modal, instead of falling through
  // to a plain text field. Without this, editing an existing row was the one
  // place a Checkbox column's value wasn't actually constrained to 0/1 —
  // Config's Type picker wouldn't mean much if the row editor let you type
  // any string back into it. Optional so callers/tests that don't track
  // habit columns default to never-boolean (unchanged behaviour).
  private isBooleanCol: (h: string) => boolean;

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
    onDelete?: () => void,
    isCategoricalCol?: (h: string) => boolean,
    titleCol?: string,
    isBooleanCol: (h: string) => boolean = () => false,
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
    this.isCategoricalCol = isCategoricalCol
      ?? ((h) => this.isSelectCol(h) || (!isDateCol(h) && looksCategorical(this.getColumnValues(h).length)));
    this.titleCol = titleCol ?? this.headers.find(h => ["title", "name", "Title", "Name"].includes(h));
    this.isBooleanCol = isBooleanCol;
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
    header.createDiv({ cls: "csv-expander-title", text: this.row[this.titleCol ?? this.headers[0]] ?? "—" });
    const headerBtns = header.createDiv({ cls: "csv-expander-header-btns" });

    // ── Fields section (non-notes columns) ──────────────────────────────────
    const fieldsEl = contentEl.createDiv({ cls: "csv-expander-fields" });
    const titleKey = this.titleCol;
    const authorKey = this.headers.find(h => ["author","Author","director","Director","artist","Artist","creator","Creator"].includes(h));

    this.headers.forEach(h => {
      if (this.isNotesCol(h)) return; // notes rendered separately below
      const fieldRow = fieldsEl.createDiv({ cls: "csv-expander-field-row" });
      // titleCase: Apple-style row labels, independent of CSV header casing.
      fieldRow.createDiv({ cls: "csv-expander-field-label", text: titleCase(h) });

      if (this.isBooleanCol(h)) {
        // Same toggle as the Add-entry modal — "checked" is a narrow
        // truthy check (1/true/yes, case-insensitive), everything else
        // (0, "", no, false, or any leftover non-conforming text) reads as
        // unchecked; writing always normalizes to exactly "1" or "0".
        const isChecked = isTruthyVal(this.row[h] ?? "");
        const toggle = fieldRow.createDiv({ cls: `csv-toggle ${isChecked ? "is-on" : ""}` });
        toggle.createDiv({ cls: "csv-toggle-knob" });
        toggle.addEventListener("click", () => {
          const on = !toggle.hasClass("is-on");
          toggle.toggleClass("is-on", on);
          this.row[h] = on ? "1" : "0";
        });
        return;
      }

      // Configured select column, per-file categorical list, or a
      // pseudo-categorical one (few distinct values, e.g. Watched/Format) —
      // all get the chip + option picker, so editing offers the same
      // vocabulary the add form does. The title/index column is excluded —
      // it's a free-text identifier, never a dropdown, even if it's short on
      // distinct values or listed in selectColumns. Multi-value columns
      // (tags/genres) key off isSelectCol directly — isCategoricalCol never
      // treats them as categorical (a native select can't multi-select).
      const isMulti = isMultiValueColName(h);
      const selectLike = h !== titleKey && (isMulti ? this.isSelectCol(h) : this.isCategoricalCol(h));
      if (selectLike) {
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
    // Notes section is only rendered when the file actually has a notes column.
    // Files without one (e.g. an applications tracker that's all structured
    // fields) still open the expander to edit every other field — the notes
    // editor just isn't shown. `ta` stays null in that case; the Save handler
    // guards on this.notesCol before writing back.
    let isEditing = false;
    let currentText = this.notesCol ? (this.row[this.notesCol] ?? "") : "";
    let ta: HTMLTextAreaElement | null = null;

    if (this.notesCol) {
      const notesDivider = contentEl.createDiv({ cls: "csv-expander-divider" });
      notesDivider.createDiv({ cls: "csv-expander-notes-label", text: this.notesCol });

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

      ta = editorWrap.createEl("textarea", { cls: "csv-expander-textarea" });
      ta.value = currentText;
      ta.addEventListener("input", () => { currentText = ta!.value; });

      const enterEdit = () => {
        if (isEditing) return;
        isEditing = true;
        rendered.style.display = "none";
        editorWrap.style.display = "flex";
        ta!.value = currentText;
        ta!.focus();
      };
      const exitEdit = () => {
        if (!isEditing) return;
        isEditing = false;
        editorWrap.style.display = "none";
        rendered.style.display = "";
        currentText = ta!.value;
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
      ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); ta!.blur(); } });
      ta.addEventListener("blur", exitEdit);
    }

    // ── Footer buttons ───────────────────────────────────────────────────────
    // Layout: [Delete] ............... [Cancel] [Save & close]
    // Delete sits far left so it can't be hit by reflex when reaching for Save.
    const footer = contentEl.createDiv({ cls: "csv-expander-footer" });

    if (this.onDelete) {
      const titleVal = String(this.row[this.titleCol ?? this.headers[0]] ?? "").trim();
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
        // Only write back when there's a notes column (ta is null otherwise).
        if (this.notesCol) {
          if (isEditing && ta) currentText = ta.value;
          this.row[this.notesCol] = currentText;
        }
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

// What each of the 6 exclusive per-column roles would resolve to with no
// explicit fileCfg override — i.e. what titleKey/getCategoryCol/getStatusCol/
// getNotesCol/getImageCol/ankiFrontCol already do by name/position at
// render time. Lets the Config modal show "(auto)" on whichever column is
// already fulfilling a role, instead of looking like no column does.
export interface AutoDetectedRoles {
  title: string | null;
  category: string | null;
  status: string | null;
  notes: string | null;
  image: string | null;
  anki: string | null;
}

export class FileConfigModal extends Modal {
  headers: string[];
  filePath: string;
  current: FileConfig;
  autoDetectedHabits: string[];
  autoDetectedCategorical: string[];
  autoDetectedRoles: AutoDetectedRoles;
  availableModes: { id: ViewMode; label: string }[];
  onSave: (cfg: FileConfig) => void;
  // Column-structure ops (add/remove the CSV column itself, not its role).
  // Return a fresh headers/config snapshot so the modal can re-render in
  // place after a mutation rather than requiring a close+reopen.
  getHeaders: () => string[];
  getFileCfg: () => FileConfig;
  onAddColumn: (name: string) => string | null;
  onRemoveColumn: (header: string) => void;
  // Rewrites every row's value in one Checkbox-typed column to exactly "1"
  // (isTruthyVal match) or "0" (everything else), in place on the real CSV
  // data — unlike everything else in this modal, this isn't a pending
  // fileCfg edit deferred to Save; it mutates rows immediately, the same as
  // onAddColumn/onRemoveColumn. Returns how many cells actually changed, for
  // the confirmation Notice. Optional so older callers/tests default to a
  // no-op.
  onCleanupBooleanColumn: (header: string) => number;

  constructor(
    app: App, headers: string[], filePath: string, current: FileConfig, autoDetectedHabits: string[],
    autoDetectedCategorical: string[], autoDetectedRoles: AutoDetectedRoles,
    availableModes: { id: ViewMode; label: string }[], onSave: (cfg: FileConfig) => void,
    getHeaders: () => string[], getFileCfg: () => FileConfig,
    onAddColumn: (name: string) => string | null, onRemoveColumn: (header: string) => void,
    onCleanupBooleanColumn: (header: string) => number = () => 0,
  ) {
    super(app);
    this.headers = headers;
    this.filePath = filePath;
    this.current = {
      ...current,
      habitColumns: current.habitColumns ? [...current.habitColumns] : undefined,
      categoricalColumns: current.categoricalColumns ? [...current.categoricalColumns] : undefined,
    };
    this.autoDetectedHabits = autoDetectedHabits;
    this.autoDetectedCategorical = autoDetectedCategorical;
    this.autoDetectedRoles = autoDetectedRoles;
    this.availableModes = availableModes;
    this.onSave = onSave;
    this.getHeaders = getHeaders;
    this.getFileCfg = getFileCfg;
    this.onAddColumn = onAddColumn;
    this.onRemoveColumn = onRemoveColumn;
    this.onCleanupBooleanColumn = onCleanupBooleanColumn;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csv-add-modal");
    contentEl.createEl("h2", { text: "View settings for this file", cls: "csv-modal-title" });
    contentEl.createEl("p", { text: "These settings apply only to this file and override the global defaults.", cls: "csv-modal-desc" });

    const form = contentEl.createDiv({ cls: "csv-modal-form" });

    // Column structure — add a new CSV column or delete an existing one.
    // Re-fetches headers/config and calls onOpen() again after any mutation
    // so every row below reflects the new column set, and any per-file
    // config that pointed at a just-deleted column shows cleared. Only used
    // for structural changes (add/remove), which persist immediately via
    // onAddColumn/onRemoveColumn — everything else in this modal is a local
    // edit to `this.current` that isn't written until Save, so it uses the
    // lighter `renderRows()` below instead (a disk refetch here would wipe
    // any of those pending edits).
    const refresh = () => {
      this.headers = this.getHeaders();
      const cfg = this.getFileCfg();
      this.current = {
        ...cfg,
        habitColumns: cfg.habitColumns ? [...cfg.habitColumns] : undefined,
        categoricalColumns: cfg.categoricalColumns ? [...cfg.categoricalColumns] : undefined,
      };
      this.onOpen();
    };

    // ── Per-column configuration ────────────────────────────────────────────
    // An actual table — Column | Type | Function | Card field — instead of
    // separate sections or stacked cards. Type describes the column's data
    // shape (mutually exclusive: a column is one of Text/Checkbox/
    // Categorical, never two at once — Habit and Categorical used to be
    // independent toggles you could both check on the same column, which
    // never made sense). Function describes the single exclusive role a
    // column plays across views (Title/Category/Status/Notes/Image/Anki
    // front — each already only ever pointed at one column). Card field
    // stays an independent toggle since a column can be shown on cards
    // regardless of its type or function. Scrolls horizontally on narrow
    // (phone) widths rather than wrapping, same pattern as the sticky Table
    // view header.
    //
    // Status is deliberately kept as a Function, not folded into a
    // "Checkmark" Type: the Tasks-view done-checkmark comes from word-
    // matching (done/completed/closed/…) against whatever multi-valued
    // vocabulary a real Status column already uses (To Do/In Progress/
    // Blocked/Done), not from the column being strictly 2-valued. Row
    // grouping (Kanban subgroups) rides along on the same Function for the
    // same reason — it groups by whatever discrete values exist, not just
    // true/false.
    const colSection = form.createDiv({ cls: "csv-modal-row" });
    colSection.createEl("label", { text: "Columns", cls: "csv-modal-label" });
    colSection.createEl("p", {
      cls: "csv-modal-hint",
      text: "Type and Function are each exclusive per column — picking one clears it from whichever column held it before. \"auto\" means it's already doing that by column name, with nothing saved here yet. Card field is independent and can combine with anything. Checkbox columns get a \"Clean up\" action that rewrites every row to strict 1/0 right away — not deferred to Save.",
    });

    type ColType = "text" | "checkbox" | "categorical";
    const TYPE_OPTIONS: { value: ColType; label: string }[] = [
      { value: "text", label: "Text" },
      { value: "checkbox", label: "Checkbox" },
      { value: "categorical", label: "Categorical" },
    ];
    type Role = "title" | "category" | "status" | "notes" | "image" | "anki" | "";
    const ROLE_OPTIONS: { value: Role; label: string }[] = [
      { value: "", label: "— no function —" },
      { value: "title", label: "Title" },
      { value: "category", label: "Column grouping (Kanban lanes)" },
      { value: "status", label: "Row grouping / checkmark (Kanban subgroups, Tasks done)" },
      { value: "notes", label: "Notes" },
      { value: "image", label: "Image (card / kanban thumbnail)" },
      { value: "anki", label: "Anki card front" },
    ];
    // Explicit fileCfg fields always win outright over name-based detection —
    // mirrors titleKey/getCategoryCol/getStatusCol/getNotesCol/getImageCol/
    // ankiFrontCol, which never blend an auto guess in once a role has an
    // override, even if that override points at a column that no longer
    // looks like a great fit. So `auto: true` only appears when fully unset.
    const roleOf = (h: string): { role: Role; auto: boolean } => {
      if (this.current.titleColumn !== undefined) { if (this.current.titleColumn === h) return { role: "title", auto: false }; }
      else if (this.autoDetectedRoles.title === h) return { role: "title", auto: true };

      if (this.current.categoryColumn !== undefined) { if (this.current.categoryColumn === h) return { role: "category", auto: false }; }
      else if (this.autoDetectedRoles.category === h) return { role: "category", auto: true };

      if (this.current.statusColumn !== undefined) { if (this.current.statusColumn === h) return { role: "status", auto: false }; }
      else if (this.autoDetectedRoles.status === h) return { role: "status", auto: true };

      if (this.current.notesColumn !== undefined) { if (this.current.notesColumn === h) return { role: "notes", auto: false }; }
      else if (this.autoDetectedRoles.notes === h) return { role: "notes", auto: true };

      if (this.current.imageColumn !== undefined) { if (this.current.imageColumn === h) return { role: "image", auto: false }; }
      else if (this.autoDetectedRoles.image === h) return { role: "image", auto: true };

      if (this.current.ankiFrontCol !== undefined) { if (this.current.ankiFrontCol === h) return { role: "anki", auto: false }; }
      else if (this.autoDetectedRoles.anki === h) return { role: "anki", auto: true };

      return { role: "", auto: false };
    };
    // Only clears the role(s) *this* column currently holds — reassigning a
    // role to a different column evicts its previous holder for free, since
    // titleColumn/categoryColumn/etc. are each a single string field.
    const clearRoleFieldsFor = (h: string) => {
      if (this.current.titleColumn === h) this.current.titleColumn = undefined;
      if (this.current.categoryColumn === h) this.current.categoryColumn = undefined;
      if (this.current.statusColumn === h) this.current.statusColumn = undefined;
      if (this.current.notesColumn === h) this.current.notesColumn = undefined;
      if (this.current.imageColumn === h) this.current.imageColumn = undefined;
      if (this.current.ankiFrontCol === h) this.current.ankiFrontCol = undefined;
    };
    const setRole = (h: string, role: Role) => {
      clearRoleFieldsFor(h);
      if (role === "title") this.current.titleColumn = h;
      else if (role === "category") this.current.categoryColumn = h;
      else if (role === "status") this.current.statusColumn = h;
      else if (role === "notes") this.current.notesColumn = h;
      else if (role === "image") this.current.imageColumn = h;
      else if (role === "anki") this.current.ankiFrontCol = h;
    };

    // Type resolution: Checkbox beats Categorical when a column happens to
    // auto-detect as both (a 2-value 0/1 column is also low-cardinality) —
    // boolean is the more specific pattern. Each of habitColumns/
    // categoricalColumns is promoted to an explicit list independently, on
    // its own first touch, same as before; Type just presents them as one
    // exclusive picker instead of two independent checkboxes.
    const typeOf = (h: string): { type: ColType; auto: boolean } => {
      const habitList = this.current.habitColumns ?? this.autoDetectedHabits;
      const catList = this.current.categoricalColumns ?? this.autoDetectedCategorical;
      if (habitList.includes(h)) return { type: "checkbox", auto: !this.current.habitColumns };
      if (catList.includes(h)) return { type: "categorical", auto: !this.current.categoricalColumns };
      return { type: "text", auto: false };
    };
    const setType = (h: string, type: ColType) => {
      if (!this.current.habitColumns) this.current.habitColumns = [...this.autoDetectedHabits];
      if (!this.current.categoricalColumns) this.current.categoricalColumns = [...this.autoDetectedCategorical];
      this.current.habitColumns = this.current.habitColumns.filter(c => c !== h);
      this.current.categoricalColumns = this.current.categoricalColumns.filter(c => c !== h);
      if (type === "checkbox") this.current.habitColumns.push(h);
      else if (type === "categorical") this.current.categoricalColumns.push(h);
      // type === "text" leaves h out of both lists — the default.
    };

    // Auto-detected card-field defaults — used when cardFields is undefined.
    const autoDetect = (candidates: string[]) =>
      this.headers.find(h => candidates.some(c => c.toLowerCase() === h.toLowerCase()));
    const autoCardFields = [
      autoDetect(["Author","Authors","Director","Artist","Creator","By"]),
      autoDetect(["Year","Date","Released"]),
      autoDetect(["Rating","Score","Score /5","Stars"]),
      autoDetect(["Theme","Tags","Tag","Mood"]),
    ].filter((c): c is string => !!c);
    const titleCol = this.current.titleColumn ?? this.autoDetectedRoles.title ?? this.headers[0];

    const tableWrap = colSection.createDiv({ cls: "csv-modal-colcfg-table-wrap" });
    const table = tableWrap.createEl("table", { cls: "csv-modal-colcfg-table" });
    const thead = table.createEl("thead").createEl("tr");
    ["Column", "Type", "Function", "Card field"].forEach(h => thead.createEl("th", { text: h }));
    const tbody = table.createEl("tbody");

    const renderRows = () => {
      tbody.empty();
      const selectedCard = new Set(this.current.cardFields ?? autoCardFields);

      this.headers.forEach(h => {
        const row = tbody.createEl("tr");

        const nameCell = row.createEl("td", { cls: "csv-modal-colcfg-name" });
        nameCell.createSpan({ text: h });
        const rm = nameCell.createEl("button", {
          cls: "csv-modal-column-remove", text: "✕",
          attr: { title: `Remove "${h}" — deletes this column's data from every row` },
        });
        rm.addEventListener("click", () => {
          if (rm.hasClass("confirm")) {
            this.onRemoveColumn(h);
            refresh();
            return;
          }
          // Destructive — require a second click within a few seconds rather
          // than a native confirm() dialog, matching the rest of the modal.
          tbody.querySelectorAll(".csv-modal-column-remove.confirm").forEach(el => { el.removeClass("confirm"); el.setText("✕"); });
          rm.addClass("confirm");
          rm.setText("Confirm?");
          window.setTimeout(() => { if (rm.isConnected) { rm.removeClass("confirm"); rm.setText("✕"); } }, 3000);
        });

        // ── Type cell ──
        const typeCell = row.createEl("td", { cls: "csv-modal-colcfg-type-cell" });
        if (h === titleCol) {
          // The title/index column is always a free-text identifier — never
          // offered a Type picker at all, same as it never got a Categorical
          // checkbox before.
          typeCell.createSpan({ cls: "csv-modal-colcfg-fixed", text: "Text" });
        } else {
          const typeSel = typeCell.createEl("select", { cls: "csv-modal-select csv-modal-colcfg-type" });
          const { type: currentType, auto: isAutoType } = typeOf(h);
          TYPE_OPTIONS.forEach(o => {
            const opt = typeSel.createEl("option", { text: o.label, value: o.value });
            if (o.value === currentType) opt.selected = true;
          });
          if (isAutoType) typeSel.addClass("auto-detected");
          typeSel.addEventListener("change", () => {
            setType(h, typeSel.value as ColType);
            renderRows();
          });
          if (isAutoType) typeCell.createSpan({ cls: "csv-modal-colcfg-auto-badge", text: "auto" });

          // Clean up: rewrites every row's raw value in this column to
          // exactly "1" (yes/true/1) or "0" (everything else) — the same
          // isTruthyVal rule the toggle itself uses to decide checked/
          // unchecked, just applied to the whole column at once instead of
          // one row at a time as you happen to click through them. Only
          // offered once a column is actually Checkbox-typed — this acts on
          // real row data immediately, not a pending Save-deferred edit, so
          // it gets the same two-click confirm as removing a column.
          if (currentType === "checkbox") {
            const cleanupBtn = typeCell.createEl("button", {
              cls: "csv-modal-colcfg-cleanup-btn", text: "Clean up",
              attr: { title: `Rewrite every row in "${h}" to strict 1/0 (yes/true/1 → 1, everything else → 0)` },
            });
            cleanupBtn.addEventListener("click", () => {
              if (cleanupBtn.hasClass("confirm")) {
                const changed = this.onCleanupBooleanColumn(h);
                new Notice(changed > 0 ? `"${h}": normalized ${changed} row${changed === 1 ? "" : "s"} to 1/0.` : `"${h}" is already strict 1/0 — nothing to change.`);
                return;
              }
              tbody.querySelectorAll(".csv-modal-colcfg-cleanup-btn.confirm").forEach(el => { el.removeClass("confirm"); el.setText("Clean up"); });
              cleanupBtn.addClass("confirm");
              cleanupBtn.setText("Confirm?");
              window.setTimeout(() => { if (cleanupBtn.isConnected) { cleanupBtn.removeClass("confirm"); cleanupBtn.setText("Clean up"); } }, 3000);
            });
          }
        }

        // ── Function cell ──
        const fnCell = row.createEl("td", { cls: "csv-modal-colcfg-fn-cell" });
        const roleSel = fnCell.createEl("select", { cls: "csv-modal-select csv-modal-colcfg-role" });
        const { role: currentRole, auto: isAutoRole } = roleOf(h);
        ROLE_OPTIONS.forEach(o => {
          const opt = roleSel.createEl("option", { text: o.label, value: o.value });
          if (o.value === currentRole) opt.selected = true;
        });
        if (isAutoRole) roleSel.addClass("auto-detected");
        roleSel.addEventListener("change", () => {
          setRole(h, roleSel.value as Role);
          renderRows();
        });
        if (isAutoRole) fnCell.createSpan({ cls: "csv-modal-colcfg-auto-badge", text: "auto" });

        // ── Card field cell ──
        const cardCell = row.createEl("td", { cls: "csv-modal-colcfg-card-cell" });
        const cardCb = cardCell.createEl("input", { type: "checkbox" });
        cardCb.checked = selectedCard.has(h);
        if (autoCardFields.includes(h) && !this.current.cardFields) cardCb.addClass("auto-detected");
        cardCb.addEventListener("change", () => {
          if (!this.current.cardFields) this.current.cardFields = [...autoCardFields];
          if (cardCb.checked) { if (!this.current.cardFields.includes(h)) this.current.cardFields.push(h); }
          else { this.current.cardFields = this.current.cardFields.filter(c => c !== h); }
        });
      });
    };
    renderRows();

    const addColWrap = colSection.createDiv({ cls: "csv-modal-add-column" });
    const addColInput = addColWrap.createEl("input", { cls: "csv-modal-input", type: "text", placeholder: "New column name" });
    const addColBtn = addColWrap.createEl("button", { cls: "csv-modal-cancel", text: "+ Add column" });
    const doAdd = () => {
      const err = this.onAddColumn(addColInput.value);
      if (err) { new Notice(err); return; }
      refresh();
    };
    addColBtn.addEventListener("click", doAdd);
    addColInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });

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

// ─── Prompt modal ───────────────────────────────────────────────────────────
//
// A minimal single-field text prompt (title + input + Cancel/OK). Used by the
// "create … file" palette commands to ask for the new file's name. onSubmit
// fires only on OK/Enter with a non-empty value, so callers never have to
// guard against blank names.
export class PromptModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private initial: string,
    private placeholder: string,
    private onSubmit: (value: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("csv-add-modal");
    contentEl.createEl("h2", { text: this.title, cls: "csv-modal-title" });

    const input = contentEl.createEl("input", { cls: "csv-modal-field", type: "text" });
    input.value = this.initial;
    input.placeholder = this.placeholder;
    // Select the basename so the user can type over the default immediately.
    window.setTimeout(() => { input.focus(); input.select(); }, 0);

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.onSubmit(value);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });

    const btnRow = contentEl.createDiv({ cls: "csv-modal-btns" });
    btnRow.createEl("button", { text: "Cancel", cls: "csv-modal-cancel" }).addEventListener("click", () => this.close());
    btnRow.createEl("button", { text: "Create", cls: "csv-modal-submit" }).addEventListener("click", submit);
  }

  onClose(): void { this.contentEl.empty(); }
}
