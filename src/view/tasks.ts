// Tasks view renderer. A native, CSV-backed replacement for the old
// DataviewJS project-dashboard pattern (vault-wide tag scan → per-project
// task/note tables). Here the CSV *is* the source of truth: one row = one
// task/note/idea/reference, grouped by a project column, split into a Tasks
// section (sorted done → priority → due) plus one section per other type
// value (Idea, Note, Reference, …). Each row
// can spawn an optional backing .md page on demand (same infra the Library
// view uses). Extracted-style module: reached CardView members are public,
// type-only import → no runtime cycle. Covered by test-view-smoke.mjs.
//
// TODO (phase 2): cross-vault aggregate mode — pull task rows from many files
// into one board, the way the old dashboard scanned dv.pages('""'). The
// single-file model below is deliberate for phase 1.

import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { showSelectPicker, titleCase, localISODate } from "../utils";
import { effectiveGroupCol } from "./kanban";
import { makeEditable } from "./table";

// ── Column resolution ─────────────────────────────────────────────────────────

/** The column that distinguishes task / note / idea / reference rows. */
export function taskTypeCol(view: CardView): string | null {
  return view.resolveCol(["Type", "type", "Kind", "kind", "Item", "item"]);
}

/** Group column: an explicit project column, else the shared group fallback. */
export function taskProjectCol(view: CardView): string | null {
  return view.resolveCol(["Project", "project", "Projects", "projects", "Area", "area"])
    ?? effectiveGroupCol(view);
}

export function taskDueCol(view: CardView): string | null {
  return view.resolveCol(["Due", "due", "Deadline", "deadline", "Due Date", "Due date", "due date"]);
}

export function taskPriorityCol(view: CardView): string | null {
  return view.resolveCol(["Priority", "priority", "Prio", "prio", "Importance", "importance"]);
}

// Type values that count as actionable tasks (vs notes/ideas/references).
// Empty type also reads as a task — a row with a due/priority but no type is
// almost always a todo.
const TASK_WORDS = ["task", "todo", "to-do", "action", ""];
// Any type value that marks a row as task-manager content at all. Used by the
// availability gate so a movies file with a genre "Type" column doesn't get a
// spurious Tasks mode.
const STRUCTURED_WORDS = ["task", "todo", "to-do", "action", "note", "idea", "reference", "ref"];

// Status words that mean "this is finished" → struck through, sorted last.
// "1" included for parity with isTruthyVal (1/true/yes) — a Status column
// typed Checkbox writes "1"/"0", and files scaffolded by the old tasks
// template did exactly that.
const DONE_WORDS = ["done", "complete", "completed", "finished", "closed", "resolved", "yes", "x", "✓", "true", "1"];

const PRIORITY_ORDER: Record<string, number> = { high: 0, med: 1, medium: 1, normal: 1, low: 2 };

/**
 * Whether this file looks like a task manager. True when it has a due or
 * priority column, or a type column actually carrying task/note/idea values.
 * Drives availableModes and the onLoadFile mode guard.
 */
export function hasTaskColumns(view: CardView): boolean {
  if (taskDueCol(view) || taskPriorityCol(view)) return true;
  const tc = taskTypeCol(view);
  if (!tc) return false;
  return view.rows.some(r => STRUCTURED_WORDS.includes((r[tc] ?? "").trim().toLowerCase()));
}



function isDone(view: CardView, row: CSVRow, statusCol: string | null): boolean {
  if (!statusCol) return false;
  return DONE_WORDS.includes((row[statusCol] ?? "").trim().toLowerCase());
}

function priorityRank(val: string): number {
  const r = PRIORITY_ORDER[(val ?? "").trim().toLowerCase()];
  return r === undefined ? 3 : r;      // unprioritised sorts after low
}

function dueRank(val: string): number {
  // ISO-ish dates sort lexically; missing dates sort last.
  const s = (val ?? "").trim();
  return s ? 0 : 1;
}

// Today as YYYY-MM-DD (local — the UTC date is wrong near midnight), for
// overdue comparison.
function todayISO(): string {
  return localISODate();
}

// The word the done-toggle writes when checking a row. Respect the file's
// existing vocabulary — if rows already use "Completed" or "Finished", reuse
// the most common one rather than forcing a second spelling ("done") into the
// column. Falls back to "done" for a file with no finished rows yet.
function resolveDoneWord(view: CardView, statusCol: string): string {
  const counts = new Map<string, number>();
  view.rows.forEach(r => {
    const v = (r[statusCol] ?? "").trim();
    if (v && DONE_WORDS.includes(v.toLowerCase())) counts.set(v, (counts.get(v) ?? 0) + 1);
  });
  let best = "done", bestN = 0;
  counts.forEach((n, v) => { if (n > bestN) { best = v; bestN = n; } });
  return best;
}

// ── Renderer ──────────────────────────────────────────────────────────────────

export function renderTasks(view: CardView, container: HTMLElement): void {
  const projectCol = taskProjectCol(view);
  const typeCol = taskTypeCol(view);
  const statusCol = view.getStatusCol();
  const dueCol = taskDueCol(view);
  const priCol = taskPriorityCol(view);
  const titleCol = view.titleKey() ?? view.headers[0];

  // ── Filters bar (project + type + done/open), mirrors the Library filter pattern ──
  const filtersBar = container.createDiv({ cls: "csv-library-filters" });

  const projects = new Set<string>();
  if (projectCol) view.rows.forEach(r => {
    (r[projectCol] ?? "").split(",").map(s => s.trim()).filter(Boolean).forEach(p => projects.add(p));
  });
  const projectSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
  projectSelect.createEl("option", { text: projectCol ? "All projects" : "All", value: "all" });
  Array.from(projects).sort().forEach(p => projectSelect.createEl("option", { text: p, value: p }));
  projectSelect.value = view.taskProjectFilter;

  const types = new Set<string>();
  if (typeCol) view.rows.forEach(r => { const t = (r[typeCol] ?? "").trim(); if (t) types.add(t); });
  let typeSelect: HTMLSelectElement | null = null;
  if (types.size > 0) {
    typeSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
    typeSelect.createEl("option", { text: "All types", value: "all" });
    Array.from(types).sort().forEach(t => typeSelect!.createEl("option", { text: t, value: t }));
    typeSelect.value = view.taskTypeFilter;
  }

  // Done/open filter — only offered when there's a status column to read.
  let statusSelect: HTMLSelectElement | null = null;
  if (statusCol) {
    statusSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
    statusSelect.createEl("option", { text: "All", value: "all" });
    statusSelect.createEl("option", { text: "○ open", value: "__open__" });
    statusSelect.createEl("option", { text: "✓ done", value: "__done__" });
    statusSelect.value = view.taskStatusFilter;
  }

  const applyFilters = () => {
    view.taskProjectFilter = projectSelect.value;
    if (typeSelect) view.taskTypeFilter = typeSelect.value;
    if (statusSelect) view.taskStatusFilter = statusSelect.value;
    view.renderView(true);
  };
  projectSelect.addEventListener("change", applyFilters);
  typeSelect?.addEventListener("change", applyFilters);
  statusSelect?.addEventListener("change", applyFilters);

  // ── Filter rows (project / type / status / toolbar search) ──
  const q = view.searchQuery.toLowerCase().trim();
  const filtered = view.rows.filter(row => {
    if (view.taskProjectFilter !== "all" && projectCol) {
      const ps = (row[projectCol] ?? "").split(",").map(s => s.trim().toLowerCase());
      if (!ps.includes(view.taskProjectFilter.toLowerCase())) return false;
    }
    if (view.taskTypeFilter !== "all" && typeCol) {
      if ((row[typeCol] ?? "").trim().toLowerCase() !== view.taskTypeFilter.toLowerCase()) return false;
    }
    if (view.taskStatusFilter !== "all" && statusCol) {
      const done = isDone(view, row, statusCol);
      if (view.taskStatusFilter === "__done__" && !done) return false;
      if (view.taskStatusFilter === "__open__" && done) return false;
    }
    if (q && !view.headers.some(h => (row[h] ?? "").toLowerCase().includes(q))) return false;
    return true;
  });

  if (view.taskProjectFilter !== "all" || view.taskTypeFilter !== "all" || view.taskStatusFilter !== "all" || q) {
    container.createDiv({ cls: "csv-library-result-count", text: `Showing ${filtered.length} of ${view.rows.length} entries` });
  }

  // ── Split into sections based on Type, each grouped by project ──
  const buckets: Record<string, Record<string, CSVRow[]>> = {};
  const projectOf = (row: CSVRow): string => {
    if (!projectCol) return "—";
    const p = (row[projectCol] ?? "").split(",").map(s => s.trim()).filter(Boolean)[0];
    return p || "—";
  };
  filtered.forEach(row => {
    const t = typeCol ? (row[typeCol] ?? "").trim() : "";
    // Task-like values (task/todo/action — and empty, see TASK_WORDS) all
    // land in one pinned "Tasks" bucket; every other type value gets its own
    // section keyed by the raw value ("idea", "reference", …).
    const bucketName = TASK_WORDS.includes(t.toLowerCase()) ? "Tasks" : t;
    const proj = projectOf(row);
    if (!buckets[bucketName]) buckets[bucketName] = {};
    (buckets[bucketName][proj] ??= []).push(row);
  });

  const wrap = container.createDiv({ cls: "csv-tasks" });
  const today = todayISO();
  const doneWord = statusCol ? resolveDoneWord(view, statusCol) : "done";

  const visibleCols = view.fileCfg.cardFields ?? view.headers;
  // Skip the grouping columns themselves from being rendered as standard columns,
  // and skip the status column since it is always rendered as the interactive checkmark.
  const displayCols = visibleCols.filter(h => h !== projectCol && h !== typeCol && h !== statusCol);

  const headersList: { name: string, cls: string }[] = [];
  if (statusCol) headersList.push({ name: "", cls: "csv-tasks-check-cell" });
  displayCols.forEach(h => {
    let cls = "";
    if (h === titleCol) cls = "csv-tasks-name-cell";
    else if (h === dueCol) cls = "csv-tasks-due";
    else if (h === priCol) cls = "csv-tasks-priority";
    else if (view.isNotesCol(h)) cls = "csv-tasks-generic-cell csv-tasks-notes-cell";
    else cls = "csv-tasks-generic-cell";
    headersList.push({ name: h, cls });
  });

  // ── Render each section ──
  const fillSection = (tbody: HTMLElement, items: CSVRow[]) => {
    items.sort((a, b) => {
      const da = isDone(view, a, statusCol), db = isDone(view, b, statusCol);
      if (da !== db) return da ? 1 : -1;
      if (priCol) {
        const pr = priorityRank(a[priCol] ?? "") - priorityRank(b[priCol] ?? "");
        if (pr) return pr;
      }
      if (dueCol) {
        const dr = dueRank(a[dueCol] ?? "") - dueRank(b[dueCol] ?? "");
        if (dr) return dr;
        const dc = (a[dueCol] ?? "").localeCompare(b[dueCol] ?? "");
        if (dc) return dc;
      }
      return view.getTitle(a).localeCompare(view.getTitle(b));
    });
    items.forEach(row => {
      const done = isDone(view, row, statusCol);
      const tr = tbody.createEl("tr");

      // Done toggle (only when there's a status column to flip).
      if (statusCol) {
        const checkCell = tr.createEl("td", { cls: "csv-tasks-check-cell" });
        const box = checkCell.createSpan({ cls: `csv-tasks-check ${done ? "is-done" : ""}`, text: done ? "✓" : "" });
        box.setAttr("title", done ? "Mark not done" : "Mark done");
        box.addEventListener("click", e => {
          e.stopPropagation();
          row[statusCol] = done ? "" : doneWord;
          view.scheduleSave();
          view.renderView(true);
        });
      }

      displayCols.forEach(h => {
        if (h === titleCol) {
          renderNameCell(view, tr, row, titleCol, done);
        } else if (h === dueCol) {
          const dueCell = tr.createEl("td", { cls: "csv-tasks-due csv-tasks-editable" });
          const dueVal = dueCol ? (row[dueCol] ?? "").slice(0, 10) : "";
          dueCell.setText(dueVal || "—");
          if (dueVal && !done && dueVal < today) dueCell.addClass("csv-tasks-overdue");
          makeEditable(view, dueCell, row, h);
        } else if (h === priCol) {
          const priCell = tr.createEl("td", { cls: "csv-tasks-priority csv-tasks-editable", text: priCol ? (row[priCol] || "—") : "—" });
          priCell.addEventListener("click", e => {
            e.stopPropagation();
            const opts = Array.from(new Set([...view.getColumnValues(priCol), "high", "medium", "low"]));
            showSelectPicker(priCell, row[priCol] ?? "", opts, val => {
              row[priCol] = val;
              view.scheduleSave();
              view.renderView(true);
            }, view.contentEl);
          });
        } else if (view.isNotesCol(h)) {
          const plain = (row[h] ?? "").replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").replace(/\n+/g," ").trim();
          const display = plain ? (plain.length > 50 ? plain.slice(0, 48) + "…" : plain) : "—";
          const td = tr.createEl("td", { text: display, cls: "csv-tasks-generic-cell csv-tasks-notes-cell csv-tasks-editable" });
          makeEditable(view, td, row, h);
        } else {
          const val = row[h] ?? "";
          const display = val.length > 40 ? val.slice(0, 38) + "…" : val;
          const td = tr.createEl("td", { text: display || "—", cls: "csv-tasks-generic-cell csv-tasks-editable" });
          makeEditable(view, td, row, h);
        }
      });
      tr.addEventListener("contextmenu", e => view.openRowContextMenu(row, e));
    });
  };

  const typesArray = Object.keys(buckets).sort((a, b) => {
    // Actionable tasks always come first; other type sections alphabetical.
    if (a === "Tasks") return -1;
    if (b === "Tasks") return 1;
    return a.localeCompare(b);
  });

  typesArray.forEach(t => {
    renderSection(view, wrap, t === "Tasks" ? t : titleCase(t), buckets[t], fillSection, headersList);
  });

  const hasActiveFilters = q || view.taskProjectFilter !== "all" || view.taskTypeFilter !== "all" || view.taskStatusFilter !== "all";
  if (typesArray.length === 0) {
    const empty = wrap.createDiv({ cls: "csv-empty-state" });
    empty.createEl("p", { text: hasActiveFilters ? "No entries match your filters." : "No tasks yet." });
    if (hasActiveFilters) {
      empty.createEl("button", { cls: "csv-clear-filters-btn", text: "Clear filters" }).addEventListener("click", () => {
        view.taskProjectFilter = "all"; view.taskTypeFilter = "all"; view.taskStatusFilter = "all"; view.searchQuery = "";
        view.renderView();
      });
    }
  }
}

// A titled group of per-project collapsible tables.
function renderSection(
  view: CardView,
  wrap: HTMLElement,
  title: string,
  byProject: Record<string, CSVRow[]>,
  fillBody: (tbody: HTMLElement, items: CSVRow[]) => void,
  cols: { name: string, cls: string }[],
): void {
  if (Object.keys(byProject).length === 0) return;
  wrap.createDiv({ cls: "csv-tasks-section-header", text: title });
  const section = wrap.createDiv({ cls: "csv-tasks-section" });
  Object.keys(byProject).sort().forEach(project => {
    const items = byProject[project];
    const details = section.createEl("details", { cls: "csv-tasks-group" });
    details.open = true;
    const summary = details.createEl("summary", { cls: "csv-tasks-group-header" });
    summary.createSpan({ cls: "csv-tasks-arrow", text: "▶" });
    summary.createSpan({ text: ` ${project} ` });
    summary.createSpan({ cls: "csv-tasks-count", text: String(items.length) });
    const wrapper = details.createDiv({ cls: "csv-tasks-table-wrapper" });
    const table = wrapper.createEl("table", { cls: "csv-tasks-table" });
    
    let minTableWidth = 120; // Guaranteed space for Name/Title column
    cols.forEach(col => {
      if (col.cls.includes("check-cell")) minTableWidth += 30;
      else if (col.cls.includes("priority")) minTableWidth += 90;
      else if (col.cls.includes("due")) minTableWidth += 150;
      else if (col.cls.includes("notes-cell")) minTableWidth += 140;
      else if (col.cls.includes("generic-cell")) minTableWidth += 150;
    });
    table.style.minWidth = `${minTableWidth}px`;
    
    const thead = table.createEl("thead");
    const tr = thead.createEl("tr");
    cols.forEach(col => tr.createEl("th", { text: col.name, cls: col.cls }));
    const tbody = table.createEl("tbody");
    fillBody(tbody, items);
  });
}

// Name cell: clicking the title opens the entry overview (the expander modal,
// same as tapping a kanban card title) — a quick read/edit without spawning a
// file. A separate small page icon (📄 if the backing .md exists, + to create)
// is the only thing that touches the filesystem — the "optional pages" model
// the Library view established.
function renderNameCell(view: CardView, tr: HTMLElement, row: CSVRow, titleCol: string, done: boolean): void {
  const nameCell = tr.createEl("td", { cls: "csv-tasks-name-cell" });
  const highlightCls = view.isHighlighted?.(row) ? "csv-title-highlight" : "";
  const link = nameCell.createSpan({ cls: `csv-tasks-link ${done ? "csv-tasks-done" : ""} ${highlightCls}`, text: row[titleCol] || "Untitled" });
  const notesCol = view.getNotesCol();
  link.addEventListener("click", () => {
    // Expander needs a notes column to host its body editor; if the file has
    // none, the page is the only place to write prose, so open/create that.
    if (notesCol) view.openNoteExpander(row, notesCol);
    else void view.openOrCreateNotes(row);
  });
  const exists = view.notesFileExists(row);
  const icon = nameCell.createEl("button", { cls: `csv-tasks-page-icon ${exists ? "exists" : ""}`, text: exists ? "📄" : "+" });
  icon.setAttr("title", exists ? "Open page" : "Create page");
  icon.addEventListener("click", e => { e.stopPropagation(); void view.openOrCreateNotes(row); });
}
