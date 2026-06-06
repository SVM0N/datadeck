import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { ViewMode } from "./types";
import type CardViewPlugin from "../main";

// ─── Settings tab ────────────────────────────────────────────────────────────
// Global plugin settings + the residency-rule editor. Touches only
// `this.plugin` (settings + saveSettings), so it lives outside the CardView
// class. (type-only import of CardViewPlugin → no runtime import cycle.)

export class CardViewSettingTab extends PluginSettingTab {
  plugin: CardViewPlugin;
  constructor(app: App, plugin: CardViewPlugin){super(app,plugin); this.plugin=plugin;}
  display(): void {
    const {containerEl}=this; containerEl.empty();
    containerEl.createEl("h2",{text:"XLSX Card View"});
    new Setting(containerEl).setName("Default view mode")
      .addDropdown(d=>d.addOption("kanban-genre","Kanban").addOption("table","Table")
        .setValue(this.plugin.settings.defaultMode)
        .onChange(async v=>{ this.plugin.settings.defaultMode=v as ViewMode; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Status column name")
      .addText(t=>t.setValue(this.plugin.settings.statusColumn).onChange(async v=>{ this.plugin.settings.statusColumn=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Category/Genre column name")
      .addText(t=>t.setValue(this.plugin.settings.categoryColumn).onChange(async v=>{ this.plugin.settings.categoryColumn=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notes column names").setDesc("Comma-separated.")
      .addText(t=>t.setValue(this.plugin.settings.notesColumns.join(", ")).onChange(async v=>{ this.plugin.settings.notesColumns=v.split(",").map(s=>s.trim()); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Select/dropdown columns").setDesc("Comma-separated column names that use a dropdown picker.")
      .addText(t=>t.setValue(this.plugin.settings.selectColumns.join(", ")).onChange(async v=>{ this.plugin.settings.selectColumns=v.split(",").map(s=>s.trim()); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notes subfolder")
      .addText(t=>t.setPlaceholder("Notes").setValue(this.plugin.settings.notesSubfolder).onChange(async v=>{ this.plugin.settings.notesSubfolder=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Reset column widths")
      .addButton(b=>b.setButtonText("Reset").onClick(async()=>{ this.plugin.settings.columnWidths={}; await this.plugin.saveSettings(); new Notice("Column widths reset."); }));
    new Setting(containerEl).setName("Residency counters (travel view)")
      .setDesc("Show residency / tax day-gauges in the travel view.")
      .addToggle(t=>t.setValue(this.plugin.settings.showResidency!==false).onChange(async v=>{ this.plugin.settings.showResidency=v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3",{text:"Residency rules"});
    containerEl.createEl("p",{cls:"setting-item-description",text:"Each rule counts days in the listed countries within the window, minus exempt visa rows, against the threshold. Counts confirmed trips only. Indicators, not legal/tax advice."});
    const rrWrap = containerEl.createDiv({cls:"csv-rr-wrap"});
    this.renderResidencyRules(rrWrap);
  }

  private renderResidencyRules(wrap: HTMLElement): void {
    wrap.empty();
    const rules = this.plugin.settings.residencyRules ?? (this.plugin.settings.residencyRules = []);
    const save = () => void this.plugin.saveSettings();

    rules.forEach((rule, i) => {
      const card = wrap.createDiv({ cls: "csv-rr-card" });
      const head = card.createDiv({ cls: "csv-rr-head" });
      const label = head.createEl("input", { cls: "csv-rr-label", type: "text", value: rule.label });
      label.placeholder = "Label (e.g. 🇪🇺 Schengen 90/180)";
      label.addEventListener("input", () => { rule.label = label.value; save(); });
      const del = head.createEl("button", { cls: "csv-rr-del", text: "✕" });
      del.setAttr("aria-label", "Remove rule");
      del.addEventListener("click", async () => { rules.splice(i, 1); await this.plugin.saveSettings(); this.renderResidencyRules(wrap); });

      const grid = card.createDiv({ cls: "csv-rr-grid" });
      const field = (lbl: string, value: string, onChange: (v: string) => void, ph = "") => {
        const f = grid.createDiv({ cls: "csv-rr-field" });
        f.createEl("label", { text: lbl });
        const inp = f.createEl("input", { type: "text", value });
        if (ph) inp.placeholder = ph;
        inp.addEventListener("input", () => { onChange(inp.value); save(); });
      };

      const countries = rule.scope.countries ?? (rule.scope.country ? [rule.scope.country] : []);
      field("Countries (ISO-2, comma)", countries.join(", "), v => {
        rule.scope = { countries: v.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) };
      }, "US, GB");

      // Window type
      const wf = grid.createDiv({ cls: "csv-rr-field" });
      wf.createEl("label", { text: "Window" });
      const sel = wf.createEl("select");
      ([["calendar-year", "Calendar year"], ["rolling", "Rolling N days"], ["all-time", "All time"]] as const)
        .forEach(([v, t]) => { const o = sel.createEl("option", { text: t, value: v }); if (rule.window.type === v) o.selected = true; });
      sel.addEventListener("change", () => { rule.window = { type: sel.value as "calendar-year" | "rolling" | "all-time", days: rule.window.days }; save(); this.renderResidencyRules(wrap); });

      if (rule.window.type === "rolling") {
        field("Rolling days", String(rule.window.days ?? 180), v => { const n = parseInt(v, 10); rule.window.days = isNaN(n) ? undefined : n; }, "180");
      }
      field("Threshold (days)", String(rule.threshold), v => { const n = parseInt(v, 10); rule.threshold = isNaN(n) ? 0 : n; }, "183");
      field("Exempt visas (comma)", (rule.exempt?.visa_status ?? []).join(", "), v => {
        const list = v.split(",").map(s => s.trim()).filter(Boolean);
        rule.exempt = list.length ? { visa_status: list } : undefined;
      }, "F-1, J-1");
      field("On-exceed label", rule.onExceed ?? "", v => { rule.onExceed = v || undefined; }, "tax resident");
      field("Note", rule.note ?? "", v => { rule.note = v || undefined; }, "optional caveat");
    });

    const btns = wrap.createDiv({ cls: "csv-rr-btns" });
    btns.createEl("button", { cls: "csv-rr-add", text: "+ Add rule" }).addEventListener("click", async () => {
      rules.push({ label: "New rule", scope: { countries: [] }, window: { type: "calendar-year" }, threshold: 183 });
      await this.plugin.saveSettings();
      this.renderResidencyRules(wrap);
    });
  }
}
