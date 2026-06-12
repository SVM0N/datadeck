// ─── csv-random code block ───────────────────────────────────────────────────
// Embeds a random entry from a CSV in any note — built for a "quote of the
// day" / "word of the day" in daily-note templates. Re-rolls on every render
// (each note open) and via the ↻ button.
//
//   ```csv-random
//   file: ../quotes.csv
//   field: Quote          (optional — defaults to the first column)
//   ```
//
// Path forms are the same as csv-add (sibling / ../ walked / vault-relative,
// resolved by resolvePath).

import { App, TFile, MarkdownPostProcessorContext } from "obsidian";

/**
 * Duck-typed TFile check (folders have `name`/`path` but no `extension`).
 * Used instead of `instanceof TFile` so the block is drivable with a stub
 * vault in the smoke tests — each test entry is bundled with its own copy of
 * the obsidian stub, which breaks cross-bundle instanceof identity.
 */
function asFile(f: unknown): TFile | null {
  return f && typeof f === "object" && "basename" in (f as object) ? (f as TFile) : null;
}
import { CSVRow } from "./types";
import { parseCSV, resolvePath } from "./utils";

const ATTRIBUTION_COLS = ["Author", "author", "By", "by", "Source", "source", "Speaker", "speaker", "Artist", "artist", "Director", "director"];

export async function renderRandomCard(app: App, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
  const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
  const opt = (key: string) => lines.find(l => l.startsWith(key + ":"))?.slice(key.length + 1).trim() ?? "";
  const filePath = opt("file");
  if (!filePath) {
    el.createEl("p", { text: "Error: No file specified. Use: file: yourfile.csv", cls: "csv-add-error" });
    return;
  }

  const currentFile = app.vault.getAbstractFileByPath(ctx.sourcePath);
  const baseFolder = currentFile?.parent?.path ?? "";
  const fullPath = resolvePath(filePath, baseFolder);
  const file = asFile(app.vault.getAbstractFileByPath(fullPath));
  if (!file) {
    el.createEl("p", { text: `Error: File not found: ${fullPath}`, cls: "csv-add-error" });
    return;
  }

  let headers: string[] = [];
  let rows: CSVRow[] = [];
  try {
    const parsed = parseCSV(await app.vault.read(file));
    headers = parsed.headers;
    rows = parsed.rows;
  } catch (e) {
    el.createEl("p", { text: `Error reading file: ${e}`, cls: "csv-add-error" });
    return;
  }
  if (!rows.length) {
    el.createEl("p", { text: "No entries in file.", cls: "csv-add-error" });
    return;
  }

  // Text column: explicit `field:` if it matches a header (case-insensitive),
  // else the first column.
  const fieldOpt = opt("field");
  const textCol = headers.find(h => h.toLowerCase() === fieldOpt.toLowerCase()) ?? headers[0];
  const attrCol = ATTRIBUTION_COLS.map(c => headers.find(h => h === c)).find(Boolean);

  const card = el.createDiv({ cls: "csv-random-card" });
  const draw = () => {
    card.empty();
    // Skip rows with an empty text cell — a blank "quote of the day" reads
    // as broken. Fall back to any row if literally all are blank.
    const usable = rows.filter(r => (r[textCol] ?? "").trim());
    const pool = usable.length ? usable : rows;
    const row = pool[Math.floor(Math.random() * pool.length)];

    card.createDiv({ cls: "csv-random-text", text: row[textCol] || "—" });
    const attribution = attrCol ? (row[attrCol] ?? "").trim() : "";
    if (attribution) card.createDiv({ cls: "csv-random-sub", text: `— ${attribution}` });

    const foot = card.createDiv({ cls: "csv-random-foot" });
    foot.createSpan({ cls: "csv-random-src", text: file.basename });
    const again = foot.createEl("button", { cls: "csv-random-btn", text: "↻", title: "Another one" });
    again.addEventListener("click", draw);
  };
  draw();
}
