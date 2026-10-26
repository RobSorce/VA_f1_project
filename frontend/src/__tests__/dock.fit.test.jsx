// The dock's capacity counts everything on the bar and
// follows the labels' real widths, so no button is cut at the four target
// viewports.
//
// The browser pass found 1439 px of buttons in the 1400 px bar at 1536 x 750,
// the first (Pit Wall) and last (Settings) buttons cut (the row is centred).
// BottomTabBar measured its buttons once, when it mounted, before the web
// font of the time was in (its labels were wider than the fallback's); the
// divider's 12 px of margin and the bar's border were not counted either.
// Now the bar measures again when the fonts finish loading and checks the
// rendered row after every render.
//
// The buttons' widths here are the real CSS ones: each is its padding (the
// .bottom-tab-bar__tab rule live at the viewport) plus the wider of the 18 px
// icon and its label (uppercase, letter-spacing 0.05em, --font-size-label, the
// Inter SemiBold face of weight 600, helpers/fontWidths.js), the fixed labels
// hidden up to 1440 px. Before the web font, the fallback's labels: narrower
// or wider than Inter's (system-ui differs by platform), both checked.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { loadCss, px, shellAt, VIEWPORTS } from './helpers/layoutModel.js';
import { mediaMatches, resolveVars, evalLength } from './helpers/layoutCss.js';
import { haveWebFont, faceWidths } from './helpers/fontWidths.js';

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
// ResizeObserver: the test delivers the notifications (G4 below)
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.els = new Set(); observers.add(this); }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  disconnect() { this.els.clear(); observers.delete(this); }
};
/** Notify every observer of `el` (its new width); returns how many got it. */
function notifyResize(el, width) {
  let n = 0;
  for (const o of [...observers]) {
    if (!o.els.has(el)) continue;
    n += 1;
    o.cb([{ target: el, contentRect: { width, height: 46 } }], o);
  }
  return n;
}
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
const INITIAL = useF1Store.getState();
const css = loadCss(SRC);

const haveFont = haveWebFont;
const label600 = haveFont ? faceWidths(600) : null;

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
const env = { vp: VIEWPORTS[0], fontScale: 1, fontLoaded: true, fallbackScale: 0.87 };
const has = (el, c) => (el.getAttribute?.('class') || '').split(/\s+/).includes(c);
function labelWidth(t, size) {
  const w = label600(t, size) + [...t].length * 0.05 * size;
  // before the web font: the fallback's labels, env.fallbackScale of Inter's
  return env.fontLoaded ? w : env.fallbackScale * w;
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

beforeEach(() => { env.fontScale = 1; env.fontLoaded = true; env.fallbackScale = 0.87; });

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
  for (const vp of VIEWPORTS) for (const fallback of [0.87, 1.15]) {
    it(`${vp.name}: nothing cut, before (fallback labels x ${fallback}) and after the Inter font loads; the fixed group always on the bar`, async () => {
      env.vp = vp;
      dom.window.innerWidth = vp.W;
      const c = dockCss(vp);
      // before the web font: the fallback labels
      env.fontLoaded = false;
      env.fallbackScale = fallback;
      const v = await mount();
      const before = renderedRow(v.nav);
      expect(before, 'fallback font').toBeLessThanOrEqual(c.maxWidth + 0.5);
      expect(v.fixed()).toHaveLength(3);
      // the font is in: the labels widen, the bar measures again
      env.fontLoaded = true;
      await act(async () => { for (const fn of fontListeners) fn(); });
      const after = renderedRow(v.nav);
      const shown = v.items().length;
      console.log(`${vp.name}: bar ${c.maxWidth} px; fallback row ${before.toFixed(1)} px; Inter row ${after.toFixed(1)} px with ${shown} of ${DOCK_DEFAULTS.length} items${v.overflow() ? ` + ⋯ (${v.overflow().getAttribute('title')})` : ''}`);
      expect(after, 'Inter font').toBeLessThanOrEqual(c.maxWidth + 0.5);
      expect(v.fixed()).toHaveLength(3);
      expect(shown + (v.overflow() ? Number(/^(\d+)/.exec(v.overflow().getAttribute('title'))[1]) : 0)).toBe(DOCK_DEFAULTS.length);
      await v.unmount();
    });
  }

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
    expect(v.items()).toHaveLength(DOCK_DEFAULTS.length);
    env.fontScale = 1.5; // e.g. a user font setting
    await act(async () => { useF1Store.setState({ activeTab: 'laptimes' }); });
    expect(renderedRow(v.nav)).toBeLessThanOrEqual(dockCss(vp).maxWidth + 0.5);
    expect(v.items().length).toBeLessThan(DOCK_DEFAULTS.length);
    await v.unmount();
  });
});

// The browser audit (docs/evidence/browser_audit_2026-10-16.md,
// "Re-check after Phase 9c") saw the first and last buttons cut for about
// 2 s after a window resize: the bar measured again only after a re-render.
// Now a ResizeObserver on the bar and on its container, the window resize and
// the page shown again render every item and measure at once (flushSync), so
// the row already fits when the callback returns, before the browser paints.
describe.skipIf(!haveFont)('the bar measures again as soon as its room changes, before the paint', () => {
  const at = (name) => VIEWPORTS.find((x) => x.name === name);
  const moveTo = (vp) => { env.vp = vp; dom.window.innerWidth = vp.W; };
  // A dock that fits the 2048 px bar and not the 1536 px one (the default
  // dock fits both in Inter): the defaults and three more views
  const DOCK = [...DOCK_DEFAULTS, 'trackmap', 'telemetry', 'lapdelta'];

  it('the bar shrinks (2048 -> 1536 px window): its observer refits the row within the callback', async () => {
    moveTo(at('2048x1100'));
    const v = await mount(DOCK);
    expect(v.items()).toHaveLength(DOCK.length);
    // moved to the 1536 px screen: the bar's max-width shrinks; nothing renders but the observer
    moveTo(at('1536x750'));
    const max = dockCss(env.vp).maxWidth;
    let inCallback = null;
    await act(async () => {
      expect(notifyResize(v.nav, max)).toBe(1);
      // the same task, no await: what the browser paints next
      inCallback = { row: renderedRow(v.nav), items: v.items().length, overflow: !!v.overflow() };
    });
    expect(inCallback.row).toBeLessThanOrEqual(max + 0.5);
    expect(inCallback.items).toBeLessThan(DOCK.length);
    expect(inCallback.overflow).toBe(true);
    expect(v.fixed()).toHaveLength(3);
    await v.unmount();
  });

  it('the container grows (1536 -> 2048 px window): every item back on the bar within the callback', async () => {
    moveTo(at('1536x750'));
    const v = await mount(DOCK);
    expect(v.items().length).toBeLessThan(DOCK.length);
    moveTo(at('2048x1100'));
    let inCallback = null;
    await act(async () => {
      expect(notifyResize(v.nav.parentElement, at('2048x1100').W)).toBe(1);
      inCallback = { items: v.items().length, overflow: !!v.overflow(), row: renderedRow(v.nav) };
    });
    expect(inCallback.items).toBe(DOCK.length);
    expect(inCallback.overflow).toBe(false);
    expect(inCallback.row).toBeLessThanOrEqual(dockCss(env.vp).maxWidth + 0.5);
    await v.unmount();
  });

  it('a window resize alone (no observer notification): refitted within the event', async () => {
    moveTo(at('2048x1100'));
    const v = await mount(DOCK);
    moveTo(at('1366x768'));
    let inEvent = null;
    await act(async () => {
      dom.mouse(dom.window, 'resize', { bubbles: false });
      inEvent = renderedRow(v.nav);
    });
    expect(inEvent).toBeLessThanOrEqual(dockCss(env.vp).maxWidth + 0.5);
    await v.unmount();
  });

  it('the bar\'s own change (an item moved to the ⋯ popover): the observer measures nothing more', async () => {
    moveTo(at('1536x750'));
    const v = await mount(DOCK);
    const before = v.items().length;
    expect(v.overflow()).not.toBeNull();
    const row = renderedRow(v.nav);
    await act(async () => { notifyResize(v.nav, row); });
    expect(v.items()).toHaveLength(before);
    expect(renderedRow(v.nav)).toBeCloseTo(row, 5);
    await v.unmount();
  });
});
