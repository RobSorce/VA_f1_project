// The focus card's rival trend reads the gap on the rival's side of the
// focus driver: closing = the gap shrinks, opening = it grows.
//
// The browser pass found it inverted for the rivals ahead: the store took
// the trend from the signed gap (rival's GapToLeader minus the focus
// driver's, negative for a rival ahead), so a rival ahead pulling away
// (-2.0 s, then -2.5 s) read "closing", and one being caught read
// "opening". The card coloured "closing" as worse whatever the side, right
// only for a rival behind.
//
// Here: the pure helper (utils/rivalTrend.js), the store's rival context on
// every lap of the demo race 2024 R16 (frontend/public/data) with LEC
// focused, and the card's arrow and colour.
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Server rendering reads getServerState: point it at the live state
vi.mock('zustand', async (importOriginal) => {
  const orig = await importOriginal();
  const bind = (createState) => {
    const api = orig.createStore(createState);
    api.getServerState = api.getState;
    const useBound = (selector, equalityFn) => orig.useStore(api, selector, equalityFn);
    Object.assign(useBound, api);
    return useBound;
  };
  return { ...orig, create: (createState) => (createState ? bind(createState) : bind) };
});
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

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset, completedLaps, leaderLapEndTime } = await import('../utils/raceTime.js');
const { DIVERGING } = await import('../utils/colors.js');
// (a missing module fails the helper's tests, not the store's and the card's)
const trend = await import('../utils/rivalTrend.js').catch(() => ({}));
const { default: FocusDriverWidget } = await import('../components/ui/FocusDriverWidget.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONZA = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(HERE, '../../public/data/2024_16_R/session.json.gz'))));
const MAX_LAP = Math.max(...MONZA.lap_times.map((r) => r.LapNumber));
const INITIAL = useF1Store.getState();
const store = () => useF1Store.getState();
const AHEAD = -1;
const BEHIND = 1;

afterAll(() => { useF1Store.setState({ ...INITIAL }); });

describe('rivalGapChange / rivalGapTrend (utils/rivalTrend.js)', () => {
  const { rivalGapChange, rivalGapTrend } = trend;
  it('a rival ahead pulling away (-2.0 s, then -2.5 s): the gap grows, opening', () => {
    expect(rivalGapChange([-2.0, -2.5], AHEAD)).toBeCloseTo(0.5, 9);
    expect(rivalGapTrend([-2.0, -2.5], AHEAD)).toBe('opening');
  });
  it('a rival ahead being caught (-2.5 s, then -2.0 s): the gap shrinks, closing', () => {
    expect(rivalGapChange([-2.5, -2.0], AHEAD)).toBeCloseTo(-0.5, 9);
    expect(rivalGapTrend([-2.5, -2.0], AHEAD)).toBe('closing');
  });
  it('a rival behind dropping back (+2.0 s, then +2.5 s): opening; catching up (+2.5, then +2.0): closing', () => {
    expect(rivalGapTrend([2.0, 2.5], BEHIND)).toBe('opening');
    expect(rivalGapTrend([2.5, 2.0], BEHIND)).toBe('closing');
  });
  it('the first and the last gap of the window; within 0.3 s either way, stable; fewer than two gaps, stable', () => {
    expect(trend.GAP_TREND_THRESHOLD_S).toBe(0.3);
    expect(rivalGapTrend([-2.0, -3.0, -2.2], AHEAD)).toBe('stable');
    expect(rivalGapTrend([-2.0, -2.25], AHEAD)).toBe('stable');
    expect(rivalGapTrend([2.0, 1.75], BEHIND)).toBe('stable');
    expect(rivalGapTrend([-2.0], AHEAD)).toBe('stable');
    expect(rivalGapChange([-2.0], AHEAD)).toBeNull();
  });
  it('a rival who passed the focus driver: measured on the side he is on now (4.1 s behind, now 1.3 s ahead: opening)', () => {
    expect(rivalGapChange([4.06, 3.69, -1.32], AHEAD)).toBeCloseTo(5.38, 9);
    expect(rivalGapTrend([4.06, 3.69, -1.32], AHEAD)).toBe('opening');
  });
});

describe('the store\'s rival context, Monza 2024 (demo data), LEC focused, every lap', () => {
  // The rival context in the middle of each leader lap, as the replay of
  // the frames puts the clock there, and the trend from the laps completed
  // at that clock: the gap's size on the rival's side
  const offset = computeSessionTimeOffset(MONZA.lap_times);
  const rows = [];
  for (let lap = 3; lap <= MAX_LAP; lap++) {
    const mid = (leaderLapEndTime(MONZA.lap_times, lap - 1) + leaderLapEndTime(MONZA.lap_times, lap)) / 2;
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R',
      sessionData: MONZA, trackStatus: MONZA.track_status || [], sessionTimeOffset: offset,
      maxLap: MAX_LAP, totalRaceLaps: MAX_LAP, currentLap: lap, totalFrames: 1000, currentTime: mid - offset,
      isLiveMode: false, focusDriver: 'LEC',
    });
    store().updateRivalContext();
    const done = completedLaps(MONZA.lap_times, store().getSessionNow());
    const at = (d, l) => done.find((r) => r.Driver === d && r.LapNumber === l);
    for (const r of store().rivalContext) {
      const gaps = [];
      for (let l = Math.max(1, lap - 2); l <= lap; l++) {
        const f = at('LEC', l);
        const x = at(r.driver, l);
        if (f?.GapToLeader != null && x?.GapToLeader != null) gaps.push(x.GapToLeader - f.GapToLeader);
      }
      const focusPos = [...done].filter((x) => x.Driver === 'LEC' && x.LapNumber <= lap).pop().Position;
      const side = r.position > focusPos ? BEHIND : AHEAD;
      let want = 'stable';
      if (gaps.length >= 2) {
        const size = (g) => side * g;
        const change = size(gaps[gaps.length - 1]) - size(gaps[0]);
        if (change < -0.3) want = 'closing';
        else if (change > 0.3) want = 'opening';
      }
      rows.push({
        lap, driver: r.driver, side, gaps, got: r.gapTrend, want, sideField: r.side,
      });
    }
  }

  it('every rival of every lap: the trend of the gap on his side', () => {
    expect(rows.length).toBeGreaterThan(100);
    const wrong = rows.filter((r) => r.got !== r.want)
      .map((r) => `L${r.lap} ${r.driver} ${r.side === AHEAD ? 'ahead' : 'behind'} [${r.gaps.map((g) => g.toFixed(2)).join(', ')}]: ${r.got}, want ${r.want}`);
    expect(wrong).toEqual([]);
  });

  it('each rival carries the side he is on: ahead or behind, from the positions', () => {
    for (const r of rows) expect(r.sideField, `L${r.lap} ${r.driver}`).toBe(r.side === AHEAD ? 'ahead' : 'behind');
  });

  it('the race has each case: ahead and behind, closing and opening', () => {
    for (const side of [AHEAD, BEHIND]) {
      for (const t of ['closing', 'opening']) {
        expect(rows.some((r) => r.side === side && r.got === t), `${side === AHEAD ? 'ahead' : 'behind'} ${t}`).toBe(true);
      }
    }
  });

  it('PIA ahead of LEC pulling away from lap 10 to lap 11 (-1.23 s to -1.83 s), mid lap 12: opening', () => {
    const r = rows.find((x) => x.lap === 12 && x.driver === 'PIA');
    expect(r.side).toBe(AHEAD);
    expect(r.gaps.map((g) => Math.round(g * 100) / 100)).toEqual([-1.23, -1.83]);
    expect(r.got).toBe('opening');
  });
});

describe('the focus card: the same arrows and words, the colour by what the change means for the focus driver', () => {
  const card = (rival) => {
    useF1Store.setState({
      ...INITIAL, focusDriver: 'LEC', drivers: MONZA.driver_info, sessionData: MONZA, currentLap: 20, rivalContext: [rival],
    });
    const html = renderToString(<FocusDriverWidget />);
    const m = html.match(/<span class="focus-widget__rival-trend" style="color:([^"]+)">([^<]*)<\/span>/);
    return { color: m[1], glyph: m[2] };
  };
  const base = { driver: 'PIA', compound: 'HARD', tyreAge: 5 };
  it('a rival ahead: closing (catching him) blue, opening (losing him) orange; the glyphs unchanged', () => {
    expect(card({ ...base, position: 1, side: 'ahead', gap: -2.0, gapTrend: 'closing' })).toEqual({ color: DIVERGING.better, glyph: '↑' });
    expect(card({ ...base, position: 1, side: 'ahead', gap: -2.5, gapTrend: 'opening' })).toEqual({ color: DIVERGING.worse, glyph: '↓' });
  });
  it('a rival behind: closing (being caught) orange, opening blue', () => {
    expect(card({ ...base, position: 3, side: 'behind', gap: 2.0, gapTrend: 'closing' })).toEqual({ color: DIVERGING.worse, glyph: '↑' });
    expect(card({ ...base, position: 3, side: 'behind', gap: 2.5, gapTrend: 'opening' })).toEqual({ color: DIVERGING.better, glyph: '↓' });
    expect(card({ ...base, position: 3, side: 'behind', gap: 2.1, gapTrend: 'stable' }).glyph).toBe('↔');
  });
});
