import {
  App,
  Plugin,
  FileView,
  WorkspaceLeaf,
  Component,
  MarkdownRenderer,
  Menu,
  Notice,
  TFile,
  normalizePath,
} from "obsidian";
import Papa from "papaparse";
// Type-only import — erased at compile time, no runtime cost. Used for the
// chartInstance field type; the actual module is lazy-loaded inside
// src/view/dashboard.ts, so non-dashboard sessions never load Chart.js.
import type { Chart as ChartType } from "chart.js";

// Import from src modules
import { CSVRow, ViewMode, FileConfig, CardViewSettings, DEFAULT_SETTINGS, CARD_VIEW_TYPE } from "./src/types";
import { sanitizeFilename, titleCase, formatRatingForDisplay, showSelectPicker, parseCSV, migrateFileConfigKey, sortRowsByColumn, isMultiValueColName } from "./src/utils";
import { AddEntryModal, NoteExpanderModal, FileConfigModal, SearchModal } from "./src/modals";
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
import { renderFocus } from "./src/view/focus";
import { renderTasks, hasTaskColumns } from "./src/view/tasks";

// World-map SVG asset, loaded lazily from the plugin dir and cached for the
// session (undefined = not yet read, null = read failed/missing).
let worldMapSvgCache: string | null | undefined = undefined;

// Injected by esbuild at build time (see esbuild.config.mjs). Surfaced via
// the ⋯ menu so the user can confirm which build is actually loaded —
// handy on iPhone where iCloud sync of the deployed bundle can lag.
declare const __BUILD_TIME__: string;


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

  async onLoadFile(file: TFile): Promise<void> {
    try {
      const text = await this.app.vault.read(file);
      const parsed = parseCSV(text);
      this.headers = parsed.headers;
      this.rows = parsed.rows;
    } catch (e) {
      console.error("CardView load error", e);
      this.headers = []; this.rows = [];
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
        || (this.mode === "tasks" && !hasTaskColumns(this))) {
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
    this.saveTimer = window.setTimeout(() => this.doSave(), 600);
  }

  private async doSave(): Promise<void> {
    if (!this.file) return;
    try {
      const csv = Papa.unparse(this.rows, { columns: this.headers });
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

  getNotesCol(): string | null {
    // 1. Per-file override
    if (this.fileCfg.notesColumn) return this.fileCfg.notesColumn;
    // 2. Fallback chain
    return this.resolveCol([
      "Notes","notes","Note","note",
      "Summary","summary",
      "Review","review",
      "Quote","quote","Quotes","quotes",
      "Comment","comment","Comments","comments",
      "Description","description",
      "Annotation","annotation",
    ]);
  }

  isNotesCol(h: string): boolean {
    const notesCol = this.getNotesCol();
    // If we resolved a specific column, only that one qualifies
    if (notesCol) return h === notesCol;
    // Otherwise fall back to global list (shouldn't normally reach here)
    return this.settings.notesColumns.some(n => n.toLowerCase() === h.toLowerCase());
  }

  isSelectCol(h: string) { return this.settings.selectColumns.some(s => s.toLowerCase()===h.toLowerCase()); }

  getStatusCol(): string | null {
    if (this.fileCfg.statusColumn) {
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.statusColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol([
      "Status","status",
      "State","state",
      "Progress","progress",
      "Stage","stage",
      "Read","read",
      "Watched","watched","Seen","seen",
      "Done","done","Completed","completed",
    ]);
  }

  getCategoryCol(): string | null {
    if (this.fileCfg.categoryColumn) {
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.categoryColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol([
      "Category","category",
      "Categories","categories",
      "Genre","genre","Genres","genres",
      "Type","type","Types","types",
      "Tag","tag","Tags","tags",
      "Topic","topic","Topics","topics",
      "Subject","subject",
      "Section","section",
    ]);
  }

  titleKey(): string | undefined {
    return this.resolveCol(["Title","title","Name","name"]) ?? undefined;
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
    const frag = document.createDocumentFragment();
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
    menu.addItem(i => i.setTitle("Open / Create Notes file").setIcon("file-text").onClick(() => this.openOrCreateNotes(row)));
    const notesCol = this.getNotesCol();
    if (notesCol) {
      menu.addItem(i => i.setTitle("Open entry").setIcon("maximize").onClick(() => this.openNoteExpander(row, notesCol)));
    }
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
    menu.addItem(i => i.setTitle("Delete").setIcon("trash").onClick(() => this.deleteWithUndo(row)));
    menu.showAtMouseEvent(e);
  }

  async openOrCreateNotes(row: CSVRow): Promise<void> {
    const path = this.notesFilePath(row);
    let file = this.app.vault.getAbstractFileByPath(path) as TFile|null;
    if (!file) {
      const fm = ["---",...this.headers.filter(h=>!this.isNotesCol(h)&&row[h]).map(h=>`${h}: "${row[h].replace(/"/g,'\\"')}"`),"---","",`# ${this.getTitle(row)}`,"",""].join("\n");
      const notesCol = this.headers.find(h=>this.isNotesCol(h));
      const content = fm+(notesCol&&row[notesCol]?.trim()?row[notesCol]:"");
      const folderPath = path.substring(0,path.lastIndexOf("/"));
      if (folderPath&&!this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath);
      file = await this.app.vault.create(path,content);
      new Notice(`Created: ${file.name}`);
    }
    await this.app.workspace.getLeaf("tab").openFile(file as TFile);
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
      () => this.deleteWithUndo(row)
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
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
    setTimeout(restore, 50);
  }

  openAddModal(): void {
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
      }
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
      root.empty(); root.addClass("csv-card-view-root");
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
      wrap.createEl("p", { text: "Add a header row in your spreadsheet app, then come back — or click + Add in the toolbar to start fresh." });
      return;
    }
    if (this.rows.length === 0) {
      // Headers present but no data — invite the user to add the first row.
      // Skip all per-mode renders; they'd produce empty grids that read as
      // "is this broken?" rather than "I haven't added anything yet."
      const wrap = content.createDiv({ cls: "csv-empty-state csv-empty-state--big" });
      wrap.createEl("h3", { text: "No entries yet" });
      const addBtn = wrap.createEl("button", { cls: "csv-empty-state-action", text: "+ Add the first entry" });
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
    else if (this.mode === "focus") renderFocus(this, content);
    else if (this.mode === "tasks") renderTasks(this, content);
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
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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
   * Load the world-map SVG shipped alongside the plugin. Cached at module
   * level so it's read once per session (it's ~110 KB). Kept out of the JS
   * bundle deliberately — see handoff. Returns null if the asset is missing.
   */
  private async loadMapSvg(): Promise<string | null> {
    if (worldMapSvgCache !== undefined) return worldMapSvgCache;
    const path = normalizePath(`${this.app.vault.configDir}/plugins/csv-card-view/world-map.svg`);
    try {
      worldMapSvgCache = await this.app.vault.adapter.read(path);
    } catch (_e) {
      worldMapSvgCache = null;
    }
    return worldMapSvgCache;
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
    // Use configured habit columns if set, otherwise auto-detect
    if (this.fileCfg.habitColumns && this.fileCfg.habitColumns.length > 0) {
      return this.fileCfg.habitColumns.filter(h => this.headers.includes(h));
    }
    return this.autoDetectBooleanColumns();
  }

  autoDetectBooleanColumns(): string[] {
    // Detect columns that look like boolean/habit columns (values are 0/1, true/false, yes/no, or empty)
    const boolPatterns = ["0", "1", "true", "false", "yes", "no", ""];
    return this.headers.filter(h => {
      if (h === this.getDateCol() || this.isNotesCol(h)) return false;
      const values = this.rows.map(r => (r[h] ?? "").toLowerCase().trim());
      return values.every(v => boolPatterns.includes(v));
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
    const v = (val ?? "").toLowerCase().trim();
    return v === "1" || v === "true" || v === "yes";
  }

  // ── Dashboard view ──────────────────────────────────────────────────────────

  selectedDate: string | null = null;
  selectedHabit: string | null = null;
  chartInstance: ChartType | null = null;


  timelineYear: number = new Date().getFullYear();




  // ── Library View ────────────────────────────────────────────────────────────

  libraryStatusFilter: string = "all";
  libraryGenreFilter: string = "all";

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
      await renderAddEntryForm(this.app, source.trim(), el, ctx);
    });

    // csv-random: a random entry from a CSV — quote/word of the day for
    // daily-note templates. Re-rolls per render + via its ↻ button.
    this.registerMarkdownCodeBlockProcessor("csv-random", async (source, el, ctx) => {
      await renderRandomCard(this.app, source.trim(), el, ctx);
    });

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
        cls: "csv-refresh-btn"
      });
      btn.innerHTML = "↻ refresh";
      btn.addEventListener("click", async () => {
        // Close and reopen the note to force Dataview to re-read CSV
        const currentPath = ctx.sourcePath;
        const file = this.app.vault.getAbstractFileByPath(currentPath);
        if (file instanceof TFile) {
          const leaf = this.app.workspace.activeLeaf;
          if (leaf) {
            await leaf.openFile(file, { state: { mode: "preview" } });
          }
        }
      });
    });
  }


  async loadSettings(): Promise<void> {
    this.settings=Object.assign({},DEFAULT_SETTINGS,await this.loadData());
    // Deep-clone so the in-app editor mutates this file's settings, not the
    // shared DEFAULT_RESIDENCY_RULES constant (a reference when data.json has none).
    this.settings.residencyRules = JSON.parse(JSON.stringify(this.settings.residencyRules ?? []));
  }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}
