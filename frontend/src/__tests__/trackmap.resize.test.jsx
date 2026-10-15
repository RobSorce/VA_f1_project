// D4 (Phase 9c, browser pass 2026-10-16 #2): the Track Map is laid out again
// in its panel's box and its labels (corner numbers, DRS, car codes, grid
// places) read at their CHART_FONT size on screen whatever the panel size and
// the d3.zoom factor: font sizes divided by --map-zoom = k x the svg's scale
// on screen (TrackMap.jsx setMapZoom, chartBox.js svgScreenScale).
//
// Measured before Phase 9c: after moving the browser from the 2048 px screen
// to the 1536 px one the map was drawn at scale 0.6 (corner labels 6.5 px,
// DRS 6 px); at 1366 x 768 the box settled smaller than the first draw
// (scale 0.89: DRS 8.9 px, corner labels 9.8 px).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
const { installResizeObserverMock, syntheticSession } = await import('./helpers/chartFixtures.js');
const { screenTexts, underFloor } = await import('./helpers/screenFont.js');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
// Font tokens evaluated at Roberto's main screen: --font-size-data 11.0005 px there
const VP = { W: 1536, H: 750 };

function sessionState() {
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: SESSION,
    circuitInfo: SESSION.circuit_info,
    trackStatus: SESSION.track_status,
    sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
    maxLap: 20, totalRaceLaps: 20, currentLap: 1,
    totalFrames: 0, currentTime: 0,
    showTrackDRS: true, showTrackSectors: true,
  });
}

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

let view = null;
async function mountMap(width, height) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(TrackMap)); });
  await settle();
  const svg = host.querySelectorAll('svg').find((s) => s.style.width === '100%' && s.style.height === '100%');
  // d3.zoom reads the viewBox through the SVG DOM (viewBox.baseVal), which the mini DOM lacks
  Object.defineProperty(svg, 'viewBox', {
    configurable: true,
    get() {
      const [x, y, w, h] = String(svg.getAttribute('viewBox') || '0 0 0 0').split(/[\s,]+/).map(Number);
      return { baseVal: { x, y, width: w, height: h } };
    },
  });
  view = {
    host, svg,
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
  return view;
}

const viewBoxOf = (svg) => String(svg.getAttribute('viewBox'));
const labels = (svg, cls) => screenTexts(svg, VP).filter((t) => t.cls.split(/\s+/).includes(cls) || (!cls && t.cls === ''));

/** Resize the map's box (the svg's container) and let the map lay out again. */
async function resizeBox(svg, width, height, { notify = true } = {}) {
  const box = svg.parentElement;
  dom.setRect(box, { left: 0, top: 0, width, height });
  if (!notify) return;
  await act(async () => { ro.notify(box, width, height); });
  await settle();
}

/** A wheel turn over the map's centre: d3.zoom scales by 2^(-deltaY x 0.002). */
async function wheel(svg, deltaY) {
  const r = svg.getBoundingClientRect();
  const ev = {
    type: 'wheel', bubbles: true, cancelable: true, deltaY, deltaMode: 0, deltaX: 0,
    clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    button: 0, buttons: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    view: dom.window, defaultPrevented: false, _stop: false, _stopImmediate: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stop = true; },
    stopImmediatePropagation() { this._stop = true; this._stopImmediate = true; },
  };
  await act(async () => { svg.dispatchEvent(ev); });
}

const zoomK = (svg) => {
  const g = svg.querySelector('.track-group');
  const m = /scale\(([\d.]+)\)/.exec(g.getAttribute('transform') || '');
  return m ? Number(m[1]) : 1;
};

describe('D4: the Track Map follows its panel and keeps its labels at the floors on screen', () => {
  beforeAll(() => sessionState());
  afterAll(async () => {
    if (view) await view.unmount();
    useF1Store.setState({ ...INITIAL });
  });

  it('first draw: viewBox = the box; corner, DRS and car labels at their sizes', async () => {
    const { svg } = await mountMap(1100, 620);
    expect(viewBoxOf(svg)).toBe('0 0 1100 620');
    expect(labels(svg, 'corner-label').length).toBe(6);
    expect(screenTexts(svg, VP).some((t) => t.text === 'DRS')).toBe(true);
    expect(labels(svg, 'car-label').length).toBe(8);
    expect(underFloor(svg, VP)).toEqual([]);
  });

  it('moved to the smaller screen (box x 0.6): laid out again, nothing under the floors', async () => {
    const { svg } = view;
    await resizeBox(svg, 660, 372);
    expect(viewBoxOf(svg)).toBe('0 0 660 372');
    expect(svg.style.getPropertyValue('--map-zoom')).toBe('1');
    expect(underFloor(svg, VP)).toEqual([]);
    const corner = labels(svg, 'corner-label')[0];
    expect(corner.screenPx).toBeCloseTo(11, 2);
    const drs = screenTexts(svg, VP).find((t) => t.text === 'DRS');
    expect(drs.screenPx).toBeCloseTo(10, 2);
  });

  it('the box settles 11 % smaller after the first draw (1366 x 768 first load): labels at the floors', async () => {
    const { svg } = view;
    await resizeBox(svg, 660, 331);
    expect(viewBoxOf(svg)).toBe('0 0 660 331');
    expect(underFloor(svg, VP)).toEqual([]);
  });

  it('zoomed out to k = 0.5 and in to k = 8: labels keep their size on screen', async () => {
    const { svg } = view;
    await wheel(svg, 500);
    expect(zoomK(svg)).toBeCloseTo(0.5, 5);
    expect(Number(svg.style.getPropertyValue('--map-zoom'))).toBeCloseTo(0.5, 5);
    expect(underFloor(svg, VP)).toEqual([]);
    for (const t of labels(svg, 'corner-label')) expect(t.screenPx).toBeCloseTo(11, 2);

    await wheel(svg, -1500);
    expect(zoomK(svg)).toBeCloseTo(4, 5);
    await wheel(svg, -1000);
    expect(zoomK(svg)).toBeCloseTo(8, 5);
    expect(underFloor(svg, VP)).toEqual([]);
    for (const t of labels(svg, 'car-label')) expect(t.screenPx).toBeCloseTo(11, 2);
  });

  it('a zoom while the svg is drawn at another scale (resize not laid out yet) divides by that scale too', async () => {
    const { svg } = view;
    // the box shrinks to 0.6, the observer has not reported it yet
    await resizeBox(svg, 396, 198.6, { notify: false });
    await wheel(svg, 1500); // back to k = 1
    expect(zoomK(svg)).toBeCloseTo(1, 5);
    expect(Number(svg.style.getPropertyValue('--map-zoom'))).toBeCloseTo(0.6, 2);
    expect(underFloor(svg, VP)).toEqual([]);
    // then the frame arrives: laid out at the new size, the divisor back to k x 1
    await act(async () => { ro.notify(svg.parentElement, 396, 198.6); });
    await settle();
    expect(viewBoxOf(svg)).toBe('0 0 396 198');
    expect(Number(svg.style.getPropertyValue('--map-zoom'))).toBeCloseTo(1, 2);
    expect(underFloor(svg, VP)).toEqual([]);
  });
});
