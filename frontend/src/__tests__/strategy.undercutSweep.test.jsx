// V6 / V1 / V5, Undercut Calculator (components/visualizations/UndercutCalculator.jsx):
//  - the pit-lap sweep is a D3 column chart (utils/views/undercutSweepChart.js)
//    with a signed y axis, an in-lap x axis, a zero line and a legend;
//  - one column per row of undercutSweep, its height the row's gap; ahead /
//    behind in the diverging pair of utils/colors.js (blue / orange), never
//    green / red, named with ▲ / ▼ and the sign in the legend; the best row
//    carries the diamond and its value; "+n" marks the extra stops;
//  - no scroll: every column fits the width (the old row list scrolled);
//  - text at the CSS font tokens; no colour literal, no fixed small font.
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
const { DIVERGING, CHART_FONT } = await import('../utils/colors.js');
const { sweepDomain, signedSeconds, SWEEP_MIN_HALF_S } = await import('../utils/views/undercutSweepChart.js');
const { undercutSweep } = await import('../utils/undercut.js');
const { circleState } = await import('../utils/circleOfDoom.js');
const { estimatePitLoss } = await import('../utils/pitLoss.js');
const { extractRaceParams } = await import('../utils/raceSimulation.js');
const { completedStints } = await import('../utils/strategyViews.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { default: UndercutCalculator } = await import('../components/visualizations/UndercutCalculator.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/UndercutCalculator.jsx');
const INITIAL = useF1Store.getState();
const HAVE = hasCachedSession(2024, 16);
const monza = HAVE ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function monzaAtLap(currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    sessionData: monza,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    maxLap: MAX_LAP,
    totalRaceLaps: MAX_LAP,
    currentLap,
    totalFrames: 0,
    currentTime: 0,
    raceSituationData: extractRaceSituationFeatures({
      lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    }),
    ...extra,
  });
}

/** The sweep the panel computes at the store's clock (the same calls, same inputs). */
function sweepNow(focus, rival) {
  const s = useF1Store.getState();
  const lapTimes = monza.lap_times;
  const sessionNow = s.getSessionNow();
  const state = circleState(lapTimes, { sessionNow, dnfMap: s.dnfMap, isLiveMode: false });
  const pitLoss = estimatePitLoss(lapTimes, { sessionNow, sessionType: 'R' });
  const raceParams = extractRaceParams(lapTimes, completedStints(lapTimes, sessionNow, { running: false }),
    monza.track_status || [], s.currentLap, { sessionNow, sessionTimeOffset: s.sessionTimeOffset, sessionType: 'R', running: false });
  return undercutSweep(focus, rival, state, pitLoss, raceParams, { totalLaps: MAX_LAP });
}

async function mount(width = 520, height = 520) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(UndercutCalculator)); });
  return {
    host,
    svg: () => host.querySelector('svg.ucs-svg'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('sweep helpers (pure)', () => {
  it('domain holds 0 and every gap, at least the minimum half-range; signed values', () => {
    expect(sweepDomain([{ gap: 0.2 }])).toEqual([-SWEEP_MIN_HALF_S, SWEEP_MIN_HALF_S]);
    expect(sweepDomain([{ gap: -4.5 }, { gap: 2.25 }])).toEqual([-4.5, 2.25]);
    expect(signedSeconds(-2.714)).toBe('−2.71');
    expect(signedSeconds(1.2)).toBe('+1.20');
    expect(signedSeconds(0.001)).toBe('0.00');
  });
});

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('draws the sweep with D3; no scroll, no colour literal, no fixed pixel font, no percentage div bars', () => {
    expect(src).toMatch(/drawUndercutSweep\(/);
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba\(\s*\d/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/(width|left):\s*`\$\{[^}]*\}%`/);
  });
});

describe.skipIf(!HAVE)('the D3 sweep, Monza 2024 lap 30, NOR vs LEC', () => {
  it('one column per candidate in-lap at its gap, axes, zero line, legend; blue / orange only', async () => {
    monzaAtLap(30, { focusDriver: 'NOR', comparisonDriver: 'LEC' });
    const analysis = sweepNow('NOR', 'LEC');
    expect(analysis.available).toBe(true);
    const view = await mount();
    const svg = view.svg();
    expect(svg).toBeTruthy();
    expect(Number(svg.getAttribute('width'))).toBe(520);

    // one column per row, race order, the gap of the row
    const cols = [...svg.querySelectorAll('g.ucs-col')];
    expect(cols.map((g) => g.getAttribute('data-key'))).toEqual(analysis.rows.map((r) => String(r.inLap)));
    cols.forEach((g, i) => expect(Number(g.getAttribute('data-gap'))).toBeCloseTo(analysis.rows[i].gap, 9));
    for (const g of cols) {
      const gap = Number(g.getAttribute('data-gap'));
      const bar = g.querySelector('rect.ucs-bar');
      expect(bar.getAttribute('fill')).toBe(gap > 0 ? DIVERGING.better : gap < 0 ? DIVERGING.worse : DIVERGING.neutral);
    }
    // the best column: outlined, diamond, value
    const best = svg.querySelector('rect.ucs-bar--best');
    expect(best.parentNode.getAttribute('data-key')).toBe(String(analysis.best.inLap));
    expect(svg.querySelector('path.ucs-best')).toBeTruthy();
    const bestValue = [...svg.querySelectorAll('text.ucs-value')].find((t) => t.getAttribute('data-key') === String(analysis.best.inLap));
    expect(text(bestValue)).toBe(signedSeconds(analysis.best.gap, 1));
    // "+n" on every column charged extra stops
    const extra = analysis.rows.filter((r) => r.extraStops?.length);
    expect([...svg.querySelectorAll('text.ucs-extra')].map((t) => [t.getAttribute('data-key'), text(t)]))
      .toEqual(extra.map((r) => [String(r.inLap), `+${r.extraStops.length}`]));

    // axes by d3-axis at the font token, signed y ticks, laps on x (NOW first)
    for (const g of svg.querySelectorAll('g.ucs-axis')) expect(g.style['font-size']).toBe(CHART_FONT.data);
    const yTicks = [...svg.querySelectorAll('g.ucs-y .tick text')].map(text);
    expect(yTicks.length).toBeGreaterThanOrEqual(2);
    for (const t of yTicks) expect(t).toMatch(/^([+−]\d+(\.\d)?|0)$/);
    const xTicks = [...svg.querySelectorAll('g.ucs-x .tick text')].map(text);
    expect(xTicks[0]).toBe('NOW');
    for (const t of xTicks.slice(1)) expect(t).toMatch(/^L\d+$/);
    expect(svg.querySelector('line.ucs-zero')).toBeTruthy();
    // legend: the direction words, glyph and sign; the best and the +n
    const legend = [...svg.querySelectorAll('g.ucs-legend .chart-legend__item')];
    expect(legend.map(text)).toEqual(['▲ NOR ahead (+)', '▼ NOR behind (−)', 'best pit lap', '+n: extra stops charged']);
    expect(legend[0].querySelector('path').getAttribute('fill')).toBe(DIVERGING.better);
    expect(legend[1].querySelector('path').getAttribute('fill')).toBe(DIVERGING.worse);
    for (const t of svg.querySelectorAll('g.ucs-legend text')) expect(t.style['font-size']).toBe(CHART_FONT.data);

    // every fill of the plot is the diverging pair (or the text colour of the best diamond)
    const fills = new Set([...svg.querySelectorAll('rect.ucs-bar')].map((r) => r.getAttribute('fill')));
    for (const f of fills) expect([DIVERGING.better, DIVERGING.worse, DIVERGING.neutral]).toContain(f);

    // the verdict and the GAP NOW cell keep their words and sign
    const body = text(view.host);
    expect(body).toMatch(/(✓ AHEAD|✗ BEHIND) AFTER BOTH STOPS/);
    expect(body).toContain('GAP NOW');
    // the accessible list holds every column with its "+n"
    expect([...view.host.querySelectorAll('.ucs-rows li')].map((li) => li.getAttribute('data-inlap')))
      .toEqual(analysis.rows.map((r) => String(r.inLap)));
    // no scroll container in the panel
    const all = [view.host, ...view.host.querySelectorAll('*')];
    expect(all.filter((el) => /auto|scroll/.test(`${el.style.overflow || ''}${el.style.overflowY || ''}${el.style['overflow-y'] || ''}`))).toEqual([]);
    await view.unmount();
  });

  it('a narrow panel keeps every column (labels thinned), never a scroll bar', async () => {
    monzaAtLap(30, { focusDriver: 'NOR', comparisonDriver: 'LEC' });
    const n = sweepNow('NOR', 'LEC').rows.length;
    const view = await mount(260, 420);
    const svg = view.svg();
    expect(svg.querySelectorAll('g.ucs-col')).toHaveLength(n);
    expect(svg.querySelectorAll('g.ucs-x .tick').length).toBeLessThan(n);
    for (const r of svg.querySelectorAll('rect.ucs-bar')) expect(Number(r.getAttribute('width'))).toBeGreaterThan(0);
    await view.unmount();
  });
});
