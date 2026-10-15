// Phase 9c F4 (D1): the Sectors panel shows every driver row: fitted to the
// panel's height (26 px down to 18 px) or paged with a visible pager; the
// ranked columns (Best, Top Speeds) fitted to its width or paged too.
//
// The browser pass found the 20 rows drawn into overflow-hidden bodies: in a
// preset pane (609 x 257 at 1536 x 750) the rows below the body were cut,
// with no scroll and no pager; the four speed columns (about 197 px of row
// each, the unit repeated on every row) were cut sideways in 140 px columns.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';

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
const observers = new Set();
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.els = new Set(); observers.add(this); }
  observe(el) { this.els.add(el); }
  unobserve(el) { this.els.delete(el); }
  disconnect() { this.els.clear(); observers.delete(this); }
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: SectorsPanel } = await import('../components/visualizations/SectorsPanel.jsx');
const {
  sectorsRowFit, sectorsColumnsFit, SECTORS_ROW_MIN, SECTORS_ROW_MAX, SECTORS_PAGER_H, SECTORS_COL_EM,
} = await import('../utils/views/sectorsPanel.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.resolve(SRC, '../public/fonts');
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** 20 drivers, 10 laps with sector times and speed traps. */
function race() {
  const lap_times = [];
  const driver_info = [];
  for (let i = 0; i < 20; i++) {
    const d = `D${String(i + 1).padStart(2, '0')}`;
    driver_info.push({ Abbreviation: d });
    for (let k = 1; k <= 10; k++) {
      const start = 1000 + 90 * (k - 1) + i * 0.5;
      const s1 = 28 + i * 0.01 + k * 0.001;
      const s2 = 31 + i * 0.012;
      const s3 = 90 - s1 - s2 + i * 0.01;
      lap_times.push({
        Driver: d, LapNumber: k, LapStartTime: start, Time: start + 90, LapTimeSeconds: s1 + s2 + s3, Position: i + 1,
        Sector1TimeSeconds: s1, Sector2TimeSeconds: s2, Sector3TimeSeconds: s3,
        Sector1SessionTime: start + s1, Sector2SessionTime: start + s1 + s2,
        SpeedI1: 300 - i, SpeedI2: 280 - i * 0.5, SpeedFL: 320 - i * 0.7, SpeedST: 340 - i * 0.9,
        Compound: 'MEDIUM', TyreLife: k, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return { lap_times, driver_info, race_results: [], track_status: [], weather_data: [] };
}

// The first measure (before any ResizeObserver callback) reads the host's
// rect: a tall host, so the panel starts with every row and no pager
async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 1209, height: 900 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(SectorsPanel)); });
  const byLabel = (label) => [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || text(b) === label);
  return {
    host,
    liveRows: () => [...host.querySelectorAll('.sectors-panel__live-row')],
    columns: () => [...host.querySelectorAll('.sectors-panel__column')],
    pager: () => host.querySelector('.sectors-panel__pager'),
    async click(label) { await act(async () => { dom.mouse(byLabel(label), 'click'); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}
async function resize(el, width, height) {
  dom.setRect(el, { left: 0, top: 0, width, height });
  await act(async () => {
    for (const o of observers) if (o.els.has(el)) o.cb([{ target: el, contentRect: { width, height } }]);
  });
}

beforeEach(() => {
  const data = race();
  useF1Store.setState({
    ...INITIAL, sessionData: data, drivers: data.driver_info, maxLap: 10, totalRaceLaps: 10, currentLap: 8,
    loadedSessionType: 'R', sessionType: 'R', focusDriver: null, selectedDrivers: [], highlightedDriver: null, speedUnit: 'kmh',
  });
});
afterEach(() => { observers.clear(); });

describe('sectorsRowFit / sectorsColumnsFit (utils/views/sectorsPanel.js)', () => {
  it('rows: every row while 18 px rows fit (up to 26 px), else pages next to the pager; unknown height: every row', () => {
    expect([SECTORS_ROW_MIN, SECTORS_ROW_MAX, SECTORS_PAGER_H]).toEqual([18, 26, 22]);
    expect(sectorsRowFit(400, 20)).toEqual({ rowH: 20, perPage: 20, paged: false });
    expect(sectorsRowFit(900, 20)).toEqual({ rowH: 26, perPage: 20, paged: false });
    expect(sectorsRowFit(360, 20)).toEqual({ rowH: 18, perPage: 20, paged: false });
    expect(sectorsRowFit(200, 20)).toEqual({ rowH: 18, perPage: 9, paged: true });
    expect(sectorsRowFit(0, 20)).toEqual({ rowH: 26, perPage: 20, paged: false });
  });
  it('columns: as many of >= 16 em as the width holds, at least one', () => {
    const w = Math.ceil(SECTORS_COL_EM * 11);
    expect(sectorsColumnsFit(593, 4, w)).toBe(3);
    expect(sectorsColumnsFit(525, 3, w)).toBe(2);
    expect(sectorsColumnsFit(1209, 4, w)).toBe(4);
    expect(sectorsColumnsFit(100, 4, w)).toBe(1);
    expect(sectorsColumnsFit(0, 4, w)).toBe(4);
  });
});

describe('the panel (mini DOM, measured sizes mocked)', () => {
  it('live: 20 rows fitted to a 400 px body (20 px each), no pager', async () => {
    const v = await mount();
    await resize(v.host.querySelector('.sectors-panel__live-body'), 591, 400);
    expect(v.liveRows()).toHaveLength(20);
    for (const r of v.liveRows()) expect(r.style.height).toBe('20px');
    expect(v.pager()).toBeNull();
    await v.unmount();
  });

  it('live in a preset pane (200 px of body): pages of 9 rows with a visible pager; stable when the pager takes its line; every driver reachable', async () => {
    const v = await mount();
    const body = v.host.querySelector('.sectors-panel__live-body');
    await resize(body, 591, 200);
    expect(v.liveRows()).toHaveLength(9);
    expect(text(v.pager())).toContain('P1–P9 of 20');
    // the pager's line now takes 22 px from the body: the fit gives it back,
    // the page is the same (9 x 18 = 162 px in the 178 px left)
    await resize(body, 591, 200 - SECTORS_PAGER_H);
    expect(v.liveRows()).toHaveLength(9);
    for (const r of v.liveRows()) expect(r.style.height).toBe('18px');
    const seen = v.liveRows().map((r) => text(r.querySelector('.sectors-panel__live-drv')));
    await v.click('Next positions');
    expect(text(v.pager())).toContain('P10–P18 of 20');
    seen.push(...v.liveRows().map((r) => text(r.querySelector('.sectors-panel__live-drv'))));
    await v.click('Next positions');
    expect(text(v.pager())).toContain('P19–P20 of 20');
    seen.push(...v.liveRows().map((r) => text(r.querySelector('.sectors-panel__live-drv'))));
    expect(new Set(seen).size).toBe(20);
    await v.unmount();
  });

  it('top speeds in a 593 px wide pane: 3 of the 4 trap columns, a column pager, the unit in the column header only', async () => {
    const v = await mount();
    await v.click('Top Speeds');
    await resize(v.host.querySelector('.sectors-panel__columns'), 593, 220);
    await resize(v.host.querySelector('.sectors-panel__col-body'), 192, 190);
    expect(v.columns()).toHaveLength(3);
    expect(text(v.pager())).toContain('(1–3 of 4)');
    expect(v.host.querySelector('.sectors-panel__speed-unit')).toBeNull();
    expect(text(v.columns()[0].querySelector('.sectors-panel__col-best'))).toMatch(/km\/h$/);
    // 190 px of body: 9 ranks a page in every column
    for (const c of v.columns()) expect(c.querySelectorAll('.sectors-panel__row')).toHaveLength(9);
    await v.click('Next columns');
    expect(v.columns()).toHaveLength(1);
    expect(text(v.columns()[0].querySelector('.sectors-panel__col-title'))).toMatch(/^Speed Trap/i);
    await v.unmount();
  });

  it('top speeds in a wide pane: the 4 columns and 20 ranks each, no pager', async () => {
    const v = await mount();
    await v.click('Top Speeds');
    await resize(v.host.querySelector('.sectors-panel__columns'), 1209, 500);
    await resize(v.host.querySelector('.sectors-panel__col-body'), 296, 440);
    expect(v.columns()).toHaveLength(4);
    for (const c of v.columns()) expect(c.querySelectorAll('.sectors-panel__row')).toHaveLength(20);
    expect(v.pager()).toBeNull();
    await v.unmount();
  });

  it('best: the D3 chart draws the ranks of the page in every sector (.sectors-best-row), the shared pager', async () => {
    const v = await mount();
    await v.click('Best');
    await resize(v.host.querySelector('.sectors-panel__columns'), 593, 220);
    await resize(v.host.querySelector('.sectors-panel__col-body'), 192, 190);
    expect(v.columns()).toHaveLength(3);
    // 190 px of body: 9 ranks a page (190 - 22 = 168 = 9 x 18 + 6)
    for (const c of v.columns()) {
      expect(c.querySelector('svg.sectors-best-chart'), 'D3 chart').toBeTruthy();
      expect(c.querySelectorAll('.sectors-best-row')).toHaveLength(9);
    }
    expect(text(v.pager())).toContain('P1–P9 of 20');
    await v.unmount();
  });

  it('best: the gap axis gets its room under the rows when that costs no page, else the rows take the body', async () => {
    const v = await mount();
    await v.click('Best');
    await resize(v.host.querySelector('.sectors-panel__columns'), 593, 440);
    const body = v.host.querySelector('.sectors-panel__col-body');
    // the body (measured by the panel) and the chart's box in it (its own hook)
    const resizeBody = async (h) => {
      await resize(body, 192, h);
      await resize(body.querySelector('.sectors-best'), 192, h);
      await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    };
    // 400 px: 20 x 18 = 360 fits in 400 - 20 (the axis): rows of 19 px, the axis under them
    await resizeBody(400);
    const first = () => v.columns()[0];
    expect(first().querySelectorAll('.sectors-best-row')).toHaveLength(20);
    expect(v.pager()).toBeNull();
    expect(first().querySelector('.sectors-best-axis'), 'gap axis').toBeTruthy();
    // 370 px: the 20 ranks fit, the axis would not: no axis, no page (the values stay next to the bars)
    await resizeBody(370);
    expect(first().querySelectorAll('.sectors-best-row')).toHaveLength(20);
    expect(v.pager()).toBeNull();
    expect(first().querySelector('.sectors-best-axis')).toBeNull();
    await v.unmount();
  });

  it('a render between the pager\'s commit and the measure that sees it keeps the page (no unpaging for a frame)', async () => {
    const v = await mount();
    const body = v.host.querySelector('.sectors-panel__live-body');
    // 350 px: 20 x 18 = 360 does not fit, 18 ranks a page next to the pager line
    await resize(body, 591, 350);
    expect(v.liveRows()).toHaveLength(18);
    expect(text(v.pager())).toContain('P1–P18 of 20');
    // a store change re-renders the panel before the body is measured again:
    // the measure (350 px, taken without the pager) gives nothing back
    await act(async () => { useF1Store.setState({ highlightedDriver: 'D03' }); });
    expect(v.liveRows()).toHaveLength(18);
    expect(v.pager()).toBeTruthy();
    // the measure with the pager on screen: 328 px + the 22 px line given back
    await resize(body, 591, 350 - SECTORS_PAGER_H);
    expect(v.liveRows()).toHaveLength(18);
    for (const r of v.liveRows()) expect(r.style.height).toBe('18px');
    await act(async () => { useF1Store.setState({ highlightedDriver: null }); });
    expect(v.liveRows()).toHaveLength(18);
    await v.unmount();
  });
});

describe('CSS: the rows have no vertical padding and the bodies never scroll', () => {
  const dash = fs.readFileSync(path.join(SRC, 'styles/dashboard.css'), 'utf8');
  const rule = (sel) => (dash.match(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  it('rows and bodies', () => {
    expect(rule('.sectors-panel__row')).toMatch(/padding: 0 6px;/);
    expect(rule('.sectors-panel__live-row')).toMatch(/padding: 0 8px;/);
    for (const s of ['.sectors-panel__live-body', '.sectors-panel__col-body']) {
      expect(rule(s), s).toMatch(/overflow: hidden;/);
      expect(rule(s), s).toMatch(/padding: 0;/);
    }
    expect(rule('.sectors-panel__col-header')).toMatch(/flex-wrap: wrap;/);
  });

  it('the ranked columns share one header row (subgrid), so every body is as tall as the measured one', () => {
    // verifier r1: each header wrapped on its own; a column whose header took
    // one more line than the first column's had a body 15-17.5 px shorter
    // than the fit, its last rank cut (Top Speeds at 2048 x 1100)
    const block = (dash.match(/@supports \(grid-template-rows: subgrid\) \{([\s\S]*?)\n\}/) || [])[1] || '';
    expect(block).toMatch(/\.sectors-panel__columns \{[^}]*display: grid;[^}]*grid-auto-flow: column;[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
    expect(block).toMatch(/\.sectors-panel__columns > \.sectors-panel__column \{[^}]*grid-row: span 2;[^}]*grid-template-rows: subgrid;/);
    // the title in the Bold face: "SPEED TRAP Lap 53" on one line in a 16 em column
    expect(rule('.sectors-panel__col-title')).toMatch(/font-weight: var\(--font-weight-bold\);/);
    // the first column's body is the one measured (SectorsBestTab, Top Speeds)
    const tab = fs.readFileSync(path.join(SRC, 'components/visualizations/SectorsBestTab.jsx'), 'utf8');
    expect(tab).toMatch(/ref=\{colIdx === 0 \? bodyRef : undefined\}/);
  });

  it('without subgrid every header keeps one line (an ellipsis on the title, its full text in a title), so the bodies stay equal', () => {
    // verifier r2: the fallback brought back the per-column header heights of
    // round 1 (P20 cut by about 7 px at 2048 x 1100) in a browser without subgrid
    const block = (dash.match(/@supports not \(grid-template-rows: subgrid\) \{([\s\S]*?)\n\}/) || [])[1] || '';
    expect(block).toMatch(/\.sectors-panel__col-header \{[^}]*flex-wrap: nowrap;/);
    expect(block).toMatch(/\.sectors-panel__col-title \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
    expect(block).toMatch(/\.sectors-panel__col-best \{[^}]*flex-shrink: 0;/);
    for (const file of ['SectorsPanel.jsx', 'SectorsBestTab.jsx']) {
      const src = fs.readFileSync(path.join(SRC, 'components/visualizations', file), 'utf8');
      for (const m of src.matchAll(/<span className="sectors-panel__col-title"([^>]*)>/g)) expect(m[1], file).toMatch(/title=\{/);
    }
  });
});

// A ranked row (rank, team bar, code, the value with its glyph, the gap) fits
// SECTORS_COL_EM data-type ems at the real font widths (JetBrains Mono 0.6 em)
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

describe.skipIf(!haveFont)('a ranked row fits its column (real font widths)', () => {
  const bold = haveFont ? faceWidths(path.join(FONTS, 'Formula1-Bold-4.ttf')) : null;
  const mono = (t, s) => [...t].length * 0.6 * s;
  for (const data of [11, 11.08, 12.41, 12.5]) {
    it(`data type ${data} px`, () => {
      const col = Math.ceil(SECTORS_COL_EM * data);
      // column border 2 + row padding 12, rank 16, bar 3, code (>= 30), the gaps (4 px), the gap column 44
      const frame = 2 + 12 + 16 + 4 + 3 + 4 + Math.max(30, bold('VER', data)) + 4 + 4 + 44;
      const speed = frame + mono('◆ 352.1', data);
      const best = frame + mono('◆ 31.234', data); // the bar takes what is left (min-width 0)
      console.log(`data ${data}: speed row ${speed.toFixed(1)}, best row ${best.toFixed(1)} px in a ${col} px column`);
      expect(speed).toBeLessThanOrEqual(col);
      expect(best).toBeLessThanOrEqual(col);
    });
  }
});
