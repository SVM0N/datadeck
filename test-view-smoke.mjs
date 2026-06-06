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

/** Bundle a TS entry (obsidian aliased to the stub) and import a named export. */
async function load(entryRel) {
  const entry = fileURLToPath(new URL(entryRel, import.meta.url));
  const out = path.join(os.tmpdir(), `smoke-${path.basename(entryRel)}.${process.pid}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, alias: { obsidian: STUB }, define: { __BUILD_TIME__: JSON.stringify("test") }, logLevel: "error" });
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
  assert(c.querySelectorAll(".csv-mode-btn").length === 3, "Cards + Kanban + Table (no travel/dashboard)");
  assert(c.querySelector(".csv-search-wrap"), "search bar present for non-dashboard mode");
  assert(c.querySelector(".csv-add-btn"), "+ Add button present");
  assert(c.querySelector(".csv-row-count").textContent === "2 entries", "row count reflects rows");
});

console.log(`\n${"=".repeat(50)}`);
console.log(`View smoke tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
