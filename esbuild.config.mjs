import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

// Watch builds skip minification so source maps and identifiers stay readable
// in the devtools. Production builds minify — biggest single size win we have
// (about 50% on the SheetJS-heavy bundle).
// Build-time timestamp injected into the bundle. Lets a tiny "Built: …"
// menu entry in the plugin show the user which build they're actually
// running — useful on mobile where sync of the deployed bundle can lag
// behind the desktop build and there's no obvious way to confirm the new
// code arrived. Format: "YYYY-MM-DD HH:mm" in local time.
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const buildTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

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
