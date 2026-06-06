// Minimal "chart.js" stub for the dashboard smoke test — jsdom has no canvas
// 2D context, so the real Chart would throw. loadChart() calls Chart.register
// and `new Chart(canvas, cfg)`; both are no-ops here.
export class Chart { constructor() {} destroy() {} static register() {} }
export class LineController {}
export class LineElement {}
export class PointElement {}
export class LinearScale {}
export class CategoryScale {}
export class Filler {}
export class Tooltip {}
