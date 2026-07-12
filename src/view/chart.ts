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
import { localISODate, isMultiValueColName } from "../utils";

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

export interface ChartPoint {
  x: number;
  y: number;
  label?: string;
  /** Raw size-by value — mapped to point radius in buildChartConfig. */
  size?: number;
}

/**
 * Centered rolling mean over a time window: each output point is the mean of
 * every input y whose x lies within ±window/2. Right for irregularly sampled
 * personal data (3 runs a week) where a fixed "last N points" window would
 * stretch over wildly different time spans.
 */
export function rollingMean(points: ChartPoint[], windowMs: number): ChartPoint[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const half = windowMs / 2;
  let lo = 0;
  return sorted.map(p => {
    while (lo < sorted.length && sorted[lo].x < p.x - half) lo++;
    let sum = 0, n = 0;
    for (let i = lo; i < sorted.length && sorted[i].x <= p.x + half; i++) {
      sum += sorted[i].y; n++;
    }
    return { x: p.x, y: n ? sum / n : p.y };
  });
}

export type BucketUnit = "week" | "month";

/**
 * Aggregate a time series into calendar buckets: one point per local week
 * (Monday-keyed) or month, y = sum/avg/count of the bucket's values.
 */
export function bucketPoints(points: ChartPoint[], unit: BucketUnit, agg: BarAgg): ChartPoint[] {
  const keyOf = (ms: number): number => {
    const d = new Date(ms);
    if (unit === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const sinceMonday = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime();
  };
  const cells = new Map<number, { sum: number; n: number }>();
  points.forEach(p => {
    const k = keyOf(p.x);
    const c = cells.get(k) ?? { sum: 0, n: 0 };
    c.sum += p.y;
    c.n += 1;
    cells.set(k, c);
  });
  return [...cells.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, c]) => ({ x, y: agg === "count" ? c.n : agg === "sum" ? c.sum : c.sum / c.n }));
}

/** One plotted series — a hue-split bucket, or the whole file when no hue. */
export interface ChartSeries { label: string; points: ChartPoint[]; }

export interface ChartSpec {
  // One entry per hue value (ggplot-style "color by" column), or a single
  // entry with label "" for an un-hued chart.
  series: ChartSeries[];
  xIsDate: boolean;        // X values are ms timestamps → date-formatted ticks
  xLabel: string;
  yLabel: string;
  connect: boolean;        // draw each series as a line (sorted by x) vs dots
  fit: "none" | "linear";  // per-series least-squares line(s)
  formula: string;         // raw y=f(x) text, "" = none
  /** Column name behind ChartPoint.size, for the tooltip. "" = no size-by. */
  sizeLabel?: string;
  /**
   * Rolling-mean window in days (date X only). >0 renders each series as
   * faint raw dots + a smoothed line carrying the legend entry.
   */
  smoothDays?: number;
  // Domain for a pure-formula plot with no data points.
  xMin?: number;
  xMax?: number;
}

/** Theme colors resolved from CSS variables at render time (canvas needs concrete values). */
export interface ChartColors {
  accent: string; muted: string; grid: string; fitLine: string; formula: string;
  /** Categorical palette for hue-split series (Obsidian's extended colors, Tableau-ish fallbacks). */
  series: string[];
}

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
    // Orange is deliberately absent — it stays the formula overlay's color.
    series: [
      v("--color-blue", "#4e79a7"),
      v("--color-green", "#59a14f"),
      v("--color-red", "#e15759"),
      v("--color-purple", "#b07aa1"),
      v("--color-cyan", "#76b7b2"),
      v("--color-pink", "#ff9da7"),
      v("--color-yellow", "#edc948"),
    ],
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

// Dataset with our own bookkeeping flags: fit lines and smoothing's raw dots
// are excluded from the legend (they'd double every hue entry) but still drawn.
type ChartDataset = ChartConfiguration<"scatter" | "line">["data"]["datasets"][number] & { csvIsFit?: boolean; csvSkipLegend?: boolean };

/**
 * Build a Chart.js scatter config from a spec: one dataset per series (hue
 * bucket), optional per-series fit lines, optional formula-overlay dataset.
 * Pure — no DOM, no Chart.js import — so the smoke tests can assert on it
 * without a canvas.
 */
export function buildChartConfig(spec: ChartSpec, colors: ChartColors): BuiltChart {
  const datasets: ChartDataset[] = [];
  const multi = spec.series.length > 1;

  const allPoints = spec.series.flatMap(s => s.points);
  const xs = allPoints.map(p => p.x);
  const xMin = allPoints.length ? Math.min(...xs) : (spec.xMin ?? 0);
  const xMax = allPoints.length ? Math.max(...xs) : (spec.xMax ?? 10);

  // Size-by: map the raw values onto 3–14 px radii with a sqrt scale, so
  // *area* (what the eye reads) tracks the value. Constant columns collapse
  // to a middle size instead of dividing by zero.
  const sized = allPoints.filter(p => p.size !== undefined);
  const sizeMin = sized.length ? Math.min(...sized.map(p => p.size as number)) : 0;
  const sizeMax = sized.length ? Math.max(...sized.map(p => p.size as number)) : 0;
  const radiusOf = (p: ChartPoint, fallback: number): number => {
    if (p.size === undefined) return fallback;
    if (sizeMax === sizeMin) return 7;
    return 3 + 11 * Math.sqrt((p.size - sizeMin) / (sizeMax - sizeMin));
  };

  const fitTexts: string[] = [];
  spec.series.forEach((s, i) => {
    const pts = spec.connect ? [...s.points].sort((a, b) => a.x - b.x) : s.points;
    if (!pts.length) return;
    const color = multi ? colors.series[i % colors.series.length] : colors.accent;
    const baseRadius = spec.connect ? 3 : 4;
    if ((spec.smoothDays ?? 0) > 0) {
      // Smoothing: quiet raw dots + a rolling-mean line that carries the
      // legend entry. The dots keep tooltips (hover any real data point).
      datasets.push({
        type: "scatter",
        label: s.label || spec.yLabel,
        csvSkipLegend: true,
        data: pts,
        backgroundColor: color,
        borderColor: color,
        pointRadius: 2.5,
        pointHoverRadius: 5,
      });
      datasets.push({
        type: "line",
        label: s.label || spec.yLabel,
        data: rollingMean(pts, (spec.smoothDays as number) * 86_400_000),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 0,
        pointHitRadius: 0,
        tension: 0.3,
      });
    } else {
      datasets.push({
        type: spec.connect ? "line" : "scatter",
        label: s.label || spec.yLabel,
        data: pts,
        backgroundColor: color,
        borderColor: color,
        borderWidth: 1.5,
        pointRadius: sized.length ? pts.map(p => radiusOf(p, baseRadius)) : baseRadius,
        pointHoverRadius: sized.length ? pts.map(p => radiusOf(p, baseRadius) + 2) : 6,
        tension: 0.3,
      });
    }

    if (spec.fit === "linear") {
      const fit = linearFit(pts);
      // Each fit spans its own series' x-extent, not the global one — a
      // short series' trend shouldn't be extrapolated across the plot.
      const sxs = pts.map(p => p.x);
      const sMin = Math.min(...sxs), sMax = Math.max(...sxs);
      if (fit && sMax > sMin) {
        datasets.push({
          type: "line",
          label: `${s.label || "Best"} fit`,
          csvIsFit: true,
          data: [
            { x: sMin, y: fit.slope * sMin + fit.intercept },
            { x: sMax, y: fit.slope * sMax + fit.intercept },
          ],
          // Hue-split fits keep their series color so they're attributable;
          // the single-series fit stays the quiet faint dash.
          borderColor: multi ? color : colors.fitLine,
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          pointHitRadius: 0,
        });
        const r2 = ` · R² = ${(Math.round(fit.r2 * 1000) / 1000).toFixed(3)}`;
        const eq = spec.xIsDate
          // Slope is per millisecond — meaningless to read. Phrase it per day.
          ? `${fit.slope * 86_400_000 >= 0 ? "+" : ""}${fmtNum(fit.slope * 86_400_000)} ${spec.yLabel}/day${r2}`
          : `y = ${fmtNum(fit.slope)}x ${fit.intercept >= 0 ? "+" : "−"} ${fmtNum(Math.abs(fit.intercept))}${r2}`;
        fitTexts.push(multi ? `${s.label}: ${eq}` : (spec.xIsDate ? `Trend: ${eq}` : eq));
      }
    }
  });
  const fitText = fitTexts.length ? fitTexts.join("   ·   ") : null;

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
          // Worth showing for hue splits and formula overlays; fit lines and
          // smoothing's raw dots are filtered (they'd double every entry).
          display: datasets.filter(d => !d.csvIsFit && !d.csvSkipLegend).length > 1,
          labels: {
            color: colors.muted,
            boxWidth: 12,
            filter: (item: { datasetIndex?: number }) => {
              const ds = datasets[item.datasetIndex ?? -1];
              return !(ds?.csvIsFit || ds?.csvSkipLegend);
            },
          },
        },
        tooltip: {
          callbacks: {
            label: (item: TooltipItem<"scatter">) => {
              const p = item.raw as ChartPoint;
              const x = spec.xIsDate ? fmtDate(p.x) : fmtNum(p.x);
              const series = multi && item.dataset.label ? `[${item.dataset.label}] ` : "";
              const head = p.label ? `${p.label}: ` : "";
              const size = p.size !== undefined && spec.sizeLabel ? ` · ${spec.sizeLabel}: ${fmtNum(p.size)}` : "";
              return `${series}${head}(${x}, ${fmtNum(p.y)})${size}`;
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
 * Rows → series for an x/y column pair, optionally split by a hue column
 * (ggplot's `color=` aesthetic): one series per distinct hue value, sorted
 * A→Z, empty hue cells bucketed as "—". `xCol` may be a date column (values
 * parsed via `parseDate`), a numeric column, or ROW_INDEX. Rows where either
 * side doesn't parse are skipped and counted.
 */
export function extractSeries(
  rows: CSVRow[],
  xCol: string,
  yCol: string,
  hueCol: string | null,
  sizeCol: string | null,
  isDateX: boolean,
  parseDate: (s: string) => Date | null,
  labelOf: (row: CSVRow) => string,
): { series: ChartSeries[]; skipped: number } {
  const buckets = new Map<string, ChartPoint[]>();
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
    const key = hueCol ? ((r[hueCol] ?? "").trim() || "—") : "";
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    const point: ChartPoint = { x, y, label: labelOf(r) };
    if (sizeCol) {
      const size = parseNumeric(r[sizeCol] ?? "");
      if (size !== null) point.size = size;
    }
    bucket.push(point);
  });
  const series = [...buckets.entries()]
    // A→Z, with the empty-value "—" catch-all pinned last.
    .sort((a, b) => a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0]))
    .map(([label, points]) => ({ label, points }));
  return { series, skipped };
}

/**
 * Columns usable as a hue (color-by) split: 2–10 distinct non-empty values,
 * excluding the given columns (current X/Y, title) and notes-style columns.
 */
export function hueColumns(headers: string[], rows: CSVRow[], exclude: Set<string>): string[] {
  return headers.filter(h => {
    if (exclude.has(h)) return false;
    const distinct = new Set(rows.map(r => (r[h] ?? "").trim()).filter(Boolean));
    return distinct.size >= 2 && distinct.size <= 10;
  });
}

/**
 * Columns usable as a *categorical X* (bar mode): like hue but roomier —
 * up to 30 bars still read fine — and empty cells count as a "—" bar.
 */
export function categoricalXColumns(headers: string[], rows: CSVRow[], exclude: Set<string>): string[] {
  return headers.filter(h => {
    if (exclude.has(h)) return false;
    const distinct = new Set(rows.map(r => (r[h] ?? "").trim()).filter(Boolean));
    return distinct.size >= 1 && distinct.size <= 30;
  });
}

// ── Bar mode (categorical X + aggregate) ─────────────────────────────────────

export type BarAgg = "count" | "sum" | "avg";

export interface BarData {
  categories: string[];
  /** One entry per hue value (single entry, label "", when no hue). Values align with categories. */
  series: { label: string; values: number[] }[];
  skipped: number;
}

/**
 * Aggregate rows into bars: one bar per distinct `xCol` value (multi-value
 * columns like Genre are comma-split — a row counts once per value), with an
 * optional hue split into grouped bars. `agg` "count" ignores yCol; sum/avg
 * skip rows whose Y doesn't parse. Categories sort numeric-aware A→Z with
 * the empty-value "—" bar last.
 */
export function aggregateBars(
  rows: CSVRow[],
  xCol: string,
  yCol: string | null,
  hueCol: string | null,
  agg: BarAgg,
): BarData {
  const cells = new Map<string, Map<string, { sum: number; n: number }>>();
  const hueVals = new Set<string>();
  let skipped = 0;
  const multiX = isMultiValueColName(xCol);

  rows.forEach(r => {
    let y = 0;
    if (agg !== "count") {
      const parsed = parseNumeric(r[(yCol ?? "")] ?? "");
      if (parsed === null) { skipped++; return; }
      y = parsed;
    }
    const rawX = (r[xCol] ?? "").trim();
    const cats = multiX
      ? (rawX ? rawX.split(",").map(s => s.trim()).filter(Boolean) : ["—"])
      : [rawX || "—"];
    const hue = hueCol ? ((r[hueCol] ?? "").trim() || "—") : "";
    hueVals.add(hue);
    cats.forEach(cat => {
      let byHue = cells.get(cat);
      if (!byHue) { byHue = new Map(); cells.set(cat, byHue); }
      const cell = byHue.get(hue) ?? { sum: 0, n: 0 };
      cell.sum += y;
      cell.n += 1;
      byHue.set(hue, cell);
    });
  });

  const catSort = (a: string, b: string) =>
    a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b, undefined, { numeric: true });
  const categories = [...cells.keys()].sort(catSort);
  const series = [...hueVals].sort(catSort).map(hue => ({
    label: hue,
    values: categories.map(cat => {
      const cell = cells.get(cat)?.get(hue);
      if (!cell || cell.n === 0) return 0;
      return agg === "count" ? cell.n : agg === "sum" ? cell.sum : cell.sum / cell.n;
    }),
  }));
  return { categories, series, skipped };
}

/** Chart.js bar config from aggregated data. Pure, like buildChartConfig. */
export function buildBarConfig(data: BarData, xLabel: string, yLabel: string, colors: ChartColors): ChartConfiguration {
  const multi = data.series.length > 1;
  return {
    type: "bar",
    data: {
      labels: data.categories,
      datasets: data.series.map((s, i) => ({
        label: s.label || yLabel,
        data: s.values,
        backgroundColor: multi ? colors.series[i % colors.series.length] : colors.accent,
        borderRadius: 3,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          title: { display: !!xLabel, text: xLabel, color: colors.muted },
          ticks: { color: colors.muted, autoSkip: false, maxRotation: 60 },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          title: { display: !!yLabel, text: yLabel, color: colors.muted },
          ticks: { color: colors.muted },
          grid: { color: colors.grid },
        },
      },
      plugins: {
        legend: { display: multi, labels: { color: colors.muted, boxWidth: 12 } },
      },
    } as ChartConfiguration["options"],
  };
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
  // then every numeric column, row order, then categorical columns — picking
  // a categorical X flips the whole chart into bar/aggregate mode.
  const titleCol = view.titleKey() ?? view.headers[0];
  const catXExclude = new Set<string>([titleCol, ...numCols, ...(dateCol ? [dateCol] : [])]);
  view.headers.forEach(h => { if (view.isNotesCol(h)) catXExclude.add(h); });
  const catXCandidates = categoricalXColumns(view.headers, view.rows, catXExclude);
  const xOptions = [...(dateCol ? [dateCol] : []), ...numCols.filter(c => c !== dateCol), ROW_INDEX, ...catXCandidates];
  let xCol = cfg.chartXCol && xOptions.includes(cfg.chartXCol) ? cfg.chartXCol : xOptions[0];
  const barMode = catXCandidates.includes(xCol);
  const agg: BarAgg = cfg.chartAgg === "sum" || cfg.chartAgg === "avg" ? cfg.chartAgg : "count";
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
  // In bar mode with a plain count, Y is irrelevant — hide it so the
  // controls read "X · Agg" like a pivot, not a broken scatter.
  if (!barMode || agg !== "count") {
    labeledSelect(barMode ? `Y (${agg})` : "Y", yOptions, yCol, v => save({ chartYCol: v }));
  }
  if (barMode) {
    labeledSelect("Agg", ["count", "sum", "avg"], agg,
      v => save({ chartAgg: v as BarAgg }));
  }

  // Hue (ggplot "color by"): split into one colored series per value of a
  // categorical column — grouped bars in bar mode. Only offered when the
  // file has a usable candidate.
  const hueExclude = new Set<string>([xCol, yCol, titleCol]);
  view.headers.forEach(h => { if (view.isNotesCol(h)) hueExclude.add(h); });
  const hueCandidates = hueColumns(view.headers, view.rows, hueExclude);
  const NO_HUE = "—";
  const hueCol = cfg.chartHueCol && hueCandidates.includes(cfg.chartHueCol) ? cfg.chartHueCol : null;
  if (hueCandidates.length) {
    labeledSelect("Color", [NO_HUE, ...hueCandidates], hueCol ?? NO_HUE,
      v => save({ chartHueCol: v === NO_HUE ? undefined : v }));
  }

  // Date-X transforms: bucket by week/month (with its own aggregate), or a
  // 7-day rolling-mean smooth. Mutually exclusive — a bucketed series is
  // already smooth by construction.
  const isDateX = !barMode && xCol !== ROW_INDEX && (xCol === dateCol || view.isDateCol(xCol));
  const bucket: BucketUnit | null = isDateX && (cfg.chartBucket === "week" || cfg.chartBucket === "month") ? cfg.chartBucket : null;
  const bucketAgg: BarAgg = cfg.chartAgg === "avg" || cfg.chartAgg === "count" ? cfg.chartAgg : "sum";
  const smooth = isDateX && !bucket && !!cfg.chartSmooth;
  if (isDateX) {
    labeledSelect("By", ["day", "week", "month"], bucket ?? "day",
      v => save({ chartBucket: v === "day" ? undefined : (v as BucketUnit) }));
    if (bucket) {
      labeledSelect("Agg", ["sum", "avg", "count"], bucketAgg,
        v => save({ chartAgg: v as BarAgg }));
    }
  }

  // Size-by (bubble): a numeric column mapped to point radius. Scatter only —
  // aggregation (bar mode / bucketing) has no per-row point to size.
  const sizeCandidates = numCols.filter(c => c !== yCol && c !== xCol);
  const sizeCol = !barMode && !bucket && cfg.chartSizeCol && sizeCandidates.includes(cfg.chartSizeCol) ? cfg.chartSizeCol : null;
  if (!barMode && !bucket && sizeCandidates.length) {
    labeledSelect("Size", [NO_HUE, ...sizeCandidates], sizeCol ?? NO_HUE,
      v => save({ chartSizeCol: v === NO_HUE ? undefined : v }));
  }

  // ── Bar mode: categorical X → aggregate bars, then done ──────────────────
  if (barMode) {
    const data = aggregateBars(rows, xCol, agg === "count" ? null : yCol, hueCol, agg);
    const canvasWrapB = wrap.createDiv({ cls: "csv-chart-wrap" });
    const canvasB = canvasWrapB.createEl("canvas", { cls: "csv-chart-canvas" });
    if (!data.categories.length) {
      canvasWrapB.remove();
      wrap.createEl("p", { text: `No rows with a "${xCol}" value to chart.`, cls: "csv-empty-state" });
      return;
    }
    if (data.skipped > 0) {
      wrap.createDiv({ cls: "csv-chart-footer" })
        .createSpan({ cls: "csv-chart-skipped", text: `${data.skipped} row${data.skipped === 1 ? "" : "s"} skipped (no numeric value)` });
    }
    const yLabel = agg === "count" ? "count" : `${agg}(${yCol})`;
    const config = buildBarConfig(data, xCol, yLabel, resolveChartColors(container));
    if (view.chartInstance) { view.chartInstance.destroy(); view.chartInstance = null; }
    const { Chart } = await loadChart();
    if (!canvasB.isConnected) return;
    view.chartInstance = new Chart(canvasB, config);
    return;
  }

  const fitBtn = controls.createEl("button", {
    cls: `csv-cfg-btn csv-chart-fit-btn ${fit === "linear" ? "active" : ""}`,
    text: "Best fit",
    title: "Toggle a least-squares fit line",
  });
  fitBtn.addEventListener("click", () => save({ chartFit: fit === "linear" ? "none" : "linear" }));

  if (isDateX && !bucket) {
    const smoothBtn = controls.createEl("button", {
      cls: `csv-cfg-btn csv-chart-smooth-btn ${smooth ? "active" : ""}`,
      text: "Smooth",
      title: "Toggle a 7-day rolling average (raw values stay as dots)",
    });
    smoothBtn.addEventListener("click", () => save({ chartSmooth: smooth ? undefined : true }));
  }

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
  const extracted = extractSeries(rows, xCol, yCol, hueCol, sizeCol, isDateX, s => view.parseDate(s), r => view.getTitle(r));
  const skipped = extracted.skipped;
  const series = bucket
    ? extracted.series.map(s => ({ label: s.label, points: bucketPoints(s.points, bucket, bucketAgg) }))
    : extracted.series;

  const canvasWrap = wrap.createDiv({ cls: "csv-chart-wrap" });
  const canvas = canvasWrap.createEl("canvas", { cls: "csv-chart-canvas" });
  const footer = wrap.createDiv({ cls: "csv-chart-footer" });

  if (!series.some(s => s.points.length)) {
    canvasWrap.remove();
    footer.remove();
    wrap.createEl("p", { text: `No rows with both "${xCol}" and "${yCol}" values to plot.`, cls: "csv-empty-state" });
    return;
  }

  const spec: ChartSpec = {
    series,
    xIsDate: isDateX,
    xLabel: xCol === ROW_INDEX ? "row" : xCol,
    yLabel: bucket ? (bucketAgg === "count" ? `count / ${bucket}` : `${bucketAgg}(${yCol}) / ${bucket}`) : yCol,
    connect: isDateX,   // time series read better connected; numeric pairs as dots
    fit,
    formula,
    sizeLabel: sizeCol ?? "",
    smoothDays: smooth ? 7 : 0,
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
