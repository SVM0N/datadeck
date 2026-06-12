// Kanban-by-genre view renderer (+ its card builder). Extracted from CardView;
// reached members are public. Type-only CardView import → no runtime cycle.
// Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { CSVRow } from "../types";
import { showSelectPicker } from "../utils";

export function renderKanbanGenre(view: CardView, container: HTMLElement): void {
  const cc = view.getCategoryCol();
  const sc = view.getStatusCol();
  if (!cc) { container.createEl("p",{text:`No "${view.settings.categoryColumn}" column found.`,cls:"csv-empty-state"}); return; }

  const filteredRows = view.getFilteredRows();

  // Show search result count if searching
  if (view.searchQuery.trim()) {
    container.createDiv({ cls: "csv-search-results", text: `Found ${filteredRows.length} of ${view.rows.length} entries` });
  }

  const genreSet = new Set<string>();
  filteredRows.forEach(r => (r[cc]??"").split(",").map(s=>s.trim()).filter(Boolean).forEach(c=>genreSet.add(c)));
  const genres = Array.from(genreSet).sort();
  if (!genres.length) {
    const empty = container.createDiv({cls:"csv-empty-state"});
    empty.createEl("p",{text: view.searchQuery ? "No matching entries found." : "No genre values found."});
    if (view.searchQuery) {
      empty.createEl("button", { cls: "csv-clear-filters-btn", text: "Clear search" })
        .addEventListener("click", () => { view.searchQuery = ""; view.renderView(); });
    }
    return;
  }

  const statusOrder = ["In progress","Finished","Not started"];
  const statuses = sc
    ? Array.from(new Set([...statusOrder,...filteredRows.map(r=>r[sc]??"").filter(Boolean)])).filter(s=>filteredRows.some(r=>(r[sc]??"")==s))
    : [];

  const board = container.createDiv({cls:"csv-kanban-board"});
  genres.forEach(genre => {
    const genreRows = filteredRows.filter(r=>(r[cc]??"").split(",").map(s=>s.trim()).includes(genre));
    if (!genreRows.length) return;
    const col = board.createDiv({cls:"csv-kanban-col"});
    const ch = col.createDiv({cls:"csv-kanban-col-header"});
    ch.createDiv({cls:"csv-kanban-col-title", text:genre});
    ch.createDiv({cls:"csv-kanban-col-count", text:String(genreRows.length)});
    const cb = col.createDiv({cls:"csv-kanban-col-body"});

    if (sc && statuses.length) {
      statuses.forEach(status => {
        const statusRows = genreRows.filter(r=>(r[sc]??"")=== status);
        if (!statusRows.length) return;
        const groupEl = cb.createDiv({cls:"csv-kanban-status-group"});
        groupEl.createDiv({cls:`csv-kanban-status-label status-${status.toLowerCase().replace(/\s+/g,"-")}`, text:status});
        statusRows.forEach(row => renderKanbanCard(view, groupEl, row, statuses, sc));
      });
    } else {
      genreRows.forEach(row => renderKanbanCard(view, cb, row, statuses, sc));
    }
  });
}

function renderKanbanCard(view: CardView, container: HTMLElement, row: CSVRow, statuses: string[], sc: string|null): void {
  const card = container.createDiv({cls:"csv-kanban-card"});
  const notesColForCard = view.getNotesCol();

  // Title row: title text on the left, small notes-file icon on the right.
  // Tapping the title opens the entry expander; the small icon creates or
  // opens the sidecar .md. Replaces the old hover-revealed bottom button row.
  const titleRow = card.createDiv({cls:"csv-kanban-card-title-row"});
  const titleEl = titleRow.createDiv({cls:"csv-kanban-card-title", text:view.getTitle(row)});
  if (notesColForCard) {
    titleEl.addEventListener("click", e => { e.stopPropagation(); view.openNoteExpander(row, notesColForCard); });
  }
  const hasNotesFile = view.notesFileExists(row);
  const notesIconBtn = titleRow.createEl("button", {
    cls: `csv-kanban-notes-icon ${hasNotesFile ? "exists" : ""}`,
    text: hasNotesFile ? "📄" : "+",
    title: hasNotesFile ? "Open notes file" : "Create notes file",
  });
  notesIconBtn.addEventListener("click", e => { e.stopPropagation(); view.openOrCreateNotes(row); });

  const sub = view.getSubtitle(row);
  if (sub) card.createDiv({cls:"csv-kanban-card-sub", text:sub});

  // Meta chips for select fields (skip category, title, author, status)
  const tk=view.titleKey(), ak=view.authorKey(), ccol=view.getCategoryCol();
  const skipInCard = new Set([sc, tk, ak, ccol].filter(Boolean) as string[]);
  const metaEl = card.createDiv({cls:"csv-kanban-card-meta"});
  view.headers.forEach(h => {
    if (skipInCard.has(h) || view.isNotesCol(h) || !row[h]) return;
    const chip = metaEl.createDiv({cls:"csv-kanban-chip"});
    chip.createSpan({cls:"csv-chip-label", text:h+": "});
    if (view.isSelectCol(h)) {
      const valSpan = chip.createSpan({cls:"csv-chip-value csv-chip-select", text:row[h]});
      valSpan.addEventListener("click", e => {
        e.stopPropagation();
        showSelectPicker(valSpan, row[h], view.getColumnValues(h), (newVal) => {
          row[h]=newVal; valSpan.setText(newVal||"—"); view.scheduleSave();
        }, view.contentEl);
      });
    } else {
      const display = row[h].length > 40 ? row[h].slice(0, 38) + "…" : row[h];
      const valSpan = chip.createSpan({cls:"csv-chip-value", text: display});
      if (row[h].length > 40) valSpan.title = row[h]; // full text on hover
    }
  });

  // Inline notes
  const notesCol = view.getNotesCol();
  const hasInlineNotes = !!(notesCol && row[notesCol]?.trim());

  // The preview is itself the editor affordance — clicking opens the
  // inline textarea. When there's no note yet, render a quiet "+ Add note"
  // placeholder in the same slot so the click target is discoverable
  // without needing a separate "Edit note" button.
  const notesPreviewEl = card.createDiv({cls:"csv-kanban-notes-preview"});
  if (hasInlineNotes && notesCol) {
    const plain = row[notesCol].replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").replace(/\n+/g," ").trim();
    notesPreviewEl.setText(plain.slice(0,120) + (plain.length > 120 ? "…" : ""));
    notesPreviewEl.title = "Click to edit";
  } else {
    notesPreviewEl.addClass("csv-kanban-notes-preview--empty");
    if (notesCol) notesPreviewEl.setText("+ Add note");
  }

  const notesEditorEl = card.createDiv({cls:"csv-kanban-notes-editor"});
  notesEditorEl.style.display = "none";

  const openInlineEditor = () => {
    // Save scroll position of the content area so we can restore it on close
    const contentArea = view.contentEl.querySelector(".csv-content-area") as HTMLElement | null;
    const scrollLeft = contentArea?.scrollLeft ?? 0;
    const scrollTop = contentArea?.scrollTop ?? 0;

    notesPreviewEl.style.display = "none";
    notesEditorEl.style.display = "block";
    notesEditorEl.empty();
    const ta = notesEditorEl.createEl("textarea", {cls:"csv-notes-textarea"});
    ta.value = (notesCol ? row[notesCol] : "") ?? "";
    ta.addEventListener("click", e => e.stopPropagation());
    ta.addEventListener("mousedown", e => e.stopPropagation());
    ta.addEventListener("input", () => { ta.style.height="auto"; ta.style.height=ta.scrollHeight+"px"; });
    ta.addEventListener("keydown", e => { if (e.key==="Escape") closeInlineEditor(ta.value, contentArea, scrollLeft, scrollTop); });
    ta.addEventListener("blur", () => closeInlineEditor(ta.value, contentArea, scrollLeft, scrollTop));
    // Use preventScroll to avoid browser auto-scrolling the content area
    ta.focus({ preventScroll: true });
    // Cursor at the start of the text, not the end. Setting .value on a
    // textarea then calling .focus() defaults to placing the caret at the
    // end — on long notes that scrolls the textarea's internal viewport
    // past all the content, so the user opens the editor and sees an
    // empty area "much down" with no text visible.
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
    // Size to content after a frame. Reading scrollHeight inline (before
    // layout) returns ~0, which made the height clamp to the 120 px floor
    // regardless of how long the note actually is.
    requestAnimationFrame(() => {
      ta.style.height = "auto";
      ta.style.height = Math.max(120, ta.scrollHeight) + "px";
    });
  };

  const closeInlineEditor = (newVal: string, contentArea: HTMLElement | null, scrollLeft: number, scrollTop: number) => {
    if (notesCol) { row[notesCol]=newVal; view.scheduleSave(); }
    notesEditorEl.style.display = "none";
    notesPreviewEl.style.display = "";
    if (newVal.trim()) {
      const plain = newVal.replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").replace(/\n+/g," ").trim();
      notesPreviewEl.setText(plain.slice(0,120) + (plain.length > 120 ? "…" : ""));
      notesPreviewEl.removeClass("csv-kanban-notes-preview--empty");
      notesPreviewEl.title = "Click to edit";
    } else {
      // Restore the "+ Add note" placeholder rather than leaving an empty,
      // invisible click target. Matches initial render exactly.
      notesPreviewEl.addClass("csv-kanban-notes-preview--empty");
      notesPreviewEl.setText(notesCol ? "+ Add note" : "");
      notesPreviewEl.removeAttribute("title");
    }
    // Restore scroll position after the DOM settles
    // Use multiple approaches to ensure scroll is restored even if browser does post-blur adjustments
    if (contentArea) {
      contentArea.scrollLeft = scrollLeft;
      contentArea.scrollTop = scrollTop;
      requestAnimationFrame(() => {
        contentArea.scrollLeft = scrollLeft;
        contentArea.scrollTop = scrollTop;
        requestAnimationFrame(() => {
          contentArea.scrollLeft = scrollLeft;
          contentArea.scrollTop = scrollTop;
        });
      });
      setTimeout(() => {
        contentArea.scrollLeft = scrollLeft;
        contentArea.scrollTop = scrollTop;
      }, 50);
    }
  };

  notesPreviewEl.addEventListener("click", e => {
    e.stopPropagation();
    // On touch devices, opening the inline textarea pops iOS's virtual
    // keyboard, which scrolls the focused element into view — that yanks
    // the user's y-position so far down the originally-tapped card
    // disappears off-screen. The expander modal sits in its own viewport,
    // so the keyboard only resizes the modal and the underlying view
    // stays put. Desktop keeps the inline textarea (faster, no modal lift).
    if (notesCol && matchMedia("(pointer: coarse)").matches) {
      view.openNoteExpander(row, notesCol);
      return;
    }
    openInlineEditor();
  });

  // Expand and Notes-file actions are now in the title row (title-tap and
  // small + icon). No bottom button row.

  // (Previously had a click handler that just called stopPropagation — no
  // useful purpose. Removed; specific child elements stop propagation when
  // they need to.)
  card.addEventListener("contextmenu", e => view.openRowContextMenu(row, e));
}
