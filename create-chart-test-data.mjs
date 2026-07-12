// Generate "Chart Test.csv" — a running log designed to exercise every
// Chart-view feature: date X (time series), three numeric columns (Y +
// size-by), person (3-value hue with visibly different trends), weekday
// (7-value categorical for bar mode).
import fs from "node:fs";

// Deterministic PRNG so regenerating gives the same file.
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const people = {
  // name: [start km, km gained per week, base pace min/km, pace change/week]
  Anna: [5.0, 0.45, 6.2, -0.06],   // building up, getting faster
  Ben:  [8.0, -0.15, 5.1, 0.02],   // tapering off slightly
  Cara: [3.0, 0.70, 7.0, -0.10],   // beginner improving fast
};
const runDays = { Anna: [1, 3, 6], Ben: [2, 5], Cara: [0, 2, 4] }; // 0=Mon offsets
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const rows = [["date", "person", "weekday", "distance_km", "pace_min_per_km", "effort"]];
const start = new Date(2026, 3, 20); // Mon 2026-04-20, ~12 weeks back from mid-July

for (let week = 0; week < 12; week++) {
  for (const [name, [km0, kmW, pace0, paceW]] of Object.entries(people)) {
    for (const off of runDays[name]) {
      const d = new Date(start);
      d.setDate(d.getDate() + week * 7 + off);
      const dist = Math.max(1, km0 + kmW * week + (rand() - 0.5) * 2.2);
      const pace = Math.max(3.4, pace0 + paceW * week + (rand() - 0.5) * 0.5);
      const effort = Math.max(1, Math.min(10, Math.round(dist * pace / 6 + (rand() - 0.5) * 2)));
      rows.push([iso(d), name, weekdays[d.getDay() === 0 ? 6 : d.getDay() - 1], dist.toFixed(1), pace.toFixed(2), String(effort)]);
    }
  }
}

const csv = rows.map(r => r.join(",")).join("\n") + "\n";
const out = process.argv[2];
fs.writeFileSync(out, csv);
console.log(`${rows.length - 1} rows → ${out}`);
