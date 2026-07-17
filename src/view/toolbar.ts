// Toolbar renderer: title, row count, view-mode buttons, search bar, sort
// toggle, and the secondary actions (Columns / Backup / Anki / + Add / ⋯).
// Extracted from CardView; reached members are public. Type-only CardView
// import → no runtime cycle. Covered by test-view-smoke.mjs.

import { Menu, Notice } from "obsidian";
import type { CardView } from "../../main";
import { ViewMode } from "../types";
import { FileConfigModal, AutoDetectedRoles, SearchModal } from "../modals";
import { syncToAnki, autoAnkiFrontCol } from "./anki";
import { hasStatsColumns } from "./stats";
import { hasChartColumns } from "./chart";
import { hasTaskColumns } from "./tasks";
import { hasBudgetColumns } from "./budget";
import { effectiveGroupCol } from "./kanban";
import { TITLE_COL_ALIASES, CATEGORY_COL_ALIASES, STATUS_COL_ALIASES, NOTES_COL_ALIASES, IMAGE_COL_ALIASES, PRICE_COL_ALIASES } from "../utils";

declare const __BUILD_TIME__: string;

/**
 * The view modes valid for the current file's columns, in toolbar order.
 * Single source of truth for the toolbar buttons and the "Cycle view mode"
 * palette command.
 */
export function availableModes(view: CardView): {id: ViewMode, label: string}[] {
  const modes: {id: ViewMode, label: string}[] = [];
  if (view.isTravelFile()) modes.push({id: "travel", label: "Travel"});
  if (view.hasDateColumn()) modes.push({id: "dashboard", label: "Dashboard"});
  // Tasks: files with a due/priority column or a type column carrying
  // task/note/idea values (see hasTaskColumns). A native replacement for the
  // old DataviewJS project dashboard.
  if (hasTaskColumns(view)) modes.push({id: "tasks", label: "Tasks"});
  // Budget: a named/assigned price column, rolled up per category against a
  // spending limit set inline in the view. Deliberately name-gated (not
  // "any numeric column") — see hasBudgetColumns.
  if (hasBudgetColumns(view)) modes.push({id: "budget", label: "Budget"});
  // Cards/Kanban work on any file with a groupable column — the per-file
  // "Group by" pick, the category column, or an auto-picked fallback (see
  // effectiveGroupCol). Travel/date files used to lose these entirely.
  if (effectiveGroupCol(view)) {
    modes.push({id: "library", label: "Cards"});
    modes.push({id: "kanban-genre", label: "Kanban"});
  }
  modes.push({id: "table", label: "Table"});
  // Focus (one entry at a time) works on any non-empty file; Stats whenever
  // there's a chartable column. (These were once gated off travel/date files
  // on the theory that the map/dashboard covers them — but hiding modes that
  // render fine just made the dropdown feel arbitrarily short.)
  if (view.rows.length > 0) modes.push({id: "focus", label: "Focus"});
  if (hasStatsColumns(view)) modes.push({id: "stats", label: "Stats"});
  // Chart: scatter/line plots of numeric column pairs, with best-fit and
  // formula overlays. Needs at least one numeric column (see hasChartColumns).
  if (hasChartColumns(view)) modes.push({id: "chart", label: "Chart"});
  return modes;
}

export function renderToolbar(view: CardView, root: HTMLElement): void {
  const bar = root.createDiv({cls:"csv-toolbar"});
  bar.createDiv({cls:"csv-toolbar-title", text: view.file?.basename??""});
  const ctrl = bar.createDiv({cls:"csv-toolbar-controls"});
  ctrl.createDiv({cls:"csv-row-count", text:`${view.rows.length} entries`});
  const mg = ctrl.createDiv({cls:"csv-mode-group"});

  // View-mode dropdown. One compact control instead of a row of buttons —
  // scales to files with many valid modes (travel files show 6+) without
  // overflowing the toolbar, especially on phones.
  const modes = availableModes(view);
  const modeSel = mg.createEl("select", { cls: "csv-mode-select", attr: { "aria-label": "View mode" } });
  modes.forEach(({id, label}) => {
    const opt = modeSel.createEl("option", { text: label, value: id });
    if (view.mode === id) opt.selected = true;
  });
  modeSel.addEventListener("change", () => {
    view.mode = modeSel.value as ViewMode;
    view.renderView();
  });

  // Search bar (only for kanban/table views, not dashboard).
  // On mobile the input collapses to a 🔍 toggle so the toolbar fits on
  // one row; tapping the toggle expands the input *in place of* the mode
  // buttons (CSS hides the mode group + +Add + ⋯ while expanded so the
  // input has the whole toolbar row). Underlying view filters live below.
  // Closing returns the toolbar to its normal layout.
  if (view.mode !== "dashboard") {
    const searchToggle = ctrl.createEl("button", {
      cls: "csv-cfg-btn csv-search-toggle",
      text: "🔍",
      title: "Search",
    });
    const searchWrap = ctrl.createDiv({ cls: "csv-search-wrap" });
    // Input lives inside its own relative wrapper so the × clear button
    // can absolute-position over the right edge of the input without
    // moving any siblings (the Done button stays put even when × appears
    // mid-typing). The toggle of × visibility uses opacity+pointer-events
    // rather than display:none — same reason: no layout shift.
    const inputWrap = searchWrap.createDiv({ cls: "csv-search-input-wrap" });
    const searchInput = inputWrap.createEl("input", {
      cls: "csv-search-input",
      type: "text",
      placeholder: "Search...",
      value: view.searchQuery,
      // iOS keyboard hints: 'search' inputmode shows a search-style
      // keyboard; enterkeyhint relabels Return as "Search" so users
      // know pressing it dismisses the keyboard.
      attr: { inputmode: "search", enterkeyhint: "search", autocomplete: "off" },
    });
    const clearBtn = inputWrap.createEl("button", { cls: "csv-search-clear", text: "×", title: "Clear search" });
    clearBtn.toggleClass("is-hidden", !view.searchQuery);
    // Mobile-only "Done" button — dismisses the keyboard so the WebView
    // returns to full height and the user can see the filtered view.
    // The keyboard otherwise can't be dismissed once focus is locked.
    // Hidden on desktop via CSS.
    const doneBtn = searchWrap.createEl("button", {
      cls: "csv-search-done",
      text: "Done",
      title: "Dismiss keyboard",
    });
    // Done does double duty on mobile: if the input is empty (user
    // already cleared their query), collapse the search bar entirely
    // and restore the normal toolbar. Otherwise just dismiss the
    // keyboard so the user can see the filtered view. Lets Done be the
    // single exit affordance — no separate × needed on mobile.
    doneBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!searchInput.value) {
        bar.removeClass("csv-toolbar--search-expanded");
        searchToggle.removeClass("has-query");
        view.searchQuery = "";
        view.renderView(true);
        return;
      }
      searchInput.blur();
    });
    // Debounce filter re-renders so typing doesn't trigger a full content
    // rebuild on every keystroke — on large tables (300+ rows) the empty-
    // then-refill flash reads as "the table disappeared while I'm typing."
    // 120ms is below human reaction latency but lets bursts collapse into
    // a single render.
    let searchDebounce: number | null = null;
    searchInput.addEventListener("input", (e) => {
      view.searchQuery = (e.target as HTMLInputElement).value;
      clearBtn.toggleClass("is-hidden", !view.searchQuery);
      searchToggle.toggleClass("has-query", !!view.searchQuery);
      if (searchDebounce !== null) window.clearTimeout(searchDebounce);
      searchDebounce = window.setTimeout(() => {
        searchDebounce = null;
        view.renderView(true); // Only re-render content, not toolbar
      }, 120);
    });
    // Enter/Return commits the search by dismissing the keyboard so the
    // WebView returns to full height. Filter stays applied.
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        searchInput.blur();
      }
    });
    // × clears the query but keeps the search bar open so the user can
    // type something new without re-opening it. Done (mobile) collapses
    // the whole bar when input is already empty.
    clearBtn.addEventListener("click", () => {
      view.searchQuery = "";
      searchInput.value = "";
      clearBtn.addClass("is-hidden");
      searchToggle.removeClass("has-query");
      searchInput.focus({ preventScroll: true });
      view.renderView(true);
    });
    // Active-filter indicator on the toggle (mobile only).
    if (view.searchQuery) searchToggle.addClass("has-query");
    // Touch devices open SearchModal instead of expanding inline: the main
    // view (unlike this modal) has no visualViewport keyboard handling, and
    // iOS collapses it to near-nothing while the inline input is focused —
    // the user can type but can't see the content area updating (black
    // screen). SearchModal already solves this (viewport pinning + a
    // results preview list rendered inside the modal itself) — it just
    // wasn't wired to a trigger before. Desktop keeps the inline expand;
    // there's no keyboard there to collapse anything.
    const isTouch = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    searchToggle.addEventListener("click", () => {
      if (isTouch) {
        const notesCol = view.getNotesCol();
        new SearchModal(
          view.app,
          view.searchQuery,
          (q) => { view.searchQuery = q; view.renderView(); },
          () => ({ matched: view.getFilteredRows().length, total: view.rows.length }),
          () => view.getFilteredRows().map(row => ({ title: view.getTitle(row), subtitle: view.getSubtitle(row) || undefined, row })),
          (row) => { if (notesCol) view.openNoteExpander(row, notesCol); else void view.openOrCreateNotes(row); },
        ).open();
        return;
      }
      // Expand inline. CSS hides the other toolbar items while expanded
      // so the input fills the row.
      bar.addClass("csv-toolbar--search-expanded");
      searchInput.focus({ preventScroll: true });
    });
  }

  // Sort order toggle (only for table view with date column)
  if (view.mode === "table" && view.hasDateColumn()) {
    const sortNewest = view.fileCfg.sortNewestFirst ?? true;
    const sortBtn = ctrl.createEl("button", {
      cls: `csv-cfg-btn ${sortNewest ? "active" : ""}`,
      text: sortNewest ? "↓ Newest" : "↑ Oldest",
      title: "Toggle sort order"
    });
    sortBtn.addEventListener("click", () => {
      const cfg = view.fileCfg;
      cfg.sortNewestFirst = !(cfg.sortNewestFirst ?? true);
      view.saveFileCfg(cfg);
      // A manual header-click sort overrides this toggle; clicking the
      // toggle is an explicit "go back to date order", so clear it.
      view.tableSortCol = null;
      // Sort flips the row order but the user is still in roughly the
      // same area — preserving scroll is less disorienting than yanking
      // them back to the very newest / oldest entry.
      view.renderViewPreservingScroll();
    });
  }

  // Secondary actions — rendered as three explicit buttons on desktop,
  // collapsed into a single ⋯ overflow menu on phones (CSS toggles
  // visibility via .csv-cfg-btn-secondary / .csv-cfg-btn-overflow).
  // Handlers are defined once and reused by both surfaces so there's a
  // single place to maintain behaviour.
  const openColumns = () => {
    // What each exclusive role would resolve to with no fileCfg override,
    // purely by column name/position — same lists/logic getCategoryCol etc.
    // already use at render time — so the modal's "auto (by name)" badge
    // always agrees with what's actually driving the view right now.
    const autoDetectedRoles: AutoDetectedRoles = {
      title: view.resolveCol(TITLE_COL_ALIASES),
      category: view.resolveCol(CATEGORY_COL_ALIASES),
      status: view.resolveCol(STATUS_COL_ALIASES),
      notes: view.resolveCol(NOTES_COL_ALIASES),
      image: view.resolveCol(IMAGE_COL_ALIASES),
      anki: autoAnkiFrontCol(view),
      price: view.resolveCol(PRICE_COL_ALIASES),
    };
    new FileConfigModal(
      view.app, view.headers, view.file?.path ?? "", view.fileCfg, view.autoDetectBooleanColumns(),
      view.autoDetectCategoricalColumns(), autoDetectedRoles, availableModes(view),
      (cfg) => {
        view.saveFileCfg(cfg);
        if (cfg.defaultMode) view.mode = cfg.defaultMode;
        view.renderView();
      },
      () => view.headers,
      () => view.fileCfg,
      (name) => view.addColumn(name),
      (header) => view.removeColumn(header),
      (header) => view.cleanupBooleanColumn(header),
    ).open();
  };
  const openBackup = () => { void view.backupToArchive(); };
  const openAnki = () => { void syncToAnki(view); };

  ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "⚙ Config", title: "Configure this file's columns and views" })
    .addEventListener("click", openColumns);
  ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "💾 Backup", title: "Copy this file to archive/ with today's date" })
    .addEventListener("click", openBackup);
  ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "🎴 Anki", title: "Sync rows to Anki (needs Anki desktop + AnkiConnect)" })
    .addEventListener("click", openAnki);

  ctrl.createEl("button",{cls:"csv-add-btn",text:"+ add"}).addEventListener("click",()=>view.openAddModal());

  // ⋯ overflow lives after + Add so on mobile (where the secondary buttons
  // are hidden) the row reads `[modes] [search] [+ Add] [⋯]` — the primary
  // action stays adjacent to the input, with the menu as the rightmost
  // catch-all. On desktop this button is display:none, so + Add is last.
  const overflowBtn = ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-overflow", text: "⋯", title: "More actions" });
  overflowBtn.addEventListener("click", (e) => {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Config").setIcon("settings").onClick(openColumns));
    menu.addItem(i => i.setTitle("Backup").setIcon("save").onClick(openBackup));
    menu.addItem(i => i.setTitle("Sync to Anki").setIcon("layers").onClick(openAnki));
    menu.addSeparator();
    // Build timestamp baked in at compile time. Lets the user confirm on
    // mobile that sync has actually delivered the latest deploy.
    menu.addItem(i => i.setTitle(`Built ${__BUILD_TIME__}`).setIcon("info").setDisabled(true));
    menu.showAtMouseEvent(e);
  });

  // Desktop: a tiny ⓘ button next to ⋯ that toasts the build time on
  // click. On mobile it's hidden — the ⋯ menu already surfaces the same
  // info, and toolbar real estate is precious.
  const infoBtn = ctrl.createEl("button", {
    cls: "csv-cfg-btn csv-cfg-btn-secondary csv-info-btn",
    text: "ⓘ",
    title: `Built ${__BUILD_TIME__} — click to confirm`,
  });
  infoBtn.addEventListener("click", () => new Notice(`datadeck — built ${__BUILD_TIME__}`, 4000));
}
