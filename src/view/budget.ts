// Budget view renderer. Items grouped by category (reusing effectiveGroupCol
// — the same fallback chain Kanban/Cards use), each row's price rolled up
// into a per-category subtotal and a grand total, compared against a
// per-file spending limit set inline in the view: blue while under, red once
// over. Extracted-style module: reached CardView members are public,
// type-only import → no runtime cycle. Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { PRICE_COL_ALIASES } from "../utils";
import { parseNumeric } from "./chart";
import { effectiveGroupCol } from "./kanban";
import { makeEditable } from "./table";

const UNCATEGORIZED = "—";

/**
 * The column holding each row's price/amount. An explicit fileCfg override
 * (the "Price" column function in ⚙ Config) wins outright, including empty
 * string for "disabled"; otherwise a name-alias match, same pattern as
 * titleKey/getCategoryCol/etc.
 */
export function budgetPriceCol(view: CardView): string | null {
  if (view.fileCfg.budgetPriceCol !== undefined) {
    if (view.fileCfg.budgetPriceCol === "") return null;
    return view.headers.find(h => h.toLowerCase() === view.fileCfg.budgetPriceCol!.toLowerCase()) ?? null;
  }
  return view.resolveCol(PRICE_COL_ALIASES);
}

/**
 * Whether Budget mode should be offered at all. Deliberately conservative —
 * a name-alias match or an explicit override only, not "any numeric column"
 * (chart's gate is that broad; here it would put a Budget tab on every file
 * with a Rating or Year column, which reads as noise rather than a feature).
 */
export function hasBudgetColumns(view: CardView): boolean {
  return budgetPriceCol(view) !== null;
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderBudget(view: CardView, container: HTMLElement): void {
  const priceCol = budgetPriceCol(view);
  if (!priceCol) {
    container.createEl("p", { text: "No price/amount column found. Assign one via ⚙ config → column functions.", cls: "csv-empty-state" });
    return;
  }
  // effectiveGroupCol's last-resort fallback picks *any* low-cardinality
  // column when there's no real category — on a file with no other
  // groupable column that can be the price column itself (e.g. two rows
  // priced "10"/"20" read as two "categories"). Reject that one case; every
  // other fallback pick is still a legitimate grouping.
  const groupCol = effectiveGroupCol(view);
  const catCol = groupCol === priceCol ? null : groupCol;
  const titleCol = view.titleKey() ?? view.headers[0];
  const rows = view.getFilteredRows();

  const catOf = (row: CSVRow): string => {
    if (!catCol) return UNCATEGORIZED;
    return (row[catCol] ?? "").trim() || UNCATEGORIZED;
  };

  const totals = new Map<string, number>();
  let grandTotal = 0;
  rows.forEach(row => {
    const n = parseNumeric(row[priceCol] ?? "") ?? 0;
    grandTotal += n;
    totals.set(catOf(row), (totals.get(catOf(row)) ?? 0) + n);
  });

  const wrap = container.createDiv({ cls: "csv-budget" });

  // ── Summary: grand total vs. the limit, plus the limit editor ──────────
  const limit = view.fileCfg.budgetLimit;
  const hasLimit = limit !== undefined && limit > 0;
  const over = hasLimit && grandTotal > limit;

  const summary = wrap.createDiv({ cls: "csv-budget-summary" });
  const totalRow = summary.createDiv({ cls: "csv-budget-total-row" });
  totalRow.createSpan({ cls: "csv-budget-total-label", text: "Total" });
  totalRow.createSpan({
    cls: `csv-budget-total-value ${hasLimit ? (over ? "is-over" : "is-under") : ""}`,
    text: fmtMoney(grandTotal),
  });
  if (hasLimit) totalRow.createSpan({ cls: "csv-budget-total-limit", text: ` / ${fmtMoney(limit)}` });

  const limitRow = summary.createDiv({ cls: "csv-budget-limit-row" });
  limitRow.createSpan({ cls: "csv-budget-limit-label", text: "Limit" });
  const limitInput = limitRow.createEl("input", {
    cls: "csv-budget-limit-input", type: "number",
    attr: { placeholder: "No limit set", step: "0.01", min: "0" },
  });
  if (limit !== undefined) limitInput.value = String(limit);
  const commitLimit = () => {
    const raw = limitInput.value.trim();
    const n = raw === "" ? undefined : parseFloat(raw);
    const next = n !== undefined && Number.isFinite(n) && n >= 0 ? n : undefined;
    if (next === view.fileCfg.budgetLimit) return;
    view.saveFileCfg({ ...view.fileCfg, budgetLimit: next });
    view.renderViewPreservingScroll();
  };
  limitInput.addEventListener("change", commitLimit);
  limitInput.addEventListener("keydown", e => { if (e.key === "Enter") limitInput.blur(); });

  if (hasLimit) {
    const bar = summary.createDiv({ cls: "csv-budget-bar" });
    const fill = bar.createDiv({ cls: `csv-budget-bar-fill ${over ? "is-over" : "is-under"}` });
    fill.style.width = `${Math.min(100, Math.round((grandTotal / limit) * 100))}%`;
  }

  // ── Per-category rollup chips (only worth showing with >1 category) ────
  if (catCol && totals.size > 1) {
    const catsWrap = wrap.createDiv({ cls: "csv-budget-cats" });
    Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, sum]) => {
        const chip = catsWrap.createDiv({ cls: "csv-budget-cat-chip" });
        chip.createSpan({ cls: "csv-budget-cat-name", text: cat });
        chip.createSpan({ cls: "csv-budget-cat-sum", text: fmtMoney(sum) });
      });
  }

  // ── Item list, grouped by category (same collapsible-table shell as Tasks) ──
  if (!rows.length) {
    wrap.createDiv({ cls: "csv-empty-state", text: "No entries yet." });
    return;
  }

  const visibleCols = view.fileCfg.cardFields ?? view.headers;
  const displayCols = visibleCols.filter(h => h !== catCol && h !== priceCol && h !== titleCol);

  const itemsWrap = wrap.createDiv({ cls: "csv-tasks" });
  const cats = Array.from(totals.keys()).sort((a, b) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return a.localeCompare(b);
  });

  cats.forEach(cat => {
    const items = rows.filter(r => catOf(r) === cat);
    if (!items.length) return;

    const section = itemsWrap.createDiv({ cls: "csv-tasks-section" });
    const details = section.createEl("details", { cls: "csv-tasks-group" });
    details.open = true;
    const summaryEl = details.createEl("summary", { cls: "csv-tasks-group-header" });
    summaryEl.createSpan({ cls: "csv-tasks-arrow", text: "▶" });
    summaryEl.createSpan({ text: ` ${cat} ` });
    summaryEl.createSpan({ cls: "csv-tasks-count", text: String(items.length) });
    summaryEl.createSpan({ cls: "csv-budget-cat-subtotal", text: fmtMoney(totals.get(cat) ?? 0) });

    const wrapper = details.createDiv({ cls: "csv-tasks-table-wrapper" });
    const table = wrapper.createEl("table", { cls: "csv-tasks-table" });
    const thead = table.createEl("thead").createEl("tr");
    thead.createEl("th", { text: "Item", cls: "csv-tasks-name-cell" });
    displayCols.forEach(h => thead.createEl("th", { text: h, cls: "csv-tasks-generic-cell" }));
    thead.createEl("th", { text: "Price", cls: "csv-budget-price-cell" });
    const tbody = table.createEl("tbody");

    items.forEach(row => {
      const tr = tbody.createEl("tr");
      const nameCell = tr.createEl("td", { cls: "csv-tasks-name-cell csv-tasks-editable", text: row[titleCol] || "Untitled" });
      makeEditable(view, nameCell, row, titleCol);
      displayCols.forEach(h => {
        const val = row[h] ?? "";
        const display = val.length > 40 ? val.slice(0, 38) + "…" : val;
        const td = tr.createEl("td", { text: display || "—", cls: "csv-tasks-generic-cell csv-tasks-editable" });
        makeEditable(view, td, row, h);
      });
      const priceCell = tr.createEl("td", { cls: "csv-budget-price-cell csv-tasks-editable", text: fmtMoney(parseNumeric(row[priceCol] ?? "") ?? 0) });
      makeEditable(view, priceCell, row, priceCol);
      tr.addEventListener("contextmenu", e => view.openRowContextMenu(row, e));
    });
  });
}
