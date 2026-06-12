// Focus view renderer — one entry at a time with big typography and
// prev / random / next navigation. Built for quote and dictionary files
// (which otherwise only get the table), but works for any non-dashboard CSV:
// title front and center, notes rendered as markdown below, remaining fields
// as chips. ←/→ arrow keys navigate when the card has focus.
// Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { showSelectPicker, isMultiValueColName } from "../utils";

export function renderFocus(view: CardView, container: HTMLElement): void {
  const rows = view.getFilteredRows();

  if (view.searchQuery.trim()) {
    container.createDiv({ cls: "csv-search-results", text: `Found ${rows.length} of ${view.rows.length} entries` });
  }
  if (!rows.length) {
    const empty = container.createDiv({ cls: "csv-empty-state" });
    empty.createEl("p", { text: view.searchQuery ? "No matching entries found." : "No entries yet." });
    if (view.searchQuery) {
      empty.createEl("button", { cls: "csv-clear-filters-btn", text: "Clear search" })
        .addEventListener("click", () => { view.searchQuery = ""; view.renderView(); });
    }
    return;
  }

  // Clamp — search filtering or deletes may have shrunk the list since the
  // index was last set.
  if (view.focusIndex >= rows.length) view.focusIndex = rows.length - 1;
  if (view.focusIndex < 0) view.focusIndex = 0;
  const row = rows[view.focusIndex];

  const titleCol = view.titleKey() ?? view.headers[0];
  const notesCol = view.getNotesCol();
  const authorCol = view.authorKey();

  const wrap = container.createDiv({ cls: "csv-focus-wrap", attr: { tabindex: "0" } });

  const goTo = (idx: number) => {
    view.focusIndex = ((idx % rows.length) + rows.length) % rows.length;
    view.focusNavPending = true;
    view.renderView(true);
  };

  // ── Card ────────────────────────────────────────────────────────────────
  const card = wrap.createDiv({ cls: "csv-focus-card" });
  card.createDiv({ cls: "csv-focus-position", text: `${view.focusIndex + 1} / ${rows.length}` });

  const titleEl = card.createDiv({ cls: "csv-focus-title", text: view.getTitle(row) });
  if (notesCol) {
    titleEl.addClass("is-clickable");
    titleEl.title = "Open entry";
    titleEl.addEventListener("click", () => view.openNoteExpander(row, notesCol));
  }

  const sub = view.getSubtitle(row);
  if (sub) card.createDiv({ cls: "csv-focus-sub", text: sub });

  // Notes body, rendered as markdown — unless the notes column *is* the
  // title column (quote files: the quote text doubles as both; showing it
  // twice reads as a bug).
  if (notesCol && notesCol !== titleCol && row[notesCol]?.trim()) {
    const body = card.createDiv({ cls: "csv-focus-notes" });
    view.renderMarkdownInto(body, row[notesCol]);
  }

  // Remaining fields as chips. Select columns stay editable in place (same
  // pattern as kanban cards); everything else is a static label: value chip.
  const skip = new Set([titleCol, notesCol, authorCol].filter(Boolean) as string[]);
  const fields = view.headers.filter(h => !skip.has(h) && (row[h] ?? "").trim());
  if (fields.length) {
    const metaEl = card.createDiv({ cls: "csv-focus-meta" });
    fields.forEach(h => {
      const chip = metaEl.createDiv({ cls: "csv-kanban-chip" });
      chip.createSpan({ cls: "csv-chip-label", text: h + ": " });
      if (view.isSelectCol(h)) {
        const valSpan = chip.createSpan({ cls: "csv-chip-value csv-chip-select", text: row[h] });
        valSpan.addEventListener("click", e => {
          e.stopPropagation();
          showSelectPicker(valSpan, row[h], view.getColumnValues(h), (newVal) => {
            row[h] = newVal; valSpan.setText(newVal || "—"); view.scheduleSave();
          }, view.contentEl, { multi: isMultiValueColName(h) });
        });
      } else {
        chip.createSpan({ cls: "csv-chip-value", text: row[h] });
      }
    });
  }

  card.addEventListener("contextmenu", e => view.openRowContextMenu(row, e));

  // ── Navigation ──────────────────────────────────────────────────────────
  const nav = wrap.createDiv({ cls: "csv-focus-nav" });
  const prevBtn = nav.createEl("button", { cls: "csv-focus-nav-btn", text: "‹", title: "Previous (←)" });
  const randBtn = nav.createEl("button", { cls: "csv-focus-nav-btn csv-focus-nav-rand", text: "🔀", title: "Random entry" });
  const nextBtn = nav.createEl("button", { cls: "csv-focus-nav-btn", text: "›", title: "Next (→)" });
  prevBtn.addEventListener("click", () => goTo(view.focusIndex - 1));
  nextBtn.addEventListener("click", () => goTo(view.focusIndex + 1));
  randBtn.addEventListener("click", () => {
    if (rows.length < 2) return;
    let idx = view.focusIndex;
    while (idx === view.focusIndex) idx = Math.floor(Math.random() * rows.length);
    goTo(idx);
  });

  wrap.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") { e.preventDefault(); goTo(view.focusIndex - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goTo(view.focusIndex + 1); }
  });

  // Claim keyboard focus after our own navigation, or when nothing else
  // holds it (mode-button clicks land here with activeElement reset to
  // body, so arrows work immediately after switching to Focus). Never
  // steal from the toolbar search input mid-typing.
  if (view.focusNavPending || document.activeElement === document.body) {
    view.focusNavPending = false;
    wrap.focus({ preventScroll: true });
  }
}
