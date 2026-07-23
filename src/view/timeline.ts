// Timeline view renderer. A Gantt-lite horizontal timeline: one row per
// entry, each drawn as an arrow spanning its Start → End/Due dates against a
// shared time axis. Rows with no end date read as "ongoing" and stretch to
// today. Extracted-style module: reached CardView members are public,
// type-only import → no runtime cycle. Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { localISODate } from "../utils";
import { effectiveGroupCol } from "./kanban";

const START_ALIASES = ["Start", "start", "Start Date", "start date", "Begin", "begin", "From", "from"];
const END_ALIASES = ["End", "end", "End Date", "end date", "Finish", "finish", "To", "to", "Due", "due", "Deadline", "deadline"];

export function timelineStartCol(view: CardView): string | null {
  return view.resolveCol(START_ALIASES);
}

export function timelineEndCol(view: CardView): string | null {
  return view.resolveCol(END_ALIASES);
}

/** Timeline needs a distinct start *and* end/due column to plot a span. */
export function hasTimelineColumns(view: CardView): boolean {
  const s = timelineStartCol(view), e = timelineEndCol(view);
  return !!s && !!e && s !== e;
}

const DAY_MS = 86400000;

// Date-only string ("2024-03-01" — a longer ISO timestamp is tolerated by
// taking just the first 10 chars) parsed at noon UTC so it never rolls to
// the adjacent day depending on the reader's timezone. Same convention the
// travel view uses for date_entered/date_left.
function parseDateMs(raw: string): number | null {
  const s = (raw ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T12:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

// Small categorical palette for the group/category color-coding — same
// values the travel-view timeline cycles through.
const PALETTE = ["#4e79a7", "#59a14f", "#e15759", "#b07aa1", "#76b7b2", "#ff9da7", "#edc948", "#a0855b"];
function makeColorer(): (key: string) => string {
  const m = new Map<string, string>();
  let i = 0;
  return (key) => { if (!m.has(key)) m.set(key, PALETTE[i++ % PALETTE.length]); return m.get(key)!; };
}

export interface TimelineTick { ms: number; label: string; }

/**
 * Axis gridlines across [domainStart, domainEnd]: month-start marks for
 * spans up to 3 years, else year-start marks — kept to two tiers so the
 * axis never gets crowded on a decades-long log or a two-week sprint alike.
 * Pure + exported for unit testing.
 */
export function buildTimelineTicks(domainStart: number, domainEnd: number): TimelineTick[] {
  if (domainEnd <= domainStart) return [];
  const spanDays = (domainEnd - domainStart) / DAY_MS;
  const yearly = spanDays > 3 * 365;
  const first = new Date(domainStart);
  let cursor = yearly
    ? Date.UTC(first.getUTCFullYear(), 0, 1, 12)
    : Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1, 12);
  const ticks: TimelineTick[] = [];
  // Safety valve against a corrupt/absurd date range spinning forever.
  for (let guard = 0; guard < 400 && cursor <= domainEnd; guard++) {
    const d = new Date(cursor);
    ticks.push({
      ms: cursor,
      label: yearly
        ? String(d.getUTCFullYear())
        : d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }),
    });
    cursor = yearly
      ? Date.UTC(d.getUTCFullYear() + 1, 0, 1, 12)
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 12);
  }
  return ticks;
}

interface PlotRow { row: CSVRow; startMs: number; endMs: number; ongoing: boolean; }

export function renderTimeline(view: CardView, container: HTMLElement): void {
  const startCol = timelineStartCol(view);
  const endCol = timelineEndCol(view);
  if (!startCol || !endCol) {
    container.createEl("p", { text: "Needs a Start and an End/Due date column.", cls: "csv-empty-state" });
    return;
  }
  const titleCol = view.titleKey() ?? view.headers[0];
  const groupCol = effectiveGroupCol(view);

  // ── Filter bar (group only — mirrors the Library/Tasks filter pattern) ──
  const groups = new Set<string>();
  if (groupCol) view.rows.forEach(r => {
    (r[groupCol] ?? "").split(",").map(s => s.trim()).filter(Boolean).forEach(g => groups.add(g));
  });
  let groupSelect: HTMLSelectElement | null = null;
  if (groups.size > 1) {
    const filtersBar = container.createDiv({ cls: "csv-library-filters" });
    groupSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
    groupSelect.createEl("option", { text: "All", value: "all" });
    Array.from(groups).sort().forEach(g => groupSelect!.createEl("option", { text: g, value: g }));
    groupSelect.value = view.timelineGroupFilter;
    groupSelect.addEventListener("change", () => {
      view.timelineGroupFilter = groupSelect!.value;
      view.renderView(true);
    });
  }

  // ── Filter rows (group + toolbar search), then keep only ones with a parseable Start ──
  const q = view.searchQuery.toLowerCase().trim();
  const filtered = view.rows.filter(row => {
    if (groupCol && view.timelineGroupFilter !== "all") {
      const gs = (row[groupCol] ?? "").split(",").map(s => s.trim().toLowerCase());
      if (!gs.includes(view.timelineGroupFilter.toLowerCase())) return false;
    }
    if (q && !view.headers.some(h => (row[h] ?? "").toLowerCase().includes(q))) return false;
    return true;
  });

  const today = localISODate();
  const todayMs = parseDateMs(today)!;

  const plotted: PlotRow[] = [];
  filtered.forEach(row => {
    const startMs = parseDateMs(row[startCol] ?? "");
    if (startMs === null) return;
    const endRaw = parseDateMs(row[endCol] ?? "");
    const ongoing = endRaw === null;
    const endMs = Math.max(ongoing ? todayMs : endRaw, startMs);
    plotted.push({ row, startMs, endMs, ongoing });
  });
  plotted.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const wrap = container.createDiv({ cls: "csv-timeline" });

  const hasActiveFilters = q || (groupCol && view.timelineGroupFilter !== "all");
  if (!filtered.length) {
    const empty = wrap.createDiv({ cls: "csv-empty-state" });
    empty.createEl("p", { text: hasActiveFilters ? "No entries match your filters." : "No entries yet." });
    if (hasActiveFilters) {
      empty.createEl("button", { cls: "csv-clear-filters-btn", text: "Clear filters" }).addEventListener("click", () => {
        view.timelineGroupFilter = "all"; view.searchQuery = "";
        view.renderView();
      });
    }
    return;
  }
  if (!plotted.length) {
    wrap.createDiv({ cls: "csv-empty-state", text: `No entries have a ${startCol} date.` });
    return;
  }
  if (hasActiveFilters || plotted.length !== filtered.length) {
    wrap.createDiv({ cls: "csv-library-result-count", text: `Showing ${plotted.length} of ${view.rows.length} entries` });
  }

  // ── Domain: data's own min/max, padded a little for breathing room.
  // Ongoing rows already clamp their end to "today", so an active entry
  // naturally pulls the domain (and the now-line) up to the present.
  let domainStart = Math.min(...plotted.map(p => p.startMs));
  let domainEnd = Math.max(...plotted.map(p => p.endMs));
  let span = Math.max(domainEnd - domainStart, DAY_MS);
  const pad = Math.max(span * 0.03, DAY_MS);
  domainStart -= pad; domainEnd += pad;
  span = domainEnd - domainStart;
  const pct = (ms: number) => (ms - domainStart) / span * 100;
  const todayInRange = todayMs >= domainStart && todayMs <= domainEnd;

  // ── Axis ──
  const axisRow = wrap.createDiv({ cls: "csv-timeline-axis-row" });
  axisRow.createDiv({ cls: "csv-timeline-row-label" });
  const axisTrack = axisRow.createDiv({ cls: "csv-timeline-axis-track" });
  buildTimelineTicks(domainStart, domainEnd).forEach(t => {
    const tick = axisTrack.createDiv({ cls: "csv-timeline-tick" });
    tick.style.left = `${pct(t.ms)}%`;
    tick.createSpan({ cls: "csv-timeline-tick-lbl", text: t.label });
  });
  if (todayInRange) {
    const marker = axisTrack.createDiv({ cls: "csv-timeline-today-lbl", text: "today" });
    marker.style.left = `${pct(todayMs)}%`;
  }

  // ── Rows ──
  const rows = wrap.createDiv({ cls: "csv-timeline-rows" });
  const colorOf = makeColorer();
  const notesCol = view.getNotesCol();
  const openEntry = (row: CSVRow) => {
    if (notesCol) view.openNoteExpander(row, notesCol);
    else void view.openOrCreateNotes(row);
  };

  plotted.forEach(p => {
    const rowEl = rows.createDiv({ cls: "csv-timeline-row" });
    const labelCell = rowEl.createDiv({ cls: "csv-timeline-row-label" });
    const highlightCls = view.isHighlighted?.(p.row) ? "csv-title-highlight" : "";
    const link = labelCell.createSpan({ cls: `csv-timeline-link ${highlightCls}`.trim(), text: p.row[titleCol] || "Untitled" });
    link.addEventListener("click", () => openEntry(p.row));

    const track = rowEl.createDiv({ cls: "csv-timeline-row-track" });
    if (todayInRange) {
      const line = track.createDiv({ cls: "csv-timeline-today" });
      line.style.left = `${pct(todayMs)}%`;
    }
    const left = pct(p.startMs);
    const width = Math.max(pct(p.endMs) - pct(p.startMs), 0.6);
    const bar = track.createDiv({ cls: `csv-timeline-bar${p.ongoing ? " is-ongoing" : ""}` });
    bar.style.left = `${left}%`;
    bar.style.width = `${width}%`;
    if (groupCol) {
      const g = (p.row[groupCol] ?? "").split(",").map(s => s.trim()).filter(Boolean)[0];
      if (g) bar.style.background = colorOf(g);
    }
    const startLabel = (p.row[startCol] ?? "").slice(0, 10);
    const endLabel = p.ongoing ? "ongoing" : (p.row[endCol] ?? "").slice(0, 10);
    bar.setAttr("title", `${p.row[titleCol] || "Untitled"}\n${startLabel} → ${endLabel}`);
    bar.createSpan({ cls: "csv-timeline-bar-lbl", text: p.row[titleCol] || "Untitled" });
    bar.addEventListener("click", e => { e.stopPropagation(); openEntry(p.row); });
    rowEl.addEventListener("contextmenu", e => view.openRowContextMenu(p.row, e));
  });
}
