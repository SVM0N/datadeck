// Toolbar renderer: title, row count, view-mode buttons, search bar, sort
// toggle, and the secondary actions (Columns / Mobile / Backup / + Add / ⋯).
// Extracted from CardView; reached members are public. Type-only CardView
// import → no runtime cycle. Covered by test-view-smoke.mjs.

import { Menu, Notice } from "obsidian";
import type { CardView } from "../../main";
import { ViewMode } from "../types";
import { FileConfigModal } from "../modals";
import { generateMobileFiles } from "./mobile";
import { hasStatsColumns } from "./stats";
import { effectiveGroupCol } from "./kanban";

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
    searchToggle.addEventListener("click", () => {
      // Expand inline. CSS hides the other toolbar items while expanded
      // so the input fills the row. The toolbar is in normal flow so
      // iOS keyboard handling is whatever the WebView does — content
      // area below shrinks to fit above the keyboard and filters live.
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
    new FileConfigModal(view.app, view.headers, view.file?.path ?? "", view.fileCfg, view.autoDetectBooleanColumns(), availableModes(view), (cfg) => {
      view.saveFileCfg(cfg);
      if (cfg.defaultMode) view.mode = cfg.defaultMode;
      view.renderView();
    }).open();
  };
  const openMobile = () => generateMobileFiles(view);
  const openBackup = () => view.backupToArchive();

  ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "⚙ Columns", title: "Configure columns for this file" })
    .addEventListener("click", openColumns);
  ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "📱 Mobile", title: "Generate mobile dashboard with add form" })
    .addEventListener("click", openMobile);
  ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-secondary", text: "💾 Backup", title: "Copy this file to Archive/ with today's date" })
    .addEventListener("click", openBackup);

  ctrl.createEl("button",{cls:"csv-add-btn",text:"+ Add"}).addEventListener("click",()=>view.openAddModal());

  // ⋯ overflow lives after + Add so on mobile (where the secondary buttons
  // are hidden) the row reads `[modes] [search] [+ Add] [⋯]` — the primary
  // action stays adjacent to the input, with the menu as the rightmost
  // catch-all. On desktop this button is display:none, so + Add is last.
  const overflowBtn = ctrl.createEl("button", { cls: "csv-cfg-btn csv-cfg-btn-overflow", text: "⋯", title: "More actions" });
  overflowBtn.addEventListener("click", (e) => {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Columns").setIcon("settings").onClick(openColumns));
    menu.addItem(i => i.setTitle("Mobile dashboard").setIcon("smartphone").onClick(openMobile));
    menu.addItem(i => i.setTitle("Backup").setIcon("save").onClick(openBackup));
    menu.addSeparator();
    // Build timestamp baked in at compile time. Lets the user confirm on
    // iPhone that iCloud has actually synced the latest deploy.
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
  infoBtn.addEventListener("click", () => new Notice(`csv-card-view — built ${__BUILD_TIME__}`, 4000));
}
