import { App, Notice, TFile, MarkdownPostProcessorContext } from "obsidian";
import Papa from "papaparse";
import { CSVRow, FileConfig } from "./types";
import { parseCSV, resolvePath, titleCase, looksCategorical, looksBoolean, isTruthyVal, localISODate } from "./utils";

// ─── csv-add code block (mobile entry form) ──────────────────────────────────
// Extracted from CardViewPlugin. Depends only on `app` (vault/workspace),
// passed in explicitly. Renders the in-note add/update form and writes the
// new/updated row back to the target CSV. `fileConfigs` (settings.fileConfigs,
// keyed by vault path) is optional so callers/tests that don't track per-file
// config can omit it — the categorical decision then falls back to auto-detect.
export async function renderAddEntryForm(app: App, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, fileConfigs: Record<string, FileConfig> = {}): Promise<void> {
    // Parse source to get file path
    const lines = source.split("\n").map(l => l.trim()).filter(Boolean);
    let filePath = "";
    for (const line of lines) {
      if (line.startsWith("file:")) {
        filePath = line.replace("file:", "").trim();
        break;
      }
    }

    if (!filePath) {
      el.createEl("p", { text: "Error: No file specified. Use: file: yourfile.csv", cls: "csv-add-error" });
      return;
    }

    // Resolve path relative to current note. Three forms accepted:
    //   "books.csv"                         → sibling of current note
    //   "../books.csv" or "../../foo.csv"   → walked up from current folder
    //   "Notes/Library/books.csv"       → vault-relative (any path containing
    //                                          "/" without a leading ".." is treated
    //                                          as vault-relative for back-compat)
    const currentFile = app.vault.getAbstractFileByPath(ctx.sourcePath);
    const baseFolder = currentFile?.parent?.path ?? "";
    const fullPath = resolvePath(filePath, baseFolder);

    const file = app.vault.getAbstractFileByPath(fullPath);
    if (!file || !(file instanceof TFile)) {
      el.createEl("p", { text: `Error: File not found: ${fullPath}`, cls: "csv-add-error" });
      return;
    }

    const fileCfg = fileConfigs[fullPath] ?? {};

    // Read the file to get headers
    let headers: string[] = [];
    let rows: CSVRow[] = [];

    try {
      const text = await app.vault.read(file);
      const parsed = parseCSV(text);
      headers = parsed.headers;
      rows = parsed.rows;
    } catch (e) {
      el.createEl("p", { text: `Error reading file: ${e instanceof Error ? e.message : String(e)}`, cls: "csv-add-error" });
      return;
    }

    if (!headers.length) {
      el.createEl("p", { text: "Error: No columns found in file", cls: "csv-add-error" });
      return;
    }

    // Detect column types
    const isDateCol = (h: string): boolean => {
      const hLower = h.toLowerCase();
      if (["date", "day", "datum"].includes(hLower)) return true;
      const vals = rows.slice(0, 5).map(r => r[h] ?? "");
      return vals.length > 0 && vals.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v));
    };

    const isNotesCol = (h: string): boolean => {
      const hLower = h.toLowerCase();
      return ["notes", "note", "comments", "description", "journal"].includes(hLower);
    };

    // Categorize columns. Checkbox/binary: an explicit ⚙ Config Type=Checkbox
    // list wins outright, even empty (matches getBooleanColumns() elsewhere) —
    // previously this always auto-detected from existing data, so a column
    // freshly retyped to Checkbox (with no boolean-shaped data yet) wouldn't
    // render as a toggle here even though it already did in the Dashboard and
    // desktop Add-entry modal.
    const binaryCols = fileCfg.habitColumns
      ? fileCfg.habitColumns.filter(h => headers.includes(h))
      : headers.filter(h => !isDateCol(h) && looksBoolean(rows.map(r => (r[h] ?? "").toLowerCase().trim())));
    const dateCols = headers.filter(h => isDateCol(h));
    const notesCols = headers.filter(h => isNotesCol(h));
    const otherCols = headers.filter(h => !binaryCols.includes(h) && !dateCols.includes(h) && !notesCols.includes(h));
    // The title/index column is a free-text identifier — never a categorical
    // dropdown, even if it happens to have few distinct existing values.
    // Per-file Config override wins, same as titleKey() elsewhere.
    const titleCol = fileCfg.titleColumn
      ? headers.find(h => h.toLowerCase() === fileCfg.titleColumn!.toLowerCase())
      : headers.find(h => ["title", "name"].includes(h.toLowerCase()));

    // Render as one collapsible "menu" (Apple-style grouped card):
    //   - Default state: a single discreet "+ New entry" pill.
    //   - Tap → expands a single rounded card containing all fields as rows
    //     separated by hairlines, then one "Add" button. No more disjoint blocks.
    const root = el.createDiv({ cls: "csv-add-form csv-add-compact" });

    // Default-open: the card is visible immediately; tapping × collapses it
    // to the trigger pill, and the pill re-opens it. (One menu, always one tap
    // away in either direction.)
    const trigger = root.createEl("button", { cls: "csv-add-trigger is-hidden", text: "+ new entry" });
    const card = root.createDiv({ cls: "csv-add-card" });

    // Header bar: title + close (×). Re-uses the trigger to collapse.
    const header = card.createDiv({ cls: "csv-add-card-header" });
    header.createSpan({ cls: "csv-add-card-title", text: "New entry" });
    const closeBtn = header.createEl("button", { cls: "csv-add-card-close", text: "×" });

    // Rows live in one grouped list with hairline separators between them.
    const rowsWrap = card.createDiv({ cls: "csv-add-rows" });

    const inputs: Record<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> = {};
    const toggleStates: Record<string, boolean> = {};

    // Helper: a single row (label on the left, control on the right).
    const makeRow = (h: string, kind: string) => {
      const row = rowsWrap.createDiv({ cls: `csv-add-row csv-add-row-${kind}` });
      row.createSpan({ cls: "csv-add-row-label", text: titleCase(h) });
      return row;
    };

    // Date row (habit trackers) — first so today's date is the obvious default.
    dateCols.forEach(h => {
      const row = makeRow(h, "date");
      const dateInput = row.createEl("input", { cls: "csv-add-row-control", type: "date" });
      dateInput.value = localISODate();
      inputs[h] = dateInput;
    });

    // Binary columns: each one its own row with a right-aligned switch.
    binaryCols.forEach(h => {
      toggleStates[h] = false;
      const row = makeRow(h, "toggle");
      const switchWrap = row.createEl("label", { cls: "csv-add-switch" });
      const checkbox = switchWrap.createEl("input", { type: "checkbox", cls: "csv-add-switch-input" });
      switchWrap.createSpan({ cls: "csv-add-switch-track" });
      checkbox.addEventListener("change", () => { toggleStates[h] = checkbox.checked; });
      inputs[h] = checkbox;
    });

    // Other fields (title, author, category, etc.) — text or select inline.
    otherCols.forEach(h => {
      const row = makeRow(h, "field");
      const uniqueVals = new Set(rows.map(r => (r[h] ?? "").trim()).filter(Boolean));
      // Per-file categorical list wins outright when set (configured in ⚙
      // Columns); otherwise auto-detect from distinct value count, same
      // heuristic as the full-page add form.
      const isCategorical = h !== titleCol
        && (fileCfg.categoricalColumns ? fileCfg.categoricalColumns.includes(h) : looksCategorical(uniqueVals.size));
      if (isCategorical) {
        const select = row.createEl("select", { cls: "csv-add-row-control" });
        select.createEl("option", { text: "—", value: "" });
        Array.from(uniqueVals).sort().forEach(v => select.createEl("option", { text: v, value: v }));
        select.createEl("option", { text: "+ custom", value: "__custom__" });
        // Custom input lives in its own row that appears just below when chosen.
        const customRow = rowsWrap.createDiv({ cls: "csv-add-row csv-add-row-custom is-hidden" });
        const customInput = customRow.createEl("input", { cls: "csv-add-row-control", type: "text", placeholder: `Custom ${titleCase(h).toLowerCase()}` });
        // Keep the custom row visually adjacent to its parent select row.
        rowsWrap.insertBefore(customRow, row.nextSibling);
        select.addEventListener("change", () => {
          customRow.classList.toggle("is-hidden", select.value !== "__custom__");
          if (select.value === "__custom__") customInput.focus();
        });
        inputs[h] = select;
        inputs[`${h}__custom`] = customInput;
      } else {
        inputs[h] = row.createEl("input", { cls: "csv-add-row-control", type: "text", placeholder: titleCase(h) });
      }
    });

    // Notes row — full-width textarea, stacked below the inline label.
    notesCols.forEach(h => {
      const row = rowsWrap.createDiv({ cls: "csv-add-row csv-add-row-notes" });
      row.createSpan({ cls: "csv-add-row-label", text: titleCase(h) });
      inputs[h] = row.createEl("textarea", { cls: "csv-add-row-textarea", placeholder: "Optional notes…" });
    });

    // Submit lives inside the card so the whole menu reads as one unit.
    const submitBtn = card.createEl("button", { text: "Add", cls: "csv-add-submit" });

    // ── Pre-fill from existing row (habit trackers) ────────────────────────────
    // When the date input matches an existing row in the file, populate the
    // form with that row's values so the user can SEE what's already saved
    // before they edit. Previously the form was always blank and a habit
    // update was indistinguishable from a fresh entry — easy to wipe an
    // existing day's notes by tabbing through.
    //
    // Only runs when the file has a date column (i.e. habit-tracker shape);
    // library/generic dashboards have no date and skip naturally.
    const titleEl = header.querySelector(".csv-add-card-title");
    const syncFromExisting = (): void => {
      if (!dateCols.length) return;
      const dateInput = inputs[dateCols[0]] as HTMLInputElement | undefined;
      if (!dateInput) return;
      const dateVal = dateInput.value;
      const existing = rows.find(r => r[dateCols[0]] === dateVal);

      // Title hint, card accent, and button label all flip together so the
      // user can tell at a glance that the form is showing what's already
      // saved for this date (not a blank new entry).
      if (titleEl) {
        titleEl.setText(existing ? `Updating ${dateVal}` : "New entry");
      }
      card.classList.toggle("is-updating", !!existing);
      submitBtn.setText(existing ? "Update" : "Add");

      // Binary toggles — set from existing or clear back to false. Same
      // narrow truth-list as isTruthyVal (1/true/yes) — anything else,
      // including leftover non-conforming text from before this column was
      // typed Checkbox, reads as off rather than erroring.
      binaryCols.forEach(h => {
        const checkbox = inputs[h] as HTMLInputElement | undefined;
        if (!checkbox) return;
        const on = isTruthyVal(existing?.[h] ?? "");
        checkbox.checked = on;
        toggleStates[h] = on;
      });

      // Text/select fields and notes textareas — set from existing or clear.
      [...otherCols, ...notesCols].forEach(h => {
        const input = inputs[h];
        if (!input) return;
        const val = existing?.[h] ?? "";
        if (input instanceof HTMLSelectElement) {
          // If the existing value isn't a known option, leave the select on
          // "—" and put the value into the custom input slot. Otherwise pick
          // the matching option.
          const opt = Array.from(input.options).find(o => o.value === val);
          const customInput = inputs[`${h}__custom`] as HTMLInputElement | undefined;
          const customRow = customInput?.closest(".csv-add-row-custom") as HTMLElement | null;
          if (opt) {
            input.value = val;
            // Hide any custom-row that was previously open.
            if (customRow) customRow.classList.add("is-hidden");
            if (customInput) customInput.value = "";
          } else if (val) {
            // Existing value isn't a known option — show it in the custom
            // slot so the form reflects what's saved (a select stuck on "—"
            // read as "nothing recorded" even when something was).
            input.value = "__custom__";
            if (customInput) customInput.value = val;
            if (customRow) customRow.classList.remove("is-hidden");
          } else {
            input.value = "";
            if (customRow) customRow.classList.add("is-hidden");
            if (customInput) customInput.value = "";
          }
        } else if (input.instanceOf(HTMLTextAreaElement)) {
          input.value = val;
        } else {
          (input).value = val;
        }
      });
    };
    // Pre-fill once on initial render, then re-sync whenever the user
    // navigates to a different date.
    syncFromExisting();
    if (dateCols.length) {
      const dateInput = inputs[dateCols[0]] as HTMLInputElement | undefined;
      dateInput?.addEventListener("change", syncFromExisting);
    }

    // Expand / collapse wiring. Focusing the first text-ish input on open
    // mirrors iOS sheet behaviour where the keyboard comes up immediately.
    const open = () => {
      card.classList.remove("is-hidden");
      trigger.classList.add("is-hidden");
      const first = card.querySelector<HTMLElement>(".csv-add-row-control");
      first?.focus();
    };
    const close = () => {
      card.classList.add("is-hidden");
      trigger.classList.remove("is-hidden");
    };
    trigger.addEventListener("click", open);
    closeBtn.addEventListener("click", close);

    const handleSubmit = async () => {
      // Gather values
      const newRow: CSVRow = {};
      headers.forEach(h => {
        if (binaryCols.includes(h)) {
          newRow[h] = toggleStates[h] ? "1" : "0";
        } else if (inputs[h] instanceof HTMLSelectElement && (inputs[h]).value === "__custom__") {
          newRow[h] = (inputs[`${h}__custom`] as HTMLInputElement)?.value ?? "";
        } else if (inputs[h] instanceof HTMLTextAreaElement) {
          newRow[h] = inputs[h].value;
        } else {
          newRow[h] = (inputs[h] as HTMLInputElement)?.value ?? "";
        }
      });

      // Check if at least one field is filled (for non-habit trackers) or date is set (for habit trackers)
      const hasDate = dateCols.length > 0 && dateCols.some(h => (newRow[h] ?? "").trim());
      const hasOtherValue = [...otherCols, ...notesCols].some(h => (newRow[h] ?? "").trim());
      const hasToggle = binaryCols.some(h => toggleStates[h]);

      if (!hasDate && !hasOtherValue && !hasToggle) {
        new Notice("Please fill at least one field");
        return;
      }

      // Re-read file to get latest data (avoids stale data issues)
      let currentRows: CSVRow[] = [];
      try {
        const text = await app.vault.read(file);
        currentRows = parseCSV(text).rows;
      } catch (e) {
        new Notice(`Error reading file: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }

      // Check for duplicate date entry (for habit trackers)
      let isUpdate = false;
      let existingRowIdx = -1;
      if (dateCols.length > 0) {
        const dateCol = dateCols[0];
        const dateVal = newRow[dateCol];
        existingRowIdx = currentRows.findIndex(r => r[dateCol] === dateVal);
        if (existingRowIdx >= 0) {
          // Update existing row - merge values (only update non-empty new values)
          isUpdate = true;
          const existingRow = currentRows[existingRowIdx];
          headers.forEach(h => {
            if (binaryCols.includes(h)) {
              // For binary cols, always use the new toggle state
              existingRow[h] = newRow[h];
            } else if ((newRow[h] ?? "").trim()) {
              // For other cols, only update if new value is non-empty
              existingRow[h] = newRow[h];
            }
          });
        } else {
          currentRows.push(newRow);
        }
      } else {
        currentRows.push(newRow);
      }

      // (Previously had `const rows = currentRows` shadowing the outer
      // `rows` from the form-render scope. Removed so the post-submit
      // re-sync can mutate the outer array via the captured reference.)
      try {
        const csv = Papa.unparse(currentRows, { columns: headers });
        await app.vault.modify(file, csv);

        new Notice(isUpdate ? `Updated entry for ${newRow[dateCols[0]] || ""}` : `Added entry to ${file.basename}`);

        // Sync our cached rows to what's now on disk so syncFromExisting reads
        // fresh data. Mutates in place to preserve the closure reference.
        rows.length = 0;
        rows.push(...currentRows);

        if (dateCols.length > 0) {
          // Habit-tracker shape: don't clear — re-sync the form so it shows
          // the just-saved state. The user can see what they recorded for
          // this day; if they want a different day they change the date.
          syncFromExisting();
        } else {
          // Other shapes (library / generic): clear for the next entry. Many
          // entries with the same shape go into the same form session.
          binaryCols.forEach(h => {
            toggleStates[h] = false;
            const checkbox = inputs[h] as HTMLInputElement;
            if (checkbox) checkbox.checked = false;
          });
          [...otherCols, ...notesCols].forEach(h => {
            const input = inputs[h];
            if (input instanceof HTMLSelectElement) {
              input.selectedIndex = 0;
            } else if (input.instanceOf(HTMLTextAreaElement)) {
              input.value = "";
            } else if (input) {
              (input).value = "";
            }
            const customInput = inputs[`${h}__custom`];
            if (customInput) {
              (customInput as HTMLInputElement).value = "";
              // The custom input lives inside a .csv-add-row-custom wrapper —
              // hide the row itself so the layout stays in sync with the select.
              const customRow = (customInput as HTMLInputElement).closest(".csv-add-row-custom");
              if (customRow) customRow.classList.add("is-hidden");
            }
          });
        }
        // Card stays open after a successful add so a quick second entry is one
        // tap away; user can collapse with the × header button when finished.

        // Auto-refresh: reopen the note to force Dataview to re-read CSV
        window.setTimeout(() => {
          void (async () => {
            const noteFile = app.vault.getAbstractFileByPath(ctx.sourcePath);
            if (noteFile instanceof TFile) {
              await app.workspace.getLeaf(false).openFile(noteFile, { state: { mode: "preview" } });
            }
          })();
        }, 300);
      } catch (e) {
        new Notice(`Error saving: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    submitBtn.addEventListener("click", () => { void handleSubmit(); });
}
