#!/usr/bin/env node
// One-shot migration: convert vault xlsx files to canonical CSV, archive
// the originals, drop the _csv_helpers/ mirror, and rewrite data.json keys.
//
// Usage:
//   OBSIDIAN_VAULT="<vault path>" node migrate-xlsx-to-csv.mjs <folder> <basename...>
//   e.g. node migrate-xlsx-to-csv.mjs "Library" books movies
//
// <folder> is the vault-relative folder holding the xlsx files; each
// <basename> is migrated from <folder>/<basename>.xlsx to <basename>.csv.
//
// Order matters:
//   1. Write fresh <basename>.csv alongside each xlsx (canonical source).
//   2. Move xlsx → Archive/<basename>_pre-csv-migration.xlsx (recoverable).
//   3. Remove _csv_helpers/ entirely (no longer needed — the .csv next to
//      the file IS the source now; Dataview reads it directly).
//   4. Rewrite data.json: any fileConfigs[<path>.xlsx] becomes [<path>.csv]
//      so per-file overrides survive the rename.
//
// Idempotent — safe to re-run; will report "already migrated" for done files.

import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import Papa from "papaparse";

const VAULT = process.env.OBSIDIAN_VAULT;
const [LIB, ...FILES] = process.argv.slice(2);
if (!VAULT || !LIB || !FILES.length) {
  console.error('Usage: OBSIDIAN_VAULT="<vault path>" node migrate-xlsx-to-csv.mjs <folder> <basename...>');
  console.error('  e.g. node migrate-xlsx-to-csv.mjs "Library" books movies');
  process.exit(1);
}
const HELPERS = `${LIB}/_csv_helpers`;
const ARCHIVE = `${LIB}/Archive`;
const DATA_JSON = `${VAULT}/.obsidian/plugins/datadeck/data.json`;

// ── Helpers (match plugin's parse path exactly) ────────────────────────────

function readXlsxAsRows(absPath) {
  const buf = fs.readFileSync(absPath);
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  if (!raw.length) return { headers: [], rows: [] };
  const headers = raw[0].map(String);
  const rows = raw.slice(1).map(r => {
    const row = {};
    headers.forEach((h, i) => { row[h] = String(r[i] ?? ""); });
    return row;
  });
  return { headers, rows };
}

// ── Migration steps ────────────────────────────────────────────────────────

let wrote = 0, archived = 0, skipped = 0;

console.log("─────────────────────────────────────────────────────────────────");
console.log("  XLSX → CSV migration");
console.log("─────────────────────────────────────────────────────────────────");

// Ensure Archive folder exists
const archiveAbs = path.join(VAULT, ARCHIVE);
if (!fs.existsSync(archiveAbs)) fs.mkdirSync(archiveAbs, { recursive: true });

for (const name of FILES) {
  const xlsxPath = path.join(VAULT, LIB, `${name}.xlsx`);
  const csvPath = path.join(VAULT, LIB, `${name}.csv`);
  const archivePath = path.join(archiveAbs, `${name}_pre-csv-migration.xlsx`);

  if (!fs.existsSync(xlsxPath) && fs.existsSync(csvPath)) {
    console.log(`· ${name}: already migrated (csv exists, no xlsx)`);
    skipped++;
    continue;
  }
  if (!fs.existsSync(xlsxPath)) {
    console.log(`· ${name}: no source — skipping`);
    skipped++;
    continue;
  }

  // 1. Write canonical CSV
  const { headers, rows } = readXlsxAsRows(xlsxPath);
  const csv = Papa.unparse(rows, { columns: headers });
  fs.writeFileSync(csvPath, csv, "utf8");
  console.log(`  ✓ ${name}.csv written (${rows.length} rows, ${csv.length.toLocaleString()} bytes)`);
  wrote++;

  // 2. Move xlsx → Archive/
  if (fs.existsSync(archivePath)) {
    // Already archived from a previous run — overwrite-safe since the
    // archive name has the "_pre-csv-migration" suffix that pins to this one event.
    fs.unlinkSync(archivePath);
  }
  fs.renameSync(xlsxPath, archivePath);
  console.log(`  ✓ ${name}.xlsx → Archive/${path.basename(archivePath)}`);
  archived++;
}

// 3. Drop _csv_helpers/ folder (deprecated — canonical csv now lives next to the data)
const helpersAbs = path.join(VAULT, HELPERS);
if (fs.existsSync(helpersAbs)) {
  const helperFiles = fs.readdirSync(helpersAbs);
  for (const f of helperFiles) fs.unlinkSync(path.join(helpersAbs, f));
  fs.rmdirSync(helpersAbs);
  console.log(`\n  ✓ Removed ${HELPERS} (${helperFiles.length} mirror file${helperFiles.length === 1 ? "" : "s"})`);
} else {
  console.log(`\n· _csv_helpers/ already gone`);
}

// 4. Rewrite data.json — migrate fileConfigs keys *.xlsx → *.csv
if (fs.existsSync(DATA_JSON)) {
  const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
  const cfg = data.fileConfigs ?? {};
  const migrated = {};
  let migratedCount = 0;
  for (const [k, v] of Object.entries(cfg)) {
    if (k.endsWith(".xlsx")) {
      const newK = k.slice(0, -".xlsx".length) + ".csv";
      migrated[newK] = v;
      migratedCount++;
    } else {
      migrated[k] = v;
    }
  }
  data.fileConfigs = migrated;
  fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2), "utf8");
  console.log(`  ✓ data.json: ${migratedCount} fileConfigs key${migratedCount === 1 ? "" : "s"} migrated to .csv`);
} else {
  console.log(`· data.json not found at ${DATA_JSON} (skipping key migration)`);
}

console.log("\n─────────────────────────────────────────────────────────────────");
console.log(`  ${wrote} files converted, ${archived} archived, ${skipped} skipped`);
console.log(`  Originals preserved in: ${ARCHIVE}/`);
console.log("─────────────────────────────────────────────────────────────────");
