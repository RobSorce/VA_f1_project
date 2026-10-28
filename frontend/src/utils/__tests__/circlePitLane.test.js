import { describe, it, expect } from 'vitest';
import {
  pitStatus, laneStats, LANE_TIME_BOUNDS_S, LANE_MIN_STOPS,
} from '../circlePitLane.js';
import { driverStateAt } from '../driverState.js';
import { perturbFuture } from './futureRows.js';
import {
  T0, car, stop, withPositions,
} from './circleRace.js';

// Stops (session seconds from T0; lane time = pit exit - pit entry):
//   B  in-lap 3: entry 270, line in the lane 280, exit 292, out-lap ends 387  (22 s)
//   C  in-lap 4: entry 364, exit 388                                          (24 s)
//   D  in-lap 5: entry 456, exit 477                                          (21 s)
//   E  in-lap 5 under SC: entry 461, exit 484                                 (23 s, in-lap not green)
//   F  in-lap 6: entry 555, exit 625                                          (70 s, outside the bounds)
//   G  in-lap 1: entry 85, exit 107                                           (22 s, no lap before it)
//   H  enters the pits at 650 on its last row (lap 7) and stays there
//   I  in-lap 6: entry 570, but lap 7 has no PitOutTime; lap 7 ends at 687
//   A  never stops
const RACE = withPositions([
  ...car('A'),
  ...car('B', { offset: 5, ...stop(3) }),
  ...car('C', { offset: 8, ...stop(4, { entry: 9, exit: 15 }) }),
  ...car('D', { offset: 12, ...stop(5, { entry: 11, exit: 10 }) }),
  ...car('E', { offset: 16, ...stop(5, { exit: 13, inLapStatus: '4' }) }),
  ...car('F', { offset: 20, ...stop(6, { exit: 60, outLap: 150 }) }),
  ...car('G', { offset: 25, ...stop(1) }),
  ...car('H', { offset: 30, laps: 7, extra: { 7: (s, e) => ({ PitInTimeSeconds: e - 10 }) } }),
  ...car('I', { offset: 35, durations: { 6: 95, 7: 107 }, extra: { 6: (s, e) => ({ PitInTimeSeconds: e - 10 }) } }),
]);
const DRIVERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

describe('pitStatus', () => {
  it('lane from the pit entry to the pit exit (the in-lap ends inside it), out until the out-lap ends', () => {
    expect(pitStatus(RACE, 'B', T0 + 269.9)).toEqual({
      status: null, pitInTime: null, pitOutTime: null, inLane: false,
    });
    const lane = {
      status: 'lane', pitInTime: T0 + 270, pitOutTime: null, inLane: true,
    };
    expect(pitStatus(RACE, 'B', T0 + 270)).toEqual(lane);
    expect(pitStatus(RACE, 'B', T0 + 280)).toEqual(lane); // across the line inside the lane
    expect(pitStatus(RACE, 'B', T0 + 291.9)).toEqual(lane);
    const out = {
      status: 'out', pitInTime: T0 + 270, pitOutTime: T0 + 292, inLane: false,
    };
    expect(pitStatus(RACE, 'B', T0 + 292)).toEqual(out);
    expect(pitStatus(RACE, 'B', T0 + 386.9)).toEqual(out);
    expect(pitStatus(RACE, 'B', T0 + 387).status).toBeNull();
    expect(pitStatus(RACE, 'B', Infinity).status).toBeNull();
  });

  it('no later row: the car stays in the lane; an out-lap without a pit exit ends the stop at its end', () => {
    expect(pitStatus(RACE, 'H', T0 + 649.9).status).toBeNull();
    for (const t of [T0 + 650, T0 + 700, Infinity]) {
      expect(pitStatus(RACE, 'H', t)).toEqual({
        status: 'lane', pitInTime: T0 + 650, pitOutTime: null, inLane: true,
      });
    }
    expect(pitStatus(RACE, 'I', T0 + 570).status).toBe('lane');
    expect(pitStatus(RACE, 'I', T0 + 686.9).status).toBe('lane');
    expect(pitStatus(RACE, 'I', T0 + 687).status).toBeNull();
  });

  it('no stop, or an unknown driver: null', () => {
    for (const t of [T0, T0 + 500, Infinity]) expect(pitStatus(RACE, 'A', t).status).toBeNull();
    expect(pitStatus(RACE, 'XXX', T0 + 500)).toEqual({
      status: null, pitInTime: null, pitOutTime: null, inLane: false,
    });
    expect(pitStatus(null, 'A', T0).status).toBeNull();
  });

  it('inLane = driverStateAt.inPitLane wherever the out-lap has a PitOutTime', () => {
    let differ = 0;
    let lane = 0;
    for (let t = T0; t <= T0 + 800; t += 0.5) {
      for (const d of ['B', 'C', 'D', 'E', 'F', 'G', 'H']) {
        const p = pitStatus(RACE, d, t);
        if (p.inLane) lane += 1;
        if (p.inLane !== driverStateAt(RACE, d, t).inPitLane) differ += 1;
      }
    }
    expect(lane).toBeGreaterThan(400);
    expect(differ).toBe(0);
    // I's out-lap has none: driverStateAt ends the lane at the in-lap's end
    // (T0 + 580), pitStatus at the end of the out-lap, the first time it can know
    expect(driverStateAt(RACE, 'I', T0 + 600).inPitLane).toBe(false);
    expect(pitStatus(RACE, 'I', T0 + 600).inLane).toBe(true);
  });

  it('causal: every future row changed, the same status (in the lane after the line too)', () => {
    for (const t of [T0 + 100, T0 + 275, T0 + 285, T0 + 300, T0 + 470, T0 + 560, T0 + 600, T0 + 655, T0 + 690]) {
      const future = perturbFuture(RACE, t);
      for (const d of DRIVERS) expect(pitStatus(future, d, t)).toEqual(pitStatus(RACE, d, t));
    }
  });
});

describe('laneStats', () => {
  it('display bounds and minimum', () => {
    expect(LANE_TIME_BOUNDS_S).toEqual([10, 60]);
    expect(LANE_MIN_STOPS).toBe(3);
  });

  it('the stops whose pit exit has passed; a median from 3 stops', () => {
    expect(laneStats(RACE, T0 + 291.9)).toEqual({ median: null, n: 0 });
    expect(laneStats(RACE, T0 + 292)).toEqual({ median: null, n: 1 }); // B
    expect(laneStats(RACE, T0 + 388)).toEqual({ median: null, n: 2 }); // B, C
    expect(laneStats(RACE, T0 + 476.9)).toEqual({ median: null, n: 2 });
    expect(laneStats(RACE, T0 + 477)).toEqual({ median: 22, n: 3 }); // 21, 22, 24
    // E (in-lap under SC), F (70 s), G (lap 1), H (no exit) and I (no PitOutTime) never count
    expect(laneStats(RACE, Infinity)).toEqual({ median: 22, n: 3 });
  });

  it('the green in-lap and the lane-time bound decide the rest', () => {
    const variant = withPositions([
      ...RACE.filter((r) => r.Driver !== 'E' && r.Driver !== 'F'),
      ...car('E', { offset: 16, ...stop(5, { exit: 13 }) }), // green: 23 s counts
      ...car('F', { offset: 20, ...stop(6, { exit: 30, outLap: 120 }) }), // 40 s counts
    ]);
    expect(laneStats(variant, Infinity)).toEqual({ median: 23, n: 5 }); // 21, 22, 23, 24, 40
  });

  it('causal', () => {
    for (const t of [T0 + 285, T0 + 300, T0 + 400, T0 + 480, T0 + 600, T0 + 700]) {
      expect(laneStats(perturbFuture(RACE, t), t)).toEqual(laneStats(RACE, t));
    }
  });
});
