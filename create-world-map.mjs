// Regenerate world-map.svg with a data-iso key on EVERY country — the old
// asset (inherited from the travel-tracker visualizer) had 55 paths with
// data-iso="", leaving Australia, Brazil, Argentina, Iceland, Austria, and
// 50 others permanently uncolorable in the travel view.
//
// Source: world-atlas countries-110m (Natural Earth, public domain).
// Projection: NaturalEarth1 fitted to the same 960×500 viewBox; coordinates
// integer-rounded like the old quantized asset to keep the size down.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as topojson from "topojson-client";
import { geoNaturalEarth1, geoPath, geoGraticule10 } from "d3-geo";
import countries from "i18n-iso-countries";

const require = createRequire(import.meta.url);
const topo = JSON.parse(readFileSync(require.resolve("world-atlas/countries-110m.json"), "utf8"));
const fc = topojson.feature(topo, topo.objects.countries);

const projection = geoNaturalEarth1();
const land = { type: "FeatureCollection", features: fc.features.filter(f => f.properties.name !== "Antarctica") };
projection.fitExtent([[2, 2], [958, 498]], land);
const path = geoPath(projection);

// Round path coordinates to integers (≈ the old quantization).
const q = d => d ? d.replace(/-?\d+\.\d+/g, n => Math.round(parseFloat(n))) : d;

// Numeric M49 → ISO alpha-2; a couple of world-atlas quirks by name.
const byName = { "Kosovo": "XK", "Somaliland": "SO", "N. Cyprus": "CY" };
const isoOf = f => {
  const a2 = countries.numericToAlpha2(String(f.id).padStart(3, "0"));
  return a2 ?? byName[f.properties.name] ?? "";
};

let out = `<svg id="world-svg" viewBox="0 0 960 500">`;
out += `<path fill="none" stroke="#1a1e2a" stroke-width="0.3" d="${q(path(geoGraticule10()))}"/>`;
let keyed = 0, unkeyed = [];
for (const f of land.features) {
  const iso = isoOf(f);
  const d = q(path(f));
  if (!d) continue;
  if (iso) keyed++; else unkeyed.push(f.properties.name);
  out += `<path class="country-path cp-unvisited" data-iso="${iso}" d="${d}"/>`;
}
out += `</svg>`;
writeFileSync(process.argv[2], out);
console.log(`countries: ${keyed} keyed, unkeyed: [${unkeyed.join(", ")}], size: ${(out.length / 1024).toFixed(0)} KB`);
