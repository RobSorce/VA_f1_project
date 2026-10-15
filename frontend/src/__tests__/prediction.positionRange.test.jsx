// V6 / V1 / V5, Race Prediction (components/visualizations/RacePredictionPanel.jsx):
//  - the Monte Carlo finishing positions are a D3 chart
//    (utils/views/positionRangeChart.js) on a position axis drawn by
//    d3-axis, beside a table of the P label, places gained / lost, driver,
//    current position and podium share, one row per driver at one height;
//  - every position with at least one run has its bar (no 3 % cut that came
//    and went with the recomputes), the range line is the P5-P95, the diamond
//    the P label and the hollow triangle the current position; a D3 legend
//    names every mark;
//  - places gained / lost in the diverging pair (blue / orange) with ▲ / ▼,
//    never green / red; no colour literal in the panel;
//  - the rows fit the panel, paged when they do not (no scroll).
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
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { DIVERGING, CHART_FONT } = await import('../utils/colors.js');
const { modePosition, positionChange, orderedProjections, PODIUM_BADGE_PCT } = await import('../utils/simulationClient.js');
const {
  positionShares, positionTicks, POSITION_AXIS_H,
} = await import('../utils/views/positionRangeChart.js');
const { fitRows, pageOf } = await import('../utils/views/chartBox.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { default: RacePredictionPanel } = await import('../components/visualizations/RacePredictionPanel.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/RacePredictionPanel.jsx');
const INITIAL = useF1Store.getState();
const HAVE = hasCachedSession(2024, 16);
const monza = HAVE ? loadCachedSession(2024, 16) : null;
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

function monzaAtLap(currentLap) {
  const lapTimes = monza.lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber));
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  const raceSituationData = extractRaceSituationFeatures({
    lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
  });
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    sessionData: monza,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    maxLap,
    totalRaceLaps: maxLap,
    currentLap,
    totalFrames: 0,
    currentTime: 0,
    raceSituationData,
    selectedDrivers: ['LEC'],
  });
}

async function mount(height = 760, width = 520) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(RacePredictionPanel)); });
  return {
    host,
    svg: () => host.querySelector('svg.mcr-svg'),
    textRows: () => [...host.querySelectorAll('.mcr-row-text')],
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('position-range helpers (pure)', () => {
  it('shares from the run counts (unrounded), else the percentages; axis ticks', () => {
    expect(positionShares({ posCount: { 2: 30, 1: 10 }, posDistribution: { 1: 99 } })).toEqual([[1, 0.25], [2, 0.75]]);
    expect(positionShares({ posDistribution: { 3: 50, 4: 50 } })).toEqual([[3, 0.5], [4, 0.5]]);
    expect(positionShares({})).toEqual([]);
    expect(positionTicks(20)).toEqual([1, 3, 5, 10, 15, 20]);
    expect(positionTicks(2)).toEqual([1, 2]);
  });

  it('rows fit the height or are paged', () => {
    expect(fitRows(0, 20, { rowMin: 16, rowMax: 26, rowDefault: 20 })).toEqual({ rowH: 20, perPage: 20, paged: false });
    expect(fitRows(400, 20, { rowMin: 16, rowMax: 26, pagerH: 22 })).toEqual({ rowH: 20, perPage: 20, paged: false });
    expect(fitRows(200, 20, { rowMin: 16, rowMax: 26, pagerH: 22 })).toEqual({ rowH: 16, perPage: 11, paged: true });
    expect(pageOf([1, 2, 3, 4, 5], 9, 2)).toMatchObject({ rows: [5], page: 2, pages: 3, first: 5, last: 5 });
  });
});

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('no colour literal, no fixed pixel font size, no scroll, no percentage div bars, a D3 chart', () => {
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/left:\s*`\$\{/);
    expect(src).toMatch(/drawPositionRanges\(/);
    expect(src).toMatch(/drawLegend\(/);
  });
});

describe.skipIf(!HAVE)('the D3 position-range chart, Monza 2024 lap 30', () => {
  it('one chart row per table row, the marks are the projection\'s, axis and legend drawn by D3', async () => {
    monzaAtLap(30);
    const proj = useF1Store.getState().raceProjection;
    const n = useF1Store.getState().raceSituationData.driverAbbrs.length;
    const rowsN = proj.projections.length;
    expect(rowsN).toBeGreaterThan(15);
    const view = await mount();
    const svg = view.svg();
    expect(svg).toBeTruthy();
    // axis: P ticks at the token size
    const ticks = [...svg.querySelectorAll('g.mcr-axis .tick text')].map(text);
    expect(ticks).toEqual(positionTicks(n).map((k) => `P${k}`));
    expect(svg.querySelector('g.mcr-axis').style['font-size']).toBe(CHART_FONT.data);
    // podium / points limits
    expect([...svg.querySelectorAll('line.mcr-limit')].map((l) => Number(l.getAttribute('data-after')))).toEqual([3, 10]);
    // legend (D3) names every mark
    const legend = [...view.host.querySelectorAll('svg.mcr-legend-svg .chart-legend__item')].map(text);
    expect(legend).toEqual(['share of runs per position', 'P5–P95', 'P label (median)', 'now', 'podium | points limit', '▲ places gained', '▼ places lost',
      `gold P / pod: a podium (in >= ${PODIUM_BADGE_PCT} % of runs)`]);

    // rows: the table and the chart in the same order, at the same height
    const ordered = orderedProjections(proj);
    const textRows = view.textRows();
    const chartRows = [...svg.querySelectorAll('g.mcr-row')];
    expect(textRows.length).toBe(rowsN);
    expect(chartRows.map((g) => g.getAttribute('data-key'))).toEqual(ordered.map((p) => p.driver));
    expect(textRows.map((r) => text(r.querySelectorAll('[role="cell"]')[2]))).toEqual(ordered.map((p) => p.driver));
    const rowH = Number.parseFloat(textRows[0].style.height);
    chartRows.forEach((g, i) => {
      expect(g.getAttribute('transform')).toBe(`translate(0,${POSITION_AXIS_H + i * rowH})`);
    });
    for (const [i, p] of ordered.entries()) {
      const g = chartRows[i];
      const shares = positionShares(p);
      const bars = [...g.querySelectorAll('rect.mcr-bar')];
      // every position with a run has a bar (no cut), shares sum to 1
      expect(bars.map((b) => Number(b.getAttribute('data-pos')))).toEqual(shares.map((s) => s[0]));
      expect(bars.reduce((s, b) => s + Number(b.getAttribute('data-share')), 0)).toBeCloseTo(1, 9);
      expect(Number(g.querySelector('path.mcr-shown').getAttribute('data-pos'))).toBe(modePosition(proj, p));
      expect(Number(g.querySelector('path.mcr-now').getAttribute('data-pos'))).toBe(p.currentPos);
      expect(g.querySelector('path.mcr-now').getAttribute('fill')).toBe('none');
      expect(g.querySelector('line.mcr-range')).toBeTruthy();
      // the text row: P label, arrow in the diverging pair with its glyph, now, podium
      const cells = [...textRows[i].querySelectorAll('[role="cell"]')].map(text);
      expect(cells[0]).toBe(`P${modePosition(proj, p)}`);
      const change = positionChange(proj, p) ?? 0;
      const arrow = textRows[i].querySelectorAll('[role="cell"]')[1];
      if (change > 0) {
        expect(cells[1]).toBe(`▲${change}`);
        expect(arrow.style.color).toBe(DIVERGING.better);
      } else if (change < 0) {
        expect(cells[1]).toBe(`▼${-change}`);
        expect(arrow.style.color).toBe(DIVERGING.worse);
      }
      expect(cells[3]).toBe(`now P${p.currentPos}`);
      expect(cells[4]).toBe(`${p.podiumProb}% pod`);
    }
    expect(ordered.some((p) => (positionChange(proj, p) ?? 0) !== 0)).toBe(true);
    // the x of a mark: the shown position and the range ends on the same scale as the ticks
    const tickX = (k) => {
      const t = [...svg.querySelectorAll('g.mcr-axis .tick')].find((el) => text(el) === `P${k}`);
      // d3-axis draws its ticks 0.5 px off the scale for crisp lines (no devicePixelRatio here)
      return Number(/translate\(([-\d.]+)/.exec(t.getAttribute('transform'))[1]) - 0.5;
    };
    const x1 = tickX(1);
    const xN = tickX(n);
    const xOf = (pos) => x1 + ((pos - 1) * (xN - x1)) / (n - 1);
    for (const [i, p] of ordered.entries()) {
      const line = chartRows[i].querySelector('line.mcr-range');
      expect(Number(line.getAttribute('x1'))).toBeCloseTo(xOf(p.posRange[0]), 6);
      expect(Number(line.getAttribute('x2'))).toBeCloseTo(xOf(p.posRange[1]), 6);
    }
    // no scroll container anywhere in the panel
    const all = [view.host, ...view.host.querySelectorAll('*')];
    expect(all.filter((el) => /auto|scroll/.test(`${el.style.overflow || ''}${el.style.overflowY || ''}${el.style['overflow-y'] || ''}`))).toEqual([]);
    await view.unmount();
  });

  it('a short panel pages the rows instead of scrolling; the pager walks every row', async () => {
    monzaAtLap(30);
    const proj = useF1Store.getState().raceProjection;
    const ordered = orderedProjections(proj).map((p) => p.driver);
    const view = await mount(220);
    const pager = () => view.host.querySelector('.mcr-pager');
    expect(pager()).toBeTruthy();
    const seen = [];
    for (let guard = 0; guard < 10; guard++) {
      const rows = view.textRows().map((r) => text(r.querySelectorAll('[role="cell"]')[2]));
      const chart = [...view.svg().querySelectorAll('g.mcr-row')].map((g) => g.getAttribute('data-key'));
      expect(chart).toEqual(rows);
      expect(rows.length).toBeLessThan(ordered.length);
      seen.push(...rows);
      const next = [...pager().querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Next rows');
      if (next.hasAttribute('disabled')) break;
      await act(async () => { dom.mouse(next, 'click'); });
    }
    expect(seen).toEqual(ordered);
    expect(text(pager())).toContain(`rows ${seen.length - view.textRows().length + 1}–${ordered.length} of ${ordered.length}`);
    await view.unmount();
  });
});
