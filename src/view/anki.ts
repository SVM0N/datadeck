// Sync the current CSV to Anki via the AnkiConnect add-on (a local HTTP API
// the Anki desktop app exposes on 127.0.0.1:8765). One row → one "Basic" note:
// the configured front column (or the title/primary field) is the card front,
// every other non-empty column is joined onto the back. Desktop-only — Anki
// must be running with AnkiConnect installed. Extracted-style module: reached
// CardView members are public, type-only import → no runtime cycle. Covered by
// test-view-smoke.mjs (with a requestUrl stub).

import { Notice, requestUrl } from "obsidian";
import type { CardView } from "../../main";
import { CSVRow } from "../types";

const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
const ANKI_CONNECT_VERSION = 6;

// Minimal AnkiConnect client. Every action shares the same envelope and the
// same error shape ({result, error}), so this one helper covers createDeck,
// addNotes, etc. Throws on transport failure (Anki not running) and on the
// API-level `error` field so the caller has a single catch.
async function ankiInvoke(action: string, params: Record<string, unknown>): Promise<unknown> {
  let res;
  try {
    res = await requestUrl({
      url: ANKI_CONNECT_URL,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
      throw: false,
    });
  } catch (e) {
    // requestUrl rejects on connection refused — Anki closed or AnkiConnect
    // not installed. Rethrow with a message the user can act on.
    throw new Error("Couldn't reach Anki. Is the desktop app open with the AnkiConnect add-on installed?");
  }
  const json = res.json as { result: unknown; error: string | null };
  if (json.error) throw new Error(json.error);
  return json.result;
}

/**
 * Resolve the column used as the Anki card front. Honours the per-file
 * `ankiFrontCol`; otherwise falls back to the title/primary field, then to a
 * content-bearing column (so a quotes file fronts on Quote, not its first
 * column Author), then to the first column.
 */
export function ankiFrontCol(view: CardView): string | null {
  const configured = view.fileCfg.ankiFrontCol;
  if (configured && view.headers.includes(configured)) return configured;
  return view.titleKey()
    ?? view.resolveCol(["Quote", "Headline", "Phrase", "Term", "Word", "Question", "Front", "Name", "Title"])
    ?? view.headers[0]
    ?? null;
}

// HTML-escape a cell so quotes/dictionary entries with <, >, & render as text
// in Anki rather than as broken markup.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Build the card back: every non-front, non-empty column as a "Label: value"
// line, joined with <br> so Anki shows them stacked.
function buildBack(view: CardView, row: CSVRow, frontCol: string): string {
  return view.headers
    .filter(h => h !== frontCol && (row[h] ?? "").trim())
    .map(h => `<b>${esc(h)}:</b> ${esc(row[h].trim())}`)
    .join("<br>");
}

export async function syncToAnki(view: CardView): Promise<void> {
  if (!view.file) return;

  const frontCol = ankiFrontCol(view);
  if (!frontCol) {
    new Notice("No column to use as the Anki card front.", 6000);
    return;
  }

  const deck = view.file.basename;
  // Only rows with a non-empty front are sendable — a blank front makes a
  // useless card and AnkiConnect rejects it.
  const rows = view.rows.filter(r => (r[frontCol] ?? "").trim());
  if (!rows.length) {
    new Notice(`Nothing to sync — no rows with a "${frontCol}" value.`, 6000);
    return;
  }

  const notice = new Notice(`Syncing ${rows.length} cards to Anki deck “${deck}”…`, 0);
  try {
    // Create the deck if it doesn't exist yet (no-op if it does).
    await ankiInvoke("createDeck", { deck });

    // duplicateScope:"deck" + allowDuplicate:false → re-syncing only adds rows
    // whose front isn't already a card in this deck. addNotes returns a note
    // id per row, or null where the note was a duplicate / invalid.
    const notes = rows.map(row => ({
      deckName: deck,
      modelName: "Basic",
      fields: { Front: esc(row[frontCol].trim()), Back: buildBack(view, row, frontCol) },
      options: { allowDuplicate: false, duplicateScope: "deck" },
      tags: ["csv-card-view"],
    }));

    const result = await ankiInvoke("addNotes", { notes }) as (number | null)[];
    const added = result.filter(id => id != null).length;
    const skipped = result.length - added;
    notice.hide();
    new Notice(
      `Anki sync: ${added} added${skipped ? `, ${skipped} already present` : ""} (deck “${deck}”).`,
      6000,
    );
  } catch (e) {
    notice.hide();
    new Notice(`Anki sync failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
  }
}
