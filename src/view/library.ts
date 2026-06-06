// Library (cards-by-genre) view renderer. Extracted from CardView; the members
// it reaches are public on CardView. Type-only import → no runtime cycle.
// Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { formatRatingForDisplay } from "../utils";

export function renderLibrary(view: CardView, container: HTMLElement): void {
  const cc = view.getCategoryCol();
  const sc = view.getStatusCol();
  const titleCol = view.titleKey() ?? view.headers[0];
  const authorCol = view.authorKey();

  if (!cc) {
    container.createEl("p", { text: `No category column found.`, cls: "csv-empty-state" });
    return;
  }

  // Collect all genres
  const allGenres = new Set<string>();
  view.rows.forEach(row => {
    const cats = (row[cc] ?? "").split(",").map(c => c.trim()).filter(Boolean);
    cats.forEach(c => allGenres.add(c));
  });

  // Collect all statuses
  const allStatuses = new Set<string>();
  if (sc) {
    view.rows.forEach(row => {
      const status = (row[sc] ?? "").trim();
      if (status) allStatuses.add(status);
    });
  }

  // Filters bar
  const filtersBar = container.createDiv({ cls: "csv-library-filters" });

  // Status filter
  const statusSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
  statusSelect.createEl("option", { text: "All", value: "all" });

  // Add common status filters. "yes" and "seen" cover the common
  // Watched=yes / Seen=yes boolean patterns used by movie trackers.
  const commonDone = ["watched", "read", "finished", "completed", "done", "yes", "seen"];
  const commonInProgress = ["watching", "reading", "in progress", "in-progress"];
  const hasDone = Array.from(allStatuses).some(s => commonDone.includes(s.toLowerCase()));
  const hasInProgress = Array.from(allStatuses).some(s => commonInProgress.includes(s.toLowerCase()));

  if (hasDone || hasInProgress) {
    statusSelect.createEl("option", { text: "───────", value: "", attr: { disabled: "true" } });
    if (hasDone) statusSelect.createEl("option", { text: "✓ Done", value: "__done__" });
    if (hasInProgress) statusSelect.createEl("option", { text: "◐ In Progress", value: "__inprogress__" });
    statusSelect.createEl("option", { text: "○ Not Started", value: "__notstarted__" });
  }

  if (allStatuses.size > 0) {
    statusSelect.createEl("option", { text: "───────", value: "", attr: { disabled: "true" } });
    Array.from(allStatuses).sort().forEach(s => {
      statusSelect.createEl("option", { text: s, value: s });
    });
  }
  statusSelect.value = view.libraryStatusFilter;

  // Genre filter
  const genreSelect = filtersBar.createEl("select", { cls: "csv-library-filter-select" });
  genreSelect.createEl("option", { text: "All genres", value: "all" });
  Array.from(allGenres).sort().forEach(g => {
    genreSelect.createEl("option", { text: g, value: g });
  });
  genreSelect.value = view.libraryGenreFilter;

  // Search lives in the toolbar (the 🔍 toggle on mobile, always-visible
  // input on desktop). Library used to render its own search input here,
  // duplicating the one in the toolbar — both wrote to the same
  // view.searchQuery. Removed.

  // Filter handlers
  const applyFilters = () => {
    view.libraryStatusFilter = statusSelect.value;
    view.libraryGenreFilter = genreSelect.value;
    view.renderView(true);
  };

  statusSelect.addEventListener("change", applyFilters);
  genreSelect.addEventListener("change", applyFilters);

  // Filter rows
  let filtered = view.rows.filter(row => {
    // Status filter
    if (view.libraryStatusFilter !== "all" && sc) {
      const rowStatus = (row[sc] ?? "").toLowerCase();
      if (view.libraryStatusFilter === "__done__") {
        if (!commonDone.includes(rowStatus)) return false;
      } else if (view.libraryStatusFilter === "__inprogress__") {
        if (!commonInProgress.includes(rowStatus)) return false;
      } else if (view.libraryStatusFilter === "__notstarted__") {
        if (commonDone.includes(rowStatus) || commonInProgress.includes(rowStatus)) return false;
      } else {
        if (rowStatus !== view.libraryStatusFilter.toLowerCase()) return false;
      }
    }

    // Genre filter
    if (view.libraryGenreFilter !== "all") {
      const rowGenres = (row[cc] ?? "").split(",").map(c => c.trim().toLowerCase());
      if (!rowGenres.includes(view.libraryGenreFilter.toLowerCase())) return false;
    }

    // Search filter
    if (view.searchQuery.trim()) {
      const title = (row[titleCol] ?? "").toLowerCase();
      if (!title.includes(view.searchQuery.toLowerCase())) return false;
    }

    return true;
  });

  // Result count
  if (view.libraryStatusFilter !== "all" || view.libraryGenreFilter !== "all" || view.searchQuery.trim()) {
    container.createDiv({
      cls: "csv-library-result-count",
      text: `Showing ${filtered.length} of ${view.rows.length} entries`
    });
  }

  // Group by genre
  const groups: Record<string, CSVRow[]> = {};
  filtered.forEach(row => {
    const cats = view.libraryGenreFilter !== "all"
      ? [view.libraryGenreFilter]
      : (row[cc] ?? "Uncategorized").split(",").map(c => c.trim()).filter(Boolean);
    if (cats.length === 0) cats.push("Uncategorized");
    cats.forEach(cat => {
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(row);
    });
  });

  // Render sections
  const sectionsWrap = container.createDiv({ cls: "csv-library-sections" });

  Object.keys(groups).sort().forEach(genre => {
    const items = groups[genre];
    const section = sectionsWrap.createEl("details", { cls: "csv-library-section" });
    section.open = true;

    const summary = section.createEl("summary", { cls: "csv-library-section-header" });
    summary.innerHTML = `<span class="csv-library-arrow">▶</span> ${genre} <span class="csv-library-count">${items.length}</span>`;

    const grid = section.createDiv({ cls: "csv-library-grid" });

    // Sort: green-dotted (read/watched/finished) first, then in-progress,
    // then everything else. Within each group, alphabetical by title.
    // Rationale: surfacing what you've already done makes the section read
    // as a library catalogue (consumed → backlog) rather than a todo list.
    items.sort((a, b) => {
      if (sc) {
        const statusA = (a[sc] ?? "").toLowerCase();
        const statusB = (b[sc] ?? "").toLowerCase();
        const doneA = commonDone.includes(statusA);
        const doneB = commonDone.includes(statusB);
        if (doneA !== doneB) return doneA ? -1 : 1;
        const inProgressA = commonInProgress.includes(statusA);
        const inProgressB = commonInProgress.includes(statusB);
        if (inProgressA !== inProgressB) return inProgressA ? -1 : 1;
      }
      return (a[titleCol] ?? "").localeCompare(b[titleCol] ?? "");
    });

    // Resolve which extra columns to surface on each card.
    // If the user picked cardFields in the per-file Columns modal, use that list verbatim.
    // Otherwise auto-detect: author, year, rating, theme.
    const yearCol = view.resolveCol(["Year", "year", "Date", "date"]);
    const ratingCol = view.resolveCol(["Rating", "rating", "Score", "score", "Score /5", "Stars", "stars"]);
    const themeCol = view.resolveCol(["Theme", "theme", "Tags", "tags", "Tag", "tag", "Mood", "mood"]);
    const autoFields = [authorCol, yearCol, ratingCol, themeCol].filter((c): c is string => !!c);
    const cardFields = view.fileCfg.cardFields ?? autoFields;

    items.forEach(row => {
      const card = grid.createDiv({ cls: "csv-library-card" });

      // Title with green dot for "done"-style status (watched, read, finished, etc.)
      const titleWrap = card.createDiv({ cls: "csv-library-card-title" });
      if (sc) {
        const status = (row[sc] ?? "").toLowerCase();
        if (commonDone.includes(status)) {
          titleWrap.createSpan({ cls: "csv-library-done-dot" });
        }
      }
      titleWrap.createSpan({ text: row[titleCol] ?? "Untitled" });

      // Walk cardFields in order, rendering each with the right element type.
      // Rating → stars line; theme/tag/category aliases → pills; everything else → meta line.
      const metaParts: string[] = [];
      const themeFieldsForCard: string[] = [];
      for (const col of cardFields) {
        if (!col) continue;
        const raw = String(row[col] ?? "").trim();
        if (!raw) continue;

        if (col === ratingCol) {
          // Render rating as stars on its own line. Already-star data passes through.
          const display = formatRatingForDisplay(raw, col);
          if (display) card.createDiv({ cls: "csv-library-card-rating", text: display });
        } else if (col === themeCol) {
          // Comma-separated theme values render as multiple pills.
          themeFieldsForCard.push(...raw.split(",").map(t => t.trim()).filter(Boolean));
        } else if (col === yearCol) {
          // Year — extract 4-digit if it's a full date.
          const m = raw.match(/\d{4}/);
          metaParts.push(m ? m[0] : raw);
        } else {
          metaParts.push(raw);
        }
      }
      if (metaParts.length) {
        card.createDiv({ cls: "csv-library-card-meta", text: metaParts.join(" · ") });
      }

      // Secondary genres render as extra tags when filtering by a single genre.
      if (view.libraryGenreFilter !== "all") {
        const otherGenres = (row[cc] ?? "").split(",").map(c => c.trim()).filter(c => c && c.toLowerCase() !== view.libraryGenreFilter.toLowerCase());
        themeFieldsForCard.push(...otherGenres);
      }
      if (themeFieldsForCard.length) {
        const tagsWrap = card.createDiv({ cls: "csv-library-card-tags" });
        themeFieldsForCard.slice(0, 3).forEach(tag => {
          tagsWrap.createSpan({ cls: "csv-library-card-tag", text: tag });
        });
      }

      // Click to expand
      card.addEventListener("click", () => {
        const notesCol = view.getNotesCol();
        if (notesCol) {
          view.openNoteExpander(row, notesCol);
        }
      });
      card.addEventListener("contextmenu", e => view.openRowContextMenu(row, e));
    });
  });

  if (Object.keys(groups).length === 0) {
    sectionsWrap.createEl("p", { text: "No entries match your filters.", cls: "csv-empty-state" });
  }
}
