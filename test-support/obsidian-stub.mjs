// Minimal "obsidian" module stub for bundling view code under node.
// esbuild aliases `obsidian` → this file in the smoke tests. Only needs to
// satisfy imports so the bundle resolves; the view code under test builds DOM
// and doesn't actually drive these classes. Chainable no-ops where the API is
// fluent (Setting).

class Base { constructor() {} }
export class App extends Base {}
export class Component extends Base { load() {} unload() {} registerEvent() {} register() {} }
export class FileView extends Base {}
export class Modal extends Base { open() {} close() {} }
export class PluginSettingTab extends Base {}
export class Plugin extends Base {}
export class Menu extends Base { addItem() { return this; } showAtMouseEvent() {} }
export class Notice { constructor() {} setMessage() { return this; } hide() {} }
export class TFile extends Base {}
export class WorkspaceLeaf extends Base {}
export class MarkdownPostProcessorContext extends Base {}
export class MarkdownRenderer extends Base { static render() { return Promise.resolve(); } static renderMarkdown() { return Promise.resolve(); } }
export class Setting extends Base {
  setName() { return this; } setDesc() { return this; }
  addText() { return this; } addToggle() { return this; }
  addDropdown() { return this; } addButton() { return this; } addTextArea() { return this; }
}
export function normalizePath(p) { return p; }
