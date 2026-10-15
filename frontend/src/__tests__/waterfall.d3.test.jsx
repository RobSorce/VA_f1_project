// V6 / V1 / V5, Sector Delta (components/visualizations/SectorDeltaWaterfall.jsx):
//  - the chart is drawn by D3 (utils/views/sectorDeltaWaterfallChart.js) into
//    an SVG with a signed y axis, a lap x axis, a zero line and a legend;
//  - a real waterfall: in each lap S1 starts at 0, each next sector where the
//    previous one ended, the lap total at the sum (the geometry of
//    utils/views/sectorDeltaWaterfall.js read back from the drawn bars);
//  - faster / slower in the diverging pair of utils/colors.js (blue / orange),
//    never green / red, and always with the direction (bar up or down, ▲ / ▼
//    in the legend and the AVG line, the sign of every value);
//  - no scroll: the chart shows the most recent laps its width holds;
//  - text at the CSS font tokens (>= 11 px for ticks and labels);
//  - causal: changing everything not known at the clock leaves the drawing
//    unchanged (Monza 2024, lap mode, skipped without the cache).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installMiniDom } from './helpers/miniDom.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

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
// <select> / <option> as react-dom reads them (the mini DOM has no form controls)
const El = dom.window.Element;
const accessor = (name, get) => {
  if (!(name in El.prototype)) {
    Object.defineProperty(El.prototype, name, {
      get, set(v) { this[`_${name}`] = v; }, configurable: true,
    });
  }
};
accessor('options', function options() { return this.localName === 'select' ? this.querySelectorAll('option') : undefined; });
accessor('value', function value() { return this._value ?? this.getAttribute('value') ?? ''; });
accessor('selected', function selected() { return !!this._selected; });
accessor('defaultSelected', function defaultSelected() { return !!this._defaultSelected; });
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { DIVERGING, CHART_FONT, FONT_FLOOR_PX } = await import('../utils/colors.js');
const {
  sectorDeltaRows, waterfallSteps, waterfallLaps, waterfallLapsThatFit, waterfallDomain, sectorMeans,
  WATERFALL_MIN_LAP_PX, fmtDelta,
} = await import('../utils/views/sectorDeltaWaterfall.js');
const { WATERFALL_MARGIN } = await import('../utils/views/sectorDeltaWaterfallChart.js');
const { resolveSessionNow, computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { default: SectorDeltaWaterfall } = await import('../components/visualizations/SectorDeltaWaterfall.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/SectorDeltaWaterfall.jsx');
const INITIAL = useF1Store.getState();
const HAVE = hasCachedSession(2024, 16);
const monza = HAVE ? loadCachedSession(2024, 16) : null;

/** Markup of a mini-DOM subtree (tags, attributes, inline styles, text). */
function serialize(n) {
  if (n.nodeType === 3) return n.data;
  const attrs = n.attributes.map((a) => `${a.name}="${a.value}"`).join(' ');
  const st = Object.keys(n.style).filter((k) => typeof n.style[k] === 'string').map((k) => `${k}:${n.style[k]}`).join(';');
  return `<${n.localName} ${attrs} style="${st}">${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

async function mount(width = 520, height = 300) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(SectorDeltaWaterfall)); });
  return {
    host,
    svg: () => host.querySelector('svg.sdw-svg'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

function atLap(lapTimes, currentLap, extra = {}) {
  useF1Store.setState({
    ...INITIAL,
    sessionData: { ...monza, lap_times: lapTimes },
    sessionType: 'R',
    sessionTimeOffset: computeSessionTimeOffset(monza.lap_times),
    maxLap: 53,
    totalRaceLaps: 53,
    currentLap,
    totalFrames: 0,
    currentTime: 0,
    focusDriver: 'LEC',
    comparisonDriver: 'PIA',
    ...extra,
  });
}

describe('waterfall geometry (pure)', () => {
  it('each sector starts where the previous one ended; the last step ends at the lap total', () => {
    const { steps, total } = waterfallSteps({ sectors: [0.2, -0.5, 0.1] });
    expect(steps.map((s) => [s.from, s.to])).toEqual([[0, 0.2], [0.2, -0.3], [-0.3, -0.2]]);
    expect(total).toBeCloseTo(-0.2, 9);
    // a missing sector: zero length, flagged, no total
    const gap = waterfallSteps({ sectors: [0.2, null, 0.1] });
    expect(gap.steps[1]).toMatchObject({ missing: true, from: 0.2, to: 0.2 });
    expect(gap.steps[2]).toMatchObject({ from: 0.2, to: 0.3 });
    expect(gap.total).toBeNull();
  });

  it('laps that fit the width (most recent kept, drawn oldest first), domain and means', () => {
    const rows = [5, 4, 3, 2, 1].map((lap) => ({ lap, sectors: [0.1, 0.1, -0.05] }));
    expect(waterfallLapsThatFit(0, 5)).toBe(5);
    expect(waterfallLapsThatFit(3 * WATERFALL_MIN_LAP_PX + 1, 5)).toBe(3);
    expect(waterfallLapsThatFit(10, 5)).toBe(1);
    expect(waterfallLaps(rows, 3).map((r) => r.lap)).toEqual([3, 4, 5]);
    expect(waterfallDomain([{ sectors: [0.01, 0.01, 0.01] }])).toEqual([-0.1, 0.1]);
    expect(waterfallDomain([{ sectors: [0.3, -0.5, 0.1] }])).toEqual([-0.2, 0.3]);
    expect(sectorMeans([{ sectors: [0.1, null, 0.2] }, { sectors: [0.3, null, null] }])).toEqual([0.2, null, 0.2]);
    expect(fmtDelta(-0.0451)).toBe('−0.045');
    expect(fmtDelta(0.2)).toBe('+0.200');
  });
});

describe('the component source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('draws with D3 (no percentage-positioned div bars), no scroll, no colour literal, no fixed small font', () => {
    expect(src).toMatch(/drawSectorDeltaWaterfall\(/);
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/width:\s*`\$\{[^}]*\}%`/);
  });
});

describe.skipIf(!HAVE)('the D3 waterfall, Monza 2024 (lap mode)', () => {
  it('axes, zero line and legend; every bar is a step of the waterfall in the diverging pair', async () => {
    atLap(monza.lap_times, 20);
    const view = await mount(520, 300);
    const svg = view.svg();
    expect(svg).toBeTruthy();
    expect(Number(svg.getAttribute('width'))).toBe(520);
    // axes drawn by d3-axis, at the font token
    const yTicks = [...svg.querySelectorAll('g.sdw-y .tick text')].map(text);
    expect(yTicks.length).toBeGreaterThanOrEqual(2);
    for (const t of yTicks) expect(t).toMatch(/^([+−]\d+\.\d{2}|0\.00)$/);
    const xTicks = [...svg.querySelectorAll('g.sdw-x .tick text')].map(text);
    expect(xTicks.length).toBeGreaterThan(0);
    for (const t of xTicks) expect(t).toMatch(/^L\d+$/);
    for (const g of svg.querySelectorAll('g.sdw-axis')) expect(g.style['font-size']).toBe(CHART_FONT.data);
    expect(CHART_FONT.data).toContain(`${FONT_FLOOR_PX.data}px`);
    expect(text(svg.querySelector('text.sdw-y-title'))).toBe('LEC − PIA (s)');
    expect(svg.querySelector('line.sdw-zero')).toBeTruthy();
    // legend: both directions with their glyph and sign, the total, the order
    const legend = [...svg.querySelectorAll('g.sdw-legend .chart-legend__item')];
    expect(legend.map((g) => text(g))).toEqual([
      '▼ LEC faster (−)', '▲ LEC slower (+)', 'lap total', 'bars S1 → S2 → S3',
    ]);
    expect(legend[0].querySelector('path').getAttribute('fill')).toBe(DIVERGING.better);
    expect(legend[1].querySelector('path').getAttribute('fill')).toBe(DIVERGING.worse);
    for (const t of svg.querySelectorAll('g.sdw-legend text')) expect(t.style['font-size']).toBe(CHART_FONT.data);

    // the laps drawn: the most recent that fit, oldest left
    const now = resolveSessionNow({ currentLap: 20, lapTimes: monza.lap_times });
    const rows = sectorDeltaRows(monza.lap_times, 'LEC', 'PIA', now, 20);
    const fit = waterfallLapsThatFit(520 - WATERFALL_MARGIN.left - WATERFALL_MARGIN.right, rows.length);
    const laps = [...svg.querySelectorAll('g.sdw-lap')];
    expect(laps.map((g) => Number(g.getAttribute('data-lap')))).toEqual(waterfallLaps(rows, fit).map((r) => r.lap));
    expect(laps.length).toBeGreaterThan(3);
    for (const g of laps) {
      const lap = Number(g.getAttribute('data-lap'));
      const row = rows.find((r) => r.lap === lap);
      const bars = [...g.querySelectorAll('rect.sdw-step')];
      expect(bars.map((b) => Number(b.getAttribute('data-value')))).toEqual(row.sectors.filter((v) => v != null));
      for (const b of bars) {
        const v = Number(b.getAttribute('data-value'));
        expect(b.getAttribute('fill')).toBe(v < 0 ? DIVERGING.better : v > 0 ? DIVERGING.worse : DIVERGING.neutral);
        expect(b.getAttribute('class')).toContain(v < 0 ? 'faster' : v > 0 ? 'slower' : 'even');
      }
      // consecutive bars touch: the top/bottom of each next bar starts at the end of the previous
      const ends = bars.map((b) => [Number(b.getAttribute('y')), Number(b.getAttribute('y')) + Number(b.getAttribute('height'))]);
      for (let i = 1; i < bars.length; i++) {
        const prevV = Number(bars[i - 1].getAttribute('data-value'));
        const prevEnd = prevV >= 0 ? ends[i - 1][0] : ends[i - 1][1];
        const curV = Number(bars[i].getAttribute('data-value'));
        const curStart = curV >= 0 ? ends[i][1] : ends[i][0];
        // (a bar under 1 px is drawn 1 px tall: its end is not exact)
        const exact = (k) => Number(bars[k].getAttribute('height')) > 1;
        if (exact(i - 1) && exact(i)) expect(curStart).toBeCloseTo(prevEnd, 6);
      }
      const total = g.querySelector('line.sdw-total');
      if (row.cumulative == null) expect(total).toBeNull();
      else expect(Number(total.getAttribute('data-value'))).toBeCloseTo(row.cumulative, 9);
    }
    // no red / green anywhere in the drawing
    const fills = [...svg.querySelectorAll('rect')].map((r) => r.getAttribute('fill'));
    expect(new Set(fills).size).toBeLessThanOrEqual(3);
    for (const f of fills) expect([DIVERGING.better, DIVERGING.worse, DIVERGING.neutral]).toContain(f);
    // the AVG line: the mean of the laps drawn, signed, with its arrow
    const avg = text(view.host.querySelector('.sdw-avg'));
    const means = sectorMeans(waterfallLaps(rows, fit));
    expect(avg).toContain(`AVG ${laps.length} laps`);
    means.forEach((v, i) => expect(avg).toContain(`S${i + 1} ${v < 0 ? '▼' : v > 0 ? '▲' : ''}${fmtDelta(v)}`));
    await view.unmount();
  });

  it('a narrow panel shows fewer laps, never a scroll bar', async () => {
    atLap(monza.lap_times, 30);
    const wide = await mount(600, 280);
    const nWide = wide.svg().querySelectorAll('g.sdw-lap').length;
    await wide.unmount();
    const narrow = await mount(200, 280);
    const nNarrow = narrow.svg().querySelectorAll('g.sdw-lap').length;
    expect(nNarrow).toBe(waterfallLapsThatFit(200 - WATERFALL_MARGIN.left - WATERFALL_MARGIN.right, 20));
    expect(nNarrow).toBeLessThan(nWide);
    // the most recent lap both completed is always there
    const now = useF1Store.getState().getSessionNow();
    const latest = sectorDeltaRows(monza.lap_times, 'LEC', 'PIA', now, 20)[0].lap;
    const last = (v) => Number([...v.svg().querySelectorAll('g.sdw-lap')].pop().getAttribute('data-lap'));
    expect(last(narrow)).toBe(latest);
    await narrow.unmount();
  });

  it('causal: the drawing at lap 16 is the same when every lap after the clock changes', async () => {
    atLap(monza.lap_times, 16);
    const now = useF1Store.getState().getSessionNow();
    const a = await mount();
    const real = serialize(a.svg());
    await a.unmount();
    // every row not completed at the clock: other sector times
    const changed = monza.lap_times.map((r) => (Number.isFinite(r.Time) && r.Time > now
      ? { ...r, Sector1TimeSeconds: 20, Sector2TimeSeconds: 40, Sector3TimeSeconds: 25 }
      : r));
    atLap(changed, 16);
    const b = await mount();
    expect(serialize(b.svg())).toBe(real);
    await b.unmount();
  });
});
