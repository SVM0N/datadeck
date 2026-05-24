/**
 * Approximate the cost Obsidian pays when enabling the plugin.
 *
 * Two numbers worth comparing across a refactor:
 *
 *   Parse  — time V8 spends turning the bundle text into bytecode the first
 *            time it sees it. This is what Obsidian's plugin-enable step pays
 *            on every launch. Lazy-parsed function bodies (uncalled functions)
 *            don't count here; they only get parsed on first call.
 *
 *   Eval   — time spent executing the bundle's top-level code. For Obsidian
 *            this is the plugin's `onload()` plus every module's top-level
 *            initialiser (Chart.js registers default components, etc.). Used
 *            to be more dramatic when SheetJS was in here too — the
 *            CSV-only migration retired that ~700 KB lazy chunk.
 *
 * The bundle uses Obsidian APIs and a few globals, so we stub `require` and
 * `module` enough for the file to evaluate without throwing.
 */
import { readFileSync } from "fs";
import vm from "vm";

const path = process.argv[2] ?? "main.js";
const code = readFileSync(path, "utf8");
const sizeKB = (code.length / 1024).toFixed(1);

const RUNS = 5;

// ── Parse only (no execution) ────────────────────────────────────────────────
const parseTimes = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  new vm.Script(code, { filename: path });
  parseTimes.push(performance.now() - t);
}
const parseAvg = parseTimes.reduce((a, b) => a + b, 0) / RUNS;

// ── Parse + top-level execute ────────────────────────────────────────────────
// Stub the bits the bundle pokes at module scope. We don't care about correctness
// here, only about reaching the end of top-level evaluation.
const stubObsidian = new Proxy({}, { get: () => class { register() {} addCommand() {} addSettingTab() {} } });
const evalTimes = [];
for (let i = 0; i < RUNS; i++) {
  const ctx = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: (id) => (id === "obsidian" ? stubObsidian : {}),
    globalThis: {},
    process: { env: {} },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  const t = performance.now();
  try { new vm.Script(code, { filename: path }).runInContext(ctx); }
  catch { /* downstream throws are fine — we only care about reaching parse + top-level eval */ }
  evalTimes.push(performance.now() - t);
}
const evalAvg = evalTimes.reduce((a, b) => a + b, 0) / RUNS;

console.log(`${path}`);
console.log(`  Size:        ${sizeKB} KB`);
console.log(`  Parse only:  ${parseAvg.toFixed(1)} ms  (avg of ${RUNS})`);
console.log(`  Parse+eval:  ${evalAvg.toFixed(1)} ms  (avg of ${RUNS})`);
