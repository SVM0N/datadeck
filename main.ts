import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  FileView,
  WorkspaceLeaf,
  MarkdownRenderer,
  MarkdownPostProcessorContext,
  Component,
  Menu,
  Notice,
  TFile,
  normalizePath,
} from "obsidian";
import Papa from "papaparse";
// Type-only import — erased at compile time, no runtime cost. The actual
// module is loaded on demand via `loadChart` below so the plugin enables
// without paying Chart.js's component registration up front.
import type { Chart as ChartType } from "chart.js";

// Import from src modules
import { CSVRow, ViewMode, FileConfig, CardViewSettings, DEFAULT_SETTINGS, CARD_VIEW_TYPE } from "./src/types";
import { sanitizeFilename, titleCase, formatRatingForDisplay, showSelectPicker, resolvePath, parseCSV, migrateFileConfigKey } from "./src/utils";
import { AddEntryModal, NoteExpanderModal, FileConfigModal, SearchModal } from "./src/modals";
import {
  generateHabitMobileDashboard as habitMobileTemplate,
  generateLibraryMobileDashboard as libraryMobileTemplate,
  generateGenericMobileDashboard as genericMobileTemplate,
} from "./src/mobile-templates";

// Injected by esbuild at build time (see esbuild.config.mjs). Surfaced via
// the ⋯ menu so the user can confirm which build is actually loaded —
// handy on iPhone where iCloud sync of the deployed bundle can lag.
declare const __BUILD_TIME__: string;

// Lazy-load Chart.js + register the bits we use. Only paid when the dashboard
// view first renders. Sessions that only touch books/movies/quotes/dictionary
// never load Chart.js at all.
type ChartModule = typeof import("chart.js");
let chartModule: ChartModule | null = null;
async function loadChart(): Promise<ChartModule> {
  if (chartModule) return chartModule;
  const mod = await import("chart.js");
  mod.Chart.register(mod.LineController, mod.LineElement, mod.PointElement, mod.LinearScale, mod.CategoryScale, mod.Filler, mod.Tooltip);
  chartModule = mod;
  return mod;
}

// ─── View ────────────────────────────────────────────────────────────────────

export class CardView extends FileView {
  settings: CardViewSettings;
  headers: string[] = [];
  rows: CSVRow[] = [];
  mode: ViewMode;
  private renderComponent: Component;
  private saveTimer: number | null = null;
  private searchQuery: string = "";
  // Callback into the plugin to persist `settings` to data.json.
  // Passed at construction time (see CardViewPlugin.onload) so the view
  // doesn't have to reach back through `(app as any).plugins.plugins[...]`
  // to find its own plugin instance.
  private persistSettings: () => Promise<void>;

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
    } else if (this.hasDateColumn()) {
      // Auto-default to dashboard if date column detected
      this.mode = "dashboard";
    } else {
      this.mode = this.settings.defaultMode;
    }
    // Guard: if the resolved mode requires a column this file doesn't have,
    // fall back to "table" so we never land on a broken empty-state screen.
    // (e.g. data.xlsx has no Category col but the global default is
    // kanban-genre — without this it would render "No category column found".)
    const needsCategory = this.mode === "kanban-genre" || this.mode === "library";
    const needsDate = this.mode === "dashboard";
    if ((needsCategory && !this.getCategoryCol()) || (needsDate && !this.hasDateColumn())) {
      this.mode = "table";
    }
    this.selectedDate = null; // Reset selected date when loading new file
    this.renderView();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    if (this.chartInstance) { this.chartInstance.destroy(); this.chartInstance = null; }
    this.headers = []; this.rows = []; this.contentEl.empty();
  }

  private scheduleSave(): void {
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

  private get fileCfg(): FileConfig {
    return this.file ? (this.settings.fileConfigs[this.file.path] ?? {}) : {};
  }

  private saveFileCfg(cfg: FileConfig): void {
    if (!this.file) return;
    this.settings.fileConfigs[this.file.path] = cfg;
    // Fire-and-forget — saveSettings is debounce-safe inside Obsidian.
    void this.persistSettings();
  }

  // ── Field helpers ──────────────────────────────────────────────────────────

  // ── Field helpers with fallback chains ────────────────────────────────────

  // Tries each candidate in order, returns first match found in headers
  private resolveCol(candidates: string[]): string | null {
    for (const c of candidates) {
      const found = this.headers.find(h => h.toLowerCase() === c.toLowerCase());
      if (found) return found;
    }
    return null;
  }

  private getNotesCol(): string | null {
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

  private isNotesCol(h: string): boolean {
    const notesCol = this.getNotesCol();
    // If we resolved a specific column, only that one qualifies
    if (notesCol) return h === notesCol;
    // Otherwise fall back to global list (shouldn't normally reach here)
    return this.settings.notesColumns.some(n => n.toLowerCase() === h.toLowerCase());
  }

  private isSelectCol(h: string) { return this.settings.selectColumns.some(s => s.toLowerCase()===h.toLowerCase()); }

  private getStatusCol(): string | null {
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

  private getCategoryCol(): string | null {
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

  private titleKey(): string | undefined {
    return this.resolveCol(["Title","title","Name","name"]) ?? undefined;
  }

  private authorKey(): string | undefined {
    return this.resolveCol([
      "Author","author","Authors","authors",
      "Director","director",
      "Artist","artist",
      "Creator","creator",
      "By","by",
    ]) ?? undefined;
  }
  private getTitle(row: CSVRow) { const k=this.titleKey(); return (k?row[k]:row[this.headers[0]])??"—"; }
  private getSubtitle(row: CSVRow) { const k=this.authorKey(); return k?row[k]??"":""; }
  private getColumnValues(h: string) { return Array.from(new Set(this.rows.map(r=>r[h]??"").filter(Boolean))).sort(); }

  // ── Notes file ─────────────────────────────────────────────────────────────

  private notesFilePath(row: CSVRow): string {
    const title = sanitizeFilename(this.getTitle(row));
    const csvFolder = this.file?.parent?.path??"";
    const sub = this.settings.notesSubfolder.trim();
    const folder = sub?(csvFolder?`${csvFolder}/${sub}`:sub):csvFolder;
    return normalizePath(`${folder}/${title}.md`);
  }

  private notesFileExists(row: CSVRow) { return !!this.app.vault.getAbstractFileByPath(this.notesFilePath(row)); }

  /**
   * Remove a row, save, re-render — and offer Undo via a Notice. Restoring
   * preserves the original index, so kanban / table positions don't visually
   * jump on undo. Idempotent: clicking Undo twice is a no-op (the button
   * disables itself after the first click).
   *
   * Used by every delete path (expander modal, kanban right-click, table
   * row button) so deletes have one consistent escape hatch.
   */
  private deleteWithUndo(row: CSVRow): void {
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
  private openRowContextMenu(row: CSVRow, e: MouseEvent): void {
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

  private async openOrCreateNotes(row: CSVRow): Promise<void> {
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

  private openNoteExpander(row: CSVRow, notesCol: string): void {
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
  private renderViewPreservingScroll(): void {
    const root = this.contentEl;
    const contentArea = root.querySelector<HTMLElement>(".csv-content-area");
    const tableWrap = root.querySelector<HTMLElement>(".csv-table-wrapper");
    const kanbanBoard = root.querySelector<HTMLElement>(".csv-kanban-board");
    const snapshot = {
      contentTop: contentArea?.scrollTop ?? 0,
      contentLeft: contentArea?.scrollLeft ?? 0,
      tableLeft: tableWrap?.scrollLeft ?? 0,
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
      if (tw) tw.scrollLeft = snapshot.tableLeft;
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

  private openAddModal(): void {
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

  private renderSelectField(container: HTMLElement, row: CSVRow, h: string): HTMLElement {
    const val = row[h] ?? "";
    const chip = container.createDiv({ cls: `csv-select-chip ${val ? "" : "empty"}` });
    chip.setText(val || "—");
    if (h.toLowerCase() === "status" && val) chip.addClass(`status-chip-${val.toLowerCase().replace(/\s+/g,"-")}`);
    chip.addEventListener("click", e => {
      e.stopPropagation();
      showSelectPicker(chip, val, this.getColumnValues(h), (newVal) => {
        row[h] = newVal;
        chip.setText(newVal || "—");
        chip.className = `csv-select-chip ${newVal ? "" : "empty"}`;
        if (h.toLowerCase() === "status" && newVal) chip.addClass(`status-chip-${newVal.toLowerCase().replace(/\s+/g,"-")}`);
        this.scheduleSave();
      }, this.contentEl);
    });
    return chip;
  }

  // ── Render root ────────────────────────────────────────────────────────────

  private contentArea: HTMLElement | null = null;

  private renderView(contentOnly = false): void {
    const root = this.contentEl;

    if (!contentOnly) {
      root.empty(); root.addClass("csv-card-view-root");
      this.renderComponent.unload();
      this.renderComponent = new Component(); this.renderComponent.load();
      this.renderToolbar(root);
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
    content.toggleClass("csv-content-area--no-yscroll", this.mode === "kanban-genre");

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
    if (this.mode === "dashboard") void this.renderDashboard(content);
    else if (this.mode === "library") this.renderLibrary(content);
    else if (this.mode === "kanban-genre") this.renderKanbanGenre(content);
    else this.renderTable(content);
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

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({cls:"csv-toolbar"});
    bar.createDiv({cls:"csv-toolbar-title", text: this.file?.basename??""});
    const ctrl = bar.createDiv({cls:"csv-toolbar-controls"});
    ctrl.createDiv({cls:"csv-row-count", text:`${this.rows.length} entries`});
    const mg = ctrl.createDiv({cls:"csv-mode-group"});

    // Build view mode buttons based on detected columns
    const modes: {id: ViewMode, label: string}[] = [];
    if (this.hasDateColumn()) modes.push({id: "dashboard", label: "Dashboard"});
    if (this.getCategoryCol()) {
      modes.push({id: "library", label: "Cards"});
      modes.push({id: "kanban-genre", label: "Kanban"});
    }
    modes.push({id: "table", label: "Table"});

    modes.forEach(({id, label}) => {
      const btn = mg.createEl("button",{cls:`csv-mode-btn ${this.mode===id?"active":""}`, text:label});
      btn.addEventListener("click",()=>{ this.mode=id; this.renderView(); });
    });

    // Search bar (only for kanban/table views, not dashboard).
    // On mobile the input collapses to a 🔍 toggle so the toolbar fits on
    // one row; tapping the toggle expands the input *in place of* the mode
    // buttons (CSS hides the mode group + +Add + ⋯ while expanded so the
    // input has the whole toolbar row). Underlying view filters live below.
    // Closing returns the toolbar to its normal layout.
    if (this.mode !== "dashboard") {
      const searchToggle = ctrl.createEl("button", {
        cls: "csv-cfg-btn csv-search-toggle",
        text: "🔍",
        title: "Search",
      });
      const searchWrap = ctrl.createDiv({ cls: "csv-search-wrap" });
      // Input lives inside its own relative wrapper so the × clear button
      // can absolute-position over the right edge of the input without
      // moving any siblings (the Done button stays put even when × appears
      // mid-typing). The toggle of × visibility uses opacity+pointer-events
      // rather than display:none — same reason: no layout shift.
      const inputWrap = searchWrap.createDiv({ cls: "csv-search-input-wrap" });
      const searchInput = inputWrap.createEl("input", {
        cls: "csv-search-input",
        type: "text",
        placeholder: "Search...",
        value: this.searchQuery,
        // iOS keyboard hints: 'search' inputmode shows a search-style
        // keyboard; enterkeyhint relabels Return as "Search" so users
        // know pressing it dismisses the keyboard.
        attr: { inputmode: "search", enterkeyhint: "search", autocomplete: "off" },
      });
      const clearBtn = inputWrap.createEl("button", { cls: "csv-search-clear", text: "×", title: "Clear search" });
      clearBtn.toggleClass("is-hidden", !this.searchQuery);
      // Mobile-only "Done" button — dismisses the keyboard so the WebView
      // returns to full height and the user can see the filtered view.
      // The keyboard otherwise can't be dismissed once focus is locked.
      // Hidden on desktop via CSS.
      const doneBtn = searchWrap.createEl("button", {
        cls: "csv-search-done",
        text: "Done",
        title: "Dismiss keyboard",
      });
      // Done does double duty on mobile: if the input is empty (user
      // already cleared their query), collapse the search bar entirely
      // and restore the normal toolbar. Otherwise just dismiss the
      // keyboard so the user can see the filtered view. Lets Done be the
      // single exit affordance — no separate × needed on mobile.
      doneBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!searchInput.value) {
          bar.removeClass("csv-toolbar--search-expanded");
          searchToggle.removeClass("has-query");
          this.searchQuery = "";
          this.renderView(true);
          return;
        }
        searchInput.blur();
      });
      // Debounce filter re-renders so typing doesn't trigger a full content
      // rebuild on every keystroke — on large tables (300+ rows) the empty-
      // then-refill flash reads as "the table disappeared while I'm typing."
      // 120ms is below human reaction latency but lets bursts collapse into
      // a single render.
      let searchDebounce: number | null = null;
      searchInput.addEventListener("input", (e) => {
        this.searchQuery = (e.target as HTMLInputElement).value;
        clearBtn.toggleClass("is-hidden", !this.searchQuery);
        searchToggle.toggleClass("has-query", !!this.searchQuery);
        if (searchDebounce !== null) window.clearTimeout(searchDebounce);
        searchDebounce = window.setTimeout(() => {
          searchDebounce = null;
          this.renderView(true); // Only re-render content, not toolbar
        }, 120);
      });
      // Enter/Return commits the search by dismissing the keyboard so the
      // WebView returns to full height. Filter stays applied.
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          searchInput.blur();
        }
      });
      // × clears the query but keeps the search bar open so the user can
      // type something new without re-opening it. Done (mobile) collapses
      // the whole bar when input is already empty.
      clearBtn.addEventListener("click", () => {
        this.searchQuery = "";
        searchInput.value = "";
        clearBtn.addClass("is-hidden");
        searchToggle.removeClass("has-query");
        searchInput.focus({ preventScroll: true });
        this.renderView(true);
      });
      // Active-filter indicator on the toggle (mobile only).
      if (this.searchQuery) searchToggle.addClass("has-query");
      searchToggle.addEventListener("click", () => {
        // Expand inline. CSS hides the other toolbar items while expanded
        // so the input fills the row. The toolbar is in normal flow so
        // iOS keyboard handling is whatever the WebView does — content
        // area below shrinks to fit above the keyboard and filters live.
        bar.addClass("csv-toolbar--search-expanded");
        searchInput.focus({ preventScroll: true });
      });
    }

    // Sort order toggle (only for table view with date column)
    if (this.mode === "table" && this.hasDateColumn()) {
      const sortNewest = this.fileCfg.sortNewestFirst ?? true;
      const sortBtn = ctrl.createEl("button", {
        cls: `csv-cfg-btn ${sortNewest ? "active" : ""}`,
        text: sortNewest ? "↓ Newest" : "↑ Oldest",
        title: "Toggle sort order"
      });
      sortBtn.addEventListener("click", () => {
        const cfg = this.fileCfg;
        cfg.sortNewestFirst = !(cfg.sortNewestFirst ?? true);
        this.saveFileCfg(cfg);
        // Sort flips the row order but the user is still in roughly the
        // same area — preserving scroll is less disorienting than yanking
        // them back to the very newest / oldest entry.
        this.renderViewPreservingScroll();
      });
    }

    // Secondary actions — rendered as three explicit buttons on desktop,
    // collapsed into a single ⋯ overflow menu on phones (CSS toggles
    // visibility via .csv-cfg-btn-secondary / .csv-cfg-btn-overflow).
    // Handlers are defined once and reused by both surfaces so there's a
    // single place to maintain behaviour.
    const openColumns = () => {
      new FileConfigModal(this.app, this.headers, this.file?.path ?? "", this.fileCfg, this.autoDetectBooleanColumns(), (cfg) => {
        this.saveFileCfg(cfg);
        if (cfg.defaultMode) this.mode = cfg.defaultMode;
        this.renderView();
      }).open();
    };
    const openMobile = () => this.generateMobileFiles();
    const openBackup = () => this.backupToArchive();

    ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "⚙ Columns", title: "Configure columns for this file" })
      .addEventListener("click", openColumns);
    ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "📱 Mobile", title: "Generate mobile dashboard with add form" })
      .addEventListener("click", openMobile);
    ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "💾 Backup", title: "Copy this file to Archive/ with today's date" })
      .addEventListener("click", openBackup);

    ctrl.createEl("button",{cls:"csv-add-btn",text:"+ Add"}).addEventListener("click",()=>this.openAddModal());

    // ⋯ overflow lives after + Add so on mobile (where the secondary buttons
    // are hidden) the row reads `[modes] [search] [+ Add] [⋯]` — the primary
    // action stays adjacent to the input, with the menu as the rightmost
    // catch-all. On desktop this button is display:none, so + Add is last.
    const overflowBtn = ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-overflow", text: "⋯", title: "More actions" });
    overflowBtn.addEventListener("click", (e) => {
      const menu = new Menu();
      menu.addItem(i => i.setTitle("Columns").setIcon("settings").onClick(openColumns));
      menu.addItem(i => i.setTitle("Mobile dashboard").setIcon("smartphone").onClick(openMobile));
      menu.addItem(i => i.setTitle("Backup").setIcon("save").onClick(openBackup));
      menu.addSeparator();
      // Build timestamp baked in at compile time. Lets the user confirm on
      // iPhone that iCloud has actually synced the latest deploy.
      menu.addItem(i => i.setTitle(`Built ${__BUILD_TIME__}`).setIcon("info").setDisabled(true));
      menu.showAtMouseEvent(e);
    });

    // Desktop: a tiny ⓘ button next to ⋯ that toasts the build time on
    // click. On mobile it's hidden — the ⋯ menu already surfaces the same
    // info, and toolbar real estate is precious.
    const infoBtn = ctrl.createEl("button", {
      cls: "csv-cfg-btn csv-cfg-btn-secondary csv-info-btn",
      text: "ⓘ",
      title: `Built ${__BUILD_TIME__} — click to confirm`,
    });
    infoBtn.addEventListener("click", () => new Notice(`csv-card-view — built ${__BUILD_TIME__}`, 4000));
  }

  // ── Archive backup ──────────────────────────────────────────────────────────

  private async backupToArchive(): Promise<void> {
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

  private hasDateColumn(): boolean {
    const dateCol = this.getDateCol();
    return dateCol !== null;
  }

  // ── Search filtering ─────────────────────────────────────────────────────────

  private getFilteredRows(): CSVRow[] {
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

  private getDateCol(): string | null {
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

  private getBooleanColumns(): string[] {
    // Use configured habit columns if set, otherwise auto-detect
    if (this.fileCfg.habitColumns && this.fileCfg.habitColumns.length > 0) {
      return this.fileCfg.habitColumns.filter(h => this.headers.includes(h));
    }
    return this.autoDetectBooleanColumns();
  }

  private autoDetectBooleanColumns(): string[] {
    // Detect columns that look like boolean/habit columns (values are 0/1, true/false, yes/no, or empty)
    const boolPatterns = ["0", "1", "true", "false", "yes", "no", ""];
    return this.headers.filter(h => {
      if (h === this.getDateCol() || this.isNotesCol(h)) return false;
      const values = this.rows.map(r => (r[h] ?? "").toLowerCase().trim());
      return values.every(v => boolPatterns.includes(v));
    });
  }

  private parseDate(dateStr: string): Date | null {
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
  }

  private formatDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private isTruthy(val: string): boolean {
    const v = (val ?? "").toLowerCase().trim();
    return v === "1" || v === "true" || v === "yes";
  }

  // ── Dashboard view ──────────────────────────────────────────────────────────

  private selectedDate: string | null = null;
  private selectedHabit: string | null = null;
  private chartInstance: ChartType | null = null;

  private async renderDashboard(container: HTMLElement): Promise<void> {
    const dateCol = this.getDateCol();
    if (!dateCol) {
      container.createEl("p", { text: "No date column detected.", cls: "csv-empty-state" });
      return;
    }

    const habitCols = this.getBooleanColumns();
    const notesCol = this.getNotesCol();
    const today = this.formatDate(new Date());

    // Sort rows by date
    const sortedRows = [...this.rows].sort((a, b) => {
      return (a[dateCol] ?? "").localeCompare(b[dateCol] ?? "");
    });

    // Find or initialize selected date
    if (!this.selectedDate) this.selectedDate = today;
    let currentRow = sortedRows.find(r => r[dateCol] === this.selectedDate);
    const isToday = this.selectedDate === today;

    container.addClass("csv-dashboard");

    // ── Date Navigator ────────────────────────────────────────────────────────
    // Compute all dates first (includes today even if no entry exists)
    const allDates = [...new Set([...sortedRows.map(r => r[dateCol]), today])].filter(Boolean).sort();

    const nav = container.createDiv({ cls: "csv-dash-nav" });

    const prevBtn = nav.createEl("button", { cls: "csv-dash-nav-btn csv-dash-back-btn", text: "◀" });
    prevBtn.addEventListener("click", () => {
      const idx = allDates.indexOf(this.selectedDate!);
      if (idx > 0) {
        this.selectedDate = allDates[idx - 1];
        this.renderView();
      } else if (idx === -1 && allDates.length > 0) {
        // Selected date not in list, go to most recent existing
        const earlier = allDates.filter(d => d < this.selectedDate!);
        if (earlier.length > 0) {
          this.selectedDate = earlier[earlier.length - 1];
          this.renderView();
        }
      }
    });

    const dateDisplay = nav.createDiv({ cls: "csv-dash-date" });

    // Green dot indicator if it's today
    if (isToday) {
      dateDisplay.createSpan({ cls: "csv-dash-today-dot" });
    }

    const dateSelect = dateDisplay.createEl("select", { cls: "csv-dash-date-select" });

    allDates.forEach(d => {
      const opt = dateSelect.createEl("option", { text: d, value: d });
      if (d === this.selectedDate) opt.selected = true;
    });
    dateSelect.addEventListener("change", () => {
      this.selectedDate = dateSelect.value;
      this.renderView();
    });

    const nextBtn = nav.createEl("button", { cls: "csv-dash-nav-btn", text: "▶" });
    nextBtn.addEventListener("click", () => {
      const idx = allDates.indexOf(this.selectedDate!);
      if (idx >= 0 && idx < allDates.length - 1) {
        this.selectedDate = allDates[idx + 1];
        this.renderView();
      } else if (idx === -1) {
        // Selected date not in list, go to next available
        const later = allDates.filter(d => d > this.selectedDate!);
        if (later.length > 0) {
          this.selectedDate = later[0];
          this.renderView();
        }
      }
    });

    // Only show "Today" button if not already on today
    if (!isToday) {
      const todayBtn = nav.createEl("button", { cls: "csv-dash-today-btn", text: "Today" });
      todayBtn.addEventListener("click", () => {
        this.selectedDate = today;
        this.renderView();
      });
    }

    // ── Add new date if not exists ────────────────────────────────────────────
    if (!currentRow) {
      const addSection = container.createDiv({ cls: "csv-dash-add-section" });
      addSection.createEl("p", { text: `No entry for ${this.selectedDate}` });
      const addBtn = addSection.createEl("button", { cls: "csv-dash-add-btn", text: `+ Add entry for ${this.selectedDate}` });
      addBtn.addEventListener("click", () => {
        const newRow: CSVRow = {};
        this.headers.forEach(h => newRow[h] = "");
        newRow[dateCol] = this.selectedDate!;
        this.rows.push(newRow);
        this.scheduleSave();
        this.renderView();
      });
      // Still show chart and stats below
    }

    // ── Today's Habits ────────────────────────────────────────────────────────
    if (currentRow) {
      const habitsSection = container.createDiv({ cls: "csv-dash-habits" });
      habitsSection.createEl("h3", { text: this.selectedDate === today ? "Today" : this.selectedDate!, cls: "csv-dash-section-title" });

      const habitsGrid = habitsSection.createDiv({ cls: "csv-dash-habits-grid" });

      habitCols.forEach(h => {
        const isChecked = this.isTruthy(currentRow![h]);
        const habitEl = habitsGrid.createDiv({ cls: `csv-dash-habit ${isChecked ? "checked" : ""}` });
        const checkbox = habitEl.createEl("button", { cls: "csv-dash-habit-check", text: isChecked ? "●" : "○" });
        habitEl.createSpan({ cls: "csv-dash-habit-label", text: h });

        checkbox.addEventListener("click", () => {
          currentRow![h] = isChecked ? "0" : "1";
          this.scheduleSave();
          // Toggling a habit on the current day shouldn't reset dashboard
          // scroll — the user may have been looking at habit stats below
          // the fold.
          this.renderViewPreservingScroll();
        });
      });

      // Habits done count
      const doneCount = habitCols.filter(h => this.isTruthy(currentRow![h])).length;
      habitsSection.createDiv({ cls: "csv-dash-habits-count", text: `${doneCount} of ${habitCols.length} complete` });

      // Notes preview
      if (notesCol && currentRow[notesCol]?.trim()) {
        const notesPreview = habitsSection.createDiv({ cls: "csv-dash-notes-preview" });
        notesPreview.createEl("strong", { text: "Notes: " });
        notesPreview.createSpan({ text: currentRow[notesCol].slice(0, 200) + (currentRow[notesCol].length > 200 ? "…" : "") });
      }
    }

    // ── Chart ─────────────────────────────────────────────────────────────────
    const chartSection = container.createDiv({ cls: "csv-dash-chart-section" });
    chartSection.createEl("h3", { text: "Progress", cls: "csv-dash-section-title" });
    const chartWrap = chartSection.createDiv({ cls: "csv-dash-chart-wrap" });
    const canvas = chartWrap.createEl("canvas", { cls: "csv-dash-chart" });

    // Prepare chart data
    const chartLabels = sortedRows.map(r => {
      const d = r[dateCol] ?? "";
      return d.slice(5); // MM-DD format
    });
    const chartData = sortedRows.map(r => {
      return habitCols.filter(h => this.isTruthy(r[h])).length;
    });

    // Destroy previous chart if exists
    if (this.chartInstance) {
      this.chartInstance.destroy();
      this.chartInstance = null;
    }

    // Lazy-load Chart.js — first visit to a habit-tracker file pays the
    // ~200KB Chart.js init; subsequent renders are cached. The dashboard's
    // habit grid + stats render synchronously above, so the page is usable
    // before the chart paints.
    const { Chart } = await loadChart();
    // The view may have been navigated away from while we were loading.
    if (!canvas.isConnected) return;
    this.chartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels: chartLabels,
        datasets: [{
          label: "Habits done",
          data: chartData,
          borderColor: "#378ADD",
          backgroundColor: "rgba(55,138,221,0.08)",
          borderWidth: 1.5,
          pointRadius: 3,
          tension: 0.3,
          fill: true,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: habitCols.length || 8, ticks: { stepSize: 1 } }
        },
        plugins: { tooltip: { enabled: true } }
      }
    });

    // ── Stats ─────────────────────────────────────────────────────────────────
    const statsSection = container.createDiv({ cls: "csv-dash-stats-section" });
    statsSection.createEl("h3", { text: "Stats", cls: "csv-dash-section-title" });

    const totalDays = sortedRows.length;
    const totalHabitsDone = sortedRows.reduce((acc, r) => {
      return acc + habitCols.filter(h => this.isTruthy(r[h])).length;
    }, 0);
    const avgPerDay = totalDays > 0 ? (totalHabitsDone / totalDays).toFixed(1) : "0";
    const perfectDays = sortedRows.filter(r => {
      return habitCols.every(h => this.isTruthy(r[h]));
    }).length;

    // Streaks - must account for missing days (gaps break the streak)
    let bestStreak = 0, streak = 0;
    let prevDate: Date | null = null;
    for (const r of sortedRows) {
      const done = habitCols.filter(h => this.isTruthy(r[h])).length;
      const currentDate = this.parseDate(r[dateCol] ?? "");

      // Check if this is a consecutive day (no gap)
      let isConsecutive = true;
      if (prevDate && currentDate) {
        const dayDiff = Math.round((currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
        if (dayDiff !== 1) isConsecutive = false;
      }

      if (done >= 1 && (isConsecutive || prevDate === null)) {
        streak++;
        if (streak > bestStreak) bestStreak = streak;
      } else if (done >= 1) {
        // Had a gap, start new streak
        streak = 1;
        if (streak > bestStreak) bestStreak = streak;
      } else {
        streak = 0;
      }
      prevDate = currentDate;
    }

    // Current streak - check backwards from today, accounting for gaps
    let currentStreak = 0;
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    let expectedDate = todayDate;

    for (let i = sortedRows.length - 1; i >= 0; i--) {
      const rowDate = this.parseDate(sortedRows[i][dateCol] ?? "");
      if (!rowDate) break;

      const dayDiff = Math.round((expectedDate.getTime() - rowDate.getTime()) / (1000 * 60 * 60 * 24));

      // Allow today or yesterday as starting point, then must be consecutive
      if (currentStreak === 0 && dayDiff > 1) break; // Too old to start current streak
      if (currentStreak > 0 && dayDiff !== 1) break; // Gap in streak

      const done = habitCols.filter(h => this.isTruthy(sortedRows[i][h])).length;
      if (done >= 1) {
        currentStreak++;
        expectedDate = rowDate;
      } else {
        break;
      }
    }

    // Format stats like Dataview: "105 days logged · 2.0 avg/day · 0 perfect days · current streak 8d · best streak 90d"
    const statsBar = statsSection.createDiv({ cls: "csv-dash-stats-bar" });
    statsBar.innerHTML = `<strong>${totalDays}</strong> days logged · <strong>${avgPerDay}</strong> avg/day · <strong>${perfectDays}</strong> perfect days · current streak <strong>${currentStreak}d</strong> · best streak <strong>${bestStreak}d</strong>`;

    // ── Per-habit cards ───────────────────────────────────────────────────────
    const cardsSection = container.createDiv({ cls: "csv-dash-cards-section" });
    const cardsGrid = cardsSection.createDiv({ cls: "csv-dash-cards-grid" });

    // Get current year for "this year" stats
    const currentYear = new Date().getFullYear();

    // Habit icons - customize per habit name (fallback to ○)
    const habitIcons: { [key: string]: string } = {
      "language": "○", "read": "≡", "gym": "⊞", "vitamins": "⊙",
      "cardio": "↑", "meditate": "◎", "challenge": "✿", "journal": "✎",
      "exercise": "⊞", "water": "💧", "sleep": "🌙", "study": "📚",
    };

    const habitStats = habitCols.map(h => {
      const doneDays = sortedRows.filter(r => this.isTruthy(r[h]));
      const lastDone = doneDays.length > 0 ? doneDays[doneDays.length - 1][dateCol] : null;

      // Get years with data for this habit
      const yearsWithData = new Set<number>();
      doneDays.forEach(r => {
        const d = this.parseDate(r[dateCol] ?? "");
        if (d) yearsWithData.add(d.getFullYear());
      });

      // Count this year
      const thisYearRows = sortedRows.filter(r => {
        const d = this.parseDate(r[dateCol] ?? "");
        return d && d.getFullYear() === currentYear;
      });
      const doneThisYear = thisYearRows.filter(r => this.isTruthy(r[h])).length;

      return {
        habit: h,
        doneCount: doneDays.length,
        doneThisYear,
        totalThisYear: thisYearRows.length,
        lastDone,
        years: Array.from(yearsWithData).sort()
      };
    }).sort((a, b) => {
      // Sort by last done date (most recent first)
      if (!a.lastDone && !b.lastDone) return 0;
      if (!a.lastDone) return 1;
      if (!b.lastDone) return -1;
      return b.lastDone.localeCompare(a.lastDone);
    });

    habitStats.forEach(({ habit, doneCount, doneThisYear, totalThisYear, lastDone, years }) => {
      const card = cardsGrid.createDiv({ cls: "csv-dash-habit-card" });

      // Header with icon and name
      const icon = habitIcons[habit.toLowerCase()] ?? "○";
      const header = card.createDiv({ cls: "csv-dash-habit-card-header" });
      header.createSpan({ cls: "csv-dash-habit-icon", text: icon });
      header.createSpan({ cls: "csv-dash-habit-card-name", text: titleCase(habit) });

      // Year badges
      if (years.length > 0) {
        const yearBadges = card.createDiv({ cls: "csv-dash-habit-years" });
        yearBadges.setText(years.join(" · "));
      }

      // Stats
      card.createDiv({ cls: "csv-dash-habit-card-thisyear", text: `${doneThisYear} of ${totalThisYear} complete this year` });
      card.createDiv({ cls: "csv-dash-habit-card-alltime", text: `${doneCount} of ${totalDays} all time` });

      // Last logged with formatted date
      if (lastDone) {
        const d = this.parseDate(lastDone);
        const formatted = d ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : lastDone;
        card.createDiv({ cls: "csv-dash-habit-card-last", text: `Last logged: ${formatted}` });
      } else {
        card.createDiv({ cls: "csv-dash-habit-card-last", text: "Never logged" });
      }

      // Progress bar
      const pct = totalDays > 0 ? (doneCount / totalDays) * 100 : 0;
      const progressWrap = card.createDiv({ cls: "csv-dash-habit-progress" });
      const progressBar = progressWrap.createDiv({ cls: "csv-dash-habit-progress-bar" });
      progressBar.style.width = `${pct}%`;

      // Click to show per-habit timeline. Re-renders the whole dashboard,
      // which without scroll-preservation would yank the user back to (0,0)
      // — they'd have to scroll down to the same card again to see the
      // timeline that just appeared.
      card.addEventListener("click", () => {
        this.selectedHabit = this.selectedHabit === habit ? null : habit;
        this.renderViewPreservingScroll();
      });
      if (this.selectedHabit === habit) {
        card.addClass("selected");
      }
    });

    // ── Per-habit timeline (if a habit is selected) ───────────────────────────
    if (this.selectedHabit && habitCols.includes(this.selectedHabit)) {
      this.renderHabitTimeline(container, sortedRows, dateCol, this.selectedHabit);
    }
  }

  private timelineYear: number = new Date().getFullYear();

  private renderHabitTimeline(container: HTMLElement, sortedRows: CSVRow[], dateCol: string, habit: string): void {
    const timelineSection = container.createDiv({ cls: "csv-dash-timeline-section" });
    const header = timelineSection.createDiv({ cls: "csv-dash-timeline-header" });
    header.createEl("h3", { text: `${titleCase(habit)} Timeline`, cls: "csv-dash-section-title" });

    // Year selector
    const yearSelect = header.createEl("select", { cls: "csv-dash-year-select" });
    const availableYears = new Set<number>();
    sortedRows.forEach(r => {
      const d = this.parseDate(r[dateCol] ?? "");
      if (d) availableYears.add(d.getFullYear());
    });
    availableYears.add(new Date().getFullYear());
    Array.from(availableYears).sort().reverse().forEach(y => {
      const opt = yearSelect.createEl("option", { text: String(y), value: String(y) });
      if (y === this.timelineYear) opt.selected = true;
    });
    yearSelect.addEventListener("change", () => {
      this.timelineYear = parseInt(yearSelect.value);
      this.renderViewPreservingScroll();
    });

    const closeBtn = header.createEl("button", { cls: "csv-dash-timeline-close", text: "✕" });
    closeBtn.addEventListener("click", () => {
      this.selectedHabit = null;
      this.renderViewPreservingScroll();
    });

    // Build a map of date -> done status
    const dateMap = new Map<string, boolean>();
    sortedRows.forEach(r => {
      dateMap.set(r[dateCol] ?? "", this.isTruthy(r[habit]));
    });

    // Create calendar-style grid (like GitHub contribution graph)
    const gridWrap = timelineSection.createDiv({ cls: "csv-dash-timeline-grid-wrap" });

    // Month labels row
    const monthRow = gridWrap.createDiv({ cls: "csv-dash-timeline-months" });
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    months.forEach(m => monthRow.createSpan({ cls: "csv-dash-timeline-month-label", text: m }));

    // Grid of days (12 months x ~31 days)
    const grid = gridWrap.createDiv({ cls: "csv-dash-timeline-calendar" });

    // Day labels (1-31)
    const dayLabels = grid.createDiv({ cls: "csv-dash-timeline-day-labels" });
    for (let d = 1; d <= 31; d++) {
      dayLabels.createDiv({ cls: "csv-dash-timeline-day-label", text: d % 5 === 0 || d === 1 ? String(d) : "" });
    }

    // Each month column
    for (let month = 0; month < 12; month++) {
      const monthCol = grid.createDiv({ cls: "csv-dash-timeline-month-col" });
      const daysInMonth = new Date(this.timelineYear, month + 1, 0).getDate();

      for (let day = 1; day <= 31; day++) {
        if (day > daysInMonth) {
          monthCol.createDiv({ cls: "csv-dash-timeline-cell empty" });
          continue;
        }

        const dateStr = `${this.timelineYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const isDone = dateMap.get(dateStr) ?? false;
        const hasEntry = dateMap.has(dateStr);
        const isFuture = new Date(this.timelineYear, month, day) > new Date();

        const cell = monthCol.createDiv({
          cls: `csv-dash-timeline-cell ${isFuture ? "future" : ""} ${isDone ? "done" : ""} ${hasEntry && !isDone ? "missed" : ""} ${!hasEntry && !isFuture ? "no-entry" : ""}`
        });
        cell.title = `${dateStr}: ${isFuture ? "Future" : isDone ? "✓ Done" : hasEntry ? "✗ Missed" : "No entry"}`;
      }
    }

    // Stats for this habit (filtered by selected year)
    const yearRows = sortedRows.filter(r => {
      const d = this.parseDate(r[dateCol] ?? "");
      return d && d.getFullYear() === this.timelineYear;
    });
    const doneDays = yearRows.filter(r => this.isTruthy(r[habit])).length;
    const totalEntries = yearRows.length;

    // Calculate streak for this specific habit
    let habitStreak = 0, habitBestStreak = 0, tempStreak = 0;
    let prevDate: Date | null = null;
    for (const r of sortedRows) {
      const done = this.isTruthy(r[habit]);
      const currentDateParsed = this.parseDate(r[dateCol] ?? "");
      let isConsecutive = true;
      if (prevDate && currentDateParsed) {
        const dayDiff = Math.round((currentDateParsed.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
        if (dayDiff !== 1) isConsecutive = false;
      }
      if (done && (isConsecutive || prevDate === null)) {
        tempStreak++;
        if (tempStreak > habitBestStreak) habitBestStreak = tempStreak;
      } else if (done) {
        tempStreak = 1;
      } else {
        tempStreak = 0;
      }
      prevDate = currentDateParsed;
    }

    // Current streak for this habit
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    let expectedDate = todayDate;
    for (let i = sortedRows.length - 1; i >= 0; i--) {
      const rowDate = this.parseDate(sortedRows[i][dateCol] ?? "");
      if (!rowDate) break;
      const dayDiff = Math.round((expectedDate.getTime() - rowDate.getTime()) / (1000 * 60 * 60 * 24));
      if (habitStreak === 0 && dayDiff > 1) break;
      if (habitStreak > 0 && dayDiff !== 1) break;
      if (this.isTruthy(sortedRows[i][habit])) {
        habitStreak++;
        expectedDate = rowDate;
      } else {
        break;
      }
    }

    const statsEl = timelineSection.createDiv({ cls: "csv-dash-timeline-stats" });
    statsEl.innerHTML = `<strong>${doneDays}</strong> of ${totalEntries} in ${this.timelineYear} · current streak <strong>${habitStreak}d</strong> · best streak <strong>${habitBestStreak}d</strong>`;
  }

  // ── Mobile Files Generation ─────────────────────────────────────────────────

  private async generateMobileFiles(): Promise<void> {
    if (!this.file) return;

    const csvFolder = this.file.parent?.path ?? "";
    // Dashboards live in a Mobile/ subfolder to keep the main folder uncluttered.
    const mobileFolder = csvFolder ? `${csvFolder}/Mobile` : "Mobile";
    if (!await this.app.vault.adapter.exists(mobileFolder)) {
      await this.app.vault.adapter.mkdir(mobileFolder);
    }
    const dashboardPath = `${mobileFolder}/${this.file.basename}.md`;

    // Single canonical CSV path — both csv-add (write) and dataviewjs (read)
    // point at the same file. (Pre-migration the read path went through a
    // _csv_helpers/ mirror because the source was xlsx; that's gone now.)
    const csvPath = this.file.path;

    // Determine file type (habit tracker vs library)
    const dateCol = this.getDateCol();
    const categoryCol = this.getCategoryCol();
    // Note-relative path so `csv-add file:` still resolves if the parent
    // folder is moved or renamed (the dashboard lives one folder deeper
    // than the data file, under Mobile/).
    const filePath = "../" + this.file.name;

    let dashboardContent: string;

    if (dateCol) {
      // Habit tracker - use Dataview to query CSV
      dashboardContent = habitMobileTemplate({
        filePath,
        csvPath,
        habitCols: this.getBooleanColumns(),
        dateCol,
      });
    } else if (categoryCol) {
      // Library (books, movies) - cards grouped by category.
      // titleKey falls back through Quote/Headline/Phrase for files like
      // quotes/dictionary that have no Title/Name column.
      const titleKey = this.titleKey()
        ?? this.resolveCol(["Quote", "quote", "Headline", "headline", "Phrase", "phrase"])
        ?? this.headers[0]
        ?? "Title";
      dashboardContent = libraryMobileTemplate({
        filePath,
        csvPath,
        titleKey,
        categoryCol,
        statusCol: this.getStatusCol() ?? "Status",
        authorKey: this.authorKey() ?? "",
        yearCol: this.resolveCol(["Year", "year", "Released", "released"]) ?? "",
        ratingCol: this.resolveCol(["Rating", "rating", "Score", "score", "Stars", "stars"]) ?? "",
        themeCol: this.resolveCol(["Theme", "theme", "Subgenre", "subgenre", "Mood", "mood"]) ?? "",
        // 2-col grid when the title is a short label (book/movie name); 1-col
        // when titleKey fell back to Quote/Headline (long sentences).
        compactGrid: this.titleKey() !== null,
      });
    } else {
      // Generic - scrollable table over all headers
      dashboardContent = genericMobileTemplate({
        filePath,
        csvPath,
        headers: this.headers,
      });
    }

    try {
      const existingDashboard = this.app.vault.getAbstractFileByPath(dashboardPath);
      if (existingDashboard && existingDashboard instanceof TFile) {
        await this.app.vault.modify(existingDashboard, dashboardContent);
        new Notice(`Updated: ${dashboardPath}`);
      } else {
        await this.app.vault.create(dashboardPath, dashboardContent);
        new Notice(`Created: ${dashboardPath}`);
      }
    } catch {
      // File exists but wasn't found - try modify
      const f = this.app.vault.getAbstractFileByPath(dashboardPath);
      if (f instanceof TFile) {
        await this.app.vault.modify(f, dashboardContent);
        new Notice(`Updated: ${dashboardPath}`);
      }
    }
  }


  // ── Library View ────────────────────────────────────────────────────────────

  private libraryStatusFilter: string = "all";
  private libraryGenreFilter: string = "all";

  private renderLibrary(container: HTMLElement): void {
    const cc = this.getCategoryCol();
    const sc = this.getStatusCol();
    const titleCol = this.titleKey() ?? this.headers[0];
    const authorCol = this.authorKey();

    if (!cc) {
      container.createEl("p", { text: `No category column found.`, cls: "csv-empty-state" });
      return;
    }

    // Collect all genres
    const allGenres = new Set<string>();
    this.rows.forEach(row => {
      const cats = (row[cc] ?? "").split(",").map(c => c.trim()).filter(Boolean);
      cats.forEach(c => allGenres.add(c));
    });

    // Collect all statuses
    const allStatuses = new Set<string>();
    if (sc) {
      this.rows.forEach(row => {
        const status = (row[sc] ?? "").trim();
        if (status) allStatuses.add(status);
      });
    }

    // Filters bar
    const filtersBar = container.createDiv({ cls: "csv-library-filters" });

    // Status filter
    const statusSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
    statusSelect.createEl("option", { text: "All", value: "all" });

    // Add common status filters. "yes" and "seen" cover the common
    // Watched=yes / Seen=yes boolean patterns used by movie trackers.
    const commonDone = ["watched", "read", "finished", "completed", "done", "yes", "seen"];
    const commonInProgress = ["watching", "reading", "in progress", "in-progress"];
    const hasDone = Array.from(allStatuses).some(s => commonDone.includes(s.toLowerCase()));
    const hasInProgress = Array.from(allStatuses).some(s => commonInProgress.includes(s.toLowerCase()));

    if (hasDone || hasInProgress) {
      statusSelect.createEl("option", { text: "───────", value: "", attr: { disabled: "true" } });
      if (hasDone) statusSelect.createEl("option", { text: "✓ Done", value: "__done__" });
      if (hasInProgress) statusSelect.createEl("option", { text: "◐ In Progress", value: "__inprogress__" });
      statusSelect.createEl("option", { text: "○ Not Started", value: "__notstarted__" });
    }

    if (allStatuses.size > 0) {
      statusSelect.createEl("option", { text: "───────", value: "", attr: { disabled: "true" } });
      Array.from(allStatuses).sort().forEach(s => {
        statusSelect.createEl("option", { text: s, value: s });
      });
    }
    statusSelect.value = this.libraryStatusFilter;

    // Genre filter
    const genreSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
    genreSelect.createEl("option", { text: "All genres", value: "all" });
    Array.from(allGenres).sort().forEach(g => {
      genreSelect.createEl("option", { text: g, value: g });
    });
    genreSelect.value = this.libraryGenreFilter;

    // Search lives in the toolbar (the 🔍 toggle on mobile, always-visible
    // input on desktop). Library used to render its own search input here,
    // duplicating the one in the toolbar — both wrote to the same
    // this.searchQuery. Removed.

    // Filter handlers
    const applyFilters = () => {
      this.libraryStatusFilter = statusSelect.value;
      this.libraryGenreFilter = genreSelect.value;
      this.renderView(true);
    };

    statusSelect.addEventListener("change", applyFilters);
    genreSelect.addEventListener("change", applyFilters);

    // Filter rows
    let filtered = this.rows.filter(row => {
      // Status filter
      if (this.libraryStatusFilter !== "all" && sc) {
        const rowStatus = (row[sc] ?? "").toLowerCase();
        if (this.libraryStatusFilter === "__done__") {
          if (!commonDone.includes(rowStatus)) return false;
        } else if (this.libraryStatusFilter === "__inprogress__") {
          if (!commonInProgress.includes(rowStatus)) return false;
        } else if (this.libraryStatusFilter === "__notstarted__") {
          if (commonDone.includes(rowStatus) || commonInProgress.includes(rowStatus)) return false;
        } else {
          if (rowStatus !== this.libraryStatusFilter.toLowerCase()) return false;
        }
      }

      // Genre filter
      if (this.libraryGenreFilter !== "all") {
        const rowGenres = (row[cc] ?? "").split(",").map(c => c.trim().toLowerCase());
        if (!rowGenres.includes(this.libraryGenreFilter.toLowerCase())) return false;
      }

      // Search filter
      if (this.searchQuery.trim()) {
        const title = (row[titleCol] ?? "").toLowerCase();
        if (!title.includes(this.searchQuery.toLowerCase())) return false;
      }

      return true;
    });

    // Result count
    if (this.libraryStatusFilter !== "all" || this.libraryGenreFilter !== "all" || this.searchQuery.trim()) {
      container.createDiv({
        cls: "csv-library-result-count",
        text: `Showing ${filtered.length} of ${this.rows.length} entries`
      });
    }

    // Group by genre
    const groups: Record<string, CSVRow[]> = {};
    filtered.forEach(row => {
      const cats = this.libraryGenreFilter !== "all"
        ? [this.libraryGenreFilter]
        : (row[cc] ?? "Uncategorized").split(",").map(c => c.trim()).filter(Boolean);
      if (cats.length === 0) cats.push("Uncategorized");
      cats.forEach(cat => {
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(row);
      });
    });

    // Render sections
    const sectionsWrap = container.createDiv({ cls: "csv-library-sections" });

    Object.keys(groups).sort().forEach(genre => {
      const items = groups[genre];
      const section = sectionsWrap.createEl("details", { cls: "csv-library-section" });
      section.open = true;

      const summary = section.createEl("summary", { cls: "csv-library-section-header" });
      summary.innerHTML = `<span class="csv-library-arrow">▶</span> ${genre} <span class="csv-library-count">${items.length}</span>`;

      const grid = section.createDiv({ cls: "csv-library-grid" });

      // Sort: green-dotted (read/watched/finished) first, then in-progress,
      // then everything else. Within each group, alphabetical by title.
      // Rationale: surfacing what you've already done makes the section read
      // as a library catalogue (consumed → backlog) rather than a todo list.
      items.sort((a, b) => {
        if (sc) {
          const statusA = (a[sc] ?? "").toLowerCase();
          const statusB = (b[sc] ?? "").toLowerCase();
          const doneA = commonDone.includes(statusA);
          const doneB = commonDone.includes(statusB);
          if (doneA !== doneB) return doneA ? -1 : 1;
          const inProgressA = commonInProgress.includes(statusA);
          const inProgressB = commonInProgress.includes(statusB);
          if (inProgressA !== inProgressB) return inProgressA ? -1 : 1;
        }
        return (a[titleCol] ?? "").localeCompare(b[titleCol] ?? "");
      });

      // Resolve which extra columns to surface on each card.
      // If the user picked cardFields in the per-file Columns modal, use that list verbatim.
      // Otherwise auto-detect: author, year, rating, theme.
      const yearCol = this.resolveCol(["Year", "year", "Date", "date"]);
      const ratingCol = this.resolveCol(["Rating", "rating", "Score", "score", "Score /5", "Stars", "stars"]);
      const themeCol = this.resolveCol(["Theme", "theme", "Tags", "tags", "Tag", "tag", "Mood", "mood"]);
      const autoFields = [authorCol, yearCol, ratingCol, themeCol].filter((c): c is string => !!c);
      const cardFields = this.fileCfg.cardFields ?? autoFields;

      items.forEach(row => {
        const card = grid.createDiv({ cls: "csv-library-card" });

        // Title with green dot for "done"-style status (watched, read, finished, etc.)
        const titleWrap = card.createDiv({ cls: "csv-library-card-title" });
        if (sc) {
          const status = (row[sc] ?? "").toLowerCase();
          if (commonDone.includes(status)) {
            titleWrap.createSpan({ cls: "csv-library-done-dot" });
          }
        }
        titleWrap.createSpan({ text: row[titleCol] ?? "Untitled" });

        // Walk cardFields in order, rendering each with the right element type.
        // Rating → stars line; theme/tag/category aliases → pills; everything else → meta line.
        const metaParts: string[] = [];
        const themeFieldsForCard: string[] = [];
        for (const col of cardFields) {
          if (!col) continue;
          const raw = String(row[col] ?? "").trim();
          if (!raw) continue;

          if (col === ratingCol) {
            // Render rating as stars on its own line. Already-star data passes through.
            const display = formatRatingForDisplay(raw, col);
            if (display) card.createDiv({ cls: "csv-library-card-rating", text: display });
          } else if (col === themeCol) {
            // Comma-separated theme values render as multiple pills.
            themeFieldsForCard.push(...raw.split(",").map(t => t.trim()).filter(Boolean));
          } else if (col === yearCol) {
            // Year — extract 4-digit if it's a full date.
            const m = raw.match(/\d{4}/);
            metaParts.push(m ? m[0] : raw);
          } else {
            metaParts.push(raw);
          }
        }
        if (metaParts.length) {
          card.createDiv({ cls: "csv-library-card-meta", text: metaParts.join(" · ") });
        }

        // Secondary genres render as extra tags when filtering by a single genre.
        if (this.libraryGenreFilter !== "all") {
          const otherGenres = (row[cc] ?? "").split(",").map(c => c.trim()).filter(c => c && c.toLowerCase() !== this.libraryGenreFilter.toLowerCase());
          themeFieldsForCard.push(...otherGenres);
        }
        if (themeFieldsForCard.length) {
          const tagsWrap = card.createDiv({ cls: "csv-library-card-tags" });
          themeFieldsForCard.slice(0, 3).forEach(tag => {
            tagsWrap.createSpan({ cls: "csv-library-card-tag", text: tag });
          });
        }

        // Click to expand
        card.addEventListener("click", () => {
          const notesCol = this.getNotesCol();
          if (notesCol) {
            this.openNoteExpander(row, notesCol);
          }
        });
        card.addEventListener("contextmenu", e => this.openRowContextMenu(row, e));
      });
    });

    if (Object.keys(groups).length === 0) {
      sectionsWrap.createEl("p", { text: "No entries match your filters.", cls: "csv-empty-state" });
    }
  }

  // ── Kanban by Genre ────────────────────────────────────────────────────────

  private renderKanbanGenre(container: HTMLElement): void {
    const cc = this.getCategoryCol();
    const sc = this.getStatusCol();
    if (!cc) { container.createEl("p",{text:`No "${this.settings.categoryColumn}" column found.`,cls:"csv-empty-state"}); return; }

    const filteredRows = this.getFilteredRows();

    // Show search result count if searching
    if (this.searchQuery.trim()) {
      container.createDiv({ cls: "csv-search-results", text: `Found ${filteredRows.length} of ${this.rows.length} entries` });
    }

    const genreSet = new Set<string>();
    filteredRows.forEach(r => (r[cc]??"").split(",").map(s=>s.trim()).filter(Boolean).forEach(c=>genreSet.add(c)));
    const genres = Array.from(genreSet).sort();
    if (!genres.length) {
      container.createEl("p",{text: this.searchQuery ? "No matching entries found." : "No genre values found.",cls:"csv-empty-state"});
      return;
    }

    const statusOrder = ["In progress","Finished","Not started"];
    const statuses = sc
      ? Array.from(new Set([...statusOrder,...filteredRows.map(r=>r[sc]??"").filter(Boolean)])).filter(s=>filteredRows.some(r=>(r[sc]??"")==s))
      : [];

    const board = container.createDiv({cls:"csv-kanban-board"});
    genres.forEach(genre => {
      const genreRows = filteredRows.filter(r=>(r[cc]??"").split(",").map(s=>s.trim()).includes(genre));
      if (!genreRows.length) return;
      const col = board.createDiv({cls:"csv-kanban-col"});
      const ch = col.createDiv({cls:"csv-kanban-col-header"});
      ch.createDiv({cls:"csv-kanban-col-title", text:genre});
      ch.createDiv({cls:"csv-kanban-col-count", text:String(genreRows.length)});
      const cb = col.createDiv({cls:"csv-kanban-col-body"});

      if (sc && statuses.length) {
        statuses.forEach(status => {
          const statusRows = genreRows.filter(r=>(r[sc]??"")=== status);
          if (!statusRows.length) return;
          const groupEl = cb.createDiv({cls:"csv-kanban-status-group"});
          groupEl.createDiv({cls:`csv-kanban-status-label status-${status.toLowerCase().replace(/\s+/g,"-")}`, text:status});
          statusRows.forEach(row => this.renderKanbanCard(groupEl, row, statuses, sc));
        });
      } else {
        genreRows.forEach(row => this.renderKanbanCard(cb, row, statuses, sc));
      }
    });
  }

  // ── Kanban card ────────────────────────────────────────────────────────────

  private renderKanbanCard(container: HTMLElement, row: CSVRow, statuses: string[], sc: string|null): void {
    const card = container.createDiv({cls:"csv-kanban-card"});
    const notesColForCard = this.getNotesCol();

    // Title row: title text on the left, small notes-file icon on the right.
    // Tapping the title opens the entry expander; the small icon creates or
    // opens the sidecar .md. Replaces the old hover-revealed bottom button row.
    const titleRow = card.createDiv({cls:"csv-kanban-card-title-row"});
    const titleEl = titleRow.createDiv({cls:"csv-kanban-card-title", text:this.getTitle(row)});
    if (notesColForCard) {
      titleEl.addEventListener("click", e => { e.stopPropagation(); this.openNoteExpander(row, notesColForCard); });
    }
    const hasNotesFile = this.notesFileExists(row);
    const notesIconBtn = titleRow.createEl("button", {
      cls: `csv-kanban-notes-icon ${hasNotesFile ? "exists" : ""}`,
      text: hasNotesFile ? "📄" : "+",
      title: hasNotesFile ? "Open notes file" : "Create notes file",
    });
    notesIconBtn.addEventListener("click", e => { e.stopPropagation(); this.openOrCreateNotes(row); });

    const sub = this.getSubtitle(row);
    if (sub) card.createDiv({cls:"csv-kanban-card-sub", text:sub});

    // Meta chips for select fields (skip category, title, author, status)
    const tk=this.titleKey(), ak=this.authorKey(), ccol=this.getCategoryCol();
    const skipInCard = new Set([sc, tk, ak, ccol].filter(Boolean) as string[]);
    const metaEl = card.createDiv({cls:"csv-kanban-card-meta"});
    this.headers.forEach(h => {
      if (skipInCard.has(h) || this.isNotesCol(h) || !row[h]) return;
      const chip = metaEl.createDiv({cls:"csv-kanban-chip"});
      chip.createSpan({cls:"csv-chip-label", text:h+": "});
      if (this.isSelectCol(h)) {
        const valSpan = chip.createSpan({cls:"csv-chip-value csv-chip-select", text:row[h]});
        valSpan.addEventListener("click", e => {
          e.stopPropagation();
          showSelectPicker(valSpan, row[h], this.getColumnValues(h), (newVal) => {
            row[h]=newVal; valSpan.setText(newVal||"—"); this.scheduleSave();
          }, this.contentEl);
        });
      } else {
        const display = row[h].length > 40 ? row[h].slice(0, 38) + "…" : row[h];
        const valSpan = chip.createSpan({cls:"csv-chip-value", text: display});
        if (row[h].length > 40) valSpan.title = row[h]; // full text on hover
      }
    });

    // Inline notes
    const notesCol = this.getNotesCol();
    const hasInlineNotes = !!(notesCol && row[notesCol]?.trim());

    // The preview is itself the editor affordance — clicking opens the
    // inline textarea. When there's no note yet, render a quiet "+ Add note"
    // placeholder in the same slot so the click target is discoverable
    // without needing a separate "Edit note" button.
    const notesPreviewEl = card.createDiv({cls:"csv-kanban-notes-preview"});
    if (hasInlineNotes && notesCol) {
      const plain = row[notesCol].replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").replace(/\n+/g," ").trim();
      notesPreviewEl.setText(plain.slice(0,120) + (plain.length > 120 ? "…" : ""));
      notesPreviewEl.title = "Click to edit";
    } else {
      notesPreviewEl.addClass("csv-kanban-notes-preview--empty");
      if (notesCol) notesPreviewEl.setText("+ Add note");
    }

    const notesEditorEl = card.createDiv({cls:"csv-kanban-notes-editor"});
    notesEditorEl.style.display = "none";

    const openInlineEditor = () => {
      // Save scroll position of the content area so we can restore it on close
      const contentArea = this.contentEl.querySelector(".csv-content-area") as HTMLElement | null;
      const scrollLeft = contentArea?.scrollLeft ?? 0;
      const scrollTop = contentArea?.scrollTop ?? 0;

      notesPreviewEl.style.display = "none";
      notesEditorEl.style.display = "block";
      notesEditorEl.empty();
      const ta = notesEditorEl.createEl("textarea", {cls:"csv-notes-textarea"});
      ta.value = (notesCol ? row[notesCol] : "") ?? "";
      ta.addEventListener("click", e => e.stopPropagation());
      ta.addEventListener("mousedown", e => e.stopPropagation());
      ta.addEventListener("input", () => { ta.style.height="auto"; ta.style.height=ta.scrollHeight+"px"; });
      ta.addEventListener("keydown", e => { if (e.key==="Escape") closeInlineEditor(ta.value, contentArea, scrollLeft, scrollTop); });
      ta.addEventListener("blur", () => closeInlineEditor(ta.value, contentArea, scrollLeft, scrollTop));
      // Use preventScroll to avoid browser auto-scrolling the content area
      ta.focus({ preventScroll: true });
      // Cursor at the start of the text, not the end. Setting .value on a
      // textarea then calling .focus() defaults to placing the caret at the
      // end — on long notes that scrolls the textarea's internal viewport
      // past all the content, so the user opens the editor and sees an
      // empty area "much down" with no text visible.
      ta.setSelectionRange(0, 0);
      ta.scrollTop = 0;
      // Size to content after a frame. Reading scrollHeight inline (before
      // layout) returns ~0, which made the height clamp to the 120 px floor
      // regardless of how long the note actually is.
      requestAnimationFrame(() => {
        ta.style.height = "auto";
        ta.style.height = Math.max(120, ta.scrollHeight) + "px";
      });
    };

    const closeInlineEditor = (newVal: string, contentArea: HTMLElement | null, scrollLeft: number, scrollTop: number) => {
      if (notesCol) { row[notesCol]=newVal; this.scheduleSave(); }
      notesEditorEl.style.display = "none";
      notesPreviewEl.style.display = "";
      if (newVal.trim()) {
        const plain = newVal.replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").replace(/\n+/g," ").trim();
        notesPreviewEl.setText(plain.slice(0,120) + (plain.length > 120 ? "…" : ""));
        notesPreviewEl.removeClass("csv-kanban-notes-preview--empty");
        notesPreviewEl.title = "Click to edit";
      } else {
        // Restore the "+ Add note" placeholder rather than leaving an empty,
        // invisible click target. Matches initial render exactly.
        notesPreviewEl.addClass("csv-kanban-notes-preview--empty");
        notesPreviewEl.setText(notesCol ? "+ Add note" : "");
        notesPreviewEl.removeAttribute("title");
      }
      // Restore scroll position after the DOM settles
      // Use multiple approaches to ensure scroll is restored even if browser does post-blur adjustments
      if (contentArea) {
        contentArea.scrollLeft = scrollLeft;
        contentArea.scrollTop = scrollTop;
        requestAnimationFrame(() => {
          contentArea.scrollLeft = scrollLeft;
          contentArea.scrollTop = scrollTop;
          requestAnimationFrame(() => {
            contentArea.scrollLeft = scrollLeft;
            contentArea.scrollTop = scrollTop;
          });
        });
        setTimeout(() => {
          contentArea.scrollLeft = scrollLeft;
          contentArea.scrollTop = scrollTop;
        }, 50);
      }
    };

    notesPreviewEl.addEventListener("click", e => {
      e.stopPropagation();
      // On touch devices, opening the inline textarea pops iOS's virtual
      // keyboard, which scrolls the focused element into view — that yanks
      // the user's y-position so far down the originally-tapped card
      // disappears off-screen. The expander modal sits in its own viewport,
      // so the keyboard only resizes the modal and the underlying view
      // stays put. Desktop keeps the inline textarea (faster, no modal lift).
      if (notesCol && matchMedia("(pointer: coarse)").matches) {
        this.openNoteExpander(row, notesCol);
        return;
      }
      openInlineEditor();
    });

    // Expand and Notes-file actions are now in the title row (title-tap and
    // small + icon). No bottom button row.

    // (Previously had a click handler that just called stopPropagation — no
    // useful purpose. Removed; specific child elements stop propagation when
    // they need to.)
    card.addEventListener("contextmenu", e => this.openRowContextMenu(row, e));
  }

  // ── Table ──────────────────────────────────────────────────────────────────

  private renderTable(container: HTMLElement): void {
    const filteredRows = this.getFilteredRows();

    // Show search result count if searching
    if (this.searchQuery.trim()) {
      container.createDiv({ cls: "csv-search-results", text: `Found ${filteredRows.length} of ${this.rows.length} entries` });
    }

    const wrap = container.createDiv({cls:"csv-table-wrapper"});
    const table = wrap.createEl("table",{cls:"csv-table"});
    const hr = table.createEl("thead").createEl("tr");

    this.headers.forEach(h => {
      const th = hr.createEl("th");
      th.setText(h);
      const savedWidth = this.settings.columnWidths[h];
      if (savedWidth) th.style.width = savedWidth + "px";
      const handle = th.createDiv({cls:"csv-col-resize-handle"});
      let startX = 0, startW = 0;
      handle.addEventListener("mousedown", e => {
        e.preventDefault(); startX=e.clientX; startW=th.offsetWidth;
        const onMove = (ev: MouseEvent) => { th.style.width=Math.max(60,startW+ev.clientX-startX)+"px"; };
        const onUp = (ev: MouseEvent) => { this.settings.columnWidths[h]=Math.max(60,startW+ev.clientX-startX); document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp); };
        document.addEventListener("mousemove",onMove); document.addEventListener("mouseup",onUp);
      });
    });
    hr.createEl("th",{text:""});

    // Skip the clip-detection on touch — the fade gradient it triggers is
    // a hover affordance and irrelevant without a cursor. Saves N rAFs × N
    // forced reflows per render on phones (the prime cause of table-view lag
    // on iPhone when the file has hundreds of rows).
    const isTouch = matchMedia("(pointer: coarse)").matches;
    const tbody = table.createEl("tbody");
    filteredRows.forEach((row) => {
      const tr = tbody.createEl("tr");
      tr.addEventListener("contextmenu", e => this.openRowContextMenu(row, e));
      this.headers.forEach(h => {
        const td = tr.createEl("td");
        if (this.isNotesCol(h)) {
          td.addClass("csv-table-notes-cell");
          const preview = (row[h]??"").replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").split("\n").filter(l=>l.trim()).slice(0,3).join(" · ");
          const display = preview ? (preview.slice(0,200)+(preview.length>200?"…":"")) : "+ Add note";
          const span = td.createSpan({ text: display });
          if (!preview) span.addClass("csv-table-notes-empty");
          td.title = "Click to open note";
          // Cell-click opens the expander. The "⤢" button used to live here
          // too, but the cell is the obvious click target — the button was
          // redundant noise.
          td.addEventListener("click", (e) => { e.stopPropagation(); this.openNoteExpander(row, h); });
        } else if (this.isSelectCol(h)) {
          this.renderSelectField(td, row, h);
        } else {
          const val = row[h] ?? "";
          td.setText(val);
          if (val.length > 80) td.title = val;
          this.makeEditable(td, row, h);
        }
      });
      const at = tr.createEl("td",{cls:"csv-table-action"});
      const hasFile = this.notesFileExists(row);
      at.createEl("button",{cls:`csv-table-notes-btn ${hasFile?"exists":""}`,text:hasFile?"📄":"✚",title:hasFile?"Open notes":"Create notes"})
        .addEventListener("click",()=>this.openOrCreateNotes(row));
      at.createEl("button",{cls:"csv-table-del-btn",text:"✕",title:"Delete row (Undo available)"})
        .addEventListener("click",()=>this.deleteWithUndo(row));
    });
    // Detect overflowing cells in one rAF instead of one per row. Single
    // querySelectorAll, single forced-layout batch — orders of magnitude
    // cheaper than per-row rAF on big files. Skipped entirely on touch.
    if (!isTouch) {
      requestAnimationFrame(() => {
        tbody.querySelectorAll<HTMLElement>("td:not(.csv-table-notes-cell):not(.csv-table-action)").forEach(cell => {
          if (cell.scrollHeight > cell.clientHeight + 1) cell.addClass("csv-cell--clipped");
        });
      });
    }
  }

  private makeEditable(el: HTMLElement, row: CSVRow, h: string): void {
    el.addEventListener("click", () => {
      el.empty();
      const input = el.createEl("input",{cls:"csv-inline-input",value:row[h]??"",type:"text"});
      input.focus(); input.select();
      input.addEventListener("blur",()=>{ row[h]=input.value; this.scheduleSave(); el.empty(); el.setText(input.value||"—"); });
      input.addEventListener("keydown",e=>{ if(e.key==="Enter")input.blur(); if(e.key==="Escape"){el.empty();el.setText(row[h]||"—");} });
    });
  }

  onunload(): void { this.renderComponent.unload(); if(this.saveTimer) window.clearTimeout(this.saveTimer); }
}

// ─── Settings ─────────────────────────────────────────────────────────────────

class CardViewSettingTab extends PluginSettingTab {
  plugin: CardViewPlugin;
  constructor(app: App, plugin: CardViewPlugin){super(app,plugin); this.plugin=plugin;}
  display(): void {
    const {containerEl}=this; containerEl.empty();
    containerEl.createEl("h2",{text:"XLSX Card View"});
    new Setting(containerEl).setName("Default view mode")
      .addDropdown(d=>d.addOption("kanban-genre","Kanban").addOption("table","Table")
        .setValue(this.plugin.settings.defaultMode)
        .onChange(async v=>{ this.plugin.settings.defaultMode=v as ViewMode; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Status column name")
      .addText(t=>t.setValue(this.plugin.settings.statusColumn).onChange(async v=>{ this.plugin.settings.statusColumn=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Category/Genre column name")
      .addText(t=>t.setValue(this.plugin.settings.categoryColumn).onChange(async v=>{ this.plugin.settings.categoryColumn=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notes column names").setDesc("Comma-separated.")
      .addText(t=>t.setValue(this.plugin.settings.notesColumns.join(", ")).onChange(async v=>{ this.plugin.settings.notesColumns=v.split(",").map(s=>s.trim()); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Select/dropdown columns").setDesc("Comma-separated column names that use a dropdown picker.")
      .addText(t=>t.setValue(this.plugin.settings.selectColumns.join(", ")).onChange(async v=>{ this.plugin.settings.selectColumns=v.split(",").map(s=>s.trim()); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notes subfolder")
      .addText(t=>t.setPlaceholder("Notes").setValue(this.plugin.settings.notesSubfolder).onChange(async v=>{ this.plugin.settings.notesSubfolder=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Reset column widths")
      .addButton(b=>b.setButtonText("Reset").onClick(async()=>{ this.plugin.settings.columnWidths={}; await this.plugin.saveSettings(); new Notice("Column widths reset."); }));
  }
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
      await this.renderAddEntryForm(source.trim(), el, ctx);
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

  async renderAddEntryForm(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    // Parse source to get file path
    const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
    let filePath = "";
    for (const line of lines) {
      if (line.startsWith("file:")) {
        filePath = line.replace("file:", "").trim();
        break;
      }
    }

    if (!filePath) {
      el.createEl("p", { text: "Error: No file specified. Use: file: yourfile.csv", cls: "csv-add-error" });
      return;
    }

    // Resolve path relative to current note. Three forms accepted:
    //   "books.csv"                         → sibling of current note
    //   "../books.csv" or "../../foo.csv"   → walked up from current folder
    //   "Library/books.csv"       → vault-relative (any path containing
    //                                          "/" without a leading ".." is treated
    //                                          as vault-relative for back-compat)
    const currentFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    const baseFolder = currentFile?.parent?.path ?? "";
    const fullPath = resolvePath(filePath, baseFolder);

    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (!file || !(file instanceof TFile)) {
      el.createEl("p", { text: `Error: File not found: ${fullPath}`, cls: "csv-add-error" });
      return;
    }

    // Read the file to get headers
    let headers: string[] = [];
    let rows: CSVRow[] = [];

    try {
      const text = await this.app.vault.read(file);
      const parsed = parseCSV(text);
      headers = parsed.headers;
      rows = parsed.rows;
    } catch (e) {
      el.createEl("p", { text: `Error reading file: ${e}`, cls: "csv-add-error" });
      return;
    }

    if (!headers.length) {
      el.createEl("p", { text: "Error: No columns found in file", cls: "csv-add-error" });
      return;
    }

    // Detect column types
    const binaryPatterns = ["0", "1", "true", "false", "yes", "no", ""];
    const isBinaryCol = (h: string): boolean => {
      const vals = rows.map(r => (r[h] ?? "").toLowerCase().trim());
      return vals.length > 0 && vals.every(v => binaryPatterns.includes(v));
    };

    const isDateCol = (h: string): boolean => {
      const hLower = h.toLowerCase();
      if (["date", "day", "datum"].includes(hLower)) return true;
      const vals = rows.slice(0, 5).map(r => r[h] ?? "");
      return vals.length > 0 && vals.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
    };

    const isNotesCol = (h: string): boolean => {
      const hLower = h.toLowerCase();
      return ["notes", "note", "comments", "description", "journal"].includes(hLower);
    };

    // Categorize columns
    const binaryCols = headers.filter(h => isBinaryCol(h) && !isDateCol(h));
    const dateCols = headers.filter(h => isDateCol(h));
    const notesCols = headers.filter(h => isNotesCol(h));
    const otherCols = headers.filter(h => !binaryCols.includes(h) && !dateCols.includes(h) && !notesCols.includes(h));

    // Render as one collapsible "menu" (Apple-style grouped card):
    //   - Default state: a single discreet "+ New entry" pill.
    //   - Tap → expands a single rounded card containing all fields as rows
    //     separated by hairlines, then one "Add" button. No more disjoint blocks.
    const root = el.createDiv({ cls: "csv-add-form csv-add-compact" });

    // Default-open: the card is visible immediately; tapping × collapses it
    // to the trigger pill, and the pill re-opens it. (One menu, always one tap
    // away in either direction.)
    const trigger = root.createEl("button", { cls: "csv-add-trigger", text: "+ New entry" });
    trigger.style.display = "none";
    const card = root.createDiv({ cls: "csv-add-card" });

    // Header bar: title + close (×). Re-uses the trigger to collapse.
    const header = card.createDiv({ cls: "csv-add-card-header" });
    header.createEl("span", { cls: "csv-add-card-title", text: "New entry" });
    const closeBtn = header.createEl("button", { cls: "csv-add-card-close", text: "×" });

    // Rows live in one grouped list with hairline separators between them.
    const rowsWrap = card.createDiv({ cls: "csv-add-rows" });

    const inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
    const toggleStates: Record<string, boolean> = {};

    // Helper: a single row (label on the left, control on the right).
    const makeRow = (h: string, kind: string) => {
      const row = rowsWrap.createDiv({ cls: `csv-add-row csv-add-row-${kind}` });
      row.createEl("span", { cls: "csv-add-row-label", text: titleCase(h) });
      return row;
    };

    // Date row (habit trackers) — first so today's date is the obvious default.
    dateCols.forEach(h => {
      const row = makeRow(h, "date");
      const dateInput = row.createEl("input", { cls: "csv-add-row-control", type: "date" });
      dateInput.value = new Date().toISOString().split("T")[0];
      inputs[h] = dateInput;
    });

    // Binary columns: each one its own row with a right-aligned switch.
    binaryCols.forEach(h => {
      toggleStates[h] = false;
      const row = makeRow(h, "toggle");
      const switchWrap = row.createEl("label", { cls: "csv-add-switch" });
      const checkbox = switchWrap.createEl("input", { type: "checkbox", cls: "csv-add-switch-input" });
      switchWrap.createEl("span", { cls: "csv-add-switch-track" });
      checkbox.addEventListener("change", () => { toggleStates[h] = checkbox.checked; });
      inputs[h] = checkbox;
    });

    // Other fields (title, author, category, etc.) — text or select inline.
    otherCols.forEach(h => {
      const row = makeRow(h, "field");
      const uniqueVals = new Set(rows.map(r => (r[h] ?? "").trim()).filter(Boolean));
      if (uniqueVals.size > 0 && uniqueVals.size <= 15) {
        const select = row.createEl("select", { cls: "csv-add-row-control" });
        select.createEl("option", { text: "—", value: "" });
        Array.from(uniqueVals).sort().forEach(v => select.createEl("option", { text: v, value: v }));
        select.createEl("option", { text: "+ Custom", value: "__custom__" });
        // Custom input lives in its own row that appears just below when chosen.
        const customRow = rowsWrap.createDiv({ cls: "csv-add-row csv-add-row-custom" });
        customRow.style.display = "none";
        const customInput = customRow.createEl("input", { cls: "csv-add-row-control", type: "text", placeholder: `Custom ${titleCase(h).toLowerCase()}` });
        // Keep the custom row visually adjacent to its parent select row.
        rowsWrap.insertBefore(customRow, row.nextSibling);
        select.addEventListener("change", () => {
          customRow.style.display = select.value === "__custom__" ? "flex" : "none";
          if (select.value === "__custom__") customInput.focus();
        });
        inputs[h] = select;
        inputs[`${h}__custom`] = customInput as HTMLInputElement;
      } else {
        inputs[h] = row.createEl("input", { cls: "csv-add-row-control", type: "text", placeholder: titleCase(h) });
      }
    });

    // Notes row — full-width textarea, stacked below the inline label.
    notesCols.forEach(h => {
      const row = rowsWrap.createDiv({ cls: "csv-add-row csv-add-row-notes" });
      row.createEl("span", { cls: "csv-add-row-label", text: titleCase(h) });
      inputs[h] = row.createEl("textarea", { cls: "csv-add-row-textarea", placeholder: "Optional notes…" }) as any;
    });

    // Submit lives inside the card so the whole menu reads as one unit.
    const submitBtn = card.createEl("button", { text: "Add", cls: "csv-add-submit" });

    // ── Pre-fill from existing row (habit trackers) ────────────────────────────
    // When the date input matches an existing row in the file, populate the
    // form with that row's values so the user can SEE what's already saved
    // before they edit. Previously the form was always blank and a habit
    // update was indistinguishable from a fresh entry — easy to wipe an
    // existing day's notes by tabbing through.
    //
    // Only runs when the file has a date column (i.e. habit-tracker shape);
    // library/generic dashboards have no date and skip naturally.
    const titleEl = header.querySelector(".csv-add-card-title") as HTMLElement | null;
    const syncFromExisting = (): void => {
      if (!dateCols.length) return;
      const dateInput = inputs[dateCols[0]] as HTMLInputElement | undefined;
      if (!dateInput) return;
      const dateVal = dateInput.value;
      const existing = rows.find(r => r[dateCols[0]] === dateVal);

      // Title hint, card accent, and button label all flip together so the
      // user can tell at a glance that the form is showing what's already
      // saved for this date (not a blank new entry).
      if (titleEl) {
        titleEl.setText(existing ? `Updating ${dateVal}` : "New entry");
      }
      card.classList.toggle("is-updating", !!existing);
      submitBtn.setText(existing ? "Update" : "Add");

      // Binary toggles — set from existing or clear back to false.
      binaryCols.forEach(h => {
        const checkbox = inputs[h] as HTMLInputElement | undefined;
        if (!checkbox) return;
        const v = (existing?.[h] ?? "").toLowerCase().trim();
        const on = v === "1" || v === "true" || v === "yes";
        checkbox.checked = on;
        toggleStates[h] = on;
      });

      // Text/select fields and notes textareas — set from existing or clear.
      [...otherCols, ...notesCols].forEach(h => {
        const input = inputs[h];
        if (!input) return;
        const val = existing?.[h] ?? "";
        if (input instanceof HTMLSelectElement) {
          // If the existing value isn't a known option, leave the select on
          // "—" and put the value into the custom input slot. Otherwise pick
          // the matching option.
          const opt = Array.from(input.options).find(o => o.value === val);
          if (opt) {
            input.value = val;
            // Hide any custom-row that was previously open.
            const customRow = (inputs[`${h}__custom`] as HTMLInputElement | undefined)?.closest(".csv-add-row-custom") as HTMLElement | null;
            if (customRow) customRow.style.display = "none";
          } else {
            input.value = val ? "" : "";
          }
        } else if (input instanceof HTMLTextAreaElement) {
          input.value = val;
        } else {
          (input as HTMLInputElement).value = val;
        }
      });
    };
    // Pre-fill once on initial render, then re-sync whenever the user
    // navigates to a different date.
    syncFromExisting();
    if (dateCols.length) {
      const dateInput = inputs[dateCols[0]] as HTMLInputElement | undefined;
      dateInput?.addEventListener("change", syncFromExisting);
    }

    // Expand / collapse wiring. Focusing the first text-ish input on open
    // mirrors iOS sheet behaviour where the keyboard comes up immediately.
    const open = () => {
      card.style.display = "block";
      trigger.style.display = "none";
      const first = card.querySelector(".csv-add-row-control") as HTMLElement | null;
      first?.focus();
    };
    const close = () => {
      card.style.display = "none";
      trigger.style.display = "";
    };
    trigger.addEventListener("click", open);
    closeBtn.addEventListener("click", close);

    submitBtn.addEventListener("click", async () => {
      // Gather values
      const newRow: CSVRow = {};
      headers.forEach(h => {
        if (binaryCols.includes(h)) {
          newRow[h] = toggleStates[h] ? "1" : "0";
        } else if (inputs[h] instanceof HTMLSelectElement && (inputs[h] as HTMLSelectElement).value === "__custom__") {
          newRow[h] = (inputs[`${h}__custom`] as HTMLInputElement)?.value ?? "";
        } else if (inputs[h] instanceof HTMLTextAreaElement) {
          newRow[h] = (inputs[h] as HTMLTextAreaElement).value;
        } else {
          newRow[h] = (inputs[h] as HTMLInputElement)?.value ?? "";
        }
      });

      // Check if at least one field is filled (for non-habit trackers) or date is set (for habit trackers)
      const hasDate = dateCols.length > 0 && dateCols.some(h => (newRow[h] ?? "").trim());
      const hasOtherValue = [...otherCols, ...notesCols].some(h => (newRow[h] ?? "").trim());
      const hasToggle = binaryCols.some(h => toggleStates[h]);

      if (!hasDate && !hasOtherValue && !hasToggle) {
        new Notice("Please fill at least one field");
        return;
      }

      // Re-read file to get latest data (avoids stale data issues)
      let currentRows: CSVRow[] = [];
      try {
        const text = await this.app.vault.read(file);
        currentRows = parseCSV(text).rows;
      } catch (e) {
        new Notice(`Error reading file: ${e}`);
        return;
      }

      // Check for duplicate date entry (for habit trackers)
      let isUpdate = false;
      let existingRowIdx = -1;
      if (dateCols.length > 0) {
        const dateCol = dateCols[0];
        const dateVal = newRow[dateCol];
        existingRowIdx = currentRows.findIndex(r => r[dateCol] === dateVal);
        if (existingRowIdx >= 0) {
          // Update existing row - merge values (only update non-empty new values)
          isUpdate = true;
          const existingRow = currentRows[existingRowIdx];
          headers.forEach(h => {
            if (binaryCols.includes(h)) {
              // For binary cols, always use the new toggle state
              existingRow[h] = newRow[h];
            } else if ((newRow[h] ?? "").trim()) {
              // For other cols, only update if new value is non-empty
              existingRow[h] = newRow[h];
            }
          });
        } else {
          currentRows.push(newRow);
        }
      } else {
        currentRows.push(newRow);
      }

      // (Previously had `const rows = currentRows` shadowing the outer
      // `rows` from the form-render scope. Removed so the post-submit
      // re-sync can mutate the outer array via the captured reference.)
      try {
        const csv = Papa.unparse(currentRows, { columns: headers });
        await this.app.vault.modify(file, csv);

        new Notice(isUpdate ? `Updated entry for ${newRow[dateCols[0]] || ""}` : `Added entry to ${file.basename}`);

        // Sync our cached rows to what's now on disk so syncFromExisting reads
        // fresh data. Mutates in place to preserve the closure reference.
        rows.length = 0;
        rows.push(...currentRows);

        if (dateCols.length > 0) {
          // Habit-tracker shape: don't clear — re-sync the form so it shows
          // the just-saved state. The user can see what they recorded for
          // this day; if they want a different day they change the date.
          syncFromExisting();
        } else {
          // Other shapes (library / generic): clear for the next entry. Many
          // entries with the same shape go into the same form session.
          binaryCols.forEach(h => {
            toggleStates[h] = false;
            const checkbox = inputs[h] as HTMLInputElement;
            if (checkbox) checkbox.checked = false;
          });
          [...otherCols, ...notesCols].forEach(h => {
            const input = inputs[h];
            if (input instanceof HTMLSelectElement) {
              input.selectedIndex = 0;
            } else if (input instanceof HTMLTextAreaElement) {
              input.value = "";
            } else if (input) {
              (input as HTMLInputElement).value = "";
            }
            const customInput = inputs[`${h}__custom`];
            if (customInput) {
              (customInput as HTMLInputElement).value = "";
              // The custom input lives inside a .csv-add-row-custom wrapper —
              // hide the row itself so the layout stays in sync with the select.
              const customRow = (customInput as HTMLInputElement).closest(".csv-add-row-custom") as HTMLElement | null;
              if (customRow) customRow.style.display = "none";
            }
          });
        }
        // Card stays open after a successful add so a quick second entry is one
        // tap away; user can collapse with the × header button when finished.

        // Auto-refresh: reopen the note to force Dataview to re-read CSV
        setTimeout(async () => {
          const noteFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
          if (noteFile instanceof TFile) {
            const leaf = this.app.workspace.activeLeaf;
            if (leaf) {
              await leaf.openFile(noteFile, { state: { mode: "preview" } });
            }
          }
        }, 300);
      } catch (e) {
        new Notice(`Error saving: ${e}`);
      }
    });
  }

  async loadSettings(): Promise<void> { this.settings=Object.assign({},DEFAULT_SETTINGS,await this.loadData()); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
}
