// utils/undercut.js on a synthetic race: the lap-model increments after the
// pit window's target lap, "pit in k laps" (k = 0 is the pit window exactly;
// k > 0 moves with the degradation and the fresh-tyre delta, in closed form),
// the undercut sweep (the rival's stop in both branches, the current gap
// counted once, signed gain), the rivals-stop toggle, causality.
import { describe, it, expect } from 'vitest';
import {
  lapIncrements, pitInLaps, undercutSweep, likelyNextCompound, likelyStop, tyreStates,
  PIT_IN_LAPS_MAX, UNDERCUT_SWEEP_LAPS,
} from '../undercut.js';
import { circleState, pitWindow } from '../circleOfDoom.js';
import { FRESH_TYRE_LAPS, PRIORS } from '../raceSimulation.js';
import { perturbFuture } from './futureRows.js';
import { driverStateAt } from '../driverState.js';
import { stintsByDriver } from '../stints.js';

/**
 * The model's inputs of a tyreStates row / a projection without `current`,
 * the set shown now: driverStateAt (R6) counts the TyreLife of the lap in
 * progress as known, perturbFuture rewrites it (conservative), so causality
 * is checked on the model fields and `current` against driverStateAt.
 */
const withoutCurrent = (x) => {
  if (Array.isArray(x)) return x.map(withoutCurrent);
  if (x instanceof Map) return new Map([...x].map(([k, v]) => [k, withoutCurrent(v)]));
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'current').map(([k, v]) => [k, withoutCurrent(v)]));
  }
  return x;
};

// Synthetic race on the SESSION clock, 20 laps of 90 s, every car on MEDIUM
// from the start (TyreLife = lap), start at T0; a car `offset` s behind the
// leader at every line (it loses them on lap 1).
//   LEAD 0, AHD 4, FOC 10 (the focus), B5 15, B12 22, B30 41
// At NOW = T0 + 580 FOC has completed 6 laps (T0 + 550): the pit window's
// target lap is A = 8, FOC's tyre age on A would be 8.
const T0 = 1000;
const NOW = T0 + 580;
const LAPS = 20;

function car(code, offset) {
  const rows = [];
  let start = T0;
  for (let k = 1; k <= LAPS; k++) {
    const dur = k === 1 ? 90 + offset : 90;
    rows.push({
      Driver: code, LapNumber: k, LapStartTime: start, Time: start + dur, LapTimeSeconds: dur,
      TrackStatus: '1', PitInTimeSeconds: null, PitOutTimeSeconds: null,
      Stint: 1, Compound: 'MEDIUM', TyreLife: k,
    });
    start += dur;
  }
  return rows;
}

const RACE = [['LEAD', 0], ['AHD', 4], ['FOC', 10], ['B5', 15], ['B12', 22], ['B30', 41]]
  .flatMap(([c, o]) => car(c, o));
const PIT_LOSS = {
  median: 20, mean: 20, stdDev: 2, p10: 18, p90: 24, n: 5, source: 'race', samples: [],
};

/** raceParams with chosen degradation (s/lap) by compound, fresh-tyre delta and stint life. */
function params({
  dM = 0, dH = 0, fresh = 0, survival = null,
} = {}) {
  const deg = (mean) => ({
    mean, median: mean, stdDev: 0, n: 5, negativeCount: 0, source: 'race',
  });
  return {
    pitLoss: PIT_LOSS,
    tyreDeg: { MEDIUM: deg(dM), HARD: deg(dH) },
    freshDelta: fresh,
    estimates: {
      freshDelta: {
        value: fresh, raw: fresh, n: 5, laps: 5, clamped: false, source: 'race', freshTyreLaps: FRESH_TYRE_LAPS,
      },
    },
    stintLength: survival ? {
      MEDIUM: {
        survival, median: 9, mean: 9, n: 5, events: 5, censored: 0, dropped: 0, source: 'race',
      },
    } : {},
    transitions: { MEDIUM: { HARD: 3 } },
    dryRace: true,
  };
}

const state = (now = NOW, lapTimes = RACE) => circleState(lapTimes, { sessionNow: now });

describe('lapIncrements: the lap model after the window\'s target lap', () => {
  it('0 up to the anchor, deg x (age - tA) after it, out-lap = in-lap, fresh delta on age 2 only', () => {
    // set of age 5 after lap 10, anchor 12 (tA = 7), stop at the end of lap 13 to HARD
    const inc = lapIncrements({
      raceParams: params({ dM: 0.1, dH: 0.05, fresh: -0.5 }),
      compound: 'MEDIUM',
      tyreAge: 5,
      refAge: 7,
      fromLap: 11,
      toLap: 17,
      anchorLap: 12,
      stops: [{ lap: 13, compound: 'HARD' }],
    });
    const d = inc.laps.map((r) => Number(r.delta.toFixed(10)));
    // 11, 12: anchor; 13: in-lap 0.1 x (8 - 7); 14: out-lap = in-lap;
    // 15: HARD age 2: 0.05 x 2 - 0.1 x 7 - 0.5; 16: age 3, no fresh delta; 17: age 4
    expect(d).toEqual([0, 0, 0.1, 0.1, -1.1, -0.55, -0.5]);
    expect(inc.laps.map((r) => [r.lap, r.compound, r.tyreAge, r.inLap, r.outLap])).toEqual([
      [11, 'MEDIUM', 6, false, false], [12, 'MEDIUM', 7, false, false], [13, 'MEDIUM', 8, true, false],
      [14, 'HARD', 1, false, true], [15, 'HARD', 2, false, false], [16, 'HARD', 3, false, false],
      [17, 'HARD', 4, false, false],
    ]);
    expect(inc.total).toBeCloseTo(0.1 + 0.1 - 1.1 - 0.55 - 0.5, 12);
  });

  it('zero degradation and no fresh-tyre delta: every lap at the pace (flat)', () => {
    const inc = lapIncrements({
      raceParams: params(), compound: 'MEDIUM', tyreAge: 5, refAge: 7, fromLap: 11, toLap: 30, anchorLap: 12,
      stops: [{ lap: 15, compound: 'HARD' }],
    });
    expect(inc.laps.every((r) => r.delta === 0)).toBe(true);
    expect(inc.total).toBe(0);
  });
});

describe('likelyNextCompound / likelyStop / tyreStates', () => {
  it('next compound: this race\'s most frequent change, the two-dry-compound rule, else the prior', () => {
    expect(likelyNextCompound(params(), 'MEDIUM', ['MEDIUM'])).toBe('HARD');
    // MEDIUM -> MEDIUM is not allowed before a second dry compound is used
    expect(likelyNextCompound({ transitions: { MEDIUM: { MEDIUM: 9, SOFT: 1 } }, dryRace: true }, 'MEDIUM', ['MEDIUM']))
      .toBe('SOFT');
    // after two dry compounds any is allowed
    expect(likelyNextCompound({ transitions: { MEDIUM: { MEDIUM: 9, SOFT: 1 } }, dryRace: true }, 'MEDIUM', ['HARD', 'MEDIUM']))
      .toBe('MEDIUM');
    // nothing in this race: the cached races' changes (PRIORS.transitions)
    const prior = PRIORS.transitions.MEDIUM;
    const top = ['SOFT', 'HARD'].sort((a, b) => (prior[b] || 0) - (prior[a] || 0))[0];
    expect(likelyNextCompound({ dryRace: true }, 'MEDIUM', ['MEDIUM'])).toBe(top);
    expect(likelyNextCompound(params(), 'INTERMEDIATE', [])).toBe('INTERMEDIATE');
  });

  it('likely stop: the in-lap the set reaches the conditional median life', () => {
    const survival = Array.from({ length: 21 }, (_, t) => (t < 9 ? 1 : t === 9 ? 0.4 : 0));
    expect(likelyStop(params({ survival }), { compound: 'MEDIUM', tyreAge: 6, lapsCompleted: 6 }))
      .toEqual({
        inLap: 9, dueAge: 9, source: 'race', n: 5,
      });
    // never that low: the set runs to the flag
    const never = Array.from({ length: 21 }, () => 1);
    expect(likelyStop(params({ survival: never }), { compound: 'MEDIUM', tyreAge: 6, lapsCompleted: 6 }).inLap).toBe(null);
  });

  it('tyre states from the latest completed lap, causal; the set shown now is driverStateAt\'s (R6)', () => {
    const t = tyreStates(RACE, NOW);
    const ds = driverStateAt(RACE, 'FOC', NOW, { stints: stintsByDriver(RACE, { sessionNow: NOW }) });
    expect(t.get('FOC')).toEqual({
      driver: 'FOC', compound: 'MEDIUM', tyreAge: 6, lapsCompleted: 6, used: ['MEDIUM'], fitted: null,
      current: { compound: ds.compound, tyreLife: ds.tyreLife }, inPitLane: ds.inPitLane,
    });
    expect(t.get('B30').lapsCompleted).toBe(5);
    expect(withoutCurrent(tyreStates(perturbFuture(RACE, NOW), NOW))).toEqual(withoutCurrent(t));
  });

  it('after the pit exit the new set is shown and modelled (R3 / R6): fitted, never the old set or a guess', () => {
    // FOC boxes at the end of lap 6 and leaves the pits on lap 7 on a used HARD (TyreLife 3 on its out-lap)
    const rows = RACE.map((r) => {
      if (r.Driver !== 'FOC') return r;
      if (r.LapNumber === 6) return { ...r, PitInTimeSeconds: r.Time - 3 };
      if (r.LapNumber >= 7) {
        const out = { ...r, Compound: 'HARD', Stint: 2, TyreLife: r.LapNumber - 4 };
        if (r.LapNumber === 7) out.PitOutTimeSeconds = r.LapStartTime + 20;
        return out;
      }
      return r;
    });
    const exit = rows.find((r) => r.Driver === 'FOC' && r.LapNumber === 7).PitOutTimeSeconds;
    const before = tyreStates(rows, exit - 1).get('FOC');
    expect(before.current.compound).toBe('MEDIUM');
    expect(before.fitted).toBeNull();
    const after = tyreStates(rows, exit + 1).get('FOC');
    const ds = driverStateAt(rows, 'FOC', exit + 1, { stints: stintsByDriver(rows, { sessionNow: exit + 1 }) });
    expect(after.current).toEqual({ compound: 'HARD', tyreLife: 3 });
    expect([ds.compound, ds.tyreLife]).toEqual(['HARD', 3]);
    expect(after.fitted).toEqual({ compound: 'HARD', tyreLife: 3 });
    // the model's start (the latest completed lap) is still the old set
    expect([after.compound, after.tyreAge]).toEqual(['MEDIUM', 6]);
  });
});

describe('pitInLaps: "pit in k laps"', () => {
  const st = state();

  it('k = 0 is the pit window exactly (crossing, rank, rejoin offset), every focus, several clocks', () => {
    let checked = 0;
    for (const now of [T0 + 300, NOW, T0 + 1000, T0 + 1500]) {
      const s = state(now);
      for (const c of s.cars) {
        for (const rp of [params(), params({ dM: 0.2, dH: -0.1, fresh: -0.7 })]) {
          for (const rivalsStop of [false]) {
            const win = pitWindow(c.driver, s, PIT_LOSS);
            const pk = pitInLaps(c.driver, s, PIT_LOSS, rp, { rivalsStop });
            expect(pk.available).toBe(win.available);
            if (!win.available) continue;
            const r0 = pk.rows[0];
            expect(r0.k).toBe(0);
            expect(r0.targetLap).toBe(win.targetLap);
            expect(r0.predictedCrossing).toBe(win.predictedCrossing);
            expect(r0.predictedPosition).toBe(win.predictedPosition);
            expect(r0.positionIfPitNow).toBe(win.predictedPosition);
            expect(r0.positionsVsNow).toBe(0);
            expect(r0.secondsVsNow).toBe(0);
            expect(r0.rejoinSeconds).toBe(win.rejoinSeconds);
            expect(r0.ghostOffset).toBe(win.rejoinOffset);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('k runs 0..PIT_IN_LAPS_MAX, capped by the laps the focus car has left', () => {
    const pk = pitInLaps('FOC', st, PIT_LOSS, params());
    expect(PIT_IN_LAPS_MAX).toBe(10);
    expect(pk.kMax).toBe(10);
    expect(pk.rows.map((r) => [r.k, r.inLap, r.targetLap])).toEqual(
      Array.from({ length: 11 }, (_, k) => [k, 7 + k, 8 + k]),
    );
    // at the end of lap 15 the window's target is lap 17: k <= 20 - 17
    const late = pitInLaps('FOC', state(T0 + 10 + 90 * 15 + 1), PIT_LOSS, params());
    expect(late.anchorLap).toBe(17);
    expect(late.kMax).toBe(3);
    expect(late.rows.at(-1).targetLap).toBe(LAPS);
  });

  it('no degradation and no fresh-tyre delta: waiting changes nothing, the ghost is the rejoin', () => {
    const pk = pitInLaps('FOC', st, PIT_LOSS, params());
    const win = pitWindow('FOC', st, PIT_LOSS);
    for (const r of pk.rows) {
      expect(r.secondsVsNow).toBe(0);
      expect(r.positionsVsNow).toBe(0);
      // every car laps the reference lap (90 s): the ghost does not move
      expect(r.ghostOffset).toBeCloseTo(win.rejoinOffset, 12);
    }
  });

  it('k > 0 follows the degradation and the fresh-tyre delta (closed form)', () => {
    // FOC: MEDIUM of age 6, A = 8, tA = 8; branch k stays out to in-lap 7 + k;
    // pitting now: HARD from lap 9 at ages 2..k + 1
    for (const [dM, dH, fresh] of [[0.1, 0.05, -0.5], [0.3, 0.02, 0], [-0.05, 0.1, -0.2], [0, 0, -1]]) {
      const pk = pitInLaps('FOC', st, PIT_LOSS, params({ dM, dH, fresh }));
      expect(pk.nextCompound).toBe('HARD');
      for (const r of pk.rows) {
        const { k } = r;
        if (k === 0) continue;
        const wait = dM * (((k - 1) * k) / 2 + (k - 1));
        const now = dH * (((k + 1) * (k + 2)) / 2 - 1) - 8 * k * dM + fresh;
        expect(r.secondsVsNow).toBeCloseTo(wait - now, 9);
      }
    }
  });

  it('more wear on the set in use makes waiting cost more; a stronger fresh-tyre delta too', () => {
    const at = (p) => pitInLaps('FOC', st, PIT_LOSS, params(p)).rows;
    const low = at({ dM: 0.05, dH: 0.05 });
    const high = at({ dM: 0.15, dH: 0.05 });
    const fresh = at({ dM: 0.05, dH: 0.05, fresh: -0.4 });
    for (let k = 1; k <= 10; k++) {
      expect(high[k].secondsVsNow).toBeGreaterThan(low[k].secondsVsNow);
      // the pit-now branch has had its first flying lap by lap 8 + k: exactly |fresh| more
      expect(fresh[k].secondsVsNow - low[k].secondsVsNow).toBeCloseTo(0.4, 9);
      // positions follow the seconds: waiting never ends better than pitting now when it costs time
      expect(high[k].positionsVsNow).toBeLessThanOrEqual(0);
    }
    // a heavily worn set: waiting 10 laps costs places against pitting now
    const worn = at({ dM: 1.0, dH: 0.05 });
    expect(worn[10].secondsVsNow).toBeGreaterThan(30);
    expect(worn[10].predictedPosition).toBeGreaterThan(worn[10].positionIfPitNow);
    expect(worn[10].positionsVsNow).toBeLessThan(0);
    // the ghost moves back (clockwise offset grows) with the time lost
    expect(worn[10].ghostOffset).toBeGreaterThan(worn[0].ghostOffset);
  });

  it('rivals stop (toggle): the other cars stop when their sets are due and pay the pit loss', () => {
    // every MEDIUM due at age 9: the cars on lap 6 box at the end of lap 9, B30 too (age 5 + 4)
    const survival = Array.from({ length: 21 }, (_, t) => (t < 9 ? 1 : t === 9 ? 0.4 : 0));
    const off = pitInLaps('FOC', st, PIT_LOSS, params({ survival }));
    const on = pitInLaps('FOC', st, PIT_LOSS, params({ survival }), { rivalsStop: true });
    // pitting now: B5 and B12 (15 and 22 s behind < 20 s + pace) pass: P5 either way at k = 0
    expect(off.rows[0].predictedPosition).toBe(5);
    expect(on.rows[0].predictedPosition).toBe(5);
    expect(on.rows[1].rivalStops).toEqual([]);
    // from target lap 10 (their out-lap) every other car has paid its stop too: back to P3
    for (const k of [2, 5, 10]) {
      expect(off.rows[k].predictedPosition).toBe(5);
      expect(on.rows[k].predictedPosition).toBe(3);
      expect(on.rows[k].rivalStops.sort()).toEqual(['AHD', 'B12', 'B30', 'B5', 'LEAD']);
    }
  });

  it('is causal: rows from the completed laps only', () => {
    const rp = params({ dM: 0.1, dH: 0.05, fresh: -0.3 });
    const a = pitInLaps('FOC', st, PIT_LOSS, rp);
    const b = pitInLaps('FOC', state(NOW, perturbFuture(RACE, NOW)), PIT_LOSS, rp);
    expect(withoutCurrent(b)).toEqual(withoutCurrent(a));
  });

  it('no k > 0 while the focus is already stopping, nothing outside the window', () => {
    expect(pitInLaps(null, st, PIT_LOSS, params())).toMatchObject({ available: false, reason: 'no-focus', kMax: 0 });
    expect(pitInLaps('FOC', state(Infinity), PIT_LOSS, params())).toMatchObject({ available: false, reason: 'race-over' });
    // FOC in the pit lane on lap 7: its stop is projected, k = 0 only
    const rows = RACE.map((r) => (r.Driver === 'FOC' && r.LapNumber === 7 ? { ...r, PitInTimeSeconds: T0 + 10 + 630 - 5 } : r));
    const s = state(T0 + 10 + 630 - 2, rows);
    const pk = pitInLaps('FOC', s, PIT_LOSS, params({ dM: 0.1 }));
    const win = pitWindow('FOC', s, PIT_LOSS);
    expect(win.ongoingStop).toBe(true);
    expect(pk.kMax).toBe(0);
    expect(pk.rows.map((r) => r.predictedPosition)).toEqual([win.predictedPosition]);
  });
});

describe('undercutSweep: the Undercut Calculator', () => {
  const st = state();

  it('a chosen rival stop the rival has already completed is ignored: its likely stop, never a stop charged again now', () => {
    // AHD has completed 6 laps at NOW: a choice of lap 3 (or 6) is in the past
    const likely = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params({ dM: 0.05, dH: 0.03, fresh: -0.2 }));
    for (const past of [3, 6]) {
      const sw = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params({ dM: 0.05, dH: 0.03, fresh: -0.2 }), { rivalStopLap: past });
      expect(sw.rivalStop.source).not.toBe('chosen');
      expect(sw.rivalStop.expiredChoice).toBe(past);
      expect(sw.rivalStop.inLap).toBe(likely.rivalStop.inLap);
      expect(sw.rows.map((r) => r.gap)).toEqual(likely.rows.map((r) => r.gap));
    }
    // the lap in progress is still a choice
    const now = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params(), { rivalStopLap: 7 });
    expect(now.rivalStop).toMatchObject({ inLap: 7, source: 'chosen' });
    expect(now.rivalStop.expiredChoice).toBeUndefined();
  });

  it('a pit-lane visit with no tyre change (R2): past its exit the car keeps its set in the model', () => {
    // AHD drives through the pit lane on lap 6 / 7 and keeps its MEDIUM (TyreLife goes on)
    const visit = RACE.map((r) => {
      if (r.Driver !== 'AHD') return r;
      if (r.LapNumber === 6) return { ...r, PitInTimeSeconds: r.Time - 5 };
      if (r.LapNumber === 7) return { ...r, PitOutTimeSeconds: r.LapStartTime + 20 };
      return r;
    });
    const stV = state(NOW, visit);
    expect(driverStateAt(visit, 'AHD', NOW).inPitLane).toBe(false);
    const sw = undercutSweep('FOC', 'AHD', stV, PIT_LOSS, params({ dM: 0.05, dH: 0.03, fresh: -0.2 }));
    expect(sw.available).toBe(true);
    expect(sw.rivalStop.source).toBe('in progress');
    // no new set modelled for the rival: it keeps its MEDIUM
    expect(sw.rivalNextCompound).toBeNull();
    // inside the pit lane the outcome is not known yet: the likely new set
    const inLane = undercutSweep('FOC', 'AHD', state(1544 + 10, visit), PIT_LOSS, params({ dM: 0.05, dH: 0.03, fresh: -0.2 }));
    expect(inLane.available).toBe(true);
    expect(driverStateAt(visit, 'AHD', 1554).inPitLane).toBe(true);
    expect(inLane.rivalNextCompound).not.toBeNull();
  });

  it('equal paces, no wear: both stop once, every row keeps the current gap (counted once)', () => {
    const sw = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params(), { rivalStopLap: 10 });
    expect(sw.available).toBe(true);
    // AHD crossed 6 s before FOC on lap 6: the focus is behind (negative)
    expect(sw.currentGap).toBeCloseTo(-6, 9);
    expect(sw.rows.length).toBeGreaterThan(5);
    for (const r of sw.rows) {
      expect(r.gap).toBeCloseTo(-6, 9);
      expect(r.change).toBeCloseTo(0, 9);
    }
    // the rival's stop is in every row, before and after the focus's
    expect(sw.rivalStop).toMatchObject({ inLap: 10, source: 'chosen', inRace: true });
    const before = sw.rows.filter((r) => r.inLap < 10);
    const after = sw.rows.filter((r) => r.inLap > 10);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeGreaterThan(0);
    // one horizon for every row: the latest out-lap of the table (lap 20, the flag)
    expect(sw.horizonLap).toBe(sw.rows.at(-1).inLap + 1);
    for (const r of sw.rows) expect(r.horizonLap).toBe(sw.horizonLap);
  });

  it('every row is read at the same lap: different paces and no tyre model give the same gap in every row', () => {
    // FOC 0.4 s a lap faster than AHD, no wear, no fresh-tyre delta: the pit lap cannot matter
    const fast = RACE.map((r) => (r.Driver === 'FOC' ? { ...r, LapTimeSeconds: r.LapTimeSeconds - 0.4, Time: r.Time - 0.4 * r.LapNumber } : r));
    const s = state(NOW, fast);
    const sw = undercutSweep('FOC', 'AHD', s, PIT_LOSS, params(), { rivalStopLap: 10 });
    const gaps = sw.rows.map((r) => r.gap);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1e-9);
    // the rival's crossing of the horizon does not depend on the focus's pit lap
    const rival = sw.rows.map((r) => r.rivalCrossing);
    expect(Math.max(...rival) - Math.min(...rival)).toBe(0);
    // the best row is then the earliest (a tie)
    expect(sw.best.inLap).toBe(sw.rows[0].inLap);
  });

  it('rows differ by pit lap and the gain is signed: positive = focus ahead', () => {
    const rp = params({ dM: 0.3, dH: 0.05, fresh: -0.5 });
    const sw = undercutSweep('FOC', 'AHD', st, PIT_LOSS, rp, { rivalStopLap: 12 });
    const gaps = sw.rows.map((r) => r.gap.toFixed(6));
    expect(new Set(gaps).size).toBe(gaps.length);
    // a worn set (0.3 s/lap) against a fresh one: the earliest stop is the best undercut,
    // and it puts the focus ahead of AHD (6 s ahead now) once both have stopped
    expect(sw.best.inLap).toBe(7);
    expect(sw.best.gap).toBeGreaterThan(0);
    // later stops lose more and more to the rival
    for (let i = 1; i < sw.rows.length; i++) expect(sw.rows[i].gap).toBeLessThan(sw.rows[i - 1].gap);
    // the new-tyre gain on the first flying lap: 9 dM - 2 dH - fresh (closed form)
    expect(sw.freshGain).toBeCloseTo(9 * 0.3 - 2 * 0.05 + 0.5, 9);
    // the gap is the rival's crossing minus the focus's (focus ahead > 0)
    for (const r of sw.rows) expect(r.gap).toBeCloseTo(r.rivalCrossing - r.focusCrossing, 9);
  });

  it('a negative fit makes the new set slower: staying out is the model\'s best', () => {
    const sw = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params({ dM: -0.1, dH: -0.1 }), { rivalStopLap: 12 });
    expect(sw.freshGain).toBeLessThan(0);
    expect(sw.best.inLap).toBe(sw.rows.at(-1).inLap);
  });

  it('the rival\'s likely stop from the stint-life survival, in-lap past the race: no stop', () => {
    const survival = Array.from({ length: 21 }, (_, t) => (t < 9 ? 1 : t === 9 ? 0.4 : 0));
    const sw = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params({ survival }));
    expect(sw.rivalStop).toMatchObject({ inLap: 9, source: 'race', dueAge: 9, inRace: true });
    const never = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params({ survival: Array.from({ length: 21 }, () => 1) }));
    expect(never.rivalStop).toMatchObject({ inLap: null, inRace: false });
    for (const r of never.rows) expect(r.horizonLap).toBe(never.rows.at(-1).inLap + 1);
    // equal paces, no wear, only the focus stops: it loses exactly the pit loss
    for (const r of never.rows) expect(r.gap).toBeCloseTo(-6 - PIT_LOSS.median, 9);
  });

  it('sweeps the lap in progress and the next UNDERCUT_SWEEP_LAPS, inside the race', () => {
    const sw = undercutSweep('FOC', 'AHD', st, PIT_LOSS, params(), { rivalStopLap: 10 });
    expect(UNDERCUT_SWEEP_LAPS).toBe(15);
    expect(sw.rows[0].inLap).toBe(7);
    // last out-lap = lap 20 (the flag)
    expect(sw.rows.at(-1).inLap).toBe(19);
    expect(undercutSweep('FOC', 'FOC', st, PIT_LOSS, params()).reason).toBe('no-rival');
  });

  it('is causal', () => {
    const rp = params({ dM: 0.1, dH: 0.05, fresh: -0.3 });
    const a = undercutSweep('FOC', 'AHD', st, PIT_LOSS, rp, { rivalStopLap: 11 });
    const b = undercutSweep('FOC', 'AHD', state(NOW, perturbFuture(RACE, NOW)), PIT_LOSS, rp, { rivalStopLap: 11 });
    expect(withoutCurrent(b)).toEqual(withoutCurrent(a));
  });
});
