import { describe, it, expect } from 'vitest';
import {
  gapReference, gapRows, laneSecondsAt, TREND_THRESHOLD_S, TREND_LAPS, WIDE_NEIGHBOUR_CAPACITY,
} from '../circleGapList.js';
import { circleState, circleStateKey } from '../circleOfDoom.js';
import { perturbFuture } from './futureRows.js';
import {
  T0, car, stop, withPositions,
} from './circleRace.js';

// Twelve laps (L7 eleven). From lap 5 on, against L2's 90 s laps:
//   L3 89.8 s (closes 0.2 s a lap), L4 90.25 s (opens 0.25 s), L5 89.95 s (0.05 s: stable).
//   L6 stops: pit entry T0 + 555, in-lap 6 ends T0 + 565, pit exit T0 + 577,
//      out-lap 7 ends T0 + 672; 40 s behind L2 from lap 7 on.
//   L7 runs 100 s laps from lap 2: lap k ends T0 + 17 + 100 k; L1 laps it on lap 9.
// Gap from L2 at the end of lap k >= 4: L3 3 - 0.2 (k - 4), L4 7 + 0.25 (k - 4),
// L5 12 - 0.05 (k - 4).
const from5 = (t) => Object.fromEntries([5, 6, 7, 8, 9, 10, 11, 12].map((k) => [k, t]));
const RACE = withPositions([
  ...car('L1', { laps: 12 }),
  ...car('L2', { offset: 2, laps: 12 }),
  ...car('L3', { offset: 5, laps: 12, durations: from5(89.8) }),
  ...car('L4', { offset: 9, laps: 12, durations: from5(90.25) }),
  ...car('L5', { offset: 14, laps: 12, durations: from5(89.95) }),
  ...car('L6', { offset: 20, laps: 12, ...stop(6) }),
  ...car('L7', {
    offset: 27, laps: 11, durations: Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((k) => [k, 100])),
  }),
]);
const state = (now, lapTimes = RACE) => circleState(lapTimes, { sessionNow: now });
const rowsAt = (now, opts, lapTimes = RACE) => gapRows(state(now, lapTimes), lapTimes, now, opts);
const crossing = (d, n) => RACE.find((r) => r.Driver === d && r.LapNumber === n).Time;
const gapOn = (a, b, n) => crossing(b, n) - crossing(a, n);
const LATE = T0 + 950; // every car has completed lap 10, L7 lap 9

describe('gapReference', () => {
  const st = state(LATE);

  it('the focus on the circle, else the first selected car in race order, else none', () => {
    expect(st.cars.map((c) => c.driver)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
    expect(gapReference(st, 'L4', ['L2'])).toBe('L4');
    expect(gapReference(st, null, ['L5', 'L3'])).toBe('L3');
    expect(gapReference(st, null, new Set(['L6', 'L2']))).toBe('L2');
    expect(gapReference(st, 'XXX', ['L5'])).toBe('L5'); // a focus not on the circle
    expect(gapReference(st, null, [])).toBeNull();
    expect(gapReference(st, undefined, undefined)).toBeNull();
  });
});

describe('gapRows: which cars', () => {
  it('a selection: the focus plus the selected cars, in race order', () => {
    const r = rowsAt(LATE, { focus: 'L4', selected: ['L5', 'L2'] });
    expect(r.reference).toBe('L4');
    expect(r.rows.map((x) => x.driver)).toEqual(['L2', 'L4', 'L5']);
    expect(r.overflow).toEqual([]);
    const only = rowsAt(LATE, { selected: ['L5', 'L3'] });
    expect(only.reference).toBe('L3');
    expect(only.rows.map((x) => x.driver)).toEqual(['L3', 'L5']);
  });

  it('a focus only: one car on each side, two from a capacity of 5', () => {
    expect(WIDE_NEIGHBOUR_CAPACITY).toBe(5);
    expect(rowsAt(LATE, { focus: 'L4', capacity: 3 }).rows.map((x) => x.driver)).toEqual(['L3', 'L4', 'L5']);
    expect(rowsAt(LATE, { focus: 'L4', capacity: 4 }).rows.map((x) => x.driver)).toEqual(['L3', 'L4', 'L5']);
    expect(rowsAt(LATE, { focus: 'L4', capacity: 5 }).rows.map((x) => x.driver)).toEqual(['L2', 'L3', 'L4', 'L5', 'L6']);
    expect(rowsAt(LATE, { focus: 'L4' }).rows).toHaveLength(5); // no capacity: the wide list
    expect(rowsAt(LATE, { focus: 'L1', capacity: 5 }).rows.map((x) => x.driver)).toEqual(['L1', 'L2', 'L3']);
    expect(rowsAt(LATE, { focus: 'L7', capacity: 3 }).rows.map((x) => x.driver)).toEqual(['L6', 'L7']);
  });

  it('neither: no rows', () => {
    expect(rowsAt(LATE, {})).toEqual({ reference: null, rows: [], overflow: [] });
    expect(rowsAt(LATE, { focus: 'XXX' })).toEqual({ reference: null, rows: [], overflow: [] });
  });

  it('beyond the capacity: overflow, in race order; the reference row always listed', () => {
    const all = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];
    const r = rowsAt(LATE, { focus: 'L6', selected: all, capacity: 3 });
    expect(r.rows.map((x) => x.driver)).toEqual(['L1', 'L2', 'L6']);
    expect(r.overflow).toEqual([3, 4, 5, 7].map((p) => ({ driver: `L${p}`, position: p })));
    // toPrev is to the previous row shown
    expect(r.rows[2].toPrev).toBeCloseTo(gapOn('L2', 'L6', 10), 9);
    expect(rowsAt(LATE, { selected: all, capacity: 0 }).rows).toEqual([]);
    expect(rowsAt(LATE, { selected: all, capacity: 0 }).overflow).toHaveLength(7);
  });
});

describe('gapRows: gaps and trend', () => {
  it('toRef / toPrev from the latest lap both cars completed; a lapped car holds its lap', () => {
    const r = rowsAt(LATE, { focus: 'L2', selected: ['L3', 'L5', 'L7'] });
    const by = Object.fromEntries(r.rows.map((x) => [x.driver, x]));
    expect(by.L2).toMatchObject({
      position: 2, toRef: 0, toRefLaps: 0, toPrev: null, toPrevLaps: null, status: null, trend: null, trendDelta: null,
    });
    expect(by.L3.toRef).toBeCloseTo(3 - 0.2 * 6, 9); // lap 10
    expect(by.L3).toMatchObject({ toRefLaps: 0, position: 3 });
    expect(by.L3.toPrev).toBeCloseTo(by.L3.toRef, 9);
    expect(by.L5.toRef).toBeCloseTo(12 - 0.05 * 6, 9);
    expect(by.L5.toPrev).toBeCloseTo(gapOn('L3', 'L5', 10), 9);
    // L7: lap 9 is the latest it shares with L2, 105 s behind: one lap down
    expect(by.L7.toRef).toBeCloseTo(gapOn('L2', 'L7', 9), 9);
    expect(by.L7.toRef).toBeCloseTo(105, 9);
    expect(by.L7).toMatchObject({ toRefLaps: 1, toPrevLaps: 1, status: null });
    // the lap each gap was read on: the latest lap both completed
    expect(by.L2).toMatchObject({ toRefAtLap: null, toPrevAtLap: null });
    expect(by.L3).toMatchObject({ toRefAtLap: 10, toPrevAtLap: 10 });
    expect(by.L7).toMatchObject({ toRefAtLap: 9, toPrevAtLap: 9 });
  });

  it(`trend: |gap| on lap L against lap L - ${TREND_LAPS}, closing / opening at ${TREND_THRESHOLD_S} s`, () => {
    const r = rowsAt(LATE, { focus: 'L2', selected: ['L3', 'L4', 'L5', 'L6', 'L7'] });
    const by = Object.fromEntries(r.rows.map((x) => [x.driver, x]));
    expect(by.L3).toMatchObject({ trend: 'closing', trendDelta: expect.closeTo(-0.6, 9) }); // laps 7 -> 10
    expect(by.L4).toMatchObject({ trend: 'opening', trendDelta: expect.closeTo(0.75, 9) });
    expect(by.L5).toMatchObject({ trend: 'stable', trendDelta: expect.closeTo(-0.15, 9) });
    expect(by.L7).toMatchObject({ trend: 'opening', trendDelta: expect.closeTo(105 - 75, 9) }); // laps 6 -> 9
    // L6: lap 7 (its out-lap) is in laps 7-10
    expect(by.L6).toMatchObject({ status: null, trend: null, trendDelta: null });
    expect(by.L6.toRef).toBeCloseTo(40, 9);
    // after its lap 11 (T0 + 1032) the window is laps 8-11: clean, the gap constant
    const later = rowsAt(T0 + 1033, { focus: 'L2', selected: ['L6'] }).rows.find((x) => x.driver === 'L6');
    expect(later).toMatchObject({ trend: 'stable', trendDelta: expect.closeTo(0, 9) });
  });

  it('no trend with fewer than 4 laps in common, nor across a lap that is not green', () => {
    // T0 + 280: everyone but L7 has completed lap 3
    const early = rowsAt(T0 + 280, { focus: 'L2', selected: ['L3'] }).rows.find((x) => x.driver === 'L3');
    expect(early.toRef).toBeCloseTo(3, 9);
    expect(early.trend).toBeNull();
    const four = rowsAt(T0 + 370, { focus: 'L2', selected: ['L3'] }).rows.find((x) => x.driver === 'L3');
    expect(four).toMatchObject({ trend: 'stable', trendDelta: expect.closeTo(0, 9) }); // laps 1-4
    const yellow = RACE.map((r) => (r.Driver === 'L4' && r.LapNumber === 9 ? { ...r, TrackStatus: '2' } : r));
    const y = rowsAt(LATE, { focus: 'L2', selected: ['L4'] }, yellow).rows.find((x) => x.driver === 'L4');
    expect(y.trend).toBeNull();
    expect(y.toRef).toBeCloseTo(7 + 0.25 * 6, 9);
  });
});

describe('gapRows: a car in the middle of its stop has no gaps', () => {
  it('in the lane and on the out-lap: status and whole seconds since the pit entry, no gap to or from it', () => {
    const r = rowsAt(T0 + 560.7, { focus: 'L5', selected: ['L6', 'L7'] });
    expect(r.rows.map((x) => x.driver)).toEqual(['L5', 'L6', 'L7']);
    const [l5, l6, l7] = r.rows;
    expect(l6).toMatchObject({
      status: 'lane', laneSeconds: 5, pitInTime: T0 + 555, toRef: null, toRefLaps: null, toPrev: null, trend: null,
    });
    expect(l5).toMatchObject({ toRef: 0, status: null });
    expect(l7.toRef).toBeCloseTo(gapOn('L5', 'L7', 5), 9);
    expect(l7.toPrev).toBeNull(); // the previous row is L6, mid-stop
    const out = rowsAt(T0 + 580, { focus: 'L5', selected: ['L6'] }).rows[1];
    expect(out).toMatchObject({ status: 'out', laneSeconds: 25, toRef: null });
    const back = rowsAt(T0 + 673, { focus: 'L5', selected: ['L6'] }).rows[1];
    expect(back).toMatchObject({ status: null, laneSeconds: null, pitInTime: null });
    expect(back.toRef).toBeCloseTo(gapOn('L5', 'L6', 7), 9);
  });

  it('a reference in the middle of its stop: no gap to it either', () => {
    const r = rowsAt(T0 + 560.7, { focus: 'L6', selected: ['L5', 'L7'] });
    expect(r.reference).toBe('L6');
    expect(r.rows.map((x) => [x.driver, x.toRef, x.toPrev])).toEqual([['L5', null, null], ['L6', null, null], ['L7', null, null]]);
  });
});

describe('gapRows: clock', () => {
  it('within one circleStateKey only laneSeconds moves, and laneSecondsAt gives it from pitInTime', () => {
    // T0 + 565 (L6 across the line inside the lane) to T0 + 577 (its exit): no lap or pit event
    const opts = { focus: 'L5', selected: ['L6', 'L7'] };
    const memoAt = T0 + 565;
    const memo = gapRows(state(memoAt), RACE, memoAt, opts);
    for (let t = memoAt; t < T0 + 577; t += 0.4) {
      expect(circleStateKey(RACE, t)).toBe(circleStateKey(RACE, memoAt));
      const fresh = rowsAt(t, opts);
      const refreshed = memo.rows.map((x) => ({ ...x, laneSeconds: x.status ? laneSecondsAt(x.pitInTime, t) : null }));
      expect(fresh.rows).toEqual(refreshed);
    }
    expect(laneSecondsAt(T0 + 555, T0 + 560.99)).toBe(5);
    expect(laneSecondsAt(null, T0)).toBeNull();
    expect(laneSecondsAt(T0, Infinity)).toBeNull();
  });

  it('causal: every future row changed, the same rows', () => {
    const opts = { focus: 'L2', selected: ['L3', 'L4', 'L5', 'L6', 'L7'] };
    for (const now of [T0 + 280, T0 + 560.7, T0 + 570, T0 + 580, T0 + 673, LATE]) {
      const future = perturbFuture(RACE, now);
      expect(gapRows(state(now, future), future, now, opts)).toEqual(gapRows(state(now), RACE, now, opts));
      expect(gapRows(state(now, future), future, now, { focus: 'L6' })).toEqual(gapRows(state(now), RACE, now, { focus: 'L6' }));
    }
  });
});
