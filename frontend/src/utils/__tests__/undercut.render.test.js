// Undercut Calculator (S7) rendered with a real store state (cached Monza
// 2024): the rows are utils/undercut.js undercutSweep's at the store's clock
// (one per candidate in-lap, signed gap once both have stopped), the best row,
// the signed NEW-TYRE GAIN (no absolute value), the rival's stop and its
// source, and the note when this race's degradation fits are negative.
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const { useF1Store } = await import('../../store/useF1Store.js');
const { default: UndercutCalculator } = await import('../../components/visualizations/UndercutCalculator.jsx');
const { undercutSweep } = await import('../undercut.js');
const { circleState } = await import('../circleOfDoom.js');
const { extractRaceParams } = await import('../raceSimulation.js');
const { estimatePitLoss } = await import('../pitLoss.js');
const { computeSessionTimeOffset } = await import('../raceTime.js');
const { driverStateAt } = await import('../driverState.js');
const { stintsByDriver } = await import('../stints.js');
const { hasCachedSession, loadCachedSession } = await import('../../__tests__/helpers/cachedSession.js');

const INITIAL = useF1Store.getState();
const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const textOf = (markup) => markup
  .replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ');
const MINUS = '−';
const fmt = (s) => `${s >= 0 ? '+' : MINUS}${Math.abs(s).toFixed(2)}s`;

function replayAt(sessionTime, currentLap, extra = {}) {
  const offset = computeSessionTimeOffset(monza.lap_times);
  const maxLap = Math.max(...monza.lap_times.map((r) => r.LapNumber));
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    loadedSessionType: 'R',
    sessionData: monza,
    drivers: monza.driver_info,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: offset,
    maxLap,
    totalRaceLaps: maxLap,
    currentLap,
    totalFrames: 10000,
    currentTime: sessionTime - offset,
    ...extra,
  });
}

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
});

describe.skipIf(!haveMonza)('Undercut Calculator: the sweep of utils/undercut.js, signed', () => {
  for (const [focus, rival, lap] of [['LEC', 'PIA', 13], ['NOR', 'LEC', 13], ['LEC', 'NOR', 30]]) {
    it(`${focus} vs ${rival}, just after ${focus} completes lap ${lap - 1}`, () => {
      const now = monza.lap_times.find((r) => r.Driver === focus && r.LapNumber === lap - 1).Time + 0.001;
      replayAt(now, lap, { focusDriver: focus, comparisonDriver: rival });
      const lt = monza.lap_times;
      const st = circleState(lt, { sessionNow: now });
      const pitLoss = estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' });
      const rp = extractRaceParams(lt, [], monza.track_status, lap, { sessionNow: now, sessionType: 'R' });
      const sw = undercutSweep(focus, rival, st, pitLoss, rp, { totalLaps: 53 });
      const m = renderToString(React.createElement(UndercutCalculator));
      const t = textOf(m);
      // one row per candidate in-lap, in order, each with its signed gap
      const rows = [...m.matchAll(/data-inlap="(\d+)"/g)].map((x) => Number(x[1]));
      expect(rows).toEqual(sw.rows.map((r) => r.inLap));
      for (const r of sw.rows) expect(t).toContain(fmt(r.gap));
      // rows differ by pit lap. With the same degradation on the old and the
      // new set the gap is symmetric about the wear balance, so two rows on
      // either side of it can be equal: at least half the rows are distinct
      expect(new Set(sw.rows.map((r) => r.gap.toFixed(6))).size).toBeGreaterThanOrEqual(Math.ceil(sw.rows.length / 2));
      // one lap for every row, named in the header
      expect(t).toContain(`gap at the end of L${sw.horizonLap}, both stopped in every row`);
      // the tyre chips: the set on each car now (driverStateAt, R6)
      const stints = stintsByDriver(lt, { sessionNow: now });
      for (const d of [focus, rival]) {
        const ds = driverStateAt(lt, d, now, { stints });
        expect(t).toContain(`${ds.compound[0]}·L${ds.tyreLife}`);
      }
      // best row and verdict
      expect(t).toContain(`Best pit lap: L${sw.best.inLap}`);
      expect(t).toContain(sw.best.gap > 0 ? 'AHEAD AFTER BOTH STOPS' : 'BEHIND AFTER BOTH STOPS');
      // the gap now and the new-tyre gain are signed, never absolute values
      expect(t).toContain(`GAP NOW ${fmt(sw.currentGap)}`);
      const gain = `${sw.freshGain >= 0 ? '+' : MINUS}${Math.abs(sw.freshGain).toFixed(3)}s`;
      expect(t).toContain(`NEW-TYRE GAIN ${gain}`);
      // the rival's stop, from the stint-life survival
      expect(t).toContain(`RIVAL STOPS likely`);
      expect(t).toContain(sw.rivalStop.inRace ? `L${sw.rivalStop.inLap} · stint-life survival of this race` : 'no stop before the flag');
      // negative fits are said, not hidden
      const negative = sw.degradation.focus.mean < 0;
      expect(t.includes('the model makes a new set slower')).toBe(negative);
      console.log(`${focus} vs ${rival} L${lap}: gap now ${fmt(sw.currentGap)}, new-tyre gain ${gain}, rival L${sw.rivalStop.inLap}, `
        + `best L${sw.best.inLap} ${fmt(sw.best.gap)}; rows ${sw.rows.map((r) => `L${r.inLap} ${fmt(r.gap)}`).join(' ')}`);
    });
  }
});
