// Phase 9c F1 (D1): the Analyse sidebar's race tower shows every driver row
// at the four target viewports.
//
// The browser pass (docs/evidence/browser_audit_2026-10-16.md)
// found the tower body at 440 px with 554 px of content: P16-P20 and the
// retired rows below it, no scroll, no pager. 554 = 19 x 28 + 22: the rows
// still stood at the 28 px spacing of the first, unmeasured render while the
// body had 22 px rows. Their translateY was in px (k x rowH), so a new row
// height was a new transform, animated by the row's 500 ms transform
// transition (and recomputed only when a ResizeObserver callback came).
// Now each row is calc(100% / n) of a body that takes its height from the
// flex layout (at most 28 px a row), moved by translateY(k x 100 %) of its
// own height: a resize changes no transform, the rows tile the body with no
// measure; the measure decides only when to page (fitRows, 18 px floor).
// The legend (three lines in the 240-300 px sidebar) opens from a "?" key
// below 900 px of window height.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';
import { loadCss, px, shellAt, VIEWPORTS } from './helpers/layoutModel.js';

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
// ResizeObserver: the test delivers the callbacks (resize below)
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.els = new Set(); observers.add(this); }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  disconnect() { this.els.clear(); observers.delete(this); }
};
const media = { short: false };
dom.window.matchMedia = (q) => ({
  matches: q === '(max-height: 899px)' ? media.short : false,
  addEventListener() {}, removeEventListener() {},
});

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: Leaderboard } = await import('../components/visualizations/Leaderboard.jsx');
const { towerRowStyle, towerBodyStyle } = await import('../utils/views/leaderboard.js');
const { fitRows } = await import('../utils/views/chartBox.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.resolve(SRC, '../public/fonts');
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** A synthetic race of 20 drivers, 10 laps, every row in the field. */
function race(n = 20, laps = 10) {
  const lap_times = [];
  const driver_info = [];
  for (let i = 0; i < n; i++) {
    const d = `D${String(i + 1).padStart(2, '0')}`;
    driver_info.push({ Abbreviation: d, FullName: `Driver ${d}` });
    for (let k = 1; k <= laps; k++) {
      const start = 1000 + 90 * (k - 1) + i * 0.5;
      lap_times.push({
        Driver: d, LapNumber: k, LapStartTime: start, Time: start + 90, LapTimeSeconds: 90 + i * 0.01,
        Position: i + 1, Compound: 'MEDIUM', TyreLife: k, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return { lap_times, driver_info, race_results: [], track_status: [], weather_data: [] };
}

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 288, height: 600 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Leaderboard, { collapsed: false })); });
  return {
    host,
    rows: () => host.querySelectorAll('.tower-row'),
    wrap: () => host.querySelector('.tower-rows'),
    body: () => host.querySelector('.tower-body'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

/** The rows' area gets a new size: its rect and the ResizeObserver callbacks. */
async function resize(el, height, width = 288) {
  dom.setRect(el, { left: 0, top: 0, width, height });
  await act(async () => {
    for (const o of observers) if (o.els.has(el)) o.cb([{ target: el, contentRect: { width, height } }]);
  });
}

const transforms = (v) => Object.fromEntries([...v.rows()].map((r) => [text(r.querySelector('.tower-row__driver-name')), r.style.transform]));

beforeEach(() => {
  media.short = false;
  const data = race();
  useF1Store.setState({
    ...INITIAL, sessionData: data, drivers: data.driver_info, maxLap: 10, totalRaceLaps: 10, currentLap: 8,
    loadedSessionType: 'R', sessionType: 'R', focusDriver: null, selectedDrivers: [],
    computeRaceProjection: () => {}, computeRaceSituation: () => {},
  });
});
afterEach(() => { observers.clear(); });

describe('row geometry (utils/views/leaderboard.js)', () => {
  it('the rows tile the body: row k of n is calc(100% / n), moved k times its own height', () => {
    for (const n of [5, 15, 20, 22]) {
      for (let k = 0; k < n; k++) {
        expect(towerRowStyle(k, n)).toEqual({ height: `calc(100% / ${n})`, transform: `translateY(${k * 100}%)` });
      }
    }
  });
  it('the body: the flex room up to 28 px a row; paged, the rows of the page at 18 px; empty, the placeholder', () => {
    expect(towerBodyStyle({ rows: 20, perPage: 20, paged: false, rowMin: 18, rowMax: 28 }))
      .toEqual({ position: 'relative', flex: '1 1 0', minHeight: 0, maxHeight: 560 });
    expect(towerBodyStyle({ rows: 20, perPage: 15, paged: true, rowMin: 18, rowMax: 28 }))
      .toEqual({ position: 'relative', flex: '0 0 auto', height: 270 });
    expect(towerBodyStyle({ rows: 0, perPage: 1, paged: false, rowMin: 18, rowMax: 28 }).minHeight).toBe(120);
  });
});

describe('the tower in the sidebar (mini DOM, measured sizes mocked)', () => {
  it('every one of the 20 rows is drawn, at k x 100 % of its own height, in a flex body of at most 28 px a row', async () => {
    const v = await mount();
    await resize(v.wrap(), 600);
    const rows = [...v.rows()];
    expect(rows).toHaveLength(20);
    const ks = rows.map((r) => Number(/translateY\((\d+)%\)/.exec(r.style.transform)[1]) / 100).sort((a, b) => a - b);
    expect(ks).toEqual(Array.from({ length: 20 }, (_, i) => i));
    for (const r of rows) expect(r.style.height).toBe('calc(100% / 20)');
    expect(v.body().style.flex).toBe('1 1 0');
    expect(v.body().style.maxHeight).toBe('560px');
    expect(v.host.querySelector('.tower-pager')).toBeNull();
    await v.unmount();
  });

  it('a resize (600 -> 440 -> 380 px, the sizes the browser pass met) moves no transform: nothing to animate below the body', async () => {
    const v = await mount();
    await resize(v.wrap(), 600);
    const before = transforms(v);
    for (const h of [440, 380, 361]) {
      await resize(v.wrap(), h);
      expect(transforms(v), `${h} px`).toEqual(before);
      expect(v.rows()).toHaveLength(20);
      expect(v.host.querySelector('.tower-pager'), `${h} px`).toBeNull();
    }
    await v.unmount();
  });

  it('below 20 x 18 px the rows are paged with a visible pager, never cut', async () => {
    const v = await mount();
    await resize(v.wrap(), 300);
    const perPage = fitRows(300, 20, { rowMin: 18, rowMax: 28, pagerH: 22 }).perPage;
    expect(perPage).toBe(15);
    expect(v.rows()).toHaveLength(15);
    expect(v.body().style.height).toBe('270px');
    expect(text(v.host.querySelector('.tower-pager__text'))).toBe('P1–P15 of 20');
    const next = [...v.host.querySelectorAll('.tower-pager__btn')].find((b) => b.getAttribute('aria-label') === 'Next positions');
    await act(async () => { dom.mouse(next, 'click'); });
    expect(text(v.host.querySelector('.tower-pager__text'))).toBe('P16–P20 of 20');
    const ks = [...v.rows()].map((r) => r.style.transform);
    expect(ks).toEqual(['translateY(0%)', 'translateY(100%)', 'translateY(200%)', 'translateY(300%)', 'translateY(400%)']);
    await v.unmount();
  });

  it('below 900 px of window height the legend opens from the "?" key, as a card over the rows (closed by Escape)', async () => {
    media.short = true;
    const v = await mount();
    expect(v.host.querySelector('.tower-legend')).toBeNull();
    const key = v.host.querySelector('.tower-legend-toggle');
    expect(key.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { dom.mouse(key, 'click'); });
    const pop = v.host.querySelector('#tower-legend-popover');
    expect(pop).not.toBeNull();
    // the card lies over the rows' area (inside .tower-rows), it takes no room from them
    expect(pop.parentNode.getAttribute('class')).toBe('tower-rows');
    expect(pop.querySelectorAll('.legend-item')).toHaveLength(10);
    await act(async () => {
      dom.window.dispatchEvent({
        type: 'keydown', key: 'Escape', bubbles: false, _stop: false, preventDefault() {}, stopPropagation() {},
      });
    });
    expect(v.host.querySelector('#tower-legend-popover')).toBeNull();
    await v.unmount();
  });

  it('on a tall window the legend stays in the panel and there is no key', async () => {
    const v = await mount();
    expect(v.host.querySelector('.tower-legend')).not.toBeNull();
    expect(v.host.querySelector('.tower-legend-toggle')).toBeNull();
    await v.unmount();
  });

  it.skipIf(!hasCachedSession(2024, 16))('Monza 2024 lap 51 (the browser pass): all 20 rows, GAS BOT ZHO HUL TSU included, in a 440 px body', async () => {
    const monza = loadCachedSession(2024, 16);
    useF1Store.setState({ sessionData: monza, drivers: monza.driver_info, maxLap: 53, totalRaceLaps: 53, currentLap: 51 });
    const v = await mount();
    await resize(v.wrap(), 440);
    const t = transforms(v);
    expect(Object.keys(t)).toHaveLength(20);
    for (const d of ['GAS', 'BOT', 'ZHO', 'HUL', 'TSU']) expect(t[d], d).toMatch(/^translateY\(\d+%\)$/);
    expect(new Set(Object.values(t)).size).toBe(20);
    expect(v.host.querySelector('.tower-pager')).toBeNull();
    await v.unmount();
  });
});

// ---------------------------------------------------------------------------
// Static fit at the four viewports (the model of
// frontend/scripts/audit/panel_fit.mjs): the sidebar's height less the
// tower chrome (CSS rules and tokens), the legend (inline from 900 px of
// height, its lines from the real Formula1 widths), a flag banner, the
// forecast footer and the focus cards (collapsed below 1200 px, SidebarFocusCards)
// leaves >= 20 x 18 px for the rows in every state.
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
  // a glyph the face lacks counts 1 em (an upper bound of the fallback)
  return (t, size) => [...t].reduce((a, ch) => { const g = glyph(ch.codePointAt(0)); return a + (g ? adv(g) : upm); }, 0) / upm * size;
}
const haveFonts = ['Formula1-Regular-1.ttf', 'Formula1-Wide.ttf'].every((f) => fs.existsSync(path.join(FONTS, f)));

describe.skipIf(!haveFonts)('static fit: 20 rows >= 18 px in every state at the four viewports', () => {
  const css = loadCss(SRC);
  const regular = faceWidths(path.join(FONTS, 'Formula1-Regular-1.ttf'));
  const wide = faceWidths(path.join(FONTS, 'Formula1-Wide.ttf'));
  const lb = fs.readFileSync(path.join(SRC, 'components/visualizations/Leaderboard.jsx'), 'utf8');
  const vis = fs.readFileSync(path.join(SRC, 'styles/visualizations.css'), 'utf8');
  it('the constants the model reads', () => {
    expect(lb).toMatch(/const ROW_MIN = 18;/);
    expect(lb).toMatch(/const ROW_MAX = 28;/);
    expect(lb).toMatch(/LEGEND_POPOVER_VIEWPORT = '\(max-height: 899px\)'/);
    expect(vis).toMatch(/\.tower-broadcast-header \{[^}]*padding: 6px 26px 6px 12px;/);
    expect(vis).toMatch(/\.tower-col-header \{[^}]*padding: 3px 8px;/);
    expect(vis).toMatch(/\.tower-flag-banner \{[^}]*padding: 3px 8px;/);
    expect(vis).toMatch(/\.tower-row \{[^}]*padding: 0 6px;/);
  });
  for (const vp of VIEWPORTS) {
    it(`${vp.name}`, () => {
      const s = shellAt(css, vp);
      const data = px(css, '--font-size-data', vp);
      const label = px(css, '--font-size-label', vp);
      const xs = px(css, '--spacing-xs', vp);
      const LH = 1.4;
      const header = 12 + Math.max(18, 16 * LH + 1.5) + 1;
      const chrome = header + 24 + (6 + data * LH + 1);
      const items = [['▲', 'vs grid'], ['▼', 'lost'], ['S', ''], ['M', ''], ['H', ''], ['P', 'pit'], ['⇅', '<30%'], ['⇅', '≥30%'], ['⇅', '≥60%'], ['⚔', 'battle']]
        .map(([g, t], i) => 2 * xs + (i >= 2 && i <= 4 ? Math.max(14, wide(g, label)) + 6 : Math.max(10, wide(g, label))) + 4 + (t ? regular(t, label) : 0));
      let lines = 1; let x = 0;
      for (const w of items) { if (x > 0 && x + xs + w > s.sidebar - 12) { lines += 1; x = w; } else x += (x > 0 ? xs : 0) + w; }
      const legend = vp.H >= 900 ? 2 * xs + lines * (4 + label * LH) + (lines - 1) * xs : 0;
      const banner = 6 + Math.max(label * LH, 12 * LH) + 1;
      const forecast = 8 + 2 * data * LH + 3;
      const collapsed = 22 + (2 + 16 + Math.max(18, 13 * LH, data * LH + 4)) + (1 + 16 + Math.max(24, 15 + data * LH) + 1);
      const hint = 1 + 24 + Math.max(data, 0.6875 * s.root) * 1.6;
      expect(vp.H).toBeLessThan(1200); // the focus cards open in full only from 1200 px
      for (const [state, extra] of [['no focus driver', hint], ['focus, cards collapsed', collapsed], ['focus + flag + forecast', collapsed + banner + forecast]]) {
        const room = s.body - chrome - legend - extra;
        const fit = fitRows(room, 20, { rowMin: 18, rowMax: 28, rowDefault: 28, pagerH: 22 });
        console.log(`${vp.name} ${state}: ${room.toFixed(1)} px for the rows (legend ${vp.H >= 900 ? `${lines} lines` : 'behind the key'}) -> ${fit.paged ? `paged ${fit.perPage}` : `20 rows at ${fit.rowH} px`}`);
        expect(fit.paged, `${vp.name} ${state}`).toBe(false);
      }
    });
  }
});
