// The Sectors panel's "Best" tab is a D3 SVG chart per
// sector (components/visualizations/SectorsBestChart.jsx, view model
// utils/views/sectorsBestChart.js): a band scale of the drivers in ranking
// order, a linear scale of the gap to the session best with its axis, the
// value of every bar written next to it, the driver in his team colour
// (badge text by contrastText). Before Phase 9c the tab drew HTML div bars of
// "closeness to the best" with no scale and no axis.
//
// Also: the chart fits its column (rows 18 px at the least, else pages with a
// visible "P1–P4 of 8" pager, D1), follows a resize (D4) and keeps every
// label at the floors on screen.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  return mocked;
});
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
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const {
  getDriverColor, contrastText, STATUS_COLORS, STATUS_GLYPHS,
} = await import('../utils/colors.js');
const { sectorsPanelData } = await import('../utils/views/sectorsPanel.js');
const { installResizeObserverMock, syntheticSession } = await import('./helpers/chartFixtures.js');
const { screenTexts, underFloor } = await import('./helpers/screenFont.js');
const { default: SectorsPanel } = await import('../components/visualizations/SectorsPanel.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const VP = { W: 1536, H: 750 };
const { bestRankings, bestSessionBests } = sectorsPanelData(SESSION.lap_times, Infinity);

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

let view = null;
async function mountBest(width, height) {
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: SESSION,
    sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
    maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true,
    totalFrames: 0, currentTime: 0, selectedDrivers: [], highlightedDriver: null,
  });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(SectorsPanel)); });
  const tab = host.querySelectorAll('button').find((b) => text(b) === 'Best');
  await act(async () => { dom.mouse(tab, 'click', { bubbles: true }); });
  await settle();
  view = { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
  return view;
}

const columns = (host) => host.querySelectorAll('.sectors-panel__column');
const chartOf = (col) => col.querySelector('svg.sectors-best-chart');
const num = (el, a) => Number(el.getAttribute(a));

describe('the Best tab is a D3 chart of the gap to the session best, per sector', () => {
  afterAll(async () => {
    if (view) await view.unmount();
    useF1Store.setState({ ...INITIAL });
  });

  it('one SVG chart per sector, every driver in ranking order (band scale)', async () => {
    const { host } = await mountBest(960, 560);
    const cols = columns(host);
    expect(cols.length).toBe(3);
    cols.forEach((col, i) => {
      const svg = chartOf(col);
      expect(svg, `sector ${i + 1}: svg chart`).toBeTruthy();
      const rows = svg.querySelectorAll('.sectors-best-row');
      const ranking = bestRankings[String(i + 1)];
      expect(rows.map((r) => r.getAttribute('data-driver'))).toEqual(ranking.map((e) => e.driver));
      // top to bottom in rank order, one band each
      const ys = rows.map((r) => dom.parseTransform(r.getAttribute('transform')).f);
      for (let k = 1; k < ys.length; k++) expect(ys[k]).toBeGreaterThan(ys[k - 1]);
    });
  });

  it('bars: length linear in the gap to the best, an axis in seconds, the value written next to each bar', () => {
    const cols = columns(view.host);
    cols.forEach((col, i) => {
      const svg = chartOf(col);
      const ranking = bestRankings[String(i + 1)];
      const best = bestSessionBests[String(i + 1)];
      const bars = svg.querySelectorAll('.sectors-best-bar');
      expect(bars.length).toBe(ranking.length - 1); // the best has no gap
      const perSecond = bars.map((b) => {
        const e = ranking.find((r) => r.driver === b.getAttribute('data-driver'));
        return num(b, 'width') / (e.best - best);
      });
      for (const k of perSecond) expect(k).toBeCloseTo(perSecond[0], 6);
      // bars start at the zero of the scale
      const x0 = num(bars[0], 'x');
      for (const b of bars) expect(num(b, 'x')).toBe(x0);
      // the axis: ticks from 0, signed, the unit on the last one
      const ticks = svg.querySelectorAll('.sectors-best-axis .tick text').map(text);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks[0]).toBe('0');
      expect(ticks.slice(1, -1).every((t) => /^\+\d+\.\d+$/.test(t))).toBe(true);
      expect(ticks.at(-1)).toMatch(/^\+\d+\.\d+ s$/);
      // value labels: "+0.123" for every driver after the best, the best's time with ◆
      const values = svg.querySelectorAll('.sectors-best-value').map(text);
      expect(values[0]).toBe(`${STATUS_GLYPHS.overallBest} ${best.toFixed(3)}`);
      ranking.slice(1).forEach((e, k) => {
        expect(values[k + 1]).toBe(`+${(e.best - best).toFixed(3)}`);
      });
    });
  });

  it('the driver in his team colour, the code in contrastText; the best marked ◆ in the session-best colour', () => {
    const svg = chartOf(columns(view.host)[0]);
    for (const row of svg.querySelectorAll('.sectors-best-row')) {
      const d = row.getAttribute('data-driver');
      const badge = row.querySelector('.sectors-best-badge');
      const code = row.querySelector('.sectors-best-code');
      expect(badge.getAttribute('fill')).toBe(getDriverColor(d));
      expect(code.getAttribute('fill')).toBe(contrastText(getDriverColor(d)));
      expect(text(code)).toBe(d);
    }
    const bestValue = svg.querySelector('.sectors-best-value');
    expect(bestValue.getAttribute('fill')).toBe(STATUS_COLORS.overallBest);
  });

  it('every label at the floors on screen, before and after a resize (D4)', async () => {
    for (const col of columns(view.host)) {
      const svg = chartOf(col);
      expect(screenTexts(svg, VP).length).toBeGreaterThan(10);
      expect(underFloor(svg, VP)).toEqual([]);
    }
    const svg = chartOf(columns(view.host)[1]);
    const before = svg.getAttribute('viewBox');
    dom.setRect(svg.parentElement, { left: 0, top: 0, width: 210, height: 300 });
    await act(async () => { ro.notify(svg.parentElement, 210, 300); });
    await settle();
    const svg2 = chartOf(columns(view.host)[1]);
    expect(svg2.getAttribute('viewBox')).toBe('0 0 210 300');
    expect(svg2.getAttribute('viewBox')).not.toBe(before);
    expect(underFloor(svg2, VP)).toEqual([]);
  });

  it('columns too low for every row at 18 px: the panel pages the ranks (D1), each chart draws its page', async () => {
    // the panel fits the rows to the first column's body (SectorsPanel.jsx,
    // sectorsRowFit); every chart observes its own column (useChartBox)
    const sizeBodies = async (h) => {
      const bodies = view.host.querySelectorAll('.sectors-panel__col-body');
      for (const b of bodies) dom.setRect(b, { left: 0, top: 0, width: 240, height: h });
      await act(async () => {
        for (const b of bodies) {
          ro.notify(b, 240, h);
          ro.notify(b.querySelector('.sectors-best'), 240, h);
        }
      });
      await settle();
    };
    await sizeBodies(120);
    // as in the browser, the pager line takes its 22 px from the bodies
    await sizeBodies(120 - 22);
    const pager = view.host.querySelector('.sectors-panel__pager');
    expect(pager, 'pager').toBeTruthy();
    expect(text(pager)).toMatch(/P1–P\d+ of 8/);
    const col = columns(view.host)[2];
    const rows = () => chartOf(col).querySelectorAll('.sectors-best-row').map((r) => r.getAttribute('data-driver'));
    const seen = [...rows()];
    expect(seen.length).toBeLessThan(8);
    // px per second of the sector's gap scale on its first page
    const best = bestSessionBests['3'];
    const perSecond = (b) => num(b, 'width') / (bestRankings['3'].find((r) => r.driver === b.getAttribute('data-driver')).best - best);
    const scale1 = perSecond(chartOf(col).querySelectorAll('.sectors-best-bar')[0]);
    // rows never under 18 px; the values are written whatever the room
    const band = chartOf(col).querySelector('.sectors-best-hit');
    expect(num(band, 'height')).toBeGreaterThanOrEqual(18);
    expect(chartOf(col).querySelectorAll('.sectors-best-value').length).toBe(seen.length);
    const next = () => view.host.querySelectorAll('.sectors-panel__pager button')
      .find((b) => b.getAttribute('aria-label') === 'Next positions');
    for (let guard = 0; guard < 8 && seen.length < 8; guard++) {
      await act(async () => { dom.mouse(next(), 'click', { bubbles: true }); });
      await settle();
      seen.push(...rows());
    }
    expect(seen).toEqual(bestRankings['3'].map((e) => e.driver));
    // one gap scale for every page of the sector: px per second as on page 1
    for (const b of chartOf(col).querySelectorAll('.sectors-best-bar')) expect(perSecond(b)).toBeCloseTo(scale1, 6);
  });

  it('the legend of the tab names the bar, its scale and the best', () => {
    const legend = text(view.host.querySelector('.sectors-panel__legend'));
    expect(legend).toContain('Session best');
    expect(legend).toContain('gap to the session best');
    expect(legend).not.toContain('closeness');
  });
});
