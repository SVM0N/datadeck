// View smoke tests — render real view code into a jsdom DOM and assert the
// output structure + that nothing throws. This is the regression net for the
// main.ts → src/view/* modularization: extracted renderers get a case here so
// a silently-broken view is caught in CI, not by eye.
//
// Renderers are bundled per-entry with esbuild (obsidian aliased to a stub),
// then imported and driven against the jsdom environment in test-support/.

import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupDom } from "./test-support/dom-env.mjs";

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.log(`✗ ${name}`); console.log(`  ${e.stack || e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const { document } = setupDom();
const STUB = fileURLToPath(new URL("./test-support/obsidian-stub.mjs", import.meta.url));
const CHART_STUB = fileURLToPath(new URL("./test-support/chartjs-stub.mjs", import.meta.url));

/** Bundle a TS entry (obsidian aliased to the stub) and import a named export. */
async function load(entryRel) {
  const entry = fileURLToPath(new URL(entryRel, import.meta.url));
  const out = path.join(os.tmpdir(), `smoke-${path.basename(entryRel)}.${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, alias: { obsidian: STUB, "chart.js": CHART_STUB }, define: { __BUILD_TIME__: JSON.stringify("test") }, logLevel: "error" });
  const mod = await import(pathToFileURL(out).href);
  fs.rmSync(out, { force: true });
  return mod;
}

const ROWS = [
  { date_entered: "2020-01-01", date_left: "2020-01-11", country: "FR", city: "Paris", visa_status: "Tourist", notes: "", source: "confirmed", resolved: "" },
  { date_entered: "2020-02-01", date_left: "2020-02-01", country: "JP", city: "Tokyo", visa_status: "Tourist", notes: "", source: "confirmed", resolved: "" },
  { date_entered: "2021-03-01", date_left: "2021-03-10", country: "IT", city: "Rome", visa_status: "", notes: "photo", source: "inferred", resolved: "" },
  { date_entered: "", date_left: "", country: "BR", city: "", visa_status: "Tourist", notes: "", source: "confirmed", resolved: "" },
];

// ── Travel view ──────────────────────────────────────────────────────────────
const { renderTravel } = await load("./src/travel-view.ts");

await test("travel: renders core sections without throwing", async () => {
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => null, () => {}, null, () => {});
  assert(c.querySelector(".csv-tv-stats"), "stats row present");
  assert(c.querySelector(".csv-tv-table"), "at least one table present");
  assert(c.querySelectorAll(".csv-tv-sec-title").length >= 2, "section titles present");
  assert(c.querySelector(".csv-tv-stat-value").textContent === "3", "3 confirmed countries (FR/JP/BR)");
});

await test("travel: residency rules render a gauge card", async () => {
  const rules = [{ label: "Test", scope: { country: "FR" }, window: { type: "all-time" }, threshold: 100 }];
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => null, () => {}, rules, () => {});
  assert(c.querySelector(".csv-tv-res-card"), "residency card present");
});

await test("travel: empty data shows the empty state", async () => {
  const c = document.body.createDiv();
  await renderTravel(c, [], async () => null);
  assert(c.querySelector(".csv-empty-state"), "empty state present");
});

await test("travel: map SVG injects + colors confirmed gold, unknown grey", async () => {
  const svg = '<svg><path class="country-path" data-iso="FR"></path><path class="country-path" data-iso="ZZ"></path></svg>';
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => svg, () => {}, null, () => {});
  const fr = c.querySelector('.country-path[data-iso="FR"]');
  const zz = c.querySelector('.country-path[data-iso="ZZ"]');
  assert(fr && fr.classList.contains("cp-confirmed"), "FR colored confirmed (gold)");
  assert(zz && zz.classList.contains("cp-unvisited"), "ZZ left unvisited (grey)");
});

await test("travel: clicking a confirmed country opens the detail panel", async () => {
  const svg = '<svg><path class="country-path" data-iso="FR"></path><path class="country-path" data-iso="ZZ"></path></svg>';
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => svg, () => {}, null, () => {});
  const fr = c.querySelector('.country-path[data-iso="FR"]');
  fr.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(fr.classList.contains("cp-selected"), "FR highlighted on the map");
  const detail = c.querySelector(".csv-tv-detail");
  assert(detail, "detail panel opened");
  assert(detail.querySelector(".csv-tv-detail-name").textContent === "France", "panel names the country");
  assert(detail.querySelectorAll("tbody tr").length === 1, "one FR trip listed");
  // Re-click toggles off.
  fr.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(!c.querySelector(".csv-tv-detail"), "re-click clears the panel");
  assert(!fr.classList.contains("cp-selected"), "highlight cleared");
});

await test("travel: countries-table row click selects; unvisited map click clears", async () => {
  const svg = '<svg><path class="country-path" data-iso="JP"></path><path class="country-path" data-iso="ZZ"></path></svg>';
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => svg, () => {}, null, () => {});
  const row = c.querySelector('tr[data-iso="JP"]');
  assert(row, "countries table rows carry data-iso");
  row.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(c.querySelector(".csv-tv-detail-name").textContent === "Japan", "row click opens Japan panel");
  assert(row.classList.contains("is-selected"), "row highlighted");
  c.querySelector('.country-path[data-iso="ZZ"]').dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(!c.querySelector(".csv-tv-detail"), "clicking an unvisited country dismisses");
});

await test("travel: timeline segments carry data-iso and years get summaries", async () => {
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => null, () => {}, null, () => {});
  const seg = c.querySelector(".csv-tv-seg");
  assert(seg && seg.getAttribute("data-iso"), "segment has data-iso");
  const sub = c.querySelector(".csv-tv-tl-sub");
  assert(sub, "year summary present");
  // 2021 (top year, sorted desc) has only the inferred IT trip → countries only, no confirmed days.
  assert(sub.textContent === "1 country", `2021 summary is countries-only (got "${sub.textContent}")`);
});

await test("travel: stats row includes Cities and Longest trip tiles", async () => {
  const c = document.body.createDiv();
  await renderTravel(c, ROWS, async () => null, () => {}, null, () => {});
  const labels = Array.from(c.querySelectorAll(".csv-tv-stat-label")).map(e => e.textContent);
  assert(labels.includes("Cities"), "Cities tile present");
  assert(labels.includes("Longest trip"), "Longest trip tile present");
  // No current-stay banner: fixture trips are all in the past.
  assert(!c.querySelector(".csv-tv-now"), "no stale 'currently in' banner");
});

// ── Table view ───────────────────────────────────────────────────────────────
// Driven with a hand-built `view` stub (no CardView/FileView instance needed).
const { renderTable } = await load("./src/view/table.ts");

await test("table: renders headers + rows without throwing", async () => {
  const rows = [
    { Title: "Dune", Status: "Read", notes: "great" },
    { Title: "Hyperion", Status: "", notes: "" },
  ];
  const view = {
    headers: ["Title", "Status", "notes"],
    rows,
    searchQuery: "",
    settings: { columnWidths: {} },
    getFilteredRows: () => rows,
    persistSettings: async () => {},
    scheduleSave: () => {},
    openRowContextMenu: () => {},
    isNotesCol: (h) => h === "notes",
    openNoteExpander: () => {},
    isSelectCol: (h) => h === "Status",
    renderSelectField: (td) => { td.setText("sel"); return td; },
    notesFileExists: () => false,
    openOrCreateNotes: () => {},
    deleteWithUndo: () => {},
  };
  const c = document.body.createDiv();
  renderTable(view, c);
  assert(c.querySelector("table.csv-table"), "table present");
  assert(c.querySelectorAll("tbody tr").length === 2, "2 data rows");
  assert(c.querySelectorAll("thead th").length === 4, "3 headers + action column");
  assert(c.querySelector(".csv-table-notes-cell"), "notes cell rendered for notes column");
});

await test("table: search count appears when a query is set", async () => {
  const rows = [{ Title: "Dune" }];
  const view = {
    headers: ["Title"], rows, searchQuery: "du", settings: { columnWidths: {} },
    getFilteredRows: () => rows, persistSettings: async () => {}, scheduleSave: () => {},
    openRowContextMenu: () => {}, isNotesCol: () => false, openNoteExpander: () => {},
    isSelectCol: () => false, renderSelectField: (td) => td, notesFileExists: () => false,
    openOrCreateNotes: () => {}, deleteWithUndo: () => {},
  };
  const c = document.body.createDiv();
  renderTable(view, c);
  assert(c.querySelector(".csv-search-results"), "search result count shown");
});

// ── Library view ─────────────────────────────────────────────────────────────
const { renderLibrary } = await load("./src/view/library.ts");

await test("library: groups cards by category", async () => {
  const rows = [
    { Title: "Dune", Category: "SciFi", Status: "Read" },
    { Title: "It", Category: "Horror", Status: "" },
  ];
  const view = {
    headers: ["Title", "Category", "Status"], rows, searchQuery: "",
    libraryStatusFilter: "all", libraryGenreFilter: "all", fileCfg: {},
    getCategoryCol: () => "Category", getStatusCol: () => "Status",
    titleKey: () => "Title", authorKey: () => undefined,
    resolveCol: () => null, getNotesCol: () => null,
    renderView: () => {}, openNoteExpander: () => {}, openRowContextMenu: () => {},
  };
  const c = document.body.createDiv();
  renderLibrary(view, c);
  assert(c.querySelector(".csv-library-sections"), "sections wrap present");
  assert(c.querySelectorAll(".csv-library-section").length === 2, "2 genre sections (SciFi, Horror)");
  assert(c.querySelectorAll(".csv-library-card").length === 2, "2 cards");
});

await test("library: no category column shows empty state", async () => {
  const view = {
    headers: [], rows: [], getCategoryCol: () => null, getStatusCol: () => null,
    titleKey: () => undefined, authorKey: () => undefined,
  };
  const c = document.body.createDiv();
  renderLibrary(view, c);
  assert(c.querySelector(".csv-empty-state"), "empty state present");
});

// ── Kanban view ──────────────────────────────────────────────────────────────
const { renderKanbanGenre } = await load("./src/view/kanban.ts");

await test("kanban: builds a column per genre with cards", async () => {
  const rows = [
    { Title: "Dune", Category: "SciFi", Status: "Finished" },
    { Title: "It", Category: "Horror", Status: "Not started" },
  ];
  const view = {
    headers: ["Title", "Category", "Status"], rows, searchQuery: "",
    settings: { categoryColumn: "Category" },
    getCategoryCol: () => "Category", getStatusCol: () => "Status",
    getFilteredRows: () => rows, getNotesCol: () => null,
    getTitle: (r) => r.Title, getSubtitle: () => "",
    titleKey: () => "Title", authorKey: () => undefined,
    isNotesCol: () => false, isSelectCol: () => false, getColumnValues: () => [],
    notesFileExists: () => false, openOrCreateNotes: () => {}, openNoteExpander: () => {},
    openRowContextMenu: () => {}, scheduleSave: () => {}, contentEl: document.body.createDiv(),
  };
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  assert(c.querySelector(".csv-kanban-board"), "board present");
  assert(c.querySelectorAll(".csv-kanban-col").length === 2, "2 genre columns");
  assert(c.querySelectorAll(".csv-kanban-card").length === 2, "2 cards");
});

await test("kanban: no category column shows empty state", async () => {
  const view = { getCategoryCol: () => null, getStatusCol: () => null, settings: { categoryColumn: "Category" } };
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  assert(c.querySelector(".csv-empty-state"), "empty state present");
});

// ── Toolbar ──────────────────────────────────────────────────────────────────
const { renderToolbar } = await load("./src/view/toolbar.ts");

await test("toolbar: renders mode buttons, search, row count, + Add", async () => {
  const view = {
    file: { basename: "movies", path: "movies.csv" },
    rows: [{}, {}], mode: "table", searchQuery: "",
    isTravelFile: () => false, hasDateColumn: () => false, getCategoryCol: () => "Category",
    fileCfg: {}, app: {}, headers: ["Title", "Category"],
    renderView: () => {}, renderViewPreservingScroll: () => {}, saveFileCfg: () => {},
    autoDetectBooleanColumns: () => [], generateMobileFiles: () => {}, backupToArchive: () => {}, openAddModal: () => {},
  };
  const c = document.body.createDiv();
  renderToolbar(view, c);
  assert(c.querySelector(".csv-toolbar"), "toolbar present");
  assert(c.querySelectorAll(".csv-mode-btn").length === 5, "Cards + Kanban + Table + Focus + Stats (no travel/dashboard)");
  assert(c.querySelector(".csv-search-wrap"), "search bar present for non-dashboard mode");
  assert(c.querySelector(".csv-add-btn"), "+ Add button present");
  assert(c.querySelector(".csv-row-count").textContent === "2 entries", "row count reflects rows");
});

await test("toolbar: date files get Dashboard + Table, no Focus/Stats", async () => {
  const view = {
    file: { basename: "habits", path: "habits.csv" },
    rows: [{}], mode: "dashboard", searchQuery: "",
    isTravelFile: () => false, hasDateColumn: () => true, getCategoryCol: () => null,
    fileCfg: {}, app: {}, headers: ["date", "gym"],
    renderView: () => {}, renderViewPreservingScroll: () => {}, saveFileCfg: () => {},
    autoDetectBooleanColumns: () => [], generateMobileFiles: () => {}, backupToArchive: () => {}, openAddModal: () => {},
  };
  const c = document.body.createDiv();
  renderToolbar(view, c);
  const labels = Array.from(c.querySelectorAll(".csv-mode-btn")).map(b => b.textContent);
  assert(labels.join(",") === "Dashboard,Table", `dashboard files keep Dashboard + Table only (got ${labels})`);
});

// ── Dashboard view ───────────────────────────────────────────────────────────
const { renderDashboard } = await load("./src/view/dashboard.ts");

function dashView() {
  const rows = [
    { date: "2024-01-01", gym: "1", read: "0" },
    { date: "2024-01-02", gym: "1", read: "1" },
  ];
  return {
    rows, headers: ["date", "gym", "read"],
    selectedDate: null, selectedHabit: null, chartInstance: null, timelineYear: 2024,
    getDateCol: () => "date", getBooleanColumns: () => ["gym", "read"], getNotesCol: () => null,
    formatDate: (d) => d.toISOString().slice(0, 10),
    parseDate: (s) => (s ? new Date(s + "T00:00:00") : null),
    isTruthy: (v) => v === "1" || v === "yes",
    scheduleSave: () => {}, renderView: () => {}, renderViewPreservingScroll: () => {},
  };
}

await test("dashboard: renders nav, chart canvas, stats and per-habit cards", async () => {
  const c = document.body.createDiv();
  await renderDashboard(dashView(), c);
  assert(c.querySelector(".csv-dash-nav"), "date navigator present");
  assert(c.querySelector("canvas.csv-dash-chart"), "chart canvas present");
  assert(c.querySelector(".csv-dash-stats-bar"), "stats bar present (post chart-load path ran)");
  assert(c.querySelectorAll(".csv-dash-habit-card").length === 2, "2 per-habit cards (gym, read)");
});

await test("dashboard: per-habit timeline renders when a habit is selected", async () => {
  const v = dashView(); v.selectedHabit = "gym";
  const c = document.body.createDiv();
  await renderDashboard(v, c);
  assert(c.querySelector(".csv-dash-timeline-section"), "timeline section present");
  assert(c.querySelectorAll(".csv-dash-timeline-month-col").length === 12, "12 month columns");
});

await test("dashboard: no date column shows empty state", async () => {
  const c = document.body.createDiv();
  await renderDashboard({ getDateCol: () => null }, c);
  assert(c.querySelector(".csv-empty-state"), "empty state present");
});

// ── Stats view ───────────────────────────────────────────────────────────────
const { renderStats, parseRating, hasStatsColumns } = await load("./src/view/stats.ts");

function statsView(rows) {
  return {
    headers: Object.keys(rows[0] ?? {}), rows, searchQuery: "",
    getFilteredRows: () => rows,
    getCategoryCol: () => "Category", getStatusCol: () => "Status",
    authorKey: () => "Author",
    resolveCol: (cands) => {
      const have = Object.keys(rows[0] ?? {});
      return cands.find(c => have.includes(c)) ?? null;
    },
  };
}

await test("stats: renders overview chips and bar sections", async () => {
  const rows = [
    { Title: "Dune", Author: "Herbert", Category: "SciFi", Status: "Read", Rating: "5", Year: "2021" },
    { Title: "Messiah", Author: "Herbert", Category: "SciFi", Status: "Read", Rating: "4", Year: "2022" },
    { Title: "It", Author: "King", Category: "Horror, Classic", Status: "Reading", Rating: "", Year: "2022" },
  ];
  const c = document.body.createDiv();
  renderStats(statsView(rows), c);
  assert(c.querySelector(".csv-stats-overview"), "overview chips present");
  assert(c.querySelector(".csv-stats-chip-value").textContent === "3", "entry count chip first");
  const titles = Array.from(c.querySelectorAll(".csv-stats-section-title")).map(t => t.textContent);
  assert(titles.includes("By status"), "status section present");
  assert(titles.includes("By category"), "category section present");
  assert(titles.includes("Ratings"), "ratings section present");
  // Multi-genre row counts once per genre: SciFi 2, Horror 1, Classic 1.
  const catSection = c.querySelectorAll(".csv-stats-section")[1];
  assert(catSection.querySelectorAll(".csv-stats-bar-row").length === 3, "3 category bars");
});

await test("stats: status bars get semantic color classes", async () => {
  const rows = [
    { Title: "A", Author: "", Category: "X", Status: "Finished", Rating: "" },
    { Title: "B", Author: "", Category: "X", Status: "In progress", Rating: "" },
  ];
  const c = document.body.createDiv();
  renderStats(statsView(rows), c);
  assert(c.querySelector(".csv-stats-bar-fill.is-done"), "done bar colored green");
  assert(c.querySelector(".csv-stats-bar-fill.is-progress"), "in-progress bar colored blue");
});

await test("stats: parseRating handles numbers and star strings", async () => {
  assert(parseRating("4") === 4, "numeric");
  assert(parseRating("4.5") === 4.5, "decimal");
  assert(parseRating("★★★☆☆") === 3, "stars counted");
  assert(parseRating("") === null, "empty → null");
  assert(parseRating("n/a") === null, "garbage → null");
  assert(parseRating("9") === 5, "clamped to 5");
});

await test("stats: hasStatsColumns false when nothing chartable", async () => {
  const view = { getCategoryCol: () => null, getStatusCol: () => null, authorKey: () => undefined, resolveCol: () => null };
  assert(hasStatsColumns(view) === false, "no chartable columns");
});

// ── Focus view ───────────────────────────────────────────────────────────────
const { renderFocus } = await load("./src/view/focus.ts");

function focusView(rows, overrides = {}) {
  const view = {
    headers: Object.keys(rows[0] ?? {}), rows, searchQuery: "",
    focusIndex: 0, focusNavPending: false,
    getFilteredRows: () => rows,
    titleKey: () => "Title", authorKey: () => "Author", getNotesCol: () => "Notes",
    getTitle: (r) => r.Title ?? "—", getSubtitle: (r) => r.Author ?? "",
    isSelectCol: () => false, getColumnValues: () => [],
    renderMarkdownInto: (el, text) => el.setText(text),
    scheduleSave: () => {}, renderView: () => {},
    openNoteExpander: () => {}, openRowContextMenu: () => {},
    contentEl: document.body.createDiv(),
    ...overrides,
  };
  return view;
}

await test("focus: renders one card with title, notes, position, nav", async () => {
  const rows = [
    { Title: "Dune", Author: "Herbert", Notes: "A classic.", Status: "Read" },
    { Title: "It", Author: "King", Notes: "", Status: "" },
  ];
  const c = document.body.createDiv();
  renderFocus(focusView(rows), c);
  assert(c.querySelectorAll(".csv-focus-card").length === 1, "exactly one card");
  assert(c.querySelector(".csv-focus-title").textContent === "Dune", "first entry shown");
  assert(c.querySelector(".csv-focus-position").textContent === "1 / 2", "position indicator");
  assert(c.querySelector(".csv-focus-notes").textContent === "A classic.", "notes body rendered");
  assert(c.querySelectorAll(".csv-focus-nav-btn").length === 3, "prev / random / next buttons");
  // Status renders as a chip; Title/Author/Notes don't.
  assert(c.querySelectorAll(".csv-kanban-chip").length === 1, "one meta chip (Status)");
});

await test("focus: next button advances and wraps", async () => {
  const rows = [{ Title: "A", Author: "", Notes: "" }, { Title: "B", Author: "", Notes: "" }];
  const view = focusView(rows);
  const c = document.body.createDiv();
  view.renderView = () => { c.empty(); renderFocus(view, c); };
  renderFocus(view, c);
  c.querySelectorAll(".csv-focus-nav-btn")[2].click(); // next
  assert(view.focusIndex === 1, "advanced to second entry");
  assert(c.querySelector(".csv-focus-title").textContent === "B", "card re-rendered");
  c.querySelectorAll(".csv-focus-nav-btn")[2].click(); // next wraps
  assert(view.focusIndex === 0, "wrapped back to first");
});

await test("focus: notes column same as title column isn't duplicated", async () => {
  // Quote-style file: first column is both the title and the notes column.
  const rows = [{ Quote: "To be or not to be", Author: "Shakespeare" }];
  const view = focusView(rows, {
    titleKey: () => undefined, getNotesCol: () => "Quote",
    getTitle: (r) => r.Quote, getSubtitle: (r) => r.Author,
  });
  view.headers = ["Quote", "Author"];
  const c = document.body.createDiv();
  renderFocus(view, c);
  assert(c.querySelector(".csv-focus-title").textContent === "To be or not to be", "quote as title");
  assert(!c.querySelector(".csv-focus-notes"), "no duplicated notes body");
});

await test("focus: clamps index when the list shrinks", async () => {
  const rows = [{ Title: "A", Author: "", Notes: "" }];
  const view = focusView(rows, { focusIndex: 5 });
  const c = document.body.createDiv();
  renderFocus(view, c);
  assert(view.focusIndex === 0, "index clamped");
  assert(c.querySelector(".csv-focus-title").textContent === "A", "card rendered");
});

// ── Table sorting ────────────────────────────────────────────────────────────
const { sortRowsByColumn } = await load("./src/utils.ts");

await test("sortRowsByColumn: numeric-aware, empties last, input untouched", async () => {
  const rows = [{ n: "10" }, { n: "" }, { n: "9" }, { n: "2" }];
  const asc = sortRowsByColumn(rows, "n", "asc");
  assert(asc.map(r => r.n).join(",") === "2,9,10,", "numeric asc with empty last");
  const desc = sortRowsByColumn(rows, "n", "desc");
  assert(desc.map(r => r.n).join(",") === "10,9,2,", "numeric desc with empty still last");
  assert(rows.map(r => r.n).join(",") === "10,,9,2", "original order untouched");
  const alpha = sortRowsByColumn([{ t: "banana" }, { t: "Apple" }], "t", "asc");
  assert(alpha[0].t === "Apple", "case-insensitive string sort");
});

await test("table: clicking a header cycles sort asc → desc → off", async () => {
  const rows = [{ Title: "B" }, { Title: "A" }];
  const view = {
    headers: ["Title"], rows, searchQuery: "", settings: { columnWidths: {} },
    tableSortCol: null, tableSortDir: "asc",
    getFilteredRows: () => rows, persistSettings: async () => {}, scheduleSave: () => {},
    openRowContextMenu: () => {}, isNotesCol: () => false, openNoteExpander: () => {},
    isSelectCol: () => false, renderSelectField: (td) => td, notesFileExists: () => false,
    openOrCreateNotes: () => {}, deleteWithUndo: () => {}, renderView: () => {},
  };
  const c = document.body.createDiv();
  const render = () => { c.empty(); renderTable(view, c); };
  view.renderView = render;
  render();
  const th = () => c.querySelector("th.csv-th-sortable");
  assert(th(), "headers are sortable");
  th().click();
  assert(view.tableSortCol === "Title" && view.tableSortDir === "asc", "first click sorts asc");
  assert(c.querySelector(".csv-th-sort-indicator").textContent.includes("▲"), "asc indicator");
  th().click();
  assert(view.tableSortDir === "desc", "second click flips to desc");
  th().click();
  assert(view.tableSortCol === null, "third click clears the sort");
});

// ── Mobile dashboard generation ──────────────────────────────────────────────
const { generateMobileFiles } = await load("./src/view/mobile.ts");

await test("mobile: writes a habit dashboard at Mobile/<file>.md", async () => {
  const created = [];
  const view = {
    file: { name: "habits.csv", basename: "habits", path: "Data/habits.csv", parent: { path: "Data" } },
    headers: ["date", "gym"],
    getDateCol: () => "date", getCategoryCol: () => null, getBooleanColumns: () => ["gym"],
    getStatusCol: () => null, titleKey: () => null, authorKey: () => null, resolveCol: () => null,
    app: { vault: {
      adapter: { exists: async () => true, mkdir: async () => {} },
      getAbstractFileByPath: () => null,
      create: async (p, c) => { created.push({ p, c }); },
      modify: async () => {},
    } },
  };
  await generateMobileFiles(view);
  assert(created.length === 1, "one dashboard created");
  assert(created[0].p === "Data/Mobile/habits.md", "dashboard path under Mobile/");
  assert(created[0].c.length > 0, "non-empty dashboard content");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`View smoke tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
