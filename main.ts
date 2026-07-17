import {
  Plugin,
  FileView,
  WorkspaceLeaf,
  Component,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  normalizePath,
  stringifyYaml,
} from "obsidian";
import Papa from "papaparse";
// Type-only import — erased at compile time, no runtime cost. Used for the
// chartInstance field type; the actual module is lazy-loaded inside
// src/view/dashboard.ts, so non-dashboard sessions never load Chart.js.
import type { Chart as ChartType } from "chart.js";

// Import from src modules
import { CSVRow, ViewMode, FileConfig, CardViewSettings, DEFAULT_SETTINGS, CARD_VIEW_TYPE } from "./src/types";
import { sanitizeFilename, tagify, showSelectPicker, parseCSV, migrateFileConfigKey, sortRowsByColumn, isMultiValueColName, IMAGE_COL_ALIASES, TITLE_COL_ALIASES, CATEGORY_COL_ALIASES, STATUS_COL_ALIASES, NOTES_COL_ALIASES, looksBoolean, looksCategorical, isTruthyVal, stashSyncConflict } from "./src/utils";
import { isDateCol } from "./src/field-types";
import { AddEntryModal, NoteExpanderModal, PromptModal } from "./src/modals";
import { renderTravel } from "./src/travel-view";
import { CardViewSettingTab } from "./src/settings-tab";
import { renderAddEntryForm } from "./src/add-entry-form";
import { renderTable } from "./src/view/table";
import { renderLibrary } from "./src/view/library";
import { renderKanbanGenre, effectiveGroupCol } from "./src/view/kanban";
import { renderToolbar, availableModes } from "./src/view/toolbar";
import { renderRandomCard } from "./src/random-block";
import { renderDashboard } from "./src/view/dashboard";
import { renderStats, hasStatsColumns } from "./src/view/stats";
import { renderChart, hasChartColumns } from "./src/view/chart";
import { renderFocus } from "./src/view/focus";
import { renderTasks, hasTaskColumns, taskProjectCol, taskTypeCol, taskPriorityCol } from "./src/view/tasks";
import { renderBudget, hasBudgetColumns } from "./src/view/budget";
import { registerCsvViewBlock } from "./src/inline-view";
import { registerCsvChartBlock } from "./src/chart-block";
import { registerCsvTasksBlock } from "./src/tasks-block";
import worldMapSvg from "./world-map.svg";

// ─── View ────────────────────────────────────────────────────────────────────

export class CardView extends FileView {
  settings: CardViewSettings;
  headers: string[] = [];
  rows: CSVRow[] = [];
  mode: ViewMode;
  private renderComponent: Component;
  private saveTimer: number | null = null;
  searchQuery: string = "";
  // Callback into the plugin to persist `settings` to data.json.
  // Passed at construction time (see CardViewPlugin.onload) so the view
  // doesn't have to reach back through `(app as any).plugins.plugins[...]`
  // to find its own plugin instance.
  persistSettings: () => Promise<void>;

  constructor(leaf: WorkspaceLeaf, settings: CardViewSettings, persistSettings: () => Promise<void>) {
    super(leaf);
    this.settings = settings;
    this.persistSettings = persistSettings;
    this.mode = settings.defaultMode;
    this.renderComponent = new Component();
    this.renderComponent.load();
  }

  getViewType() { return CARD_VIEW_TYPE; }
  getDisplayText() { return this.file?.basename ?? "Card View"; }
  getIcon() { return "table"; }

  // ── File I/O ───────────────────────────────────────────────────────────────

  // The CSV text as we last read or wrote it. The anchor for sync safety:
  // an on-disk value that diverges from this means another writer (device,
  // tab, iCloud) touched the file since we last agreed with it.
  private lastDiskContent: string | null = null;

  onload(): void {
    super.onload();
    // Re-sync when the open file changes underneath us — the inline csv-view
    // block always did this; the full view showed stale data until reopen.
    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (!this.file || f.path !== this.file.path) return;
      void this.syncFromDisk();
    }));
  }

  /**
   * Refresh from disk after an external change. Skips our own writes
   * (content equality with lastDiskContent) and mid-edit states — when a
   * debounced save is pending, doSave's conflict stash reconciles instead,
   * so the user's in-flight edits aren't yanked out from under them.
   */
  private async syncFromDisk(): Promise<void> {
    if (!this.file) return;
    const text = await this.app.vault.read(this.file);
    if (text === this.lastDiskContent) return;
    if (this.saveTimer) return;
    this.lastDiskContent = text;
    const parsed = parseCSV(text);
    this.headers = parsed.headers;
    this.rows = parsed.rows;
    this.renderViewPreservingScroll();
  }

  async onLoadFile(file: TFile): Promise<void> {
    try {
      const text = await this.app.vault.read(file);
      const parsed = parseCSV(text);
      this.headers = parsed.headers;
      this.rows = parsed.rows;
      this.lastDiskContent = text;
    } catch (e) {
      console.error("CardView load error", e);
      this.headers = []; this.rows = []; this.lastDiskContent = null;
      // Surface to the user — silent failure leaves an empty view with no clue why.
      new Notice(`Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
    // Apply per-file default mode if set, or auto-detect based on columns
    if (this.file && this.settings.fileConfigs[this.file.path]?.defaultMode) {
      this.mode = this.settings.fileConfigs[this.file.path].defaultMode!;
    } else if (this.isTravelFile()) {
      // Travel logs (country/date/source columns) get the map view by default.
      // Checked before the date-column rule since they also have date columns.
      this.mode = "travel";
    } else if (this.hasDateColumn()) {
      // Auto-default to dashboard if date column detected
      this.mode = "dashboard";
    } else {
      this.mode = this.settings.defaultMode;
    }
    // Guard: if the resolved mode requires a column this file doesn't have,
    // fall back to "table" so we never land on a broken empty-state screen.
    // Cards/Kanban only need *some* groupable column (per-file pick →
    // category → auto fallback; see effectiveGroupCol in view/kanban.ts).
    const needsCategory = this.mode === "kanban-genre" || this.mode === "library";
    const needsDate = this.mode === "dashboard";
    if ((needsCategory && !effectiveGroupCol(this)) || (needsDate && !this.hasDateColumn())
        || (this.mode === "travel" && !this.isTravelFile())
        || (this.mode === "stats" && !hasStatsColumns(this))
        || (this.mode === "chart" && !hasChartColumns(this))
        || (this.mode === "tasks" && !hasTaskColumns(this))
        || (this.mode === "budget" && !hasBudgetColumns(this))) {
      this.mode = "table";
    }
    this.selectedDate = null; // Reset selected date when loading new file
    this.focusIndex = 0;      // Focus view starts at the first entry per file
    this.tableSortCol = null; // Manual column sort doesn't carry across files
    this.renderView();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    if (this.chartInstance) { this.chartInstance.destroy(); this.chartInstance = null; }
    this.headers = []; this.rows = []; this.contentEl.empty();
  }

  scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { void this.doSave(); }, 600);
  }

  private async doSave(): Promise<void> {
    if (!this.file) return;
    try {
      const csv = Papa.unparse(this.rows, { columns: this.headers });
      // Sync safety: this is a whole-file overwrite from in-memory rows. If
      // the file changed on disk since we last agreed with it, stash that
      // version to Archive/ first so the other writer's edits survive —
      // last-write-wins at the file level used to silently eat them.
      try {
        const onDisk = await this.app.vault.read(this.file);
        if (this.lastDiskContent !== null && onDisk !== this.lastDiskContent && onDisk !== csv) {
          await stashSyncConflict(this.app, this.file, onDisk);
        }
      } catch { /* unreadable right now — proceed with the write */ }
      this.lastDiskContent = csv;
      await this.app.vault.modify(this.file, csv);
    } catch (e) {
      console.error("CardView save error", e);
      // Surface — the debounced save is invisible, so a permission / iCloud
      // sync conflict otherwise looks like "my edits stuck" until reload.
      new Notice(`Couldn't save ${this.file.name}: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  // ── Per-file config ────────────────────────────────────────────────────────

  get fileCfg(): FileConfig {
    return this.file ? (this.settings.fileConfigs[this.file.path] ?? {}) : {};
  }

  saveFileCfg(cfg: FileConfig): void {
    if (!this.file) return;
    this.settings.fileConfigs[this.file.path] = cfg;
    // Fire-and-forget — saveSettings is debounce-safe inside Obsidian.
    void this.persistSettings();
  }

  // ── Title highlight ────────────────────────────────────────────────────────
  // Per-file, keyed by the title-column value (like collapsedGroups) rather
  // than a row index/id — the CSV has no stable identity column, and a
  // value-based key is resilient to row reordering/sort changes.

  isHighlighted(row: CSVRow): boolean {
    return (this.fileCfg.highlightedTitles ?? []).includes(this.getTitle(row));
  }

  toggleHighlight(row: CSVRow): void {
    const title = this.getTitle(row);
    const cfg = this.fileCfg;
    const list = cfg.highlightedTitles ? [...cfg.highlightedTitles] : [];
    const idx = list.indexOf(title);
    if (idx >= 0) list.splice(idx, 1); else list.push(title);
    cfg.highlightedTitles = list;
    this.saveFileCfg(cfg);
  }

  // ── Column structure ───────────────────────────────────────────────────────
  // Add/remove a CSV column itself (not just its role). Used by the ⚙ Columns
  // modal. `doSave` writes with `columns: this.headers`, so pushing/filtering
  // headers is what actually changes the file's shape on next save.

  /** Returns an error message on failure, or null on success. */
  addColumn(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return "Column name can't be empty.";
    if (this.headers.some(h => h.toLowerCase() === trimmed.toLowerCase())) return `"${trimmed}" already exists.`;
    this.headers.push(trimmed);
    this.rows.forEach(r => { r[trimmed] = ""; });
    this.scheduleSave();
    this.renderViewPreservingScroll();
    return null;
  }

  /**
   * Deletes a column and its data from every row. Also clears any per-file
   * config pointing at it (category/status/notes/anki/card-fields/habits/
   * categorical) so a stale reference doesn't silently break kanban
   * grouping, the Add form, etc. after the column is gone.
   */
  removeColumn(header: string): void {
    this.headers = this.headers.filter(h => h !== header);
    this.rows.forEach(r => { delete r[header]; });
    const cfg = this.fileCfg;
    if (cfg.categoryColumn === header) cfg.categoryColumn = undefined;
    if (cfg.statusColumn === header) cfg.statusColumn = undefined;
    if (cfg.notesColumn === header) cfg.notesColumn = undefined;
    if (cfg.ankiFrontCol === header) cfg.ankiFrontCol = undefined;
    if (cfg.kanbanGroupCol === header) cfg.kanbanGroupCol = undefined;
    if (cfg.habitColumns) cfg.habitColumns = cfg.habitColumns.filter(h => h !== header);
    if (cfg.cardFields) cfg.cardFields = cfg.cardFields.filter(h => h !== header);
    if (cfg.categoricalColumns) cfg.categoricalColumns = cfg.categoricalColumns.filter(h => h !== header);
    this.saveFileCfg(cfg);
    this.scheduleSave();
    this.renderViewPreservingScroll();
  }

  // ── Field helpers ──────────────────────────────────────────────────────────

  // ── Field helpers with fallback chains ────────────────────────────────────

  // Tries each candidate in order, returns first match found in headers
  resolveCol(candidates: string[]): string | null {
    for (const c of candidates) {
      const found = this.headers.find(h => h.toLowerCase() === c.toLowerCase());
      if (found) return found;
    }
    return null;
  }

  // Role getters: an explicit per-file override wins outright — including the
  // empty string, which the ⚙ Config modal stores for "— no function —" and
  // which must read as *disabled*, not "fall back to name detection" (that's
  // what InlineCardHost already does; the two views must agree on the same
  // fileCfg entry).
  getNotesCol(): string | null {
    if (this.fileCfg.notesColumn !== undefined) {
      return this.fileCfg.notesColumn === "" ? null : this.fileCfg.notesColumn;
    }
    return this.resolveCol(NOTES_COL_ALIASES);
  }

  isNotesCol(h: string): boolean {
    const notesCol = this.getNotesCol();
    // If we resolved a specific column, only that one qualifies
    if (notesCol) return h === notesCol;
    // Otherwise fall back to global list (shouldn't normally reach here)
    return this.settings.notesColumns.some(n => n.toLowerCase() === h.toLowerCase());
  }

  isSelectCol(h: string) { return this.settings.selectColumns.some(s => s.toLowerCase()===h.toLowerCase()); }

  /**
   * Whether a column should render as a dropdown (Add entry / entry editor /
   * mobile add form) rather than free text. Single source of truth: an
   * explicit per-file `categoricalColumns` list wins outright when set;
   * otherwise falls back to the historical auto-detection (a configured
   * select column, or a low-cardinality "pseudo-categorical" one). The
   * title/index column and date columns are never categorical, regardless
   * of the list — a free-text identifier or a date picker, never a select.
   */
  isCategoricalCol(h: string): boolean {
    const titleCol = this.titleKey() ?? this.headers[0];
    if (h === titleCol || this.isDateCol(h) || isMultiValueColName(h)) return false;
    if (this.fileCfg.categoricalColumns) return this.fileCfg.categoricalColumns.includes(h);
    return this.isSelectCol(h) || looksCategorical(this.getColumnValues(h).length);
  }

  /** What isCategoricalCol would auto-detect with no per-file override — drives the ⚙ Columns checkbox pre-check. */
  autoDetectCategoricalColumns(): string[] {
    const titleCol = this.titleKey() ?? this.headers[0];
    return this.headers.filter(h => {
      if (h === titleCol || this.isDateCol(h) || isMultiValueColName(h) || this.isNotesCol(h)) return false;
      return this.isSelectCol(h) || looksCategorical(this.getColumnValues(h).length);
    });
  }

  isDateCol(h: string): boolean {
    if (this.fileCfg.dateColumns?.includes(h)) return true;
    return isDateCol(h);
  }

  getStatusCol(): string | null {
    if (this.fileCfg.statusColumn !== undefined) {
      if (this.fileCfg.statusColumn === "") return null;
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.statusColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol(STATUS_COL_ALIASES);
  }

  getCategoryCol(): string | null {
    if (this.fileCfg.categoryColumn !== undefined) {
      if (this.fileCfg.categoryColumn === "") return null;
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.categoryColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol(CATEGORY_COL_ALIASES);
  }

  titleKey(): string | undefined {
    if (this.fileCfg.titleColumn !== undefined) {
      if (this.fileCfg.titleColumn === "") return undefined;
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.titleColumn!.toLowerCase()) ?? undefined;
    }
    return this.resolveCol(TITLE_COL_ALIASES) ?? undefined;
  }

  authorKey(): string | undefined {
    return this.resolveCol([
      "Author","author","Authors","authors",
      "Director","director",
      "Artist","artist",
      "Creator","creator",
      "By","by",
    ]) ?? undefined;
  }
  getTitle(row: CSVRow) { const k=this.titleKey(); return (k?row[k]:row[this.headers[0]])??"—"; }
  getSubtitle(row: CSVRow) { const k=this.authorKey(); return k?row[k]??"":""; }
  getColumnValues(h: string) { return Array.from(new Set(this.rows.map(r=>r[h]??"").filter(Boolean))).sort(); }
  // Image column for card/kanban thumbnails — per-file override (reuses the
  // cardImageColumn config) or detected by name (Image/Cover/Poster/…).
  getImageCol(): string | null {
    if (this.fileCfg.imageColumn !== undefined) {
      if (this.fileCfg.imageColumn === "") return null;
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.imageColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol(IMAGE_COL_ALIASES);
  }

  // ── Notes file ─────────────────────────────────────────────────────────────

  private notesFilePath(row: CSVRow): string {
    const title = sanitizeFilename(this.getTitle(row));
    const csvFolder = this.file?.parent?.path??"";
    const sub = this.settings.notesSubfolder.trim();
    const folder = sub?(csvFolder?`${csvFolder}/${sub}`:sub):csvFolder;
    return normalizePath(`${folder}/${title}.md`);
  }

  notesFileExists(row: CSVRow) { return !!this.app.vault.getAbstractFileByPath(this.notesFilePath(row)); }

  /**
   * Remove a row, save, re-render — and offer Undo via a Notice. Restoring
   * preserves the original index, so kanban / table positions don't visually
   * jump on undo. Idempotent: clicking Undo twice is a no-op (the button
   * disables itself after the first click).
   *
   * Used by every delete path (expander modal, kanban right-click, table
   * row button) so deletes have one consistent escape hatch.
   */
  deleteWithUndo(row: CSVRow): void {
    const idx = this.rows.indexOf(row);
    if (idx < 0) return;
    this.rows.splice(idx, 1);
    this.scheduleSave();
    // In-place edit — the user deleted from where they are; keep them
    // anchored there instead of yanking the view to (0,0).
    this.renderViewPreservingScroll();

    const title = this.getTitle(row) || "entry";
    const frag = createFragment();
    frag.createSpan({ text: `Deleted “${title}”. ` });
    const undoBtn = frag.createEl("button", { text: "Undo", cls: "csv-notice-undo" });
    const notice = new Notice(frag, 6000);
    undoBtn.addEventListener("click", () => {
      if (undoBtn.hasAttribute("disabled")) return;
      undoBtn.setAttribute("disabled", "true");
      // Clamp insert position — other deletes/adds during the 6s window
      // may have shifted the array; idx may now be past end.
      const insertAt = Math.min(idx, this.rows.length);
      this.rows.splice(insertAt, 0, row);
      this.scheduleSave();
      this.renderViewPreservingScroll();
      notice.hide();
      new Notice(`Restored “${title}”`, 2500);
    });
  }

  /**
   * Open the right-click context menu for a row. Same items everywhere
   * the user can click on a row — kanban card, library card, table row.
   * Previously only the kanban card had this; the parity gap meant
   * power-users in library/table had to use buttons for status changes
   * and the toolbar for delete.
   */
  openRowContextMenu(row: CSVRow, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Open / create notes file").setIcon("file-text").onClick(() => this.openOrCreateNotes(row)));
    // Always offered — the expander edits every structured field; on files
    // without a notes column it simply omits the notes editor.
    menu.addItem(i => i.setTitle("Open entry").setIcon("maximize").onClick(() => this.openNoteExpander(row, this.getNotesCol() ?? "")));
    const sc = this.getStatusCol();
    if (sc) {
      const statuses = this.getColumnValues(sc);
      if (statuses.length) {
        menu.addSeparator();
        statuses.forEach(s => {
          if (s === row[sc]) return;
          menu.addItem(i => i.setTitle(`Mark as: ${s}`).onClick(() => { row[sc] = s; this.scheduleSave(); this.renderViewPreservingScroll(); }));
        });
      }
    }
    menu.addSeparator();
    const highlighted = this.isHighlighted(row);
    menu.addItem(i => i.setTitle(highlighted ? "Remove highlight" : "Highlight").setIcon("highlighter")
      .onClick(() => { this.toggleHighlight(row); this.renderViewPreservingScroll(); }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Delete").setIcon("trash").onClick(() => this.deleteWithUndo(row)));
    menu.showAtMouseEvent(e);
  }

  async openOrCreateNotes(row: CSVRow): Promise<void> {
    const path = this.notesFilePath(row);
    let file = this.app.vault.getAbstractFileByPath(path) as TFile|null;
    if (!file) {
      // Serialize properties with stringifyYaml — hand-built `key: "value"`
      // lines broke on values containing backslashes (invalid YAML escapes)
      // or newlines (multi-line CSV cells), which corrupted the whole
      // properties block in Obsidian.
      const fmObj: Record<string, unknown> = {};
      // On a tasks/projects file, surface the project column as a tag so notes
      // spawned from rows roll up under #project-… in the tag pane / graph /
      // any vault-wide dashboard scan — not just as a structured property.
      // Comma-separated projects → one tag each. Skipped for non-task files.
      const projectCol = hasTaskColumns(this) ? taskProjectCol(this) : null;
      const tags = projectCol
        ? (row[projectCol] ?? "").split(",").map(p=>tagify(p.trim())).filter(Boolean).map(t=>`project-${t}`)
        : [];
      if (tags.length) fmObj.tags = tags;
      for (const h of this.headers) { if (!this.isNotesCol(h) && row[h]) fmObj[h] = row[h]; }
      // Wikilink back to the CSV: gives every sidecar note a backlink to its
      // source file. Obsidian property names are case-insensitive, so skip
      // when any column is already named "source".
      if (this.file && !Object.keys(fmObj).some(k=>k.toLowerCase()==="source")) fmObj.source = `[[${this.file.path}]]`;
      const fm = ["---",stringifyYaml(fmObj).trimEnd(),"---","",`# ${this.getTitle(row)}`,"",""].join("\n");
      const notesCol = this.headers.find(h=>this.isNotesCol(h));
      const content = fm+(notesCol&&row[notesCol]?.trim()?row[notesCol]:"");
      const folderPath = path.substring(0,path.lastIndexOf("/"));
      if (folderPath&&!this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath);
      file = await this.app.vault.create(path,content);
      new Notice(`Created: ${file.name}`);
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  openNoteExpander(row: CSVRow, notesCol: string): void {
    new NoteExpanderModal(
      this.app,
      row,
      notesCol,
      this.headers,
      this.file?.path ?? "",
      this.isNotesCol.bind(this),
      this.isSelectCol.bind(this),
      this.getColumnValues.bind(this),
      (updatedRow) => {
        // Apply all field changes back to the original row
        Object.assign(row, updatedRow);
        this.scheduleSave();
        // Re-render rebuilds the whole content area, so scroll positions
        // would reset to (0,0). Snapshot scroll across all known scrollers
        // (table y+x, library y, kanban board x + per-column y) and restore
        // after the re-render so closing the expander doesn't jump the view.
        this.renderViewPreservingScroll();
      },
      // Delete with undo: the helper handles splice + save + rerender + Notice.
      () => this.deleteWithUndo(row),
      c => this.isCategoricalCol(c),
      this.titleKey(),
      c => this.getBooleanColumns().includes(c),
      c => this.isDateCol(c)
    ).open();
  }

  /**
   * Snapshot scroll positions of every scrollable container in the current
   * view, re-render, then put them back. Used after modal saves so the user
   * isn't yanked back to (0,0) every time they edit an entry.
   *
   * Kanban columns are keyed by their header text — column DOM nodes are
   * recreated on re-render, so we re-find the same column by its (stable)
   * title and replay its scrollTop. Replays are scheduled across two rAFs +
   * a setTimeout because Obsidian sometimes adjusts scroll after our
   * immediate write (matches the same defense used in the inline note editor).
   */
  renderViewPreservingScroll(): void {
    const root = this.contentEl;
    const contentArea = root.querySelector<HTMLElement>(".csv-content-area");
    const tableWrap = root.querySelector<HTMLElement>(".csv-table-wrapper");
    const kanbanBoard = root.querySelector<HTMLElement>(".csv-kanban-board");
    const snapshot = {
      contentTop: contentArea?.scrollTop ?? 0,
      contentLeft: contentArea?.scrollLeft ?? 0,
      tableLeft: tableWrap?.scrollLeft ?? 0,
      tableTop: tableWrap?.scrollTop ?? 0,
      boardLeft: kanbanBoard?.scrollLeft ?? 0,
      cols: new Map<string, number>(),
    };
    root.querySelectorAll<HTMLElement>(".csv-kanban-col").forEach(col => {
      const title = col.querySelector(".csv-kanban-col-title")?.textContent ?? "";
      const body = col.querySelector<HTMLElement>(".csv-kanban-col-body");
      if (title && body) snapshot.cols.set(title, body.scrollTop);
    });

    this.renderView();

    const restore = () => {
      const ca = this.contentEl.querySelector<HTMLElement>(".csv-content-area");
      const tw = this.contentEl.querySelector<HTMLElement>(".csv-table-wrapper");
      const kb = this.contentEl.querySelector<HTMLElement>(".csv-kanban-board");
      if (ca) { ca.scrollTop = snapshot.contentTop; ca.scrollLeft = snapshot.contentLeft; }
      if (tw) { tw.scrollLeft = snapshot.tableLeft; tw.scrollTop = snapshot.tableTop; }
      if (kb) kb.scrollLeft = snapshot.boardLeft;
      this.contentEl.querySelectorAll<HTMLElement>(".csv-kanban-col").forEach(col => {
        const title = col.querySelector(".csv-kanban-col-title")?.textContent ?? "";
        const body = col.querySelector<HTMLElement>(".csv-kanban-col-body");
        const saved = snapshot.cols.get(title);
        if (body && saved != null) body.scrollTop = saved;
      });
    };
    restore();
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
    window.setTimeout(restore, 50);
  }

  openAddModal(): void {
    // On a tasks/projects file, seed the Type and Priority dropdowns with their
    // canonical vocabularies so a brand-new file offers them before any row
    // exists to harvest values from. (Skipped elsewhere — a movies "Type"
    // holds genres, not Task/Note/Idea.)
    const optionPresets: Record<string, string[]> = {};
    if (hasTaskColumns(this)) {
      const typeCol = taskTypeCol(this);
      if (typeCol) optionPresets[typeCol] = ["Task", "Note", "Idea"];
      const priCol = taskPriorityCol(this);
      if (priCol) optionPresets[priCol] = ["Low", "Medium", "High"];
    }
    new AddEntryModal(
      this.app,
      this.headers,
      this.isNotesCol.bind(this),
      this.isSelectCol.bind(this),
      this.getColumnValues.bind(this),
      (row) => {
        this.rows.push(row);
        this.scheduleSave();
        // Keep the user where they were — the new entry's discoverable via
        // the Notice; yanking to (0,0) just disorients them.
        this.renderViewPreservingScroll();
        new Notice(`Added: ${this.getTitle(row)}`);
      },
      optionPresets,
      // Habit/0-1 columns render as toggles in the add form.
      (h) => this.getBooleanColumns().includes(h),
      c => this.isCategoricalCol(c),
      this.titleKey(),
      c => this.isDateCol(c)
    ).open();
  }

  // ── Select field ───────────────────────────────────────────────────────────

  renderSelectField(container: HTMLElement, row: CSVRow, h: string): HTMLElement {
    const val = row[h] ?? "";
    const chip = container.createDiv({ cls: `csv-select-chip ${val ? "" : "empty"}` });
    chip.setText(val || "—");
    if (h.toLowerCase() === "status" && val) chip.addClass(`status-chip-${val.toLowerCase().replace(/\s+/g,"-")}`);
    chip.addEventListener("click", e => {
      e.stopPropagation();
      showSelectPicker(chip, row[h] ?? "", this.getColumnValues(h), (newVal) => {
        row[h] = newVal;
        chip.setText(newVal || "—");
        chip.className = `csv-select-chip ${newVal ? "" : "empty"}`;
        if (h.toLowerCase() === "status" && newVal) chip.addClass(`status-chip-${newVal.toLowerCase().replace(/\s+/g,"-")}`);
        this.scheduleSave();
      }, this.contentEl, { multi: isMultiValueColName(h) });
    });
    return chip;
  }

  // ── Render root ────────────────────────────────────────────────────────────

  private contentArea: HTMLElement | null = null;

  renderView(contentOnly = false): void {
    const root = this.contentEl;

    if (!contentOnly) {
      root.empty(); root.addClass("datadeck-root");
      this.renderComponent.unload();
      this.renderComponent = new Component(); this.renderComponent.load();
      renderToolbar(this, root);
      this.contentArea = root.createDiv({ cls: "csv-content-area" });
      this.installTouchScrollGuard(this.contentArea);
    } else if (this.contentArea) {
      this.contentArea.empty();
    }

    const content = this.contentArea;
    if (!content) return;
    // Kanban manages its own scroll: the board fills the viewport, each
    // column scrolls internally. Without this flag .csv-content-area also
    // y-scrolls and the user gets two stacked scrollbars for the same content.
    // Table mode also opts out: the table wrapper becomes the y-scroller so
    // the sticky header has a scrollport to stick to (sticky inside an
    // overflow-x:auto wrapper that never y-scrolls is a no-op).
    content.toggleClass("csv-content-area--no-yscroll", this.mode === "kanban-genre" || this.mode === "table");

    if (!this.headers.length) {
      // Distinguish "truly malformed" from "brand-new empty file": both end
      // up here, but most of the time it's the latter (user just created
      // a new xlsx in Numbers/Excel and there's nothing inside yet).
      const wrap = content.createDiv({ cls: "csv-empty-state csv-empty-state--big" });
      wrap.createEl("h3", { text: "This file is empty" });
      wrap.createEl("p", { text: "Add a header row in your spreadsheet app, then come back — or click + add in the toolbar to start fresh." });
      return;
    }
    if (this.rows.length === 0) {
      // Headers present but no data — invite the user to add the first row.
      // Skip all per-mode renders; they'd produce empty grids that read as
      // "is this broken?" rather than "I haven't added anything yet."
      const wrap = content.createDiv({ cls: "csv-empty-state csv-empty-state--big" });
      wrap.createEl("h3", { text: "No entries yet" });
      const addBtn = wrap.createEl("button", { cls: "csv-empty-state-action", text: "+ add the first entry" });
      addBtn.addEventListener("click", () => this.openAddModal());
      wrap.createEl("p", { cls: "csv-empty-state-hint", text: `${this.headers.length} column${this.headers.length === 1 ? "" : "s"} detected: ${this.headers.slice(0, 5).join(", ")}${this.headers.length > 5 ? "…" : ""}` });
      return;
    }
    // renderDashboard is async (lazy-loads Chart.js); no one awaits renderView,
    // so the fire-and-forget here is intentional — dashboard chrome paints
    // synchronously, the chart lands a tick later.
    if (this.mode === "travel") void renderTravel(content, this.rows, () => this.loadMapSvg(), () => this.scheduleSave(),
      this.settings.showResidency === false ? null : (this.settings.residencyRules ?? null),
      (teardown) => this.renderComponent.register(teardown));
    else if (this.mode === "dashboard") void renderDashboard(this, content);
    else if (this.mode === "library") renderLibrary(this, content);
    else if (this.mode === "kanban-genre") renderKanbanGenre(this, content);
    else if (this.mode === "stats") renderStats(this, content);
    else if (this.mode === "chart") void renderChart(this, content);
    else if (this.mode === "focus") renderFocus(this, content);
    else if (this.mode === "tasks") renderTasks(this, content);
    else if (this.mode === "budget") renderBudget(this, content);
    else renderTable(this, content);
  }

  /**
   * Stop a swipe from being read as a tap on touch devices.
   *
   * iOS Safari is mostly good at distinguishing the two natively, but with
   * CSS scroll-snap between kanban columns + momentum scrolling inside a
   * column, a touch that lands briefly on a card mid-scroll can still fire
   * `click` (which opens the inline note editor / the expander modal /
   * etc., and the user thinks "why did I just select that?").
   *
   * Strategy: track touchstart→touchmove distance. If the finger moved
   * more than 10 px (iOS's own tap threshold) before touchend, swallow
   * the subsequent click in capture phase before any descendant handler
   * sees it. Programmatic scrolls (the scroll-restore after closeInlineEditor)
   * don't fire touchmove, so they can't create false lockouts.
   *
   * Installed once per content-area creation; persists across mode changes
   * (renderView only recreates the content area when `contentOnly=false`).
   */
  private installTouchScrollGuard(el: HTMLElement): void {
    if (!matchMedia("(pointer: coarse)").matches) return;
    let startX = 0, startY = 0, moved = false;
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      moved = false;
    }, { capture: true, passive: true });
    el.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1 || moved) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 10 || dy > 10) moved = true;
    }, { capture: true, passive: true });
    el.addEventListener("click", (e) => {
      if (!moved) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }


  // ── Archive backup ──────────────────────────────────────────────────────────

  async backupToArchive(): Promise<void> {
    if (!this.file) return;
    const folder = this.file.parent?.path ?? "";
    const archiveFolder = folder ? `${folder}/Archive` : "Archive";
    if (!await this.app.vault.adapter.exists(archiveFolder)) {
      await this.app.vault.adapter.mkdir(archiveFolder);
    }
    const date = this.formatDate(new Date()); // local YYYY-MM-DD
    const dest = `${archiveFolder}/${this.file.basename}_${date}.${this.file.extension}`;
    if (await this.app.vault.adapter.exists(dest)) {
      new Notice(`Backup already exists for today: ${dest}`);
      return;
    }
    const buf = await this.app.vault.readBinary(this.file);
    await this.app.vault.adapter.writeBinary(dest, buf);
    new Notice(`Backed up to ${dest}`);
  }

  // ── Date detection ──────────────────────────────────────────────────────────

  hasDateColumn(): boolean {
    const dateCol = this.getDateCol();
    return dateCol !== null;
  }

  // ── Travel-log detection + map asset ──────────────────────────────────────────

  /**
   * A file is a travel log if it carries the flat-CSV columns emitted by the
   * travel-tracker's travel.py: country (ISO-2) + a date range + a `source`
   * discriminator. Specific enough not to fire on movies/books/habits.
   */
  isTravelFile(): boolean {
    const have = new Set(this.headers.map(h => h.toLowerCase()));
    return have.has("country") && have.has("date_entered")
        && have.has("date_left") && have.has("source");
  }

  /**
   * World-map SVG for the travel view. Inlined into the bundle at build
   * time (esbuild text loader) rather than read from a separate release
   * asset — Obsidian's plugin installer only ever downloads main.js,
   * styles.css, and manifest.json, so a standalone world-map.svg release
   * file would never reach community-store installs.
   */
  private async loadMapSvg(): Promise<string | null> {
    return worldMapSvg;
  }

  // ── Search filtering ─────────────────────────────────────────────────────────

  getFilteredRows(): CSVRow[] {
    let result = this.rows;

    // Filter by search query
    if (this.searchQuery.trim()) {
      const query = this.searchQuery.toLowerCase().trim();
      result = result.filter(row => {
        return this.headers.some(h => {
          const val = row[h] ?? "";
          return val.toLowerCase().includes(query);
        });
      });
    }

    // Manual header-click sort takes precedence over the date default.
    if (this.mode === "table" && this.tableSortCol && this.headers.includes(this.tableSortCol)) {
      return sortRowsByColumn(result, this.tableSortCol, this.tableSortDir);
    }

    // Sort by date if in table view and has date column
    const dateCol = this.getDateCol();
    if (this.mode === "table" && dateCol) {
      const sortNewest = this.fileCfg.sortNewestFirst ?? true;
      result = [...result].sort((a, b) => {
        const dateA = a[dateCol] ?? "";
        const dateB = b[dateCol] ?? "";
        const cmp = dateA.localeCompare(dateB);
        return sortNewest ? -cmp : cmp;
      });
    }

    return result;
  }

  getDateCol(): string | null {
    // An explicit per-file Date pick (⚙ Config, Type = Date) wins — the
    // inline csv-view host already honoured it; the full view ignored it,
    // so a configured date column off in position 2+ never drove the
    // dashboard/date sort here. Deliberately NOT falling back to name-based
    // isDateCol like the inline host does: "Due" is date-named, and that
    // fallback would auto-default every tasks file to Dashboard mode.
    if (this.fileCfg.dateColumns && this.fileCfg.dateColumns.length > 0) {
      const h = this.fileCfg.dateColumns[0];
      return this.headers.find(header => header === h) ?? null;
    }
    // Check first column - if it looks like dates, use it
    if (this.headers.length === 0) return null;
    const firstCol = this.headers[0];
    const firstColLower = firstCol.toLowerCase();

    // Check by column name
    if (["date", "day", "datum"].includes(firstColLower)) return firstCol;

    // Check if first few values look like dates (YYYY-MM-DD or similar)
    const sampleRows = this.rows.slice(0, 5);
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const looksLikeDates = sampleRows.length > 0 &&
      sampleRows.every(r => datePattern.test(r[firstCol] ?? ""));

    if (looksLikeDates) return firstCol;
    return null;
  }

  getBooleanColumns(): string[] {
    // Explicit list wins outright once set, even if empty — same semantics
    // as isCategoricalCol's categoricalColumns check. Previously this used
    // `.length > 0`, which meant explicitly unchecking every Checkbox column
    // in ⚙ Config (leaving the list empty) silently fell back to
    // auto-detection instead of actually turning the habit tracker off.
    if (this.fileCfg.habitColumns) {
      return this.fileCfg.habitColumns.filter(h => this.headers.includes(h));
    }
    return this.autoDetectBooleanColumns();
  }

  /**
   * ⚙ Config's "Clean up" action for a Checkbox-typed column: rewrites every
   * row's raw value in `header` to exactly "1" (isTruthy match) or "0"
   * (everything else) — the same rule the toggle itself already uses to
   * decide checked/unchecked, applied to the whole column at once instead of
   * one row at a time as each happens to get touched. Acts on the real CSV
   * data immediately (like addColumn/removeColumn), not deferred to Save.
   * Returns how many cells actually changed, for the confirmation Notice.
   */
  cleanupBooleanColumn(header: string): number {
    let changed = 0;
    this.rows.forEach(row => {
      const normalized = this.isTruthy(row[header] ?? "") ? "1" : "0";
      if (row[header] !== normalized) changed++;
      row[header] = normalized;
    });
    if (changed > 0) {
      this.scheduleSave();
      this.renderViewPreservingScroll();
    }
    return changed;
  }

  autoDetectBooleanColumns(): string[] {
    // Detect columns that look like boolean/habit columns (values are 0/1, true/false, yes/no, or empty).
    return this.headers.filter(h => {
      if (h === this.getDateCol() || this.isNotesCol(h)) return false;
      const values = this.rows.map(r => (r[h] ?? "").toLowerCase().trim());
      return looksBoolean(values);
    });
  }

  parseDate(dateStr: string): Date | null {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }

  formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  isTruthy(val: string): boolean {
    return isTruthyVal(val);
  }

  // ── Dashboard view ──────────────────────────────────────────────────────────

  selectedDate: string | null = null;
  selectedHabit: string | null = null;
  chartInstance: ChartType | null = null;


  timelineYear: number = new Date().getFullYear();




  // ── Library View ────────────────────────────────────────────────────────────

  libraryStatusFilter: string = "all";
  libraryGenreFilter: string = "all";
  // Group values (lowercased) collapsed by default in Cards view. Only the
  // inline csv-view block populates this (via its `collapse:` directive); the
  // full-page view leaves it empty, so every section opens as before.
  collapsedGroups: Set<string> = new Set();

  // ── Tasks view ────────────────────────────────────────────────────────────────

  taskProjectFilter: string = "all";
  taskTypeFilter: string = "all";

  // ── Focus view ───────────────────────────────────────────────────────────────

  focusIndex: number = 0;
  // Set by the focus renderer before a nav-triggered re-render so the rebuilt
  // card can reclaim keyboard focus — but only then, so a search-driven
  // re-render never steals focus from the toolbar input.
  focusNavPending: boolean = false;

  /** Render markdown text into an element, tied to this view's lifecycle. */
  renderMarkdownInto(el: HTMLElement, text: string): void {
    void MarkdownRenderer.render(this.app, text, el, this.file?.path ?? "", this.renderComponent);
  }

  // ── Table view ───────────────────────────────────────────────────────────────

  // Click-to-sort state (session-only; the persisted per-file default stays
  // the date-column newest/oldest toggle in fileCfg.sortNewestFirst).
  tableSortCol: string | null = null;
  tableSortDir: "asc" | "desc" = "asc";


  /** Switch to the next valid view mode for this file (palette command). */
  cycleMode(): void {
    const modes = availableModes(this);
    if (modes.length < 2) return;
    const idx = modes.findIndex(m => m.id === this.mode);
    this.mode = modes[(idx + 1) % modes.length].id;
    this.renderView();
  }

  onunload(): void { this.renderComponent.unload(); if(this.saveTimer) window.clearTimeout(this.saveTimer); }
}

// ─── File templates ─────────────────────────────────────────────────────────
//
// Canonical column sets for the "create … file" palette commands. `headers`
// must satisfy the target view's detector (see the command registration in
// onload). `defaultName` seeds the name prompt; `mode` is pinned in
// fileConfigs so the new file opens straight into the right renderer.
interface FileTemplate {
  id: string;
  command: string;
  defaultName: string;
  headers: string[];
  mode: ViewMode;
  configOverrides?: Partial<FileConfig>;
}

const FILE_TEMPLATES: FileTemplate[] = [
  {
    id: "tasks",
    command: "Create tasks file",
    defaultName: "Tasks",
    // Type + Project are the two columns the tasks view is actually designed
    // around (per-type sections, grouped by project) — without Project the
    // group falls back to whatever pickFallbackGroupCol guesses (Priority),
    // which read as nonsense headings. Status stays a *word* column
    // (done/…), NOT a Checkbox: the view's done-toggle writes DONE_WORDS
    // vocabulary, and typing it Checkbox made the Add-form toggle write
    // "1"/"0" that the view then couldn't agree with.
    headers: ["Title", "Type", "Project", "Priority", "Due", "Status", "Notes"],
    mode: "tasks",
    configOverrides: {
      categoricalColumns: ["Type", "Priority"],
      dateColumns: ["Due"],
      statusColumn: "Status",
      notesColumn: "Notes"
    }
  },
  {
    id: "travel",
    command: "Create travel file",
    defaultName: "Travel",
    // Exactly travel.py's flat-CSV columns, lowercase — analyzeTravel reads
    // literal keys (r.country, r.notes, …), so the old capitalized
    // Country/Notes headers passed detection (isTravelFile lowercases) but
    // produced a travel view where every row was silently dropped.
    headers: ["date_entered", "date_left", "country", "city", "visa_status", "notes", "source", "resolved"],
    mode: "travel",
  },
  {
    id: "habits",
    command: "Create habit tracker file",
    defaultName: "Habits",
    headers: ["Date", "Exercise", "Meditate", "Read", "Notes"],
    mode: "dashboard",
    configOverrides: {
      // Pinned — auto-detection needs at least one row of values, so a fresh
      // file otherwise renders a dashboard with zero habit toggles.
      habitColumns: ["Exercise", "Meditate", "Read"],
      notesColumn: "Notes",
      // "Read" is a status-column alias; explicitly no status column here so
      // Stats/Library don't misread a habit as the file's status.
      statusColumn: "",
    }
  },
  {
    id: "chart",
    command: "Create chart file",
    defaultName: "Measurements",
    // A dated measurement log — the most common personal chart shape
    // (weight, km, hours…). Opens as a table until two rows exist
    // (hasChartColumns needs data to plot), then lands in Chart with a
    // date X-axis, Value on Y, and the fit line on.
    headers: ["Date", "Value", "Notes"],
    mode: "chart",
    configOverrides: {
      chartYCol: "Value",
      chartFit: "linear",
      notesColumn: "Notes",
    }
  },
  {
    id: "budget",
    command: "Create budget file",
    defaultName: "Budget",
    // Category and Price match CATEGORY_COL_ALIASES/PRICE_COL_ALIASES by
    // name already (see effectiveGroupCol / hasBudgetColumns) — only Item
    // needs an explicit titleColumn override, since "Item" isn't one of
    // TITLE_COL_ALIASES (Title/Name).
    headers: ["Date", "Item", "Category", "Price", "Notes"],
    mode: "budget",
    configOverrides: {
      titleColumn: "Item",
      categoricalColumns: ["Category"],
      notesColumn: "Notes",
      // "" is in BOOLEAN_PATTERNS (looksBoolean), so a fresh file with one
      // row and an empty Category value vacuously auto-detects Category as
      // a habit/checkbox column — and the Add-entry modal checks isBooleanCol
      // before the categorical branch, so it'd render a toggle instead of
      // the dropdown categoricalColumns configures. Pin no habit columns,
      // same fix the "habits" template uses for its own collision.
      habitColumns: [],
    }
  },
];

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class CardViewPlugin extends Plugin {
  settings: CardViewSettings = DEFAULT_SETTINGS;
  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(CARD_VIEW_TYPE, leaf=>new CardView(leaf, this.settings, () => this.saveSettings()));
    this.registerExtensions(["csv"], CARD_VIEW_TYPE);
    this.addSettingTab(new CardViewSettingTab(this.app, this));

    // Register csv-add code block for mobile entry
    this.registerMarkdownCodeBlockProcessor("csv-add", async (source, el, ctx) => {
      await renderAddEntryForm(this.app, source.trim(), el, ctx, this.settings.fileConfigs);
    });

    // csv-random: a random entry from a CSV — quote/word of the day for
    // daily-note templates. Re-rolls per render + via its ↻ button.
    this.registerMarkdownCodeBlockProcessor("csv-random", async (source, el, ctx) => {
      await renderRandomCard(this.app, source.trim(), el, ctx);
    });

    // csv-view: an inline, editable table/cards/kanban view of a CSV file —
    // a .base / Notion-DB-style embed. Reuses the full-view renderers via a
    // lightweight host tied to the block's lifecycle. See src/inline-view.ts.
    registerCsvViewBlock(
      this.app,
      this.settings,
      () => this.saveSettings(),
      (lang, handler) => this.registerMarkdownCodeBlockProcessor(lang, handler),
    );

    // csv-chart: an inline read-only chart of a CSV (or a pure y = f(x)
    // formula plot) — scatter/line, best-fit, formula overlay. See
    // src/chart-block.ts.
    registerCsvChartBlock(
      this.app,
      (lang, handler) => this.registerMarkdownCodeBlockProcessor(lang, handler),
    );

    // csv-tasks: a cross-file tasks board — merge task rows from a folder
    // and/or file list into one editable board. The phase-2 replacement for
    // the old vault-wide DataviewJS dashboard. See src/tasks-block.ts.
    registerCsvTasksBlock(
      this.app,
      this.settings,
      (lang, handler) => this.registerMarkdownCodeBlockProcessor(lang, handler),
    );

    // Palette commands — operate on the active CSV view, so they're
    // hotkey-able (Settings → Hotkeys → filter "CSV Card View").
    this.addCommand({
      id: "add-entry",
      name: "Add entry to current CSV",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(CardView);
        if (!view) return false;
        if (!checking) view.openAddModal();
        return true;
      },
    });
    this.addCommand({
      id: "cycle-view-mode",
      name: "Cycle view mode",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(CardView);
        if (!view) return false;
        if (!checking) view.cycleMode();
        return true;
      },
    });

    // "Create … file" palette commands — one per view template. Each scaffolds
    // a fresh CSV with the canonical columns for that view, pins its
    // defaultMode so it opens straight into the right renderer, and opens it.
    // Always available (no active-view gate), so they're the entry point to a
    // new tracker from anywhere. Headers must satisfy each view's detector:
    //  - tasks: hasTaskColumns() (Priority/Due present)
    //  - travel: isTravelFile() (country + date_entered + date_left + source)
    //  - dashboard: a date column + boolean habit columns.
    //  - budget: hasBudgetColumns() (a Price/Cost/Amount/Total/Spend/Value column)
    for (const tpl of FILE_TEMPLATES) {
      this.addCommand({
        id: `create-${tpl.id}`,
        name: tpl.command,
        callback: () => this.createTemplateFile(tpl),
      });
    }

    // Migrate per-file config keys when the user renames or moves a
    // tracked csv inside Obsidian. Without this, `fileConfigs[oldPath]`
    // (cardFields, categoryColumn, defaultMode, etc.) is orphaned and the
    // file silently reverts to auto-detected defaults.
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      if (file.extension !== "csv") return;
      if (!this.settings.fileConfigs[oldPath]) return;
      migrateFileConfigKey(this.settings.fileConfigs, oldPath, file.path);
      await this.saveSettings();
    }));

    // Same for delete — drop the orphaned entry so data.json doesn't grow forever.
    this.registerEvent(this.app.vault.on("delete", async (file) => {
      if (!(file instanceof TFile)) return;
      if (!this.settings.fileConfigs[file.path]) return;
      delete this.settings.fileConfigs[file.path];
      await this.saveSettings();
    }));

    // Register csv-refresh code block for manual refresh button
    this.registerMarkdownCodeBlockProcessor("csv-refresh", (source, el, ctx) => {
      const btn = el.createEl("button", {
        cls: "csv-refresh-btn",
        text: "↻ refresh"
      });
      btn.addEventListener("click", () => {
        void (async () => {
          // Close and reopen the note to force Dataview to re-read CSV
          const currentPath = ctx.sourcePath;
          const file = this.app.vault.getAbstractFileByPath(currentPath);
          if (file instanceof TFile) {
            await this.app.workspace.getLeaf(false).openFile(file, { state: { mode: "preview" } });
          }
        })();
      });
    });
  }


  /**
   * Scaffold a new CSV from a view template: prompt for a name, create it
   * (header row only) next to the active file or at the vault root, pin its
   * defaultMode so it opens in the right renderer, and open it. Resolves name
   * collisions by appending " 2", " 3", … rather than overwriting.
   */
  async createTemplateFile(tpl: FileTemplate): Promise<void> {
    new PromptModal(
      this.app,
      tpl.command,
      tpl.defaultName,
      "File name (without .csv)",
      (name) => {
        void (async () => {
          // Drop into the active file's folder so a tracker lands beside related
          // notes; fall back to the vault root.
          const active = this.app.workspace.getActiveFile();
          const folder = active?.parent && active.parent.path !== "/" ? `${active.parent.path}/` : "";
          const base = sanitizeFilename(name);
          let path = normalizePath(`${folder}${base}.csv`);
          for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) {
            path = normalizePath(`${folder}${base} ${n}.csv`);
          }
          const file = await this.app.vault.create(path, tpl.headers.join(",") + "\n");
          // Pin the renderer up front so the file opens in its template's view
          // even before the user adds a row that would trigger auto-detection.
          const baseConfig = this.settings.fileConfigs[file.path] || {};
          this.settings.fileConfigs[file.path] = { ...baseConfig, defaultMode: tpl.mode, ...(tpl.configOverrides || {}) };
          await this.saveSettings();
          await this.app.workspace.getLeaf("tab").openFile(file);
          new Notice(`Created: ${file.name}`);
        })();
      }
    ).open();
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData() as Partial<CardViewSettings> | null;
    this.settings=Object.assign({},DEFAULT_SETTINGS,saved);
    // Deep-clone so the in-app editor mutates this file's settings, not the
    // shared DEFAULT_RESIDENCY_RULES constant (a reference when data.json has none).
    this.settings.residencyRules = JSON.parse(JSON.stringify(this.settings.residencyRules ?? [])) as CardViewSettings["residencyRules"];
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}
