import { describe, it, expect } from 'vitest';
import { driverStateAt } from '../driverState.js';
import { deriveStints, stintsByDriver } from '../stints.js';
import { lapStartTime } from '../raceTime.js';
import { hasCachedSession, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';

// Synthetic race on the SESSION clock (T0 = race start):
//  AAA leads, 10 laps of 90 s, stop on lap 5 (MEDIUM -> HARD);
//  BBB 9 laps of 101 s: lapped, takes the flag after AAA (not retired);
//  CCC retires in the pits on lap 4; DDD retires on track after lap 3.
// Sectors: S1 ends 30 s and S2 60 s into each lap, S3 at the lap end.
const T0 = 1000;

function buildLaps(driver, { n, dur, position, compound = 'MEDIUM', extra = () => ({}) }) {
  const rows = [];
  for (let k = 1; k <= n; k++) {
    const start = T0 + (k - 1) * dur;
    rows.push({
      Driver: driver, LapNumber: k, LapStartTime: start, Time: start + dur, LapTimeSeconds: dur,
      Sector1SessionTime: start + 30, Sector2SessionTime: start + 60, Sector3SessionTime: start + dur,
      Sector1TimeSeconds: 30, Sector2TimeSeconds: 30, Sector3TimeSeconds: dur - 60,
      Position: position, TrackStatus: '1', Stint: 1, Compound: compound, TyreLife: k,
      PitInTimeSeconds: null, PitOutTimeSeconds: null,
      ...extra(k, start),
    });
  }
  return rows;
}

const AAA = buildLaps('AAA', {
  n: 10, dur: 90, position: 1,
  extra: (k, start) => {
    if (k === 5) return { PitInTimeSeconds: start + 85 };                        // T0 + 445
    if (k >= 6) {
      return {
        Stint: 2, Compound: 'HARD', TyreLife: k - 5,
        ...(k === 6 ? { PitOutTimeSeconds: start + 20 } : {}),                 // T0 + 470
      };
    }
    return {};
  },
});
const BBB = buildLaps('BBB', { n: 9, dur: 101, position: 2, compound: 'SOFT' });
const CCC = buildLaps('CCC', {
  n: 4, dur: 92, position: 3, compound: 'HARD',
  extra: (k, start) => (k === 4 ? { PitInTimeSeconds: start + 88 } : {}),        // T0 + 364
});
const DDD = buildLaps('DDD', { n: 3, dur: 93, position: 4 });
const RACE = [...AAA, ...BBB, ...CCC, ...DDD];

const lapNo = (r) => (r ? r.LapNumber : null);

describe('driverStateAt: rows (synthetic)', () => {
  it('before the race start nothing is known', () => {
    const s = driverStateAt(RACE, 'AAA', T0 - 1);
    expect(s).toEqual({
      lastCompleted: null, inProgress: null, visibleSectors: { s1: null, s2: null, s3: null },
      stint: null, compound: null, tyreLife: null, inPitLane: false, retired: false, retiredLap: null,
      lapsCompleted: 0,
    });
  });

  it('lap 1 at the race start: lap in progress, stint 1 with 0 laps, the grid set', () => {
    const s = driverStateAt(RACE, 'AAA', T0);
    expect(s.lastCompleted).toBeNull();
    expect(lapNo(s.inProgress)).toBe(1);
    expect(s.stint).toEqual({
      Driver: 'AAA', StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: 0, TotalLaps: 0, ongoing: true,
    });
    expect([s.compound, s.tyreLife, s.lapsCompleted, s.inPitLane, s.retired]).toEqual(['MEDIUM', 1, 0, false, false]);
  });

  it('the lap in progress shows only the sectors already run, never its lap time', () => {
    expect(driverStateAt(RACE, 'AAA', T0 + 29.9).visibleSectors).toEqual({ s1: null, s2: null, s3: null });
    expect(driverStateAt(RACE, 'AAA', T0 + 30).visibleSectors).toEqual({ s1: 30, s2: null, s3: null });
    expect(driverStateAt(RACE, 'AAA', T0 + 60).visibleSectors).toEqual({ s1: 30, s2: 30, s3: null });
    const done = driverStateAt(RACE, 'AAA', T0 + 90);
    expect(lapNo(done.lastCompleted)).toBe(1);
    expect(lapNo(done.inProgress)).toBe(2);
    expect(done.visibleSectors).toEqual({ s1: null, s2: null, s3: null });
  });

  it('picks rows by the driver\'s own clock, not by the leader\'s lap (lapped car)', () => {
    const now = T0 + 450; // AAA ends lap 5; BBB ended lap 4 at T0 + 404 and is on lap 5
    expect(driverStateAt(RACE, 'AAA', now).lapsCompleted).toBe(5);
    const b = driverStateAt(RACE, 'BBB', now);
    expect([b.lapsCompleted, lapNo(b.inProgress), b.compound, b.tyreLife]).toEqual([4, 5, 'SOFT', 5]);
    expect(b.retired).toBe(false);
  });

  it('a lap row that has not started is not in progress', () => {
    const gap = RACE.map((r) => (r.Driver === 'AAA' && r.LapNumber === 2 ? { ...r, LapStartTime: T0 + 100 } : r));
    const s = driverStateAt(gap, 'AAA', T0 + 95);
    expect(lapNo(s.lastCompleted)).toBe(1);
    expect(s.inProgress).toBeNull();
  });
});

describe('driverStateAt: pit entry and exit instants (R3, synthetic)', () => {
  const at = (now) => driverStateAt(RACE, 'AAA', now);

  it('before the pit entry: on track on the old set', () => {
    const s = at(T0 + 444.9);
    expect([s.inPitLane, s.compound, s.tyreLife, lapNo(s.inProgress)]).toEqual([false, 'MEDIUM', 5, 5]);
  });

  it('pit entry: in the pit lane, the old set is still the current one', () => {
    const s = at(T0 + 445);
    expect([s.inPitLane, s.compound, s.tyreLife]).toEqual([true, 'MEDIUM', 5]);
    expect(s.stint).toMatchObject({ StintNumber: 1, StartLap: 1, EndLap: 4, ongoing: true });
  });

  it('in-lap over, still in the pit lane: the out-lap runs but its new set is not shown', () => {
    const s = at(T0 + 450);
    expect([lapNo(s.lastCompleted), lapNo(s.inProgress), s.inPitLane]).toEqual([5, 6, true]);
    expect([s.stint.StintNumber, s.stint.EndLap, s.compound, s.tyreLife]).toEqual([1, 5, 'MEDIUM', 5]);
  });

  it('pit exit: the new stint (0 laps), compound and tyre age appear together', () => {
    const s = at(T0 + 470);
    expect(s.inPitLane).toBe(false);
    expect(s.stint).toEqual({
      Driver: 'AAA', StintNumber: 2, Compound: 'HARD', StartLap: 6, EndLap: 5, TotalLaps: 0, ongoing: true,
    });
    expect([s.compound, s.tyreLife]).toEqual(['HARD', 1]);
    const next = at(T0 + 540); // out-lap over, lap 7 (TyreLife 2) in progress
    expect([lapNo(next.lastCompleted), next.tyreLife, next.stint.TotalLaps]).toEqual([6, 2, 1]);
  });

  it('at Infinity: the final lap, nothing in progress, not retired', () => {
    const s = at(Infinity);
    expect([lapNo(s.lastCompleted), s.inProgress, s.tyreLife, s.retired, s.inPitLane]).toEqual([10, null, 5, false, false]);
    expect(driverStateAt(RACE, 'AAA', undefined)).toEqual(s);
  });
});

describe('driverStateAt: retirement (synthetic)', () => {
  it('a retirement in the pits counts from its pit entry, not before', () => {
    const pitIn = CCC[3].PitInTimeSeconds;
    expect(driverStateAt(RACE, 'CCC', pitIn - 0.001)).toMatchObject({ retired: false, inPitLane: false, retiredLap: null });
    // the lap of the retirement is known at the pit entry (the in-lap has begun)
    expect(driverStateAt(RACE, 'CCC', pitIn)).toMatchObject({ retired: true, inPitLane: true, retiredLap: CCC[3].LapNumber });
    expect(driverStateAt(RACE, 'CCC', Infinity).retired).toBe(true);
  });

  it('a retirement on track counts once the final row has ended', () => {
    const end = DDD[2].Time;
    expect(driverStateAt(RACE, 'DDD', end - 0.001).retired).toBe(false);
    expect(driverStateAt(RACE, 'DDD', end - 0.001).retiredLap).toBeNull();
    expect(driverStateAt(RACE, 'DDD', end)).toMatchObject({ retired: true, retiredLap: DDD[2].LapNumber });
  });

  it('a lapped finisher is never retired; opts.dnf overrides the inference', () => {
    expect(driverStateAt(RACE, 'BBB', Infinity).retired).toBe(false);
    expect(driverStateAt(RACE, 'DDD', Infinity, { dnf: false }).retired).toBe(false);
    expect(driverStateAt(RACE, 'AAA', AAA[9].Time - 1, { dnf: { status: 'Retired' } }).retired).toBe(false);
    expect(driverStateAt(RACE, 'AAA', AAA[9].Time, { dnf: { status: 'Retired' } }).retired).toBe(true);
  });
});

describe('driverStateAt: options and live mode', () => {
  it('opts.stints (array or map at the same now) gives the same state', () => {
    for (const now of [T0, T0 + 445, T0 + 450, T0 + 470, T0 + 700, Infinity]) {
      const plain = driverStateAt(RACE, 'AAA', now);
      expect(driverStateAt(RACE, 'AAA', now, { stints: deriveStints(RACE, { sessionNow: now }) })).toEqual(plain);
      expect(driverStateAt(RACE, 'AAA', now, { stints: stintsByDriver(RACE, { sessionNow: now }) })).toEqual(plain);
    }
  });

  it('live mode (Infinity, rows without clock or pit times): last row, no lap in progress', () => {
    const live = AAA.map(({ Time, LapStartTime, PitInTimeSeconds, PitOutTimeSeconds, ...r }) => r);
    const s = driverStateAt(live, 'AAA', Infinity);
    expect([lapNo(s.lastCompleted), s.inProgress, s.compound, s.tyreLife]).toEqual([10, null, 'HARD', 5]);
    expect([s.inPitLane, s.retired, s.lapsCompleted]).toEqual([false, false, 10]);
    expect(s.stint).toMatchObject({ StintNumber: 2, StartLap: 6, EndLap: 10 });
    expect(driverStateAt(live, 'AAA', Infinity, { dnf: true }).retired).toBe(true);
  });

  it('an unknown driver or no rows gives the empty state', () => {
    const empty = driverStateAt([], 'AAA', T0);
    expect(empty).toMatchObject({ lastCompleted: null, stint: null, lapsCompleted: 0, retired: false });
    expect(driverStateAt(RACE, 'ZZZ', T0 + 100)).toEqual(empty);
    expect(driverStateAt(null, 'AAA', T0)).toEqual(empty);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('driverStateAt on cached Monza 2024 (R16)', () => {
  const rows = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];

  it('TSU (retired in the pits on lap 7) is not retired before its pit entry (3983.674 s)', () => {
    expect(driverStateAt(rows, 'TSU', 3470.494).retired).toBe(false);
    expect(driverStateAt(rows, 'TSU', 3983.674 - 0.1).retired).toBe(false);
    expect(driverStateAt(rows, 'TSU', 3983.674)).toMatchObject({ retired: true, inPitLane: true });
  });

  it('LEC before his pit entry (4628.772 s) is on the MEDIUM in-lap; the HARD shows at the pit exit', () => {
    const before = driverStateAt(rows, 'LEC', 4628.094);
    expect([before.compound, before.tyreLife, before.inPitLane]).toEqual(['MEDIUM', 15, false]);
    expect([lapNo(before.lastCompleted), lapNo(before.inProgress)]).toEqual([14, 15]);
    expect(driverStateAt(rows, 'LEC', 4628.772)).toMatchObject({ inPitLane: true, compound: 'MEDIUM' });
    expect(driverStateAt(rows, 'LEC', 4653.191 - 0.001)).toMatchObject({ inPitLane: true, compound: 'MEDIUM', tyreLife: 15 });
    expect(driverStateAt(rows, 'LEC', 4653.191)).toMatchObject({ inPitLane: false, compound: 'HARD', tyreLife: 1 });
  });

  it('PIA just before his pit entry: in-lap 16 in progress, its S3 (ends 4714.0 s) not shown', () => {
    const s = driverStateAt(rows, 'PIA', 4709.694);
    expect([lapNo(s.lastCompleted), lapNo(s.inProgress), s.inPitLane]).toEqual([15, 16, false]);
    expect(s.visibleSectors.s3).toBeNull();
    expect(s.visibleSectors.s1).toBeCloseTo(27.891, 6);
  });

  it('at every instant: stint = deriveStints, rows causal, pit lane only after an entry', () => {
    const drivers = [...new Set(rows.map((r) => r.Driver))];
    const start = Math.min(...rows.map((r) => r.LapStartTime));
    const end = Math.max(...rows.map((r) => r.Time));
    for (let k = 0; k <= 60; k++) {
      const now = start + ((end - start) * k) / 60;
      const by = stintsByDriver(rows, { sessionNow: now });
      for (const drv of drivers) {
        const s = driverStateAt(rows, drv, now, { stints: by });
        const list = by[drv] || [];
        expect(s.stint).toEqual(list.length ? list[list.length - 1] : null);
        expect(s.compound).toBe(s.stint ? s.stint.Compound : null);
        if (s.lastCompleted) expect(s.lastCompleted.Time).toBeLessThanOrEqual(now);
        if (s.inProgress) {
          expect(lapStartTime(s.inProgress)).toBeLessThanOrEqual(now);
          expect(s.inProgress.Time).toBeGreaterThan(now);
        }
        if (s.inPitLane) {
          expect(rows.some((r) => r.Driver === drv && r.PitInTimeSeconds != null && r.PitInTimeSeconds <= now)).toBe(true);
        }
        expect(s.retired).toBe(drv === 'TSU' && now >= 3983.674);
      }
    }
  });
});
