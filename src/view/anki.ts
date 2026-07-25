// Sync the current CSV to Anki via the AnkiConnect add-on (a local HTTP API
// the Anki desktop app exposes on 127.0.0.1:8765). One row → one note, in the
// deck/note type/field mapping configured via AnkiExportModal (src/modals.ts)
// — or, with no config saved yet, the legacy default: the configured front
// column (or the title/primary field) as "Front", every other non-empty
// column joined onto "Back". Desktop-only — Anki must be running with
// AnkiConnect installed. Extracted-style module: reached CardView members are
// public, type-only import → no runtime cycle. Covered by test-view-smoke.mjs
// (with a requestUrl stub).

import { Notice, requestUrl } from "obsidian";
import type { CardView } from "../../main";
import { CSVRow } from "../types";

const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
const ANKI_CONNECT_VERSION = 6;

// Sentinel column value in a saved ankiFieldMap meaning "every other
// non-empty column, as Label: value lines" — the legacy Back behaviour,
// available on any field rather than hardcoded to one named "Back".
export const ANKI_REST_FIELD = "__rest__";

// Minimal AnkiConnect client. Every action shares the same envelope and the
// same error shape ({result, error}), so this one helper covers createDeck,
// addNotes, modelNames, etc. Throws on transport failure (Anki not running)
// and on the API-level `error` field so the caller has a single catch.
export async function ankiInvoke(action: string, params: Record<string, unknown>): Promise<unknown> {
  let res;
  try {
    res = await requestUrl({
      url: ANKI_CONNECT_URL,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
      throw: false,
    });
  } catch {
    // requestUrl rejects on connection refused — Anki closed or AnkiConnect
    // not installed. Rethrow with a message the user can act on.
    throw new Error("Couldn't reach Anki. Is the desktop app open with the AnkiConnect add-on installed?");
  }
  const json = res.json as { result: unknown; error: string | null };
  if (json.error) throw new Error(json.error);
  return json.result;
}

// Every note type Anki knows about (e.g. "Basic", "Basic (and reversed
// card)", "Cloze") — lets the export modal offer a dropdown instead of a
// free-text guess. Throws (via ankiInvoke) if Anki isn't reachable; callers
// fall back to a manual text field in that case.
export async function listAnkiModelNames(): Promise<string[]> {
  return (await ankiInvoke("modelNames", {})) as string[];
}

// Field names for one note type, in template order (e.g. ["Front","Back"]
// for Basic) — drives the field-mapping table's rows.
export async function listAnkiModelFieldNames(modelName: string): Promise<string[]> {
  return (await ankiInvoke("modelFieldNames", { modelName })) as string[];
}

// Existing deck names, offered as datalist suggestions so subdeck nesting
// can match an already-existing parent deck's exact casing/spelling.
export async function listAnkiDeckNames(): Promise<string[]> {
  return (await ankiInvoke("deckNames", {})) as string[];
}

/**
 * The deck a sync writes into: the configured name (or the file's basename),
 * optionally nested under a configured parent deck as "Parent::Deck".
 */
export function resolveAnkiDeck(view: CardView): string {
  const name = view.fileCfg.ankiDeckName?.trim() || view.file?.basename || "Default";
  const parent = view.fileCfg.ankiParentDeck?.trim();
  return parent ? `${parent}::${name}` : name;
}

/**
 * What ankiFrontCol would resolve to with no per-file override — the
 * title/primary field, then a content-bearing column (so a quotes file
 * fronts on Quote, not its first column Author), then the first column.
 * Exposed separately so the ⚙ Config modal can show which column is
 * *already* the front by name/position, without an explicit `ankiFrontCol`.
 */
export function autoAnkiFrontCol(view: CardView): string | null {
  return view.titleKey()
    ?? view.resolveCol(["Quote", "Headline", "Phrase", "Term", "Word", "Question", "Front", "Name", "Title"])
    ?? view.headers[0]
    ?? null;
}

/**
 * Resolve the column used as the Anki card front. Honours the per-file
 * `ankiFrontCol`; otherwise falls back to autoAnkiFrontCol.
 */
export function ankiFrontCol(view: CardView): string | null {
  const configured = view.fileCfg.ankiFrontCol;
  if (configured && view.headers.includes(configured)) return configured;
  return autoAnkiFrontCol(view);
}

// HTML-escape a cell so quotes/dictionary entries with <, >, & render as text
// in Anki rather than as broken markup.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Every non-front, non-empty column as a "Label: value" line, joined with
// <br> so Anki shows them stacked — the value of the __rest__ sentinel field.
function buildRest(view: CardView, row: CSVRow, usedCols: Set<string>): string {
  return view.headers
    .filter(h => !usedCols.has(h) && (row[h] ?? "").trim())
    .map(h => `<b>${esc(h)}:</b> ${esc(row[h].trim())}`)
    .join("<br>");
}

// Build one note's fields per the configured ankiFieldMap (Anki field name →
// column name, or ANKI_REST_FIELD for "everything else"). With no map saved
// yet (the modal was never opened), fall back to the original two-field
// Front/Back shape so existing configs keep working unchanged.
function buildFields(view: CardView, row: CSVRow, frontCol: string): Record<string, string> {
  const fieldMap = view.fileCfg.ankiFieldMap;
  if (!fieldMap) {
    return { Front: esc(row[frontCol].trim()), Back: buildRest(view, row, new Set([frontCol])) };
  }
  const usedCols = new Set(Object.values(fieldMap).filter(c => c && c !== ANKI_REST_FIELD));
  const fields: Record<string, string> = {};
  for (const [field, col] of Object.entries(fieldMap)) {
    if (!col) fields[field] = "";
    else if (col === ANKI_REST_FIELD) fields[field] = buildRest(view, row, usedCols);
    else fields[field] = esc((row[col] ?? "").trim());
  }
  return fields;
}

export async function syncToAnki(view: CardView): Promise<void> {
  if (!view.file) return;

  const frontCol = ankiFrontCol(view);
  if (!frontCol) {
    new Notice("No column to use as the Anki card front.", 6000);
    return;
  }

  const deck = resolveAnkiDeck(view);
  const modelName = view.fileCfg.ankiNoteType || "Basic";
  // Only rows with a non-empty front are sendable — a blank front makes a
  // useless card and AnkiConnect rejects it.
  const rows = view.rows.filter(r => (r[frontCol] ?? "").trim());
  if (!rows.length) {
    new Notice(`Nothing to sync — no rows with a "${frontCol}" value.`, 6000);
    return;
  }

  const notice = new Notice(`Syncing ${rows.length} cards to Anki deck “${deck}”…`, 0);
  try {
    // Create the deck if it doesn't exist yet (no-op if it does) — AnkiConnect
    // creates any missing parent decks too, so a subdeck path just works.
    await ankiInvoke("createDeck", { deck });

    // duplicateScope:"deck" + allowDuplicate:false → re-syncing only adds rows
    // whose front isn't already a card in this deck. addNotes returns a note
    // id per row, or null where the note was a duplicate / invalid.
    const notes = rows.map(row => ({
      deckName: deck,
      modelName,
      fields: buildFields(view, row, frontCol),
      options: { allowDuplicate: false, duplicateScope: "deck" },
      tags: ["datadeck"],
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
