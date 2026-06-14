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

await test("library: nothing groupable shows empty state", async () => {
  const view = {
    headers: [], rows: [], fileCfg: {}, getCategoryCol: () => null, getStatusCol: () => null,
    getDateCol: () => null, isNotesCol: () => false,
    titleKey: () => undefined, authorKey: () => undefined,
  };
  const c = document.body.createDiv();
  renderLibrary(view, c);
  assert(c.querySelector(".csv-empty-state"), "empty state present");
});

await test("library: sort selector orders cards by year, newest first, undated last", async () => {
  const rows = [
    { Title: "Old", Category: "SciFi", Status: "", Year: "1979" },
    { Title: "Undated", Category: "SciFi", Status: "", Year: "" },
    { Title: "New", Category: "SciFi", Status: "", Year: "2021" },
  ];
  const view = {
    headers: ["Title", "Category", "Status", "Year"], rows, searchQuery: "",
    libraryStatusFilter: "all", libraryGenreFilter: "all",
    fileCfg: { librarySort: "year" }, saveFileCfg: () => {},
    getCategoryCol: () => "Category", getStatusCol: () => "Status",
    titleKey: () => "Title", authorKey: () => undefined,
    resolveCol: (cands) => (cands.includes("Year") ? "Year" : null),
    getNotesCol: () => null,
    renderView: () => {}, openNoteExpander: () => {}, openRowContextMenu: () => {},
  };
  const c = document.body.createDiv();
  renderLibrary(view, c);
  const selects = c.querySelectorAll(".csv-library-filter-select");
  assert(selects.length === 3, `status + genre + sort selects (got ${selects.length})`);
  const titles = Array.from(c.querySelectorAll(".csv-library-card-title")).map(t => t.textContent);
  assert(titles.join(",") === "New,Old,Undated", `newest first, undated last (got ${titles})`);
});

// ── Kanban view ──────────────────────────────────────────────────────────────
const { renderKanbanGenre } = await load("./src/view/kanban.ts");

function kanbanView(rows, overrides = {}) {
  return {
    headers: Object.keys(rows[0] ?? {}), rows, searchQuery: "", fileCfg: {},
    settings: { categoryColumn: "Category" },
    getDateCol: () => null,
    getCategoryCol: () => "Category", getStatusCol: () => "Status",
    getFilteredRows: () => rows, getNotesCol: () => null,
    getTitle: (r) => r.Title, getSubtitle: () => "",
    titleKey: () => "Title", authorKey: () => undefined,
    isNotesCol: () => false, isSelectCol: () => false, getColumnValues: () => [],
    notesFileExists: () => false, openOrCreateNotes: () => {}, openNoteExpander: () => {},
    openRowContextMenu: () => {}, scheduleSave: () => {}, saveFileCfg: () => {},
    renderView: () => {}, contentEl: document.body.createDiv(),
    ...overrides,
  };
}

await test("kanban: builds a column per genre with cards", async () => {
  const rows = [
    { Title: "Dune", Category: "SciFi", Status: "Finished" },
    { Title: "It", Category: "Horror", Status: "Not started" },
  ];
  const c = document.body.createDiv();
  renderKanbanGenre(kanbanView(rows), c);
  assert(c.querySelector(".csv-kanban-board"), "board present");
  assert(c.querySelectorAll(".csv-kanban-col").length === 2, "2 genre columns");
  assert(c.querySelectorAll(".csv-kanban-card").length === 2, "2 cards");
  assert(c.querySelector(".csv-kanban-groupbar select"), "group-by selector present");
});

await test("kanban: nothing groupable shows empty state", async () => {
  const view = {
    headers: [], rows: [], fileCfg: {}, settings: { categoryColumn: "Category" },
    getCategoryCol: () => null, getStatusCol: () => null, getDateCol: () => null,
    isNotesCol: () => false, titleKey: () => undefined,
  };
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  assert(c.querySelector(".csv-empty-state"), "empty state present");
});

await test("kanban: no category column auto-picks a fallback group column", async () => {
  // Travel-log shape: no Category, but `country` is nicely groupable.
  const rows = [
    { trip_id: "1", country: "FR", city: "Paris" },
    { trip_id: "2", country: "FR", city: "Lyon" },
    { trip_id: "3", country: "JP", city: "Tokyo" },
  ];
  const view = kanbanView(rows, {
    getCategoryCol: () => null,
    getTitle: (r) => r.trip_id, titleKey: () => "trip_id",
  });
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  assert(c.querySelector(".csv-kanban-board"), "board renders without a category column");
  assert(c.querySelectorAll(".csv-kanban-col").length >= 2, "grouped by the auto-picked column");
  const sel = c.querySelector(".csv-kanban-groupbar select");
  assert(sel, "group-by selector still offered for switching");
});

await test("kanban: explicit group-by column groups rows, empties get a — bucket", async () => {
  const rows = [
    { Title: "Fargo", Category: "Crime", Director: "Coen", Status: "" },
    { Title: "True Grit", Category: "Western", Director: "Coen", Status: "" },
    { Title: "Heat", Category: "Crime", Director: "", Status: "" },
  ];
  const view = kanbanView(rows, { fileCfg: { kanbanGroupCol: "Director" } });
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  const titles = Array.from(c.querySelectorAll(".csv-kanban-col-title")).map(t => t.textContent);
  assert(titles.join(",") === "Coen,—", `Coen column + — bucket for the empty Director (got ${titles})`);
  const coenCol = c.querySelectorAll(".csv-kanban-col")[0];
  assert(coenCol.querySelectorAll(".csv-kanban-card").length === 2, "both Coen films in one column");
});

await test("kanban: year-like group column buckets into decades", async () => {
  const rows = [
    { Title: "Goodfellas", Category: "Crime", Year: "1990", Status: "" },
    { Title: "Fargo", Category: "Crime", Year: "1996", Status: "" },
    { Title: "Heat", Category: "Crime", Year: "1995", Status: "" },
    { Title: "Dune", Category: "SciFi", Year: "2021", Status: "" },
  ];
  const view = kanbanView(rows, { fileCfg: { kanbanGroupCol: "Year" } });
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  const titles = Array.from(c.querySelectorAll(".csv-kanban-col-title")).map(t => t.textContent);
  assert(titles.join(",") === "1990s,2020s", `decade columns, not per-year (got ${titles})`);
  const nineties = c.querySelectorAll(".csv-kanban-col")[0];
  assert(nineties.querySelectorAll(".csv-kanban-card").length === 3, "three 90s films bucketed together");
});

await test("kanban: stale persisted group column falls back to category", async () => {
  const rows = [{ Title: "Dune", Category: "SciFi", Status: "" }];
  const view = kanbanView(rows, { fileCfg: { kanbanGroupCol: "Removed Column" } });
  const c = document.body.createDiv();
  renderKanbanGenre(view, c);
  const titles = Array.from(c.querySelectorAll(".csv-kanban-col-title")).map(t => t.textContent);
  assert(titles.join(",") === "SciFi", `falls back to Category grouping (got ${titles})`);
});

// ── Toolbar ──────────────────────────────────────────────────────────────────
const { renderToolbar } = await load("./src/view/toolbar.ts");

function toolbarView(overrides = {}) {
  return {
    file: { basename: "movies", path: "movies.csv" },
    rows: [{}, {}], mode: "table", searchQuery: "",
    isTravelFile: () => false, hasDateColumn: () => false, getCategoryCol: () => "Category",
    getStatusCol: () => null, authorKey: () => undefined, resolveCol: () => null,
    isNotesCol: () => false, getDateCol: () => null, titleKey: () => "Title",
    fileCfg: {}, app: {}, headers: ["Title", "Category"],
    renderView: () => {}, renderViewPreservingScroll: () => {}, saveFileCfg: () => {},
    autoDetectBooleanColumns: () => [], generateMobileFiles: () => {}, backupToArchive: () => {}, openAddModal: () => {},
    ...overrides,
  };
}

await test("toolbar: renders mode dropdown, search, row count, + Add", async () => {
  const view = toolbarView();
  const c = document.body.createDiv();
  renderToolbar(view, c);
  assert(c.querySelector(".csv-toolbar"), "toolbar present");
  const sel = c.querySelector(".csv-mode-select");
  assert(sel, "mode dropdown present");
  assert(sel.querySelectorAll("option").length === 5, "Cards + Kanban + Table + Focus + Stats (no travel/dashboard)");
  assert(sel.value === "table", "current mode selected");
  assert(c.querySelector(".csv-search-wrap"), "search bar present for non-dashboard mode");
  assert(c.querySelector(".csv-add-btn"), "+ Add button present");
  assert(c.querySelector(".csv-row-count").textContent === "2 entries", "row count reflects rows");
});

await test("toolbar: ungroupable date file gets Dashboard + Table + Focus", async () => {
  const view = toolbarView({
    file: { basename: "habits", path: "habits.csv" },
    rows: [{}], mode: "dashboard",
    hasDateColumn: () => true, getCategoryCol: () => null,
    getDateCol: () => "date", titleKey: () => undefined,
    headers: ["date", "gym"],
  });
  const c = document.body.createDiv();
  renderToolbar(view, c);
  const labels = Array.from(c.querySelectorAll(".csv-mode-select option")).map(o => o.textContent);
  assert(labels.join(",") === "Dashboard,Table,Focus", `no Cards/Kanban/Stats without groupable or chartable columns (got ${labels})`);
});

await test("toolbar: travel file with groupable columns gets the full dropdown", async () => {
  const view = toolbarView({
    file: { basename: "travel_flat", path: "travel_flat.csv" },
    mode: "travel",
    rows: [
      { date_entered: "2020-01-01", country: "FR", city: "Paris", source: "confirmed" },
      { date_entered: "2020-02-01", country: "JP", city: "Tokyo", source: "confirmed" },
      { date_entered: "2021-03-01", country: "FR", city: "Lyon", source: "inferred" },
    ],
    isTravelFile: () => true, hasDateColumn: () => true, getCategoryCol: () => null,
    getDateCol: () => "date_entered", titleKey: () => undefined,
    headers: ["date_entered", "country", "city", "source"],
  });
  const c = document.body.createDiv();
  renderToolbar(view, c);
  const labels = Array.from(c.querySelectorAll(".csv-mode-select option")).map(o => o.textContent);
  assert(labels.join(",") === "Travel,Dashboard,Cards,Kanban,Table,Focus",
    `Cards/Kanban via fallback group col + Focus no longer gated off travel files (got ${labels})`);
});

await test("toolbar: changing the mode dropdown switches the view", async () => {
  let rendered = 0;
  const view = toolbarView({ rows: [{}], renderView: () => { rendered++; } });
  const c = document.body.createDiv();
  renderToolbar(view, c);
  const sel = c.querySelector(".csv-mode-select");
  sel.value = "kanban-genre";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(view.mode === "kanban-genre", "mode updated from dropdown");
  assert(rendered === 1, "view re-rendered");
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

// ── Multi-select picker ──────────────────────────────────────────────────────
const { showSelectPicker, isMultiValueColName } = await load("./src/utils.ts");

await test("picker: isMultiValueColName matches list-shaped headers only", async () => {
  for (const h of ["Category", "categories", "Genre", "Genres", "Tags", "tag", "Theme", "Topics"]) {
    assert(isMultiValueColName(h), `${h} should be multi`);
  }
  for (const h of ["Status", "Rating", "Title", "Type", "category notes"]) {
    assert(!isMultiValueColName(h), `${h} should NOT be multi`);
  }
});

await test("picker: multi mode toggles values and live-commits the joined string", async () => {
  const anchor = document.body.createDiv();
  let committed = null;
  showSelectPicker(anchor, "Fiction", ["Fiction", "Classic", "Sci-Fi"], v => { committed = v; }, document.body, { multi: true });
  const picker = document.body.querySelector(".csv-select-picker");
  assert(picker, "picker mounted");
  assert(picker.querySelector(".csv-picker-done"), "multi picker has a Done button");
  const items = () => Array.from(picker.querySelectorAll(".csv-picker-item:not(.csv-picker-clear):not(.csv-picker-add)"));
  assert(items()[0].textContent === "✓ Fiction", "current value pre-checked");
  // Toggle Classic on → "Fiction, Classic", picker stays open.
  items().find(i => i.textContent.includes("Classic")).dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  assert(committed === "Fiction, Classic", `toggle on commits joined string (got "${committed}")`);
  assert(document.body.querySelector(".csv-select-picker"), "picker stays open after toggle");
  // Toggle Fiction off → "Classic".
  items().find(i => i.textContent.includes("Fiction")).dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  assert(committed === "Classic", `toggle off removes value (got "${committed}")`);
  // Clear all.
  picker.querySelector(".csv-picker-clear").dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  assert(committed === "", "clear-all commits empty string");
  picker.querySelector(".csv-picker-done").dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  assert(!document.body.querySelector(".csv-select-picker"), "Done dismisses");
});

await test("picker: multi mode splits comma-joined data values into options", async () => {
  const anchor = document.body.createDiv();
  showSelectPicker(anchor, "", ["Fiction, Classic", "Sci-Fi"], () => {}, document.body, { multi: true });
  const picker = document.body.querySelector(".csv-select-picker");
  const labels = Array.from(picker.querySelectorAll(".csv-picker-item")).map(i => i.textContent);
  assert(labels.includes("Fiction") && labels.includes("Classic") && labels.includes("Sci-Fi"),
    `joined values split into separate options (got ${labels})`);
  picker.remove();
});

await test("picker: single mode still commits and dismisses on pick", async () => {
  const anchor = document.body.createDiv();
  let committed = null;
  showSelectPicker(anchor, "", ["Read", "Reading"], v => { committed = v; }, document.body);
  const picker = document.body.querySelector(".csv-select-picker");
  picker.querySelector(".csv-picker-item").dispatchEvent(new window.Event("mousedown", { bubbles: true }));
  assert(committed === "Read", "single pick commits the value");
  assert(!document.body.querySelector(".csv-select-picker"), "single pick dismisses");
});

// ── Stats → library cross-link ───────────────────────────────────────────────

await test("stats: clicking a category bar jumps to the filtered library", async () => {
  const rows = [
    { Title: "Dune", Author: "", Category: "SciFi", Status: "Read", Rating: "" },
    { Title: "It", Author: "", Category: "Horror", Status: "Reading", Rating: "" },
  ];
  const view = { ...statsView(rows), mode: "stats", libraryStatusFilter: "all", libraryGenreFilter: "all", renderView: () => {} };
  const c = document.body.createDiv();
  renderStats(view, c);
  const bar = Array.from(c.querySelectorAll(".csv-stats-bar-row.is-clickable"))
    .find(r => r.querySelector(".csv-stats-bar-label").textContent === "SciFi");
  assert(bar, "category bar is clickable");
  bar.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(view.mode === "library", "switched to library mode");
  assert(view.libraryGenreFilter === "SciFi", "genre filter applied");
  assert(view.libraryStatusFilter === "all", "status filter untouched");
});

// ── availableModes / cycle source of truth ───────────────────────────────────
const { availableModes } = await load("./src/view/toolbar.ts");

await test("toolbar: availableModes is consistent with rendered buttons", async () => {
  const view = {
    rows: [{}], fileCfg: {}, headers: [], isTravelFile: () => false, hasDateColumn: () => false,
    getCategoryCol: () => "Category", getStatusCol: () => null, authorKey: () => undefined, resolveCol: () => null,
    isNotesCol: () => false, getDateCol: () => null, titleKey: () => undefined,
  };
  const ids = availableModes(view).map(m => m.id);
  assert(ids.join(",") === "library,kanban-genre,table,focus,stats", `expected full content-file set (got ${ids})`);
});

// ── csv-random block ─────────────────────────────────────────────────────────
const { renderRandomCard } = await load("./src/random-block.ts");

await test("csv-random: renders a quote card and ↻ re-rolls", async () => {
  const csv = "Quote,Author\nFirst quote,Alice\nSecond quote,Bob\n";
  const file = { basename: "quotes", extension: "csv", parent: { path: "Data" } };
  const app = { vault: { getAbstractFileByPath: (p) => (p === "Data/quotes.csv" || p === "Data/note.md" ? file : null), read: async () => csv } };
  const el = document.body.createDiv();
  await renderRandomCard(app, "file: quotes.csv", el, { sourcePath: "Data/note.md" });
  const text = el.querySelector(".csv-random-text");
  assert(text && text.textContent.includes("quote"), "quote text rendered");
  assert(el.querySelector(".csv-random-sub").textContent.startsWith("—"), "attribution rendered");
  el.querySelector(".csv-random-btn").dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(el.querySelector(".csv-random-text"), "re-roll re-renders a card");
});

await test("csv-random: missing file shows an error, no card", async () => {
  const app = { vault: { getAbstractFileByPath: () => null, read: async () => "" } };
  const el = document.body.createDiv();
  await renderRandomCard(app, "file: nope.csv", el, { sourcePath: "note.md" });
  assert(el.querySelector(".csv-add-error"), "error message shown");
  assert(!el.querySelector(".csv-random-card"), "no card rendered");
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
  // Labels are computed by the caller now (templates module is dependency-free).
  assert(created[0].c.includes('labels = ["Gym"]'), "title-cased habit label baked into the dataviewjs block");
});

// ── Shared mobile templates (single .mjs source) ─────────────────────────────
// The plugin (above) and regenerate-mobile-dashboards.mjs import the same
// module — assert node can load it directly and the output is well-formed.
const templates = await import("./src/mobile-templates.mjs");

await test("mobile templates: node-importable, library template embeds its keys", async () => {
  const md = templates.generateLibraryMobileDashboard({
    filePath: "../books.csv", csvPath: "Lib/books.csv",
    titleKey: "Title", categoryCol: "Category", statusCol: "Status",
    authorKey: "Author", yearCol: "Year", ratingCol: "Rating", themeCol: "",
    compactGrid: true,
  });
  assert(md.includes("file: ../books.csv"), "csv-add points at the data file");
  assert(md.includes('dv.io.csv("Lib/books.csv")'), "dataviewjs reads the canonical csv");
  assert(md.includes('const titleKey = "Title"'), "titleKey baked in");
  assert(md.includes("const compactGrid = true"), "compact grid flag baked in");
});

// ── Grouping helpers (kanban group-by) ───────────────────────────────────────
const { isYearLikeColumn, decadeLabel, pickFallbackGroupCol } = await load("./src/utils.ts");

await test("utils: pickFallbackGroupCol prefers a board-sized column, skips IDs and constants", async () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({
      id: String(i),                        // all-unique → skipped
      kind: "always-same",                  // single value → skipped
      country: ["FR", "JP", "US", "DE", "IT", "ES"][i % 6],
      flag: i % 2 ? "yes" : "no",           // groupable but tiny
    });
  }
  const pick = pickFallbackGroupCol(Object.keys(rows[0]), rows, new Set());
  assert(pick === "country", `country (6 groups) beats flag (2) and the degenerate columns (got ${pick})`);
  assert(pickFallbackGroupCol(["id"], rows, new Set()) === null, "nothing groupable → null");
  assert(pickFallbackGroupCol(["country"], [], new Set()) === null, "no rows → null");
  assert(pickFallbackGroupCol(["country"], rows, new Set(["country"])) === null, "excluded columns are skipped");
});

await test("utils: isYearLikeColumn by name and by values", async () => {
  assert(isYearLikeColumn("Year", []), "name match wins regardless of values");
  assert(isYearLikeColumn("Released", []), "Released counts as year-like");
  assert(isYearLikeColumn("foo", ["1994", "2001", "1987", "2020"]), "value-shape detection");
  assert(!isYearLikeColumn("foo", ["1994", "Drama", "Crime", "Noir"]), "mixed values rejected");
  assert(!isYearLikeColumn("foo", ["1994", "2001"]), "too few values to trust the shape");
});

await test("utils: decadeLabel buckets years, tolerates dates, rejects junk", async () => {
  assert(decadeLabel("1994") === "1990s", "plain year");
  assert(decadeLabel("2021-03-01") === "2020s", "year inside a date");
  assert(decadeLabel("1899") === "1890s", "19th century");
  assert(decadeLabel("") === null, "empty → null");
  assert(decadeLabel("unknown") === null, "non-year → null");
});

// ── Tasks view ────────────────────────────────────────────────────────────────
const { renderTasks, hasTaskColumns } = await load("./src/view/tasks.ts");

function tasksView(rows, overrides = {}) {
  const headers = Object.keys(rows[0] ?? {});
  const resolveCol = (cands) => {
    for (const cand of cands) {
      const f = headers.find(h => h.toLowerCase() === cand.toLowerCase());
      if (f) return f;
    }
    return null;
  };
  const view = {
    headers, rows, searchQuery: "",
    taskProjectFilter: "all", taskTypeFilter: "all",
    fileCfg: {}, resolveCol,
    titleKey: () => resolveCol(["Title", "Name"]) ?? undefined,
    getStatusCol: () => resolveCol(["Status", "State", "Done"]),
    getCategoryCol: () => null, getDateCol: () => null, isNotesCol: () => false,
    getTitle: (r) => r[resolveCol(["Name", "Title"]) ?? headers[0]] ?? "—",
    getColumnValues: (h) => Array.from(new Set(rows.map(r => r[h] ?? "").filter(Boolean))).sort(),
    getNotesCol: () => resolveCol(["Notes", "Note"]),
    notesFileExists: () => false,
    scheduleSave: () => {}, renderView: () => {},
    openNoteExpander: () => {}, openOrCreateNotes: () => {}, openRowContextMenu: () => {},
    contentEl: document.body.createDiv(),
    ...overrides,
  };
  return view;
}

await test("tasks: splits tasks vs notes and groups by project", async () => {
  const rows = [
    { Name: "Fix bug", Project: "Web", Type: "task", Status: "", Due: "", Priority: "high" },
    { Name: "Idea x", Project: "Web", Type: "idea", Status: "", Due: "", Priority: "" },
    { Name: "Buy yarn", Project: "Craft", Type: "task", Status: "", Due: "", Priority: "" },
    { Name: "Ref doc", Project: "Craft", Type: "reference", Status: "", Due: "", Priority: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  const headers = Array.from(c.querySelectorAll(".csv-tasks-section-header")).map(h => h.textContent);
  assert(headers.join(",") === "Tasks,Notes & Ideas", `both sections present (got ${headers})`);
  // 2 task groups (Web, Craft) + 2 notes groups (Web, Craft)
  assert(c.querySelectorAll(".csv-tasks-group").length === 4, "4 project groups across both sections");
  assert(c.querySelectorAll(".csv-tasks-table tbody tr").length === 4, "4 rows total");
  assert(c.querySelectorAll(".csv-tasks-type-pill").length === 2, "idea + reference render type pills");
});

await test("tasks: sorts done last, then by priority, then due", async () => {
  const rows = [
    { Name: "B-low", Project: "P", Type: "task", Status: "", Priority: "low", Due: "" },
    { Name: "A-high", Project: "P", Type: "task", Status: "", Priority: "high", Due: "" },
    { Name: "C-done", Project: "P", Type: "task", Status: "done", Priority: "high", Due: "" },
    { Name: "D-med", Project: "P", Type: "task", Status: "", Priority: "medium", Due: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  const order = Array.from(c.querySelectorAll(".csv-tasks-link")).map(l => l.textContent);
  assert(order.join(",") === "A-high,D-med,B-low,C-done", `priority order, done last (got ${order})`);
  assert(c.querySelector(".csv-tasks-link").classList.contains("csv-tasks-done") === false, "top row not struck through");
  assert(Array.from(c.querySelectorAll(".csv-tasks-link")).pop().classList.contains("csv-tasks-done"), "done row struck through");
});

await test("tasks: not-done past-due rows are flagged overdue", async () => {
  const rows = [
    { Name: "Late", Project: "P", Type: "task", Status: "", Due: "2000-01-01", Priority: "" },
    { Name: "Soon", Project: "P", Type: "task", Status: "", Due: "2999-01-01", Priority: "" },
    { Name: "LateDone", Project: "P", Type: "task", Status: "done", Due: "2000-01-01", Priority: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  assert(c.querySelectorAll(".csv-tasks-overdue").length === 1, "only the not-done past-due row is overdue");
});

await test("tasks: done toggle reuses the file's existing finished word", async () => {
  const rows = [
    { Name: "T1", Project: "P", Type: "task", Status: "", Priority: "", Due: "" },
    { Name: "T2", Project: "P", Type: "task", Status: "Completed", Priority: "", Due: "" },
  ];
  const view = tasksView(rows);
  const c = document.body.createDiv();
  renderTasks(view, c);
  // T1 sorts first (not done); click its checkbox.
  c.querySelector(".csv-tasks-check").click();
  assert(rows.find(r => r.Name === "T1").Status === "Completed", `wrote existing vocab (got ${rows[0].Status})`);
});

await test("tasks: no type column → everything is a task", async () => {
  const rows = [
    { Name: "One", Project: "P", Due: "2030-01-01", Priority: "high" },
    { Name: "Two", Project: "P", Due: "", Priority: "low" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  const headers = Array.from(c.querySelectorAll(".csv-tasks-section-header")).map(h => h.textContent);
  assert(headers.join(",") === "Tasks", "only a Tasks section");
  assert(c.querySelectorAll(".csv-tasks-table tbody tr").length === 2, "both rows are tasks");
});

await test("tasks: clicking a name opens the expander, not the filesystem", async () => {
  const rows = [{ Name: "T", Project: "P", Type: "task", Status: "", Notes: "body", Due: "", Priority: "" }];
  let expanded = 0, created = 0;
  const view = tasksView(rows, {
    openNoteExpander: () => { expanded++; },
    openOrCreateNotes: () => { created++; },
  });
  const c = document.body.createDiv();
  renderTasks(view, c);
  c.querySelector(".csv-tasks-link").click();      // name → overview
  c.querySelector(".csv-tasks-page-icon").click(); // icon → page
  assert(expanded === 1, "name click opened the expander");
  assert(created === 1, "only the page icon touches the filesystem");
});

await test("tasks: name falls back to page when there's no notes column", async () => {
  const rows = [{ Name: "T", Project: "P", Type: "task", Status: "", Due: "", Priority: "" }];
  let expanded = 0, created = 0;
  const view = tasksView(rows, {
    openNoteExpander: () => { expanded++; },
    openOrCreateNotes: () => { created++; },
  });
  const c = document.body.createDiv();
  renderTasks(view, c);
  c.querySelector(".csv-tasks-link").click();
  assert(expanded === 0 && created === 1, "no notes column → name opens/creates the page");
});

await test("tasks: hasTaskColumns gates the mode correctly", async () => {
  // due column alone qualifies
  assert(hasTaskColumns(tasksView([{ Name: "x", Due: "2030-01-01" }])), "due column → tasks file");
  // priority alone qualifies
  assert(hasTaskColumns(tasksView([{ Name: "x", Priority: "high" }])), "priority column → tasks file");
  // a type column carrying task/note values qualifies
  assert(hasTaskColumns(tasksView([{ Name: "x", Type: "task" }])), "type=task → tasks file");
  // a movies-style file (Type holds a genre, no due/priority) does NOT
  assert(!hasTaskColumns(tasksView([{ Title: "Dune", Type: "Fiction", Rating: "5" }])), "genre Type → not a tasks file");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`View smoke tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
