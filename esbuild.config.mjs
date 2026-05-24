import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

// Watch builds skip minification so source maps and identifiers stay readable
// in the devtools. Production builds minify — biggest single size win we have
// (about 50% on the SheetJS-heavy bundle).
// Build-time timestamp injected into the bundle. Lets a tiny "Built: …"
// menu entry in the plugin show the user which build they're actually
// running — useful on iPhone where iCloud sync of the deployed bundle
// can lag behind the desktop build and there's no obvious way to confirm
// the new code arrived. Format: ISO-ish "YYYY-MM-DD HH:mm" in local time.
const buildTime = new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 16);

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
