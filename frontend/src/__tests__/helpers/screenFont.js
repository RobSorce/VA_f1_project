// Test helper (Phase 9c, D4): the size a <text> of a mounted D3 chart is
// drawn at ON SCREEN (CSS px), as a browser computes it, in the mini DOM
// (helpers/miniDom.js):
//  1. its font-size: the inline style, else the CSS rule of styles/*.css
//     that matches it (class, tag and descendant selectors; the dark theme,
//     the @media of the viewport), else its font-size presentation attribute,
//     else its parent's size (inheritance), up to the page's root size;
//  2. var(--x): the custom properties set inline on the element or an
//     ancestor (TrackMap's --map-zoom on its svg), else the :root tokens,
//     evaluated at the viewport (calc / clamp / max: layoutCss.evalLength);
//  3. times the scale of its user space on screen: getScreenCTM() (the outer
//     svg's viewBox fitted into its client rect, meet, and every transform
//     from the svg down to the text: d3.zoom's scale(k) included).
// The floor of a text is 10 px when its size comes from --font-size-label
// (CHART_FONT.label: non-data text), else 11 px (colors.js FONT_FLOOR_PX).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FLOORS = { data: 11, label: 10 };

let cache = null;
function css() {
  if (!cache) {
    const rules = H.listFiles(SRC, ['.css']).flatMap((f) => H.parseCssFile(f));
    cache = { rules, tokens: H.rootTokens(rules) };
  }
  return cache;
}

// ── Selectors (the subset the views use for text: tag, .class, descendant) ──

function parseCompound(s) {
  const m = s.match(/^([a-z][\w-]*)?((?:\.[\w-]+)*)$/i);
  if (!m) return null;
  return { tag: m[1] ? m[1].toLowerCase() : null, classes: m[2] ? m[2].split('.').filter(Boolean) : [] };
}

function compoundMatches(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && String(el.localName).toLowerCase() !== c.tag) return false;
  const cls = String(el.getAttribute('class') || '').split(/\s+/);
  return c.classes.every((k) => cls.includes(k));
}

/** Specificity [classes, tags] of a selector part, or null when it does not match el. */
function matchPart(el, part) {
  if (/[[\]:>+~#*]/.test(part)) return null; // themes, pseudo-classes, other combinators: not drawn here
  const compounds = part.trim().split(/\s+/).map(parseCompound);
  if (compounds.some((c) => !c)) return null;
  if (!compoundMatches(el, compounds[compounds.length - 1])) return null;
  let anc = el.parentNode;
  for (let i = compounds.length - 2; i >= 0; i--) {
    while (anc && anc.nodeType === 1 && !compoundMatches(anc, compounds[i])) anc = anc.parentNode;
    if (!anc || anc.nodeType !== 1) return null;
    anc = anc.parentNode;
  }
  return [
    compounds.reduce((s, c) => s + c.classes.length, 0),
    compounds.reduce((s, c) => s + (c.tag ? 1 : 0), 0),
  ];
}

// Cascade order: !important, then specificity (classes, tags), then source order
function cascadeCmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The winning font-size declaration of the CSS for el at vp, or null. */
function cssFontSize(el, vp) {
  let best = null;
  css().rules.forEach((r, order) => {
    if (!H.mediaMatches(r.media, vp)) return;
    const decl = [...r.decls].reverse().find((d) => d.prop === 'font-size');
    if (!decl) return;
    for (const part of r.selector.split(',')) {
      const spec = matchPart(el, part);
      if (!spec) continue;
      const key = [decl.important ? 1 : 0, spec[0], spec[1], order];
      if (!best || cascadeCmp(key, best.key) > 0) {
        best = { key, value: decl.value, important: decl.important, selector: r.selector };
      }
    }
  });
  return best;
}

/** Custom properties set inline on el and its ancestors (closest wins) over the :root tokens. */
function tokensAt(el) {
  const map = new Map(css().tokens);
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) chain.unshift(n);
  for (const n of chain) {
    for (const [k, v] of Object.entries(n.style || {})) {
      if (k.startsWith('--') && v !== '' && v != null) map.set(k, String(v));
    }
  }
  return map;
}

function rootPx(vp) {
  const { rules, tokens } = css();
  return H.rootFontPx(rules, tokens, vp.W, vp.H);
}

/**
 * Computed font size of el (CSS px, in its own user space) and where it comes from.
 *
 * @returns {{px: number, decl: string, source: string}}
 */
export function computedFontSize(el, vp) {
  if (!el || el.nodeType !== 1) return { px: rootPx(vp), decl: '', source: 'root' };
  const parent = () => computedFontSize(el.parentNode, vp);
  const inline = el.style?.getPropertyValue?.('font-size') || '';
  const rule = cssFontSize(el, vp);
  let decl = '';
  let source = '';
  if (rule && rule.important) { decl = rule.value; source = `css ${rule.selector} !important`; }
  else if (inline) { decl = inline; source = 'inline style'; }
  else if (rule) { decl = rule.value; source = `css ${rule.selector}`; }
  else if (el.getAttribute('font-size') != null) { decl = el.getAttribute('font-size'); source = 'attribute'; }
  if (!decl || /^(inherit|unset)$/i.test(decl)) return parent();
  if (/^[\d.]+$/.test(decl)) return { px: Number(decl), decl, source };
  const resolved = H.resolveVars(decl, tokensAt(el));
  const em = /em\b|%/.test(resolved) ? parent().px : rootPx(vp);
  const px = H.evalLength(resolved.replace(/([\d.]+)%/g, (m, v) => `${v / 100}em`), { W: vp.W, H: vp.H, root: rootPx(vp), em });
  return { px, decl, source };
}

/** On-screen px per user unit of el: the length of the CTM's x column. */
export function screenScale(el) {
  const m = el.getScreenCTM();
  return m ? Math.hypot(m.a, m.b) : 1;
}

/**
 * Every visible <text> of an svg with its size on screen and its floor.
 *
 * @param {Element} svg
 * @param {{W: number, H: number}} vp
 * @returns {Array<{text: string, cls: string, px: number, screenPx: number, floor: number, decl: string, source: string}>}
 */
export function screenTexts(svg, vp) {
  const out = [];
  for (const t of svg.querySelectorAll('text')) {
    const content = t.textContent.trim();
    if (!content) continue;
    let hidden = false;
    for (let n = t; n && n !== svg.parentNode; n = n.parentNode) {
      const st = n.style || {};
      if (st.visibility === 'hidden' || st.display === 'none' || n.getAttribute('display') === 'none'
        || n.localName === 'defs' || n.getAttribute('opacity') === '0' || st.opacity === '0') { hidden = true; break; }
    }
    if (hidden) continue;
    const f = computedFontSize(t, vp);
    const s = screenScale(t);
    out.push({
      text: content,
      cls: t.getAttribute('class') || '',
      px: f.px,
      screenPx: f.px * s,
      floor: /--font-size-label/.test(f.decl) ? FLOORS.label : FLOORS.data,
      decl: f.decl,
      source: f.source,
    });
  }
  return out;
}

/** The texts drawn under their floor (with a 0.01 px tolerance), formatted for an assertion message. */
export function underFloor(svg, vp) {
  return screenTexts(svg, vp)
    .filter((t) => !(t.screenPx >= t.floor - 0.01))
    .map((t) => `${t.text} [${t.cls}] ${Number.isFinite(t.screenPx) ? t.screenPx.toFixed(2) : t.screenPx} px < ${t.floor} (${t.source}: ${t.decl})`);
}
