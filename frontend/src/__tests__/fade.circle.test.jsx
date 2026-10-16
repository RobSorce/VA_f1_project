// Focus + context in the Circle of Doom: with a selection on, the cars that are not
// selected are context. Their ring labels turn to the muted text colour
// (>= 3:1, in fact 7.63:1 on the panel) and their leader lines are drawn in
// the leader grey mixed toward the panel (contextColor, >= 2:1); nothing of
// theirs is drawn at an opacity below 1 (the leaders read 1.25:1 at the
// former opacity 0.3). Server render of the cached Monza 2024 race (skipped
// without the cache), as circleOfDoom.view.test.js.
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
