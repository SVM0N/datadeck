// Table view renderer. Extracted from CardView as a free function taking the
// view instance; the members it reaches (getFilteredRows, isNotesCol,
// openNoteExpander, scheduleSave, …) are public on CardView. Type-only import
// of CardView keeps this out of a runtime cycle. Covered by test-view-smoke.mjs.

import type { CardView } from "../../main";
import { CSVRow } from "../types";

export function renderTable(view: CardView, container: HTMLElement): void {
  const filteredRows = view.getFilteredRows();

  // Show search result count if searching
  if (view.searchQuery.trim()) {
    container.createDiv({ cls: "csv-search-results", text: `Found ${filteredRows.length} of ${view.rows.length} entries` });
  }

  const wrap = container.createDiv({cls:"csv-table-wrapper"});
  const table = wrap.createEl("table",{cls:"csv-table"});
  const hr = table.createEl("thead").createEl("tr");

  view.headers.forEach(h => {
    const th = hr.createEl("th");
    th.setText(h);
    const savedWidth = view.settings.columnWidths[h];
    if (savedWidth) th.style.width = savedWidth + "px";
    const handle = th.createDiv({cls:"csv-col-resize-handle"});
    let startX = 0, startW = 0;
    // Pointer events (not mouse) so the handle works under touch as well as a
    // cursor; setPointerCapture routes move/up to the handle even when the
    // finger/cursor strays off the 6px strip, and lets us drop the
    // document-level listeners. `touch-action:none` on the handle (CSS) stops
    // the browser claiming the gesture for scrolling. Persist on release —
    // the old mouseup only mutated in-memory settings, so resized widths were
    // silently lost on reload.
    handle.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      startX=e.clientX; startW=th.offsetWidth;
      const onMove = (ev: PointerEvent) => { th.style.width=Math.max(60,startW+ev.clientX-startX)+"px"; };
      const onUp = (ev: PointerEvent) => {
        view.settings.columnWidths[h]=Math.max(60,startW+ev.clientX-startX);
        handle.removeEventListener("pointermove",onMove);
        handle.removeEventListener("pointerup",onUp);
        void view.persistSettings();
      };
      handle.addEventListener("pointermove",onMove);
      handle.addEventListener("pointerup",onUp);
    });
  });
  hr.createEl("th",{text:""});

  // Skip the clip-detection on touch — the fade gradient it triggers is
  // a hover affordance and irrelevant without a cursor. Saves N rAFs × N
  // forced reflows per render on phones (the prime cause of table-view lag
  // on iPhone when the file has hundreds of rows).
  const isTouch = matchMedia("(pointer: coarse)").matches;
  const tbody = table.createEl("tbody");
  filteredRows.forEach((row) => {
    const tr = tbody.createEl("tr");
    tr.addEventListener("contextmenu", e => view.openRowContextMenu(row, e));
    view.headers.forEach(h => {
      const td = tr.createEl("td");
      if (view.isNotesCol(h)) {
        td.addClass("csv-table-notes-cell");
        const preview = (row[h]??"").replace(/#{1,6}\s/g,"").replace(/[*_>`]/g,"").split("\n").filter(l=>l.trim()).slice(0,3).join(" · ");
        const display = preview ? (preview.slice(0,200)+(preview.length>200?"…":"")) : "+ Add note";
        const span = td.createSpan({ text: display });
        if (!preview) span.addClass("csv-table-notes-empty");
        td.title = "Click to open note";
        // Cell-click opens the expander. The "⤢" button used to live here
        // too, but the cell is the obvious click target — the button was
        // redundant noise.
        td.addEventListener("click", (e) => { e.stopPropagation(); view.openNoteExpander(row, h); });
      } else if (view.isSelectCol(h)) {
        view.renderSelectField(td, row, h);
      } else {
        const val = row[h] ?? "";
        td.setText(val);
        if (val.length > 80) td.title = val;
        makeEditable(view, td, row, h);
      }
    });
    const at = tr.createEl("td",{cls:"csv-table-action"});
    const hasFile = view.notesFileExists(row);
    at.createEl("button",{cls:`csv-table-notes-btn ${hasFile?"exists":""}`,text:hasFile?"📄":"✚",title:hasFile?"Open notes":"Create notes"})
      .addEventListener("click",()=>view.openOrCreateNotes(row));
    at.createEl("button",{cls:"csv-table-del-btn",text:"✕",title:"Delete row (Undo available)"})
      .addEventListener("click",()=>view.deleteWithUndo(row));
  });
  // Detect overflowing cells in one rAF instead of one per row. Single
  // querySelectorAll, single forced-layout batch — orders of magnitude
  // cheaper than per-row rAF on big files. Skipped entirely on touch.
  if (!isTouch) {
    requestAnimationFrame(() => {
      tbody.querySelectorAll<HTMLElement>("td:not(.csv-table-notes-cell):not(.csv-table-action)").forEach(cell => {
        if (cell.scrollHeight > cell.clientHeight + 1) cell.addClass("csv-cell--clipped");
      });
    });
  }
}

function makeEditable(view: CardView, el: HTMLElement, row: CSVRow, h: string): void {
  el.addEventListener("click", () => {
    el.empty();
    const input = el.createEl("input",{cls:"csv-inline-input",value:row[h]??"",type:"text"});
    input.focus(); input.select();
    input.addEventListener("blur",()=>{ row[h]=input.value; view.scheduleSave(); el.empty(); el.setText(input.value||"—"); });
    input.addEventListener("keydown",e=>{ if(e.key==="Enter")input.blur(); if(e.key==="Escape"){el.empty();el.setText(row[h]||"—");} });
  });
}
