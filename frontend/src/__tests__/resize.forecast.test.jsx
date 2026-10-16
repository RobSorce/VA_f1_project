// The Lap Times panel's forecast mini-chart
// (LapTimeChart.jsx ForecastChart, drawn whenever there is a focus driver)
// follows its box like every D3 view (utils/views/chartBox.js useChartBox):
// a pane resized (the browser moved from the 2048 px screen to the 1536 px
// one, a dock split dragged) lays it out again at the new width, so its
// labels stay at their CHART_FONT size on screen.
//
// It read its container's width once inside the
// draw effect, with no size in the effect's dependencies: drawn at 760 px,
// shrunk to 456 px, the viewBox stayed "0 0 760 90" and its 12 labels read
// 6.60 px on screen.
import { describe, it, expect, vi, afterAll } from 'vitest';
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
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock, syntheticSession } = await import('./helpers/chartFixtures.js');
const { screenTexts, underFloor } = await import('./helpers/screenFont.js');
const { default: LapTimeChart } = await import('../components/visualizations/LapTimeChart.jsx');

// Installed after d3: d3-timer keeps its own frame source for the transitions
const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
// Font tokens evaluated at Roberto's main screen (1920 x 1080 at 125 %)
const VP = { W: 1536, H: 750 };

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});
const forecastSvg = (host) => host.querySelectorAll('svg').find((s) => s.style.height === '90px');

describe('the Lap Times forecast mini-chart follows its box', () => {
  afterAll(() => { useF1Store.setState({ ...INITIAL }); });

  it('drawn at 760 px, then 456 px: the viewBox follows the box, no label under the floors', async () => {
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R',
      sessionData: SESSION, circuitInfo: SESSION.circuit_info, trackStatus: SESSION.track_status,
      sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
      maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true,
      totalFrames: 0, currentTime: 0, focusDriver: 'NOR', selectedDrivers: ['NOR'],
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 760, height: 520 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(LapTimeChart)); });
    await settle();

    const svg = forecastSvg(host);
    expect(svg, 'forecast svg').toBeTruthy();
    // the box the svg fills: 760 px wide, the svg 90 px high
    dom.setRect(svg.parentElement, { left: 0, top: 0, width: 760, height: 200 });
    dom.setRect(svg, { left: 0, top: 0, width: 760, height: 90 });
    await act(async () => { ro.notify(svg.parentElement, 760, 200); });
    await settle();
    expect(forecastSvg(host).getAttribute('viewBox')).toBe('0 0 760 90');
    expect(screenTexts(forecastSvg(host), VP).length).toBeGreaterThan(0);
    expect(underFloor(forecastSvg(host), VP)).toEqual([]);

    // the pane shrinks to 456 px
    dom.setRect(host, { left: 0, top: 0, width: 456, height: 520 });
    dom.setRect(svg.parentElement, { left: 0, top: 0, width: 456, height: 200 });
    dom.setRect(svg, { left: 0, top: 0, width: 456, height: 90 });
    await act(async () => { ro.notify(svg.parentElement, 456, 200); });
    await settle();
    const svg2 = forecastSvg(host);
    expect(svg2.getAttribute('viewBox')).toBe('0 0 456 90');
    const texts = screenTexts(svg2, VP);
    expect(texts.length).toBeGreaterThan(0);
    expect(underFloor(svg2, VP)).toEqual([]);
    await act(async () => { root.unmount(); });
    host.remove();
  }, 20000);
});
