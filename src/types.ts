// ─── Types ────────────────────────────────────────────────────────────────────

export interface CSVRow { [key: string]: string; }
export type ViewMode = "kanban-genre" | "table" | "dashboard" | "library";

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
}

export interface CardViewSettings {
  defaultMode: ViewMode;
  notesColumns: string[];
  statusColumn: string;
  categoryColumn: string;
  notesSubfolder: string;
  columnWidths: { [header: string]: number };
  selectColumns: string[];
  fileConfigs: { [filePath: string]: FileConfig };
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
};

export const CARD_VIEW_TYPE = "xlsx-card-view";
