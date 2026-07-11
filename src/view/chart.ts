// Chart view renderer — scatter/line plots of one column against another,
// with an optional least-squares fit line (equation + R² shown below) and an
// optional y = f(x) formula overlay (safe evaluator, see src/formula.ts).
// Chart.js is lazy-loaded via src/chartjs-loader.ts, same deal as the
// dashboard: the controls render synchronously, the canvas paints when the
// module arrives. X/Y/fit/formula picks persist per file in fileCfg.
// The csv-chart code block (src/chart-block.ts) reuses the extraction +
// config-building core below. Covered by test-view-smoke.mjs (chart.js stub).

import type { ChartConfiguration, TooltipItem } from "chart.js";
import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { loadChart } from "../chartjs-loader";
import { compileFormula } from "../formula";
import { localISODate } from "../utils";

// ── Numeric parsing / column detection ──────────────────────────────────────

/**
 * Parse a cell into a finite number, or null. Tolerates thousands separators
 * ("1,234" / "1 234") and a European decimal comma ("3,5") — data typed on a
 * Swedish keyboard should chart without a cleanup pass.
 */
export function parseNumeric(raw: string): number | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  if (/^-?\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/[,\s]/g, "");
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Headers that are chartable as numbers: at least two non-empty values and a
 * 70%+ numeric hit rate (so an odd "n/a" doesn't disqualify a column).
 */
export function numericColumns(headers: string[], rows: CSVRow[]): string[] {
  return headers.filter(h => {
    let nonEmpty = 0, numeric = 0;
    for (const r of rows) {
      const v = (r[h] ?? "").trim();
      if (!v) continue;
      nonEmpty++;
      if (parseNumeric(v) !== null) numeric++;
    }
    return numeric >= 2 && numeric / nonEmpty >= 0.7;
  });
}

// ── Fit + config building (shared with the csv-chart block) ─────────────────

export interface LinearFit { slope: number; intercept: number; r2: number; }

/** Least-squares linear regression. Null when <2 points or X has no spread. */
export function linearFit(pts: { x: number; y: number }[]): LinearFit | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // R² = 1 - SSres/SStot (1 when Y is constant — the flat line fits exactly)
  const meanY = sy / n;
  let ssRes = 0, ssTot = 0;
  for (const p of pts) {
    const e = p.y - (slope * p.x + intercept);
    ssRes += e * e;
    ssTot += (p.y - meanY) * (p.y - meanY);
  }
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

export interface ChartPoint { x: number; y: number; label?: string; }

export interface ChartSpec {
  points: ChartPoint[];
  xIsDate: boolean;        // X values are ms timestamps → date-formatted ticks
  xLabel: string;
  yLabel: string;
  connect: boolean;        // draw the series as a line (sorted by x) vs dots
  fit: "none" | "linear";
  formula: string;         // raw y=f(x) text, "" = none
  // Domain for a pure-formula plot with no data points.
  xMin?: number;
  xMax?: number;
}

/** Theme colors resolved from CSS variables at render time (canvas needs concrete values). */
export interface ChartColors { accent: string; muted: string; grid: string; fitLine: string; formula: string; }

export function resolveChartColors(el: HTMLElement): ChartColors {
  // Via the element's own window — a bare getComputedStyle global doesn't
  // exist in the jsdom smoke tests (and popout windows have their own).
  const css = el.ownerDocument.defaultView?.getComputedStyle(el);
  const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
  return {
    accent: v("--interactive-accent", "#378ADD"),
    muted: v("--text-muted", "#888888"),
    grid: v("--background-modifier-border", "rgba(128,128,128,0.25)"),
    fitLine: v("--text-faint", "#999999"),
    formula: v("--color-orange", "#e0883a"),
  };
}

const fmtNum = (n: number): string => {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  return abs !== 0 && (abs >= 1e6 || abs < 1e-3) ? n.toExponential(2) : String(Math.round(n * 1000) / 1000);
};

const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  // Local, not toISOString — the timestamps come from local-midnight Date
  // parses, so the UTC date would read one day early in UTC+ timezones.
  return isNaN(d.getTime()) ? String(ms) : localISODate(d);
};

export interface BuiltChart {
  config: ChartConfiguration;
  /** "y = 2.35x + 1.2 · R² = 0.91" (or the per-day phrasing for date X), null when no fit drawn. */
  fitText: string | null;
  /** Compile error for the formula overlay, null when it parsed (or was empty). */
  formulaError: string | null;
}

/**
 * Build a Chart.js scatter config from a spec: data points, optional fit-line
 * dataset, optional formula-overlay dataset. Pure — no DOM, no Chart.js
 * import — so the smoke tests can assert on it without a canvas.
 */
export function buildChartConfig(spec: ChartSpec, colors: ChartColors): BuiltChart {
  const datasets: ChartConfiguration<"scatter" | "line">["data"]["datasets"] = [];
  const pts = spec.connect ? [...spec.points].sort((a, b) => a.x - b.x) : spec.points;

  if (pts.length) {
    datasets.push({
      type: spec.connect ? "line" : "scatter",
      label: spec.yLabel,
      data: pts,
      backgroundColor: colors.accent,
      borderColor: colors.accent,
      borderWidth: 1.5,
      pointRadius: spec.connect ? 3 : 4,
      pointHoverRadius: 6,
      tension: 0.3,
    });
  }

  const xs = pts.map(p => p.x);
  const xMin = pts.length ? Math.min(...xs) : (spec.xMin ?? 0);
  const xMax = pts.length ? Math.max(...xs) : (spec.xMax ?? 10);

  let fitText: string | null = null;
  if (spec.fit === "linear") {
    const fit = linearFit(pts);
    if (fit && xMax > xMin) {
      datasets.push({
        type: "line",
        label: "Best fit",
        data: [
          { x: xMin, y: fit.slope * xMin + fit.intercept },
          { x: xMax, y: fit.slope * xMax + fit.intercept },
        ],
        borderColor: colors.fitLine,
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHitRadius: 0,
      });
      const r2 = ` · R² = ${(Math.round(fit.r2 * 1000) / 1000).toFixed(3)}`;
      if (spec.xIsDate) {
        // Slope is per millisecond — meaningless to read. Phrase it per day.
        const perDay = fit.slope * 86_400_000;
        fitText = `Trend: ${perDay >= 0 ? "+" : ""}${fmtNum(perDay)} ${spec.yLabel}/day${r2}`;
      } else {
        const sign = fit.intercept >= 0 ? "+" : "−";
        fitText = `y = ${fmtNum(fit.slope)}x ${sign} ${fmtNum(Math.abs(fit.intercept))}${r2}`;
      }
    }
  }

  let formulaError: string | null = null;
  if (spec.formula.trim()) {
    try {
      const f = compileFormula(spec.formula);
      const samples: ChartPoint[] = [];
      const steps = 160;
      for (let i = 0; i <= steps; i++) {
        const x = xMin + ((xMax - xMin) * i) / steps;
        const y = f(x);
        if (Number.isFinite(y)) samples.push({ x, y });
      }
      if (samples.length) {
        datasets.push({
          type: "line",
          label: spec.formula.trim(),
          data: samples,
          borderColor: colors.formula,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHitRadius: 0,
          tension: 0,
        });
      }
    } catch (e) {
      formulaError = e instanceof Error ? e.message : String(e);
    }
  }

  const config: ChartConfiguration = {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "linear",
          title: { display: !spec.xIsDate && !!spec.xLabel, text: spec.xLabel, color: colors.muted },
          ticks: {
            color: colors.muted,
            ...(spec.xIsDate ? { callback: (v: unknown) => fmtDate(Number(v)), maxTicksLimit: 8 } : {}),
          },
          grid: { color: colors.grid },
        },
        y: {
          title: { display: !!spec.yLabel, text: spec.yLabel, color: colors.muted },
          ticks: { color: colors.muted },
          grid: { color: colors.grid },
        },
      },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: colors.muted, boxWidth: 12 },
        },
        tooltip: {
          callbacks: {
            label: (item: TooltipItem<"scatter">) => {
              const p = item.raw as ChartPoint;
              const x = spec.xIsDate ? fmtDate(p.x) : fmtNum(p.x);
              const head = p.label ? `${p.label}: ` : "";
              return `${head}(${x}, ${fmtNum(p.y)})`;
            },
          },
        },
      },
    } as ChartConfiguration["options"],
  };
  return { config, fitText, formulaError };
}

// ── Data extraction ──────────────────────────────────────────────────────────

const ROW_INDEX = "(row number)";

/**
 * Rows → points for an x/y column pair. `xCol` may be a date column (values
 * parsed via `parseDate`), a numeric column, or ROW_INDEX. Rows where either
 * side doesn't parse are skipped and counted.
 */
export function extractPoints(
  rows: CSVRow[],
  xCol: string,
  yCol: string,
  isDateX: boolean,
  parseDate: (s: string) => Date | null,
  labelOf: (row: CSVRow) => string,
): { points: ChartPoint[]; skipped: number } {
  const points: ChartPoint[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const y = parseNumeric(r[yCol] ?? "");
    let x: number | null;
    if (xCol === ROW_INDEX) x = i + 1;
    else if (isDateX) {
      const d = parseDate(r[xCol] ?? "");
      x = d ? d.getTime() : null;
    } else x = parseNumeric(r[xCol] ?? "");
    if (x === null || y === null) { skipped++; return; }
    points.push({ x, y, label: labelOf(r) });
  });
  return { points, skipped };
}

// ── The Chart view ───────────────────────────────────────────────────────────

/** True when the file has a column pair worth plotting (≥1 numeric column). */
export function hasChartColumns(view: CardView): boolean {
  return view.rows.length >= 2 && numericColumns(view.headers, view.rows).length >= 1;
}

export async function renderChart(view: CardView, container: HTMLElement): Promise<void> {
  const rows = view.getFilteredRows();
  const numCols = numericColumns(view.headers, view.rows);
  if (!numCols.length) {
    container.createEl("p", { text: "No numeric column to chart.", cls: "csv-empty-state" });
    return;
  }

  if (view.searchQuery.trim()) {
    container.createDiv({ cls: "csv-search-results", text: `Chart over ${rows.length} of ${view.rows.length} entries` });
  }

  const cfg = view.fileCfg;
  const dateCol = view.getDateCol();

  // X candidates: the date column first (time series is the common case),
  // then every numeric column, then plain row order as a fallback.
  const xOptions = [...(dateCol ? [dateCol] : []), ...numCols.filter(c => c !== dateCol), ROW_INDEX];
  let xCol = cfg.chartXCol && xOptions.includes(cfg.chartXCol) ? cfg.chartXCol : xOptions[0];
  const yOptions = numCols;
  let yCol = cfg.chartYCol && yOptions.includes(cfg.chartYCol)
    ? cfg.chartYCol
    : yOptions.find(c => c !== xCol) ?? yOptions[0];
  const fit: "none" | "linear" = cfg.chartFit === "linear" ? "linear" : "none";
  const formula = cfg.chartFormula ?? "";

  const wrap = container.createDiv({ cls: "csv-chart-view" });

  // ── Controls ──────────────────────────────────────────────────────────────
  const controls = wrap.createDiv({ cls: "csv-chart-controls" });
  const save = (patch: Partial<typeof cfg>) => {
    view.saveFileCfg({ ...view.fileCfg, ...patch });
    view.renderViewPreservingScroll();
  };
  const labeledSelect = (label: string, options: string[], value: string, onChange: (v: string) => void) => {
    const group = controls.createDiv({ cls: "csv-chart-control" });
    group.createSpan({ cls: "csv-chart-control-label", text: label });
    const sel = group.createEl("select", { cls: "csv-chart-select", attr: { "aria-label": label } });
    options.forEach(o => {
      const opt = sel.createEl("option", { text: o, value: o });
      if (o === value) opt.selected = true;
    });
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  };

  labeledSelect("X", xOptions, xCol, v => save({ chartXCol: v }));
  labeledSelect("Y", yOptions, yCol, v => save({ chartYCol: v }));

  const fitBtn = controls.createEl("button", {
    cls: `csv-cfg-btn csv-chart-fit-btn ${fit === "linear" ? "active" : ""}`,
    text: "Best fit",
    title: "Toggle a least-squares fit line",
  });
  fitBtn.addEventListener("click", () => save({ chartFit: fit === "linear" ? "none" : "linear" }));

  // Formula applies on Enter/blur, not per keystroke — the whole view
  // re-renders on apply, which would eat the input focus mid-typing.
  const formulaWrap = controls.createDiv({ cls: "csv-chart-control csv-chart-formula-wrap" });
  formulaWrap.createSpan({ cls: "csv-chart-control-label", text: "y =" });
  const formulaInput = formulaWrap.createEl("input", {
    cls: "csv-chart-formula-input",
    type: "text",
    value: formula,
    placeholder: "overlay, e.g. 2x + 1",
    attr: { spellcheck: "false", autocomplete: "off", enterkeyhint: "done" },
  });
  const applyFormula = () => {
    if (formulaInput.value.trim() === formula.trim()) return;
    save({ chartFormula: formulaInput.value });
  };
  formulaInput.addEventListener("change", applyFormula);
  formulaInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); formulaInput.blur(); } });

  // ── Chart ─────────────────────────────────────────────────────────────────
  const isDateX = xCol !== ROW_INDEX && (xCol === dateCol || view.isDateCol(xCol));
  const { points, skipped } = extractPoints(rows, xCol, yCol, isDateX, s => view.parseDate(s), r => view.getTitle(r));

  const canvasWrap = wrap.createDiv({ cls: "csv-chart-wrap" });
  const canvas = canvasWrap.createEl("canvas", { cls: "csv-chart-canvas" });
  const footer = wrap.createDiv({ cls: "csv-chart-footer" });

  if (!points.length) {
    canvasWrap.remove();
    footer.remove();
    wrap.createEl("p", { text: `No rows with both "${xCol}" and "${yCol}" values to plot.`, cls: "csv-empty-state" });
    return;
  }

  const spec: ChartSpec = {
    points,
    xIsDate: isDateX,
    xLabel: xCol === ROW_INDEX ? "row" : xCol,
    yLabel: yCol,
    connect: isDateX,   // time series read better connected; numeric pairs as dots
    fit,
    formula,
  };
  const built = buildChartConfig(spec, resolveChartColors(container));

  if (built.fitText) footer.createSpan({ cls: "csv-chart-fit-text", text: built.fitText });
  if (built.formulaError) footer.createSpan({ cls: "csv-chart-formula-error", text: `formula: ${built.formulaError}` });
  if (skipped > 0) footer.createSpan({ cls: "csv-chart-skipped", text: `${skipped} row${skipped === 1 ? "" : "s"} skipped (no numeric value)` });

  // Same lazy-load + stale-canvas guard as the dashboard chart.
  if (view.chartInstance) { view.chartInstance.destroy(); view.chartInstance = null; }
  const { Chart } = await loadChart();
  if (!canvas.isConnected) return;
  view.chartInstance = new Chart(canvas, built.config);
}
