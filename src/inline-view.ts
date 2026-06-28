// ─── csv-view code block: an inline, editable CSV view ───────────────────────
//
// Renders a CSV file's data as a table / cards / kanban *inside a note* — the
// way a `.base` block or a Notion linked-database renders a view in a page.
// Reuses the full-view renderers (renderTable / renderLibrary / renderKanban)
// verbatim by giving them a host object that satisfies the same duck-typed
// surface CardView exposes, but lives in a markdown block instead of a leaf.
//
//   ```csv-view
//   file: ../movies.csv      (sibling / ../ walked / vault-relative, like csv-add)
//   mode: table              (table | cards | kanban — default: table)
//   height: 480              (optional max content height in px)
//   ```
//
// Edits (inline cell edits, status chips, drag-free status changes via the
// row menu, the inline note editor, + Add, delete) write back to the source
// CSV via app.vault.modify, the same path the full view uses. Other open
// views of the same file (a .csv tab, or another csv-view block) re-sync off
// the vault `modify` event. See HANDOFF for the concurrency model.

import {
  App,
  TFile,
  Component,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownPostProcessorContext,
  Menu,
  Notice,
  normalizePath,
} from "obsidian";
import Papa from "papaparse";
import type { CardView } from "../main";
import { CSVRow, ViewMode, FileConfig, CardViewSettings } from "./types";
import { parseCSV, resolvePath, sanitizeFilename, showSelectPicker, IMAGE_COL_ALIASES } from "./utils";
import { AddEntryModal, NoteExpanderModal } from "./modals";
import { renderTable } from "./view/table";
import { renderLibrary } from "./view/library";
import { renderKanbanGenre, effectiveGroupCol } from "./view/kanban";

/** Modes the inline view offers. A subset of the full ViewMode union. */
type InlineMode = "table" | "library" | "kanban-genre";

const MODE_LABELS: { id: InlineMode; label: string }[] = [
  { id: "table", label: "Table" },
  { id: "library", label: "Cards" },
  { id: "kanban-genre", label: "Kanban" },
];

/**
 * Duck-typed TFile check — mirrors random-block.ts so the block is drivable
 * with a stub vault in the smoke tests (cross-bundle instanceof is unreliable).
 */
function asFile(f: unknown): TFile | null {
  return f && typeof f === "object" && "basename" in (f as object) ? (f as TFile) : null;
}

interface BlockOptions {
  file: string;
  mode: InlineMode;
  height: number | null;
  collapse: string[];   // group values collapsed by default in Cards view
}

/** Parse the `key: value` lines of a csv-view block. Forgiving, like csv-random. */
function parseBlockSource(source: string): BlockOptions {
  const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
  const opt = (key: string) =>
    lines.find(l => l.toLowerCase().startsWith(key + ":"))?.slice(key.length + 1).trim() ?? "";

  const rawMode = opt("mode").toLowerCase();
  const mode: InlineMode =
    rawMode === "kanban" || rawMode === "kanban-genre" ? "kanban-genre"
    : rawMode === "cards" || rawMode === "card" || rawMode === "library" ? "library"
    : "table";

  const heightRaw = parseInt(opt("height"), 10);
  return {
    file: opt("file"),
    mode,
    height: Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : null,
    collapse: opt("collapse").split(",").map(s => s.trim()).filter(Boolean),
  };
}

/**
 * Inline host for the CSV renderers. Tied to the markdown block's lifecycle
 * via MarkdownRenderChild (ctx.addChild → onunload on block teardown), which
 * also gives it registerEvent for the vault `modify` listener. It re-implements
 * the model/interaction surface CardView exposes — the renderers reach the same
 * members on either, so renderTable/renderLibrary/renderKanban work unchanged.
 */
export class InlineCardHost extends MarkdownRenderChild {
  app: App;
  settings: CardViewSettings;
  persistSettings: () => Promise<void>;
  file: TFile | null = null;
  private opts: BlockOptions;
  // Component for MarkdownRenderer.render (notes preview / expander markdown).
  // MarkdownRenderChild is itself a Component, so `this` works — kept as a
  // named field to read the same as CardView's renderComponent call sites.
  private get renderComponent(): Component { return this; }

  headers: string[] = [];
  rows: CSVRow[] = [];
  mode: ViewMode;
  searchQuery = "";
  tableSortCol: string | null = null;
  tableSortDir: "asc" | "desc" = "asc";
  libraryStatusFilter = "all";
  libraryGenreFilter = "all";
  // Group values (lowercased) collapsed by default in Cards view — from the
  // block's `collapse:` directive. Read by renderLibrary.
  collapsedGroups: Set<string> = new Set();

  private saveTimer: number | null = null;
  // Serialized form of our own last write. On a vault `modify` event we re-read
  // the file and skip the re-render when the content matches — that's how we
  // ignore our own saves (no focus-stealing mid-edit) while still re-syncing
  // when another view (a .csv tab, another block) changes the file.
  private lastWritten: string | null = null;
  private contentArea: HTMLElement | null = null;

  constructor(
    containerEl: HTMLElement,
    app: App,
    settings: CardViewSettings,
    persistSettings: () => Promise<void>,
    opts: BlockOptions,
  ) {
    super(containerEl);
    this.app = app;
    this.settings = settings;
    this.persistSettings = persistSettings;
    this.opts = opts;
    this.mode = opts.mode;
    this.collapsedGroups = new Set(opts.collapse.map(s => s.toLowerCase()));
  }

  // contentEl is the block root the renderers query for `.csv-content-area`
  // and pass to showSelectPicker. MarkdownRenderChild gives us containerEl.
  get contentEl(): HTMLElement { return this.containerEl; }

  // The renderers + effectiveGroupCol are typed against CardView. InlineCardHost
  // satisfies the duck-typed subset they actually reach (verified by the smoke
  // tests, which drive the same renderers with plain object literals), but it
  // isn't a structural CardView, so the cast is explicit and centralized here.
  private get asView(): CardView { return this as unknown as CardView; }

  async onload(): Promise<void> {
    this.containerEl.addClass("csv-inline-view");
    if (!this.opts.file) {
      this.renderError("No file specified. Use: file: yourfile.csv");
      return;
    }
    if (!(await this.reload())) return;
    this.renderView();

    // Re-sync when the source file changes underneath us (edited in a .csv
    // tab, another csv-view block, or external sync). Skip our own writes.
    this.registerEvent(this.app.vault.on("modify", async (f) => {
      if (!this.file || f.path !== this.file.path) return;
      const text = await this.app.vault.read(this.file);
      if (text === this.lastWritten) return; // our own save — already rendered
      const parsed = parseCSV(text);
      this.headers = parsed.headers;
      this.rows = parsed.rows;
      this.renderView();
    }));
    // A rename of the source file invalidates our cached handle.
    this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
      if (this.file && oldPath === this.file.path) this.file = asFile(f);
    }));
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
  }

  /** Read the source file (path already resolved at registration). Returns false (and renders an error) on failure. */
  private async reload(): Promise<boolean> {
    const file = asFile(this.app.vault.getAbstractFileByPath(this.opts.file));
    if (!file) {
      this.renderError(`File not found: ${this.opts.file}`);
      return false;
    }
    this.file = file;
    try {
      const parsed = parseCSV(await this.app.vault.read(file));
      this.headers = parsed.headers;
      this.rows = parsed.rows;
    } catch (e) {
      this.renderError(`Error reading file: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    return true;
  }

  private renderError(msg: string): void {
    this.containerEl.empty();
    this.containerEl.createEl("p", { text: `csv-view: ${msg}`, cls: "csv-add-error" });
  }

  // ── Save ─────────────────────────────────────────────────────────────────

  scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.doSave(), 600);
  }

  private async doSave(): Promise<void> {
    if (!this.file) return;
    try {
      const csv = Papa.unparse(this.rows, { columns: this.headers });
      this.lastWritten = csv; // suppress the echo `modify` event from re-rendering
      await this.app.vault.modify(this.file, csv);
    } catch (e) {
      new Notice(`Couldn't save ${this.file.name}: ${e instanceof Error ? e.message : String(e)}`, 8000);
    }
  }

  // ── Per-file config (shared with the full view via settings.fileConfigs) ───

  get fileCfg(): FileConfig {
    return this.file ? (this.settings.fileConfigs[this.file.path] ?? {}) : {};
  }
  saveFileCfg(cfg: FileConfig): void {
    if (!this.file) return;
    this.settings.fileConfigs[this.file.path] = cfg;
    void this.persistSettings();
  }

  // ── Column detection (mirrors CardView) ────────────────────────────────────

  resolveCol(candidates: string[]): string | null {
    for (const c of candidates) {
      const found = this.headers.find(h => h.toLowerCase() === c.toLowerCase());
      if (found) return found;
    }
    return null;
  }
  getNotesCol(): string | null {
    if (this.fileCfg.notesColumn) return this.fileCfg.notesColumn;
    return this.resolveCol([
      "Notes", "notes", "Note", "note", "Summary", "summary", "Review", "review",
      "Quote", "quote", "Quotes", "quotes", "Comment", "comment", "Comments", "comments",
      "Description", "description", "Annotation", "annotation",
    ]);
  }
  isNotesCol(h: string): boolean {
    const notesCol = this.getNotesCol();
    if (notesCol) return h === notesCol;
    return this.settings.notesColumns.some(n => n.toLowerCase() === h.toLowerCase());
  }
  isSelectCol(h: string): boolean {
    return this.settings.selectColumns.some(s => s.toLowerCase() === h.toLowerCase());
  }
  getStatusCol(): string | null {
    if (this.fileCfg.statusColumn) {
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.statusColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol([
      "Status", "status", "State", "state", "Progress", "progress", "Stage", "stage",
      "Read", "read", "Watched", "watched", "Seen", "seen", "Done", "done", "Completed", "completed",
    ]);
  }
  getCategoryCol(): string | null {
    if (this.fileCfg.categoryColumn) {
      return this.headers.find(h => h.toLowerCase() === this.fileCfg.categoryColumn!.toLowerCase()) ?? null;
    }
    return this.resolveCol([
      "Category", "category", "Categories", "categories", "Genre", "genre", "Genres", "genres",
      "Type", "type", "Types", "types", "Tag", "tag", "Tags", "tags",
      "Topic", "topic", "Topics", "topics", "Subject", "subject", "Section", "section",
    ]);
  }
  titleKey(): string | undefined {
    return this.resolveCol(["Title", "title", "Name", "name"]) ?? undefined;
  }
  authorKey(): string | undefined {
    return this.resolveCol([
      "Author", "author", "Authors", "authors", "Director", "director",
      "Artist", "artist", "Creator", "creator", "By", "by",
    ]) ?? undefined;
  }
  getTitle(row: CSVRow): string { const k = this.titleKey(); return (k ? row[k] : row[this.headers[0]]) ?? "—"; }
  getSubtitle(row: CSVRow): string { const k = this.authorKey(); return k ? row[k] ?? "" : ""; }
  getColumnValues(h: string): string[] {
    return Array.from(new Set(this.rows.map(r => r[h] ?? "").filter(Boolean))).sort();
  }
  getImageCol(): string | null {
    if (this.fileCfg.imageColumn) return this.headers.find(h => h.toLowerCase() === this.fileCfg.imageColumn!.toLowerCase()) ?? null;
    return this.resolveCol(IMAGE_COL_ALIASES);
  }
  // Habit/0-1 columns — configured list or auto-detected (all values 0/1/
  // true/false/yes/no/empty). Drives the add-form toggles.
  getBooleanColumns(): string[] {
    if (this.fileCfg.habitColumns?.length) return this.fileCfg.habitColumns.filter(h => this.headers.includes(h));
    const boolPatterns = ["0", "1", "true", "false", "yes", "no", ""];
    return this.headers.filter(h => {
      if (h === this.getDateCol() || this.isNotesCol(h)) return false;
      return this.rows.map(r => (r[h] ?? "").toLowerCase().trim()).every(v => boolPatterns.includes(v));
    });
  }
  getDateCol(): string | null {
    if (this.headers.length === 0) return null;
    const firstCol = this.headers[0];
    if (["date", "day", "datum"].includes(firstCol.toLowerCase())) return firstCol;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const sample = this.rows.slice(0, 5);
    if (sample.length > 0 && sample.every(r => datePattern.test(r[firstCol] ?? ""))) return firstCol;
    return null;
  }

  getFilteredRows(): CSVRow[] {
    let result = this.rows;
    if (this.searchQuery.trim()) {
      const query = this.searchQuery.toLowerCase().trim();
      result = result.filter(row => this.headers.some(h => (row[h] ?? "").toLowerCase().includes(query)));
    }
    if (this.mode === "table" && this.tableSortCol && this.headers.includes(this.tableSortCol)) {
      const col = this.tableSortCol, dir = this.tableSortDir;
      return [...result].sort((a, b) => {
        const cmp = (a[col] ?? "").localeCompare(b[col] ?? "", undefined, { numeric: true });
        return dir === "asc" ? cmp : -cmp;
      });
    }
    const dateCol = this.getDateCol();
    if (this.mode === "table" && dateCol) {
      const sortNewest = this.fileCfg.sortNewestFirst ?? true;
      result = [...result].sort((a, b) => {
        const cmp = (a[dateCol] ?? "").localeCompare(b[dateCol] ?? "");
        return sortNewest ? -cmp : cmp;
      });
    }
    return result;
  }

  // ── Notes sidecar files ─────────────────────────────────────────────────

  private notesFilePath(row: CSVRow): string {
    const title = sanitizeFilename(this.getTitle(row));
    const csvFolder = this.file?.parent?.path ?? "";
    const sub = this.settings.notesSubfolder.trim();
    const folder = sub ? (csvFolder ? `${csvFolder}/${sub}` : sub) : csvFolder;
    return normalizePath(`${folder}/${title}.md`);
  }
  notesFileExists(row: CSVRow): boolean {
    return !!this.app.vault.getAbstractFileByPath(this.notesFilePath(row));
  }
  async openOrCreateNotes(row: CSVRow): Promise<void> {
    const path = this.notesFilePath(row);
    let file = this.app.vault.getAbstractFileByPath(path) as TFile | null;
    if (!file) {
      const props = this.headers.filter(h => !this.isNotesCol(h) && row[h]).map(h => `${h}: "${row[h].replace(/"/g, '\\"')}"`);
      const fm = ["---", ...props, "---", "", `# ${this.getTitle(row)}`, "", ""].join("\n");
      const notesCol = this.headers.find(h => this.isNotesCol(h));
      const content = fm + (notesCol && row[notesCol]?.trim() ? row[notesCol] : "");
      const folderPath = path.substring(0, path.lastIndexOf("/"));
      if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath);
      file = await this.app.vault.create(path, content);
      new Notice(`Created: ${file.name}`);
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  // ── Row interactions (mirror CardView; render into this block) ─────────────

  deleteWithUndo(row: CSVRow): void {
    const idx = this.rows.indexOf(row);
    if (idx < 0) return;
    this.rows.splice(idx, 1);
    this.scheduleSave();
    this.renderView();
    const title = this.getTitle(row) || "entry";
    const frag = document.createDocumentFragment();
    frag.createSpan({ text: `Deleted “${title}”. ` });
    const undoBtn = frag.createEl("button", { text: "Undo", cls: "csv-notice-undo" });
    const notice = new Notice(frag, 6000);
    undoBtn.addEventListener("click", () => {
      if (undoBtn.hasAttribute("disabled")) return;
      undoBtn.setAttribute("disabled", "true");
      this.rows.splice(Math.min(idx, this.rows.length), 0, row);
      this.scheduleSave();
      this.renderView();
      notice.hide();
      new Notice(`Restored “${title}”`, 2500);
    });
  }

  openRowContextMenu(row: CSVRow, e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Open / Create Notes file").setIcon("file-text").onClick(() => void this.openOrCreateNotes(row)));
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
          menu.addItem(i => i.setTitle(`Mark as: ${s}`).onClick(() => { row[sc] = s; this.scheduleSave(); this.renderView(); }));
        });
      }
    }
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Delete").setIcon("trash").onClick(() => this.deleteWithUndo(row)));
    menu.showAtMouseEvent(e);
  }

  openNoteExpander(row: CSVRow, notesCol: string): void {
    new NoteExpanderModal(
      this.app, row, notesCol, this.headers, this.file?.path ?? "",
      this.isNotesCol.bind(this), this.isSelectCol.bind(this), this.getColumnValues.bind(this),
      (updatedRow) => { Object.assign(row, updatedRow); this.scheduleSave(); this.renderView(); },
      () => this.deleteWithUndo(row),
    ).open();
  }

  openAddModal(): void {
    new AddEntryModal(
      this.app, this.headers, this.isNotesCol.bind(this), this.isSelectCol.bind(this), this.getColumnValues.bind(this),
      (row) => {
        this.rows.push(row);
        this.scheduleSave();
        this.renderView();
        new Notice(`Added: ${this.getTitle(row)}`);
      },
      {},
      // Habit/0-1 columns render as toggles in the add form.
      (h) => this.getBooleanColumns().includes(h),
    ).open();
  }

  renderSelectField(container: HTMLElement, row: CSVRow, h: string): HTMLElement {
    const val = row[h] ?? "";
    const chip = container.createDiv({ cls: `csv-select-chip ${val ? "" : "empty"}` });
    chip.setText(val || "—");
    if (h.toLowerCase() === "status" && val) chip.addClass(`status-chip-${val.toLowerCase().replace(/\s+/g, "-")}`);
    chip.addEventListener("click", e => {
      e.stopPropagation();
      showSelectPicker(chip, row[h] ?? "", this.getColumnValues(h), (newVal) => {
        row[h] = newVal;
        chip.setText(newVal || "—");
        this.scheduleSave();
      }, this.contentEl);
    });
    return chip;
  }

  /** Render markdown text into an element, tied to this block's lifecycle. */
  renderMarkdownInto(el: HTMLElement, text: string): void {
    void MarkdownRenderer.render(this.app, text, el, this.file?.path ?? "", this.renderComponent);
  }

  // The full view debounces+preserves scroll across a leaf re-render; inline
  // blocks are short, so a plain re-render reads fine. Alias keeps the
  // renderers' `renderViewPreservingScroll()` calls working.
  renderViewPreservingScroll(): void { this.renderView(); }

  // ── Render ─────────────────────────────────────────────────────────────────

  renderView(contentOnly = false): void {
    const root = this.containerEl;
    if (!contentOnly) {
      root.empty();
      this.renderToolbar(root);
      this.contentArea = root.createDiv({ cls: "csv-content-area" });
      if (this.opts.height) this.contentArea.style.maxHeight = this.opts.height + "px";
    } else if (this.contentArea) {
      this.contentArea.empty();
    }
    const content = this.contentArea;
    if (!content) return;
    content.toggleClass("csv-content-area--no-yscroll", this.mode === "kanban-genre" || this.mode === "table");

    if (!this.headers.length) {
      content.createDiv({ cls: "csv-empty-state" }).createEl("p", { text: "This file is empty." });
      return;
    }
    if (this.rows.length === 0) {
      const wrap = content.createDiv({ cls: "csv-empty-state" });
      wrap.createEl("p", { text: "No entries yet." });
      wrap.createEl("button", { cls: "csv-empty-state-action", text: "+ Add the first entry" })
        .addEventListener("click", () => this.openAddModal());
      return;
    }
    // Cards/Kanban need a groupable column; fall back to table if there isn't one.
    if ((this.mode === "library" || this.mode === "kanban-genre") && !effectiveGroupCol(this.asView)) {
      this.mode = "table";
    }
    if (this.mode === "library") renderLibrary(this.asView, content);
    else if (this.mode === "kanban-genre") renderKanbanGenre(this.asView, content);
    else renderTable(this.asView, content);
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "csv-toolbar csv-inline-toolbar" });
    bar.createDiv({ cls: "csv-toolbar-title", text: this.file?.basename ?? "" })
      .addEventListener("click", () => { if (this.file) void this.app.workspace.getLeaf("tab").openFile(this.file); });
    const ctrl = bar.createDiv({ cls: "csv-toolbar-controls" });
    ctrl.createDiv({ cls: "csv-row-count", text: `${this.rows.length} entries` });

    // Mode segmented control. Cards/Kanban only when a groupable column exists.
    const groupable = !!effectiveGroupCol(this.asView);
    const mg = ctrl.createDiv({ cls: "csv-mode-group" });
    MODE_LABELS.forEach(({ id, label }) => {
      if ((id === "library" || id === "kanban-genre") && !groupable) return;
      const btn = mg.createEl("button", { cls: `csv-mode-btn ${this.mode === id ? "active" : ""}`, text: label });
      btn.addEventListener("click", () => { this.mode = id; this.renderView(); });
    });

    // Search.
    const searchInput = ctrl.createEl("input", {
      cls: "csv-search-input", type: "text", placeholder: "Search…", value: this.searchQuery,
      attr: { inputmode: "search", enterkeyhint: "search", autocomplete: "off" },
    });
    let debounce: number | null = null;
    searchInput.addEventListener("input", e => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      if (debounce !== null) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { debounce = null; this.renderView(true); }, 120);
    });

    ctrl.createEl("button", { cls: "csv-add-btn", text: "+ Add" }).addEventListener("click", () => this.openAddModal());
  }
}

/**
 * csv-view block processor. Each block gets its own host, tied to the block's
 * lifecycle via ctx.addChild (re-rendered/removed → host.onunload).
 */
export function registerCsvViewBlock(
  app: App,
  settings: CardViewSettings,
  persistSettings: () => Promise<void>,
  register: (lang: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void) => void,
): void {
  register("csv-view", (source, el, ctx) => {
    const opts = parseBlockSource(source);
    // Resolve the source file against the note that holds the block — captured
    // here from ctx, since the host only keeps the active-file folder as a
    // fallback. We pre-resolve by stashing the note folder on opts.file when
    // it's a bare/relative path so reload() resolves correctly.
    const noteFolder = app.vault.getAbstractFileByPath(ctx.sourcePath)?.parent?.path ?? "";
    const resolved = opts.file ? resolvePath(opts.file, noteFolder) : opts.file;
    const host = new InlineCardHost(el, app, settings, persistSettings, { ...opts, file: resolved });
    ctx.addChild(host);
  });
}
