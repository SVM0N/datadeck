// ─── Residency / threshold evaluation ───────────────────────────────────────
//
// Pure, DOM-free. Reduces every residency/tax rule to one primitive: count the
// days a person was in `scope` within `window`, minus exempt visa rows, vs a
// threshold. Rendered by travel-view.ts as a used/threshold gauge.
//
// Day counting matches the travel-tracker: date_entered inclusive, date_left
// exclusive, clamped to the window (covered by unit tests over synthetic data).
// These are indicators, NOT legal/tax advice — real tests (US SPT weighting,
// UK statutory test) differ.

import { ResidencyRule } from "./types";

const DAY = 86400000;

/** Minimal trip shape — TravelRow satisfies it. */
export interface TripLike {
  date_entered: string;
  date_left: string;
  country: string;
  visa_status: string;
}

export interface RuleResult {
  rule: ResidencyRule;
  used: number;
  threshold: number;
  remaining: number;            // threshold - used (may be negative)
  windowLabel: string;          // "in 2026" | "in last 180 days" | "all time"
  status: "ok" | "warn" | "over";
}

function parseISO(s: string): number | null {
  if (!s || s.indexOf("?") !== -1) return null;
  const t = Date.parse(s + "T00:00:00Z");
  return isNaN(t) ? null : t;
}

/** Days of [enter, leave) overlapping [winStart, winEnd) — left-exclusive, no min. */
function overlapDays(enter: number, leave: number, winStart: number, winEnd: number): number {
  const a = Math.max(enter, winStart);
  const b = Math.min(leave, winEnd);
  if (b <= a) return 0;
  return Math.round((b - a) / DAY);
}

function windowFor(rule: ResidencyRule, today: number): { start: number; end: number; label: string } {
  const w = rule.window;
  if (w.type === "all-time") return { start: -Infinity, end: Infinity, label: "all time" };
  if (w.type === "calendar-year") {
    const y = new Date(today).getUTCFullYear();
    return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1), label: `in ${y}` };
  }
  // rolling: last N days up to and including today
  const n = w.days ?? 180;
  return { start: today - n * DAY, end: today + DAY, label: `in last ${n} days` };
}

/**
 * Evaluate one rule against a set of trips (typically the confirmed rows).
 * `today` is injectable for testing; defaults to now.
 */
export function evaluateResidency(rule: ResidencyRule, trips: TripLike[], today: number = Date.now()): RuleResult {
  const scopeList = rule.scope.countries ?? (rule.scope.country ? [rule.scope.country] : []);
  const scope = new Set(scopeList.map(c => c.toUpperCase()));
  const exempt = new Set((rule.exempt?.visa_status ?? []).map(v => v.toLowerCase().trim()));
  const win = windowFor(rule, today);

  let used = 0;
  for (const t of trips) {
    if (!scope.has((t.country || "").toUpperCase())) continue;
    if (exempt.has((t.visa_status || "").toLowerCase().trim())) continue;
    const enter = parseISO(t.date_entered);
    const leave = parseISO(t.date_left);
    if (enter === null || leave === null) continue;
    used += overlapDays(enter, leave, win.start, win.end);
  }

  const remaining = rule.threshold - used;
  const status: RuleResult["status"] = used >= rule.threshold ? "over"
    : used / rule.threshold >= 0.8 ? "warn" : "ok";
  return { rule, used, threshold: rule.threshold, remaining, windowLabel: win.label, status };
}
