// Shared lazy Chart.js loader. Chart.js is ~200KB of init cost, so it's only
// paid the first time a chart actually renders (dashboard progress chart,
// Chart view, or a csv-chart block) — sessions that never chart never load it.
// Registers the superset of components those three consumers use; registering
// is idempotent so the union is cheaper than per-consumer bookkeeping.
// Covered by test-view-smoke.mjs (with a chart.js stub).

type ChartModule = typeof import("chart.js");

let chartModule: ChartModule | null = null;

export async function loadChart(): Promise<ChartModule> {
  if (chartModule) return chartModule;
  const mod = await import("chart.js");
  mod.Chart.register(
    mod.LineController, mod.ScatterController,
    mod.LineElement, mod.PointElement,
    mod.LinearScale, mod.CategoryScale,
    mod.Filler, mod.Tooltip, mod.Legend,
  );
  chartModule = mod;
  return mod;
}
