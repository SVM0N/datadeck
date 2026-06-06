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
  await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", outfile: out, alias: { obsidian: STUB }, logLevel: "error" });
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

console.log(`\n${"=".repeat(50)}`);
console.log(`View smoke tests: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);
