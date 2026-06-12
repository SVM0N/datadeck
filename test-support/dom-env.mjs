// jsdom environment + Obsidian's HTMLElement extensions.
//
// The plugin's render code leans on Obsidian's non-standard DOM helpers
// (createEl / createDiv / setText / empty / addClass / …) which jsdom doesn't
// have. This polyfills them onto the jsdom HTMLElement prototype so view code
// runs unmodified under node, and wires the needed globals. Used by the view
// smoke tests to render each view into a real DOM tree and assert structure.

import { JSDOM } from "jsdom";

export function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  // Patch Element (not HTMLElement) so the helpers also exist on SVG nodes —
  // the map colors/labels <path> elements, which are SVGElement, not HTMLElement.
  const HE = window.Element.prototype;

  const applyOpts = (el, opts) => {
    if (opts == null) return el;
    if (typeof opts === "string") { el.className = opts; return el; }
    if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
    if (opts.text != null) el.textContent = String(opts.text);
    if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
    if (opts.type != null) el.setAttribute("type", opts.type);
    if (opts.value != null) el.value = opts.value;
    if (opts.placeholder != null) el.setAttribute("placeholder", opts.placeholder);
    if (opts.href != null) el.setAttribute("href", opts.href);
    if (opts.title != null) el.setAttribute("title", opts.title);
    return el;
  };

  HE.createEl = function (tag, opts, cb) { const el = doc.createElement(tag); applyOpts(el, opts); this.appendChild(el); if (cb) cb(el); return el; };
  HE.createDiv = function (opts, cb) { return this.createEl("div", opts, cb); };
  HE.createSpan = function (opts, cb) { return this.createEl("span", opts, cb); };
  HE.setText = function (t) { this.textContent = t == null ? "" : String(t); return this; };
  HE.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); return this; };
  HE.addClass = function (...c) { this.classList.add(...c.filter(Boolean)); return this; };
  HE.removeClass = function (...c) { this.classList.remove(...c.filter(Boolean)); return this; };
  HE.toggleClass = function (c, on) { this.classList.toggle(c, on); return this; };
  HE.hasClass = function (c) { return this.classList.contains(c); };
  HE.setAttr = function (k, v) { this.setAttribute(k, String(v)); return this; };
  HE.getAttr = function (k) { return this.getAttribute(k); };
  // jsdom doesn't implement scrollIntoView (used by the picker's keyboard
  // cursor and the travel detail panel); a no-op is fine for structure tests.
  if (!HE.scrollIntoView) HE.scrollIntoView = function () {};

  // Globals the view code resolves against the realm.
  globalThis.window = window;
  globalThis.document = doc;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(() => fn(Date.now()), 0));
  globalThis.matchMedia = globalThis.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.matchMedia = window.matchMedia || globalThis.matchMedia;

  return { window, document: doc };
}
