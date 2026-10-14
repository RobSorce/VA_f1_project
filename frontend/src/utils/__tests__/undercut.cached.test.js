// utils/undercut.js on cached races (skipped without the cache): the Monza
// 2024 undercut sweep (rows differ by pit lap; where the best lap falls with
// this race's estimates at the time and with the whole race's) and the
// "pit in k laps" tables (k = 0..10, focus LEC and PIA), k = 0 equal to the
// pit window for every focus over Monza and China, k capped by the laps left.
// frontend/scripts/undercut_monza.mjs prints the same tables
// (notes/experiments/undercut_monza.txt).
import { describe, it, expect } from 'vitest';
import { undercutSweep, pitInLaps, PIT_IN_LAPS_MAX } from '../undercut.js';
import { circleState, pitWindow } from '../circleOfDoom.js';
import { extractRaceParams, degradationFor } from '../raceSimulation.js';
import { estimatePitLoss } from '../pitLoss.js';
import { hasCachedSession, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';

const haveMonza = hasCachedSession(2024, 16);
const haveChina = hasCachedSession(2024, 5);
const sgn = (v, d = 2) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}`;

function inputs(session, now) {
  const lt = session.lap_times;
  return {
    st: circleState(lt, { sessionNow: now }),
    pitLoss: estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' }),
    rp: extractRaceParams(lt, [], session.track_status || [], 1, { sessionNow: now, sessionType: 'R' }),
  };
}
const endOf = (session, drv, lap) => session.lap_times.find((r) => r.Driver === drv && r.LapNumber === lap).Time;
const realStop = (session, drv) => session.lap_times
  .filter((r) => r.Driver === drv && r.PitInTimeSeconds != null)
  .map((r) => r.LapNumber).sort((a, b) => a - b)[0];

describe.skipIf(!haveMonza)('Monza 2024: the undercut sweep (S7)', () => {
  const monza = haveMonza ? loadCachedSession(2024, 16) : null;
  const whole = haveMonza ? {
    pitLoss: estimatePitLoss(monza.lap_times, { sessionNow: Infinity, sessionType: 'R' }),
    rp: extractRaceParams(monza.lap_times, [], monza.track_status, 1, { sessionNow: Infinity, sessionType: 'R' }),
  } : null;

  it('the real stops: NOR L14, LEC L15, PIA L16 (in-laps)', () => {
    expect([realStop(monza, 'NOR'), realStop(monza, 'LEC'), realStop(monza, 'PIA')]).toEqual([14, 15, 16]);
  });

  const PAIRS = [['LEC', 'PIA'], ['PIA', 'LEC'], ['NOR', 'PIA'], ['PIA', 'NOR'], ['NOR', 'LEC'], ['LEC', 'NOR']];

  it('every row read at one lap; with no tyre model (zero degradation, zero fresh-tyre delta) every row has the same gap', () => {
    for (const [focus, rival] of PAIRS) {
      const now = endOf(monza, focus, 12) + 0.001;
      const s = inputs(monza, now);
      const zero = { mean: 0, median: 0, stdDev: 0, n: 1, negativeCount: 0, source: 'race' };
      const flat = { ...s.rp, tyreDeg: { SOFT: zero, MEDIUM: zero, HARD: zero }, freshDelta: 0 };
      const sw = undercutSweep(focus, rival, s.st, s.pitLoss, flat, { rivalStopLap: realStop(monza, rival) });
      expect(sw.rows).toHaveLength(16);
      for (const r of sw.rows) expect(r.horizonLap).toBe(sw.horizonLap);
      const gaps = sw.rows.map((r) => r.gap);
      // the pace difference of the two cars counts the same in every row: no spread
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9);
    }
  });

  it('end of laps 8-13, the six NOR / LEC / PIA pairs: rows differ by pit lap; the best lap is the wear balance up to the horizon', () => {
    const tally = { causal: { cases: 0, near: 0, first: 0 }, whole: { cases: 0, near: 0, first: 0 } };
    for (const [focus, rival] of PAIRS) {
      for (let lap = 8; lap <= 13; lap++) {
        const now = endOf(monza, focus, lap) + 0.001;
        const s = inputs(monza, now);
        const causal = undercutSweep(focus, rival, s.st, s.pitLoss, s.rp);
        const hindsight = undercutSweep(focus, rival, s.st, whole.pitLoss, whole.rp);
        for (const [label, sw] of [['causal', causal], ['whole', hindsight]]) {
          expect(sw.available).toBe(true);
          expect(sw.rows).toHaveLength(16);
          // rows differ by pit lap
          expect(new Set(sw.rows.map((r) => r.gap.toFixed(6))).size).toBe(sw.rows.length);
          // one horizon, the rival's crossing the same in every row
          expect(new Set(sw.rows.map((r) => r.rivalCrossing)).size).toBe(1);
          tally[label].cases += 1;
          if (sw.best.inLap >= 14 && sw.best.inLap <= 16) tally[label].near += 1;
          if (sw.best.inLap === sw.rows[0].inLap) tally[label].first += 1;
        }
        // with the estimates at the time (MEDIUM above HARD), the wear balance
        // up to the horizon falls before the lap in progress: pit now
        const dM = degradationFor(s.rp, 'MEDIUM').mean;
        const dH = degradationFor(s.rp, 'HARD').mean;
        expect(dM).toBeGreaterThan(dH);
        expect(causal.best.inLap).toBe(causal.rows[0].inLap);
        // with the whole race's (MEDIUM = HARD to 1e-4) the balance is about half way to the horizon
        expect(Math.abs(hindsight.best.inLap - (hindsight.horizonLap - 1) / 2)).toBeLessThanOrEqual(1.5);
      }
    }
    console.log(`best in-lap in L14-16 (the real stops NOR L14, LEC L15, PIA L16): estimates at the time ${tally.causal.near}/${tally.causal.cases}`
      + ` (first row ${tally.causal.first}); whole race ${tally.whole.near}/${tally.whole.cases} (first row ${tally.whole.first})`);
    // at the end of lap 13 the lap in progress is lap 14: the best is L14 for every pair
    expect(tally.causal.near).toBe(6);
  });

  it('the best lap follows the horizon: read at the flag, it moves later', () => {
    const now = endOf(monza, 'LEC', 12) + 0.001;
    const s = inputs(monza, now);
    const table = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp);
    const flag = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { sweepLaps: 60 });
    expect(flag.horizonLap).toBe(53);
    expect(flag.best.inLap).toBeGreaterThan(table.best.inLap);
  });
});

describe.skipIf(!haveMonza)('Monza 2024: pit in k laps (C4)', () => {
  const monza = haveMonza ? loadCachedSession(2024, 16) : null;

  it('focus LEC and PIA at the end of lap 12, k = 0..10: k = 0 is the pit window, the table', () => {
    for (const focus of ['LEC', 'PIA']) {
      const now = endOf(monza, focus, 12) + 0.001;
      const s = inputs(monza, now);
      const win = pitWindow(focus, s.st, s.pitLoss);
      const pk = pitInLaps(focus, s.st, s.pitLoss, s.rp);
      expect(pk.kMax).toBe(PIT_IN_LAPS_MAX);
      expect(pk.rows).toHaveLength(11);
      expect(pk.rows[0].predictedPosition).toBe(win.predictedPosition);
      expect(pk.rows[0].predictedCrossing).toBe(win.predictedCrossing);
      expect(pk.rows[0].ghostOffset).toBe(win.rejoinOffset);
      console.log(`${focus} end of L12 (P${pk.currentPosition}), ${pk.tyre.compound} age ${pk.tyre.tyreAge} -> ${pk.nextCompound}:\n${
        pk.rows.map((r) => `  k ${r.k}: in-lap L${r.inLap}, P${r.predictedPosition} at L${r.targetLap} `
          + `(pit now: P${r.positionIfPitNow}, ${r.positionsVsNow >= 0 ? '+' : ''}${r.positionsVsNow} vs now, ${sgn(r.secondsVsNow)} s)`).join('\n')}`);
      // the in-laps and target laps follow k
      expect(pk.rows.map((r) => r.inLap)).toEqual(pk.rows.map((r) => 13 + r.k));
      // at lap 12 the lap model wears the MEDIUM set more than the HARD one
      // (the cached races' estimates: no MEDIUM fit long enough yet): every
      // lap of waiting costs time against pitting now
      expect(degradationFor(s.rp, 'MEDIUM').mean).toBeGreaterThan(degradationFor(s.rp, 'HARD').mean);
      for (let k = 1; k <= 10; k++) expect(pk.rows[k].secondsVsNow).toBeGreaterThan(pk.rows[k - 1].secondsVsNow);
    }
  });

  it('later in the race, on positive fits, waiting costs time; k is capped by the laps left', () => {
    const now = endOf(monza, 'LEC', 24) + 0.001;
    const s = inputs(monza, now);
    const pk = pitInLaps('LEC', s.st, s.pitLoss, s.rp);
    expect(degradationFor(s.rp, 'HARD').mean).toBeGreaterThan(0);
    for (let k = 1; k <= 10; k++) expect(pk.rows[k].secondsVsNow).toBeGreaterThan(pk.rows[k - 1].secondsVsNow);
    // end of lap 48: the window's target lap is 50, the race has 53 laps
    const late = inputs(monza, endOf(monza, 'LEC', 48) + 0.001);
    const pkLate = pitInLaps('LEC', late.st, late.pitLoss, late.rp);
    expect(pkLate.anchorLap).toBe(50);
    expect(pkLate.kMax).toBe(3);
  });
});

describe.skipIf(!haveMonza || !haveChina)('k = 0 is the pit window for every focus, every 120 s', () => {
  for (const [name, year, round] of [['Monza 2024', 2024, 16], ['China 2024', 2024, 5]]) {
    it(name, () => {
      const session = loadCachedSession(year, round);
      const lt = session.lap_times;
      const first = Math.min(...lt.filter((r) => r.LapNumber === 2).map((r) => r.LapStartTime));
      const last = Math.max(...lt.map((r) => r.Time ?? 0));
      let windows = 0;
      let mismatches = 0;
      for (let now = first; now < last; now += 120) {
        const s = inputs(session, now);
        for (const c of s.st.cars) {
          const win = pitWindow(c.driver, s.st, s.pitLoss);
          if (!win.available) continue;
          windows += 1;
          const r0 = pitInLaps(c.driver, s.st, s.pitLoss, s.rp).rows[0];
          if (!(r0.predictedPosition === win.predictedPosition && r0.predictedCrossing === win.predictedCrossing
            && r0.ghostOffset === win.rejoinOffset && r0.targetLap === win.targetLap)) mismatches += 1;
        }
      }
      console.log(`${name}: ${windows} pit windows, ${mismatches} k = 0 rows differ`);
      expect(windows).toBeGreaterThan(400);
      expect(mismatches).toBe(0);
    });
  }
});
