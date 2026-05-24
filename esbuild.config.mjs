import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

// Watch builds skip minification so source maps and identifiers stay readable
// in the devtools. Production builds minify — biggest single size win we have
// (about 50% on the SheetJS-heavy bundle).
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
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
