import { describe, it, expect, beforeAll } from 'vitest';
import {
  referenceLap, circleState, gapSeconds, lapOffset, pitWindow, rankByCrossing, rejoinDistribution,
  rejoinProbabilities, circleMemoKey, circleStateKey, ringRelations, phaseAt, wrapPhase, PHASE_MAX, TRAFFIC_GAP_S,
} from '../circleOfDoom.js';
import fs from 'node:fs';
import { estimatePitLoss } from '../pitLoss.js';
import { leaderLapEndTime } from '../raceTime.js';
import { perturbFuture } from './futureRows.js';
import { hasCachedSession, loadCachedSession, CACHE_DIR } from '../../__tests__/helpers/cachedSession.js';
import { pitStatus, laneStats } from '../circlePitLane.js';
import { sectorFractions } from '../circleSectors.js';
import { gapRows } from '../circleGapList.js';

const row = (lapTimes, d, n) => lapTimes.find((r) => r.Driver === d && r.LapNumber === n);

// Position of a driver at the end of lap n by the validation script's rule:
// 1 + the cars with an earlier lap n Time
function actualPositionAt(lapTimes, d, n) {
  const others = [...new Set(lapTimes.map((r) => r.Driver))]
    .filter((x) => x !== d)
    .map((x) => row(lapTimes, x, n)?.Time)
    .filter((t) => t != null);
  return rankByCrossing(row(lapTimes, d, n).Time, others);
}

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16), lap 15 before LEC stops', () => {
  // LEC runs lap 15 (started 4542.276); pit entry at 4628.772
  const NOW = 4600;
  let lapTimes;
  let st;
  let est;
  beforeAll(() => {
    lapTimes = loadCachedSession(2024, 16).lap_times;
    st = circleState(lapTimes, { sessionNow: NOW });
    est = estimatePitLoss(lapTimes, { sessionNow: NOW });
  });

  it('reference lap: median of the green laps 10-14, a Monza race lap', () => {
    const ref = referenceLap(lapTimes, { sessionNow: NOW });
    expect(ref).toMatchObject({ laps: [10, 14], source: 'race' });
    expect(ref.nSamples).toBeGreaterThanOrEqual(10);
    expect(ref.seconds).toBeGreaterThan(84);
    expect(ref.seconds).toBeLessThan(87);
    expect(st.refLap).toEqual(ref);
  });

  it('19 cars (TSU retired in the pits on lap 7), order and gaps = FastF1 lap-14 Position / GapToLeader', () => {
    expect(st.cars).toHaveLength(19);
    expect(st.cars.find((c) => c.driver === 'TSU')).toBeUndefined();
    expect(circleState(lapTimes, { sessionNow: 3983 }).cars.find((c) => c.driver === 'TSU')).toBeDefined();
    const leader = st.cars[0].driver;
    expect(leader).toBe('PIA');
    for (const car of st.cars.filter((c) => c.lapsCompleted === 14)) {
      const r = row(lapTimes, car.driver, 14);
      expect(car.position).toBe(r.Position);
      expect(gapSeconds(leader, car.driver, st)).toBeCloseTo(r.GapToLeader, 3);
    }
    const lec = st.cars.find((c) => c.driver === 'LEC');
    expect(lec).toMatchObject({ position: 2, lapsCompleted: 14, inPitLane: false, lapOffsetToLeader: 0 });
    expect(lec.phase).toBeCloseTo((NOW - 4542.276) / st.refLap.seconds, 9);
    for (const c of st.cars) {
      expect(c.phase).toBeGreaterThanOrEqual(0);
      expect(c.phase).toBeLessThanOrEqual(PHASE_MAX);
    }
  });

  it('pit window of LEC: plausible rank, threshold lists, traffic', () => {
    expect(est).toMatchObject({ source: 'race', n: 5 });
    const w = pitWindow('LEC', st, est);
    expect(w).toMatchObject({
      available: true, ongoingStop: false, targetLap: 16, currentPosition: 2, paceSource: 'recent',
      pitLoss: { source: 'race', n: 5 },
    });
    expect(w.pace).toBeGreaterThan(84);
    expect(w.pace).toBeLessThan(87);
    expect(w.predictedCrossing).toBeCloseTo(4542.276 + 2 * w.pace + est.median, 6);
    expect(w.predictedPosition).toBeGreaterThanOrEqual(7);
    expect(w.predictedPosition).toBeLessThanOrEqual(11);
    expect(w.positionsLost).toBe(w.predictedPosition - 2);
    // the same-lap cars within 10 s behind gain the place; PIA (3.4 s ahead) could cover
    const passing = w.wouldPassFocus.map((x) => x.driver);
    for (const d of ['SAI', 'HAM', 'VER', 'PER']) expect(passing).toContain(d);
    expect(w.wouldDropBehindFocus.map((x) => x.driver)).toEqual(['PIA']);
    for (const x of w.wouldPassFocus) expect(x.gapSeconds).toBeGreaterThan(0);
    expect(typeof w.traffic.flag).toBe('boolean');
    expect(w.traffic.carAhead).toBeTruthy();
    // NOR and MAG pitted on lap 14 and are on their out-laps: their pending loss is projected
    const pending = w.rivalCrossings.filter((r) => r.stage === 'out-lap').map((r) => r.driver).sort();
    expect(pending).toEqual(['MAG', 'NOR']);
  });

  it('rejoin probabilities: sum to 1; the actual rejoin (P7 at the end of lap 16) is the most likely', () => {
    const d = rejoinDistribution('LEC', st, est);
    expect(d.method).toBe('bootstrap');
    expect(d.positions.reduce((a, p) => a + p.probability, 0)).toBeCloseTo(1, 12);
    const actual = actualPositionAt(lapTimes, 'LEC', 16);
    expect(actual).toBe(7);
    const modal = d.positions.reduce((a, b) => (b.probability > a.probability ? b : a));
    expect(modal.position).toBe(actual);
    expect(rejoinProbabilities('LEC', st, est, { seed: 3 })).toEqual(rejoinProbabilities('LEC', st, est, { seed: 3 }));
  });

  it('causal: perturbing every row not known at 4600 s changes nothing', () => {
    const future = perturbFuture(lapTimes, NOW);
    const st2 = circleState(future, { sessionNow: NOW });
    const est2 = estimatePitLoss(future, { sessionNow: NOW });
    expect(st2.cars).toEqual(st.cars);
    expect(st2.refLap).toEqual(st.refLap);
    expect(est2).toEqual(est);
    expect(pitWindow('LEC', st2, est2)).toEqual(pitWindow('LEC', st, est));
    expect(rejoinProbabilities('LEC', st2, est2)).toEqual(rejoinProbabilities('LEC', st, est));
    expect(circleMemoKey('LEC', future, NOW, est2)).toBe(circleMemoKey('LEC', lapTimes, NOW, est));
  });
});

describe.skipIf(!hasCachedSession(2024, 5))('China 2024 (R5) under the Safety Car (laps 23-31)', () => {
  let lapTimes;
  let ver26;
  let NOW;
  let st;
  let est;
  beforeAll(() => {
    lapTimes = loadCachedSession(2024, 5).lap_times;
    ver26 = row(lapTimes, 'VER', 26); // an SC lap: 157 s
    NOW = ver26.LapStartTime + 130;
    st = circleState(lapTimes, { sessionNow: NOW });
    est = estimatePitLoss(lapTimes, { sessionNow: NOW });
  });

  it('the reference lap reaches back to the green laps before the neutralisation', () => {
    expect(ver26.TrackStatus).not.toBe('1');
    expect(ver26.Time - ver26.LapStartTime).toBeGreaterThan(150); // its LapTimeSeconds is null
    expect(st.refLap).toMatchObject({ source: 'race', laps: [19, 25] });
    expect(st.refLap.nSamples).toBeGreaterThanOrEqual(10);
    expect(st.refLap.seconds).toBeGreaterThan(98);
    expect(st.refLap.seconds).toBeLessThan(106);
  });

  it('phases stay in [0, 0.999]; past the reference lap the cars pile up at 0.999, flagged saturated', () => {
    expect(st.cars).toHaveLength(19);
    for (const c of st.cars) {
      expect(c.phase).toBeGreaterThanOrEqual(0);
      expect(c.phase).toBeLessThanOrEqual(PHASE_MAX);
      expect(c.saturated).toBe(c.elapsed > st.refLap.seconds * PHASE_MAX);
    }
    expect(st.cars.filter((c) => c.saturated).length).toBeGreaterThanOrEqual(15);
    // 100 s earlier nobody but the last car (about to complete its lap) is saturated
    const early = circleState(lapTimes, { sessionNow: ver26.LapStartTime + 30 });
    expect(early.cars.filter((c) => c.saturated).length).toBeLessThanOrEqual(1);
    // same-lap cars: phase never increases down the order (the field is bunched)
    const lap25 = early.cars.filter((c) => c.lapsCompleted === 25);
    for (let i = 1; i < lap25.length; i++) expect(lap25[i].phase).toBeLessThanOrEqual(lap25[i - 1].phase);
    const spread = (lap25[0].lastCrossingTime - lap25[lap25.length - 1].lastCrossingTime);
    expect(Math.abs(spread)).toBeLessThan(40);
  });

  it('pit window under SC: green-flag figures, flagged neutralised; probabilities sum to 1', () => {
    const w = pitWindow('VER', st, est, { trackFlag: '4' });
    expect(w).toMatchObject({ available: true, neutralised: true, trackFlag: '4', currentPosition: 1 });
    expect(est.source).toBe('race');
    expect(w.predictedPosition).toBeGreaterThanOrEqual(1);
    expect(w.predictedPosition).toBeLessThanOrEqual(19);
    expect(pitWindow('VER', st, est).neutralised).toBe(false);
    const p = rejoinProbabilities('VER', st, est);
    expect(p.reduce((a, x) => a + x.probability, 0)).toBeCloseTo(1, 12);
    expect(p.every((x) => x.position >= 1 && x.position <= 19)).toBe(true);
  });

  it('causal under SC', () => {
    const future = perturbFuture(lapTimes, NOW);
    const st2 = circleState(future, { sessionNow: NOW });
    const est2 = estimatePitLoss(future, { sessionNow: NOW });
    expect(st2.cars).toEqual(st.cars);
    expect(pitWindow('VER', st2, est2, { trackFlag: '4' })).toEqual(pitWindow('VER', st, est, { trackFlag: '4' }));
    expect(rejoinProbabilities('VER', st2, est2)).toEqual(rejoinProbabilities('VER', st, est));
  });
});

// Independent reading of the rules, from the module header and the spec:
//  ahead in the race = more laps completed, or as many and earlier across the line;
//  threshold lists = same-lap cars (lapOffset 0) on each side of the race order,
//    gap = gapSeconds + the rival's stop in progress not yet in it (read here from
//    the rows: pit entry passed on the lap it runs, or its last lap an in-lap);
//  traffic = the last line crossing of another car before predictedCrossing (actual
//    rows up to sessionNow, then lastCrossingTime + laps x its pace + its pending loss,
//    up to its own last lap), flag < 1.0 s;
//  trafficOnly = cars drawn inside the band that are not on the focus's lap.
const aheadInRace = (a, b) => a.lapsCompleted > b.lapsCompleted
  || (a.lapsCompleted === b.lapsCompleted && a.lapsCompleted > 0 && a.lastCrossingTime < b.lastCrossingTime);

/** Latest lap both cars completed (rows with a Time at or before now). */
function commonLap(lapTimes, a, b, now) {
  const done = (d) => new Set(lapTimes.filter((r) => r.Driver === d && r.Time != null && r.Time <= now).map((r) => r.LapNumber));
  const la = done(a);
  const shared = [...done(b)].filter((n) => la.has(n));
  return shared.length ? Math.max(...shared) : null;
}

function specLists(focus, st, w) {
  const loss = w.pitLoss.median;
  const lapTimes = st.lapTimes;
  const now = st.sessionNow;
  const F = st.cars.find((c) => c.driver === focus);
  const pass = [];
  const drop = [];
  for (const c of st.cars) {
    if (c.driver === focus || lapOffset(focus, c.driver, st) !== 0) continue;
    const n = commonLap(lapTimes, focus, c.driver, now);
    if (n == null) continue;
    const gap = row(lapTimes, c.driver, n).Time - row(lapTimes, focus, n).Time;
    // its stop in progress: in-lap (pit entry passed, lap still running) or out-lap
    const running = row(lapTimes, c.driver, c.lapsCompleted + 1);
    const last = row(lapTimes, c.driver, c.lapsCompleted);
    const rc = w.rivalCrossings.find((r) => r.driver === c.driver);
    let whole = 0;
    let notInGap = 0;
    if (running?.PitInTimeSeconds != null && running.PitInTimeSeconds <= now && !(running.Time <= now)) {
      whole = loss;
      notInGap = loss;
    } else if (last?.PitInTimeSeconds != null) {
      whole = loss;
      notInGap = n >= c.lapsCompleted ? Math.max(0, loss - Math.max(0, last.LapTimeSeconds - rc.pace)) : loss;
    }
    if (aheadInRace(c, F)) {
      const g = Math.min(0, gap - (whole - notInGap));
      if (-g < loss) drop.push(c.driver);
    } else if (Math.max(0, gap + notInGap) < loss) {
      pass.push(c.driver);
    }
  }
  return { pass: pass.sort(), drop: drop.sort() };
}

/** Last line crossing of another running car before the focus's predicted crossing. */
function trafficOracle(focus, st, w) {
  const crossings = [];
  for (const rc of w.rivalCrossings) {
    const c = st.cars.find((x) => x.driver === rc.driver);
    if (c.finished || !c.lapsCompleted) continue;
    const lastLap = rc.lastLap ?? Infinity;
    for (let k = Math.max(1, c.lapsCompleted - 1); k <= Math.min(lastLap, c.lapsCompleted + 10); k++) {
      const t = k <= c.lapsCompleted
        ? row(st.lapTimes, c.driver, k).Time
        : c.lastCrossingTime + (k - c.lapsCompleted) * rc.pace + rc.pendingLoss;
      if (t < w.predictedCrossing) crossings.push({ driver: c.driver, gap: w.predictedCrossing - t, laps: w.targetLap - k });
    }
  }
  return crossings.sort((a, b) => a.gap - b.gap)[0] || null;
}

function drawnRing(focus, st, w) {
  const f = st.cars.find((c) => c.driver === focus);
  const ring = st.cars.filter((c) => c.driver !== focus && !c.inPitLane && !c.finished);
  const band = ring.filter((c) => {
    const behind = wrapPhase(f.phase - c.phase);
    return behind > 0 && behind <= w.bandSeconds / w.refLap;
  });
  const trafficOnly = band
    .map((c) => {
      const k = lapOffset(focus, c.driver, st);
      if (k !== 0) return `${c.driver}:${k}`;
      return aheadInRace(c, f) ? `${c.driver}:-1` : null;
    })
    .filter(Boolean)
    .sort();
  return { trafficOnly };
}

const sorted = (list) => list.map((x) => x.driver).sort();

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024: last lap, threshold lists and traffic', () => {
  let lapTimes;
  let flag;
  beforeAll(() => {
    lapTimes = loadCachedSession(2024, 16).lap_times;
    flag = leaderLapEndTime(lapTimes, 53);
  });
  const at =(now) => ({ st: circleState(lapTimes, { sessionNow: now }), est: estimatePitLoss(lapTimes, { sessionNow: now }) });

  it('no window after the chequered flag, nor past a lapped car\'s last lap', () => {
    expect(flag).toBeCloseTo(7831.479, 3);
    const after = at(flag + 1);
    const running = after.st.cars.filter((c) => !c.finished);
    expect(running.map((c) => c.driver)).toContain('OCO');
    for (const c of running) {
      expect(pitWindow(c.driver, after.st, after.est, { totalLaps: 53 })).toMatchObject({ available: false, reason: 'chequered-flag' });
    }
    // leader on lap 53: OCO, GAS, BOT are one lap down and finish after lap 52
    const late = at(7778.2);
    for (const d of ['OCO', 'GAS', 'BOT']) {
      expect(late.st.cars.find((c) => c.driver === d)).toMatchObject({ lapsCompleted: 51, lapOffsetToLeader: 1 });
      expect(pitWindow(d, late.st, late.est, { totalLaps: 53 })).toMatchObject({ available: false, reason: 'last-lap' });
      expect(Math.max(...lapTimes.filter((r) => r.Driver === d).map((r) => r.LapNumber))).toBe(52);
    }
  });

  it('4038 s, NOR (fallback 22 s): every same-lap car within 22 s gains the place; the car ahead at the rejoin is OCO, 2.5 s', () => {
    const { st, est } = at(4038);
    expect(est.source).toBe('fallback');
    const w = pitWindow('NOR', st, est);
    expect(sorted(w.wouldPassFocus)).toEqual(specLists('NOR', st, w).pass);
    for (const d of ['STR', 'COL', 'BOT', 'ZHO']) expect(sorted(w.wouldPassFocus)).toContain(d);
    // NOR would complete lap 10 at 4225.45 s; OCO is projected across 2.5 s earlier.
    // (The drawn ring, every car at the reference lap, read BOT 0.4 s ahead; in the
    // data BOT crossed 2.9 s after that time.)
    const oracle = trafficOracle('NOR', st, w);
    expect(w.traffic).toMatchObject({ flag: false, carAhead: 'OCO', carAheadLaps: 0 });
    expect(oracle.driver).toBe('OCO');
    expect(w.traffic.gapSeconds).toBeCloseTo(oracle.gap, 9);
    expect(w.traffic.gapSeconds).toBeGreaterThan(2);
  });

  it('4600 s, LEC (31.9 s, 5 stops): COL and BOT are within the pit loss; NOR and MAG, mid-stop, are not', () => {
    const { st, est } = at(4600);
    const w = pitWindow('LEC', st, est);
    const spec = specLists('LEC', st, w);
    expect(sorted(w.wouldPassFocus)).toEqual(spec.pass);
    expect(sorted(w.wouldDropBehindFocus)).toEqual(spec.drop);
    expect(sorted(w.wouldPassFocus)).toEqual(expect.arrayContaining(['COL', 'BOT']));
    // NOR and MAG are on their out-laps: once their stops are paid they are more than
    // 31.9 s behind, so LEC's stop does not give them the place
    for (const d of ['NOR', 'MAG']) {
      expect(w.rivalCrossings.find((r) => r.driver === d).stage).toBe('out-lap');
      expect(sorted(w.wouldPassFocus)).not.toContain(d);
    }
    for (const x of w.wouldPassFocus) expect(x.marginSeconds).toBeCloseTo(est.median - x.gapSeconds, 9);
  });

  it('6000 s, HAM: flagged 0.7 s behind ALO at the predicted rejoin (0.3 s in the data)', () => {
    const { st, est } = at(6000);
    const w = pitWindow('HAM', st, est);
    const oracle = trafficOracle('HAM', st, w);
    expect(oracle.driver).toBe('ALO');
    expect(w.traffic).toMatchObject({ flag: true, carAhead: 'ALO', carAheadLaps: 0 });
    expect(w.traffic.gapSeconds).toBeCloseTo(oracle.gap, 9);
    expect(w.traffic.gapSeconds).toBeLessThan(TRAFFIC_GAP_S);
    // what happened: ALO completed lap 32 0.33 s before HAM's predicted crossing
    expect(w.predictedCrossing - row(lapTimes, 'ALO', 32).Time).toBeGreaterThan(0);
    expect(w.predictedCrossing - row(lapTimes, 'ALO', 32).Time).toBeLessThan(TRAFFIC_GAP_S);
  });
});

describe.skipIf(!hasCachedSession(2024, 13))('Hungary 2024 (R13) at 5353.5 s: LEC on its out-lap, behind PIA on the road', () => {
  it('a same-lap rival in wouldPassFocus (17.7 s behind in the data), not -1L, not within reach', () => {
    const lapTimes = loadCachedSession(2024, 13).lap_times;
    const NOW = 5353.5;
    const st = circleState(lapTimes, { sessionNow: NOW });
    const pia = st.cars.find((c) => c.driver === 'PIA');
    const lec = st.cars.find((c) => c.driver === 'LEC');
    expect(pia).toMatchObject({ position: 1, lapsCompleted: 24 });
    expect(lec).toMatchObject({ lapsCompleted: 23 });
    expect(lec.position).toBeGreaterThan(pia.position);
    // LEC led at the end of lap 23 (its in-lap): the gap on that lap is stale
    expect(gapSeconds('PIA', 'LEC', st)).toBeLessThan(0);
    expect(lapOffset('PIA', 'LEC', st)).toBe(0);
    const w = pitWindow('PIA', st, estimatePitLoss(lapTimes, { sessionNow: NOW }));
    expect(w.trafficOnly.map((x) => x.driver)).not.toContain('LEC');
    expect(w.wouldDropBehindFocus.map((x) => x.driver)).not.toContain('LEC');
    const x = w.wouldPassFocus.find((y) => y.driver === 'LEC');
    expect(x).toBeDefined();
    // LEC's lap 24 in the data: 17.7 s after PIA's
    const actual = row(lapTimes, 'LEC', 24).Time - row(lapTimes, 'PIA', 24).Time;
    expect(actual).toBeCloseTo(17.71, 1);
    expect(Math.abs(x.gapSeconds - actual)).toBeLessThan(3);
    expect(x.gapSeconds).toBeLessThan(w.pitLoss.median);
  });
});

describe.skipIf(!hasCachedSession(2024, 10))('Spain 2024 (R10) at 8670 s: a rival lapped before the target lap is not ahead on it', () => {
  it('OCO: ALO takes the flag at the end of lap 65 (no lap 66 row), so OCO rejoins P11, not P12', () => {
    const lapTimes = loadCachedSession(2024, 10).lap_times;
    const NOW = 8670;
    const st = circleState(lapTimes, { sessionNow: NOW });
    const est = estimatePitLoss(lapTimes, { sessionNow: NOW });
    const w = pitWindow('OCO', st, est, { totalLaps: 66 });
    expect(w).toMatchObject({ available: true, targetLap: 66 });
    const alo = w.rivalCrossings.find((r) => r.driver === 'ALO');
    expect(alo).toMatchObject({ lastLap: 65, time: Infinity });
    expect(pitWindow('ALO', st, est, { totalLaps: 66 })).toMatchObject({ available: false, reason: 'last-lap' });
    expect(row(lapTimes, 'ALO', 66)).toBeUndefined();
    expect(w.predictedPosition).toBe(11);
    // the cars counted ahead all complete lap 66 by their own projection
    for (const r of w.rivalCrossings.filter((x) => x.time < w.predictedCrossing)) expect(r.lastLap).toBeGreaterThanOrEqual(66);
  });
});

describe.skipIf(!hasCachedSession(2024, 10) || !hasCachedSession(2024, 13))('lapped traffic read off the drawn band (saturated focus)', () => {
  it('2024 R10 at 6437.1 s, RUS on its out-lap: SAR (same lap, outside the drawn band) is not listed', () => {
    const lapTimes = loadCachedSession(2024, 10).lap_times;
    // the line anchor (the ring check's comparison) holds RUS at 0.999 on its out-lap
    const st = circleState(lapTimes, { sessionNow: 6437.1, outLapAnchor: 'line' });
    const w = pitWindow('RUS', st, estimatePitLoss(lapTimes, { sessionNow: 6437.1 }));
    expect(st.cars.find((c) => c.driver === 'RUS').saturated).toBe(true);
    expect(lapOffset('RUS', 'SAR', st)).toBe(0);
    expect(w.trafficOnly.map((x) => x.driver)).not.toContain('SAR');
    expect(w.trafficOnly.map((x) => `${x.driver}:${x.laps}`).sort()).toEqual(drawnRing('RUS', st, w).trafficOnly);
  });

  it('2024 R13 at 7372.9 s, PIA: the list is the drawn band, labels = lapOffset', () => {
    const lapTimes = loadCachedSession(2024, 13).lap_times;
    const st = circleState(lapTimes, { sessionNow: 7372.9 });
    const w = pitWindow('PIA', st, estimatePitLoss(lapTimes, { sessionNow: 7372.9 }));
    expect(w.trafficOnly.map((x) => `${x.driver}:${x.laps}`).sort()).toEqual(drawnRing('PIA', st, w).trafficOnly);
    expect(w.trafficOnly.length).toBeGreaterThan(0);
    for (const x of w.trafficOnly) {
      if (x.laps > 0) expect(lapOffset('PIA', x.driver, st)).toBe(x.laps);
      expect(x.label).toBe(`${x.laps}L`);
    }
  });
});

const SWEEP = [[2024, 16], [2024, 5], [2024, 10], [2024, 13]].filter(([y, r]) => hasCachedSession(y, r));

describe.skipIf(!SWEEP.length)('sweep: every focus car every 2 minutes, the rules hold', () => {
  for (const [year, round] of SWEEP) {
    it(`${year} R${round}`, () => {
      const lapTimes = loadCachedSession(year, round).lap_times;
      const last = Math.max(...lapTimes.map((r) => r.LapNumber));
      const flag = leaderLapEndTime(lapTimes, last);
      const start = Math.min(...lapTimes.filter((r) => r.LapNumber === 1).map((r) => r.LapStartTime));
      const lastLapOf = new Map();
      for (const r of lapTimes) lastLapOf.set(r.Driver, Math.max(lastLapOf.get(r.Driver) || 0, r.LapNumber));
      const n = {
        windows: 0, lists: 0, traffic: 0, band: 0, afterFlag: 0, pastOwnLastLap: 0, sideVsOrder: 0, minusOneBehind: 0, aheadAfterLastLap: 0,
      };
      for (let now = start + 200; now < flag + 60; now += 120) {
        const st = circleState(lapTimes, { sessionNow: now });
        const est = estimatePitLoss(lapTimes, { sessionNow: now });
        for (const car of st.cars) {
          const w = pitWindow(car.driver, st, est, { totalLaps: last });
          if (now >= flag && !car.finished && w.available) n.afterFlag += 1;
          if (!w.available) continue;
          n.windows += 1;
          // the out-lap of a finisher never ends past its own last lap in the data
          if (w.targetLap > lastLapOf.get(car.driver) && lastLapOf.get(car.driver) >= last - 3) n.pastOwnLastLap += 1;
          const spec = specLists(car.driver, st, w);
          if (sorted(w.wouldPassFocus).join() !== spec.pass.join()
            || sorted(w.wouldDropBehindFocus).join() !== spec.drop.join()) n.lists += 1;
          // the lists and the '-1L' tag follow the race order
          const carOf = (d) => st.cars.find((c) => c.driver === d);
          if (w.wouldPassFocus.some((x) => aheadInRace(carOf(x.driver), car))
            || w.wouldDropBehindFocus.some((x) => !aheadInRace(carOf(x.driver), car))) n.sideVsOrder += 1;
          if (w.trafficOnly.some((x) => x.laps === -1 && !aheadInRace(carOf(x.driver), car))) n.minusOneBehind += 1;
          // no rival is counted ahead on a lap past its own last lap
          if (w.rivalCrossings.some((r) => r.time < w.predictedCrossing && r.lastLap != null && r.lastLap < w.targetLap)) n.aheadAfterLastLap += 1;
          const oracle = trafficOracle(car.driver, st, w);
          const flagOracle = !!oracle && oracle.gap < TRAFFIC_GAP_S;
          if (flagOracle !== w.traffic.flag || (oracle?.driver ?? null) !== w.traffic.carAhead
            || (oracle && Math.abs(oracle.gap - w.traffic.gapSeconds) > 1e-6)) n.traffic += 1;
          const ring = drawnRing(car.driver, st, w);
          if (w.trafficOnly.map((x) => `${x.driver}:${x.laps}`).sort().join() !== ring.trafficOnly.join()) n.band += 1;
        }
      }
      expect(n.windows).toBeGreaterThan(300);
      expect({ ...n, windows: 0 }).toEqual({
        windows: 0, lists: 0, traffic: 0, band: 0, afterFlag: 0, pastOwnLastLap: 0, sideVsOrder: 0, minusOneBehind: 0, aheadAfterLastLap: 0,
      });
    }, 60000);
  }
});

/** { driver: grid slot } as the view builds it from race_results (0 = pit lane). */
function gridOf(session) {
  const out = {};
  for (const r of session.race_results || []) {
    const g = Number(r?.GridPosition);
    if (r?.Abbreviation && r.GridPosition != null && Number.isFinite(g) && g >= 0) out[r.Abbreviation] = g;
  }
  return out;
}

const ALL_RACES = (fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [])
  .map((f) => /^session_(\d+)_(\d+)_R\.json$/.exec(f))
  .filter(Boolean)
  .map((m) => [Number(m[1]), Number(m[2])]);

describe.skipIf(!hasCachedSession(2024, 10))('lap 1: Spain 2024 (R10) 1 s after the first crossing', () => {
  it('NOR (not across yet) is placed by sector 2 and gets no pit window', () => {
    const session = loadCachedSession(2024, 10);
    const lapTimes = session.lap_times;
    const NOW = 3500.9; // RUS crossed at 3499.9
    const st = circleState(lapTimes, { sessionNow: NOW, gridPositions: gridOf(session) });
    const nor = st.cars.find((c) => c.driver === 'NOR');
    expect(nor.lapsCompleted).toBe(0);
    // FastF1 lap-1 Position of NOR: 3 (its crossing at 3501.274)
    expect(row(lapTimes, 'NOR', 1).Position).toBe(3);
    expect(nor.position).toBe(3);
    const est = estimatePitLoss(lapTimes, { sessionNow: NOW });
    expect(pitWindow('NOR', st, est)).toMatchObject({ available: false, reason: 'first-lap' });
    expect(rejoinDistribution('NOR', st, est).positions).toEqual([]);
  });
});

describe.skipIf(!ALL_RACES.length)('lap 1 on every cached race: order of the cars not yet across', () => {
  it('1, 5 and 15 s after the first crossing: no pit window, places = the order they then cross in', () => {
    const n = {
      notAcross: 0,
      windows: 0,
      windowsAcross: 0,
      windowWithoutSector2: 0,
      wrongRefusal: 0,
      projected: 0,
      projectionError: 0,
      within1s: 0,
      startError: 0,
      refusals: {},
      exact: 0,
      placeError: 0,
      positioned: 0,
      races: 0,
      afterLast: 0,
    };
    for (const [year, round] of ALL_RACES) {
      const session = loadCachedSession(year, round);
      const lapTimes = session.lap_times;
      const lapOne = lapTimes.filter((r) => r.LapNumber === 1 && r.Time != null).sort((a, b) => a.Time - b.Time);
      if (!lapOne.length) continue;
      n.races += 1;
      const grid = gridOf(session);
      for (const dt of [1, 5, 15]) {
        const now = lapOne[0].Time + dt;
        const st = circleState(lapTimes, { sessionNow: now, gridPositions: grid });
        const est = estimatePitLoss(lapTimes, { sessionNow: now });
        const across = st.cars.filter((c) => c.lapsCompleted > 0).length;
        const truth = lapOne.filter((r) => r.Time > now).map((r) => r.Driver);
        // the cars already across: a window only once every car on lap 1 has passed
        // sector 2; those cars are then projected to the line from there
        const allPastSector2 = st.cars.filter((c) => c.lapsCompleted === 0)
          .every((c) => row(lapTimes, c.driver, 1)?.Sector2SessionTime <= now);
        for (const car of st.cars.filter((c) => c.lapsCompleted > 0)) {
          const w = pitWindow(car.driver, st, est);
          if (!w.available) {
            n.refusals[w.reason] = (n.refusals[w.reason] || 0) + 1;
            if (w.reason === 'field-on-lap-one' && allPastSector2) n.wrongRefusal += 1;
            continue;
          }
          n.windowsAcross += 1;
          if (!allPastSector2) n.windowWithoutSector2 += 1;
          for (const r of w.rivalCrossings) {
            if (st.cars.find((c) => c.driver === r.driver)?.lapsCompleted !== 0) continue;
            // projected lap-1 crossing vs the actual one (not known at now)
            const actual = row(lapTimes, r.driver, 1).Time;
            const err = Math.abs(r.time - r.pendingLoss - (w.targetLap - 1) * r.pace - actual);
            n.projected += 1;
            n.projectionError += err;
            if (err < 1) n.within1s += 1;
            // the start-based projection it replaces: race start + one lap at its pace
            const start = st.cars.find((c) => c.driver === r.driver).lastCrossingTime;
            n.startError += Math.abs(start + r.pace - actual);
          }
        }
        for (const car of st.cars.filter((c) => c.lapsCompleted === 0)) {
          n.notAcross += 1;
          if (pitWindow(car.driver, st, est).available) n.windows += 1;
          if (car.position == null) continue;
          n.positioned += 1;
          const actual = across + 1 + truth.indexOf(car.driver);
          if (actual === car.position) n.exact += 1;
          n.placeError += Math.abs(actual - car.position);
        }
      }
      // once the last car has crossed, the lap-1 refusal ends (2024 R4 and R8 had a
      // red flag on lap 1: a lap over 200 s, no reference lap yet, 'no-reference-lap')
      const after = lapOne[lapOne.length - 1].Time + 1;
      const stAfter = circleState(lapTimes, { sessionNow: after, gridPositions: grid });
      const w = pitWindow(stAfter.cars[0].driver, stAfter, estimatePitLoss(lapTimes, { sessionNow: after }));
      if (w.available || w.reason !== 'first-lap') n.afterLast += 1;
    }
    console.log(`lap 1: ${n.races} races, ${n.notAcross} cars not yet across, ${n.positioned} with a position, `
      + `${n.windows} pit windows for them; exact place ${n.exact} `
      + `(${(100 * n.exact / n.positioned).toFixed(1)} %), mean place error ${(n.placeError / n.positioned).toFixed(2)}; `
      + `cars across: ${n.windowsAcross} windows (${n.windowWithoutSector2} with a car on lap 1 short of sector 2, `
      + `${n.wrongRefusal} wrong refusals), ${n.projected} lap-1 rivals projected from sector 2: mean error `
      + `${(n.projectionError / n.projected).toFixed(2)} s (start-based: ${(n.startError / n.projected).toFixed(2)} s), within 1 s ${(100 * n.within1s / n.projected).toFixed(1)} %; `
      + `refusals of the cars across ${JSON.stringify(n.refusals)}; `
      + `lap-1 refusal over 1 s after the last lap-1 crossing in ${n.afterLast} races`);
    expect(n.notAcross).toBeGreaterThan(500);
    expect(n.windows).toBe(0);
    expect(n.windowWithoutSector2).toBe(0);
    expect(n.wrongRefusal).toBe(0);
    expect(n.projected).toBeGreaterThan(100);
    // measured: 2.07 s mean error, against 8.52 s for the start-based projection it replaces
    expect(n.projectionError).toBeLessThan(n.startError / 3);
    expect(n.afterLast).toBe(n.races);
    expect(n.exact / n.positioned).toBeGreaterThan(0.8);
  });
});

// The view's memoisation (CircleOfDoom.jsx): circleState memoised on
// circleStateKey, pitWindow / rejoinDistribution on circleMemoKey, the cars
// moved every frame with phaseAt and the band read off each frame with
// ringRelations. At every 0.4 s frame this must equal computing everything
// again, the key must change only on events, and the traffic flag and the
// probabilities must never move within a key.
const MEMO_RACES = [[2024, 16], [2024, 5], [2024, 13]].filter(([y, r]) => hasCachedSession(y, r));

describe.skipIf(!MEMO_RACES.length)('memoisation: the memo key changes on events only, the frames match a fresh computation', () => {
  for (const [year, round] of MEMO_RACES) {
    it(`${year} R${round}`, () => {
      const session = loadCachedSession(year, round);
      const lapTimes = session.lap_times;
      const ts = session.track_status || null;
      const last = Math.max(...lapTimes.map((r) => r.LapNumber));
      const start = Math.min(...lapTimes.filter((r) => r.LapNumber === 1).map((r) => r.LapStartTime));
      const from = start + 1200;
      // lap 1 (the first crossings and the sector-2 events) and 15 minutes mid-race
      const firstCrossing = Math.min(...lapTimes.filter((r) => r.LapNumber === 1 && r.Time != null).map((r) => r.Time));
      const windows = [[firstCrossing - 5, firstCrossing + 85], [from, from + 900]];
      const grid = gridOf(session);
      const focuses = circleState(lapTimes, { sessionNow: from }).cars.filter((_, i) => [0, 4, 9, 15].includes(i)).map((c) => c.driver);
      const n = {
        frames: 0, stateKeyChanges: 0, keyChanges: 0, checks: 0, differ: 0, trafficMoved: 0, bandMoved: 0,
      };
      let stateKey = null;
      let state = null;
      let est = null;
      const memo = new Map();
      for (const [a, b] of windows) for (let now = a; now < b; now += 0.4) {
        n.frames += 1;
        const sk = circleStateKey(lapTimes, now, ts);
        if (sk !== stateKey) {
          if (stateKey != null) n.stateKeyChanges += 1;
          stateKey = sk;
          state = circleState(lapTimes, { sessionNow: now, gridPositions: grid });
          est = estimatePitLoss(lapTimes, { sessionNow: now });
        }
        const cars = state.cars.map((c) => ({ ...c, ...phaseAt(c, now, state.refLap) }));
        const frame = { ...state, sessionNow: now, cars };
        for (const focus of focuses) {
          const key = circleMemoKey(focus, lapTimes, now, est, ts);
          let m = memo.get(focus);
          if (!m || m.key !== key) {
            if (m) n.keyChanges += 1;
            const win = pitWindow(focus, frame, est, { totalLaps: last });
            m = { key, win, dist: win.available ? rejoinDistribution(focus, frame, est, { totalLaps: last }) : null };
            memo.set(focus, m);
          }
          if (n.frames % 2 || !m.win.available) continue;
          // what the view shows from the memo vs everything computed again
          const ring = ringRelations(m.win, frame);
          const shown = { win: { ...m.win, ...ring }, dist: m.dist };
          const fresh = circleState(lapTimes, { sessionNow: now, gridPositions: grid });
          const freshEst = estimatePitLoss(lapTimes, { sessionNow: now });
          const win = pitWindow(focus, fresh, freshEst, { totalLaps: last });
          const dist = rejoinDistribution(focus, fresh, freshEst, { totalLaps: last });
          n.checks += 1;
          if (JSON.stringify(shown) !== JSON.stringify({ win, dist })) n.differ += 1;
          if (JSON.stringify(win.traffic) !== JSON.stringify(m.win.traffic)
            || dist.trafficProbability !== m.dist.trafficProbability) n.trafficMoved += 1;
          if (JSON.stringify(ring.trafficOnly) !== JSON.stringify(m.win.trafficOnly)) n.bandMoved += 1;
        }
      }
      expect(n.checks).toBeGreaterThan(2000);
      expect(n.differ).toBe(0);
      expect(n.trafficMoved).toBe(0);
      // the memo key changes only with the state key (a lap, pit, track-status
      // or lap-1 timing event; the pit loss changes only on a lap): never per frame
      expect(n.keyChanges).toBe(n.stateKeyChanges * focuses.length);
      expect(n.stateKeyChanges).toBeLessThan(n.frames * 0.2);
      console.log(`${year} R${round}: ${n.frames} frames of 0.4 s, ${n.stateKeyChanges} state-key changes, `
        + `${n.keyChanges / focuses.length} memo-key changes per focus, `
        + `${n.checks} frame checks, ${n.differ} differ from a fresh computation, traffic flag or share moved within a key in `
        + `${n.trafficMoved}, band's lapped traffic moved within a key in ${n.bandMoved}`);
    }, 120000);
  }
});

// Out-lap anchor, pit lane, sector marks and gap list on the races
// (circleOfDoom.js header, circlePitLane.js, circleSectors.js, circleGapList.js)
const BAND_KEYS = ['focusPhase', 'rejoinPhase', 'rejoinArc', 'trafficOnly', 'bandSeconds'];
const withoutBand = (w) => Object.fromEntries(Object.entries(w).filter(([k]) => !BAND_KEYS.includes(k)));

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16): LEC stops on lap 15', () => {
  // pit entry 4628.772, in-lap 15 ends inside the lane at 4632.468, pit exit
  // 4653.191 (on lap 16), out-lap 16 ends at 4737.356
  let lapTimes;
  beforeAll(() => {
    lapTimes = loadCachedSession(2024, 16).lap_times;
  });

  it('in the pit lane 4628.772-4653.191 s (24.42 s); laneStats counts the stop from its exit only', () => {
    expect(pitStatus(lapTimes, 'LEC', 4628)).toMatchObject({ status: null, inLane: false });
    expect(pitStatus(lapTimes, 'LEC', 4640)).toEqual({
      status: 'lane', pitInTime: 4628.772, pitOutTime: null, inLane: true,
    });
    const out = pitStatus(lapTimes, 'LEC', 4654);
    expect(out).toMatchObject({ status: 'out', pitInTime: 4628.772, pitOutTime: 4653.191, inLane: false });
    expect(out.pitOutTime - out.pitInTime).toBeCloseTo(24.42, 2);
    expect(pitStatus(lapTimes, 'LEC', 4737.4).status).toBeNull();
    // LEC's is the only pit exit between 4640 and 4654 s
    expect(lapTimes.filter((r) => r.PitOutTimeSeconds > 4640 && r.PitOutTimeSeconds <= 4654).map((r) => r.Driver))
      .toEqual(['LEC']);
    const before = laneStats(lapTimes, 4640);
    const after = laneStats(lapTimes, 4654);
    expect(before.median).not.toBeNull();
    expect(after.n).toBe(before.n + 1);
  });

  it('pit-exit anchor at 4680 s: LEC drawn from its exit, its rejoin marker between NOR and OCO', () => {
    const est = estimatePitLoss(lapTimes, { sessionNow: 4680 });
    const st = circleState(lapTimes, { sessionNow: 4680, outLapAnchor: 'pitExit' });
    const lec = st.cars.find((c) => c.driver === 'LEC');
    expect(lec).toMatchObject({
      lastCrossingTime: 4632.468, anchorTime: 4653.191, pitExitTime: 4653.191, inPitLane: false,
    });
    expect(lec.phase).toBeCloseTo((4680 - 4653.191) / st.refLap.seconds, 9);
    expect(lec.linePhase).toBeCloseTo((4680 - 4632.468) / st.refLap.seconds, 9);
    const w = pitWindow('LEC', st, est);
    expect(w).toMatchObject({ available: true, ongoingStop: true, stage: 'out-lap' });
    // the nearest cars drawn ahead of and behind the marker on the ring
    const ring = st.cars
      .filter((c) => c.driver !== 'LEC' && !c.inPitLane && !c.finished)
      .map((c) => ({ driver: c.driver, ahead: wrapPhase(c.phase - w.rejoinPhase) }))
      .sort((a, b) => a.ahead - b.ahead);
    expect(ring[0].driver).toBe('NOR');
    expect(ring[ring.length - 1].driver).toBe('OCO');
    // the rank's neighbours at the predicted crossing are the same two cars
    const ahead = w.rivalCrossings.filter((r) => r.time < w.predictedCrossing);
    const behind = w.rivalCrossings.filter((r) => r.time >= w.predictedCrossing);
    expect(ahead[ahead.length - 1].driver).toBe('NOR');
    expect(behind[0].driver).toBe('OCO');
    // the line anchor: the same marker and the same rank; only the drawn car moves
    const line = pitWindow('LEC', circleState(lapTimes, { sessionNow: 4680, outLapAnchor: 'line' }), est);
    expect(line.rejoinPhase).toBeCloseTo(w.rejoinPhase, 12);
    expect(withoutBand(line)).toEqual(withoutBand(w));
    expect(line.focusPhase - w.focusPhase).toBeCloseTo((4653.191 - 4632.468) / st.refLap.seconds, 9);
  });

  it('causal: every row not known at 4640 / 4680 s changed, the same stop, marks and gap rows', () => {
    for (const now of [4640, 4680]) {
      const future = perturbFuture(lapTimes, now);
      for (const d of ['LEC', 'NOR', 'OCO', 'PIA', 'MAG']) expect(pitStatus(future, d, now)).toEqual(pitStatus(lapTimes, d, now));
      expect(laneStats(future, now)).toEqual(laneStats(lapTimes, now));
      const ref = referenceLap(lapTimes, { sessionNow: now });
      expect(sectorFractions(future, referenceLap(future, { sessionNow: now }), now)).toEqual(sectorFractions(lapTimes, ref, now));
      const a = circleState(lapTimes, { sessionNow: now, outLapAnchor: 'pitExit' });
      const b = circleState(future, { sessionNow: now, outLapAnchor: 'pitExit' });
      const opts = { focus: 'LEC', selected: ['NOR', 'OCO', 'PIA'] };
      expect(gapRows(b, future, now, opts)).toEqual(gapRows(a, lapTimes, now, opts));
      // at 4640 s LEC is in the lane after the line: only driverStateAt's inPitLane
      // reads the out-lap's PitOutTime there (circleOfDoom.test.js, causality)
      const fields = (st) => st.cars.map(({ inPitLane, ...c }) => c);
      expect(fields(b)).toEqual(fields(a));
    }
  });
});

// Arrival on the line at the end of the out-lap of the driver's first green
// stop: the pit-exit anchor's phase just before the crossing (the line anchor
// holds the car at 0.999 there)
const ARRIVALS = [[2024, 16, 'LEC', 0.985], [2024, 5, 'VER', 0.961], [2024, 7, 'VER', 0.943]];

describe.skipIf(!ARRIVALS.some(([y, r]) => hasCachedSession(y, r)))('arrival phase on the line at the end of the out-lap', () => {
  for (const [year, round, driver, expected] of ARRIVALS) {
    it.skipIf(!hasCachedSession(year, round))(`${year} R${round} ${driver}: about ${expected}`, () => {
      const lapTimes = loadCachedSession(year, round).lap_times;
      const first = estimatePitLoss(lapTimes).samples.filter((s) => s.driver === driver).sort((a, b) => a.inLap - b.inLap)[0];
      const outLap = row(lapTimes, driver, first.inLap + 1);
      const t = outLap.Time - 1e-3;
      const exit = circleState(lapTimes, { sessionNow: t, outLapAnchor: 'pitExit' }).cars.find((c) => c.driver === driver);
      const line = circleState(lapTimes, { sessionNow: t, outLapAnchor: 'line' }).cars.find((c) => c.driver === driver);
      expect(exit.anchorTime).toBe(outLap.PitOutTimeSeconds);
      expect(exit.phase).toBeCloseTo(expected, 2);
      expect(exit.saturated).toBe(false);
      expect(line).toMatchObject({ phase: PHASE_MAX, saturated: true });
    });
  }
});

// Sector boundaries as shares of the lap time, after the leader's laps 5 and 20 and at the end
const SPLITS = [[2024, 16, 0.326, 0.668], [2024, 5, 0.266, 0.568]];

describe.skipIf(!SPLITS.some(([y, r]) => hasCachedSession(y, r)))('sector fractions', () => {
  for (const [year, round, f1, f12] of SPLITS) {
    it.skipIf(!hasCachedSession(year, round))(`${year} R${round}: within 0.005 of ${f1} / ${f12}; none on lap 1`, () => {
      const lapTimes = loadCachedSession(year, round).lap_times;
      for (const now of [leaderLapEndTime(lapTimes, 5) + 1, leaderLapEndTime(lapTimes, 20) + 1, Infinity]) {
        const f = sectorFractions(lapTimes, referenceLap(lapTimes, { sessionNow: now }), now);
        expect(f.n).toBeGreaterThanOrEqual(10);
        expect(Math.abs(f.f1 - f1)).toBeLessThan(0.005);
        expect(Math.abs(f.f12 - f12)).toBeLessThan(0.005);
      }
      const start = Math.min(...lapTimes.filter((r) => r.LapNumber === 1).map((r) => r.LapStartTime));
      for (const now of [start + 30, leaderLapEndTime(lapTimes, 1) + 1]) {
        expect(sectorFractions(lapTimes, referenceLap(lapTimes, { sessionNow: now }), now)).toBeNull();
      }
    });
  }
});

describe.skipIf(!SWEEP.length)('sweep: the out-lap anchor moves the drawn phases only', () => {
  for (const [year, round] of SWEEP) {
    it(`${year} R${round}`, () => {
      const lapTimes = loadCachedSession(year, round).lap_times;
      const last = Math.max(...lapTimes.map((r) => r.LapNumber));
      const flag = leaderLapEndTime(lapTimes, last);
      const start = Math.min(...lapTimes.filter((r) => r.LapNumber === 1).map((r) => r.LapStartTime));
      const n = {
        windows: 0, anchored: 0, order: 0, window: 0, marker: 0,
      };
      for (let now = start + 200; now < flag; now += 120) {
        const a = circleState(lapTimes, { sessionNow: now, outLapAnchor: 'line' });
        const b = circleState(lapTimes, { sessionNow: now, outLapAnchor: 'pitExit' });
        const order = (st) => st.cars.map((c) => `${c.driver}:${c.position}:${c.lapsCompleted}:${c.lapOffsetToLeader}`).join();
        if (order(a) !== order(b)) n.order += 1;
        const est = estimatePitLoss(lapTimes, { sessionNow: now });
        for (const car of b.cars) {
          if (car.anchorTime !== car.lastCrossingTime) n.anchored += 1;
          const wa = pitWindow(car.driver, a, est, { totalLaps: last });
          const wb = pitWindow(car.driver, b, est, { totalLaps: last });
          if (!wa.available) continue;
          n.windows += 1;
          if (JSON.stringify(withoutBand(wa)) !== JSON.stringify(withoutBand(wb))) n.window += 1;
          // a stop under way: one rejoin marker whatever the anchor
          if (wa.ongoingStop && Math.abs(wrapPhase(wa.rejoinPhase - wb.rejoinPhase + 0.5) - 0.5) > 1e-9) n.marker += 1;
        }
      }
      expect(n.windows).toBeGreaterThan(300);
      expect(n.anchored).toBeGreaterThan(0);
      expect({ ...n, windows: 0, anchored: 0 }).toEqual({
        windows: 0, anchored: 0, order: 0, window: 0, marker: 0,
      });
    }, 60000);
  }
});
