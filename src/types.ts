// ─── Types ────────────────────────────────────────────────────────────────────

export interface CSVRow { [key: string]: string; }
export type ViewMode = "kanban-genre" | "table" | "dashboard" | "library" | "travel" | "stats" | "focus" | "tasks";

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
  ankiFrontCol?: string;      // Column used as the Anki card front on sync.
                              // Unset = the title/primary field; every other
                              // non-empty column becomes the card back.
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
