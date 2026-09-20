// ─── Row filtering for the csv-view block's `filter:` directive ──────────────
//
//   filter: HSK == 2
//   filter: Status != Done
//
// One condition per line; several `filter:` lines AND together. This is a
// *display* filter, the row-wise counterpart of `columns:`/`hide:` — it decides
// what a block draws, never what gets written back, so a filtered-out row keeps
// its place in the CSV (InlineCardHost.doSave unparses `rows`, not `baseRows()`).
//
// Comparisons are numeric when both sides parse as numbers (so `HSK == 2`
// matches a cell holding "2.0") and case-insensitive strings otherwise, which
// is what `Status == done` and `Rating >= 7.5` both want. Multi-value cells
// ("Drama, Crime") are a job for `contains` — `==` tests the whole cell.
//
// Parsing is done once per block, and compiled to a closure per condition, so
// the per-row cost is a property read and a comparison. Covered by
// test-view-smoke.mjs.

import { CSVRow } from "./types";

export type FilterOp =
  | "==" | "!=" | ">" | ">=" | "<" | "<="
  | "contains" | "!contains" | "in" | "not in" | "empty" | "not empty";

export interface FilterCond {
  col: string;
  op: FilterOp;
  /** Right-hand side, trimmed. Empty for the unary `empty` / `not empty`. */
  value: string;
  /** The directive line as written — re-read on a column miss, and quoted in the warning. */
  raw: string;
}

export interface CompiledFilter {
  /** True = draw this row. */
  test: (row: CSVRow) => boolean;
  /** Conditions naming a column the file doesn't have — dropped, and surfaced to the reader. */
  unknown: string[];
}

// Longest token first within each family: a tie on position is broken by array
// order, which is how `>=` wins over `>` and `not in` over `in`.
const OPS: { token: string; op: FilterOp; word: boolean }[] = [
  { token: ">=", op: ">=", word: false },
  { token: "<=", op: "<=", word: false },
  { token: "!=", op: "!=", word: false },
  { token: "==", op: "==", word: false },
  { token: "=", op: "==", word: false },
  { token: ">", op: ">", word: false },
  { token: "<", op: "<", word: false },
  { token: "not in", op: "not in", word: true },
  { token: "in", op: "in", word: true },
  { token: "!contains", op: "!contains", word: true },
  { token: "contains", op: "contains", word: true },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Parse one `filter:` line's body into a condition. Returns null when there's
 * no operator in it (a malformed line is reported, not silently treated as a
 * filter that matches nothing).
 *
 * The operator is the *leftmost* one in the line, so a value may contain
 * operator characters ("Tags contains a=b" is a `contains`) and a word operator
 * doesn't outrank an earlier symbol ("Status == in progress" is an `==`).
 * `symbolsOnly` re-reads a line with the word operators off, which is how a
 * column whose own name embeds one ("Built in Year >= 1990") is recovered —
 * see compileRowFilter.
 */
export function parseFilterLine(raw: string, symbolsOnly = false): FilterCond | null {
  const line = raw.trim();
  if (!line) return null;

  let best: { pos: number; end: number; op: FilterOp } | null = null;
  for (const { token, op, word } of OPS) {
    if (word && symbolsOnly) continue;
    let pos: number, end: number;
    if (word) {
      const m = new RegExp(`\\s+${escapeRe(token)}\\s+`, "i").exec(line);
      if (!m) continue;
      pos = m.index;
      end = m.index + m[0].length;
    } else {
      // From index 1: an operator at the very start leaves no column name.
      pos = line.indexOf(token, 1);
      if (pos < 0) continue;
      end = pos + token.length;
    }
    if (!best || pos < best.pos) best = { pos, end, op };
  }

  if (best) {
    const col = line.slice(0, best.pos).trim();
    const value = line.slice(best.end).trim();
    // A line that opens with an operator leaves operator characters, not a
    // column name, on the left ("== 2" splits at the second `=`).
    if (!col || !value || /^[=<>!]+$/.test(col)) return null;
    return { col, op: best.op, value, raw };
  }

  // No binary operator — the unary pair is the only thing left it can be.
  const unary = /^(.+?)\s+(not\s+empty|empty)$/i.exec(line);
  if (unary) {
    const col = unary[1].trim();
    if (!col) return null;
    const op: FilterOp = /^not/i.test(unary[2]) ? "not empty" : "empty";
    return { col, op, value: "", raw };
  }
  return null;
}

/** Finite number, or null — `Number("")` is 0 and `Number("2kg")` is NaN, both of which must not read as numeric. */
function numeric(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function eq(a: string, b: string, nb: number | null): boolean {
  const na = numeric(a);
  if (na !== null && nb !== null) return na === nb;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Ordering comparison, or null when the row has nothing in the column — a blank
 * cell is outside every range rather than sorting as a zero or an empty string.
 */
function cmp(a: string, b: string, nb: number | null): number | null {
  if (!a) return null;
  const na = numeric(a);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Compile one resolved condition into a row predicate. Everything that can be hoisted out of the row loop is. */
function makeTest(col: string, op: FilterOp, value: string): (row: CSVRow) => boolean {
  const lower = value.toLowerCase();
  const n = numeric(value);
  const cell = (row: CSVRow) => (row[col] ?? "").trim();

  switch (op) {
    case "empty": return r => cell(r) === "";
    case "not empty": return r => cell(r) !== "";
    case "contains": return r => cell(r).toLowerCase().includes(lower);
    case "!contains": return r => !cell(r).toLowerCase().includes(lower);
    case "in":
    case "not in": {
      const list = value.split(",").map(s => s.trim()).filter(Boolean)
        .map(v => ({ v, n: numeric(v) }));
      const hit = (r: CSVRow) => { const c = cell(r); return list.some(({ v, n: vn }) => eq(c, v, vn)); };
      return op === "in" ? hit : (r => !hit(r));
    }
    case "==": return r => eq(cell(r), value, n);
    case "!=": return r => !eq(cell(r), value, n);
    default: {
      const dir = op;
      return r => {
        const c = cmp(cell(r), value, n);
        if (c === null) return false;
        return dir === ">" ? c > 0 : dir === ">=" ? c >= 0 : dir === "<" ? c < 0 : c <= 0;
      };
    }
  }
}

/**
 * Resolve conditions against the file's real headers and compile them into a
 * single predicate. Column names match case-insensitively; one that matches
 * nothing is dropped and named in `unknown` — unlike a stray `hide:` entry, a
 * dropped row filter would silently show everything, so the block says so.
 * Returns null when there is nothing to filter by.
 */
export function compileRowFilter(conds: FilterCond[], headers: string[]): CompiledFilter | null {
  if (!conds.length) return null;
  const find = (name: string) => headers.find(h => h.toLowerCase() === name.trim().toLowerCase());
  const tests: ((row: CSVRow) => boolean)[] = [];
  const unknown: string[] = [];

  for (const cond of conds) {
    let col = find(cond.col);
    let use = cond;
    if (!col) {
      // "Built in Year >= 1990" split at ` in ` — re-read it without the word
      // operators before writing the column off as missing.
      const retry = parseFilterLine(cond.raw, true);
      const retryCol = retry ? find(retry.col) : undefined;
      if (retry && retryCol) { col = retryCol; use = retry; }
    }
    if (!col) { unknown.push(cond.col); continue; }
    tests.push(makeTest(col, use.op, use.value));
  }

  if (!tests.length) return { test: () => true, unknown };
  if (tests.length === 1) { const only = tests[0]; return { test: only, unknown }; }
  return { test: row => tests.every(t => t(row)), unknown };
}
