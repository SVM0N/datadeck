// Stats view renderer — pure-CSS bar charts over the current file: status
// breakdown, categories, rating distribution, entries per year, top authors.
// Deliberately no Chart.js (that stays a dashboard-only lazy load); plain DOM
// bars are cheaper, theme-aware, and trivially smoke-testable.
// Respects the toolbar search (renders stats over getFilteredRows()).
// Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { CSVRow } from "../types";

/** True when the file has at least one column the stats view can chart. */
export function hasStatsColumns(view: CardView): boolean {
  return !!(view.getCategoryCol() || view.getStatusCol()
    || resolveRatingCol(view) || view.authorKey());
}

function resolveRatingCol(view: CardView): string | null {
  return view.resolveCol(["Rating", "rating", "Score", "score", "Score /5", "Stars", "stars"]);
}

/**
 * Parse a rating cell into a 1–5 number, or null. Handles both numeric
 * values ("4", "4.5") and star strings ("★★★★☆" — counts filled stars).
 */
export function parseRating(raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const stars = (s.match(/★/g) ?? []).length;
  if (stars > 0) return stars;
  const n = parseFloat(s);
  if (isNaN(n) || n <= 0) return null;
  return Math.min(5, n);
}

const DONE_STATUSES = ["watched", "read", "finished", "completed", "done", "yes", "seen"];
const PROGRESS_STATUSES = ["watching", "reading", "in progress", "in-progress"];
const DROPPED_STATUSES = ["dropped", "abandoned", "dnf"];

function statusBarClass(status: string): string {
  const s = status.toLowerCase();
  if (DONE_STATUSES.includes(s)) return "is-done";
  if (PROGRESS_STATUSES.includes(s)) return "is-progress";
  if (DROPPED_STATUSES.includes(s)) return "is-dropped";
  return "";
}

/** Tally `key(row)` values (a row may yield several keys, e.g. split genres). */
function tally(rows: CSVRow[], key: (row: CSVRow) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  rows.forEach(r => key(r).forEach(k => counts.set(k, (counts.get(k) ?? 0) + 1)));
  return counts;
}

interface BarSpec { label: string; count: number; cls?: string; onClick?: () => void; }

function renderBarSection(container: HTMLElement, title: string, bars: BarSpec[], total: number): void {
  if (!bars.length) return;
  const section = container.createDiv({ cls: "csv-stats-section" });
  section.createDiv({ cls: "csv-stats-section-title", text: title });
  const max = Math.max(...bars.map(b => b.count));
  bars.forEach(b => {
    const row = section.createDiv({ cls: "csv-stats-bar-row" });
    row.createDiv({ cls: "csv-stats-bar-label", text: b.label, attr: { title: b.label } });
    const track = row.createDiv({ cls: "csv-stats-bar-track" });
    const fill = track.createDiv({ cls: `csv-stats-bar-fill ${b.cls ?? ""}` });
    fill.style.width = `${Math.max(2, Math.round((b.count / max) * 100))}%`;
    const pct = total > 0 ? Math.round((b.count / total) * 100) : 0;
    row.createDiv({ cls: "csv-stats-bar-count", text: `${b.count} · ${pct}%` });
    if (b.onClick) {
      row.addClass("is-clickable");
      row.title = `Show "${b.label}" in the library`;
      row.addEventListener("click", b.onClick);
    }
  });
}

export function renderStats(view: CardView, container: HTMLElement): void {
  const rows = view.getFilteredRows();

  if (view.searchQuery.trim()) {
    container.createDiv({ cls: "csv-search-results", text: `Stats over ${rows.length} of ${view.rows.length} entries` });
  }
  if (!rows.length) {
    container.createEl("p", { text: "No entries to chart.", cls: "csv-empty-state" });
    return;
  }

  const wrap = container.createDiv({ cls: "csv-stats-wrap" });
  const sc = view.getStatusCol();
  const cc = view.getCategoryCol();
  const ratingCol = resolveRatingCol(view);
  const authorCol = view.authorKey();
  const yearCol = view.resolveCol(["Year", "year"]);

  // ── Overview chips ──────────────────────────────────────────────────────
  const overview = wrap.createDiv({ cls: "csv-stats-overview" });
  const chip = (value: string, label: string) => {
    const c = overview.createDiv({ cls: "csv-stats-chip" });
    c.createDiv({ cls: "csv-stats-chip-value", text: value });
    c.createDiv({ cls: "csv-stats-chip-label", text: label });
  };
  chip(String(rows.length), "entries");
  if (sc) {
    const done = rows.filter(r => DONE_STATUSES.includes((r[sc] ?? "").toLowerCase().trim())).length;
    if (done > 0) chip(`${done} · ${Math.round((done / rows.length) * 100)}%`, "done");
    const inProgress = rows.filter(r => PROGRESS_STATUSES.includes((r[sc] ?? "").toLowerCase().trim())).length;
    if (inProgress > 0) chip(String(inProgress), "in progress");
  }
  if (cc) {
    const genres = tally(rows, r => (r[cc] ?? "").split(",").map(s => s.trim()).filter(Boolean));
    if (genres.size > 0) chip(String(genres.size), cc.toLowerCase() === "genre" || cc.toLowerCase() === "genres" ? "genres" : "categories");
  }
  if (ratingCol) {
    const ratings = rows.map(r => parseRating(r[ratingCol])).filter((n): n is number => n !== null);
    if (ratings.length) {
      const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      chip(`★ ${avg.toFixed(1)}`, `avg of ${ratings.length} rated`);
    }
  }

  // Status/category bars double as filters: clicking one jumps to the
  // library pre-filtered to that value. Only wired when the library mode is
  // actually available for this file (it needs a category column).
  const jumpToLibrary = (status: string | null, genre: string | null) => {
    view.libraryStatusFilter = status ?? "all";
    view.libraryGenreFilter = genre ?? "all";
    view.mode = "library";
    view.renderView();
  };

  // ── By status ───────────────────────────────────────────────────────────
  if (sc) {
    const counts = tally(rows, r => { const s = (r[sc] ?? "").trim(); return s ? [s] : []; });
    const bars: BarSpec[] = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label, count, cls: statusBarClass(label),
        onClick: cc ? () => jumpToLibrary(label, null) : undefined,
      }));
    renderBarSection(wrap, `By ${sc.toLowerCase()}`, bars, rows.length);
  }

  // ── By category (multi-genre rows count once per genre) ────────────────
  if (cc) {
    const counts = tally(rows, r => (r[cc] ?? "").split(",").map(s => s.trim()).filter(Boolean));
    const bars: BarSpec[] = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([label, count]) => ({ label, count, onClick: () => jumpToLibrary(null, label) }));
    renderBarSection(wrap, `By ${cc.toLowerCase()}`, bars, rows.length);
  }

  // ── Rating distribution (5★ → 1★) ───────────────────────────────────────
  if (ratingCol) {
    const buckets = new Map<number, number>();
    let rated = 0;
    rows.forEach(r => {
      const n = parseRating(r[ratingCol]);
      if (n === null) return;
      const b = Math.min(5, Math.max(1, Math.round(n)));
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
      rated++;
    });
    if (rated > 0) {
      const bars: BarSpec[] = [5, 4, 3, 2, 1]
        .filter(star => (buckets.get(star) ?? 0) > 0)
        .map(star => ({ label: "★".repeat(star), count: buckets.get(star)!, cls: "is-rating" }));
      renderBarSection(wrap, "Ratings", bars, rated);
    }
  }

  // ── Entries per year ────────────────────────────────────────────────────
  if (yearCol) {
    const counts = tally(rows, r => {
      const m = (r[yearCol] ?? "").match(/\d{4}/);
      return m ? [m[0]] : [];
    });
    if (counts.size > 1) {
      const bars: BarSpec[] = Array.from(counts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ label, count }));
      renderBarSection(wrap, "By year", bars, rows.length);
    }
  }

  // ── Top authors / directors / artists ───────────────────────────────────
  if (authorCol) {
    const counts = tally(rows, r => { const a = (r[authorCol] ?? "").trim(); return a ? [a] : []; });
    // Only interesting when names repeat — a list of all-1s is just the table.
    const repeats = Array.from(counts.entries()).filter(([, n]) => n > 1);
    if (repeats.length >= 2) {
      const bars: BarSpec[] = repeats
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([label, count]) => ({ label, count }));
      renderBarSection(wrap, `Top ${authorCol.toLowerCase()}s`, bars, rows.length);
    }
  }
}
