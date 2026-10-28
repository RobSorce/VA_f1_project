// The Race Pace view (components/visualizations/FieldPace.jsx) on the
// tracked demo race 2024 R16 (frontend/public/data): one row per team on the
// shared % axis, the marks (circle first driver, diamond second, hollow and
// LOW DATA under 10 laps), the team-mate gap, the pager, the lap-range chip,
// the fit floors at the dock panes of 1536 x 750 and 1536 x 864, and the
// interactions.
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
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { setSessionDriverColors } = await import('../utils/colors.js');
const { fieldPace, gapLine } = await import('../utils/fieldPace.js');
const {
  FIELD_PACE_MIN, FIELD_PACE_ROW_PX, paceRowsFit, paceAnswerOnly, markLabelLayout,
} = await import('../utils/views/fieldPaceChart.js');
const { underFloor } = await import('./helpers/screenFont.js');
const { loadCss, dockedPanesAt, px } = await import('./helpers/layoutModel.js');
const { default: FieldPace } = await import('../components/visualizations/FieldPace.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const MONZA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(SRC, '../public/data/2024_16_R/session.json.gz'))));
const INITIAL = useF1Store.getState();
const VP = { W: 1536, H: 750 };

function state(session = MONZA, extra = {}) {
  setSessionDriverColors(session.driver_info);
  const lt = session.lap_times;
  const maxLap = Math.max(...lt.map((r) => r.LapNumber));
  useF1Store.setState({
    ...INITIAL,
    year: 2024, round: 16, sessionType: 'R',
    sessionData: session, trackStatus: session.track_status,
    sessionTimeOffset: computeSessionTimeOffset(lt),
    maxLap, totalRaceLaps: maxLap, currentLap: maxLap, lapModeRaceOver: true,
    totalFrames: 0, currentTime: 0,
    focusDriver: null, selectedDrivers: [], highlightedDriver: null, brushLapRange: null, selectedLapRange: null,
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
  await act(async () => { root.render(React.createElement(FieldPace)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  view = { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); view = null; } };
  return view;
}
const svgOf = (host) => host.querySelectorAll('svg').find((s) => s.style.width === '100%');
const rowsOf = (host) => svgOf(host).querySelectorAll('.fp-row');
const fire = async (el, type, init = {}) => { await act(async () => { dom.mouse(el, type, init); }); };

// the view of a test goes before the next test changes the store
afterEach(async () => {
  if (view) await view.unmount();
});
afterAll(() => {
  useF1Store.setState({ ...INITIAL });
});

describe('rows and marks', () => {
  beforeEach(() => state());

  it('10 teams on one page at 600 x 220, sorted by the team median, two marks and the gap per row', async () => {
    const { host } = await mount({ width: 600, height: FIELD_PACE_MIN.height });
    const rows = rowsOf(host);
    const pace = fieldPace(MONZA.lap_times, { trackStatus: MONZA.track_status, driverInfo: MONZA.driver_info });
    expect(rows.map((r) => r.getAttribute('data-team'))).toEqual(pace.teams.map((t) => t.team));
    expect(host.querySelector('.fp-next')).toBeFalsy();
    for (const r of rows) {
      expect(r.querySelectorAll('.fp-mark--circle').length).toBe(1);
      expect(r.querySelectorAll('.fp-mark--diamond').length).toBe(1);
    }
    // the gap line of each row
    expect(rows.map((r) => r.querySelector('.fp-gap').textContent)).toEqual(pace.teams.map((t) => gapLine(t.gap)));
    expect(rows[0].querySelector('.fp-gap').textContent).toMatch(/^[A-Z]{3} [−+]\d\.\d\d % \[[−+]?\d\.\d\d, [−+]?\d\.\d\d\] · (decisive|not decisive|low data)$/);
    // the axis caption
    expect(svgOf(host).querySelector('.fp-caption').textContent).toBe('faster ◀ 0 = field median, same lap');
    expect(underFloor(svgOf(host), VP)).toEqual([]);
  });

  it('TSU (4 laps): a hollow mark and LOW DATA; the RB gap reads low data', async () => {
    const { host } = await mount({ width: 700, height: 260 });
    const rb = rowsOf(host).find((r) => r.getAttribute('data-team') === 'RB');
    const tsu = rb.querySelectorAll('.fp-mark').find((m) => m.getAttribute('data-driver') === 'TSU');
    expect(tsu.querySelector('.fp-label').textContent).toBe('TSU n4 LOW DATA');
    expect(tsu.querySelector('.fp-dot').getAttribute('fill')).not.toBe(tsu.querySelector('.fp-dot').getAttribute('stroke'));
    expect(rb.querySelector('.fp-gap').textContent).toMatch(/· low data$/);
  });

  it('11 teams: a pager in the header, 10 rows then 1', async () => {
    // an eleventh team: two copies of the Sauber drivers under new codes
    const extra = MONZA.lap_times.filter((r) => r.Driver === 'BOT' || r.Driver === 'ZHO')
      .map((r) => ({ ...r, Driver: r.Driver === 'BOT' ? 'XXA' : 'XXB', Team: 'Eleventh' }));
    const session = {
      ...MONZA,
      lap_times: [...MONZA.lap_times, ...extra],
      driver_info: [...MONZA.driver_info,
        { DriverNumber: '98', Abbreviation: 'XXA', FullName: 'A', TeamName: 'Eleventh', TeamColor: '888888' },
        { DriverNumber: '99', Abbreviation: 'XXB', FullName: 'B', TeamName: 'Eleventh', TeamColor: '888888' }],
    };
    state(session);
    const { host } = await mount({ width: 640, height: 260 });
    expect(rowsOf(host).length).toBe(10);
    expect(host.querySelector('.fp-page').textContent).toBe('1/2');
    await fire(host.querySelector('.fp-next'), 'click');
    expect(rowsOf(host).length).toBe(1);
    expect(host.querySelector('.fp-page').textContent).toBe('2/2');
  });

  it('the lap range: a chip "laps a–b ×" that clears it; the pace of those laps only', async () => {
    state(MONZA, { brushLapRange: [20, 35], selectedLapRange: [20, 35] });
    const { host } = await mount({ width: 640, height: 260 });
    const chip = host.querySelector('.fp-range');
    expect(chip.textContent).toBe('laps 20–35 ×');
    const pace = fieldPace(MONZA.lap_times, {
      trackStatus: MONZA.track_status, driverInfo: MONZA.driver_info, lapRange: [20, 35],
    });
    // a team with a driver without a comparable lap in the range has no gap line
    expect(rowsOf(host).map((r) => r.querySelector('.fp-gap')?.textContent ?? '')).toEqual(pace.teams.map((t) => gapLine(t.gap)));
    await fire(chip, 'click');
    expect(useF1Store.getState().brushLapRange).toBe(null);
  });
});

describe('fit', () => {
  it('rows of 21 px, 10 a page from 220 px; under 560 px wide the answer line only', () => {
    expect(FIELD_PACE_MIN).toEqual({ width: 560, height: 220 });
    expect(FIELD_PACE_ROW_PX).toBe(21);
    expect(paceRowsFit(210, 10)).toEqual({ perPage: 10, paged: false });
    expect(paceRowsFit(210, 11)).toEqual({ perPage: 10, paged: true });
    expect(paceRowsFit(199, 10)).toEqual({ perPage: 9, paged: true });
    expect(paceAnswerOnly({ width: 559, height: 400 }, 10)).toBe(true);
    expect(paceAnswerOnly({ width: 560, height: 220 }, 10)).toBe(false);
    expect(paceAnswerOnly({ width: 600, height: 51 }, 10)).toBe(true);
  });

  // The view's box in a dock pane: the pane less the panel header and the dense padding
  const css = loadCss(SRC);
  const quarterAt = (vp) => {
    const half = { direction: 'horizontal', ratio: 0.5, children: [{ tabs: ['a'] }, { tabs: ['b'] }] };
    const q = dockedPanesAt(css, { direction: 'vertical', ratio: 0.5, children: [half, half] }, vp)[0];
    const pad = px(css, 'var(--spacing-sm)', vp);
    const header = 2 * pad + Math.max(22, px(css, 'var(--font-size-sm)', vp) * 1.5);
    return { width: Math.floor(q.width - 2 * pad), height: Math.floor(q.height - header - 2 * pad) };
  };

  it('a quarter dock pane at 1536 x 750: rows, 9 a page (the pager); at 1536 x 864: all 10', async () => {
    state();
    const at750 = quarterAt(VP);
    expect(at750.width).toBeGreaterThanOrEqual(FIELD_PACE_MIN.width);
    let { host } = await mount(at750);
    expect(rowsOf(host).length).toBe(9);
    expect(host.querySelector('.fp-page').textContent).toBe('1/2');
    expect(underFloor(svgOf(host), VP)).toEqual([]);
    const at864 = quarterAt({ W: 1536, H: 864 });
    ({ host } = await mount(at864));
    expect(rowsOf(host).length).toBe(10);
    expect(host.querySelector('.fp-page')).toBeFalsy();
  });

  it('under the floor: the answer line, no rows', async () => {
    state();
    const { host } = await mount({ width: 500, height: 300 });
    expect(svgOf(host)).toBeFalsy();
    expect(host.querySelector('.fp-answer').textContent).toMatch(/^Fastest race pace: McLaren \((NOR|PIA) −\d\.\d\d %, (NOR|PIA) −\d\.\d\d %\)$/);
  });

  it('mark labels stay inside the axis column when one side has no room', () => {
    const marks = [{ key: 'A', left: 105, right: 115, w: 50 }, { key: 'B', left: 130, right: 140, w: 50 }];
    const lay = markLabelLayout(marks, { x0: 100, x1: 400 });
    expect(lay.get('A')).toEqual({ x: 146, anchor: 'start' });
    expect(lay.get('B')).toEqual({ x: 202, anchor: 'start' });
    const wide = markLabelLayout([{ key: 'A', left: 200, right: 210, w: 50 }, { key: 'B', left: 250, right: 260, w: 50 }], { x0: 100, x1: 400 });
    expect(wide.get('A')).toEqual({ x: 194, anchor: 'end' });
    expect(wide.get('B')).toEqual({ x: 266, anchor: 'start' });
  });

  it('the source has no scroll area', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/visualizations/FieldPace.jsx'), 'utf8');
    expect(src).not.toMatch(/overflow[XY]?\s*:\s*['"](auto|scroll)/);
  });
});

describe('interactions', () => {
  beforeEach(() => state());

  it('hover a mark: that driver; the row elsewhere: the faster team-mate; leave: none', async () => {
    const { host } = await mount({ width: 700, height: 260 });
    const row = rowsOf(host).find((r) => r.getAttribute('data-team') === 'Ferrari');
    const sai = row.querySelectorAll('.fp-mark').find((m) => m.getAttribute('data-driver') === 'SAI');
    await fire(sai.querySelector('.fp-dot'), 'mousemove', { clientX: 5, clientY: 5 });
    expect(useF1Store.getState().highlightedDriver).toBe('SAI');
    const ferrari = fieldPace(MONZA.lap_times, { trackStatus: MONZA.track_status, driverInfo: MONZA.driver_info })
      .teams.find((t) => t.team === 'Ferrari');
    await fire(rowsOf(host).find((r) => r.getAttribute('data-team') === 'Ferrari').querySelector('.fp-team'), 'mousemove');
    expect(useF1Store.getState().highlightedDriver).toBe(ferrari.gap.faster);
    await fire(rowsOf(host).find((r) => r.getAttribute('data-team') === 'Ferrari'), 'mouseleave');
    expect(useF1Store.getState().highlightedDriver).toBe(null);
  });

  it('click a row: both drivers selected; double-click a mark: the focus', async () => {
    const { host } = await mount({ width: 700, height: 260 });
    const row = () => rowsOf(host).find((r) => r.getAttribute('data-team') === 'McLaren');
    await fire(row().querySelector('.fp-team'), 'click');
    expect([...useF1Store.getState().selectedDrivers].sort()).toEqual(['NOR', 'PIA']);
    const nor = row().querySelectorAll('.fp-mark').find((m) => m.getAttribute('data-driver') === 'NOR');
    await fire(nor.querySelector('.fp-dot'), 'dblclick');
    expect(useF1Store.getState().focusDriver).toBe('NOR');
  });
});
