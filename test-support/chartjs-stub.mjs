// Minimal "chart.js" stub for the dashboard/chart smoke tests — jsdom has no
// canvas 2D context, so the real Chart would throw. loadChart() calls
// Chart.register and `new Chart(canvas, cfg)`; both are no-ops here, but the
// last-constructed config is kept so tests can assert on datasets/scales.
export class Chart {
  static lastConfig = null;
  constructor(_canvas, config) { Chart.lastConfig = config ?? null; }
  destroy() {}
  static register() {}
}
export class LineController {}
export class ScatterController {}
export class BarController {}
export class LineElement {}
export class PointElement {}
export class BarElement {}
export class LinearScale {}
export class CategoryScale {}
export class Filler {}
export class Tooltip {}
export class Legend {}
