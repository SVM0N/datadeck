// ─── Field-type heuristics ──────────────────────────────────────────────────
//
// Pure, DOM-free name/value rules that decide how a column edits in the modals
// (see makeFieldInput in modals.ts). Kept separate from modals.ts — which
// imports "obsidian" — so these can be unit-tested in plain node.

// Columns offered as non-strict dropdowns: suggestions are listed via a native
// <datalist>, but free text is still accepted. Keyed by lowercased header name.
// (Travel flat-CSV columns; harmless for files without them.)
export const COLUMN_SUGGESTIONS: Record<string, string[]> = {
  source: ["confirmed", "inferred", "conflict"],
  resolved: ["yes", "no"],
};

export function suggestionsFor(h: string): string[] | null {
  return COLUMN_SUGGESTIONS[h.trim().toLowerCase()] ?? null;
}

/**
 * Is this column date-like *by name*? Matches `date`, `date_entered`,
 * `date_left`, `Release Date`, `start-date`, plus the task columns `due` and
 * `deadline` — i.e. any of those as a whole word (bounded by start/end or
 * _ / space / -). Deliberately does NOT match `update`, `mandate`,
 * `candidate`, `dateline`, `overdue`, or `Year`, so we never turn a non-date
 * column into a date picker. Paired with an ISO-value guard at the call site
 * so existing non-ISO values are never clobbered.
 */
export function isDateCol(h: string): boolean {
  return /(^|[_\s-])(date|due|deadline)([_\s-]|$)/i.test(h.trim());
}

/** A clean yyyy-mm-dd value — the only shape safe to hand a native date input. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
