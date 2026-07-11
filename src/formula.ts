// Safe y = f(x) expression compiler for the Chart view and csv-chart blocks.
// A tiny tokenizer + recursive-descent parser — no eval/Function, so it's
// community-plugin-store safe and can't touch anything outside pure math.
//
// Supported: numbers, x, pi/e, + - * / % ^ (right-assoc), unary minus,
// parentheses, one/two-arg functions (sin cos tan asin acos atan sqrt log ln
// exp abs floor ceil round sign min max pow atan2), and implicit
// multiplication ("2x", "3(x+1)", "x sin(x)") so formulas read naturally.
// Compiles once into a closure tree; evaluation per sample is just calls.
// Covered by test-view-smoke.mjs.

export type CompiledFormula = (x: number) => number;

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const FUNCS_1: Record<string, (a: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, log: Math.log10, ln: Math.log, exp: Math.exp,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  round: Math.round, sign: Math.sign,
};

const FUNCS_2: Record<string, (a: number, b: number) => number> = {
  min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2,
};

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: string }      // + - * / % ^
  | { kind: "lparen" } | { kind: "rparen" } | { kind: "comma" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
      if (!m || m[0] === "") throw new Error(`Bad number at "${src.slice(i, i + 8)}"`);
      tokens.push({ kind: "num", value: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const m = src.slice(i).match(/^[a-zA-Z_][a-zA-Z_0-9]*/)!;
      tokens.push({ kind: "ident", name: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ("+-*/%^".includes(ch)) { tokens.push({ kind: "op", op: ch }); i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma" }); i++; continue; }
    throw new Error(`Unexpected character "${ch}"`);
  }
  return tokens;
}

/**
 * Compile an expression like "2x^2 - 3x + 1" or "10 sin(x/2)" into a plain
 * (x) => number. Throws Error with a human-readable message on bad input —
 * callers show it inline next to the formula field.
 */
export function compileFormula(source: string): CompiledFormula {
  // Allow a leading "y =" / "f(x) =" so users can paste equations verbatim.
  const cleaned = source.trim().replace(/^(y|f\s*\(\s*x\s*\))\s*=\s*/i, "");
  if (!cleaned) throw new Error("Empty formula");
  const tokens = tokenize(cleaned);
  let pos = 0;

  const peek = (): Token | null => tokens[pos] ?? null;
  const next = (): Token | null => tokens[pos++] ?? null;

  // expr := term (('+'|'-') term)*
  function parseExpr(): CompiledFormula {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && (t.op === "+" || t.op === "-")) {
        pos++;
        const right = parseTerm();
        const l = left, op = t.op;
        left = op === "+" ? (x) => l(x) + right(x) : (x) => l(x) - right(x);
      } else return left;
    }
  }

  // term := unary (('*'|'/'|'%'| implicit-mult) unary)*
  function parseTerm(): CompiledFormula {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t?.kind === "op" && (t.op === "*" || t.op === "/" || t.op === "%")) {
        pos++;
        const right = parseUnary();
        const l = left, op = t.op;
        left = op === "*" ? (x) => l(x) * right(x)
          : op === "/" ? (x) => l(x) / right(x)
          : (x) => l(x) % right(x);
      } else if (t && (t.kind === "num" || t.kind === "ident" || t.kind === "lparen")) {
        // implicit multiplication: 2x, 3(x+1), x sin(x)
        const right = parseUnary();
        const l = left;
        left = (x) => l(x) * right(x);
      } else return left;
    }
  }

  // unary := '-' unary | power
  function parseUnary(): CompiledFormula {
    const t = peek();
    if (t?.kind === "op" && t.op === "-") {
      pos++;
      const operand = parseUnary();
      return (x) => -operand(x);
    }
    if (t?.kind === "op" && t.op === "+") { pos++; return parseUnary(); }
    return parsePower();
  }

  // power := atom ('^' unary)?   — right-associative, and -x^2 = -(x^2)
  function parsePower(): CompiledFormula {
    const base = parseAtom();
    const t = peek();
    if (t?.kind === "op" && t.op === "^") {
      pos++;
      const exp = parseUnary();
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }

  // atom := number | x | constant | func '(' expr (',' expr)? ')' | '(' expr ')'
  function parseAtom(): CompiledFormula {
    const t = next();
    if (!t) throw new Error("Unexpected end of formula");
    if (t.kind === "num") { const v = t.value; return () => v; }
    if (t.kind === "lparen") {
      const inner = parseExpr();
      if (next()?.kind !== "rparen") throw new Error("Missing closing )");
      return inner;
    }
    if (t.kind === "ident") {
      if (t.name === "x") return (x) => x;
      if (t.name in CONSTANTS) { const v = CONSTANTS[t.name]; return () => v; }
      const isCall = peek()?.kind === "lparen";
      if (t.name in FUNCS_1 || t.name in FUNCS_2) {
        if (!isCall) throw new Error(`${t.name} needs parentheses, e.g. ${t.name}(x)`);
        pos++; // consume (
        const a = parseExpr();
        if (t.name in FUNCS_2) {
          if (next()?.kind !== "comma") throw new Error(`${t.name}(a, b) needs two arguments`);
          const b = parseExpr();
          if (next()?.kind !== "rparen") throw new Error("Missing closing )");
          const fn = FUNCS_2[t.name];
          return (x) => fn(a(x), b(x));
        }
        if (next()?.kind !== "rparen") throw new Error("Missing closing )");
        const fn = FUNCS_1[t.name];
        return (x) => fn(a(x));
      }
      throw new Error(`Unknown name "${t.name}" — use x, pi, e, or a function like sin()`);
    }
    throw new Error(`Unexpected "${t.kind === "op" ? t.op : t.kind}"`);
  }

  const compiled = parseExpr();
  if (pos < tokens.length) {
    const t = tokens[pos];
    throw new Error(`Unexpected "${t.kind === "op" ? t.op : t.kind === "ident" ? t.name : t.kind}" after end of expression`);
  }
  return compiled;
}
