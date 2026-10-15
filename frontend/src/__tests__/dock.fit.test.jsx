// Phase 9c F2 (D2): the dock's capacity counts everything on the bar and
// follows the labels' real widths, so no button is cut at the four target
// viewports.
//
// The browser pass found 1439 px of buttons in the 1400 px bar at 1536 x 750,
// the first (Pit Wall) and last (Settings) buttons cut (the row is centred).
// BottomTabBar measured its buttons once, when it mounted, before the
// Formula1 web font was in: with the fallback font's labels the default dock
// fits (1292 px at 1536 x 750 with Segoe UI Bold, the system-ui of Windows),
// with the Formula1 Bold labels it is 1490 px (notes/experiments/v13_audit/
// dock_fit.mjs); the divider's 12 px of margin and the bar's border were not
// counted either. Now the bar measures again when the fonts finish loading
// and checks the rendered row after every render.
//
// The buttons' widths here are the real CSS ones: each is its padding (the
// .bottom-tab-bar__tab rule live at the viewport) plus the wider of the 18 px
// icon and its label (uppercase, letter-spacing 0.05em, --font-size-label, the
// Formula1 Bold face from public/fonts), the fixed labels hidden up to 1440 px.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { loadCss, px, shellAt, VIEWPORTS } from './helpers/layoutModel.js';
import { mediaMatches, resolveVars, evalLength } from './helpers/layoutCss.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const dom = installMiniDom();
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
// document.fonts: the test says when the web fonts are in
const fontListeners = new Set();
dom.document.fonts = {
  ready: new Promise(() => {}), // resolved by no one: 'loadingdone' is the signal here
  addEventListener: (type, fn) => { if (type === 'loadingdone') fontListeners.add(fn); },
  removeEventListener: (type, fn) => { if (type === 'loadingdone') fontListeners.delete(fn); },
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store, DOCK_DEFAULTS } = await import('../store/useF1Store.js');
const { default: BottomTabBar } = await import('../components/ui/BottomTabBar.jsx');
const { dockCapacity, dockRow } = await import('../utils/dockCapacity.js');
const { SLOT_OPTIONS } = await import('../utils/slotOptions.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.resolve(SRC, '../public/fonts');
const INITIAL = useF1Store.getState();
const css = loadCss(SRC);

/** Advance widths of a TTF (cmap format 4 + hmtx); a glyph the face lacks counts 1 em. */
function faceWidths(file) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = {};
  for (let i = 0; i < dv.getUint16(4); i++) {
    const o = 12 + i * 16;
    tables[String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])] = dv.getUint32(o + 8);
  }
  const upm = dv.getUint16(tables.head + 18);
  const nh = dv.getUint16(tables.hhea + 34);
  const adv = (g) => dv.getUint16(tables.hmtx + 4 * Math.min(g, nh - 1));
  let sub = null;
  for (let i = 0; i < dv.getUint16(tables.cmap + 2); i++) {
    const pid = dv.getUint16(tables.cmap + 4 + i * 8);
    const off = dv.getUint32(tables.cmap + 8 + i * 8);
    if (dv.getUint16(tables.cmap + off) === 4 && (pid === 3 || pid === 0)) sub = tables.cmap + off;
  }
  const segX2 = dv.getUint16(sub + 6);
  const ends = sub + 14; const starts = ends + segX2 + 2; const deltas = starts + segX2; const ranges = deltas + segX2;
  const glyph = (code) => {
    for (let i = 0; i < segX2 / 2; i++) {
      if (code > dv.getUint16(ends + 2 * i)) continue;
      const start = dv.getUint16(starts + 2 * i);
      if (code < start) return 0;
      const ro = dv.getUint16(ranges + 2 * i);
      if (!ro) return (code + dv.getInt16(deltas + 2 * i)) & 0xffff;
      const g = dv.getUint16(ranges + 2 * i + ro + 2 * (code - start));
      return g ? (g + dv.getInt16(deltas + 2 * i)) & 0xffff : 0;
    }
    return 0;
  };
  return (t, size) => [...t].reduce((a, ch) => { const g = glyph(ch.codePointAt(0)); return a + (g ? adv(g) : upm); }, 0) / upm * size;
}
const haveFont = fs.existsSync(path.join(FONTS, 'Formula1-Bold-4.ttf'));
const bold = haveFont ? faceWidths(path.join(FONTS, 'Formula1-Bold-4.ttf')) : null;

/** Last declaration of `prop` for an exact selector live at vp (dashboard.css order). */
function declAt(selector, prop, vp) {
  let v = null;
  for (const r of css.rules) {
    if (!mediaMatches(r.media, vp)) continue;
    if (!r.selector.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) v = d.value;
  }
  return v;
}
const len = (value, vp) => evalLength(resolveVars(value, css.tokens), { W: vp.W, H: vp.H, root: shellAt(css, vp).root });
const hPad = (value, vp) => { const p = String(value).trim().split(/\s+/); return len(p.length > 1 ? p[1] : p[0], vp); };

/** The bar's CSS at a viewport (cached: the mini DOM asks for it on every measure). */
const dockCssCache = new Map();
function dockCss(vp) {
  if (!dockCssCache.has(vp.name)) dockCssCache.set(vp.name, dockCssOf(vp));
  return dockCssCache.get(vp.name);
}
function dockCssOf(vp) {
  const lastPadding = (sels) => {
    let v = null;
    for (const r of css.rules) {
      if (!mediaMatches(r.media, vp)) continue;
      if (!r.selector.split(',').map((s) => s.trim()).some((s) => sels.includes(s))) continue;
      for (const d of r.decls) if (d.prop === 'padding') v = d.value;
    }
    return hPad(v, vp);
  };
  return {
    label: px(css, '--font-size-label', vp),
    labelHidden: declAt('.bottom-tab-bar__label', 'display', vp) === 'none',
    fixedLabelHidden: declAt('.bottom-tab-bar__tab--fixed .bottom-tab-bar__label', 'display', vp) === 'none',
    tabPad: lastPadding(['.bottom-tab-bar__tab']),
    fixedPad: lastPadding(['.bottom-tab-bar__tab', '.bottom-tab-bar__tab--fixed']),
    overflowPad: hPad(declAt('.bottom-tab-bar__tab--overflow', 'padding', vp), vp),
    navPad: hPad(declAt('.bottom-tab-bar', 'padding', vp), vp),
    gap: len(declAt('.bottom-tab-bar', 'gap', vp), vp),
    border: 0.5,
    divider: { width: len(declAt('.bottom-tab-bar__divider', 'width', vp), vp), margin: hPad(declAt('.bottom-tab-bar__divider', 'margin', vp), vp) },
    maxWidth: len(declAt('.bottom-tab-bar', 'max-width', vp), vp),
  };
}

// The mini DOM's layout: widths from dockCss + the label font of the moment
const env = { vp: VIEWPORTS[0], fontScale: 1, fontLoaded: true };
const has = (el, c) => (el.getAttribute?.('class') || '').split(/\s+/).includes(c);
function labelWidth(t, size) {
  const w = bold(t, size) + [...t].length * 0.05 * size;
  // before the web font: a narrower fallback (the Segoe UI Bold row is 0.87 of the Formula1 one)
  return env.fontLoaded ? w : 0.87 * w;
}
function buttonWidth(el) {
  const c = dockCss(env.vp);
  const fixed = has(el, 'bottom-tab-bar__tab--fixed');
  if (has(el, 'bottom-tab-bar__tab--overflow')) return 2 * c.overflowPad + 18;
  const hidden = c.labelHidden || (fixed && c.fixedLabelHidden);
  const label = el.querySelector('.bottom-tab-bar__label');
  const text = label ? label.textContent.toUpperCase() : '';
  return 2 * (fixed ? c.fixedPad : c.tabPad) + Math.max(18, hidden || !text ? 0 : labelWidth(text, c.label) * env.fontScale);
}
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
const baseRect = ElementProto.getBoundingClientRect;
ElementProto.getBoundingClientRect = function rect() {
  if (has(this, 'bottom-tab-bar__tab')) {
    const width = buttonWidth(this);
    return { left: 0, top: 0, width, height: 46, x: 0, y: 0, right: width, bottom: 46 };
  }
  if (has(this, 'bottom-tab-bar__divider')) {
    const width = dockCss(env.vp).divider.width;
    return { left: 0, top: 0, width, height: 24, x: 0, y: 0, right: width, bottom: 24 };
  }
  return baseRect.call(this);
};
const baseStyle = dom.window.getComputedStyle;
dom.window.getComputedStyle = (el) => {
  const c = dockCss(env.vp);
  const z = { marginLeft: '0px', marginRight: '0px' };
  let s = null;
  if (has(el, 'bottom-tab-bar')) {
    s = {
      ...z, columnGap: `${c.gap}px`, paddingLeft: `${c.navPad}px`, paddingRight: `${c.navPad}px`,
      borderLeftWidth: `${c.border}px`, borderRightWidth: `${c.border}px`, maxWidth: `${c.maxWidth}px`,
    };
  } else if (has(el, 'bottom-tab-bar__divider')) {
    s = { marginLeft: `${c.divider.margin}px`, marginRight: `${c.divider.margin}px` };
  } else s = z;
  return { ...s, getPropertyValue: (name) => baseStyle(el).getPropertyValue(name) };
};
globalThis.getComputedStyle = dom.window.getComputedStyle;

/** The rendered row: every child of the bar, its margins, the gaps, padding and border. */
function renderedRow(nav) {
  const c = dockCss(env.vp);
  const parts = [...nav.children].map((el) => {
    const s = dom.window.getComputedStyle(el);
    return { width: el.getBoundingClientRect().width, marginLeft: parseFloat(s.marginLeft), marginRight: parseFloat(s.marginRight) };
  });
  return dockRow(parts, { gap: c.gap, paddingLeft: c.navPad, paddingRight: c.navPad, borderLeft: c.border, borderRight: c.border });
}

async function mount(items = DOCK_DEFAULTS) {
  useF1Store.setState({ ...INITIAL, dockItems: [...items], showDashboard: true, activeTab: 'pitwall', dockedLayout: null, openOverlays: [] });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(BottomTabBar)); });
  const nav = host.querySelector('nav.bottom-tab-bar');
  return {
    nav,
    items: () => [...nav.children].filter((el) => has(el, 'bottom-tab-bar__tab') && !has(el, 'bottom-tab-bar__tab--fixed') && !has(el, 'bottom-tab-bar__tab--overflow')),
    fixed: () => [...nav.children].filter((el) => has(el, 'bottom-tab-bar__tab--fixed')),
    overflow: () => nav.querySelector('.bottom-tab-bar__tab--overflow'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

beforeEach(() => { env.fontScale = 1; env.fontLoaded = true; });

describe('dockRow / dockCapacity (utils/dockCapacity.js)', () => {
  it('dockRow counts the widths, the margins, a gap between every two children, padding and border', () => {
    expect(dockRow([{ width: 100 }, { width: 1, marginLeft: 6, marginRight: 6 }, { width: 50 }],
      { gap: 2, paddingLeft: 6, paddingRight: 6, borderLeft: 0.5, borderRight: 0.5 })).toBe(100 + 13 + 50 + 4 + 13);
    expect(dockRow([], { paddingLeft: 6, paddingRight: 6 })).toBe(12);
  });
  it('with fixedWidth = dockRow(fixed group), items + fixed group are exactly the rendered row', () => {
    const box = { gap: 2, paddingLeft: 6, paddingRight: 6, borderLeft: 0.5, borderRight: 0.5 };
    const fixed = [{ width: 1, marginLeft: 6, marginRight: 6 }, { width: 90 }, { width: 50 }, { width: 95 }];
    const items = [80, 120, 60, 150, 140];
    const fixedWidth = dockRow(fixed, box);
    const row = dockRow([...items.map((width) => ({ width })), ...fixed], box);
    const available = row; // exactly full
    expect(dockCapacity(items, { available, fixedWidth, overflowWidth: 38, gap: 2 })).toBe(5);
    expect(dockCapacity(items, { available: row - 1, fixedWidth, overflowWidth: 38, gap: 2 })).toBeLessThan(5);
  });
});

describe.skipIf(!haveFont)('the dock at the four viewports, with the real CSS widths', () => {
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: nothing cut, before and after the Formula1 font loads; the fixed group always on the bar`, async () => {
      env.vp = vp;
      dom.window.innerWidth = vp.W;
      const c = dockCss(vp);
      // before the web font: the fallback labels
      env.fontLoaded = false;
      const v = await mount();
      const before = renderedRow(v.nav);
      expect(before, 'fallback font').toBeLessThanOrEqual(c.maxWidth + 0.5);
      expect(v.fixed()).toHaveLength(3);
      // the font is in: the labels widen, the bar measures again
      env.fontLoaded = true;
      await act(async () => { for (const fn of fontListeners) fn(); });
      const after = renderedRow(v.nav);
      const shown = v.items().length;
      console.log(`${vp.name}: bar ${c.maxWidth} px; fallback row ${before.toFixed(1)} px; Formula1 row ${after.toFixed(1)} px with ${shown} of ${DOCK_DEFAULTS.length} items${v.overflow() ? ` + ⋯ (${v.overflow().getAttribute('title')})` : ''}`);
      expect(after, 'Formula1 font').toBeLessThanOrEqual(c.maxWidth + 0.5);
      expect(v.fixed()).toHaveLength(3);
      expect(shown + (v.overflow() ? Number(/^(\d+)/.exec(v.overflow().getAttribute('title'))[1]) : 0)).toBe(DOCK_DEFAULTS.length);
      await v.unmount();
    });
  }

  it('1536x750: the measure of the code before Phase 9c (once, fallback font, no divider margin, no border) shows all 10 and the Formula1 row is wider than the bar', () => {
    const vp = VIEWPORTS.find((x) => x.name === '1536x750');
    env.vp = vp;
    const c = dockCss(vp);
    const labels = SLOT_OPTIONS.filter((o) => DOCK_DEFAULTS.includes(o.id)).map((o) => o.label.toUpperCase());
    const width = (t, loaded) => { env.fontLoaded = loaded; return 2 * c.tabPad + Math.max(18, labelWidth(t, c.label)); };
    const fixedW = (t, loaded) => { env.fontLoaded = loaded; return 2 * c.fixedPad + Math.max(18, c.fixedLabelHidden ? 0 : labelWidth(t, c.label)); };
    const oldFixed = 2 * c.navPad + c.divider.width + c.gap + ['LAYOUTS', '⌘K', 'SETTINGS'].reduce((a, t) => a + fixedW(t, false) + c.gap, 0);
    const oldCap = dockCapacity(labels.map((t) => width(t, false)), { available: c.maxWidth, fixedWidth: oldFixed, overflowWidth: 44, gap: c.gap });
    expect(oldCap).toBe(10);
    const real = dockRow([...labels.map((t) => ({ width: width(t, true) })), { width: c.divider.width, marginLeft: c.divider.margin, marginRight: c.divider.margin },
      ...['LAYOUTS', '⌘K', 'SETTINGS'].map((t) => ({ width: fixedW(t, true) }))],
    { gap: c.gap, paddingLeft: c.navPad, paddingRight: c.navPad, borderLeft: c.border, borderRight: c.border });
    console.log(`1536x750 before 9c: 10 of 10 kept; Formula1 row ${real.toFixed(1)} px in the ${c.maxWidth} px bar (the browser measured 1439)`);
    expect(real).toBeGreaterThan(c.maxWidth);
  });

  it('every view in the dock (25 items): the bar keeps what fits and the ⋯ popover the rest, at every viewport', async () => {
    const all = SLOT_OPTIONS.map((o) => o.id).filter((id) => id !== 'settings' && id !== 'charts');
    for (const vp of VIEWPORTS) {
      env.vp = vp;
      dom.window.innerWidth = vp.W;
      const v = await mount(all);
      expect(renderedRow(v.nav), vp.name).toBeLessThanOrEqual(dockCss(vp).maxWidth + 0.5);
      expect(v.overflow(), vp.name).not.toBeNull();
      expect(v.fixed()).toHaveLength(3);
      await v.unmount();
    }
  }, 60000);

  it('a label that grows with no event (no resize, no font event): the check after the render moves one more item to the ⋯', async () => {
    const vp = VIEWPORTS.find((x) => x.name === '1920x1080');
    env.vp = vp;
    dom.window.innerWidth = vp.W;
    const v = await mount();
    expect(v.items()).toHaveLength(10);
    env.fontScale = 1.25; // e.g. a user font setting
    await act(async () => { useF1Store.setState({ activeTab: 'laptimes' }); });
    expect(renderedRow(v.nav)).toBeLessThanOrEqual(dockCss(vp).maxWidth + 0.5);
    expect(v.items().length).toBeLessThan(10);
    await v.unmount();
  });
});
