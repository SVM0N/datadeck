// ─── Travel view: DOM rendering ─────────────────────────────────────────────
//
// Renders the model from `travel-data.ts` as: stats row, interactive world
// choropleth, per-country day totals, a year-by-year timeline, and the trip
// tables (confirmed + collapsed photo-inferred + collapsed conflicts).
//
// Coloring rule (see handoff): gold = confirmed countries, blue = countries
// seen only via photo-inferred rows, grey = unvisited. Conflict rows and
// inferred rows overlapping a confirmed range are excluded from map/timeline.

import { CSVRow, ResidencyRule } from "./types";
import {
  analyzeTravel, TravelModel, TravelRow, countryName, flag, tripDays,
  CONT_NAMES, TOTAL_COUNTRIES,
} from "./travel-data";
import { makeFieldInput } from "./modals";
import { evaluateResidency } from "./residency";

const PALETTE = ['#c9a96e','#4a6fa5','#5ba06e','#a05b8a','#6ea0a0','#a0855b','#7a6ea0','#a06e6e','#6e8fa0','#a09e5b'];
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Stable per-country color cycler for the timeline. */
function makeColorer(): (iso: string) => string {
  const m = new Map<string, string>(); let i = 0;
  return (iso) => { if (!m.has(iso)) m.set(iso, PALETTE[i++ % PALETTE.length]); return m.get(iso)!; };
}

/**
 * Instant, cursor-following tooltip shared across the map and timeline.
 *
 * The native `title` attribute is slow (~1s delay), easy to miss, and clipped
 * by overflow containers — bad for tiny country shapes and short segments. This
 * uses a single position:fixed element on document.body, driven by delegated
 * pointer events on `root`: any element carrying `data-tip` shows it on hover.
 *
 * Returns a teardown fn so the view can clean up its body-level node and the
 * global pointer listener when the container is emptied / the view closes.
 */
function attachTooltip(root: HTMLElement): () => void {
  const tip = document.body.createDiv({ cls: "csv-tv-tooltip" });
  let current: HTMLElement | null = null;

  const place = (x: number, y: number) => {
    // Offset from the cursor, then clamp so it never runs off-screen.
    const pad = 8;
    let left = x + 14, top = y + 16;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    if (left + w + pad > window.innerWidth) left = x - w - 14;
    if (top + h + pad > window.innerHeight) top = y - h - 16;
    tip.style.left = `${Math.max(pad, left)}px`;
    tip.style.top = `${Math.max(pad, top)}px`;
  };

  const onMove = (e: PointerEvent) => {
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]") ?? null;
    const text = target?.getAttribute("data-tip") || "";
    if (!target || !text) { if (current) { current = null; tip.removeClass("is-on"); } return; }
    if (target !== current) {
      current = target;
      tip.setText(text);
      tip.addClass("is-on");
    }
    place(e.clientX, e.clientY);
  };
  const onLeave = () => { current = null; tip.removeClass("is-on"); };

  root.addEventListener("pointermove", onMove);
  root.addEventListener("pointerleave", onLeave);
  return () => {
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerleave", onLeave);
    tip.remove();
  };
}

function durLabel(r: TravelRow): string { const d = tripDays(r); return d ? `${d}d` : "—"; }
function dateLabel(s: string): string { return s ? s : "—"; }

/** Table inside a horizontal-scroll wrapper (so wide tables don't overflow on mobile). */
function tableIn(parent: HTMLElement): HTMLTableElement {
  return parent.createDiv({ cls: "csv-tv-table-wrap" }).createEl("table", { cls: "csv-tv-table" });
}

/**
 * Click-to-edit cell, writing straight through to the original CSVRow so the
 * change persists when `onEdit` (scheduleSave) runs. Reuses makeFieldInput, so
 * date columns get the yyyy-mm-dd picker and known columns get datalists.
 * Derived cells (flag, duration) and aggregates (map, stats) refresh on reopen.
 */
function editableCell(td: HTMLElement, row: CSVRow, h: string, onEdit: () => void): void {
  td.addClass("csv-tv-editable");
  td.title = "Click to edit";
  const show = () => { td.empty(); td.setText(row[h] ? row[h] : "—"); };
  show();
  td.addEventListener("click", () => {
    if (td.querySelector("input")) return; // already editing
    td.empty();
    const input = makeFieldInput(td, h, row[h] ?? "", "csv-inline-input");
    input.focus(); if (input.type === "text") input.select();
    input.addEventListener("blur", () => { row[h] = input.value; onEdit(); show(); });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { input.value = row[h] ?? ""; input.blur(); } // revert
    });
  });
}

/**
 * Render the travel view into `container`.
 * @param loadMapSvg async loader for the world-map SVG asset (returns null if unavailable)
 * @param register hook to tie teardown (e.g. the hover tooltip) to the view's
 *   lifecycle; called with a cleanup fn that runs on re-render / view close.
 */
export async function renderTravel(
  container: HTMLElement,
  rows: CSVRow[],
  loadMapSvg: () => Promise<string | null>,
  onEdit: () => void = () => {},
  residencyRules: ResidencyRule[] | null = null,
  register: (teardown: () => void) => void = () => {},
): Promise<void> {
  const model = analyzeTravel(rows);
  const root = container.createDiv({ cls: "csv-tv" });

  if (!model.confirmed.length && !model.inferred.length) {
    root.createDiv({ cls: "csv-empty-state", text: "No travel rows found. Expected columns: country, date_entered, date_left, source." });
    return;
  }

  register(attachTooltip(root));
  renderStats(root, model);
  // Map wrapper is created synchronously (keeps document order); filled async.
  const mapWrap = root.createDiv({ cls: "csv-tv-mapwrap" });
  mapWrap.createDiv({ cls: "csv-tv-map-loading", text: "Loading map…" });
  if (residencyRules && residencyRules.length) renderResidency(root, model.confirmed, residencyRules);
  renderCountries(root, model);
  renderTimeline(root, model);
  renderTrips(root, model, onEdit);

  // Async: inject + color the SVG once loaded. Failure degrades gracefully.
  try {
    const svg = await loadMapSvg();
    mapWrap.empty();
    if (svg) injectMap(mapWrap, svg, model);
    else mapWrap.createDiv({ cls: "csv-tv-map-loading", text: "World map asset not found (world-map.svg)." });
  } catch (_e) {
    mapWrap.empty();
    mapWrap.createDiv({ cls: "csv-tv-map-loading", text: "Couldn't load world map." });
  }
}

function renderStats(root: HTMLElement, m: TravelModel): void {
  const row = root.createDiv({ cls: "csv-tv-stats" });
  const stat = (label: string, value: string, sub = "") => {
    const c = row.createDiv({ cls: "csv-tv-stat" });
    c.createDiv({ cls: "csv-tv-stat-label", text: label });
    c.createDiv({ cls: "csv-tv-stat-value", text: value });
    if (sub) c.createDiv({ cls: "csv-tv-stat-sub", text: sub });
  };
  const allPct = Math.round(m.allCountries.size / TOTAL_COUNTRIES * 100);
  stat("Countries", String(m.confirmedCountries.size), `${m.worldPct}% of world`);
  stat("Incl. photos", String(m.allCountries.size), `${allPct}% of world`);
  stat("Continents", `${m.visitedContinents.size} / 7`,
    [...m.visitedContinents].map(c => CONT_NAMES[c] || c).sort().join(", "));
  stat("Confirmed trips", String(m.confirmed.length));
  stat("Confirmed days", String(m.totalConfirmedDays));
}

function injectMap(wrap: HTMLElement, svg: string, m: TravelModel): void {
  const box = wrap.createDiv({ cls: "csv-tv-map" });
  box.innerHTML = svg;
  box.querySelectorAll<SVGPathElement>(".country-path").forEach(p => {
    const iso = (p.getAttribute("data-iso") || "").toUpperCase();
    p.classList.remove("cp-unvisited", "cp-confirmed", "cp-inferred");
    if (iso && m.confirmedCountries.has(iso)) {
      p.classList.add("cp-confirmed");
      const stat = m.countryDays.find(c => c.iso === iso);
      p.setAttr("aria-label", `${countryName(iso)} — ${stat && stat.days ? stat.days + "d confirmed" : "confirmed"}`);
      p.setAttr("data-tip", `${countryName(iso)}${stat && stat.days ? "  ·  " + stat.days + "d" : ""}`);
    } else if (iso && m.inferredOnlyCountries.has(iso)) {
      p.classList.add("cp-inferred");
      p.setAttr("aria-label", `${countryName(iso)} — photo evidence`);
      p.setAttr("data-tip", `${countryName(iso)}  ·  photo evidence`);
    } else if (iso) {
      p.classList.add("cp-unvisited");
      p.setAttr("data-tip", countryName(iso));
    } else {
      p.classList.add("cp-unvisited");
    }
  });
  // Micro-states (Singapore, Malta, island nations…) render only a few pixels
  // wide — hard to land the cursor on. Give the small ones a wide transparent
  // stroke as an invisible hit halo (see .cp-tiny). One measurement pass on
  // render; getBoundingClientRect can throw on detached/zero-box nodes, so guard.
  box.querySelectorAll<SVGPathElement>(".country-path").forEach(p => {
    try {
      const r = p.getBoundingClientRect();
      if (r.width && r.height && Math.max(r.width, r.height) < 12) p.classList.add("cp-tiny");
    } catch (_e) { /* not measurable yet — skip, no halo */ }
  });
  const legend = wrap.createDiv({ cls: "csv-tv-map-legend" });
  legend.createSpan({ cls: "csv-tv-leg" }).innerHTML = `<span class="csv-tv-dot cp-confirmed"></span> Confirmed`;
  legend.createSpan({ cls: "csv-tv-leg" }).innerHTML = `<span class="csv-tv-dot cp-inferred"></span> Photo evidence`;
}

function renderResidency(root: HTMLElement, confirmed: TravelRow[], rules: ResidencyRule[]): void {
  root.createDiv({ cls: "csv-tv-sec-title", text: "Residency counters" });
  const grid = root.createDiv({ cls: "csv-tv-res-grid" });
  for (const rule of rules) {
    const r = evaluateResidency(rule, confirmed);
    const card = grid.createDiv({ cls: `csv-tv-res-card csv-tv-res-${r.status}` });
    card.createDiv({ cls: "csv-tv-res-label", text: rule.label });
    const nums = card.createDiv({ cls: "csv-tv-res-nums" });
    nums.createSpan({ cls: "csv-tv-res-used", text: String(r.used) });
    nums.createSpan({ cls: "csv-tv-res-thresh", text: ` / ${r.threshold}` });
    nums.createSpan({ cls: "csv-tv-res-window", text: ` ${r.windowLabel}` });
    const bar = card.createDiv({ cls: "csv-tv-res-bar" });
    bar.createDiv({ cls: "csv-tv-res-fill" }).style.width = `${Math.min(100, Math.round(r.used / r.threshold * 100))}%`;
    const status = r.status === "over"
      ? (rule.onExceed ? `Over — ${rule.onExceed}` : "Limit reached")
      : `${r.remaining} day${r.remaining === 1 ? "" : "s"} left`;
    card.createDiv({ cls: "csv-tv-res-status", text: status });
    if (rule.note) card.createDiv({ cls: "csv-tv-res-note", text: rule.note });
  }
  root.createDiv({ cls: "csv-tv-res-disclaimer", text: "Indicators only — not legal or tax advice. Based on confirmed trips." });
}

function renderCountries(root: HTMLElement, m: TravelModel): void {
  root.createDiv({ cls: "csv-tv-sec-title", text: "Countries visited" });
  const table = tableIn(root);
  const thead = table.createEl("thead").createEl("tr");
  ["", "Country", "Total days"].forEach(h => thead.createEl("th", { text: h }));
  const tbody = table.createEl("tbody");
  for (const { iso, days } of m.countryDays) {
    const tr = tbody.createEl("tr");
    tr.createEl("td", { text: flag(iso), cls: "csv-tv-flag" });
    tr.createEl("td", { text: countryName(iso) });
    tr.createEl("td", { text: days ? `${days}d` : "—" });
  }
  if (m.inferredOnlyCountries.size) {
    const photo = root.createDiv({ cls: "csv-tv-photo-only" });
    photo.createSpan({ text: "📷 Photo evidence only: " });
    photo.createSpan({ text: [...m.inferredOnlyCountries].sort().map(flag).join(" ") });
  }
}

function renderTimeline(root: HTMLElement, m: TravelModel): void {
  root.createDiv({ cls: "csv-tv-sec-title", text: "Timeline" });
  const colorOf = makeColorer();

  // Confirmed (solid) + visible inferred (bordered), bucketed by every year they span.
  type Seg = TravelRow & { _inf: boolean };
  const segs: Seg[] = [
    ...m.confirmed.map(r => ({ ...r, _inf: false })),
    ...m.inferredVisible.map(r => ({ ...r, _inf: true })),
  ].filter(r => r.date_entered && r.date_left && r.date_entered.indexOf("?") === -1);

  const byYear = new Map<number, Seg[]>();
  for (const r of segs) {
    const y0 = parseInt(r.date_entered.slice(0, 4));
    const y1 = parseInt(r.date_left.slice(0, 4));
    if (isNaN(y0) || isNaN(y1)) continue;
    for (let y = y0; y <= y1; y++) { if (!byYear.has(y)) byYear.set(y, []); byYear.get(y)!.push(r); }
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  const wrap = root.createDiv({ cls: "csv-tv-timeline" });

  for (const year of years) {
    const yS = new Date(`${year}-01-01T12:00:00Z`).getTime();
    const yE = new Date(`${year}-12-31T12:00:00Z`).getTime();
    const span = yE - yS;
    const block = wrap.createDiv({ cls: "csv-tv-tl-year" });
    block.createDiv({ cls: "csv-tv-tl-label", text: String(year) });
    const mrow = block.createDiv({ cls: "csv-tv-month-row" });
    MONTHS.forEach(mo => mrow.createDiv({ cls: "csv-tv-month-tick", text: mo }));
    const track = block.createDiv({ cls: "csv-tv-track" });
    for (const r of byYear.get(year)!) {
      const a = Math.max(new Date(r.date_entered + "T12:00:00Z").getTime(), yS);
      const b = Math.min(new Date(r.date_left + "T12:00:00Z").getTime(), yE);
      if (a > b) continue;
      const left = (a - yS) / span * 100;
      const width = Math.max((b - a + 86400000) / span * 100, 0.5);
      const color = colorOf(r.country);
      const seg = track.createDiv({ cls: `csv-tv-seg${r._inf ? " csv-tv-seg-inf" : ""}` });
      seg.style.left = `${left}%`;
      seg.style.width = `${width}%`;
      if (r._inf) { seg.style.borderColor = color; seg.style.background = color + "22"; seg.style.color = color; }
      else { seg.style.background = color; }
      seg.setAttr("data-tip", `${countryName(r.country)}  ${r.date_entered} → ${r.date_left}  (${tripDays(r)}d)${r.visa_status ? "  [" + r.visa_status + "]" : ""}${r._inf ? "  [photo]" : ""}`);
      if (width > 4) seg.createSpan({ cls: "csv-tv-seg-lbl", text: `${flag(r.country)} ${r.country}` });
      else if (width > 2) seg.createSpan({ cls: "csv-tv-seg-lbl", text: flag(r.country) });
    }
  }
  const leg = wrap.createDiv({ cls: "csv-tv-tl-legend" });
  leg.setText("Confirmed (solid) · Photo inferred (outlined)");
}

function sortByDateDesc<T extends { date_entered: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => {
    if (!a.date_entered && !b.date_entered) return 0;
    if (!a.date_entered) return 1;   // blanks last
    if (!b.date_entered) return -1;
    return b.date_entered.localeCompare(a.date_entered);
  });
}

function renderTrips(root: HTMLElement, m: TravelModel, onEdit: () => void): void {
  root.createDiv({ cls: "csv-tv-sec-title", text: "Confirmed trips" });
  root.createDiv({ cls: "csv-tv-edit-hint", text: "Dates, city, visa and notes are editable — click a cell. Edit country in Table view." });
  const table = tableIn(root);
  const head = table.createEl("thead").createEl("tr");
  ["", "Country", "Entered", "Left", "Duration", "City", "Visa", "Notes"].forEach(h => head.createEl("th", { text: h }));
  const body = table.createEl("tbody");
  for (const r of sortByDateDesc(m.confirmed)) {
    const tr = body.createEl("tr");
    // Flag + country (full name) + duration are derived → display-only.
    tr.createEl("td", { text: flag(r.country), cls: "csv-tv-flag" });
    tr.createEl("td", { text: countryName(r.country) });
    editableCell(tr.createEl("td"), r._src, "date_entered", onEdit);
    editableCell(tr.createEl("td"), r._src, "date_left", onEdit);
    tr.createEl("td", { text: durLabel(r) });
    editableCell(tr.createEl("td"), r._src, "city", onEdit);
    editableCell(tr.createEl("td"), r._src, "visa_status", onEdit);
    editableCell(tr.createEl("td"), r._src, "notes", onEdit);
  }

  // Collapsed: photo-inferred
  if (m.inferred.length) {
    const det = root.createEl("details", { cls: "csv-tv-details" });
    det.createEl("summary", { text: `📷 Photo inferred trips (${m.inferred.length})` });
    const t = tableIn(det);
    const h = t.createEl("thead").createEl("tr");
    ["", "Country", "Entered", "Left", "Days", "City"].forEach(x => h.createEl("th", { text: x }));
    const tb = t.createEl("tbody");
    for (const r of sortByDateDesc(m.inferred)) {
      const tr = tb.createEl("tr");
      tr.createEl("td", { text: flag(r.country), cls: "csv-tv-flag" });
      tr.createEl("td", { text: countryName(r.country) });
      tr.createEl("td", { text: dateLabel(r.date_entered) });
      tr.createEl("td", { text: dateLabel(r.date_left) });
      tr.createEl("td", { text: durLabel(r) });
      tr.createEl("td", { text: r.city });
    }
  }

  // Collapsed: conflicts
  if (m.conflicts.length) {
    const det = root.createEl("details", { cls: "csv-tv-details csv-tv-details-warn" });
    det.createEl("summary", { text: `⚠ ${m.conflicts.length} conflict(s) — photo evidence contradicts a confirmed entry` });
    const t = tableIn(det);
    const h = t.createEl("thead").createEl("tr");
    ["", "Country (photos)", "Dates", "Detail"].forEach(x => h.createEl("th", { text: x }));
    const tb = t.createEl("tbody");
    for (const r of sortByDateDesc(m.conflicts)) {
      const tr = tb.createEl("tr");
      tr.createEl("td", { text: flag(r.country), cls: "csv-tv-flag" });
      tr.createEl("td", { text: r.country });
      tr.createEl("td", { text: `${dateLabel(r.date_entered)} → ${dateLabel(r.date_left)}` });
      tr.createEl("td", { text: r.notes });
    }
  }
}
