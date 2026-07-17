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
import { App as StubApp } from "./test-support/obsidian-stub.mjs";

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

await test("library: highlighted entry gets the highlight class on its title", async () => {
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
    isHighlighted: (r) => r.Title === "Dune",
  };
  const c = document.body.createDiv();
  renderLibrary(view, c);
  const titles = Array.from(c.querySelectorAll(".csv-library-card-title"));
  assert(titles.find(t => t.textContent.includes("Dune")).classList.contains("csv-title-highlight"), "highlighted card's title carries the class");
  assert(!titles.find(t => t.textContent.includes("It")).classList.contains("csv-title-highlight"), "non-highlighted card's title doesn't");
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

await test("kanban: rows with a blank status get their own \"—\" labeled group", async () => {
  const rows = [
    { Title: "Dune", Category: "SciFi", Status: "Finished" },
    { Title: "Foundation", Category: "SciFi", Status: "" },
    { Title: "Hyperion", Category: "SciFi", Status: "" },
  ];
  const c = document.body.createDiv();
  renderKanbanGenre(kanbanView(rows), c);
  const groups = Array.from(c.querySelectorAll(".csv-kanban-status-group"));
  assert(groups.length === 2, `finished group + one "—" group for the blank-status rows (got ${groups.length})`);
  const dashGroup = groups.find(g => g.querySelector(".csv-kanban-status-label")?.textContent === "—");
  assert(dashGroup, "a group is labeled \"—\"");
  assert(dashGroup.querySelectorAll(".csv-kanban-card").length === 2, "both blank-status rows land in the \"—\" group");
  // No bare cards sitting directly in the column body outside any group.
  const col = c.querySelector(".csv-kanban-col-body");
  const bareCards = Array.from(col.children).filter(el => el.classList.contains("csv-kanban-card"));
  assert(bareCards.length === 0, "no ungrouped cards left directly in the column body");
});

await test("kanban: a status value outside the canonical list still gets its own real label", async () => {
  const rows = [
    { Title: "Dune", Category: "SciFi", Status: "Finished" },
    { Title: "Rendezvous", Category: "SciFi", Status: "On hold" },
  ];
  const c = document.body.createDiv();
  renderKanbanGenre(kanbanView(rows), c);
  const labels = Array.from(c.querySelectorAll(".csv-kanban-status-label")).map(l => l.textContent);
  assert(labels.includes("On hold"), `an unrecognized-but-present status still gets its own label (got ${labels})`);
  assert(!labels.includes("—"), "no \"—\" group needed when every row has a real status value");
});

await test("kanban: highlighted entry gets the highlight class on its title", async () => {
  const rows = [
    { Title: "Dune", Category: "SciFi", Status: "Finished" },
    { Title: "It", Category: "Horror", Status: "Not started" },
  ];
  const c = document.body.createDiv();
  renderKanbanGenre(kanbanView(rows, { isHighlighted: (r) => r.Title === "Dune" }), c);
  const titles = Array.from(c.querySelectorAll(".csv-kanban-card-title"));
  assert(titles.find(t => t.textContent === "Dune").classList.contains("csv-title-highlight"), "highlighted card's title carries the class");
  assert(!titles.find(t => t.textContent === "It").classList.contains("csv-title-highlight"), "non-highlighted card's title doesn't");
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
    autoDetectBooleanColumns: () => [], backupToArchive: () => {}, openAddModal: () => {},
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

await test("focus: highlighted entry gets the highlight class on its title", async () => {
  const rows = [{ Title: "Dune", Author: "Herbert", Notes: "" }];
  const c = document.body.createDiv();
  renderFocus(focusView(rows, { isHighlighted: () => true }), c);
  assert(c.querySelector(".csv-focus-title").classList.contains("csv-title-highlight"), "highlighted entry's title carries the class");
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

// ── Boolean/habit-column auto-detection ─────────────────────────────────────
const { looksBoolean, isTruthyVal } = await load("./src/utils.ts");

await test("looksBoolean: empty column (no rows yet) is never boolean", async () => {
  // Regression test: [].every(...) is vacuously true in JS, which used to
  // misclassify every column as a toggle on a brand-new/empty sheet.
  assert(looksBoolean([]) === false, "an empty sheet's columns should not auto-toggle");
});

await test("looksBoolean: recognizes 0/1/true/false/yes/no/empty vocabularies", async () => {
  assert(looksBoolean(["0", "1", "1", ""]), "0/1/empty is boolean");
  assert(looksBoolean(["true", "false"]), "true/false is boolean");
  assert(looksBoolean(["yes", "no", ""]), "yes/no/empty is boolean");
  assert(!looksBoolean(["0", "1", "Task"]), "a non-boolean value disqualifies the column");
});

await test("isTruthyVal: narrow truth-list — only 1/true/yes (any case) read as checked", async () => {
  assert(isTruthyVal("1"), "1 is checked");
  assert(isTruthyVal("true"), "true is checked");
  assert(isTruthyVal("TRUE"), "case-insensitive");
  assert(isTruthyVal(" Yes "), "trims whitespace");
  assert(!isTruthyVal("0"), "0 is unchecked");
  assert(!isTruthyVal(""), "empty is unchecked");
  assert(!isTruthyVal("no"), "no is unchecked");
  assert(!isTruthyVal("false"), "false is unchecked");
  assert(!isTruthyVal("Maybe"), "any other leftover text reads as unchecked, not an error");
});

// ── Add Entry / Note Expander modals: title column is never categorical ────
const { AddEntryModal, NoteExpanderModal } = await load("./src/modals.ts");

function openAddModal(headers, rows, overrides = {}) {
  const isNotesCol = overrides.isNotesCol ?? (() => false);
  const isSelectCol = overrides.isSelectCol ?? (() => false);
  const getColumnValues = overrides.getColumnValues
    ?? ((h) => Array.from(new Set(rows.map(r => r[h] ?? "").filter(Boolean))).sort());
  const modal = new AddEntryModal(
    new StubApp(), headers, isNotesCol, isSelectCol, getColumnValues, () => {},
    overrides.optionPresets ?? {}, overrides.isBooleanCol ?? (() => false),
    overrides.isCategoricalCol, overrides.titleCol,
  );
  modal.contentEl = document.body.createDiv();
  modal.onOpen();
  return modal;
}

function fieldRowFor(modal, header) {
  return Array.from(modal.contentEl.querySelectorAll(".csv-modal-row"))
    .find(r => r.querySelector(".csv-modal-label")?.textContent.toLowerCase() === header.toLowerCase());
}

await test("add-entry: title column stays a text input even with few distinct values", async () => {
  const headers = ["Title", "Type"];
  const rows = [{ Title: "Alpha", Type: "Task" }, { Title: "Beta", Type: "Task" }];
  const modal = openAddModal(headers, rows);
  const titleRow = fieldRowFor(modal, "Title");
  assert(titleRow.querySelector("input.csv-modal-input"), "title renders as a plain text input");
  assert(!titleRow.querySelector("select"), "title never renders as a <select>");
});

await test("add-entry: title column stays text even when configured as a select column", async () => {
  const headers = ["Title", "Type"];
  const rows = [{ Title: "Alpha", Type: "Task" }];
  const modal = openAddModal(headers, rows, { isSelectCol: (h) => h === "Title" });
  const titleRow = fieldRowFor(modal, "Title");
  assert(titleRow.querySelector("input.csv-modal-input"), "title stays text even if explicitly marked a select column");
  assert(!titleRow.querySelector("select"), "no dropdown for title");
});

await test("add-entry: a genuinely categorical non-title column still gets a dropdown", async () => {
  const headers = ["Title", "Type"];
  const rows = [{ Title: "Alpha", Type: "Task" }, { Title: "Beta", Type: "Idea" }];
  const modal = openAddModal(headers, rows);
  const typeRow = fieldRowFor(modal, "Type");
  assert(typeRow.querySelector("select"), "non-title low-cardinality column still auto-categorizes");
});

await test("add-entry: an explicit isCategoricalCol override wins over auto-detection", async () => {
  // Notes gets 20 distinct values (would never auto-categorize), but an
  // explicit per-file override says it's categorical → dropdown.
  const headers = ["Title", "Notes"];
  const rows = Array.from({ length: 20 }, (_, i) => ({ Title: `T${i}`, Notes: `n${i}` }));
  const modal = openAddModal(headers, rows, { isCategoricalCol: (h) => h === "Notes" });
  const notesRow = fieldRowFor(modal, "Notes");
  assert(notesRow.querySelector("select"), "explicit override forces a dropdown even with many distinct values");
});

await test("add-entry: an explicit isCategoricalCol override can suppress auto-categorization", async () => {
  // Type would normally auto-categorize (2 distinct values), but an explicit
  // override that excludes it should keep it a plain text field.
  const headers = ["Title", "Type"];
  const rows = [{ Title: "Alpha", Type: "Task" }, { Title: "Beta", Type: "Idea" }];
  const modal = openAddModal(headers, rows, { isCategoricalCol: () => false });
  const typeRow = fieldRowFor(modal, "Type");
  assert(!typeRow.querySelector("select"), "override can un-categorize a naturally low-cardinality column");
  assert(typeRow.querySelector("input.csv-modal-input"), "falls back to a plain text field");
});

function openExpander(row, headers, overrides = {}) {
  const isNotesCol = overrides.isNotesCol ?? (() => false);
  const isSelectCol = overrides.isSelectCol ?? (() => false);
  const getColumnValues = overrides.getColumnValues ?? (() => []);
  const modal = new NoteExpanderModal(
    new StubApp(), row, overrides.notesCol ?? "", headers, "test.csv",
    isNotesCol, isSelectCol, getColumnValues, () => {}, undefined,
    overrides.isCategoricalCol, overrides.titleCol, overrides.isBooleanCol,
  );
  modal.contentEl = document.body.createDiv();
  modal.onOpen();
  return modal;
}

await test("note-expander: title column is never rendered as a select chip", async () => {
  const headers = ["Title", "Type"];
  const row = { Title: "Alpha", Type: "Task" };
  const modal = openExpander(row, headers, {
    isSelectCol: (h) => h === "Title",
    getColumnValues: () => ["Alpha", "Beta"],
  });
  const fieldRows = Array.from(modal.contentEl.querySelectorAll(".csv-expander-field-row"));
  const titleRow = fieldRows.find(r => r.querySelector(".csv-expander-field-label")?.textContent === "Title");
  assert(titleRow, "title field row exists");
  assert(!titleRow.querySelector(".csv-select-chip"), "title never renders as a select chip");
  assert(titleRow.querySelector(".csv-expander-field-value"), "title renders as a plain value field");
});

await test("note-expander: an explicit isCategoricalCol override wins over auto-detection", async () => {
  const headers = ["Title", "Notes"];
  const row = { Title: "Alpha", Notes: "some long free text" };
  const modal = openExpander(row, headers, {
    isCategoricalCol: (h) => h === "Notes",
    getColumnValues: () => ["a", "b", "c"],
  });
  const fieldRows = Array.from(modal.contentEl.querySelectorAll(".csv-expander-field-row"));
  const notesRow = fieldRows.find(r => r.querySelector(".csv-expander-field-label")?.textContent === "Notes");
  assert(notesRow.querySelector(".csv-select-chip"), "explicit override renders Notes as a select chip");
});

await test("note-expander: an explicit titleCol override drives the header, the field exclusion, and the delete label", async () => {
  // A file whose real identifier isn't named Title/Name (e.g. "Slug") would
  // otherwise fall back to headers[0] and get treated as an ordinary field —
  // this is what ⚙ Config's Title function is for.
  const headers = ["Slug", "Status"];
  const row = { Slug: "hello-world", Status: "Open" };
  let deletedLabel = null;
  const modal = openExpander(row, headers, {
    titleCol: "Slug",
    isCategoricalCol: () => true, // even if it would otherwise be categorical
    getColumnValues: () => ["Open", "Closed"],
  });
  assert(modal.contentEl.querySelector(".csv-expander-title").textContent === "hello-world", "header uses the overridden title column's value");
  const fieldRows = Array.from(modal.contentEl.querySelectorAll(".csv-expander-field-row"));
  const slugRow = fieldRows.find(r => r.querySelector(".csv-expander-field-label")?.textContent === "Slug");
  assert(!slugRow.querySelector(".csv-select-chip"), "the overridden title column is still excluded from the dropdown treatment");
});

await test("add-entry: an explicit titleCol override excludes a non-conventionally-named identifier from the dropdown", async () => {
  const headers = ["Slug", "Status"];
  const rows = [{ Slug: "a", Status: "Open" }, { Slug: "b", Status: "Open" }];
  const modal = openAddModal(headers, rows, { titleCol: "Slug" });
  const slugRow = fieldRowFor(modal, "Slug");
  assert(slugRow.querySelector("input.csv-modal-input"), "the overridden title column stays a plain text input");
  assert(!slugRow.querySelector("select"), "never a <select>, even with few distinct existing values");
});

await test("note-expander: a Checkbox-typed column edits as a toggle, not free text — value normalizes to 1/0", async () => {
  const headers = ["Title", "Watered"];
  const row = { Title: "Fern", Watered: "yes" }; // leftover non-0/1 vocabulary
  const modal = openExpander(row, headers, { isBooleanCol: (h) => h === "Watered" });
  const fieldRows = Array.from(modal.contentEl.querySelectorAll(".csv-expander-field-row"));
  const wateredFieldRow = fieldRows.find(r => r.querySelector(".csv-expander-field-label")?.textContent === "Watered");
  const toggle = wateredFieldRow.querySelector(".csv-toggle");
  assert(toggle, "renders as a toggle, not a text field or select chip");
  assert(toggle.hasClass("is-on"), "'yes' (not yet 0/1) still reads as checked via the same narrow truth-list");
  assert(!wateredFieldRow.querySelector(".csv-select-chip") && !wateredFieldRow.querySelector(".csv-expander-field-value"), "no fallback text/select rendering alongside the toggle");

  toggle.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(modal.row.Watered === "0", "clicking an on toggle normalizes the leftover 'yes' straight to '0', not back to some other word");
});

// ── FileConfigModal: per-column config table (⚙ Config panel) ───────────────
// Column | Type (Text/Checkbox/Categorical, exclusive) | Function
// (Title/Category/Status/Notes/Image/Anki front, exclusive) | Card field.
const { FileConfigModal } = await load("./src/modals.ts");

function openFileConfigModal(headers, current, autoDetectedCategorical, overrides = {}) {
  const autoDetectedRoles = { title: null, category: null, status: null, notes: null, image: null, anki: null, ...overrides.autoDetectedRoles };
  const modal = new FileConfigModal(
    new StubApp(), headers, "test.csv", current, overrides.autoDetectedHabits ?? [],
    autoDetectedCategorical, autoDetectedRoles, overrides.availableModes ?? [],
    overrides.onSave ?? (() => {}),
    overrides.getHeaders ?? (() => headers),
    overrides.getFileCfg ?? (() => current),
    overrides.onAddColumn ?? (() => null),
    overrides.onRemoveColumn ?? (() => {}),
    overrides.onCleanupBooleanColumn ?? (() => 0),
  );
  modal.contentEl = document.body.createDiv();
  modal.onOpen();
  return modal;
}

function colConfigRowFor(modal, header) {
  const rows = Array.from(modal.contentEl.querySelectorAll(".csv-modal-colcfg-table tbody tr"));
  return rows.find(r => r.querySelector(".csv-modal-colcfg-name > span")?.textContent === header);
}

function typeSelectFor(modal, header) { return colConfigRowFor(modal, header)?.querySelector(".csv-modal-colcfg-type"); }
function cardCheckboxFor(modal, header) { return colConfigRowFor(modal, header)?.querySelector(".csv-modal-colcfg-card-cell input[type=checkbox]"); }
function typeBadgeFor(modal, header) { return colConfigRowFor(modal, header)?.querySelector(".csv-modal-colcfg-type-cell .csv-modal-colcfg-auto-badge"); }

// Functions live in their own table (one row per role, a column select each).
// Row lookup is by role label; both tables share .csv-modal-colcfg-table, so
// filter on the presence of a role select.
const ROLE_LABELS = {
  title: "Title",
  category: "Column group (Kanban lanes)",
  status: "Row group / Status / Checkmark",
  notes: "Notes",
  image: "Image (card / kanban thumbnail)",
  anki: "Anki card front",
};
function funcRowFor(modal, role) {
  const rows = Array.from(modal.contentEl.querySelectorAll(".csv-modal-colcfg-table tbody tr"));
  return rows.find(r => r.querySelector(".csv-modal-colcfg-role")
    && r.querySelector(".csv-modal-colcfg-name")?.textContent === ROLE_LABELS[role]);
}
function funcSelectFor(modal, role) { return funcRowFor(modal, role)?.querySelector(".csv-modal-colcfg-role"); }
function fnBadgeFor(modal, role) { return funcRowFor(modal, role)?.querySelector(".csv-modal-colcfg-auto-badge"); }
function cleanupBtnFor(modal, header) { return colConfigRowFor(modal, header)?.querySelector(".csv-modal-colcfg-cleanup-btn"); }

function setSelect(sel, value) {
  sel.value = value;
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));
}

await test("FileConfigModal: Type reflects auto-detected categorical/checkbox; title never gets a picker", async () => {
  const headers = ["Title", "Type", "Notes"];
  const modal = openFileConfigModal(headers, {}, ["Type"], { autoDetectedHabits: ["Notes"] });
  assert(typeSelectFor(modal, "Type").value === "categorical", "auto-detected categorical column shows Categorical");
  assert(typeSelectFor(modal, "Type").hasClass("auto-detected"), "auto-detected Type gets the badge styling");
  assert(typeSelectFor(modal, "Notes").value === "checkbox", "auto-detected boolean column shows Checkbox");
  assert(!typeSelectFor(modal, "Title"), "title column gets no Type picker at all — it's always Text");
});

await test("FileConfigModal: Type is mutually exclusive — switching to Categorical removes a column from the habit list", async () => {
  const headers = ["Title", "Watched"];
  const modal = openFileConfigModal(headers, {}, [], { autoDetectedHabits: ["Watched"] });
  assert(typeSelectFor(modal, "Watched").value === "checkbox", "starts out auto-detected as Checkbox");

  setSelect(typeSelectFor(modal, "Watched"), "categorical");
  assert(modal.current.categoricalColumns.includes("Watched"), "now in the explicit categorical list");
  assert(!modal.current.habitColumns.includes("Watched"), "no longer in the habit list — a column is one Type, not two");
});

await test("FileConfigModal: a Checkbox column gets a Clean up action; other Types don't", async () => {
  const headers = ["Title", "Watched", "Genre"];
  const modal = openFileConfigModal(headers, {}, ["Genre"], { autoDetectedHabits: ["Watched"] });
  assert(cleanupBtnFor(modal, "Watched"), "Checkbox-typed column offers Clean up");
  assert(!cleanupBtnFor(modal, "Genre"), "Categorical-typed column does not");
  assert(!cleanupBtnFor(modal, "Title"), "the title column (no Type picker at all) does not");
});

await test("FileConfigModal: Clean up requires a confirm click, then calls onCleanupBooleanColumn once", async () => {
  const headers = ["Title", "Watched"];
  let calls = [];
  const modal = openFileConfigModal(headers, {}, [], {
    autoDetectedHabits: ["Watched"],
    onCleanupBooleanColumn: (h) => { calls.push(h); return 3; },
  });
  const btn = cleanupBtnFor(modal, "Watched");
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(calls.length === 0, "first click only asks for confirmation, doesn't act yet");
  assert(btn.textContent === "Confirm?", "button flips to a confirm state");

  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(calls.length === 1 && calls[0] === "Watched", "second click actually runs the cleanup, for the right column");
});

await test("FileConfigModal: an existing categoricalColumns config overrides the auto-detected Type pre-select", async () => {
  const headers = ["Title", "Type", "Notes"];
  const modal = openFileConfigModal(headers, { categoricalColumns: ["Notes"] }, ["Type"]);
  assert(typeSelectFor(modal, "Notes").value === "categorical", "configured column shows Categorical");
  assert(typeSelectFor(modal, "Type").value === "text", "auto-detected-but-not-configured column falls back to Text once an explicit list exists");
});

await test("FileConfigModal: assigning a Function to another column evicts the previous holder", async () => {
  const headers = ["Title", "Genre", "Watched"];
  const modal = openFileConfigModal(headers, { categoryColumn: "Genre" }, []);
  assert(funcSelectFor(modal, "category").value === "Genre", "Genre starts out holding the Category function");

  setSelect(funcSelectFor(modal, "category"), "Watched");
  assert(modal.current.categoryColumn === "Watched", "Watched now holds the Category function");
  assert(funcSelectFor(modal, "category").value === "Watched", "select re-renders showing the new holder");
});

await test("FileConfigModal: giving a column a new function clears its previous one — functions stay exclusive", async () => {
  const headers = ["Title", "Status"];
  const modal = openFileConfigModal(headers, { notesColumn: "Status" }, []);
  assert(funcSelectFor(modal, "notes").value === "Status");

  setSelect(funcSelectFor(modal, "status"), "Status");
  assert(modal.current.statusColumn === "Status", "Status column now holds the Status function");
  assert(!modal.current.notesColumn, "the old Notes assignment on the same column is cleared, not left dangling");
  assert(funcSelectFor(modal, "notes").value === "", "Notes row re-renders back to none");
});

await test("FileConfigModal: Title is a configurable Function, defaulting to the auto-detected Title/Name column", async () => {
  const headers = ["Name", "Author", "Rating"];
  const modal = openFileConfigModal(headers, {}, [], { autoDetectedRoles: { title: "Name" } });
  assert(funcSelectFor(modal, "title").value === "Name", "Title row shows the auto-detected Name column");
  assert(funcSelectFor(modal, "title").hasClass("auto-detected"));

  setSelect(funcSelectFor(modal, "title"), "Author");
  assert(modal.current.titleColumn === "Author", "Author now holds the Title function");
  assert(!funcSelectFor(modal, "title").hasClass("auto-detected"), "explicit pick drops the auto styling");
});

await test("FileConfigModal: type/function/card-field edits don't touch disk — only add/remove column does", async () => {
  const headers = ["Title", "Genre", "Watched"];
  let getFileCfgCalls = 0;
  const modal = openFileConfigModal(headers, {}, [], {
    getFileCfg: () => { getFileCfgCalls++; return {}; },
  });
  setSelect(funcSelectFor(modal, "category"), "Genre");
  setSelect(typeSelectFor(modal, "Watched"), "checkbox");
  cardCheckboxFor(modal, "Watched").dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(getFileCfgCalls === 0, "editing type/function/card-field is a pending, in-memory draft until Save — it must not refetch from disk");
});

await test("FileConfigModal: a name-detected Function shows an auto badge, no config needed", async () => {
  // Mirrors a real project-dashboard file: nothing in fileCfg, but "Status" already
  // resolves by name at render time (getStatusCol) — the row should show
  // that, not "— none —", which is what prompted this feature.
  const headers = ["Title", "Type", "Project", "Status"];
  const modal = openFileConfigModal(headers, {}, [], { autoDetectedRoles: { status: "Status" } });
  const sel = funcSelectFor(modal, "status");
  assert(sel.value === "Status", "Status row shows the name-detected column even with nothing saved");
  assert(sel.hasClass("auto-detected"), "auto-detected function select gets the auto-detected styling");
  assert(fnBadgeFor(modal, "status"), "row surfaces an auto badge");

  const notesSel = funcSelectFor(modal, "notes");
  assert(notesSel.value === "", "a function with no matching alias and no config shows — none —");
  assert(!fnBadgeFor(modal, "notes"), "no badge when there's nothing auto-detected for this function");
});

await test("FileConfigModal: an explicit override suppresses the auto badge, matching runtime resolution", async () => {
  // getStatusCol() never blends a name-based guess back in once statusColumn
  // is set — even to a different column — so the row should show the explicit
  // pick with no "auto" flag.
  const headers = ["Title", "Status", "Progress"];
  const modal = openFileConfigModal(headers, { statusColumn: "Progress" }, [], { autoDetectedRoles: { status: "Status" } });
  assert(funcSelectFor(modal, "status").value === "Progress", "the explicit override holds the Status function");
  assert(!funcSelectFor(modal, "status").hasClass("auto-detected"), "explicit picks aren't flagged as auto");
  assert(!fnBadgeFor(modal, "status"), "no auto badge once an override exists");
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

await test("tasks: splits tasks / notes / ideas into peer sections, grouped by project", async () => {
  const rows = [
    { Name: "Fix bug", Project: "Web", Type: "task", Status: "", Due: "", Priority: "high" },
    { Name: "Idea x", Project: "Web", Type: "idea", Status: "", Due: "", Priority: "" },
    { Name: "Buy yarn", Project: "Craft", Type: "task", Status: "", Due: "", Priority: "" },
    { Name: "Ref doc", Project: "Craft", Type: "reference", Status: "", Due: "", Priority: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  const headers = Array.from(c.querySelectorAll(".csv-tasks-section-header")).map(h => h.textContent);
  // Tasks pinned first; every other type value gets its own section, A→Z.
  assert(headers.join(",") === "Tasks,Idea,Reference", `three peer sections, Tasks first (got ${headers})`);
  // 2 task groups (Web, Craft) + 1 idea group (Web) + 1 reference group (Craft)
  assert(c.querySelectorAll(".csv-tasks-group").length === 4, "4 project groups across the three sections");
  assert(c.querySelectorAll(".csv-tasks-table tbody tr").length === 4, "4 rows total");
});

await test("tasks: empty type folds into Tasks; no other sections rendered blank", async () => {
  // All rows are task-like (incl. the empty type) → only the Tasks header.
  const rows = [
    { Name: "A", Project: "P", Type: "task", Status: "", Due: "", Priority: "" },
    { Name: "B", Project: "P", Type: "", Status: "", Due: "", Priority: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  const headers = Array.from(c.querySelectorAll(".csv-tasks-section-header")).map(h => h.textContent);
  assert(headers.join(",") === "Tasks", `only Tasks present (got ${headers})`);
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

await test("tasks: Notes/Ideas rows get a done checkmark too", async () => {
  const rows = [
    { Name: "Idea A", Project: "P", Type: "idea", Status: "", Due: "", Priority: "" },
    { Name: "Ref B", Project: "P", Type: "reference", Status: "done", Due: "", Priority: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows), c);
  const checks = c.querySelectorAll(".csv-tasks-check");
  assert(checks.length === 2, `Notes + Ideas rows both get a checkbox (got ${checks.length})`);
  assert(Array.from(checks).some(el => el.classList.contains("is-done")), "the already-done row renders checked");
  const notDone = Array.from(checks).find(el => !el.classList.contains("is-done"));
  notDone.click();
  assert(rows.find(r => r.Name === "Idea A").Status === "done", "clicking marks the idea done");
});

await test("tasks: highlighted entry gets the highlight class on its name link", async () => {
  const rows = [
    { Name: "A-high", Project: "P", Type: "task", Status: "", Priority: "high", Due: "" },
    { Name: "B-low", Project: "P", Type: "task", Status: "", Priority: "low", Due: "" },
  ];
  const c = document.body.createDiv();
  renderTasks(tasksView(rows, { isHighlighted: (r) => r.Name === "A-high" }), c);
  const links = Array.from(c.querySelectorAll(".csv-tasks-link"));
  assert(links.find(l => l.textContent === "A-high").classList.contains("csv-title-highlight"), "highlighted row's name carries the class");
  assert(!links.find(l => l.textContent === "B-low").classList.contains("csv-title-highlight"), "non-highlighted row's name doesn't");
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

// ── Budget view ──────────────────────────────────────────────────────────────
const { renderBudget, hasBudgetColumns, budgetPriceCol } = await load("./src/view/budget.ts");

function budgetView(rows, cfg = {}, overrides = {}) {
  let savedCfg = null;
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
    fileCfg: cfg, resolveCol,
    getFilteredRows: () => rows,
    saveFileCfg: (c) => { savedCfg = c; view.fileCfg = c; },
    getSavedCfg: () => savedCfg,
    renderView: () => {}, renderViewPreservingScroll: () => {},
    titleKey: () => resolveCol(["Title", "Name", "Item"]) ?? undefined,
    getCategoryCol: () => resolveCol(["Category"]),
    getDateCol: () => null, isNotesCol: () => false, isDateCol: () => false,
    getNotesCol: () => resolveCol(["Notes", "Note"]),
    notesFileExists: () => false,
    openNoteExpander: () => {}, openOrCreateNotes: () => {},
    scheduleSave: () => {}, openRowContextMenu: () => {},
    ...overrides,
  };
  return view;
}

await test("budget: hasBudgetColumns gates on a named/assigned price column only", async () => {
  assert(hasBudgetColumns(budgetView([{ Item: "Tent", Price: "10" }])), "named Price column → available");
  assert(hasBudgetColumns(budgetView([{ Item: "Tent", Cost: "10" }])), "named Cost alias → available");
  // A movies-style Rating column is numeric but not price-named — must NOT
  // silently enable Budget (that would be a chart-like broad heuristic,
  // deliberately avoided).
  assert(!hasBudgetColumns(budgetView([{ Title: "Dune", Rating: "5" }])), "unnamed numeric column → not budget-y");
  // Explicit fileCfg override wins even without a name match.
  assert(hasBudgetColumns(budgetView([{ Title: "Dune", Rating: "5" }], { budgetPriceCol: "Rating" })), "explicit override enables it");
  assert(budgetPriceCol(budgetView([{ Title: "Dune", Rating: "5" }], { budgetPriceCol: "Rating" })) === "Rating", "override resolves to that column");
});

await test("budget: rolls up per category and a grand total", async () => {
  const rows = [
    { Item: "Tent", Category: "Gear", Price: "120.00" },
    { Item: "Stove", Category: "Gear", Price: "45.50" },
    { Item: "Flights", Category: "Travel", Price: "300" },
  ];
  const c = document.body.createDiv();
  renderBudget(budgetView(rows), c);
  const chips = Array.from(c.querySelectorAll(".csv-budget-cat-chip")).map(el => el.textContent);
  assert(chips.some(t => t.includes("Gear") && t.includes("165.50")), `Gear subtotal 165.50 (got ${chips})`);
  assert(chips.some(t => t.includes("Travel") && t.includes("300.00")), `Travel subtotal 300.00 (got ${chips})`);
  assert(c.querySelector(".csv-budget-total-value").textContent === "465.50", "grand total sums every row");
  assert(c.querySelectorAll(".csv-tasks-group").length === 2, "one collapsible group per category");
  assert(c.querySelectorAll(".csv-tasks-table tbody tr").length === 3, "3 item rows total");
});

await test("budget: uncategorized rows fall into a single '—' bucket when there's no category column", async () => {
  const rows = [{ Item: "A", Price: "1" }, { Item: "B", Price: "2" }];
  const c = document.body.createDiv();
  renderBudget(budgetView(rows), c);
  assert(!c.querySelector(".csv-budget-cats"), "no chip row for a single implicit category");
  assert(c.querySelector(".csv-tasks-group-header").textContent.includes("—"), "uncategorized group header");
  assert(c.querySelector(".csv-budget-total-value").textContent === "3.00", "total still sums both rows");
});

await test("budget: total colors blue under the limit, red over it", async () => {
  const rows = [{ Item: "A", Price: "50" }, { Item: "B", Price: "60" }];
  const under = document.body.createDiv();
  renderBudget(budgetView(rows, { budgetLimit: 200 }), under);
  assert(under.querySelector(".csv-budget-total-value").classList.contains("is-under"), "110 of 200 reads as under");
  assert(!under.querySelector(".csv-budget-total-value").classList.contains("is-over"), "not flagged over");

  const over = document.body.createDiv();
  renderBudget(budgetView(rows, { budgetLimit: 100 }), over);
  assert(over.querySelector(".csv-budget-total-value").classList.contains("is-over"), "110 of 100 reads as over");
  assert(over.querySelector(".csv-budget-bar-fill").classList.contains("is-over"), "gauge fill also flips to over");

  const noLimit = document.body.createDiv();
  renderBudget(budgetView(rows), noLimit);
  const val = noLimit.querySelector(".csv-budget-total-value");
  assert(!val.classList.contains("is-under") && !val.classList.contains("is-over"), "no limit set → neutral, no bar");
  assert(!noLimit.querySelector(".csv-budget-bar"), "no gauge rendered without a limit");
});

await test("budget: editing the limit input persists to fileCfg", async () => {
  const rows = [{ Item: "A", Price: "50" }];
  const view = budgetView(rows);
  const c = document.body.createDiv();
  renderBudget(view, c);
  const input = c.querySelector(".csv-budget-limit-input");
  input.value = "150";
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(view.getSavedCfg()?.budgetLimit === 150, "typed limit saved to fileCfg");
});

await test("budget: price cells parse currency symbols and thousands separators", async () => {
  const rows = [
    { Item: "A", Price: "$1,200.50" },
    { Item: "B", Price: "45" },
  ];
  const c = document.body.createDiv();
  renderBudget(budgetView(rows), c);
  const shown = parseFloat(c.querySelector(".csv-budget-total-value").textContent.replace(/,/g, ""));
  assert(shown === 1245.5, `currency symbol + thousands separator both parse (got ${shown})`);
});

await test("budget: clicking an item opens the expander, not an inline edit", async () => {
  const rows = [{ Item: "Tent", Category: "Gear", Price: "10", Notes: "body" }];
  let expanded = 0, created = 0;
  const view = budgetView(rows, {}, {
    openNoteExpander: () => { expanded++; },
    openOrCreateNotes: () => { created++; },
  });
  const c = document.body.createDiv();
  renderBudget(view, c);
  assert(!c.querySelector(".csv-tasks-name-cell input"), "no inline text input on the item cell");
  c.querySelector(".csv-tasks-link").click();      // item name → overview
  c.querySelector(".csv-tasks-page-icon").click(); // icon → page
  assert(expanded === 1, "item click opened the expander");
  assert(created === 1, "only the page icon touches the filesystem");
});

// ── Anki sync ────────────────────────────────────────────────────────────────
const { syncToAnki, ankiFrontCol } = await load("./src/view/anki.ts");

// A quotes-shaped view stub. resolveCol does case-insensitive header matching,
// mirroring CardView.resolveCol closely enough for front-column resolution.
function ankiView(headers, rows, cfg = {}, basename = "quotes") {
  return {
    file: { basename },
    fileCfg: cfg,
    headers,
    rows,
    titleKey: () => headers.find(h => ["title", "name"].includes(h.toLowerCase())) ?? undefined,
    resolveCol: (cands) => headers.find(h => cands.some(c => c.toLowerCase() === h.toLowerCase())) ?? null,
  };
}

const QUOTE_HEADERS = ["Author", "Category", "Quote", "Where", "Written In"];

await test("anki: front column falls back to a content column, not the first column", () => {
  // No Title/Name → should pick Quote, not the literal first header (Author).
  const view = ankiView(QUOTE_HEADERS, []);
  assert(ankiFrontCol(view) === "Quote", "quotes front resolves to Quote");
  // Per-file override wins outright.
  const overridden = ankiView(QUOTE_HEADERS, [], { ankiFrontCol: "Author" });
  assert(ankiFrontCol(overridden) === "Author", "configured front column wins");
  // A stale/unknown configured column is ignored (falls back).
  const stale = ankiView(QUOTE_HEADERS, [], { ankiFrontCol: "Ghost" });
  assert(ankiFrontCol(stale) === "Quote", "unknown configured column falls back");
});

await test("anki: builds Basic notes (front = front col, back = other fields) and counts adds", async () => {
  let createdDeck = null;
  let sentNotes = null;
  globalThis.__ankiRequestUrl = (opts) => {
    const { action, params } = JSON.parse(opts.body);
    if (action === "createDeck") { createdDeck = params.deck; return { json: { result: 1, error: null } }; }
    if (action === "addNotes") {
      sentNotes = params.notes;
      // First row added, second a duplicate (null).
      return { json: { result: [1111, null], error: null } };
    }
    return { json: { result: null, error: null } };
  };
  const rows = [
    { Author: "Marcus Aurelius", Category: "Stoicism", Quote: "Waste no more time arguing", Where: "Meditations", "Written In": "180" },
    { Author: "Anon", Category: "", Quote: "Be water", Where: "", "Written In": "" },
  ];
  await syncToAnki(ankiView(QUOTE_HEADERS, rows));

  assert(createdDeck === "quotes", "deck named after the file basename");
  assert(sentNotes.length === 2, "one note per row");
  assert(sentNotes[0].modelName === "Basic", "uses the Basic model");
  assert(sentNotes[0].fields.Front === "Waste no more time arguing", "front is the Quote value");
  assert(sentNotes[0].fields.Back.includes("Author:") && sentNotes[0].fields.Back.includes("Marcus Aurelius"), "back carries the other columns");
  assert(!sentNotes[0].fields.Back.includes("Waste no more time"), "front column excluded from the back");
  // Empty cells are skipped on the back (row 2 has only Author + Quote).
  assert(!sentNotes[1].fields.Back.includes("Where:"), "empty columns omitted from back");
  assert(sentNotes[0].options.allowDuplicate === false && sentNotes[0].options.duplicateScope === "deck", "dedupes within the deck");
  delete globalThis.__ankiRequestUrl;
});

await test("anki: HTML-escapes cell values so markup renders as text", async () => {
  let sentNotes = null;
  globalThis.__ankiRequestUrl = (opts) => {
    const { action, params } = JSON.parse(opts.body);
    if (action === "addNotes") { sentNotes = params.notes; return { json: { result: [1], error: null } }; }
    return { json: { result: 1, error: null } };
  };
  await syncToAnki(ankiView(["Phrase", "Meaning"], [{ Phrase: "a<b>", Meaning: "x & y" }], {}, "dictionary"));
  assert(sentNotes[0].fields.Front === "a&lt;b&gt;", "front escaped");
  assert(sentNotes[0].fields.Back.includes("x &amp; y"), "back escaped");
  delete globalThis.__ankiRequestUrl;
});

await test("anki: surfaces a transport failure instead of throwing", async () => {
  globalThis.__ankiRequestUrl = () => { throw new Error("ECONNREFUSED"); };
  // Should resolve (error caught + shown as a Notice), not reject.
  let threw = false;
  try { await syncToAnki(ankiView(["Phrase", "Meaning"], [{ Phrase: "x", Meaning: "y" }])); }
  catch { threw = true; }
  assert(!threw, "connection failure is caught, not propagated");
  delete globalThis.__ankiRequestUrl;
});

// ── Formula evaluator ────────────────────────────────────────────────────────
const { compileFormula } = await load("./src/formula.ts");

await test("formula: polynomial, implicit multiplication, constants, functions", async () => {
  assert(compileFormula("2x^2 - 3x + 1")(2) === 3, "2x^2-3x+1 at x=2");
  assert(compileFormula("3(x+1)")(2) === 9, "implicit mult over parens");
  assert(Math.abs(compileFormula("sin(pi/2)")(0) - 1) < 1e-12, "sin(pi/2) = 1");
  assert(compileFormula("2^3^2")(0) === 512, "^ is right-associative");
  assert(compileFormula("y = -x^2")(3) === -9, "leading y= allowed; -x^2 = -(x^2)");
  assert(compileFormula("max(x, 5)")(2) === 5, "two-arg function");
  assert(compileFormula("10 sin(x)")(0) === 0, "implicit mult before function call");
});

await test("formula: bad input throws readable errors", async () => {
  for (const bad of ["", "2 +", "(x", "foo(x)", "x $ 2", "sin x"]) {
    let threw = false;
    try { compileFormula(bad); } catch { threw = true; }
    assert(threw, `"${bad}" should throw`);
  }
});

// ── Chart view ───────────────────────────────────────────────────────────────
const { renderChart, hasChartColumns, parseNumeric, numericColumns, linearFit, buildChartConfig, extractSeries, hueColumns, aggregateBars, buildBarConfig, rollingMean, bucketPoints } =
  await load("./src/view/chart.ts");

await test("chart: parseNumeric handles separators and rejects text", async () => {
  assert(parseNumeric("1,234") === 1234, "thousands comma");
  assert(parseNumeric("1 234") === 1234, "thousands space");
  assert(parseNumeric("3,5") === 3.5, "decimal comma");
  assert(parseNumeric("-2.5e3") === -2500, "scientific");
  assert(parseNumeric("abc") === null, "text rejected");
  assert(parseNumeric("") === null, "empty rejected");
});

await test("chart: numericColumns needs 2+ values at a 70%+ hit rate", async () => {
  const rows = [
    { title: "A", score: "1", year: "n/a" },
    { title: "B", score: "2", year: "1999" },
    { title: "C", score: "3", year: "" },
  ];
  const cols = numericColumns(["title", "score", "year"], rows);
  assert(cols.join(",") === "score", `only score qualifies (got ${cols})`);
});

await test("chart: linearFit recovers an exact line with R² = 1", async () => {
  const fit = linearFit([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]);
  assert(Math.abs(fit.slope - 2) < 1e-12 && Math.abs(fit.intercept - 1) < 1e-12, "y = 2x + 1");
  assert(fit.r2 === 1, "perfect fit");
  assert(linearFit([{ x: 1, y: 1 }, { x: 1, y: 2 }]) === null, "no X spread → null");
});

const chartColors = { accent: "#38d", muted: "#888", grid: "#ccc", fitLine: "#999", formula: "#e83", series: ["#111", "#222", "#333"] };
const oneSeries = (points) => [{ label: "", points }];

await test("chart: buildChartConfig adds fit + formula datasets and fit text", async () => {
  const built = buildChartConfig({
    series: oneSeries([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]),
    xIsDate: false, xLabel: "x", yLabel: "score", connect: false,
    fit: "linear", formula: "2x + 1",
  }, chartColors);
  assert(built.config.data.datasets.length === 3, "points + fit + formula datasets");
  assert(built.fitText.startsWith("y = 2x + 1"), `fit equation (got "${built.fitText}")`);
  assert(built.fitText.includes("R² = 1.000"), "R² shown");
  assert(built.formulaError === null, "formula compiled");
});

await test("chart: date X gets per-day trend text; bad formula surfaces error", async () => {
  const day = 86_400_000;
  const built = buildChartConfig({
    series: oneSeries([{ x: 0, y: 0 }, { x: day, y: 2 }, { x: 2 * day, y: 4 }]),
    xIsDate: true, xLabel: "date", yLabel: "km", connect: true,
    fit: "linear", formula: "foo(x)",
  }, chartColors);
  assert(built.fitText.startsWith("Trend: +2 km/day"), `per-day phrasing (got "${built.fitText}")`);
  assert(built.formulaError !== null, "bad formula reported, not thrown");
});

await test("chart: hue split — one colored dataset per series, per-series fits off the legend", async () => {
  const built = buildChartConfig({
    series: [
      { label: "A", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }] },
      { label: "B", points: [{ x: 0, y: 5 }, { x: 1, y: 4 }] },
    ],
    xIsDate: false, xLabel: "x", yLabel: "score", connect: false,
    fit: "linear", formula: "",
  }, chartColors);
  const ds = built.config.data.datasets;
  assert(ds.length === 4, `2 point datasets + 2 fit datasets (got ${ds.length})`);
  const pointSets = ds.filter(d => !d.csvIsFit);
  assert(pointSets[0].label === "A" && pointSets[1].label === "B", "series labeled by hue value");
  assert(pointSets[0].backgroundColor !== pointSets[1].backgroundColor, "distinct palette colors");
  const fits = ds.filter(d => d.csvIsFit);
  assert(fits.length === 2 && fits[0].borderColor === pointSets[0].backgroundColor, "fit keeps its series color");
  assert(built.fitText.includes("A:") && built.fitText.includes("B:"), `per-series fit text (got "${built.fitText}")`);
  const legend = built.config.options.plugins.legend;
  assert(legend.display === true, "legend shown for hue split");
  assert(legend.labels.filter({ datasetIndex: ds.indexOf(fits[0]) }) === false, "fit datasets filtered from legend");
  assert(legend.labels.filter({ datasetIndex: 0 }) === true, "point datasets stay in legend");
});

await test("chart: extractSeries buckets by hue (empty → —); hueColumns needs 2–10 distinct", async () => {
  const rows = [
    { name: "a", who: "Anna", val: "1" },
    { name: "b", who: "Ben", val: "2" },
    { name: "c", who: "", val: "3" },
  ];
  const { series, skipped } = extractSeries(rows, "(row number)", "val", "who", null, false, () => null, r => r.name);
  assert(skipped === 0, "all rows numeric");
  assert(series.map(s => s.label).join(",") === "Anna,Ben,—", `A→Z with — bucket (got ${series.map(s => s.label)})`);
  assert(hueColumns(["name", "who", "val"], rows, new Set(["name"])).join(",") === "who,val",
    "low-cardinality columns qualify, excluded ones don't");
});

await test("chart: size-by maps values to sqrt-scaled radii; tooltip label wired", async () => {
  const rows = [
    { name: "a", val: "1", weight: "0" },
    { name: "b", val: "2", weight: "25" },
    { name: "c", val: "3", weight: "100" },
  ];
  const { series } = extractSeries(rows, "(row number)", "val", null, "weight", false, () => null, r => r.name);
  const built = buildChartConfig({
    series, xIsDate: false, xLabel: "x", yLabel: "val", connect: false, fit: "none", formula: "", sizeLabel: "weight",
  }, chartColors);
  const radii = built.config.data.datasets[0].pointRadius;
  assert(Array.isArray(radii), "per-point radii when size-by set");
  assert(radii[0] === 3 && radii[2] === 14, `sqrt scale endpoints 3→14 (got ${radii})`);
  assert(Math.abs(radii[1] - 8.5) < 0.01, `25 of 100 → sqrt(0.25)=half-way radius (got ${radii[1]})`);
});

await test("chart: aggregateBars counts/sums/averages per category, hue → grouped, multi-value X splits", async () => {
  const rows = [
    { Genre: "Drama, Crime", Rating: "4", Who: "Anna" },
    { Genre: "Drama", Rating: "2", Who: "Ben" },
    { Genre: "Crime", Rating: "3", Who: "Anna" },
    { Genre: "", Rating: "5", Who: "Ben" },
  ];
  const count = aggregateBars(rows, "Genre", null, null, "count");
  assert(count.categories.join(",") === "Crime,Drama,—", `A→Z with — last (got ${count.categories})`);
  assert(count.series[0].values.join(",") === "2,2,1", "multi-value row counts once per genre");

  const avg = aggregateBars(rows, "Genre", "Rating", null, "avg");
  assert(avg.series[0].values.join(",") === "3.5,3,5", `avg per category (got ${avg.series[0].values})`);

  const sum = aggregateBars(rows, "Genre", "Rating", "Who", "sum");
  assert(sum.series.map(s => s.label).join(",") === "Anna,Ben", "hue split into grouped series");
  assert(sum.series[0].values.join(",") === "7,4,0", `Anna's sums (got ${sum.series[0].values})`);
  assert(sum.series[1].values.join(",") === "0,2,5", `Ben's sums (got ${sum.series[1].values})`);

  const cfg = buildBarConfig(sum, "Genre", "sum(Rating)", chartColors);
  assert(cfg.type === "bar" && cfg.data.labels.join(",") === "Crime,Drama,—", "bar config carries categories");
  assert(cfg.data.datasets.length === 2 && cfg.data.datasets[0].backgroundColor !== cfg.data.datasets[1].backgroundColor,
    "grouped bars with distinct colors");
});

await test("chart: rollingMean averages a centered time window; bucketPoints aggregates weeks", async () => {
  const day = 86_400_000;
  const pts = [0, 1, 2, 3, 4].map(i => ({ x: i * day, y: i * 10 })); // 0,10,20,30,40
  const smoothed = rollingMean(pts, 2 * day); // ±1 day window
  assert(smoothed[0].y === 5, `edge point averages itself + next (got ${smoothed[0].y})`);
  assert(smoothed[2].y === 20, `interior point averages neighbours (got ${smoothed[2].y})`);

  // Mon 2026-01-05 .. Wed 2026-01-14 spans two ISO weeks.
  const t = (d) => new Date(2026, 0, d).getTime();
  const weekPts = [
    { x: t(5), y: 1 }, { x: t(7), y: 2 },   // week of Jan 5
    { x: t(12), y: 4 }, { x: t(14), y: 6 }, // week of Jan 12
  ];
  const sums = bucketPoints(weekPts, "week", "sum");
  assert(sums.length === 2 && sums[0].y === 3 && sums[1].y === 10, `weekly sums (got ${sums.map(p => p.y)})`);
  assert(sums[0].x === t(5) && sums[1].x === t(12), "buckets keyed to local Mondays");
  const avgs = bucketPoints(weekPts, "week", "avg");
  assert(avgs[0].y === 1.5 && avgs[1].y === 5, "weekly averages");
  const counts = bucketPoints(weekPts, "month", "count");
  assert(counts.length === 1 && counts[0].y === 4, "monthly count collapses to one bucket");
});

await test("chart: smoothing renders raw dots off the legend + a mean line per series", async () => {
  const day = 86_400_000;
  const built = buildChartConfig({
    series: [{ label: "A", points: [{ x: 0, y: 0 }, { x: day, y: 10 }] },
             { label: "B", points: [{ x: 0, y: 5 }, { x: day, y: 5 }] }],
    xIsDate: true, xLabel: "date", yLabel: "km", connect: true,
    fit: "none", formula: "", smoothDays: 7,
  }, chartColors);
  const ds = built.config.data.datasets;
  assert(ds.length === 4, `dots + line per series (got ${ds.length})`);
  const dots = ds.filter(d => d.csvSkipLegend);
  assert(dots.length === 2 && dots.every(d => d.type === "scatter"), "raw dots flagged off the legend");
  const lines = ds.filter(d => !d.csvSkipLegend);
  assert(lines.every(d => d.type === "line" && d.pointRadius === 0), "smoothed lines carry the legend");
  assert(built.config.options.plugins.legend.labels.filter({ datasetIndex: ds.indexOf(dots[0]) }) === false,
    "legend filter drops the raw dots");
});

await test("chart: date X offers By/Smooth controls; bucketing hides Size", async () => {
  const rows = [
    { date: "2026-01-05", km: "3", effort: "2" },
    { date: "2026-01-07", km: "4", effort: "5" },
    { date: "2026-01-12", km: "5", effort: "9" },
  ];
  const view = chartView(rows, { chartXCol: "date", chartYCol: "km" });
  const c = document.body.createDiv();
  await renderChart(view, c);
  let labels = Array.from(c.querySelectorAll(".csv-chart-control-label")).map(l => l.textContent);
  assert(labels.includes("By"), `By select present for date X (got ${labels})`);
  assert(c.querySelector(".csv-chart-smooth-btn"), "Smooth toggle present");
  assert(labels.includes("Size"), "Size present un-bucketed");

  const bucketed = chartView(rows, { chartXCol: "date", chartYCol: "km", chartBucket: "week" });
  const c2 = document.body.createDiv();
  await renderChart(bucketed, c2);
  labels = Array.from(c2.querySelectorAll(".csv-chart-control-label")).map(l => l.textContent);
  assert(labels.includes("Agg"), "bucket Agg select present");
  assert(!labels.includes("Size"), "Size hidden when bucketing");
  assert(!c2.querySelector(".csv-chart-smooth-btn"), "Smooth hidden when bucketing");
});

await test("tasks-block: buildAggregate maps mixed schemas onto canonical columns", async () => {
  const { buildAggregate, writeBack } = await load("./src/tasks-block.ts");
  const agg = buildAggregate([
    {
      basename: "Website",
      headers: ["Title", "Priority", "Due", "Status", "Notes"], // no Project/Type
      rows: [{ Title: "Fix nav", Priority: "high", Due: "2026-08-01", Status: "", Notes: "top bar" }],
    },
    {
      basename: "Life",
      headers: ["name", "kind", "project", "deadline", "state"], // aliased everything
      rows: [{ name: "Renew membership", kind: "task", project: "Admin", deadline: "2026-09-01", state: "done" }],
    },
  ]);
  assert(agg.headers.join(",") === "Title,Type,Project,Priority,Due,Status,Notes", "canonical header set");
  assert(agg.rows.length === 2 && agg.refs.length === 2, "one canonical row per source row");
  assert(agg.rows[0].Project === "Website", "file basename fills a missing Project column");
  const r = agg.rows[1];
  assert(r.Title === "Renew membership" && r.Type === "task" && r.Project === "Admin"
    && r.Due === "2026-09-01" && r.Status === "done", `aliases resolved (got ${JSON.stringify(r)})`);

  // Write-through: edit the canonical row, push back to the source row.
  r.Status = "";
  r.Due = "2026-10-01";
  writeBack(r, agg.refs[1]);
  const src = agg.refs[1].srcRow;
  assert(src.state === "" && src.deadline === "2026-10-01", "edits land on the aliased source columns");
  // The basename-Project is synthetic — nothing to write back to, and the
  // unmapped column must not be invented on the source row.
  writeBack(agg.rows[0], agg.refs[0]);
  assert(!("Project" in agg.refs[0].srcRow), "synthetic Project never written to the source");
});

await test("tasks-block: aggregate rows render through renderTasks with per-file projects", async () => {
  const { buildAggregate } = await load("./src/tasks-block.ts");
  const agg = buildAggregate([
    { basename: "Website", headers: ["Title", "Due", "Status"], rows: [{ Title: "Fix nav", Due: "", Status: "" }] },
    { basename: "Life", headers: ["Title", "Due", "Status"], rows: [{ Title: "Membership", Due: "", Status: "" }] },
  ]);
  const view = tasksView(agg.rows, {
    headers: agg.headers,
    resolveCol: (cands) => cands.map(c => agg.headers.find(h => h.toLowerCase() === c.toLowerCase())).find(Boolean) ?? null,
    titleKey: () => "Title",
    getStatusCol: () => "Status",
    getNotesCol: () => "Notes",
  });
  const c = document.body.createDiv();
  renderTasks(view, c);
  const groups = Array.from(c.querySelectorAll(".csv-tasks-group-header")).map(g => g.textContent.trim());
  assert(groups.some(g => g.includes("Website")) && groups.some(g => g.includes("Life")),
    `each file becomes a project group (got ${groups})`);
});

await test("sync: conflict stash writes the diverged disk version to Archive", async () => {
  const { stashSyncConflict } = await load("./src/utils.ts");
  const writes = {};
  const mkdirs = [];
  const app = { vault: { adapter: {
    exists: async () => false,
    mkdir: async (p) => { mkdirs.push(p); },
    write: async (p, c) => { writes[p] = c; },
  } } };
  const file = { name: "tasks.csv", basename: "tasks", parent: { path: "Projects" } };
  const path = await stashSyncConflict(app, file, "a,b\n1,2\n");
  assert(mkdirs[0] === "Projects/Archive", "creates the Archive folder");
  assert(path.startsWith("Projects/Archive/tasks sync-conflict "), `stash path (got ${path})`);
  assert(writes[path] === "a,b\n1,2\n", "disk version preserved verbatim");
});

await test("chart: picking a categorical X renders bar mode with an Agg control", async () => {
  const rows = [
    { title: "A", genre: "Drama", rating: "4" },
    { title: "B", genre: "Crime", rating: "2" },
    { title: "C", genre: "Drama", rating: "5" },
  ];
  const view = chartView(rows, { chartXCol: "genre", chartAgg: "avg", chartYCol: "rating" });
  const c = document.body.createDiv();
  await renderChart(view, c);
  const labels = Array.from(c.querySelectorAll(".csv-chart-control-label")).map(l => l.textContent);
  assert(labels.includes("Agg"), `Agg select present in bar mode (got ${labels})`);
  assert(!c.querySelector(".csv-chart-fit-btn"), "no fit toggle in bar mode");
  assert(!c.querySelector(".csv-chart-formula-input"), "no formula overlay in bar mode");
  assert(c.querySelector("canvas.csv-chart-canvas"), "canvas present");
  assert(view.chartInstance, "Chart instance created");
});

function chartView(rows, cfg = {}) {
  let savedCfg = null;
  const view = {
    rows, headers: Object.keys(rows[0] ?? {}), searchQuery: "",
    getFilteredRows: () => rows,
    fileCfg: cfg, saveFileCfg: (c) => { savedCfg = c; view.fileCfg = c; },
    getDateCol: () => (Object.keys(rows[0] ?? {}).includes("date") ? "date" : null),
    isDateCol: (h) => h === "date",
    parseDate: (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + "T00:00:00") : null),
    getTitle: (r) => r[Object.keys(r)[0]] ?? "—",
    titleKey: () => undefined,
    isNotesCol: () => false,
    chartInstance: null,
    renderView: () => {}, renderViewPreservingScroll: () => {},
    getSavedCfg: () => savedCfg,
  };
  return view;
}

await test("chart: renders controls, canvas, and fit text over a numeric file", async () => {
  const rows = [
    { title: "A", year: "2000", rating: "2" },
    { title: "B", year: "2010", rating: "3" },
    { title: "C", year: "2020", rating: "4" },
  ];
  const view = chartView(rows, { chartXCol: "year", chartYCol: "rating", chartFit: "linear" });
  assert(hasChartColumns(view), "file is chartable");
  const c = document.body.createDiv();
  await renderChart(view, c);
  assert(c.querySelectorAll(".csv-chart-select").length === 2, "X and Y selects present");
  assert(c.querySelector(".csv-chart-fit-btn.active"), "fit toggle reflects saved state");
  assert(c.querySelector(".csv-chart-formula-input"), "formula input present");
  assert(c.querySelector("canvas.csv-chart-canvas"), "canvas present");
  assert(c.querySelector(".csv-chart-fit-text"), "fit equation shown");
  assert(view.chartInstance, "Chart instance created");
  assert(c.querySelector(".csv-chart-export-btn"), "PNG export button appended after render");
});

await test("chart: changing the Y select persists to fileCfg and re-renders", async () => {
  const rows = [
    { title: "A", pages: "100", rating: "2" },
    { title: "B", pages: "200", rating: "5" },
  ];
  const view = chartView(rows);
  const c = document.body.createDiv();
  await renderChart(view, c);
  const ySel = c.querySelectorAll(".csv-chart-select")[1];
  ySel.value = "rating";
  ySel.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert(view.getSavedCfg()?.chartYCol === "rating", "Y pick saved to fileCfg");
});

await test("chart: non-numeric file is not chartable; empty pair shows empty state", async () => {
  assert(!hasChartColumns(chartView([{ title: "A" }, { title: "B" }])), "no numeric column");
  const view = chartView([{ title: "A", score: "1" }, { title: "B", score: "2" }], { chartFormula: "" });
  view.getFilteredRows = () => []; // search filtered everything out
  const c = document.body.createDiv();
  await renderChart(view, c);
  assert(c.querySelector(".csv-empty-state"), "empty state when nothing plots");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`View smoke tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
