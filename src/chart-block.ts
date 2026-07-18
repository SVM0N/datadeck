// ─── csv-chart code block: an inline chart in any note ───────────────────────
//
// Embeds a Chart.js scatter/line plot of a CSV's columns — or a pure formula
// curve with no data at all — inside a note, the way csv-view embeds a table.
//
//   ```csv-chart
//   file: ../health.csv     (sibling / ../ walked / vault-relative, like csv-view;
//                            omit entirely for a formula-only plot)
//   x: date                 (optional — default: date column → first numeric)
//   y: weight               (optional — default: first numeric column ≠ x)
//   hue: person             (optional — ggplot-style color-by: one colored
//                            series per distinct value; alias: color:)
//   size: effort            (optional — numeric column mapped to point radius)
//   agg: sum                (aggregate for bar mode and bucket: — count | sum
//                            | avg. Bar mode kicks in when x: is a categorical
//                            column — one bar per value, hue → grouped bars)
//   bucket: week            (date X only: aggregate into week | month buckets)
//   smooth: true            (date X only: rolling-mean line over faint raw
//                            dots; true = 7-day window, or a number of days)
//   fit: linear             (optional per-series best-fit with equation + R²)
//   formula: 0.5x + 2       (optional y = f(x) overlay; the whole plot when
//                            there's no file. See src/formula.ts for syntax.)
//   xmin: -10               (formula-only plots: domain, default -10 … 10)
//   xmax: 10
//   height: 280             (optional px height)
//   ```
//
// Read-only: it re-renders off the vault `modify` event when the source CSV
// changes (edited in a DataDeck tab, a csv-view block, or external sync), but
// never writes. Reuses the extraction / fit / config core from src/view/chart.ts
// and the shared lazy Chart.js loader. Covered by test-view-smoke.mjs.

import { App, MarkdownPostProcessorContext, MarkdownRenderChild, TFile } from "obsidian";
import type { ChartConfiguration } from "chart.js";
import { CSVRow } from "./types";
import { parseCSV, resolvePath, assumeShape } from "./utils";
import { isDateCol } from "./field-types";
import { loadChart } from "./chartjs-loader";
import {
  buildChartConfig, buildBarConfig, aggregateBars, extractSeries, numericColumns,
  resolveChartColors, bucketPoints, ChartSpec, BarAgg, BucketUnit,
} from "./view/chart";

interface ChartBlockOptions {
  file: string;
  x: string;
  y: string;
  hue: string;
  size: string;
  agg: BarAgg | "";
  bucket: BucketUnit | "";
  smooth: number;         // rolling-mean window in days, 0 = off
  fit: "none" | "linear";
  formula: string;
  xmin: number | null;
  xmax: number | null;
  height: number | null;
}

/** Parse the `key: value` lines of a csv-chart block. Forgiving, like csv-view. */
function parseBlockSource(source: string): ChartBlockOptions {
  const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
  const opt = (key: string) =>
    lines.find(l => l.toLowerCase().startsWith(key + ":"))?.slice(key.length + 1).trim() ?? "";
  const num = (key: string): number | null => {
    const n = parseFloat(opt(key));
    return Number.isFinite(n) ? n : null;
  };
  return {
    file: opt("file"),
    x: opt("x"),
    y: opt("y"),
    hue: opt("hue") || opt("color"),
    size: opt("size"),
    agg: (["count", "sum", "avg"].includes(opt("agg").toLowerCase()) ? opt("agg").toLowerCase() : "") as BarAgg | "",
    bucket: (["week", "month"].includes(opt("bucket").toLowerCase()) ? opt("bucket").toLowerCase() : "") as BucketUnit | "",
    // smooth: true → 7-day default; smooth: 14 → explicit window in days.
    smooth: opt("smooth").toLowerCase() === "true" ? 7 : Math.max(0, parseInt(opt("smooth"), 10) || 0),
    fit: opt("fit").toLowerCase() === "linear" ? "linear" : "none",
    formula: opt("formula"),
    xmin: num("xmin"),
    xmax: num("xmax"),
    height: num("height"),
  };
}

/**
 * `instanceof TFile` fast path for real vault files, falling back to duck-
 * typing — mirrors inline-view.ts. The fallback matters across bundles
 * (e.g. smoke tests with a stub vault), where instanceof identity breaks.
 */
function asFile(f: unknown): TFile | null {
  if (f instanceof TFile) return f;
  return f && typeof f === "object" && "basename" in (f) ? assumeShape<TFile>(f) : null;
}

function parseIsoDate(s: string): Date | null {
  const m = (s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

class ChartBlock extends MarkdownRenderChild {
  private chart: { destroy(): void } | null = null;

  constructor(
    containerEl: HTMLElement,
    private app: App,
    private opts: ChartBlockOptions,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.containerEl.addClass("csv-chart-block");
    void (async () => {
      await this.render();
      if (this.opts.file) {
        this.registerEvent(this.app.vault.on("modify", (f) => {
          if (f.path === this.opts.file) void this.render();
        }));
        this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
          if (oldPath === this.opts.file) this.opts.file = f.path;
        }));
      }
    })();
  }

  onunload(): void {
    if (this.chart) { this.chart.destroy(); this.chart = null; }
  }

  private renderError(msg: string): void {
    this.containerEl.empty();
    this.containerEl.createEl("p", { text: `csv-chart: ${msg}`, cls: "csv-add-error" });
  }

  private async render(): Promise<void> {
    const root = this.containerEl;
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    root.empty();

    let built: { config: ChartConfiguration; fitText: string | null; formulaError: string | null };
    let skipped = 0;

    if (this.opts.file) {
      const file = asFile(this.app.vault.getAbstractFileByPath(this.opts.file));
      if (!file) return this.renderError(`File not found: ${this.opts.file}`);
      let headers: string[], rows: CSVRow[];
      try {
        ({ headers, rows } = parseCSV(await this.app.vault.read(file)));
      } catch (e) {
        return this.renderError(`Error reading file: ${e instanceof Error ? e.message : String(e)}`);
      }

      const findCol = (name: string) => headers.find(h => h.toLowerCase() === name.toLowerCase()) ?? null;
      const numCols = numericColumns(headers, rows);
      // Same date heuristic as the views: a date-named column, or a first
      // column whose sample values are yyyy-mm-dd.
      const dateCol = headers.find(h => isDateCol(h))
        ?? (rows.slice(0, 5).length && rows.slice(0, 5).every(r => parseIsoDate(r[headers[0]] ?? "")) ? headers[0] : null);

      const xCol = this.opts.x ? findCol(this.opts.x) : (dateCol ?? numCols[0] ?? null);
      if (this.opts.x && !xCol) return this.renderError(`No column "${this.opts.x}" in ${file.basename}`);
      const yCol = this.opts.y ? findCol(this.opts.y) : numCols.find(c => c !== xCol) ?? null;
      if (this.opts.y && !yCol) return this.renderError(`No column "${this.opts.y}" in ${file.basename}`);
      if (!xCol || !yCol) return this.renderError(`Couldn't auto-pick x/y columns — add "x:" and "y:" lines`);
      const hueCol = this.opts.hue ? findCol(this.opts.hue) : null;
      if (this.opts.hue && !hueCol) return this.renderError(`No column "${this.opts.hue}" in ${file.basename}`);
      const sizeCol = this.opts.size ? findCol(this.opts.size) : null;
      if (this.opts.size && !sizeCol) return this.renderError(`No column "${this.opts.size}" in ${file.basename}`);

      const isDateX = xCol === dateCol || isDateCol(xCol);
      // A categorical X (not numeric, not a date) flips into bar/aggregate
      // mode — same rule as the Chart view's X picker.
      if (!isDateX && !numCols.includes(xCol)) {
        const agg: BarAgg = this.opts.agg || "count";
        const data = aggregateBars(rows, xCol, agg === "count" ? null : yCol, hueCol, agg);
        skipped = data.skipped;
        if (!data.categories.length) return this.renderError(`No rows with a "${xCol}" value to chart`);
        const yLabel = agg === "count" ? "count" : `${agg}(${yCol})`;
        built = { config: buildBarConfig(data, xCol, yLabel, resolveChartColors(root)), fitText: null, formulaError: null };
      } else {
        const extracted = extractSeries(rows, xCol, yCol, hueCol, sizeCol, isDateX, parseIsoDate, r => r[headers[0]] ?? "");
        skipped = extracted.skipped;
        if (!extracted.series.some(s => s.points.length)) return this.renderError(`No rows with numeric "${xCol}" and "${yCol}" values`);

        // Date-X transforms, same semantics as the view: bucket wins over
        // smooth (a bucketed series is already smooth by construction).
        const bucket = isDateX ? this.opts.bucket : "";
        const bucketAgg: BarAgg = this.opts.agg || "sum";
        const series = bucket
          ? extracted.series.map(s => ({ label: s.label, points: bucketPoints(s.points, bucket, bucketAgg) }))
          : extracted.series;

        const spec: ChartSpec = {
          series,
          xIsDate: isDateX,
          xLabel: xCol,
          yLabel: bucket ? (bucketAgg === "count" ? `count / ${bucket}` : `${bucketAgg}(${yCol}) / ${bucket}`) : yCol,
          connect: isDateX,
          fit: this.opts.fit,
          formula: this.opts.formula,
          sizeLabel: bucket ? "" : (sizeCol ?? ""),
          smoothDays: isDateX && !bucket ? this.opts.smooth : 0,
        };
        built = buildChartConfig(spec, resolveChartColors(root));
      }
    } else {
      // Formula-only plot: no data, just the curve over an explicit domain.
      if (!this.opts.formula.trim()) return this.renderError(`Give a "file:" line, a "formula:" line, or both`);
      built = buildChartConfig({
        series: [],
        xIsDate: false,
        xLabel: "x",
        yLabel: "y",
        connect: false,
        fit: "none",
        formula: this.opts.formula,
        xMin: this.opts.xmin ?? -10,
        xMax: this.opts.xmax ?? 10,
      }, resolveChartColors(root));
    }

    if (built.formulaError) return this.renderError(`formula: ${built.formulaError}`);

    const wrap = root.createDiv({ cls: "csv-chart-wrap" });
    if (this.opts.height) wrap.style.height = this.opts.height + "px";
    const canvas = wrap.createEl("canvas", { cls: "csv-chart-canvas" });

    if (built.fitText || skipped > 0) {
      const footer = root.createDiv({ cls: "csv-chart-footer" });
      if (built.fitText) footer.createSpan({ cls: "csv-chart-fit-text", text: built.fitText });
      if (skipped > 0) footer.createSpan({ cls: "csv-chart-skipped", text: `${skipped} row${skipped === 1 ? "" : "s"} skipped (no numeric value)` });
    }

    const { Chart } = await loadChart();
    if (!canvas.isConnected) return;
    this.chart = new Chart(canvas, built.config);
  }
}

/** csv-chart block processor. Each block gets its own child tied to the block's lifecycle. */
export function registerCsvChartBlock(
  app: App,
  register: (lang: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void) => void,
): void {
  register("csv-chart", (source, el, ctx) => {
    const opts = parseBlockSource(source);
    const noteFolder = app.vault.getAbstractFileByPath(ctx.sourcePath)?.parent?.path ?? "";
    const resolved = opts.file ? resolvePath(opts.file, noteFolder) : opts.file;
    ctx.addChild(new ChartBlock(el, app, { ...opts, file: resolved }));
  });
}
