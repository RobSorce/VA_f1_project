import { describe, it, expect } from 'vitest';
import {
  referenceLap, phases, phaseAt, circleState, gapSeconds, lapOffset, pitWindow, rankByCrossing,
  rejoinProbabilities, rejoinDistribution, seededRandom, circleMemoKey, circleStateKey, ringRelations,
  wrapPhase, PHASE_MAX,
} from '../circleOfDoom.js';
import { estimatePitLoss, FALLBACK_PIT_LOSS } from '../pitLoss.js';
import { perturbFuture } from './futureRows.js';

// Synthetic race on the SESSION clock, 10 laps of 90 s, start at T0.
// Each car starts lap 1 at T0 and loses `offset` s on lap 1, so it completes
// lap k at T0 + offset + 90 k: `offset` s behind the leader at every line.
//   LEAD 0, AHD 4, FOC 10 (the focus), B5 15, B12 22, B215 31.5, B30 41
//   PIT  50: in-lap 6 (pit entry T0 + 575, 95 s), out-lap 7 (pit exit T0 + 610,
//        107 s): a 5 + 17 = 22 s stop
//   LAPD lap 2 lasts 200 s under yellow: completes lap k at T0 + 112 + 90 k,
//        one lap + 12 s behind FOC (12 s behind it on track), 9 laps
//   RET  60, three laps, then retires on track
// At NOW = T0 + 580: FOC has completed 6 laps (T0 + 550) and runs lap 7.
const T0 = 1000;
const NOW = T0 + 580;

function car(code, { offset = 0, laps = 10, durations = {}, extra = {} } = {}) {
  const rows = [];
  let start = T0;
  for (let k = 1; k <= laps; k++) {
    const dur = durations[k] ?? (k === 1 ? 90 + offset : 90);
    rows.push({
      Driver: code, LapNumber: k, LapStartTime: start, Time: start + dur, LapTimeSeconds: dur,
      TrackStatus: '1', PitInTimeSeconds: null, PitOutTimeSeconds: null,
      Stint: 1, Compound: 'MEDIUM', TyreLife: k,
      ...(extra[k] ? extra[k](start, start + dur) : {}),
    });
    start += dur;
  }
  return rows;
}

/** Position of every row = order of the Times on its lap. */
function withPositions(rows) {
  const byLap = new Map();
  for (const r of rows) {
    if (!byLap.has(r.LapNumber)) byLap.set(r.LapNumber, []);
    byLap.get(r.LapNumber).push(r);
  }
  for (const list of byLap.values()) list.sort((a, b) => a.Time - b.Time).forEach((r, i) => { r.Position = i + 1; });
  return rows;
}

const newSet = (k) => (k >= 7 ? { Stint: 2, Compound: 'HARD', TyreLife: k - 6 } : {});
const RACE = withPositions([
  ...car('LEAD'),
  ...car('AHD', { offset: 4 }),
  ...car('FOC', { offset: 10 }),
  ...car('B5', { offset: 15 }),
  ...car('B12', { offset: 22 }),
  ...car('B215', { offset: 31.5 }),
  ...car('B30', { offset: 41 }),
  ...car('PIT', {
    offset: 50,
    durations: { 6: 95, 7: 107 },
    extra: Object.fromEntries(Array.from({ length: 10 }, (_, i) => i + 1).map((k) => [k, (s) => ({
      ...newSet(k),
      ...(k === 6 ? { PitInTimeSeconds: s + 75 } : {}),
      ...(k === 7 ? { PitOutTimeSeconds: s + 15 } : {}),
    })])),
  }),
  ...car('LAPD', { offset: 2, laps: 9, durations: { 2: 200 }, extra: { 2: () => ({ TrackStatus: '2' }) } }),
  ...car('RET', { offset: 60, laps: 3 }),
]);

const state = (now = NOW, lapTimes = RACE) => circleState(lapTimes, { sessionNow: now });
const carOf = (st, d) => st.cars.find((c) => c.driver === d);

describe('referenceLap', () => {
  it('median of the clean laps of the last 5 leader laps', () => {
    // Leader has 6 laps at NOW: window laps 2-6. Clean laps: 5 each for LEAD, AHD,
    // FOC, B5, B12, B215; 4 for B30 and PIT; LAPD 3 (lap 2 yellow); RET 2
    expect(referenceLap(RACE, { sessionNow: NOW }))
      .toEqual({ seconds: 90, nSamples: 43, laps: [2, 6], source: 'race' });
  });

  it('skips non-green, pit and lap-1 laps; widens back until 10 samples or lap 2', () => {
    const sc = (codes) => codes.flatMap((d, i) => car(d, {
      offset: i,
      durations: { 6: 130, 7: 130, 8: 130, 9: 130, 10: 130 },
      extra: Object.fromEntries([6, 7, 8, 9, 10].map((k) => [k, () => ({ TrackStatus: '4' })])),
    }));
    // 3 cars: laps 6-10 under SC, lap 5 -> 3 samples, 4 -> 6, 3 -> 9, 2 -> 12
    expect(referenceLap(sc(['A', 'B', 'C']))).toEqual({ seconds: 90, nSamples: 12, laps: [2, 10], source: 'race' });
    // 2 cars: 8 green laps at most, the window stops at lap 2
    expect(referenceLap(sc(['A', 'B']))).toEqual({ seconds: 90, nSamples: 8, laps: [2, 10], source: 'race' });
  });

  it('fallback with only lap 1 completed; none before the first lap ends', () => {
    // lap 1 times: 90 + offset; LEAD..B30 + LAPD + RET + PIT completed lap 1 by T0 + 155
    const ref = referenceLap(RACE, { sessionNow: T0 + 155 });
    expect(ref.source).toBe('fallback');
    expect(ref.laps).toEqual([1, 1]);
    expect(ref.seconds).toBe(108.5); // median of 90, 92, 94, 100, 105, 112, 121.5, 131, 140, 150
    expect(referenceLap(RACE, { sessionNow: T0 + 50 }))
      .toEqual({ seconds: null, nSamples: 0, laps: null, source: 'none' });
    expect(phases(RACE, { sessionNow: T0 + 50 }).every((c) => c.phase === null)).toBe(true);
  });

  it('is causal', () => {
    expect(referenceLap(perturbFuture(RACE, NOW), { sessionNow: NOW })).toEqual(referenceLap(RACE, { sessionNow: NOW }));
  });
});

describe('phases: geometry', () => {
  it('race order, phase = time since the last crossing / reference lap, angle clockwise from the top', () => {
    const cars = phases(RACE, { sessionNow: NOW });
    expect(cars.map((c) => c.driver)).toEqual(['LEAD', 'AHD', 'FOC', 'B5', 'B12', 'B215', 'B30', 'PIT', 'LAPD']);
    expect(cars.map((c) => c.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const foc = cars[2];
    expect(foc).toMatchObject({ lapsCompleted: 6, lastCrossingTime: T0 + 550, elapsed: 30, inPitLane: false });
    expect(foc.phase).toBeCloseTo(30 / 90, 12);
    expect(foc.angle).toBeCloseTo((30 / 90) * 2 * Math.PI, 12);
    expect(phaseAt(foc, NOW, 90)).toEqual({ elapsed: 30, phase: foc.phase, angle: foc.angle, saturated: false });
  });

  it('wraps around at the line: a car just past it sits next to a car just before it', () => {
    // T0 + 541: LEAD crossed 1 s ago (lap 6), AHD crosses in 3 s (still on lap 6)
    const st = state(T0 + 541);
    const lead = carOf(st, 'LEAD');
    const ahd = carOf(st, 'AHD');
    expect(lead.lapsCompleted).toBe(6);
    expect(ahd.lapsCompleted).toBe(5);
    expect(lead.phase).toBeCloseTo(1 / 90, 12);
    expect(ahd.phase).toBeCloseTo(87 / 90, 12);
    // angular distance across the top = the 4 s gap, and AHD is not lapped
    expect(wrapPhase(lead.phase - ahd.phase) * 90).toBeCloseTo(4, 9);
    expect(gapSeconds('LEAD', 'AHD', st)).toBeCloseTo(4, 9);
    expect(lapOffset('LEAD', 'AHD', st)).toBe(0);
    expect(ahd.position).toBe(2);
    expect(ahd.lapOffsetToLeader).toBe(0);
  });

  it('flags a car in the pit lane (inner arc) between pit entry and pit exit', () => {
    expect(carOf(state(T0 + 574), 'PIT').inPitLane).toBe(false);
    expect(carOf(state(T0 + 575), 'PIT').inPitLane).toBe(true);  // pit entry
    expect(carOf(state(T0 + 600), 'PIT').inPitLane).toBe(true);  // in-lap ended in the lane
    expect(carOf(state(T0 + 610), 'PIT').inPitLane).toBe(false); // pit exit
  });

  it('drops a retired car once its final lap has ended', () => {
    expect(carOf(state(T0 + 329), 'RET')).toMatchObject({ lapsCompleted: 2, retired: false });
    expect(carOf(state(T0 + 330), 'RET')).toBeUndefined();
    const all = phases(RACE, { sessionNow: T0 + 330, includeRetired: true });
    expect(all[all.length - 1]).toMatchObject({ driver: 'RET', retired: true, position: null });
  });

  it('lapped car: lap offset to the leader, and a gap holding the whole lap', () => {
    const st = state();
    expect(carOf(st, 'LAPD')).toMatchObject({ lapsCompleted: 5, lapOffsetToLeader: 1 });
    expect(lapOffset('FOC', 'LAPD', st)).toBe(1);
    expect(lapOffset('LAPD', 'FOC', st)).toBe(-1);
    expect(gapSeconds('FOC', 'LAPD', st)).toBeCloseTo(102, 9); // one lap + 12 s
    // on the ring LAPD is 12 s behind FOC
    expect(wrapPhase(carOf(st, 'FOC').phase - carOf(st, 'LAPD').phase) * 90).toBeCloseTo(12, 9);
  });

  it('a lap longer than the reference stops at 0.999, flagged saturated', () => {
    // PIT's out-lap lasts 107 s: 95 s into it, 95 / 90 > 1
    const pit = carOf(state(T0 + 690), 'PIT');
    expect(pit.phase).toBe(PHASE_MAX);
    expect(pit.saturated).toBe(true);
  });

  it('start, chequered flag and race over', () => {
    const grid = phases(RACE, { sessionNow: T0 - 50, refLap: 90 });
    expect(grid.every((c) => c.phase === 0 && c.lapsCompleted === 0 && c.lastCrossingTime === T0)).toBe(true);
    // T0 + 905: LEAD (900) and AHD (904) took the flag, FOC (910) has not
    const flag = state(T0 + 905);
    expect(['LEAD', 'AHD'].map((d) => carOf(flag, d)).every((c) => c.finished && c.phase === 0)).toBe(true);
    expect(carOf(flag, 'FOC')).toMatchObject({ finished: false, lapsCompleted: 9 });
    const over = phases(RACE, { sessionNow: Infinity });
    expect(over).toHaveLength(9);
    expect(over.every((c) => c.finished && c.phase === 0)).toBe(true);
    expect(over.find((c) => c.driver === 'LAPD').lapOffsetToLeader).toBe(1);
  });
});

describe('gapSeconds', () => {
  it('signed: positive when b is behind a, from the latest lap both completed', () => {
    const st = state();
    expect(gapSeconds('FOC', 'B5', st)).toBeCloseTo(5, 9);
    expect(gapSeconds('B5', 'FOC', st)).toBeCloseTo(-5, 9);
    expect(gapSeconds('FOC', 'B30', st)).toBeCloseTo(31, 9); // B30 is still on lap 6
    expect(gapSeconds('FOC', 'FOC', st)).toBe(0);
  });

  it('null for a car not on the circle or before both completed a lap', () => {
    expect(gapSeconds('FOC', 'RET', state())).toBeNull();
    expect(gapSeconds('FOC', 'XXX', state())).toBeNull();
    expect(gapSeconds('FOC', 'B5', state(T0 + 50))).toBeNull();
  });
});

describe('pitWindow (synthetic, fallback pit loss 22 s)', () => {
  const st = state();
  const est = estimatePitLoss(RACE, { sessionNow: NOW });

  it('uses the race estimate at sessionNow (fallback here: no measurable stop yet)', () => {
    expect(est.source).toBe('fallback');
    expect(est.median).toBe(FALLBACK_PIT_LOSS.median);
  });

  it('rank after a stop now: predicted crossing of the out-lap, lap-aware rule', () => {
    const w = pitWindow('FOC', st, est);
    expect(w).toMatchObject({
      focus: 'FOC', available: true, ongoingStop: false, stage: null, targetLap: 8,
      currentPosition: 3, predictedPosition: 6, positionsLost: 3, pace: 90, refLap: 90,
      pitLoss: { median: 22, n: 0, source: 'fallback' },
    });
    // lastCrossingTime + 2 x pace + median loss
    expect(w.predictedCrossing).toBeCloseTo(T0 + 550 + 180 + 22, 9);
    expect(w.rivalCrossings).toHaveLength(8);
  });

  it('threshold lists: same-lap cars within the pit loss behind / ahead (equal paces)', () => {
    const w = pitWindow('FOC', st, est);
    expect(w.wouldPassFocus.map((x) => x.driver)).toEqual(['B5', 'B12', 'B215']); // 5, 12, 21.5 s < 22 s
    expect(w.wouldPassFocus.map((x) => x.gapSeconds)).toEqual([5, 12, 21.5].map((g) => expect.closeTo(g, 9)));
    expect(w.wouldPassFocus.map((x) => x.marginSeconds)).toEqual([17, 10, 0.5].map((g) => expect.closeTo(g, 9)));
    // B30 is 31 s behind: it stays behind
    expect(w.wouldPassFocus.find((x) => x.driver === 'B30')).toBeUndefined();
    // If THEY pitted now: AHD (6 s ahead) and LEAD (10 s ahead) would drop behind
    expect(w.wouldDropBehindFocus.map((x) => x.driver)).toEqual(['AHD', 'LEAD']);
    expect(w.wouldDropBehindFocus.map((x) => x.marginSeconds)).toEqual([16, 12].map((g) => expect.closeTo(g, 9)));
  });

  it('lapped car inside the band: traffic only (1L), no place lost to it', () => {
    const w = pitWindow('FOC', st, est);
    expect(w.trafficOnly).toEqual([{ driver: 'LAPD', laps: 1, label: '1L' }]);
    expect(w.wouldPassFocus.find((x) => x.driver === 'LAPD')).toBeUndefined();
  });

  it('cars about to lap the focus inside its band: traffic only (-1L)', () => {
    // LAPD's band: B215 is 9.5 s and B30 19 s behind it on track, both a lap ahead in the race
    const w = pitWindow('LAPD', st, est);
    expect(w.trafficOnly).toEqual([
      { driver: 'B215', laps: -1, label: '-1L' },
      { driver: 'B30', laps: -1, label: '-1L' },
    ]);
    expect(lapOffset('LAPD', 'B215', st)).toBe(0); // not passed yet
    expect(w.predictedPosition).toBe(w.currentPosition);
  });

  it('traffic at the predicted rejoin: the last car across the line before it, flagged under 1.0 s', () => {
    const w = pitWindow('FOC', st, est);
    // FOC completes lap 8 at T0 + 550 + 180 + 22 = T0 + 752; B215 completes it at T0 + 751.5
    expect(w.traffic).toMatchObject({ flag: true, carAhead: 'B215', carAheadLaps: 0, thresholdSeconds: 1 });
    expect(w.traffic.gapSeconds).toBeCloseTo(0.5, 9);
    expect(w.traffic.gapSeconds).toBeCloseTo(w.predictedCrossing - (T0 + 31.5 + 8 * 90), 9);
    // every car runs at the reference lap here, so it equals the ring distance from
    // the drawn rejoin point forward to B215
    const rejoin = wrapPhase(carOf(st, 'FOC').phase - w.rejoinOffset);
    expect(wrapPhase(carOf(st, 'B215').phase - rejoin) * 90).toBeCloseTo(w.traffic.gapSeconds, 9);
    // B5 would rejoin 5.5 s behind B215: clear air, the nearest car is still reported
    const b5 = pitWindow('B5', st, est);
    expect(b5.traffic.flag).toBe(false);
    expect(b5.traffic.carAhead).toBe('B215');
    expect(b5.traffic.gapSeconds).toBeCloseTo(5.5, 9);
    // any lap: LAPD's rejoin (T0 + 562 + 180 + 22 = T0 + 764 at the end of its lap 7)
    // comes 3 s after B30 completes lap 8 (T0 + 41 + 720 = T0 + 761): a car one lap up
    const lapd = pitWindow('LAPD', st, est);
    expect(lapd.traffic).toMatchObject({ carAhead: 'B30', carAheadLaps: -1, flag: false });
    expect(lapd.traffic.gapSeconds).toBeCloseTo(3, 9);
  });

  it('band geometry: rejoin point = focus phase - loss / reference lap, arc from p10 / p90', () => {
    const w = pitWindow('FOC', st, est);
    expect(w.focusPhase).toBeCloseTo(30 / 90, 12);
    expect(w.rejoinOffset).toBeCloseTo(22 / 90, 12);
    expect(w.rejoinPhase).toBeCloseTo(wrapPhase(30 / 90 - 22 / 90), 12);
    expect(w.rejoinArcOffset[0]).toBeCloseTo(est.p10 / 90, 12);
    expect(w.rejoinArcOffset[1]).toBeCloseTo(est.p90 / 90, 12);
    expect(w.rejoinArc[0]).toBeCloseTo(wrapPhase(30 / 90 - est.p10 / 90), 12);
    expect(w.rejoinArc[1]).toBeCloseTo(wrapPhase(30 / 90 - est.p90 / 90), 12);
    // a large loss wraps the rejoin point past the line
    const big = pitWindow('FOC', st, { ...est, median: 45, source: 'race', n: 3 });
    expect(big.rejoinPhase).toBeCloseTo(wrapPhase(30 / 90 - 45 / 90), 12);
    expect(big.rejoinPhase).toBeGreaterThan(0.8);
  });

  it('a car already stopping: its stop is projected (in-lap, then out-lap)', () => {
    const inLap = pitWindow('PIT', st, est);
    expect(inLap).toMatchObject({ ongoingStop: true, stage: 'in-lap', targetLap: 7 });
    // the threshold lists stay the gap rule: B30 9 s and B215 18.5 s ahead, within 22 s
    expect(inLap.wouldDropBehindFocus.map((x) => [x.driver, x.gapSeconds, x.marginSeconds]))
      .toEqual([['B30', -9, 13], ['B215', -18.5, 3.5]].map(([d, g, m]) => [d, expect.closeTo(g, 9), expect.closeTo(m, 9)]));
    expect(inLap.predictedCrossing).toBeCloseTo(T0 + 702, 9); // = PIT's actual lap 7 end (a 22 s stop)
    const outLap = pitWindow('PIT', state(T0 + 600), estimatePitLoss(RACE, { sessionNow: T0 + 600 }));
    expect(outLap).toMatchObject({ ongoingStop: true, stage: 'out-lap', targetLap: 7 });
    // in-lap lost 95 - 90 = 5 s of the 22 s: 17 s still to come
    expect(outLap.predictedCrossing).toBeCloseTo(T0 + 595 + 90 + 17, 9);
    expect(outLap.rejoinOffset).toBeCloseTo(17 / 90, 12);
  });

  it('a rival in the pit lane carries its pending loss', () => {
    const w = pitWindow('FOC', st, est);
    const pit = w.rivalCrossings.find((r) => r.driver === 'PIT');
    expect(pit).toMatchObject({ stage: 'in-lap', pendingLoss: 22, projected: true });
    expect(pit.time).toBeCloseTo(T0 + 500 + 3 * 90 + 22, 9); // lap 8
  });

  it('no window when it cannot be computed', () => {
    expect(pitWindow(null, st, est)).toMatchObject({ available: false, reason: 'no-focus' });
    expect(pitWindow('RET', st, est)).toMatchObject({ available: false, reason: 'not-running' });
    expect(pitWindow('FOC', state(Infinity), est)).toMatchObject({ available: false, reason: 'race-over' });
    expect(pitWindow('FOC', state(T0 + 50), est)).toMatchObject({ available: false, reason: 'no-reference-lap' });
    expect(pitWindow('FOC', st, { ...est, median: null, source: 'not-applicable' }))
      .toMatchObject({ available: false, reason: 'not-applicable' });
    // FOC completes lap 9 at T0 + 820: a stop then would end after lap 10
    expect(pitWindow('FOC', state(T0 + 821), est)).toMatchObject({ available: false, reason: 'last-lap' });
    expect(pitWindow('FOC', state(T0 + 819), est)).toMatchObject({ available: true, targetLap: 10 });
    expect(pitWindow('LEAD', state(T0 + 905), est)).toMatchObject({ available: false, reason: 'finished' });
  });

  it('the last lap is lap-aware, and the window closes at the chequered flag', () => {
    // LAPD is one lap down on LEAD: it takes the flag at the end of lap 9, not 10
    const before = state(T0 + 800); // LAPD has completed 7 laps: out-lap = lap 9
    expect(carOf(before, 'LAPD')).toMatchObject({ lapsCompleted: 7, lapOffsetToLeader: 1 });
    expect(pitWindow('LAPD', before, est)).toMatchObject({ available: true, targetLap: 9 });
    const late = state(T0 + 840); // 8 laps: the out-lap would be lap 10, which LAPD never runs
    expect(carOf(late, 'LAPD')).toMatchObject({ lapsCompleted: 8, lapOffsetToLeader: 1 });
    expect(pitWindow('LAPD', late, est)).toMatchObject({ available: false, reason: 'last-lap' });
    // LEAD completes lap 10 at T0 + 900: every car still running finishes at its next crossing
    expect(pitWindow('LAPD', state(T0 + 899), est)).toMatchObject({ available: false, reason: 'last-lap' });
    for (const d of ['FOC', 'B30', 'PIT', 'LAPD']) {
      expect(pitWindow(d, state(T0 + 901), est)).toMatchObject({ available: false, reason: 'chequered-flag' });
      expect(rejoinDistribution(d, state(T0 + 901), est)).toMatchObject({ available: false, reason: 'chequered-flag' });
    }
  });

  it('builds the state from opts.lapTimes / opts.sessionNow when given phases', () => {
    const viaOpts = pitWindow('FOC', phases(RACE, { sessionNow: NOW }), est, { lapTimes: RACE, sessionNow: NOW });
    expect(viaOpts).toEqual(pitWindow('FOC', st, est));
  });

  it('neutralised track flag', () => {
    expect(pitWindow('FOC', st, est, { trackFlag: '4' })).toMatchObject({ trackFlag: '4', neutralised: true });
    expect(pitWindow('FOC', st, est, { trackFlag: '6' }).neutralised).toBe(true);
    expect(pitWindow('FOC', st, est, { trackFlag: '2' }).neutralised).toBe(false);
    expect(pitWindow('FOC', st, est)).toMatchObject({ trackFlag: null, neutralised: false });
  });
});

describe('rejoin probabilities', () => {
  const st = state();
  const est = estimatePitLoss(RACE, { sessionNow: NOW });

  it('sum to 1; fallback = normal(22, 2.5): P5 when the loss < 21.5 s, else P6', () => {
    const d = rejoinDistribution('FOC', st, est);
    expect(d).toMatchObject({ available: true, samples: 1000, method: 'normal' });
    expect(d.positions.map((p) => p.position)).toEqual([5, 6]);
    expect(d.positions.reduce((a, p) => a + p.probability, 0)).toBeCloseTo(1, 12);
    // Phi(-0.2) = 0.42
    expect(d.positions[0].probability).toBeGreaterThan(0.37);
    expect(d.positions[0].probability).toBeLessThan(0.47);
    // traffic: 21.5 <= loss < 22.5 (behind B215 by < 1 s): Phi(0.2) - Phi(-0.2) = 0.16
    expect(d.trafficProbability).toBeGreaterThan(0.12);
    expect(d.trafficProbability).toBeLessThan(0.2);
    expect(rejoinProbabilities('FOC', st, est)).toEqual(d.positions);
  });

  it('bootstrap of the measured stops', () => {
    const race = { ...est, median: 25, p10: 21, p90: 29, n: 2, source: 'race', samples: [{ loss: 20 }, { loss: 30 }] };
    const d = rejoinDistribution('FOC', st, race, { samples: 2000 });
    expect(d.method).toBe('bootstrap');
    // loss 20 -> B215 (21.5 s) stays behind: P5; loss 30 -> P6 (B30 at 31 s stays behind)
    expect(d.positions.map((p) => p.position)).toEqual([5, 6]);
    expect(d.positions[0].probability).toBeGreaterThan(0.45);
    expect(d.positions[0].probability).toBeLessThan(0.55);
    expect(d.trafficProbability).toBe(0);
  });

  it('deterministic with a seed', () => {
    const a = rejoinProbabilities('FOC', st, est, { seed: 42 });
    expect(rejoinProbabilities('FOC', st, est, { seed: 42 })).toEqual(a);
    expect(rejoinProbabilities('FOC', st, est, { seed: 43 })).not.toEqual(a);
    const r1 = seededRandom(7);
    const r2 = seededRandom(7);
    const xs = Array.from({ length: 100 }, () => r1());
    expect(Array.from({ length: 100 }, () => r2())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('[] when no window can be computed', () => {
    expect(rejoinProbabilities('RET', st, est)).toEqual([]);
  });
});

/** Ahead in the race order (phases): more laps completed, or as many and across the line earlier. */
const aheadInRace = (a, b) => a.lapsCompleted > b.lapsCompleted
  || (a.lapsCompleted === b.lapsCompleted && a.lastCrossingTime < b.lastCrossingTime);

describe('band read off the drawn (clamped) ring; traffic at the predicted rejoin', () => {
  // T0 + 690: PIT runs its 107 s out-lap, 95 s in: drawn at 0.999 (85.9 s), not at 95 s
  const NOW2 = T0 + 690;
  const st = state(NOW2);
  const est = estimatePitLoss(RACE, { sessionNow: NOW2 });

  it('a saturated focus: band and lap labels read off the drawn phases, traffic off the projected crossings', () => {
    const pit = carOf(st, 'PIT');
    expect(pit).toMatchObject({ saturated: true, phase: PHASE_MAX });
    const w = pitWindow('PIT', st, est);
    expect(w).toMatchObject({ available: true, stage: 'out-lap' });
    // independent reading of the ring: cars on it, their distance behind the focus
    const ring = st.cars.filter((c) => c.driver !== 'PIT' && !c.inPitLane && !c.finished);
    const inBand = ring.filter((c) => {
      const behind = wrapPhase(pit.phase - c.phase);
      return behind > 0 && behind <= w.rejoinOffset;
    });
    const expected = inBand
      .map((c) => {
        const k = lapOffset('PIT', c.driver, st);
        if (k !== 0) return { driver: c.driver, laps: k, label: `${k}L` };
        return aheadInRace(c, pit) ? { driver: c.driver, laps: -1, label: '-1L' } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.driver.localeCompare(b.driver));
    expect(w.trafficOnly).toEqual(expected);
    // traffic: PIT completes lap 7 at T0 + 595 + 90 + 17 = T0 + 702 (its actual time);
    // the last car across the line before it is B30 (lap 7 at T0 + 671), 31 s ahead.
    // The drawn ring (PIT held at 0.999) would read 36.1 s: the clamp is not used.
    expect(w.predictedCrossing).toBeCloseTo(T0 + 702, 9);
    expect(w.traffic).toMatchObject({ carAhead: 'B30', carAheadLaps: 0, flag: false });
    expect(w.traffic.gapSeconds).toBeCloseTo(31, 9);
  });

  it('memo key: constant between events even while the ring is not rigid; the traffic flag never moves within it', () => {
    // T0 + 686 .. 700: PIT is held at 0.999 (its out-lap runs long), the others
    // move; no lap or pit event (B30 completes lap 8 at T0 + 761)
    const frames = Array.from({ length: 29 }, (_, i) => T0 + 686 + i * 0.5);
    const keys = new Set(frames.map((t) => circleMemoKey('FOC', RACE, t, estimatePitLoss(RACE, { sessionNow: t }))));
    expect(keys.size).toBe(1);
    // the view's pattern: state and analytics memoised at the first frame, the
    // cars moved with phaseAt, the band read off every frame
    const memoState = state(frames[0]);
    const memoEst = estimatePitLoss(RACE, { sessionNow: frames[0] });
    for (const focus of ['FOC', 'B5', 'B30', 'LAPD', 'AHD', 'PIT']) {
      const memoWin = pitWindow(focus, memoState, memoEst);
      const memoDist = rejoinDistribution(focus, memoState, memoEst);
      expect(memoWin.available).toBe(true);
      for (const t of frames) {
        const cars = memoState.cars.map((c) => ({ ...c, ...phaseAt(c, t, memoState.refLap) }));
        const frame = { ...memoState, sessionNow: t, cars };
        const ring = ringRelations(memoWin, frame);
        expect(Object.keys(ring).sort()).toEqual(['focusPhase', 'rejoinArc', 'rejoinPhase', 'trafficOnly']);
        // identical to computing everything again at this frame
        const fresh = state(t);
        expect(fresh.cars).toEqual(cars);
        const freshEst = estimatePitLoss(RACE, { sessionNow: t });
        const freshWin = pitWindow(focus, fresh, freshEst);
        expect({ ...memoWin, ...ring }).toEqual(freshWin);
        // the traffic flag and the probabilities (traffic share included) are the memoised ones
        expect(freshWin.traffic).toEqual(memoWin.traffic);
        expect(rejoinDistribution(focus, fresh, freshEst)).toEqual(memoDist);
      }
    }
    expect(ringRelations({ available: false }, memoState)).toBeNull();
  });
});

describe('the race order decides who is ahead (a rival in the middle of its stop)', () => {
  // ST2 leads FOC by 0.5 s at the end of lap 6, its in-lap (90.5 s, pit entry
  // before the line), then runs a 110 s out-lap (lap 7 ends at T0 + 659.5)
  const ST2 = car('ST2', {
    offset: 9,
    durations: { 6: 90.5, 7: 110 },
    extra: { 6: (s) => ({ PitInTimeSeconds: s + 85 }), 7: (s) => ({ PitOutTimeSeconds: s + 20 }) },
  });
  const RACE2 = withPositions([...RACE.map((r) => ({ ...r })), ...ST2]);

  it('behind on the road on its out-lap: a same-lap rival that gains the place, never -1L', () => {
    // T0 + 645: FOC has completed lap 7 (T0 + 640); ST2, on its out-lap, has not
    const NOW3 = T0 + 645;
    const st3 = circleState(RACE2, { sessionNow: NOW3 });
    const st2 = carOf(st3, 'ST2');
    const foc = carOf(st3, 'FOC');
    expect(st2).toMatchObject({ lapsCompleted: 6, saturated: true });
    expect(foc.lapsCompleted).toBe(7);
    expect(lapOffset('FOC', 'ST2', st3)).toBe(0);
    // the gap on lap 6, the latest lap both completed, still says "0.5 s ahead"
    expect(gapSeconds('FOC', 'ST2', st3)).toBeCloseTo(-0.5, 9);
    expect(st2.position).toBeGreaterThan(foc.position);
    const w = pitWindow('FOC', st3, estimatePitLoss(RACE2, { sessionNow: NOW3 }));
    expect(w.pitLoss.median).toBe(22);
    // once its stop is paid: -0.5 + (22 - (90.5 - 90)) = 21 s behind, within the 22 s loss
    const x = w.wouldPassFocus.find((y) => y.driver === 'ST2');
    expect(x.gapSeconds).toBeCloseTo(21, 9);
    expect(x.marginSeconds).toBeCloseTo(1, 9);
    expect(w.wouldDropBehindFocus.map((y) => y.driver)).not.toContain('ST2');
    // drawn at the line just behind FOC, inside the band, but not traffic
    const behind = wrapPhase(foc.phase - st2.phase) * st3.refLap.seconds;
    expect(behind).toBeGreaterThan(0);
    expect(behind).toBeLessThan(w.rejoinSeconds);
    expect(w.trafficOnly.map((y) => y.driver)).not.toContain('ST2');
  });

  it('ahead in the race on its out-lap: within reach by its gap before the stop, not a place lost', () => {
    // NOW: both have completed lap 6, ST2 0.5 s earlier (its in-lap)
    const st3 = circleState(RACE2, { sessionNow: NOW });
    const w = pitWindow('FOC', st3, estimatePitLoss(RACE2, { sessionNow: NOW }));
    expect(carOf(st3, 'ST2').position).toBeLessThan(carOf(st3, 'FOC').position);
    // before its stop: -0.5 - 0.5 (what the in-lap already lost) = 1 s ahead
    const x = w.wouldDropBehindFocus.find((y) => y.driver === 'ST2');
    expect(x.gapSeconds).toBeCloseTo(-1, 9);
    expect(w.wouldPassFocus.map((y) => y.driver)).not.toContain('ST2');
  });
});

describe('a rival that takes the chequered flag before the target lap is not ahead on it', () => {
  // LATE runs 90 s laps 74 s behind LEAD: lap 8 at T0 + 794, lap 9 at T0 + 884
  // (before LEAD's flag at T0 + 900), so it completes lap 10. CUT runs 92 s laps
  // 15 s behind LATE: lap 8 at T0 + 809, lap 9 at T0 + 901, after the flag: its
  // last lap is 9, and the data have no lap 10 for it.
  const CUT = car('CUT', {
    laps: 9,
    durations: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => [k, k === 1 ? 165 : 92])),
  });
  const RACE3 = withPositions([...RACE.map((r) => ({ ...r })), ...car('LATE', { offset: 74 }), ...CUT]);
  const NOW4 = T0 + 820;

  it('the rank leaves it out, as the validation script does (no lap n + 1 Time)', () => {
    const st4 = circleState(RACE3, { sessionNow: NOW4 });
    expect(carOf(st4, 'CUT')).toMatchObject({ lapsCompleted: 8, lapOffsetToLeader: 0 });
    const est4 = estimatePitLoss(RACE3, { sessionNow: NOW4 });
    const w = pitWindow('LATE', st4, est4);
    expect(w).toMatchObject({ available: true, targetLap: 10 });
    // LATE pits now: T0 + 794 + 180 + 22 = T0 + 996; CUT at its pace would complete
    // lap 10 at T0 + 993, but LEAD (projected flag T0 + 900) laps it first
    expect(w.predictedCrossing).toBeCloseTo(T0 + 996, 9);
    const cut = w.rivalCrossings.find((r) => r.driver === 'CUT');
    expect(cut).toMatchObject({ lastLap: 9, time: Infinity });
    expect(RACE3.some((r) => r.Driver === 'CUT' && r.LapNumber === 10)).toBe(false);
    const ahead = w.rivalCrossings.filter((r) => r.time < w.predictedCrossing).map((r) => r.driver);
    expect(ahead).not.toContain('CUT');
    expect(w.predictedPosition).toBe(1 + ahead.length);
    // nor in any draw, nor as traffic after the flag
    const d = rejoinDistribution('LATE', st4, est4);
    const best = Math.min(...d.positions.map((p) => p.position));
    const fewest = w.rivalCrossings.filter((r) => r.time < w.predictedCrossing - 10).length;
    expect(best).toBeGreaterThanOrEqual(1 + fewest);
    expect(w.traffic.carAhead).not.toBe('CUT');
  });
});

describe('lap 1: cars not yet across the line', () => {
  // End of sector 2 of lap 1 at T0 + 60 + offset (30 s before the line)
  const withSectors = RACE.map((r) => (r.LapNumber === 1
    ? { ...r, Sector2SessionTime: r.LapStartTime + 60 + (r.Time - r.LapStartTime - 90) }
    : r));
  // T0 + 95: LEAD (90), LAPD (92) and AHD (94) have crossed; FOC, B5, B12 and
  // B215 have passed sector 2 (70, 75, 82, 91.5); B30, PIT and RET have not
  const AT = T0 + 95;
  const GRID = { RET: 3, B30: 9, PIT: 0 };

  it('ordered by the last lap-1 timing point passed, then the grid (pit-lane start last)', () => {
    const cars = phases(withSectors, { sessionNow: AT, gridPositions: GRID });
    expect(cars.map((c) => c.driver))
      .toEqual(['LEAD', 'LAPD', 'AHD', 'FOC', 'B5', 'B12', 'B215', 'RET', 'B30', 'PIT']);
    expect(cars.map((c) => c.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(cars.find((c) => c.driver === 'FOC')).toMatchObject({ lapsCompleted: 0, lastCrossingTime: T0 });
  });

  it('no position where the data leave the place open (no timing point and no grid slot, or a tie)', () => {
    const cars = phases(withSectors, { sessionNow: AT });
    expect(cars.slice(0, 7).map((c) => c.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(cars.slice(7).map((c) => [c.driver, c.position])).toEqual([['B30', null], ['PIT', null], ['RET', null]]);
    // two pit-lane starters tie on every key
    const tied = phases(withSectors, { sessionNow: AT, gridPositions: { ...GRID, B30: 0 } });
    expect(tied.slice(7).map((c) => [c.driver, c.position])).toEqual([['RET', 8], ['B30', null], ['PIT', null]]);
    // before the start nobody has a place but the grid's
    expect(phases(withSectors, { sessionNow: T0 - 50, refLap: 90, gridPositions: GRID }).slice(0, 2)
      .map((c) => [c.driver, c.position])).toEqual([['RET', 1], ['B30', 2]]);
  });

  it('causal: later timing points and positions do not change the order', () => {
    const future = withSectors.map((r) => (r.LapNumber === 1 && r.Sector2SessionTime > AT
      ? { ...r, Sector2SessionTime: AT + 100 - r.Sector2SessionTime / 1000, Position: 1 }
      : r));
    expect(phases(perturbFuture(future, AT), { sessionNow: AT, gridPositions: GRID }))
      .toEqual(phases(withSectors, { sessionNow: AT, gridPositions: GRID }));
  });

  it('no pit window before the focus crosses, nor while a car on lap 1 has not passed sector 2', () => {
    const st = circleState(withSectors, { sessionNow: AT, gridPositions: GRID });
    const est = estimatePitLoss(withSectors, { sessionNow: AT });
    expect(pitWindow('FOC', st, est)).toMatchObject({ available: false, reason: 'first-lap' });
    expect(rejoinDistribution('FOC', st, est)).toMatchObject({ available: false, reason: 'first-lap', positions: [] });
    // AHD has crossed, but B30, PIT and RET have not reached the end of sector 2
    // (T0 + 101, 110, 120): nothing to project them from
    expect(pitWindow('AHD', st, est)).toMatchObject({ available: false, reason: 'field-on-lap-one' });
    expect(pitWindow('AHD', circleState(withSectors, { sessionNow: T0 + 119.9 }), est).reason).toBe('field-on-lap-one');
    // T0 + 120: every car on lap 1 has passed sector 2. Each is projected to the line
    // at its sector-2 time + the median last sector of the cars across (30 s here),
    // = its actual lap-1 crossing, then at its pace (the reference lap)
    const at120 = circleState(withSectors, { sessionNow: T0 + 120 });
    const w = pitWindow('AHD', at120, estimatePitLoss(withSectors, { sessionNow: T0 + 120 }));
    expect(w).toMatchObject({ available: true, targetLap: 3 });
    const ref = at120.refLap.seconds;
    for (const d of ['B215', 'B30', 'PIT', 'RET']) {
      const lapOneEnd = withSectors.find((r) => r.Driver === d && r.LapNumber === 1).Time;
      expect(w.rivalCrossings.find((r) => r.driver === d).time).toBeCloseTo(lapOneEnd + 2 * ref, 9);
    }
    // the rivals on lap 1 no longer share one projected crossing
    const onLapOne = w.rivalCrossings.filter((r) => at120.cars.find((c) => c.driver === r.driver).lapsCompleted === 0);
    expect(new Set(onLapOne.map((r) => r.time.toFixed(6))).size).toBe(onLapOne.length);
    // a car that never reaches sector 2 holds the window back only until the leader completes lap 2 (T0 + 180)
    const stuck = [...withSectors, ...car('SLOW', { durations: { 1: 200 } })];
    expect(pitWindow('FOC', circleState(stuck, { sessionNow: T0 + 179 }), est).reason).toBe('field-on-lap-one');
    expect(pitWindow('FOC', circleState(stuck, { sessionNow: T0 + 181 }), est).available).toBe(true);
    // B30 passes sector 2 at T0 + 101: no lap completed in between, a new state key
    expect(circleStateKey(withSectors, T0 + 100.5)).toBe(circleStateKey(withSectors, T0 + 100));
    expect(circleStateKey(withSectors, T0 + 101)).not.toBe(circleStateKey(withSectors, T0 + 100.5));
    expect(circleMemoKey('AHD', withSectors, T0 + 101, est)).not.toBe(circleMemoKey('AHD', withSectors, T0 + 100.5, est));
  });
});

describe('rank rule and memo key', () => {
  it('rankByCrossing: 1 + cars completing the lap strictly earlier', () => {
    expect(rankByCrossing(10, [5, 10, 15])).toBe(2);
    expect(rankByCrossing(1, [])).toBe(1);
  });

  it('memo key changes on a lap or pit event, the focus or the pit loss, not every frame', () => {
    const est = estimatePitLoss(RACE, { sessionNow: NOW });
    // events: B215 lap 6 at T0 + 571.5, PIT pit entry at T0 + 575, B30 lap 6 at T0 + 581
    const k = circleMemoKey('FOC', RACE, T0 + 576, est);
    expect(circleMemoKey('FOC', RACE, T0 + 580.9, est)).toBe(k);
    expect(circleMemoKey('FOC', RACE, T0 + 581, est)).not.toBe(k);
    expect(circleMemoKey('FOC', RACE, T0 + 574, est)).not.toBe(k);
    expect(circleMemoKey('B5', RACE, T0 + 576, est)).not.toBe(k);
    expect(circleMemoKey('FOC', RACE, T0 + 576, { ...est, median: 23, source: 'race', n: 1 })).not.toBe(k);
    const sc = [{ status: '4', start_time: T0 + 578, end_time: null }];
    expect(circleMemoKey('FOC', RACE, T0 + 576, est, sc)).not.toBe(circleMemoKey('FOC', RACE, T0 + 580, est, sc));
  });
});

describe('causality (synthetic)', () => {
  it('changing every future row leaves the circle, the window and the probabilities unchanged', () => {
    // Not between an in-lap end and the pit exit: there driverStateAt reads the
    // pit-lane state from the out-lap's PitOutTime, which perturbFuture removes
    for (const now of [T0 + 541, NOW, T0 + 690]) {
      const future = perturbFuture(RACE, now);
      const a = circleState(RACE, { sessionNow: now });
      const b = circleState(future, { sessionNow: now });
      expect(b.cars).toEqual(a.cars);
      expect(b.refLap).toEqual(a.refLap);
      const estA = estimatePitLoss(RACE, { sessionNow: now });
      const estB = estimatePitLoss(future, { sessionNow: now });
      for (const d of ['FOC', 'PIT', 'LAPD']) {
        expect(pitWindow(d, b, estB)).toEqual(pitWindow(d, a, estA));
        expect(rejoinProbabilities(d, b, estB)).toEqual(rejoinProbabilities(d, a, estA));
      }
      expect(circleMemoKey('FOC', future, now, estB)).toBe(circleMemoKey('FOC', RACE, now, estA));
    }
  });
});
