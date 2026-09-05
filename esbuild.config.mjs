import esbuild from "esbuild";
import { execSync } from "node:child_process";

const isWatch = process.argv.includes("--watch");

// Watch builds skip minification so source maps and identifiers stay readable
// in the devtools. Production builds minify — biggest single size win we have
// (about 50% on the SheetJS-heavy bundle).
// Build-time timestamp injected into the bundle. Lets a tiny "Built: …"
// menu entry in the plugin show the user which build they're actually
// running — useful on mobile where sync of the deployed bundle can lag
// behind the desktop build and there's no obvious way to confirm the new
// code arrived. Format: "YYYY-MM-DD HH:mm".
//
// Derived from the checked-out commit's own timestamp, NOT wall-clock time —
// a `new Date()` here would stamp a different value on every invocation,
// making the bundle unreproducible (two builds of the identical commit would
// never byte-match, which is exactly what Obsidian's release-review
// build-verification step checks for). Falls back to "unknown" outside a git
// checkout (e.g. a source tarball with no .git directory).
let buildTime = "unknown";
try {
  buildTime = execSync("git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M'", { encoding: "utf8" }).trim();
} catch { /* no git metadata available — leave "unknown" */ }

const buildOptions = {
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  sourcemap: isWatch ? "inline" : false,
  minify: !isWatch,
  logLevel: "info",
  loader: { ".svg": "text" },
  define: {
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
