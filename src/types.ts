// ─── Types ────────────────────────────────────────────────────────────────────

export interface CSVRow { [key: string]: string; }
export type ViewMode = "kanban-genre" | "table" | "dashboard" | "library" | "travel" | "stats" | "focus" | "tasks" | "chart" | "budget" | "timeline";

// ─── Residency / threshold rules (travel view) ──────────────────────────────
// A declarative rule: count days a person was in `scope` within `window`,
// excluding `exempt` visa statuses, compared to `threshold`. Rendered as a
// used/threshold gauge. See src/residency.ts for evaluation.
export interface ResidencyRule {
  label: string;
  scope: { country?: string; countries?: string[] };   // ISO-2
  window: { type: "calendar-year" | "rolling" | "all-time"; days?: number };
  threshold: number;
  exempt?: { visa_status?: string[] };
  onExceed?: string;   // status word shown when over (e.g. "tax resident")
  note?: string;       // optional caveat shown under the gauge
}

// 26 Schengen-area countries (for the rolling 90/180 rule).
export const SCHENGEN = ["AT","BE","CZ","DK","EE","FI","FR","DE","GR","HU","IS","IT","LV","LI","LT","LU","MT","NL","NO","PL","PT","SK","SI","ES","SE","CH"];

// A single neutral example so the feature is discoverable out of the box.
// Users add their own jurisdictions in Settings → CSV Card View (stored in
// data.json, never committed). Schengen 90/180 is a public standard — it
// reveals nothing personal and demonstrates the rolling multi-country window.
export const DEFAULT_RESIDENCY_RULES: ResidencyRule[] = [
  { label: "🇪🇺 Schengen 90/180 (example)", scope: { countries: SCHENGEN }, window: { type: "rolling", days: 180 }, threshold: 90, note: "Example rule — add your own in Settings → CSV Card View." },
];

// Per-file overrides, keyed by vault file path
export interface FileConfig {
  titleColumn?: string;       // Column treated as the title/primary identifier.
                              // Unset = auto-detect by name (Title/Name).
  categoryColumn?: string;
  notesColumn?: string;
  statusColumn?: string;
  habitColumns?: string[];  // Columns to track as habits in dashboard view
  cardFields?: string[];    // Columns to surface on Library / Kanban cards.
                            // If unset, auto-detect (author/year/rating/theme).
                            // Empty array means "no extra fields, just title".
  defaultMode?: ViewMode;
  sortNewestFirst?: boolean;  // Sort by date column, newest first
  kanbanGroupCol?: string;    // Kanban "Group by" column. Unset = category column.
                              // Year-like columns bucket into decades.
  librarySort?: LibrarySort;  // Card-view section ordering. Unset = "status".
  imageColumn?: string;       // Column holding an image (path/wikilink/URL) for
                              // card/kanban thumbnails. Unset = auto-detect by name.
  collapsedGroups?: string[]; // Card-view group values (lowercased) collapsed by
                              // default; remembers manual collapse/expand toggles.
  ankiFrontCol?: string;      // Column used as the Anki card front on sync.
                              // Unset = the title/primary field; every other
                              // non-empty column becomes the card back.
  ankiDeckName?: string;      // Anki deck to sync into. Unset = the file's
                              // basename.
  ankiParentDeck?: string;    // Parent deck path to nest ankiDeckName under
                              // as a subdeck ("Parent::Deck"). Unset = a
                              // top-level deck.
  ankiNoteType?: string;      // Anki note type / model name. Unset = "Basic".
  ankiFieldMap?: { [ankiField: string]: string }; // Anki field name → CSV
                              // column name. The sentinel value "__rest__"
                              // means "every other non-empty column, as
                              // Label: value lines" (the legacy Back
                              // behaviour). Unset = the legacy two-field
                              // Front/Back auto-mapping.
  categoricalColumns?: string[]; // Columns that render as a dropdown (Add
                              // entry / entry editor / mobile add form)
                              // instead of free text. Unset = auto-detect
                              // (settings.selectColumns ∪ low-cardinality
                              // columns, via looksCategorical). The title/
                              // index column and date columns are never
                              // categorical regardless of this list.
  dateColumns?: string[];     // Columns that should be explicitly treated as dates.
  highlightedTitles?: string[]; // Title-column values marked highlighted via
                              // the row context menu. Keyed by value (like
                              // collapsedGroups) rather than a row id — the
                              // CSV has no stable identity column.
  chartXCol?: string;         // Chart view X column. Unset = date col → first
                              // numeric → row number (see src/view/chart.ts).
  chartYCol?: string;         // Chart view Y column. Unset = first numeric ≠ X.
  chartHueCol?: string;       // Chart view "Color by" split column (ggplot hue).
                              // Unset = single series.
  chartSizeCol?: string;      // Chart view "Size by" numeric column → point
                              // radius (bubble). Unset = uniform dots.
  chartAgg?: "count" | "sum" | "avg"; // Aggregate for bar mode (X categorical,
                              // default count) and date bucketing (default sum).
  chartBucket?: "week" | "month"; // Chart view date-X bucketing. Unset = raw days.
  chartSmooth?: boolean;      // Chart view 7-day rolling-mean toggle (date X).
  chartFit?: "none" | "linear"; // Chart view best-fit line toggle.
  chartFormula?: string;      // Chart view y = f(x) overlay (src/formula.ts).
  budgetPriceCol?: string;    // Budget view price/amount column. Unset =
                              // name-alias match, else the "Price" column
                              // function (see src/view/budget.ts).
  budgetLimit?: number;       // Budget view spending cap, set inline in the
                              // view itself. Unset = no limit (total shown
                              // neutral, no over/under coloring).
}

export type LibrarySort = "status" | "title" | "rating" | "year";

export interface CardViewSettings {
  defaultMode: ViewMode;
  notesColumns: string[];
  statusColumn: string;
  categoryColumn: string;
  notesSubfolder: string;
  columnWidths: { [header: string]: number };
  selectColumns: string[];
  fileConfigs: { [filePath: string]: FileConfig };
  residencyRules: ResidencyRule[];
  showResidency: boolean;
}

export const DEFAULT_SETTINGS: CardViewSettings = {
  defaultMode: "kanban-genre",
  notesColumns: ["notes","note","Notes","Note","description","Description","review","Review"],
  statusColumn: "status",
  categoryColumn: "category",
  notesSubfolder: "Notes",
  columnWidths: {},
  selectColumns: ["Category","Type","Rating","Status","rating","type","category","status","Score /5"],
  fileConfigs: {},
  residencyRules: DEFAULT_RESIDENCY_RULES,
  showResidency: true,
};

export const CARD_VIEW_TYPE = "xlsx-card-view";
