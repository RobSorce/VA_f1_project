// Phase 9c F4 (D1): the Consistency panel shows every driver's card, on one
// page when they fit, else on pages with a visible pager; it never scrolls.
//
// The browser pass found 2-6 of the 20 cards at 1536 x 750: the grid
// (minmax(360px, 1fr) columns, 40 px collapsed cards, 12 px gaps) scrolled
// even with every card collapsed. Now a collapsed card is one fitted line
// (20-30 px), the cards are laid in as many columns of >= 32 data-type ems as
// the width holds (utils/views/consistencyLayout.js), an expanded card spans
// its row with its measured height, and the cards that do not fit go to the
// pages of a pager in the panel's header line.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { parseCss } from './helpers/layoutCss.js';

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
// An expanded card is EXPANDED_H px high in this mini DOM (the panel measures it)
let EXPANDED_H = 155;
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
const baseRect = ElementProto.getBoundingClientRect;
ElementProto.getBoundingClientRect = function rect() {
  if (this.getAttribute('data-expanded') === 'true') {
    const r = baseRect.call(this);
    return { ...r, height: EXPANDED_H, bottom: r.top + EXPANDED_H };
  }
  return baseRect.call(this);
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: ConsistencyPanel } = await import('../components/visualizations/ConsistencyPanel.jsx');
const {
  consistencyColumns, consistencyRows, consistencyPages, consistencyPageOf, CONSISTENCY_CARD_EM, CONSISTENCY_ROW_MIN,
} = await import('../utils/views/consistencyLayout.js');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.resolve(SRC, '../public/fonts');
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** 20 drivers, 20 laps, two stints each (a fit per stint): every driver has a σ. */
function race() {
  const lap_times = [];
  const driver_info = [];
  for (let i = 0; i < 20; i++) {
    const d = `D${String(i + 1).padStart(2, '0')}`;
    driver_info.push({ Abbreviation: d });
    for (let k = 1; k <= 20; k++) {
      const start = 1000 + 90 * (k - 1) + i * 0.5;
      const t = 90 + i * 0.01 + 0.03 * k + ((k * 7 + i * 3) % 5) * 0.05;
      lap_times.push({
        Driver: d, LapNumber: k, LapStartTime: start, Time: start + t, LapTimeSeconds: t, Position: i + 1,
        Compound: k <= 10 ? 'MEDIUM' : 'HARD', TyreLife: k <= 10 ? k : k - 10, Stint: k <= 10 ? 1 : 2, TrackStatus: '1',
        PitInTime: k === 10 ? start + 80 : null, PitOutTime: k === 11 ? start + 5 : null,
      });
    }
  }
  return { lap_times, driver_info, race_results: [], track_status: [], weather_data: [] };
}

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 600, height: 300 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(ConsistencyPanel)); });
  return {
    host,
    area: () => host.querySelector('.consistency-panel__area'),
    cards: () => [...host.querySelectorAll('.consistency-card')],
    pagerText: () => text(host.querySelector('.consistency-panel__pager span')),
    async click(label) {
      const b = [...host.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label);
      await act(async () => { dom.mouse(b, 'click'); });
    },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}
async function resize(el, width, height) {
  dom.setRect(el, { left: 0, top: 0, width, height });
  await act(async () => {
    for (const o of observers) if (o.els.has(el)) o.cb([{ target: el, contentRect: { width, height } }]);
  });
}
const codes = (v) => v.cards().map((c) => c.getAttribute('data-driver'));

beforeEach(() => {
  const data = race();
  useF1Store.setState({
    ...INITIAL, sessionData: data, drivers: data.driver_info, maxLap: 20, totalRaceLaps: 20, currentLap: 20,
    totalFrames: 100, currentFrameIndex: 99, currentTime: 100000, maxTime: 100000, sessionTimeOffset: 0,
    loadedSessionType: 'R', sessionType: 'R', focusDriver: null, selectedDrivers: [], highlightedDriver: null,
  });
});
afterEach(() => { observers.clear(); EXPANDED_H = 155; });

describe('consistencyLayout (pure)', () => {
  it('columns of >= minCardW px that the width holds', () => {
    const w = Math.ceil(CONSISTENCY_CARD_EM * 11);
    expect(w).toBe(352);
    expect(consistencyColumns(1209, 20, w)).toBe(3); // pace preset at 1536 x 750
    expect(consistencyColumns(593, 20, w)).toBe(1); // overview preset at 1536 x 750
    expect(consistencyColumns(1706, 20, w)).toBe(4);
    expect(consistencyColumns(0, 20, w)).toBe(1);
    expect(consistencyColumns(5000, 3, w)).toBe(3);
  });
  it('rows: collapsed cards share a row, an expanded one takes a row of its own', () => {
    const c = { expanded: false };
    const e = { expanded: true, height: 150 };
    expect(consistencyRows([c, c, e, c, c, c, c], 3)).toEqual([
      { start: 0, end: 2, expanded: false }, { start: 2, end: 3, expanded: true, height: 150 },
      { start: 3, end: 6, expanded: false }, { start: 6, end: 7, expanded: false },
    ]);
  });
  it('every card on one page when they fit (rows as tall as the room allows, 30 px at most)', () => {
    const cards = Array.from({ length: 20 }, () => ({ expanded: false }));
    expect(consistencyPages(cards, { cols: 3, room: 181 })).toEqual({ rowH: 22, pages: [{ start: 0, end: 20 }] });
    expect(consistencyPages(cards, { cols: 4, room: 322 }).rowH).toBe(30);
    // unknown room (server render): one page
    expect(consistencyPages(cards, { cols: 1, room: 0 }).pages).toEqual([{ start: 0, end: 20 }]);
  });
  it('else pages of rows at the minimum height, every card on a page, none twice', () => {
    const cards = Array.from({ length: 20 }, () => ({ expanded: false }));
    const { rowH, pages } = consistencyPages(cards, { cols: 1, room: 180 });
    expect(rowH).toBe(CONSISTENCY_ROW_MIN);
    expect(pages).toEqual([{ start: 0, end: 7 }, { start: 7, end: 14 }, { start: 14, end: 20 }]);
    // an expanded card (155 px) and one collapsed line share a 180 px page
    const withE = cards.map((c, i) => (i === 4 ? { expanded: true, height: 155 } : c));
    const p2 = consistencyPages(withE, { cols: 1, room: 180 }).pages;
    const covered = p2.flatMap((p) => Array.from({ length: p.end - p.start }, (_, k) => p.start + k));
    expect(covered).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(p2[consistencyPageOf(p2, 4)]).toEqual({ start: 4, end: 6 });
  });
});

describe('the panel (mini DOM, measured sizes mocked)', () => {
  it('pace preset at 1536 x 750 (cards area 1209 x 181): the 20 cards on one page, 3 columns of fitted one-line cards, no pager', async () => {
    const v = await mount();
    await resize(v.area(), 1209, 181);
    expect(v.cards()).toHaveLength(20);
    const grid = v.host.querySelector('.consistency-panel__grid');
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
    for (const c of v.cards()) expect(c.style.height).toBe('22px');
    expect(v.host.querySelector('.consistency-panel__pager')).toBeNull();
    await v.unmount();
  });

  it('overview preset (593 x 180): pages of 7 one-line cards with the pager in the header line; every driver reachable', async () => {
    const v = await mount();
    await resize(v.area(), 593, 180);
    const seen = [];
    expect(v.pagerText()).toBe('1–7/20');
    seen.push(...codes(v));
    await v.click('Next drivers');
    expect(v.pagerText()).toBe('8–14/20');
    seen.push(...codes(v));
    await v.click('Next drivers');
    expect(v.pagerText()).toBe('15–20/20');
    seen.push(...codes(v));
    expect(seen).toHaveLength(20);
    expect(new Set(seen).size).toBe(20);
    // the pager sits in the header line, not under the cards
    expect(v.host.querySelector('.consistency-panel__bar .consistency-panel__pager')).not.toBeNull();
    await v.unmount();
  });

  it('the focus driver\'s card opens on his page, spans the row (wide layout from 520 px) and its measured height is what the page holds', async () => {
    useF1Store.setState({ focusDriver: 'D12' });
    const v = await mount();
    await resize(v.area(), 593, 180);
    const exp = v.cards().filter((c) => c.getAttribute('data-expanded') === 'true');
    expect(exp.map((c) => c.getAttribute('data-driver'))).toEqual(['D12']);
    expect(exp[0].getAttribute('class')).toMatch(/consistency-card--wide/);
    expect(exp[0].style.gridColumn).toBe('1 / -1');
    // a 155 px card and one 20 px line (and the 4 px gap) in 180 px
    expect(v.cards().length).toBeLessThanOrEqual(2);
    expect(text(exp[0])).toMatch(/Residual σ\s*±\d\.\d{3}s/);
    expect(text(exp[0])).toMatch(/Deg: [+−-]?\d\.\d{3} s\/lap/);
    // never taller than the area (its details scroll beyond it)
    expect(exp[0].style.maxHeight).toBe('180px');
    await v.unmount();
  });

  it('Expand all: every card expanded, paged one or more per page, never cut', async () => {
    const v = await mount();
    await resize(v.area(), 1209, 330);
    const all = [...v.host.querySelectorAll('.consistency-panel__bulk-btn')].find((b) => text(b) === 'Expand all');
    await act(async () => { dom.mouse(all, 'click'); });
    // 155 px cards: two per 330 px page (155 + 4 + 155)
    expect(v.cards()).toHaveLength(2);
    expect(v.pagerText()).toBe('1–2/20');
    await v.unmount();
  });

  // Phase 9c r2 (F4): the pager kept its index, or jumped back to the focus
  // page, when expanding a card moved the pages: the card just expanded left
  // the screen
  it('expanding a card on a later page keeps that card on screen (no focus driver)', async () => {
    const v = await mount();
    await resize(v.area(), 593, 180);
    await v.click('Next drivers');
    await v.click('Next drivers');
    expect(v.pagerText()).toBe('15–20/20');
    const target = codes(v)[2];
    await v.click(`Expand ${target}`);
    expect(codes(v)).toContain(target);
    expect(v.cards().find((c) => c.getAttribute('data-driver') === target).getAttribute('data-expanded')).toBe('true');
    // collapsing it again keeps it on screen too
    await v.click(`Collapse ${target}`);
    expect(codes(v)).toContain(target);
    await v.unmount();
  });

  it('with a focus driver on page 1, a card expanded on a page reached by hand stays on screen', async () => {
    useF1Store.setState({ focusDriver: 'D02' });
    const v = await mount();
    await resize(v.area(), 593, 180);
    expect(codes(v)).toContain('D02');
    await v.click('Next drivers');
    await v.click('Next drivers');
    const target = codes(v)[2];
    expect(target).not.toBe('D02');
    await v.click(`Expand ${target}`);
    expect(codes(v)).toContain(target);
    // a new focus driver still opens on his own page
    await act(async () => { useF1Store.setState({ focusDriver: 'D07' }); });
    expect(codes(v)).toContain('D07');
    await v.unmount();
  });

  it('Expand all with a focus driver: Next always moves forward, measured heights never bounce back to the focus page', async () => {
    // 1920 x 1080 Overview: cards measured at 170 px against the 160 px estimate,
    // so each first visit to a page lays the pages again
    EXPANDED_H = 170;
    useF1Store.setState({ focusDriver: 'D02' });
    const v = await mount();
    await resize(v.area(), 778, 325);
    const all = [...v.host.querySelectorAll('.consistency-panel__bulk-btn')].find((b) => text(b) === 'Expand all');
    await act(async () => { dom.mouse(all, 'click'); });
    // Expand all keeps the focus driver's card on screen
    expect(codes(v)).toContain('D02');
    const first = () => Number(v.pagerText().split('–')[0]);
    const enabled = (label) => {
      const b = [...v.host.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === label);
      return !!b && !b.hasAttribute('disabled');
    };
    const seen = new Set(codes(v));
    let last = first();
    for (let i = 0; i < 30 && enabled('Next drivers'); i++) {
      await v.click('Next drivers');
      expect(first()).toBeGreaterThan(last);
      last = first();
      codes(v).forEach((c) => seen.add(c));
    }
    // the last page ends at the last card
    expect(v.pagerText()).toMatch(/–20\/20$/);
    for (let i = 0; i < 30 && enabled('Previous drivers'); i++) {
      await v.click('Previous drivers');
      expect(first()).toBeLessThan(last);
      last = first();
      codes(v).forEach((c) => seen.add(c));
    }
    expect(last).toBe(1);
    // every card measured now: one walk forward shows each driver once
    const walk = [...codes(v)];
    for (let i = 0; i < 30 && enabled('Next drivers'); i++) {
      await v.click('Next drivers');
      walk.push(...codes(v));
    }
    expect(walk).toHaveLength(20);
    expect(new Set([...walk, ...seen]).size).toBe(20);
    EXPANDED_H = 155;
    await v.unmount();
  });

  it('a context card keeps full opacity (its text turns muted in CSS), the low-data look is no opacity either', async () => {
    useF1Store.setState({ selectedDrivers: ['D01'] });
    const v = await mount();
    await resize(v.area(), 1209, 181);
    const d02 = v.cards().find((c) => c.getAttribute('data-driver') === 'D02');
    expect(d02.getAttribute('class')).toMatch(/consistency-card--context/);
    expect(d02.style.opacity || '').toBe('');
    await v.unmount();
  });
});

describe('CSS: the cards never scroll', () => {
  const rules = parseCss(fs.readFileSync(path.join(SRC, 'styles/dashboard.css'), 'utf8'))
    .filter((r) => /consistency-(panel|card)/.test(r.selector));
  it('no overflow auto / scroll on a rule of the panel but the expanded card\'s details', () => {
    for (const r of rules) {
      // the one exception (docs/SCROLL_JUSTIFICATIONS.md "Consistency expanded
      // card"): the details of an expanded card capped at the area
      if (r.selector === '.consistency-card__details') continue;
      for (const d of r.decls) if (/^overflow/.test(d.prop)) expect(`${r.selector} { ${d.prop}: ${d.value} }`).not.toMatch(/auto|scroll/);
    }
    const grid = rules.find((r) => r.selector === '.consistency-panel__grid');
    expect(grid.decls.find((d) => d.prop === 'overflow').value).toBe('hidden');
  });

  it('an expanded card is capped at the area; its details scroll only beyond it (a floating overlay near its minimum)', () => {
    const details = rules.find((r) => r.selector === '.consistency-card__details');
    const decl = (prop) => details.decls.find((d) => d.prop === prop)?.value;
    expect(decl('overflow-y')).toBe('auto');
    expect(decl('min-height')).toBe('0');
    const header = rules.find((r) => r.selector === '.consistency-card__header');
    expect(header.decls.find((d) => d.prop === 'flex-shrink')?.value).toBe('0');
  });
});

// The collapsed line's parts (team bar, code in Bold, σ, the badge in Bold,
// CV, the chevron's room, padding, border) fit CONSISTENCY_CARD_EM data-type
// ems at the real font widths (JetBrains Mono: 0.6 em a character)
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

describe.skipIf(!haveFont)('the collapsed line fits its card (real font widths)', () => {
  const bold = haveFont ? faceWidths(path.join(FONTS, 'Formula1-Bold-4.ttf')) : null;
  const mono = (t, s) => [...t].length * 0.6 * s;
  // data / label / sm sizes at 1536 x 750, 1366 x 768 (floors) and 1920 x 1080 (tokens.css)
  for (const [vp, data, label, sm] of [['1536x750', 11, 10, 11.44], ['1366x768', 11.08, 10.08, 11], ['1920x1080', 12.41, 11.41, 13]]) {
    it(vp, () => {
      const badge = bold('INCONSISTENT', label) + 12 * 0.03 * label + 12 + 2;
      const line = 4 + bold('VER', sm) + mono('±0.123s', data) + badge + mono('CV: 0.45%', data) + 4 * 6 + 24 + 16 + 2;
      const lowData = line - badge + mono('LOW DATA', label) + 0.08 * label * 8 + 14;
      const card = Math.ceil(CONSISTENCY_CARD_EM * data);
      console.log(`${vp}: collapsed line ${line.toFixed(1)} px (LOW DATA ${lowData.toFixed(1)}) in >= ${card} px`);
      expect(line).toBeLessThanOrEqual(card);
      expect(lowData).toBeLessThanOrEqual(card);
    });
  }
});
