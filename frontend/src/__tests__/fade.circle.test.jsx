// Focus + context in the Circle of Doom: with a selection on, the cars that are not
// selected are context. Their ring labels turn to the muted text colour
// (>= 3:1, in fact 7.63:1 on the panel) and their leader lines are drawn in
// the leader grey mixed toward the panel (contextColor, >= 2:1); nothing of
// theirs is drawn at an opacity below 1 (the leaders read 1.25:1 at the
// former opacity 0.3). Server render of the cached Monza 2024 race (skipped
// without the cache), as circleOfDoom.view.test.js.
// A car lapped by the leader is an encoding, not context: it is drawn hollow
// (the panel inside a 1.5 px ring of its mark colour, drawn inside the dot;
// the second car's white cue outside the ring; the selection ring 1 px
// further out), no longer as a 0.45 fill. Server render of the synthetic race
// with one car slowed until it is lapped (no cache needed).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

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
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { useF1Store } = await import('../store/useF1Store.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');
const {
  contrastRatio, compositeOver, contextColor, SURFACES, TEXT_COLORS, CONTEXT_FLOOR, setSessionDriverColors,
} = await import('../utils/colors.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');
const { syntheticSession } = await import('./helpers/chartFixtures.js');
const { circleState } = await import('../utils/circleOfDoom.js');
const { getDriverColor, markColor } = await import('../utils/colors.js');

const INITIAL = useF1Store.getState();
const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;

function replayAt(session, sessionTime, currentLap, extra = {}) {
  const offset = computeSessionTimeOffset(session.lap_times);
  const maxLap = Math.max(...session.lap_times.map((r) => r.LapNumber));
  setSessionDriverColors(session.driver_info);
  useF1Store.setState({
    ...INITIAL, sessionType: 'R', loadedSessionType: 'R', sessionData: session, drivers: session.driver_info,
    trackStatus: session.track_status || [], sessionTimeOffset: offset, maxLap, totalRaceLaps: maxLap, currentLap,
    totalFrames: 10000, currentTime: sessionTime - offset, ...extra,
  });
}
const tags = (markup, re) => [...markup.matchAll(re)].map((m) => m[0]);

describe.skipIf(!haveMonza)('Circle of Doom, Monza 2024 lap 15, HAM selected', () => {
  it('context leaders: the leader grey mixed toward the panel (>= 2:1), no opacity attribute', () => {
    replayAt(monza, 4600, 15, { selectedDrivers: ['HAM'] });
    const markup = renderToString(React.createElement(CircleOfDoom));
    const leaders = tags(markup, /<line class="cod-leader"[^>]*>/g);
    expect(leaders.length).toBeGreaterThan(0);
    const expected = contextColor('rgba(255,255,255,0.28)', SURFACES.panel);
    let context = 0;
    for (const l of leaders) {
      expect(l, 'no opacity on a leader').not.toMatch(/\sopacity="/);
      const m = l.match(/style="stroke:([^";]+)/);
      if (m) {
        context += 1;
        expect(m[1].toUpperCase()).toBe(expected);
      }
    }
    expect(context).toBeGreaterThan(0);
    expect(contrastRatio(expected, SURFACES.panel)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
    // what the opacity used to give
    expect(contrastRatio(compositeOver('rgba(255,255,255,0.084)', SURFACES.panel), SURFACES.panel)).toBeLessThan(1.5);
  });

  it('context labels: muted text at full opacity (>= 3:1), the selected car keeps its colour', () => {
    replayAt(monza, 4600, 15, { selectedDrivers: ['HAM'] });
    const markup = renderToString(React.createElement(CircleOfDoom));
    const dimmed = tags(markup, /<text class="cod-label[^"]*cod-label--dim"[^>]*><tspan class="cod-label__code" fill="([^"]+)"/g);
    expect(dimmed.length).toBeGreaterThan(5);
    for (const t of dimmed) {
      expect(t).not.toMatch(/opacity/);
      const fill = t.match(/fill="([^"]+)"$/)[1];
      expect(fill).toBe(TEXT_COLORS.muted);
      expect(contrastRatio(fill, SURFACES.panel)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
    }
    const ham = markup.match(/<text class="(cod-label[^"]*)"[^>]*data-driver="HAM"/);
    expect(ham).toBeTruthy();
    expect(ham[1]).not.toContain('cod-label--dim');
  });
});

// The synthetic race with `abbr` `extra` s slower on every lap (in its last
// sector), so the leader laps it after about 82 / extra laps
function withSlowCar(session, abbr, extra) {
  const r3 = (v) => (v == null ? v : Math.round(v * 1000) / 1000);
  const lapTimes = session.lap_times.map((row) => {
    if (row.Driver !== abbr) return row;
    const n = row.LapNumber;
    const shift = (k) => (v) => (v == null ? v : r3(v + extra * k));
    return {
      ...row,
      Time: shift(n)(row.Time),
      LapStartTime: shift(n - 1)(row.LapStartTime),
      LapTime: r3(row.LapTime + extra),
      LapTimeSeconds: r3(row.LapTimeSeconds + extra),
      Sector3Time: r3(row.Sector3Time + extra),
      Sector3TimeSeconds: r3(row.Sector3TimeSeconds + extra),
      Sector1SessionTime: shift(n - 1)(row.Sector1SessionTime),
      Sector2SessionTime: shift(n - 1)(row.Sector2SessionTime),
      Sector3SessionTime: shift(n)(row.Sector3SessionTime),
      PitInTimeSeconds: shift(n)(row.PitInTimeSeconds),
      PitOutTimeSeconds: shift(n - 1)(row.PitOutTimeSeconds),
    };
  });
  return { ...session, lap_times: lapTimes };
}

describe('Circle of Doom, synthetic race: a lapped car is hollow, not faded', () => {
  const session = withSlowCar(syntheticSession(20), 'RUS', 9);
  const offset = computeSessionTimeOffset(session.lap_times);
  const atLap = (lap, extra = {}) => {
    setSessionDriverColors(session.driver_info);
    useF1Store.setState({
      ...INITIAL, sessionType: 'R', loadedSessionType: 'R', sessionData: session, drivers: session.driver_info,
      trackStatus: session.track_status, sessionTimeOffset: offset, maxLap: 20, totalRaceLaps: 20, currentLap: lap,
      totalFrames: 0, currentTime: 0, ...extra,
    });
  };
  const carTag = (markup, d) => {
    const m = markup.match(new RegExp(`<g class="cod-car[^"]*" data-driver="${d}"[^>]*>(.*?)</g>`));
    return m ? m[1] : null;
  };
  const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const circles = (inner) => [...inner.matchAll(/<circle [^>]*>/g)].map((m) => attrs(m[0]));

  it('RUS (second Mercedes, lapped): panel fill, a 1.5 px ring of its mark colour inside the dot, the white cue outside', () => {
    atLap(15);
    const lapTimes = useF1Store.getState().sessionData.lap_times;
    const leaderEnd = Math.min(...lapTimes.filter((r) => r.LapNumber === 14).map((r) => r.Time));
    const st = circleState(lapTimes, { sessionNow: leaderEnd });
    expect(st.cars.find((c) => c.driver === 'RUS').lapOffsetToLeader).toBeGreaterThan(0);
    const markup = renderToString(React.createElement(CircleOfDoom));
    const parts = circles(carTag(markup, 'RUS'));
    const hit = parts.find((c) => c.class === 'cod-car__hit');
    const rad = Number(hit.r) - 5;
    const dot = parts.find((c) => /\bcod-car__dot--hollow\b/.test(c.class || ''));
    expect(dot.fill).toBe(SURFACES.panel);
    expect(dot.stroke).toBe(markColor(getDriverColor('RUS'), SURFACES.panel));
    expect(Number(dot['stroke-width'])).toBe(1.5);
    expect(Number(dot.r)).toBeCloseTo(rad - 0.75, 6);
    const cue = parts.find((c) => c.class === 'cod-car__second');
    expect(cue).toMatchObject({ fill: 'none', stroke: '#fff', 'stroke-width': '1.5' });
    expect(Number(cue.r)).toBeCloseTo(rad + 0.75, 6);
    // no opacity on any car mark
    expect(markup).not.toMatch(/<g class="cod-car[^>]*>[^]*?(fill-opacity|stroke-opacity)/);
    // a car on the leader's lap keeps its filled dot
    const ham = circles(carTag(markup, 'HAM')).find((c) => c.class === 'cod-car__dot');
    expect(ham.fill).toBe(markColor(getDriverColor('HAM'), SURFACES.panel));
    expect(markup).not.toMatch(/data-driver="HAM"[^>]*>(?:(?!<\/g>).)*cod-car__dot--hollow/);
  });

  it('selected: the ring sits 3 px out from a hollow car, 2 px from a filled one', () => {
    atLap(15, { selectedDrivers: ['RUS', 'HAM'] });
    const markup = renderToString(React.createElement(CircleOfDoom));
    for (const [d, gap] of [['RUS', 3], ['HAM', 2]]) {
      const parts = circles(carTag(markup, d));
      const rad = Number(parts.find((c) => c.class === 'cod-car__hit').r) - 5;
      expect(Number(parts.find((c) => c.class === 'cod-select-ring').r), d).toBeCloseTo(rad + gap, 6);
    }
  });

  it('a car in the pit lane that is not lapped keeps its filled dot on the inner arc', () => {
    const row = session.lap_times.find((r) => r.Driver === 'NOR' && r.PitInTimeSeconds != null);
    // the replay clock 5 s after NOR's pit entry
    atLap(row.LapNumber, { totalFrames: 10000, currentTime: row.PitInTimeSeconds + 5 - offset, maxTime: 1e6, frameDt: 0.4 });
    const markup = renderToString(React.createElement(CircleOfDoom));
    expect(markup).toMatch(/<g class="cod-car cod-car--pit" data-driver="NOR" data-pit="true"/);
    const dot = circles(carTag(markup, 'NOR')).find((c) => /cod-car__dot/.test(c.class || ''));
    expect(dot.class).toBe('cod-car__dot');
    expect(dot.fill).toBe(markColor(getDriverColor('NOR'), SURFACES.panel));
  });

  it("the legend's 'lapped (1L)' swatch is the hollow mark, the legend keeps its 9 items", () => {
    atLap(15);
    const markup = renderToString(React.createElement(CircleOfDoom));
    const items = [...markup.matchAll(/<div class="legend-item cod-legend__item" title="([^"]+)"/g)].map((m) => m[1]);
    expect(items).toHaveLength(9);
    const lapped = markup.match(/title="lapped \(1L\)"><svg[^>]*>(<circle [^>]*>)/);
    expect(attrs(lapped[1])).toMatchObject({
      class: 'cod-car__dot--hollow', fill: SURFACES.panel, stroke: TEXT_COLORS.muted, 'stroke-width': '1.5', r: '3.25',
    });
  });
});
