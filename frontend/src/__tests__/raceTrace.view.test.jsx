// The Race Trace view (components/visualizations/RaceTrace.jsx) on the
// tracked demo race 2024 R5 (frontend/public/data: a VSC on lap 22, safety
// cars from laps 23 and 27): its marks, its fit floors and its interactions.
//
// Fit floors (utils/views/raceTraceChart.js RACE_TRACE_FIT), checked at the
// pane sizes of the dock at 1536 x 750 (helpers/layoutModel.js
// dockedPanesAt: a quarter pane is 609 x 257, a full one 1225 x 548): full
// labels from 420 x 200, labels on hover under it, the answer line alone
// under 300 x 150; every text at its floor (11 px data, 10 px labels).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { setSessionDriverColors } = await import('../utils/colors.js');
const { traceStops, buildRaceTrace } = await import('../utils/raceTrace.js');
const { RACE_TRACE_FIT, raceTraceMode, placeEndLabels, traceLineStyle, LINE_WIDTHS } = await import('../utils/views/raceTraceChart.js');
const { screenTexts, underFloor } = await import('./helpers/screenFont.js');
const { loadCss, dockedPanesAt, px } = await import('./helpers/layoutModel.js');
const { WINDOW_PRESETS } = await import('../utils/windowPresets.js');
const { default: RaceTrace } = await import('../components/visualizations/RaceTrace.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const CHINA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, '../public/data/2024_5_R/session.json.gz'))));
const LT = CHINA.lap_times;
const MAX_LAP = Math.max(...LT.map((r) => r.LapNumber));
const INITIAL = useF1Store.getState();
const VP = { W: 1536, H: 750 };

function state(extra = {}) {
  setSessionDriverColors(CHINA.driver_info);
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 5, sessionType: 'R',
    sessionData: CHINA, trackStatus: CHINA.track_status,
    sessionTimeOffset: computeSessionTimeOffset(LT),
    maxLap: MAX_LAP, totalRaceLaps: MAX_LAP, currentLap: 32, lapModeRaceOver: false,
    totalFrames: 0, currentTime: 0, isLiveMode: false,
    focusDriver: null, lapDeltaBaseDriver: null, selectedDrivers: [], highlightedDriver: null,
    selectedLapRange: null, brushLapRange: null,
    raceTraceReference: 'field', raceTraceWindow: 'focus',
    ...extra,
  });
}

let view = null;
async function mount({ width, height }) {
  if (view) await view.unmount();
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(RaceTrace)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  view = { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); view = null; } };
  return view;
}
const chartSvg = (host) => host.querySelectorAll('svg').find((s) => s.style.width === '100%');
const shown = (els) => els.filter((e) => e.style.display !== 'none');
const fire = async (el, type, init = {}) => { await act(async () => { dom.mouse(el, type, init); }); };

// the view of a test goes before the next test changes the store
afterEach(async () => {
  if (view) await view.unmount();
});
afterAll(() => {
  useF1Store.setState({ ...INITIAL });
});

describe('fit modes', () => {
  it('the floors: full from 420 x 200, compact under it, the answer alone under 300 x 150', () => {
    expect(RACE_TRACE_FIT).toEqual({ full: { width: 420, height: 200 }, answer: { width: 300, height: 150 } });
    expect(raceTraceMode({ width: 609, height: 257 })).toBe('full');
    expect(raceTraceMode({ width: 419, height: 257 })).toBe('compact');
    expect(raceTraceMode({ width: 609, height: 199 })).toBe('compact');
    expect(raceTraceMode({ width: 299, height: 199 })).toBe('answer');
    expect(raceTraceMode({ width: 400, height: 149 })).toBe('answer');
  });

  // The view's box in a dock pane: the pane less the panel header (padding
  // 2 x --spacing-sm, the taller of the 22 px export button and the title
  // line, --font-size-sm x 1.5) and the dense panel's padding (2 x --spacing-sm)
  const css = loadCss(SRC);
  const pad = px(css, 'var(--spacing-sm)', VP);
  const header = 2 * pad + Math.max(22, px(css, 'var(--font-size-sm)', VP) * 1.5);
  const viewBoxOf = (p) => ({ width: p.width - 2 * pad, height: p.height - header - 2 * pad });

  it('dock panes at 1536 x 750: a quarter pane is full; the low panes of the presets compact or the answer line', () => {
    const half = { direction: 'horizontal', ratio: 0.5, children: [{ tabs: ['a'] }, { tabs: ['b'] }] };
    const quarter = dockedPanesAt(css, { direction: 'vertical', ratio: 0.5, children: [half, half] }, VP)[0];
    expect(Math.round(quarter.width)).toBe(609);
    expect(Math.round(quarter.height)).toBe(257);
    expect(raceTraceMode(viewBoxOf(quarter))).toBe('full');
    const modes = [];
    for (const [name, preset] of Object.entries(WINDOW_PRESETS)) {
      for (const p of dockedPanesAt(css, preset.dockedLayout, VP)) modes.push([`${name}:${p.tabs}`, raceTraceMode(viewBoxOf(p))]);
    }
    // the lowest pane (the Strategy preset's bottom row, 1225 x 199) is under
    // 150 px high once the header is off: the answer line; the panes 228 px
    // high are under 200: compact (labels on hover); every other pane is full
    expect(modes.filter(([, m]) => m !== 'full')).toEqual([
      ['strategy:laptimes', 'answer'],
      ['pace:consistency', 'compact'],
      ['prediction:laptimes', 'compact'],
      ['simulator:prediction', 'compact'],
    ]);
  });

  for (const size of [{ width: 593, height: 211 }, { width: 1209, height: 502 }]) {
    it(`full at ${size.width} x ${size.height}: lines, labels, legend and provenance, every text at its floor`, async () => {
      state({ focusDriver: 'VER', lapDeltaBaseDriver: 'VER' });
      const { host } = await mount(size);
      const svg = chartSvg(host);
      expect(svg).toBeTruthy();
      const now = resolveSessionNow({ currentLap: 32, lapTimes: LT });
      const trace = buildRaceTrace(LT, { trackStatus: CHINA.track_status, sessionNow: now });
      expect(svg.querySelectorAll('.rt-line').length).toBe(trace.drivers.length);
      expect(shown(svg.querySelectorAll('.rt-end-label')).length).toBeGreaterThan(3);
      expect(svg.querySelectorAll('.rt-band--sc').length).toBe(2);
      expect(svg.querySelectorAll('.rt-band--vsc').length).toBe(1);
      expect(svg.querySelectorAll('.rt-chip--stop').length).toBeGreaterThan(5);
      expect(svg.querySelector('.rt-now-label').textContent).toBe('now · L32');
      expect(svg.querySelector('.rt-pit-bracket')).toBeTruthy();
      // the focus line is 3 px, the others 1 px in context
      const ver = svg.querySelectorAll('.rt-line').find((l) => l.getAttribute('data-driver') === 'VER');
      expect(Number(ver.getAttribute('stroke-width'))).toBe(LINE_WIDTHS.focus);
      expect(host.querySelector('.rt-answer').textContent).toMatch(/^VER [+−]\d+\.\d s (ahead of|behind) the field-median car at L31, P\d+$/);
      expect(host.querySelector('.rt-provenance').textContent)
        .toMatch(/^lap end times \(Time\) of the timing · as of L31 · reference: field-median lap, \d+ of \d+ cars on L\d+/);
      expect(screenTexts(svg, VP).length).toBeGreaterThan(10);
      expect(underFloor(svg, VP)).toEqual([]);
    });
  }

  it('compact under 420 x 200: end labels on hover only, the short legend', async () => {
    state();
    const { host } = await mount({ width: 400, height: 190 });
    const svg = chartSvg(host);
    expect(svg).toBeTruthy();
    expect(svg.querySelectorAll('.rt-end-label').length).toBeGreaterThan(0);
    expect(shown(svg.querySelectorAll('.rt-end-label'))).toEqual([]);
    const legend = host.querySelectorAll('.rt-legend .legend-label').map((e) => e.textContent);
    expect(legend).not.toContain('pit, same tyres');
    expect(legend).toContain('stop');
    // hover a line: its label shows
    const hit = svg.querySelectorAll('.rt-hit').find((h) => h.getAttribute('data-driver') === 'HAM');
    await fire(hit, 'mouseenter', { clientX: 10, clientY: 10 });
    expect(shown(chartSvg(host).querySelectorAll('.rt-end-label')).map((e) => e.getAttribute('data-driver'))).toEqual(['HAM']);
    expect(underFloor(chartSvg(host), VP)).toEqual([]);
  });

  it('under 300 x 150: the answer line only, no chart', async () => {
    state({ focusDriver: 'LEC' });
    const { host } = await mount({ width: 290, height: 140 });
    expect(chartSvg(host)).toBeFalsy();
    // LEC (P3) has not completed lap 31 yet when the leader starts lap 32
    expect(host.querySelector('.rt-answer').textContent).toMatch(/^LEC [+−]\d+\.\d s (ahead of|behind) the field-median car at L30, P3$/);
    expect(host.querySelector('.rt-reference')).toBeFalsy();
  });

  it('the source has no scroll area', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/visualizations/RaceTrace.jsx'), 'utf8');
    expect(src).not.toMatch(/overflow[XY]?\s*:\s*['"](auto|scroll)/);
    expect(src).not.toMatch(/['"]overflow(-x|-y)?['"]\s*,\s*['"](auto|scroll)/);
  });
});

describe('interactions', () => {
  beforeEach(() => state());

  it('hover a line: highlightedDriver; leave: cleared', async () => {
    const { host } = await mount({ width: 800, height: 400 });
    const hit = chartSvg(host).querySelectorAll('.rt-hit').find((h) => h.getAttribute('data-driver') === 'NOR');
    await fire(hit, 'mouseenter', { clientX: 5, clientY: 5 });
    expect(useF1Store.getState().highlightedDriver).toBe('NOR');
    // the hovered line in its colour at 2 px, without a redraw
    const nor = chartSvg(host).querySelectorAll('.rt-line').find((l) => l.getAttribute('data-driver') === 'NOR');
    expect(Number(nor.getAttribute('stroke-width'))).toBe(LINE_WIDTHS.selected);
    await fire(hit, 'mouseleave');
    expect(useF1Store.getState().highlightedDriver).toBe(null);
  });

  it('click a line: toggleDriver; double-click: setFocusDriver', async () => {
    const { host } = await mount({ width: 800, height: 400 });
    const hitOf = (d) => chartSvg(host).querySelectorAll('.rt-hit').find((h) => h.getAttribute('data-driver') === d);
    await fire(hitOf('PER'), 'click');
    expect(useF1Store.getState().selectedDrivers).toEqual(['PER']);
    await fire(hitOf('PER'), 'click');
    expect(useF1Store.getState().selectedDrivers).toEqual([]);
    await fire(hitOf('ALO'), 'dblclick');
    expect(useF1Store.getState().focusDriver).toBe('ALO');
  });

  it('drag along x: setBrushLapRange; a click on the background clears it', async () => {
    const { host } = await mount({ width: 800, height: 400 });
    const svg = chartSvg(host);
    const g = svg.querySelector('g');
    const clip = svg.querySelector('clipPath rect');
    const innerW = Number(clip.getAttribute('width'));
    const a = dom.toClient(g, 2, 40);
    const b = dom.toClient(g, innerW / 2, 40);
    await fire(svg, 'mousedown', a);
    await fire(svg, 'mousemove', b);
    await fire(svg, 'mouseup', b);
    const range = useF1Store.getState().brushLapRange;
    expect(range[0]).toBe(1);
    expect(range[1]).toBeGreaterThan(10);
    expect(range[1]).toBeLessThan(20);
    expect(useF1Store.getState().selectedLapRange).toEqual(range);
    // drawn as a tint
    expect(chartSvg(host).querySelector('.rt-lap-range')).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await fire(chartSvg(host), 'click');
    expect(useF1Store.getState().brushLapRange).toBe(null);
  });

  it('click an SC band: that episode\'s laps', async () => {
    const { host } = await mount({ width: 800, height: 400 });
    const band = chartSvg(host).querySelector('.rt-band--sc');
    await fire(band, 'click');
    const [a, b] = band.getAttribute('data-laps').split('-').map(Number);
    expect(useF1Store.getState().brushLapRange).toEqual([a, b]);
    expect(a).toBe(23);
  });

  it('click a stop chip (replay): rewind to the lap before the in-lap; not in live mode', async () => {
    const { host } = await mount({ width: 800, height: 400 });
    const chip = chartSvg(host).querySelector('.rt-chip--stop');
    const driver = chip.getAttribute('data-driver');
    const outLap = Number(chip.getAttribute('data-lap'));
    const stop = traceStops(LT, resolveSessionNow({ currentLap: 32, lapTimes: LT }))
      .find((s) => s.driver === driver && s.lap === outLap);
    await fire(chip, 'click');
    expect(useF1Store.getState().currentLap).toBe(stop.inLap - 1);

    await view.unmount();
    state({ isLiveMode: true });
    const live = await mount({ width: 800, height: 400 });
    const chip2 = chartSvg(live.host).querySelector('.rt-chip--stop');
    const before = useF1Store.getState().currentLap;
    await fire(chip2, 'click');
    expect(useF1Store.getState().currentLap).toBe(before);
  });
});

describe('store settings and helpers', () => {
  it('reference and window are store settings, persisted with the other view settings', () => {
    state();
    useF1Store.getState().setRaceTraceReference('leader');
    useF1Store.getState().setRaceTraceWindow('all');
    expect(useF1Store.getState()).toMatchObject({ raceTraceReference: 'leader', raceTraceWindow: 'all' });
    useF1Store.getState().setRaceTraceReference('nonsense');
    expect(useF1Store.getState().raceTraceReference).toBe('field');
    const saved = useF1Store.persist.getOptions().partialize(useF1Store.getState());
    expect(saved).toMatchObject({ raceTraceReference: 'field', raceTraceWindow: 'all' });
    expect(INITIAL).toMatchObject({ raceTraceReference: 'field', raceTraceWindow: 'focus' });
  });

  it('the window follows the focus: focus +- one stop with a focus, the top 10 without', async () => {
    state({ focusDriver: 'NOR' });
    let { host } = await mount({ width: 800, height: 400 });
    expect(host.querySelector('.rt-provenance').textContent).toContain('window: NOR ± max(20 s, pit loss + 5 s)');
    await view.unmount();
    state({ focusDriver: null });
    ({ host } = await mount({ width: 800, height: 400 }));
    expect(host.querySelector('.rt-provenance').textContent).toContain('window: top 10 of the lead lap');
  });

  it('line styles: 3 px focus, 2 px selected or hovered, 1 px others in context while one is emphasised', () => {
    expect(traceLineStyle('VER', { focus: 'VER' }).width).toBe(3);
    expect(traceLineStyle('PER', { focus: 'VER', selected: ['PER'] }).width).toBe(2);
    expect(traceLineStyle('NOR', { highlighted: 'NOR' }).width).toBe(2);
    const other = traceLineStyle('NOR', { focus: 'VER' });
    expect(other).toMatchObject({ width: 1, context: true });
    expect(traceLineStyle('NOR', {})).toMatchObject({ width: 1, context: false });
  });

  it('end labels keep one line of room, by priority', () => {
    const placed = placeEndLabels([
      { key: 'A', y: 50, priority: 2 }, { key: 'B', y: 52, priority: 0 }, { key: 'C', y: 100, priority: 1 },
    ], { gap: 12, top: 0, bottom: 200 });
    expect(placed.get('B')).toBe(52);
    expect(placed.get('C')).toBe(100);
    expect(Math.abs(placed.get('A') - 52)).toBeGreaterThanOrEqual(12);
  });

  it('the wet note on a wet race (2025 R1)', async () => {
    const wet = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, '../public/data/2025_1_R/session.json.gz'))));
    setSessionDriverColors(wet.driver_info);
    useF1Store.setState({
      ...INITIAL, year: 2025, round: 1, sessionType: 'R', sessionData: wet, trackStatus: wet.track_status,
      sessionTimeOffset: computeSessionTimeOffset(wet.lap_times), maxLap: 57, totalRaceLaps: 57, currentLap: 20,
      totalFrames: 0, currentTime: 0, raceTraceReference: 'field', raceTraceWindow: 'focus',
    });
    const { host } = await mount({ width: 800, height: 400 });
    expect(host.querySelector('.rt-provenance').textContent)
      .toContain('wet race: the reference is unreliable while the field changes tyres together');
  });
});
