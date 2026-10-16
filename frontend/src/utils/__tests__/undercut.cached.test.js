// utils/undercut.js on cached races (skipped without the cache): the Monza
// 2024 undercut sweep (rows differ by pit lap; every row read at the race end,
// lead decision D2; where the best lap falls with this race's estimates at the
// time and with the whole race's) and the "pit in k laps" tables (k = 0..10,
// focus LEC and PIA), k = 0 equal to the pit window for every focus over Monza
// and China, k capped by the laps left. frontend/scripts/s7_undercut_monza.mjs
// prints the sweep (docs/evidence/s7_undercut_monza.txt),
// frontend/scripts/c4_pit_in_k_monza.mjs the "pit in k laps" tables
// (docs/evidence/c4_pit_in_k_monza.txt).
import { describe, it, expect } from 'vitest';
import {
  undercutSweep, pitInLaps, tyreStates, PIT_IN_LAPS_MAX,
} from '../undercut.js';
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

  it('every row read at the race end; with no tyre model (zero degradation, zero fresh-tyre delta) every row has the same gap', () => {
    for (const [focus, rival] of PAIRS) {
      const now = endOf(monza, focus, 12) + 0.001;
      const s = inputs(monza, now);
      const zero = { mean: 0, median: 0, stdDev: 0, n: 1, negativeCount: 0, source: 'race' };
      const flat = { ...s.rp, tyreDeg: { SOFT: zero, MEDIUM: zero, HARD: zero }, freshDelta: 0 };
      const sw = undercutSweep(focus, rival, s.st, s.pitLoss, flat, { rivalStopLap: realStop(monza, rival) });
      expect(sw.rows).toHaveLength(16);
      expect(sw.horizon).toEqual({ lap: 53, source: 'race-end' });
      for (const r of sw.rows) expect(r.horizonLap).toBe(53);
      const gaps = sw.rows.map((r) => r.gap);
      // the pace difference of the two cars counts the same in every row: no spread
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9);
    }
  });

  it('end of laps 8-13, the six NOR / LEC / PIA pairs: rows differ by pit lap; the best lap is the wear balance over the whole race (D2)', () => {
    const tally = { causal: { cases: 0, near: 0, best: new Set() }, whole: { cases: 0, near: 0, best: new Set() } };
    for (const [focus, rival] of PAIRS) {
      for (let lap = 8; lap <= 13; lap++) {
        const now = endOf(monza, focus, lap) + 0.001;
        const s = inputs(monza, now);
        const causal = undercutSweep(focus, rival, s.st, s.pitLoss, s.rp);
        const hindsight = undercutSweep(focus, rival, s.st, whole.pitLoss, whole.rp);
        for (const [label, sw] of [['causal', causal], ['whole', hindsight]]) {
          expect(sw.available).toBe(true);
          expect(sw.rows).toHaveLength(16);
          expect(sw.horizonLap).toBe(53);
          // rows differ by pit lap
          expect(new Set(sw.rows.map((r) => r.gap.toFixed(6))).size).toBe(sw.rows.length);
          // one horizon, the rival's crossing the same in every row
          expect(new Set(sw.rows.map((r) => r.rivalCrossing)).size).toBe(1);
          // feasibility (P90 stint length): with the estimates at the time (MEDIUM P90 36-40 laps) no
          // row needs an extra stop; with the whole race's (MEDIUM P90 27) a MEDIUM run past lap 27 does
          for (const r of sw.rows) {
            const extra = label === 'whole' && r.inLap > 27 ? [{ lap: 27, compound: 'HARD' }] : [];
            expect(r.extraStops).toEqual(extra);
          }
          tally[label].cases += 1;
          tally[label].best.add(sw.best.inLap);
          if (sw.best.inLap >= 14 && sw.best.inLap <= 16) tally[label].near += 1;
        }
        // the best row is the closed-form balance of the lap model over the race:
        // the first in-lap p with dM (a0 + p - n + 2) >= dH (H - p)
        const dM = degradationFor(s.rp, 'MEDIUM').mean;
        const dH = degradationFor(s.rp, 'HARD').mean;
        const a0 = causal.focusTyre.tyreAge;
        const n = causal.focusTyre.lapsCompleted;
        let p = n + 1;
        while (dM * (a0 + p - n + 2) < dH * (53 - p)) p += 1;
        expect(causal.best.inLap).toBe(p);
      }
    }
    console.log(`best in-lap (the real stops NOR L14, LEC L15, PIA L16): estimates at the time ${[...tally.causal.best]} `
      + `(in L14-16 ${tally.causal.near}/${tally.causal.cases}); whole race ${[...tally.whole.best]} (in L14-16 ${tally.whole.near}/${tally.whole.cases})`);
    // the data-driven inputs put the balance after the real stops (MEDIUM / HARD = 1.62 with the
    // cached races' estimates at the time; a best lap of L15 needs 2.24:
    // docs/evidence/s7_undercut_monza.txt section 4)
    expect([...tally.causal.best]).toEqual([19]);
    expect([...tally.whole.best].sort()).toEqual([24, 25, 26]);
    expect(tally.causal.near).toBe(0);
  });

  it('the best lap does not depend on the table length or on the rival\'s stop (D2)', () => {
    const now = endOf(monza, 'LEC', 10) + 0.001;
    const s = inputs(monza, now);
    const full = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { sweepLaps: 60 });
    for (const sweepLaps of [10, 15, 20, 30]) {
      const sw = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { sweepLaps });
      expect(sw.horizonLap).toBe(53);
      expect(sw.best.inLap).toBe(full.best.inLap);
      for (const r of sw.rows) expect(r.gap).toBeCloseTo(full.rows.find((x) => x.inLap === r.inLap).gap, 9);
    }
    const base = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { rivalStopLap: 12 });
    for (const q of [14, 16, 20, 25]) {
      const sw = undercutSweep('LEC', 'PIA', s.st, s.pitLoss, s.rp, { rivalStopLap: q });
      expect(sw.rivalStop).toMatchObject({ inLap: q, source: 'chosen' });
      expect(sw.best.inLap).toBe(base.best.inLap);
      sw.rows.forEach((r, i) => expect(r.gap - sw.rows[0].gap).toBeCloseTo(base.rows[i].gap - base.rows[0].gap, 9));
    }
  });

  it('D4: a chosen stop of the rival is dropped once in its past or after it has changed tyres', () => {
    const s10 = inputs(monza, endOf(monza, 'LEC', 10) + 0.001);
    const chosen = undercutSweep('LEC', 'PIA', s10.st, s10.pitLoss, s10.rp, { rivalStopLap: 16 });
    expect(chosen.rivalStop).toMatchObject({ inLap: 16, source: 'chosen' });
    const stints = chosen.rivalTyre.stints;
    expect(stints).toBe(1);
    const s20 = inputs(monza, endOf(monza, 'LEC', 20) + 0.001);
    const past = undercutSweep('LEC', 'PIA', s20.st, s20.pitLoss, s20.rp, { rivalStopLap: 16, rivalStopStints: stints });
    expect(past.rivalStop).toMatchObject({ source: 'race', expiredChoice: 16, expiredReason: 'past' });
    const changed = undercutSweep('LEC', 'PIA', s20.st, s20.pitLoss, s20.rp, { rivalStopLap: 40, rivalStopStints: stints });
    expect(changed.rivalTyre.stints).toBe(2);
    expect(changed.rivalStop).toMatchObject({ source: 'race', expiredChoice: 40, expiredReason: 'tyre-change' });
    // no phantom second stop: the same rows as with no choice
    const none = undercutSweep('LEC', 'PIA', s20.st, s20.pitLoss, s20.rp);
    expect(changed.rows.map((r) => r.gap)).toEqual(none.rows.map((r) => r.gap));
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

describe.skipIf(!hasCachedSession(2024, 22))('2024 R22: pit-lane visits and "pit in k laps" (D3, R2 / R3)', () => {
  it('t = 4518.3 s: OCO past its exit with no tyre change keeps its set; ZHO and LAW, still in the pit lane, get a new set', () => {
    const s22 = loadCachedSession(2024, 22);
    const now = 4518.3;
    const s = inputs(s22, now);
    const tyres = tyreStates(s22.lap_times, now);
    expect(tyres.get('OCO')).toMatchObject({ compound: 'MEDIUM', tyreAge: 11, inPitLane: false, fitted: null, stints: 1 });
    for (const d of ['ZHO', 'LAW']) expect(tyres.get(d)).toMatchObject({ inPitLane: true, fitted: null });
    const sw = undercutSweep('HUL', 'OCO', s.st, s.pitLoss, s.rp);
    expect(sw.rivalStop.source).toBe('in progress');
    expect(sw.rivalNextCompound).toBeNull();
    // the C4 table of docs/evidence/c4_pit_in_k_monza.txt section 4
    const hul = pitInLaps('HUL', s.st, s.pitLoss, s.rp);
    expect([hul.rows[1].predictedPosition, hul.rows[1].positionsVsNow]).toEqual([18, -1]);
    expect([hul.rows[2].predictedPosition, hul.rows[2].positionsVsNow]).toEqual([19, -2]);
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
