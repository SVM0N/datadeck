// ─── csv-tasks code block: a cross-file tasks board ──────────────────────────
//
// The phase-2 replacement for the old vault-wide DataviewJS project dashboard:
// merge task rows from many CSVs into one board, rendered with the same
// renderTasks the full-page Tasks view uses.
//
//   ```csv-tasks
//   folder: Projects        (scan the folder recursively for task-shaped CSVs;
//                            "/" scans the whole vault)
//   files: a.csv, ../b.csv  (and/or an explicit list — sibling / ../ walked /
//                            vault-relative, like csv-view. Explicit files skip
//                            the task-shape check.)
//   height: 600             (optional max content height in px)
//   ```
//
// Each file's columns are mapped onto one canonical set (Title/Type/Project/
// Priority/Due/Status/Notes); a file without a Project column contributes its
// basename as the project, so "one CSV per project" folders Just Work. Edits
// (done toggles, inline cells, the expander) write back to the row's source
// file — with the same sync-conflict stash the single-file views use — and
// the board re-syncs when any source file changes externally.

import { App, Menu, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile, normalizePath } from "obsidian";
import Papa from "papaparse";
import type { CardView } from "../main";
import { CSVRow, CardViewSettings } from "./types";
import { parseCSV, resolvePath, sanitizeFilename, stashSyncConflict, TITLE_COL_ALIASES, NOTES_COL_ALIASES, assumeShape } from "./utils";
import { NoteExpanderModal } from "./modals";
import { renderTasks, hasTaskColumns } from "./view/tasks";

// Canonical board columns, in render order.
const CANON = ["Title", "Type", "Project", "Priority", "Due", "Status", "Notes"] as const;
type CanonCol = typeof CANON[number];

// Per-canonical-column source aliases (first header match wins, like resolveCol).
const CANON_ALIASES: Record<CanonCol, string[]> = {
  Title: TITLE_COL_ALIASES,
  Type: ["Type", "type", "Kind", "kind", "Item", "item"],
  Project: ["Project", "project", "Projects", "projects", "Area", "area"],
  Priority: ["Priority", "priority", "Prio", "prio", "Importance", "importance"],
  Due: ["Due", "due", "Deadline", "deadline", "Due Date", "Due date", "due date"],
  Status: ["Status", "status", "State", "state", "Done", "done"],
  Notes: NOTES_COL_ALIASES,
};

export interface AggSource {
  basename: string;
  headers: string[];
  rows: CSVRow[];
}

export interface AggRowRef {
  sourceIndex: number;      // into the AggSource[] the aggregate was built from
  srcRow: CSVRow;           // the live source row — write-through target
  map: Partial<Record<CanonCol, string>>; // canonical col → source header
}

export interface Aggregate {
  headers: string[];        // CANON
  rows: CSVRow[];           // canonical rows, aligned with refs
  refs: AggRowRef[];
}

/** Header-name resolution per source file: canonical col → its column, if any. */
function mapColumns(headers: string[]): Partial<Record<CanonCol, string>> {
  const map: Partial<Record<CanonCol, string>> = {};
  for (const canon of CANON) {
    for (const alias of CANON_ALIASES[canon]) {
      const hit = headers.find(h => h.toLowerCase() === alias.toLowerCase());
      if (hit) { map[canon] = hit; break; }
    }
  }
  // A file whose first column is unmatched free text still needs a Title.
  if (!map.Title && headers.length) map.Title = headers[0];
  return map;
}

/**
 * Merge many parsed CSVs into one canonical board model. Pure — no vault, no
 * DOM — so it's unit-testable. Files without a Project column contribute
 * their basename as every row's project.
 */
export function buildAggregate(sources: AggSource[]): Aggregate {
  const rows: CSVRow[] = [];
  const refs: AggRowRef[] = [];
  sources.forEach((src, sourceIndex) => {
    const map = mapColumns(src.headers);
    src.rows.forEach(srcRow => {
      const canon: CSVRow = {};
      for (const col of CANON) {
        canon[col] = map[col] ? (srcRow[map[col]] ?? "") : "";
      }
      if (!map.Project) canon.Project = src.basename;
      rows.push(canon);
      refs.push({ sourceIndex, srcRow, map });
    });
  });
  return { headers: [...CANON], rows, refs };
}

/** Copy a canonical row's mapped values back onto its source row. */
export function writeBack(canon: CSVRow, ref: AggRowRef): void {
  for (const col of CANON) {
    const srcCol = ref.map[col];
    if (srcCol) ref.srcRow[srcCol] = canon[col] ?? "";
  }
}

// ── Block options ────────────────────────────────────────────────────────────

interface TasksBlockOptions { folder: string; files: string[]; height: number | null; }

function parseBlockSource(source: string): TasksBlockOptions {
  const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
  const opt = (key: string) =>
    lines.find(l => l.toLowerCase().startsWith(key + ":"))?.slice(key.length + 1).trim() ?? "";
  const heightRaw = parseInt(opt("height"), 10);
  return {
    folder: opt("folder"),
    files: opt("files").split(",").map(s => s.trim()).filter(Boolean),
    height: Number.isFinite(heightRaw) && heightRaw > 0 ? heightRaw : null,
  };
}

/** `instanceof TFile` fast path, falling back to duck-typing for stub-vault smoke tests (cross-bundle instanceof identity breaks there). */
function asFile(f: unknown): TFile | null {
  if (f instanceof TFile) return f;
  return f && typeof f === "object" && "basename" in (f) ? assumeShape<TFile>(f) : null;
}

// ── The block host ───────────────────────────────────────────────────────────

interface LoadedSource {
  file: TFile;
  headers: string[];
  rows: CSVRow[];
  lastText: string;   // sync anchor for the conflict stash + echo suppression
}

class TasksBlockHost extends MarkdownRenderChild {
  // Duck-typed surface renderTasks reaches (same trick as InlineCardHost).
  headers: string[] = [];
  rows: CSVRow[] = [];
  searchQuery = "";
  taskProjectFilter = "all";
  taskTypeFilter = "all";
  taskStatusFilter = "all";
  fileCfg: Record<string, never> = {};

  private sources: LoadedSource[] = [];
  private refs: AggRowRef[] = [];
  private saveTimer: number | null = null;
  private contentArea: HTMLElement | null = null;

  constructor(
    containerEl: HTMLElement,
    private app: App,
    private settings: CardViewSettings,
    private opts: TasksBlockOptions,
    private notePath: string,
  ) {
    super(containerEl);
  }

  get contentEl(): HTMLElement { return this.containerEl; }
  private get asView(): CardView { return this as unknown as CardView; }

  onload(): void {
    this.containerEl.addClass("csv-inline-view", "csv-tasks-block");
    if (!this.opts.folder && !this.opts.files.length) {
      this.renderError(`Give a "folder:" line ("/" = whole vault) and/or a "files:" list.`);
      return;
    }
    void (async () => {
      await this.reload();
      this.renderView();

      // Re-sync when any source CSV changes underneath us; skip our own saves
      // (text equality) and mid-edit states (doSave reconciles those).
      this.registerEvent(this.app.vault.on("modify", async (f) => {
        const src = this.sources.find(s => s.file.path === f.path);
        if (!src || this.saveTimer) return;
        const text = await this.app.vault.read(src.file);
        if (text === src.lastText) return;
        src.lastText = text;
        const parsed = parseCSV(text);
        src.headers = parsed.headers;
        src.rows = parsed.rows;
        this.rebuild();
        this.renderView();
      }));
    })();
  }

  onunload(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
  }

  private renderError(msg: string): void {
    this.containerEl.empty();
    this.containerEl.createEl("p", { text: `csv-tasks: ${msg}`, cls: "csv-add-error" });
  }

  // ── Source discovery + load ────────────────────────────────────────────────

  private async reload(): Promise<void> {
    const noteFolder = this.app.vault.getAbstractFileByPath(this.notePath)?.parent?.path ?? "";
    const picked = new Map<string, { file: TFile; explicit: boolean }>();

    for (const raw of this.opts.files) {
      const file = asFile(this.app.vault.getAbstractFileByPath(resolvePath(raw, noteFolder)));
      if (!file) { this.renderError(`File not found: ${raw}`); continue; }
      picked.set(file.path, { file, explicit: true });
    }
    if (this.opts.folder) {
      const prefix = this.opts.folder === "/" ? "" : this.opts.folder.replace(/\/$/, "") + "/";
      for (const file of this.app.vault.getFiles()) {
        if (file.extension !== "csv") continue;
        if (prefix && !file.path.startsWith(prefix)) continue;
        if (!picked.has(file.path)) picked.set(file.path, { file, explicit: false });
      }
    }

    this.sources = [];
    for (const { file, explicit } of picked.values()) {
      try {
        const text = await this.app.vault.read(file);
        const { headers, rows } = parseCSV(text);
        // Folder scans keep only task-shaped files (a movies CSV with a
        // genre "Type" column must not flood the board); explicit files
        // are the user's call.
        const shaped = explicit || hasTaskColumns({
          headers, rows,
          resolveCol: (cands: string[]) => cands.map(c => headers.find(h => h.toLowerCase() === c.toLowerCase())).find(Boolean) ?? null,
        } as unknown as CardView);
        if (shaped) this.sources.push({ file, headers, rows, lastText: text });
      } catch { /* unreadable file — skip it rather than sink the board */ }
    }
    this.rebuild();
  }

  private rebuild(): void {
    const agg = buildAggregate(this.sources.map(s => ({ basename: s.file.basename, headers: s.headers, rows: s.rows })));
    this.headers = agg.headers;
    this.rows = agg.rows;
    this.refs = agg.refs;
  }

  private refOf(canon: CSVRow): AggRowRef | null {
    const idx = this.rows.indexOf(canon);
    return idx >= 0 ? this.refs[idx] : null;
  }

  private sourceOf(canon: CSVRow): LoadedSource | null {
    const ref = this.refOf(canon);
    return ref ? this.sources[ref.sourceIndex] ?? null : null;
  }

  // ── Save (write-through to each source file) ───────────────────────────────

  scheduleSave(): void {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.doSave(), 600);
  }

  private async doSave(): Promise<void> {
    this.saveTimer = null;
    // Propagate every canonical row back onto its source row, then write
    // only the files whose serialized text actually changed.
    this.rows.forEach((canon, i) => writeBack(canon, this.refs[i]));
    for (const src of this.sources) {
      const csv = Papa.unparse(src.rows, { columns: src.headers });
      if (csv === src.lastText) continue;
      try {
        try {
          const onDisk = await this.app.vault.read(src.file);
          if (onDisk !== src.lastText && onDisk !== csv) {
            await stashSyncConflict(this.app, src.file, onDisk);
          }
        } catch { /* unreadable — proceed */ }
        src.lastText = csv;
        await this.app.vault.modify(src.file, csv);
      } catch (e) {
        new Notice(`Couldn't save ${src.file.name}: ${e instanceof Error ? e.message : String(e)}`, 8000);
      }
    }
  }

  // ── renderTasks' duck-typed surface ────────────────────────────────────────

  resolveCol(candidates: string[]): string | null {
    for (const c of candidates) {
      const found = this.headers.find(h => h.toLowerCase() === c.toLowerCase());
      if (found) return found;
    }
    return null;
  }
  titleKey(): string | undefined { return "Title"; }
  getStatusCol(): string | null { return "Status"; }
  getCategoryCol(): string | null { return null; }
  getDateCol(): string | null { return null; }
  getNotesCol(): string | null { return "Notes"; }
  isNotesCol(h: string): boolean { return h === "Notes"; }
  isDateCol(h: string): boolean { return h === "Due"; }
  getTitle(row: CSVRow): string { return row.Title || "—"; }
  getColumnValues(h: string): string[] {
    return Array.from(new Set(this.rows.map(r => r[h] ?? "").filter(Boolean))).sort();
  }

  renderViewPreservingScroll(): void { this.renderView(); }

  renderView(contentOnly = false): void {
    const root = this.containerEl;
    if (!contentOnly) {
      root.empty();
      const bar = root.createDiv({ cls: "csv-toolbar csv-inline-toolbar" });
      bar.createDiv({ cls: "csv-toolbar-title", text: "Tasks" });
      bar.createDiv({ cls: "csv-row-count", text: `${this.rows.length} entries · ${this.sources.length} file${this.sources.length === 1 ? "" : "s"}` });
      this.contentArea = root.createDiv({ cls: "csv-content-area" });
      if (this.opts.height) this.contentArea.style.maxHeight = this.opts.height + "px";
    } else if (this.contentArea) {
      this.contentArea.empty();
    }
    if (!this.contentArea) return;
    if (!this.sources.length) {
      this.contentArea.createEl("p", { text: "No task-shaped CSV files found.", cls: "csv-empty-state" });
      return;
    }
    renderTasks(this.asView, this.contentArea);
  }

  // ── Row interactions (per-row source-file context) ─────────────────────────

  openNoteExpander(canon: CSVRow, _notesCol: string): void {
    const ref = this.refOf(canon);
    const src = this.sourceOf(canon);
    if (!ref || !src) return;
    const srcNotesCol = ref.map.Notes ?? "";
    const isSrcNotes = (h: string) => h === ref.map.Notes;
    new NoteExpanderModal(
      this.app, ref.srcRow, srcNotesCol, src.headers, src.file.path,
      isSrcNotes,
      () => false,
      (h) => Array.from(new Set(src.rows.map(r => r[h] ?? "").filter(Boolean))).sort(),
      (updated) => {
        Object.assign(ref.srcRow, updated);
        // Re-derive the canonical row from the source so the board reflects
        // the edit immediately (writeBack goes the other way on save).
        for (const col of Object.keys(canon)) {
          const srcCol = ref.map[col as CanonCol];
          if (srcCol) canon[col] = ref.srcRow[srcCol] ?? "";
        }
        this.scheduleSave();
        this.renderView();
      },
      () => this.deleteRow(canon),
      undefined,
      ref.map.Title,
      undefined,
      (h) => /(^|[_\s-])(date|due|deadline)([_\s-]|$)/i.test(h),
    ).open();
  }

  async openOrCreateNotes(canon: CSVRow): Promise<void> {
    const src = this.sourceOf(canon);
    if (!src) return;
    const path = this.notesFilePath(canon, src);
    let file = asFile(this.app.vault.getAbstractFileByPath(path));
    if (!file) {
      const fm = ["---", `source: "[[${src.file.path}]]"`, "---", "", `# ${this.getTitle(canon)}`, "", ""].join("\n");
      const folderPath = path.substring(0, path.lastIndexOf("/"));
      if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) await this.app.vault.createFolder(folderPath);
      file = await this.app.vault.create(path, fm);
      new Notice(`Created: ${file.name}`);
    }
    await this.app.workspace.getLeaf("tab").openFile(file);
  }

  notesFileExists(canon: CSVRow): boolean {
    const src = this.sourceOf(canon);
    return !!src && !!this.app.vault.getAbstractFileByPath(this.notesFilePath(canon, src));
  }

  private notesFilePath(canon: CSVRow, src: LoadedSource): string {
    const title = sanitizeFilename(this.getTitle(canon));
    const csvFolder = src.file.parent?.path ?? "";
    const sub = this.settings.notesSubfolder.trim();
    const folder = sub ? (csvFolder ? `${csvFolder}/${sub}` : sub) : csvFolder;
    return normalizePath(`${folder}/${title}.md`);
  }

  private deleteRow(canon: CSVRow): void {
    const ref = this.refOf(canon);
    const src = this.sourceOf(canon);
    if (!ref || !src) return;
    const srcIdx = src.rows.indexOf(ref.srcRow);
    if (srcIdx >= 0) src.rows.splice(srcIdx, 1);
    const idx = this.rows.indexOf(canon);
    if (idx >= 0) { this.rows.splice(idx, 1); this.refs.splice(idx, 1); }
    this.scheduleSave();
    this.renderView();
    new Notice(`Deleted “${this.getTitle(canon)}” from ${src.file.name}`);
  }

  openRowContextMenu(canon: CSVRow, e: MouseEvent): void {
    const src = this.sourceOf(canon);
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Open entry").setIcon("maximize").onClick(() => this.openNoteExpander(canon, "Notes")));
    if (src) {
      menu.addItem(i => i.setTitle(`Open source: ${src.file.name}`).setIcon("file-spreadsheet")
        .onClick(() => void this.app.workspace.getLeaf("tab").openFile(src.file)));
    }
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Delete").setIcon("trash").onClick(() => this.deleteRow(canon)));
    menu.showAtMouseEvent(e);
  }
}

/** csv-tasks block processor. Each block gets its own host tied to the block lifecycle. */
export function registerCsvTasksBlock(
  app: App,
  settings: CardViewSettings,
  register: (lang: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void) => void,
): void {
  register("csv-tasks", (source, el, ctx) => {
    ctx.addChild(new TasksBlockHost(el, app, settings, parseBlockSource(source), ctx.sourcePath));
  });
}
