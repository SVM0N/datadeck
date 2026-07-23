# Dev workflow

Reference doc — load when running the dev loop, adding tests, or debugging build/deploy. For what the code does, see [architecture.md](architecture.md); for the CSS surface, see [css-classes.md](css-classes.md).

## Project structure

```
datadeck/
├── main.ts                       # CardView, Settings, Plugin
├── main.js                       # Compiled output — do not edit directly (minified,
│                                 # post-CSV migration; was much larger with SheetJS)
├── bench-load.mjs                # Measures bundle parse/eval cost; run after big refactors
├── src/                          # types, utils, modals, and one file per view mode
│                                 # under src/view/ (table, kanban, library, tasks, budget,
│                                 # timeline, chart, dashboard, focus, stats, toolbar, anki)
├── styles.css                    # All plugin CSS
├── manifest.json                 # Obsidian plugin manifest (id: datadeck)
├── package.json                  # deps: chart.js, papaparse, esbuild, obsidian types
│                                 # (xlsx/SheetJS removed in "SWITCH TO CSV AS MAIN")
├── esbuild.config.mjs            # Build config
├── tsconfig.json                 # TypeScript config
├── test-csv-parser.mjs           # CSV parsing tests
├── test-plugin-logic.mjs         # Plugin logic tests — sanitization, parsing, column
│                                 # resolution, round-trip, edge cases, resolvePath,
│                                 # migrateFileConfigKey, and more
├── test-view-smoke.mjs           # DOM regression harness for view renderers
├── test-support/                 # jsdom + Obsidian/Chart.js stubs for the smoke harness
├── migrate-xlsx-to-csv.mjs       # One-shot migration script for anyone still on an xlsx-era
│                                 # install: writes canonical csv, archives xlsx to Archive/,
│                                 # rewrites fileConfigs keys
├── create-chart-test-data.mjs    # Generates a synthetic Chart Test.csv fixture
├── create-world-map.mjs          # Regenerates world-map.svg from source map data
├── world-map.svg                 # Static country-outline asset for the travel view
├── docs/                         # Reference docs (architecture, css-classes, dev-workflow)
└── (local/, handoff.md)          # gitignored personal dev tooling + session notes —
                                  # not part of the published repo
```

## Live data location

Live data is any folder of CSVs in the vault. `Mobile/` and `Archive/` subfolders are created as needed by the plugin on first click of the respective buttons; `Archive/` also holds `*_pre-csv-migration.xlsx` originals preserved by the migration script and `* sync-conflict *.csv` stashes from the sync guard.

## Build & Deploy

```bash
npm install              # Install dependencies
npm run build            # Build main.js (minified, ~720 KB)
npm run build:deploy     # Build and copy to Obsidian plugin folder
npm run dev              # Watch mode (rebuild on changes, unminified, inline sourcemaps)
npm run deploy           # Copy already-built files to Obsidian plugin folder
```

Watch mode is unminified with inline sourcemaps so DevTools in Obsidian stays readable during dev. Production builds (`npm run build`, `build:deploy`) minify.

Install in Obsidian: copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/datadeck/` and enable in Community plugins. The `datadeck/` folder in this repo is a symlink to that path, so `npm run deploy` (or `build:deploy`) updates the plugin in place. Reload with `npm run reload` (Obsidian CLI — see below) or Cmd+R in Obsidian.

## Testing

```bash
npm run test             # Plugin logic tests (88)
npm run test:csv         # CSV parser tests (6)
npm run test:all         # All of the above (115 total)
npm run typecheck        # TypeScript type checking
npm run check            # Full check: typecheck + tests + build + deploy
```

### Test surface

- **CSV parsing** — CRLF, quotes, escaping, long fields, embedded newlines, Unicode, empty input.
- **Column resolution** — case-insensitive matching, fallback chains.
- **Round-trip serialization** — Papa unparse → parseCSV round-trip stability.
- **Title case, binary col detection, date col detection, search filtering.**
- **`findExistingRowByDate` / `mergeHabitEntry` / `sortByDate`** — habit-tracker write paths.
- **`formatRatingForDisplay`** (9) — empty / unrated / glyph-pass-through / numeric / text-mapped / out-of-range / unknown-on-rating-col / unknown-on-other-col.
- **`resolvePath`** (9) — sibling / vault-relative / `../` / `../../` / `./` / mixed / root-clamp.
- **`migrateFileConfigKey`** (4) — rename moves config, delete drops it, no-op for missing keys, caller-set new entry wins.
- **Mobile dashboard simulator** (21) — per-file no-throw + render assertions, movie-specific compact-grid/year/rating/theme checks, generic-table wrap, watched-dot count.

The mobile simulator runs the dataviewjs body against real CSVs via Papa Parse with `dynamicTyping: true`, so any drift between template and rendered output fails the test the same way it would fail in Obsidian.

## Active dev loop

```bash
npm run build:deploy && npm run test:all
npm run reload           # hot-reload the plugin in the running Obsidian (no Cmd+R)
npm run errors           # surface any runtime errors the reload produced
```

Mobile-dashboard regeneration/verification lives in the gitignored `local/` tooling (`OBSIDIAN_VAULT` env var required).

`npm run check:live` chains the whole thing: typecheck + tests + build + deploy + reload + error check.

## Obsidian CLI (driving the running app)

The `obsidian` CLI (ships with Obsidian ≥1.12, desktop must be running) can drive the live app — this replaces the manual "Cmd+R and click around" step for most verification. Full reference: `obsidian help` or https://help.obsidian.md/cli.

```bash
obsidian plugin:reload id=datadeck      # reload after build:deploy (= npm run reload)
obsidian dev:errors                          # captured plugin errors (= npm run errors)
obsidian dev:console level=error             # console output
obsidian dev:screenshot path=shot.png        # screenshot the app for visual verification
obsidian dev:dom selector=".csv-card" text   # inspect rendered DOM (CSS classes: css-classes.md)
obsidian dev:css selector=".csv-chip-value" prop=max-width
obsidian dev:mobile on                       # toggle mobile emulation (kanban scroll-snap etc.)
obsidian eval code="app.vault.getFiles().length"
```

Typical verify pass after a change: `npm run check:live`, then `dev:screenshot` / `dev:dom` against an open CSV view instead of eyeballing, and `dev:mobile on` to check the phone layout without a device. Commands target the most recently focused vault; pass `vault="<name>"` first if several are open.

## Bench

`node bench-load.mjs main.js` measures V8 parse cost on the bundle text + parse+top-level eval. 5-run averages. Current baseline:

| Stage | Size | Parse only | Parse+eval |
|---|---|---|---|
| Eager + unminified (historical) | 1338 KB | 2.6 ms | 3.4 ms |
| Lazy + unminified | 1533 KB | 2.0 ms | 0.8 ms |
| Lazy + minified (with SheetJS) | 720 KB | 1.5 ms | 0.9 ms |
| **CSV-only (current, post-migration)** | **297 KB** | **0.7 ms** | **0.5 ms** |

Chart.js is dynamic-imported (only initialises when dashboard renders). SheetJS is gone entirely — the CSV-only migration retired it. Run the bench after any refactor that touches imports/bundling.

## Settings persistence (data.json)

All plugin settings saved to:

```
<vault>/.obsidian/plugins/datadeck/data.json
```

Obsidian writes this automatically via `saveData()` / `loadData()`. Persists across sessions, restarts, and devices (travels with vault on iCloud sync). Example:

```json
{
  "defaultMode": "kanban-genre",
  "statusColumn": "status",
  "categoryColumn": "category",
  "notesSubfolder": "Notes",
  "columnWidths": { "Name": 240, "Notes": 400 },
  "selectColumns": ["Category", "Type", "Rating", "Status"],
  "fileConfigs": {
    "Library/books.csv": {
      "categoryColumn": "Category",
      "notesColumn": "Notes",
      "statusColumn": "Status",
      "defaultMode": "kanban-genre"
    }
  }
}
```

File-rename/delete hooks migrate `fileConfigs` keys automatically — old `Library/Data/...` entries in the user's live `data.json` may still be orphaned from before that fix; hand-edit if you want them back. The SWITCH TO CSV AS MAIN migration also rewrote `*.xlsx` keys to `*.csv` in-place.

## Manual test checklist

- Open `books.csv` → opens in By Genre view.
- Genre columns render with status subgroups (In progress / Finished / Not started).
- Hover card → buttons appear; click the note preview → textarea opens inline; blur saves and scroll position restored.
- Click "⤢ Expand" → NoteExpanderModal opens; fields bar shows all columns; text fields click-to-edit; select chips open picker; click rendered notes to edit; Cancel discards; Save & close commits.
- Click "+ Add" → AddEntryModal opens; all fields present; select chips work; submit adds row, notice shown.
- Click "⚙ Columns" → FileConfigModal opens; dropdowns show all headers; checkbox grid for habit cols + cardFields; save persists to data.json.
- Long chip values truncate with `…`; full text shown on hover.
- Switch to Table view; resize columns; click notes cell → NoteExpanderModal opens (no inline editing).
- Right-click kanban / library / table row → change status, delete (with undo).
- Delete a row → 6s Notice with Undo button → click Undo, row restored to original index.
- Click "💾 Backup" → `Archive/<basename>_<date>.csv` appears (byte-identical to source); same-day repeat refused.
- Verify csv saved correctly by reopening or checking mtime.
