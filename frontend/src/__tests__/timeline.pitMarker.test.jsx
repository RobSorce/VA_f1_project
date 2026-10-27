// A pit marker of the timing bar opens Tyre Degradation.
//
// The browser pass found that a click on a pit marker (the aggregated pit
// window of a lap, or a selected driver's stop) seeked the replay and then
// called openPanel('degradation'), which only set the store's activePanel:
// no view on screen reads it (the panel that did, DetailPanel, is not
// mounted), so the view never opened.
//
// The app opens a view with setActiveTab, as the dock, the command palette
// and the number keys do; that also closes a docked view already open, so
// showView opens Tyre Degradation, or brings it forward when it is open (a
// floating window to the front, a docked tab made its pane's active tab).
// The click also sets the lap range to the stint the stop ended, for the
// driver the view shows. Here: the store action in each mode, the stint on
// the demo race 2024 R16 (frontend/public/data), and the click on the
// timeline as drawn.
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { stopStintRange } = await import('../utils/stints.js');
const { installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const { default: TimelinePlayer } = await import('../components/ui/TimelinePlayer.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const MONZA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(HERE, '../../public/data/2024_16_R/session.json.gz'))));
const MAX_LAP = Math.max(...MONZA.lap_times.map((r) => r.LapNumber));
const store = () => useF1Store.getState();
const tabsOf = (node) => (!node ? [] : node.children ? [...tabsOf(node.children[0]), ...tabsOf(node.children[1])] : node.tabs);
const paneOf = (node, tab) => (!node ? null : node.children
  ? paneOf(node.children[0], tab) || paneOf(node.children[1], tab)
  : (node.tabs.includes(tab) ? node : null));

afterAll(() => { useF1Store.setState({ ...INITIAL }); });

describe('showView: open a view, or bring it forward, never close it', () => {
  it('no layout open: Tyre Degradation opens docked, as setActiveTab opens it', () => {
    useF1Store.setState({ ...INITIAL, activeTab: 'charts', dockedLayout: null, openOverlays: [] });
    store().showView('tiredeg');
    expect(store().dockedLayout).toEqual({ tabs: ['tiredeg'], activeTab: 'tiredeg' });
    expect(store().activeTab).toBe('charts');
  });

  it('the Pit Wall on screen: the analysis layout opens with it', () => {
    useF1Store.setState({ ...INITIAL, activeTab: 'pitwall', dockedLayout: null, openOverlays: [] });
    store().showView('tiredeg');
    expect(tabsOf(store().dockedLayout)).toEqual(['tiredeg']);
    expect(store().activeTab).toBe('charts');
  });

  it('docked behind another tab of its pane: made the active tab, the layout otherwise kept (setActiveTab would close it)', () => {
    const layout = {
      direction: 'vertical',
      ratio: 0.55,
      children: [
        { tabs: ['simulator'], activeTab: 'simulator' },
        { tabs: ['prediction', 'tiredeg'], activeTab: 'prediction' },
      ],
    };
    useF1Store.setState({ ...INITIAL, activeTab: 'charts', dockedLayout: layout, openOverlays: [] });
    store().showView('tiredeg');
    const after = store().dockedLayout;
    expect(tabsOf(after)).toEqual(['simulator', 'prediction', 'tiredeg']);
    expect(paneOf(after, 'tiredeg').activeTab).toBe('tiredeg');
    expect(paneOf(after, 'simulator').activeTab).toBe('simulator');
    expect(after.ratio).toBe(0.55);
    // twice: still open
    store().showView('tiredeg');
    expect(tabsOf(store().dockedLayout)).toContain('tiredeg');
  });

  it('a floating window: brought to the front, left open', () => {
    useF1Store.setState({
      ...INITIAL, activeTab: 'settings', dockedLayout: null, openOverlays: ['tiredeg', 'settings'],
    });
    store().showView('tiredeg');
    expect(store().openOverlays).toEqual(['tiredeg', 'settings']);
    expect(store().activeTab).toBe('tiredeg');
    expect(store().dockedLayout).toBeNull();
  });
});

describe('stopStintRange (utils/stints.js), Monza 2024', () => {
  it('the stint the stop ended: LEC pitted at the end of lap 15 (out-lap 16): laps 1-15', () => {
    expect(stopStintRange(MONZA.lap_times, 'LEC', 16)).toEqual([1, 15]);
  });
  it('no stop of that driver before that out-lap, or no laps: null', () => {
    expect(stopStintRange(MONZA.lap_times, 'LEC', 1)).toBeNull();
    expect(stopStintRange([], 'LEC', 16)).toBeNull();
  });
});

describe('the pit markers of the timing bar', () => {
  async function mountAt(lap, extra = {}) {
    const lapTimes = MONZA.lap_times;
    const offset = computeSessionTimeOffset(lapTimes);
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R', loadedYear: 2024, loadedRound: 16,
      sessionData: MONZA, trackStatus: MONZA.track_status || [], sessionTimeOffset: offset,
      maxLap: MAX_LAP, totalRaceLaps: MAX_LAP, currentLap: lap, totalFrames: 0, currentTime: 0,
      isLiveMode: false, focusDriver: 'LEC', selectedDrivers: ['LEC'],
      activeTab: 'pitwall', dockedLayout: null, openOverlays: [], selectedLapRange: null, brushLapRange: null,
      ...extra,
    });
    expect(resolveSessionNow({ currentLap: lap, lapTimes })).toBeGreaterThan(0);
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 1200, height: 120 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(TimelinePlayer)); });
    const bar = host.querySelector('.timeline-player');
    // the pointer over the bar: the strip expands and draws its markers
    await act(async () => { dom.mouse(bar, 'mouseover', { relatedTarget: dom.document.body }); });
    await act(async () => { ro.flushFrames(); await new Promise((r) => setTimeout(r, 0)); ro.flushFrames(); });
    return { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
  }

  // The marker groups drawn with the pit glyph: the aggregated window (a
  // circle) and the selected driver's stop (a square)
  const pitMarkers = (host, shape) => [...host.querySelectorAll('svg g')]
    .filter((g) => g.style.cursor === 'pointer' && g.querySelector(shape)
      && g.querySelector('text') && /^(P|\d+)$/.test(g.querySelector('text').textContent));

  it('LEC selected at lap 40: his stop marker opens Tyre Degradation with laps 1-15, his first stint', async () => {
    const v = await mountAt(40);
    try {
      const marks = pitMarkers(v.host, 'rect');
      expect(marks.length).toBeGreaterThan(0);
      await act(async () => { dom.mouse(marks[0], 'click'); });
      expect(tabsOf(store().dockedLayout)).toContain('tiredeg');
      expect(paneOf(store().dockedLayout, 'tiredeg').activeTab).toBe('tiredeg');
      expect(store().activeTab).not.toBe('pitwall');
      expect(store().selectedLapRange).toEqual([1, 15]);
      expect(store().activePanel ?? null).toBeNull();
    } finally {
      await v.unmount();
    }
  });

  it('the aggregated marker of lap 16 with Tyre Degradation already docked: brought forward, not closed', async () => {
    const layout = { tabs: ['prediction', 'tiredeg'], activeTab: 'prediction' };
    const v = await mountAt(40, { activeTab: 'charts', dockedLayout: layout });
    try {
      const lap16 = pitMarkers(v.host, 'circle').find((g) => /translate\(([\d.]+)/.test(g.getAttribute('transform'))
        && Math.abs(Number(g.getAttribute('transform').match(/translate\(([\d.]+)/)[1])
          - pitMarkers(v.host, 'rect')[0].getAttribute('transform').match(/translate\(([\d.]+)/)[1]) < 0.5);
      expect(lap16).toBeTruthy();
      await act(async () => { dom.mouse(lap16, 'click'); });
      expect(store().dockedLayout.tabs).toEqual(['prediction', 'tiredeg']);
      expect(store().dockedLayout.activeTab).toBe('tiredeg');
      // LEC, the driver the view shows, stopped on that lap: his stint
      expect(store().selectedLapRange).toEqual([1, 15]);
    } finally {
      await v.unmount();
    }
  });
});
