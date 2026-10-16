import { describe, it, expect } from 'vitest';
import {
  deriveStints, stintsByDriver, pitStops, pitLaneVisits, isTyreChange, stintsRunning,
} from '../stints.js';
import {
  simulatorStints, completedStints, tyreStintStatus,
} from '../strategyViews.js';
import {
  completedLaps, computeSessionTimeOffset, resolveSessionNow, isLapCompleted,
} from '../raceTime.js';
import {
  hasCachedSession, loadCachedSession, listCachedRaces,
} from '../../__tests__/helpers/cachedSession.js';

// Synthetic laps on the SESSION clock: lap n of every driver runs from
// T0 + (n - 1) * 90 to T0 + n * 90, driver index i adds i seconds.
const T0 = 1000;
const DUR = 90;
const DRIVERS = ['AAA', 'BBB', 'CCC'];

function lap(driver, n, extra = {}) {
  const i = DRIVERS.indexOf(driver);
  const start = T0 + (n - 1) * DUR + i;
  return {
    Driver: driver, LapNumber: n, LapStartTime: start, Time: start + DUR, LapTimeSeconds: DUR,
    TrackStatus: '1', Stint: 1, Compound: 'MEDIUM', PitInTimeSeconds: null, PitOutTimeSeconds: null,
    ...extra,
  };
}

/** Laps from..to with a given Stint / Compound. */
function laps(driver, from, to, extra = {}) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(lap(driver, n, extra));
  return out;
}

/** Mark lap n as in-lap and n + 1 as out-lap in a row list (session times inside the laps). */
function withStop(rows, driver, inLap) {
  return rows.map((r) => {
    if (r.Driver !== driver) return r;
    if (r.LapNumber === inLap) return { ...r, PitInTimeSeconds: r.Time - 5, PitInTime: r.Time - 5 };
    if (r.LapNumber === inLap + 1) return { ...r, PitOutTimeSeconds: r.LapStartTime + 20, PitOutTime: r.LapStartTime + 20 };
    return r;
  });
}

/** TyreLife counting from `first` on laps from..to. */
function aged(rows, from, first = 1) {
  return rows.map((r) => ({ ...r, TyreLife: first + (r.LapNumber - from) }));
}

const row = (rows, driver, n) => rows.find((r) => r.Driver === driver && r.LapNumber === n);
const summary = (stints) => stints.map((s) => `${s.Driver} ${s.StintNumber} ${s.Compound} ${s.StartLap}-${s.EndLap}`);

describe('isTyreChange (R1)', () => {
  const at = (c, t) => ({ Compound: c, TyreLife: t });
  it('same compound and TyreLife + 1 or + 2: the same set', () => {
    expect(isTyreChange(at('SOFT', 4), at('SOFT', 5))).toBe(false);
    expect(isTyreChange(at('SOFT', 4), at('SOFT', 6))).toBe(false);
    expect(isTyreChange(at('soft', '4'), at('SOFT', 5))).toBe(false);
    expect(isTyreChange(at('nan', 4), at('UNKNOWN', 5))).toBe(false);
  });
  it('compound change, TyreLife not continuing or missing: a tyre change', () => {
    expect(isTyreChange(at('SOFT', 4), at('MEDIUM', 5))).toBe(true);
    expect(isTyreChange(at('SOFT', 4), at('SOFT', 7))).toBe(true);
    expect(isTyreChange(at('SOFT', 4), at('SOFT', 4))).toBe(true);
    expect(isTyreChange(at('SOFT', 4), at('SOFT', 1))).toBe(true);
    expect(isTyreChange(at('SOFT', null), at('SOFT', 5))).toBe(true);
    expect(isTyreChange(at('SOFT', 4), at('SOFT', NaN))).toBe(true);
    expect(isTyreChange(at('nan', 4), at('SOFT', 5))).toBe(true);
  });
});

describe('deriveStints (synthetic)', () => {
  it('splits back-to-back stints on the same compound using the Stint column', () => {
    const rows = withStop(withStop([
      ...laps('AAA', 1, 4, { Stint: 1, Compound: 'MEDIUM' }),
      ...laps('AAA', 5, 8, { Stint: 2, Compound: 'HARD' }),
      ...laps('AAA', 9, 12, { Stint: 3, Compound: 'HARD' }),
    ], 'AAA', 4), 'AAA', 8);
    expect(summary(deriveStints(rows))).toEqual([
      'AAA 1 MEDIUM 1-4', 'AAA 2 HARD 5-8', 'AAA 3 HARD 9-12',
    ]);
  });

  it('a Stint change that keeps the set (SC pit-lane pass, TyreLife continues) does not split', () => {
    // As NOR in 2025 R1: laps 2-4 through the pit lane under SC, Stint 1 -> 4, same set
    let rows = aged([
      ...laps('AAA', 1, 2, { Stint: 1, Compound: 'INTERMEDIATE' }),
      lap('AAA', 3, { Stint: 2, Compound: 'INTERMEDIATE' }),
      lap('AAA', 4, { Stint: 3, Compound: 'INTERMEDIATE' }),
      ...laps('AAA', 5, 8, { Stint: 4, Compound: 'INTERMEDIATE' }),
    ], 1);
    rows = withStop(withStop(withStop(rows, 'AAA', 2), 'AAA', 3), 'AAA', 4);
    rows = [...rows, ...laps('AAA', 9, 10, { Stint: 5, Compound: 'HARD', TyreLife: 1 })];
    rows = withStop(rows, 'AAA', 8);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 INTERMEDIATE 1-8', 'AAA 2 HARD 9-10']);
    expect(pitStops(rows).map((p) => [p.inLap, p.outLap])).toEqual([[8, 9]]);
    expect(pitLaneVisits(rows).map((v) => [v.inLap, v.outLap])).toEqual([[2, 3], [3, 4], [4, 5]]);
  });

  it('a Stint change on the same compound with a TyreLife reset opens a stint', () => {
    const rows = withStop([
      ...aged(laps('AAA', 1, 4, { Stint: 1, Compound: 'HARD' }), 1, 10),
      ...aged(laps('AAA', 5, 6, { Stint: 2, Compound: 'HARD' }), 5, 1),
    ], 'AAA', 4);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 HARD 1-4', 'AAA 2 HARD 5-6']);
  });

  it('keeps the tyre_strategy shape plus ongoing, TotalLaps = EndLap - StartLap + 1', () => {
    const [s] = deriveStints(laps('AAA', 3, 7));
    expect(s).toEqual({
      Driver: 'AAA', StintNumber: 1, Compound: 'MEDIUM', StartLap: 3, EndLap: 7, TotalLaps: 5, ongoing: false,
    });
  });

  it('Compound is the most common known compound; UNKNOWN / nan / null are ignored', () => {
    const rows = [
      lap('AAA', 1, { Compound: null }),
      lap('AAA', 2, { Compound: 'nan' }),
      lap('AAA', 3, { Compound: 'SOFT' }),
      lap('AAA', 4, { Compound: 'HARD' }),
      lap('AAA', 5, { Compound: 'HARD' }),
      lap('BBB', 1, { Compound: 'UNKNOWN' }),
      lap('BBB', 2, { Compound: null }),
    ];
    const by = stintsByDriver(rows);
    expect(by.AAA.map((s) => s.Compound)).toEqual(['HARD']);
    expect(by.BBB.map((s) => s.Compound)).toEqual(['UNKNOWN']);
  });

  it('Stint null: a pit-out with a tyre change (no TyreLife = a change) opens a new stint', () => {
    const rows = withStop(laps('AAA', 1, 10, { Stint: null, Compound: 'HARD' }), 'AAA', 5);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 HARD 1-5', 'AAA 2 HARD 6-10']);
  });

  it('Stint null: a pit-out keeping the set (TyreLife continues) does not split', () => {
    const rows = withStop(aged(laps('AAA', 1, 10, { Stint: null, Compound: 'HARD' }), 1), 'AAA', 5);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 HARD 1-10']);
  });

  it('Stint null: a compound change opens a new stint, unknown compounds do not', () => {
    const rows = [
      ...laps('AAA', 1, 3, { Stint: null, Compound: 'SOFT' }),
      lap('AAA', 4, { Stint: null, Compound: null }),
      ...laps('AAA', 5, 6, { Stint: null, Compound: 'MEDIUM' }),
    ];
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 SOFT 1-4', 'AAA 2 MEDIUM 5-6']);
  });

  it('a stint opened by Stint-null rows adopts the following Stint value (missing early columns)', () => {
    // As in the cached 2025 R6: no Stint/Compound for the first laps, pit-out on
    // lap 4 with Stint still null, the column starts at lap 6 with value 1.
    const rows = withStop([
      ...laps('AAA', 1, 5, { Stint: null, Compound: null }),
      ...laps('AAA', 6, 10, { Stint: 1, Compound: 'HARD' }),
    ], 'AAA', 3);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 UNKNOWN 1-3', 'AAA 2 HARD 4-10']);
  });

  it('a Stint value after null rows opens a new stint when that row is an out-lap', () => {
    const rows = withStop([
      ...laps('AAA', 1, 3, { Stint: null, Compound: 'SOFT' }),
      ...laps('AAA', 4, 6, { Stint: 2, Compound: 'SOFT' }),
    ], 'AAA', 3);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 SOFT 1-3', 'AAA 2 SOFT 4-6']);
  });

  it('Stint null rows after a numbered stint extend it', () => {
    const rows = [...laps('AAA', 1, 3, { Stint: 1 }), ...laps('AAA', 4, 5, { Stint: null, Compound: null })];
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 MEDIUM 1-5']);
  });

  it('StintNumber is the index per driver even when FastF1 numbering restarts', () => {
    const rows = [...laps('AAA', 1, 3, { Stint: 2 }), ...laps('AAA', 4, 6, { Stint: 1, Compound: 'HARD' })];
    expect(deriveStints(rows).map((s) => s.StintNumber)).toEqual([1, 2]);
  });

  it('the FastF1 Stint is authoritative: a pit-out with an unchanged Stint (drive-through) does not split', () => {
    const rows = withStop(laps('AAA', 1, 8, { Stint: 2 }), 'AAA', 4);
    expect(summary(deriveStints(rows))).toEqual(['AAA 1 MEDIUM 1-8']);
    expect(pitStops(rows)).toEqual([]);
    expect(pitLaneVisits(rows)).toHaveLength(1);
  });

  it('sorts by Driver then StintNumber, one row per (driver, lap): the last one wins', () => {
    const rows = [
      ...laps('CCC', 1, 2), ...laps('AAA', 3, 4, { Stint: 2, Compound: 'HARD' }), ...laps('AAA', 1, 2),
      lap('BBB', 1), lap('BBB', 1, { Compound: 'SOFT' }),
    ];
    expect(summary(deriveStints(rows))).toEqual([
      'AAA 1 MEDIUM 1-2', 'AAA 2 HARD 3-4', 'BBB 1 SOFT 1-1', 'CCC 1 MEDIUM 1-2',
    ]);
  });

  it('empty or invalid input gives no stints', () => {
    expect(deriveStints([])).toEqual([]);
    expect(deriveStints(null)).toEqual([]);
    expect(deriveStints(undefined, { sessionNow: 5 })).toEqual([]);
    expect(stintsByDriver([])).toEqual({});
  });
});

describe('deriveStints visibility (R3, synthetic)', () => {
  const rows = withStop([
    ...laps('AAA', 1, 5, { Stint: 1, Compound: 'MEDIUM' }),
    ...laps('AAA', 6, 10, { Stint: 2, Compound: 'HARD' }),
    ...laps('BBB', 1, 3, { Stint: 1, Compound: 'SOFT' }), // retires after lap 3
  ], 'AAA', 5);
  const aIn = row(rows, 'AAA', 5);
  const aOut = row(rows, 'AAA', 6);

  it('at Infinity nothing is ongoing', () => {
    expect(deriveStints(rows).every((s) => !s.ongoing)).toBe(true);
  });

  it('mid race: completed laps only, the running driver\'s last stint is ongoing', () => {
    const now = T0 + 7 * DUR; // AAA has finished lap 7, BBB retired after lap 3
    const by = stintsByDriver(rows, { sessionNow: now });
    expect(summary(by.AAA)).toEqual(['AAA 1 MEDIUM 1-5', 'AAA 2 HARD 6-7']);
    expect(by.AAA.map((s) => s.ongoing)).toEqual([false, true]);
    expect(by.BBB.map((s) => s.ongoing)).toEqual([false]);
  });

  it('stint 1 of every driver exists from the race start, with 0 completed laps', () => {
    expect(deriveStints(rows, { sessionNow: T0 - 1 })).toEqual([]);
    // BBB's first lap starts 1 s after AAA's (synthetic offset): each appears at its own start
    expect(deriveStints(rows, { sessionNow: T0 })).toEqual([
      { Driver: 'AAA', StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: 0, TotalLaps: 0, ongoing: true },
    ]);
    expect(deriveStints(rows, { sessionNow: T0 + 1 })).toEqual([
      { Driver: 'AAA', StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: 0, TotalLaps: 0, ongoing: true },
      { Driver: 'BBB', StintNumber: 1, Compound: 'SOFT', StartLap: 1, EndLap: 0, TotalLaps: 0, ongoing: true },
    ]);
  });

  it('in the pit lane the old stint is current; the new stint appears at the pit exit with 0 laps', () => {
    const at = (now) => stintsByDriver(rows, { sessionNow: now }).AAA;
    expect(summary(at(aIn.PitInTimeSeconds))).toEqual(['AAA 1 MEDIUM 1-4']);   // in-lap still running
    expect(at(aIn.PitInTimeSeconds)[0].ongoing).toBe(true);
    expect(summary(at(aOut.PitOutTimeSeconds - 0.001))).toEqual(['AAA 1 MEDIUM 1-5']); // in-lap over, still in the pits
    const out = at(aOut.PitOutTimeSeconds);
    expect(out).toEqual([
      { Driver: 'AAA', StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: 5, TotalLaps: 5, ongoing: false },
      { Driver: 'AAA', StintNumber: 2, Compound: 'HARD', StartLap: 6, EndLap: 5, TotalLaps: 0, ongoing: true },
    ]);
    expect(summary(at(aOut.Time))).toEqual(['AAA 1 MEDIUM 1-5', 'AAA 2 HARD 6-6']);
  });

  it('without a PitOutTime (live rows) the new stint appears when its first lap is completed', () => {
    const noExit = rows.map((r) => (r === aOut ? { ...r, PitOutTimeSeconds: null, PitOutTime: null } : r));
    const at = (now) => summary(stintsByDriver(noExit, { sessionNow: now }).AAA);
    expect(at(aOut.Time - 0.001)).toEqual(['AAA 1 MEDIUM 1-5']);
    expect(at(aOut.Time)).toEqual(['AAA 1 MEDIUM 1-5', 'AAA 2 HARD 6-6']);
  });

  it('every completed lap is in exactly one stint and no stint holds a lap ending after now', () => {
    for (let now = T0 - 50; now <= T0 + 11 * DUR; now += 7) {
      const stints = deriveStints(rows, { sessionNow: now });
      const covered = stints.reduce((n, s) => n + s.TotalLaps, 0);
      expect(covered).toBe(completedLaps(rows, now).length);
      for (const s of stints) {
        expect(s.TotalLaps).toBeGreaterThanOrEqual(0);
        if (s.TotalLaps > 0) expect(row(rows, s.Driver, s.EndLap).Time).toBeLessThanOrEqual(now);
      }
    }
  });

  it('per driver, pit stops = visible stints - 1 at every instant (badge and bars together)', () => {
    for (let now = T0 - 50; now <= T0 + 11 * DUR; now += 3) {
      const by = stintsByDriver(rows, { sessionNow: now });
      const stops = pitStops(rows, { sessionNow: now });
      for (const [drv, list] of Object.entries(by)) {
        expect(stops.filter((p) => p.Driver === drv).length).toBe(list.length - 1);
      }
    }
  });
});

// Live mode: the rows are the laps received so far and sessionNow is Infinity
// (resolveSessionNow), yet the race goes on after them (R3).
describe('live mode: the stint a driver is racing on stays ongoing until the flag (R3)', () => {
  /** Live-style rows (no session clock, no pit times) of laps 1..upTo. */
  const live = (rows, upTo) => rows
    .filter((r) => r.LapNumber <= upTo)
    .map((r) => ({
      ...r, Time: null, LapStartTime: null,
      PitInTime: null, PitInTimeSeconds: null, PitOutTime: null, PitOutTimeSeconds: null,
    }));
  const rows = withStop([
    ...laps('AAA', 1, 5, { Stint: 1, Compound: 'MEDIUM' }),
    ...laps('AAA', 6, 10, { Stint: 2, Compound: 'HARD' }),
    ...laps('BBB', 1, 10, { Stint: 1, Compound: 'SOFT' }),
    ...laps('CCC', 1, 3, { Stint: 1, Compound: 'SOFT' }), // out after lap 3
  ], 'AAA', 5);

  it('stintsRunning: false outside live mode and after the chequered flag, else a per-driver test', () => {
    const lap7 = live(rows, 7);
    expect(stintsRunning({ isLiveMode: false, totalRaceLaps: 10, lapTimes: lap7 })).toBe(false);
    const running = stintsRunning({ isLiveMode: true, totalRaceLaps: 10, lapTimes: lap7, dnfMap: { CCC: {} } });
    expect(typeof running).toBe('function');
    expect([running('AAA'), running('BBB'), running('CCC')]).toEqual([true, true, false]);
    // total laps not known yet: still running
    expect(typeof stintsRunning({ isLiveMode: true, lapTimes: lap7 })).toBe('function');
    // the leader has completed the distance: the rows are the whole race
    expect(stintsRunning({ isLiveMode: true, totalRaceLaps: 10, lapTimes: live(rows, 10) })).toBe(false);
  });

  it('lap 7 of 10: the current stints are ongoing, the finished ones and the retired driver\'s are not', () => {
    const lap7 = live(rows, 7);
    const running = stintsRunning({ isLiveMode: true, totalRaceLaps: 10, lapTimes: lap7, dnfMap: { CCC: {} } });
    // without the option every live stint reads as completed (the round-1 defect)
    expect(deriveStints(lap7, { sessionNow: Infinity }).some((st) => st.ongoing)).toBe(false);
    const by = stintsByDriver(lap7, { sessionNow: Infinity, running });
    expect(summary(by.AAA)).toEqual(['AAA 1 MEDIUM 1-5', 'AAA 2 HARD 6-7']);
    expect(by.AAA.map((st) => st.ongoing)).toEqual([false, true]);
    expect(by.BBB.map((st) => st.ongoing)).toEqual([true]);
    expect(by.CCC.map((st) => st.ongoing)).toEqual([false]);
    // the views: the simulator plan reaches the flag, the stint lengths and
    // the tyre silhouette do not treat the running sets as completed
    expect(simulatorStints(by.AAA, 10)).toEqual([
      { compound: 'MEDIUM', lapStart: 1, length: 5 }, { compound: 'HARD', lapStart: 6, length: 5 },
    ]);
    expect(completedStints(lap7, Infinity, { running }).map((st) => `${st.Driver} ${st.StintNumber}`))
      .toEqual(['AAA 1', 'CCC 1']);
    const all = deriveStints(lap7, { sessionNow: Infinity, running });
    expect(tyreStintStatus(by.AAA[1], { allStints: all })).toMatchObject({ lapsOnTyre: 3, lengthSource: null });
    // pit stops do not depend on the option
    expect(pitStops(lap7).map((p) => `${p.Driver} ${p.inLap}`)).toEqual(['AAA 5']);
  });

  it('after the chequered flag nothing is ongoing, as in a replay at its end', () => {
    const all = live(rows, 10);
    const running = stintsRunning({ isLiveMode: true, totalRaceLaps: 10, lapTimes: all });
    expect(deriveStints(all, { sessionNow: Infinity, running }).some((st) => st.ongoing)).toBe(false);
  });
});

describe('pitStops: tyre changes only (R2, synthetic)', () => {
  const rows = withStop(withStop(withStop([
    ...laps('AAA', 1, 5, { Stint: 1 }), ...laps('AAA', 6, 10, { Stint: 2, Compound: 'HARD' }),
    ...laps('BBB', 1, 4, { Stint: 1 }),
    ...laps('CCC', 1, 8, { Stint: 1 }),
  ], 'AAA', 5), 'BBB', 4), 'CCC', 3); // BBB retires in the pits on lap 4; CCC: drive-through on lap 3
  const aIn = row(rows, 'AAA', 5);
  const aOut = row(rows, 'AAA', 6);

  it('lists the tyre change with its compounds; a drive-through and a retirement in the pits are not stops', () => {
    expect(pitStops(rows)).toEqual([{
      Driver: 'AAA', inLap: 5, outLap: 6, pitInTime: aIn.PitInTimeSeconds, pitOutTime: aOut.PitOutTimeSeconds,
      fromCompound: 'MEDIUM', toCompound: 'HARD',
    }]);
  });

  it('a stop counts from its pit exit, not from its pit entry', () => {
    const aaa = (now) => pitStops(rows, { sessionNow: now }).filter((p) => p.Driver === 'AAA');
    expect(aaa(aIn.PitInTimeSeconds)).toEqual([]);
    expect(aaa(aOut.PitOutTimeSeconds - 0.001)).toEqual([]);
    expect(aaa(aOut.PitOutTimeSeconds)).toHaveLength(1);
  });

  it('works on live rows (no PitInTime / PitOutTime, no clock): the stop is the stint boundary', () => {
    const live = rows.filter((r) => r.Driver === 'AAA').map(({ Time, LapStartTime, ...r }) => ({
      ...r, PitInTimeSeconds: null, PitOutTimeSeconds: null, PitInTime: null, PitOutTime: null,
    }));
    expect(pitStops(live, { sessionNow: Infinity })).toEqual([{
      Driver: 'AAA', inLap: 5, outLap: 6, pitInTime: null, pitOutTime: null,
      fromCompound: 'MEDIUM', toCompound: 'HARD',
    }]);
  });

  it('pitLaneVisits lists the visits without a tyre change, causally', () => {
    const bIn = row(rows, 'BBB', 4);
    const cIn = row(rows, 'CCC', 3);
    const cOut = row(rows, 'CCC', 4);
    expect(pitLaneVisits(rows)).toEqual([
      { Driver: 'BBB', inLap: 4, outLap: null, pitInTime: bIn.PitInTimeSeconds, pitOutTime: null, retired: true },
      { Driver: 'CCC', inLap: 3, outLap: 4, pitInTime: cIn.PitInTimeSeconds, pitOutTime: cOut.PitOutTimeSeconds, retired: false },
    ]);
    // the drive-through counts from its pit exit, the retirement from its pit entry
    const drivers = (now) => pitLaneVisits(rows, { sessionNow: now }).map((v) => v.Driver);
    expect(drivers(cOut.PitOutTimeSeconds - 0.001)).not.toContain('CCC');
    expect(drivers(cOut.PitOutTimeSeconds)).toContain('CCC');
    expect(drivers(bIn.PitInTimeSeconds - 0.001)).not.toContain('BBB');
    expect(drivers(bIn.PitInTimeSeconds)).toContain('BBB');
  });

  it('empty input gives no stops and no visits', () => {
    expect(pitStops([])).toEqual([]);
    expect(pitStops(null)).toEqual([]);
    expect(pitLaneVisits(undefined)).toEqual([]);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('stints on cached Monza 2024 (R16)', () => {
  const s = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16) : null;
  const rows = s?.lap_times || [];

  it('50 stints from the Stint column (backend tyre_strategy on disk merges same-compound stints: 40)', () => {
    expect(deriveStints(rows)).toHaveLength(50);
    expect(s.tyre_strategy).toHaveLength(40);
  });

  it('PIA = MEDIUM 1-16, HARD 17-38, HARD 39-53; NOR and HAM 3 stints each', () => {
    const by = stintsByDriver(rows);
    expect(by.PIA.map((x) => `${x.Compound} ${x.StartLap}-${x.EndLap}`))
      .toEqual(['MEDIUM 1-16', 'HARD 17-38', 'HARD 39-53']);
    expect(by.NOR).toHaveLength(3);
    expect(by.HAM).toHaveLength(3);
  });

  it('has every tyre_strategy key', () => {
    const keys = Object.keys(s.tyre_strategy[0]);
    for (const st of deriveStints(rows)) for (const k of keys) expect(st).toHaveProperty(k);
  });

  it('30 tyre changes; TSU\'s retirement in the pits is a pit-lane visit, not a stop', () => {
    const stops = pitStops(rows);
    expect(stops).toHaveLength(deriveStints(rows).length - new Set(rows.map((r) => r.Driver)).size);
    expect(stops).toHaveLength(30);
    expect(rows.filter((r) => r.PitInTimeSeconds)).toHaveLength(31);
    expect(stops.some((p) => p.Driver === 'TSU')).toBe(false);
    expect(pitLaneVisits(rows)).toEqual([expect.objectContaining({ Driver: 'TSU', inLap: 7, retired: true })]);
    for (const p of stops) {
      expect(p.outLap).toBe(p.inLap + 1);
      expect(p.pitOutTime).toBeGreaterThan(p.pitInTime);
    }
    expect(stops.filter((p) => p.Driver === 'PIA').map((p) => `${p.fromCompound}>${p.toCompound}`))
      .toEqual(['MEDIUM>HARD', 'HARD>HARD']);
  });

  it('lap mode, lap 2: every driver who started has a row (stint 1, possibly 0 laps)', () => {
    const now = resolveSessionNow({ currentLap: 2, lapTimes: rows });
    const drivers = new Set(rows.map((r) => r.Driver));
    const stints = deriveStints(rows, { sessionNow: now });
    expect(new Set(stints.map((st) => st.Driver))).toEqual(drivers);
    expect(stints.every((st) => st.StintNumber === 1 && st.ongoing)).toBe(true);
  });

  it('mid race (lap mode, lap 30): stints cover exactly the completed laps, nothing later', () => {
    const now = resolveSessionNow({ currentLap: 30, maxLap: 53, lapTimes: rows, sessionTimeOffset: computeSessionTimeOffset(rows) });
    const done = completedLaps(rows, now);
    const stints = deriveStints(rows, { sessionNow: now });
    const covered = stints.reduce((n, st) => n + st.TotalLaps, 0);
    expect(covered).toBe(done.length);
    for (const st of stints.filter((x) => x.TotalLaps > 0)) {
      const end = rows.find((r) => r.Driver === st.Driver && r.LapNumber === st.EndLap).Time;
      expect(end).toBeLessThanOrEqual(now);
    }
    const by = stintsByDriver(rows, { sessionNow: now });
    for (const list of Object.values(by)) {
      expect(list.slice(0, -1).every((st) => !st.ongoing)).toBe(true);
    }
    expect(Object.values(by).filter((list) => list[list.length - 1].ongoing).length).toBeGreaterThan(15);
    for (const p of pitStops(rows, { sessionNow: now })) expect(p.pitOutTime).toBeLessThanOrEqual(now);
  });

  it('PIA\'s first stop: stint and stop appear together at the pit exit, on the new HARD set', () => {
    const inLap = rows.find((r) => r.Driver === 'PIA' && r.LapNumber === 16);
    const outLap = rows.find((r) => r.Driver === 'PIA' && r.LapNumber === 17);
    const at = (now) => ({
      stints: stintsByDriver(rows, { sessionNow: now }).PIA,
      stops: pitStops(rows, { sessionNow: now }).filter((p) => p.Driver === 'PIA'),
    });
    const inPit = at(inLap.PitInTimeSeconds + 0.5);
    expect(inPit.stints.map((x) => x.Compound)).toEqual(['MEDIUM']);
    expect(inPit.stops).toEqual([]);
    const exit = at(outLap.PitOutTimeSeconds);
    expect(exit.stints.map((x) => `${x.Compound} ${x.StartLap}-${x.EndLap} ${x.TotalLaps}`))
      .toEqual(['MEDIUM 1-16 16', 'HARD 17-16 0']);
    expect(exit.stops).toEqual([expect.objectContaining({ inLap: 16, outLap: 17, toCompound: 'HARD' })]);
  });
});

describe.skipIf(!hasCachedSession(2025, 1))('stints on cached Australia 2025 (R1, SC pit-lane passes)', () => {
  const rows = hasCachedSession(2025, 1) ? loadCachedSession(2025, 1).lap_times : [];

  it('NOR = INTERMEDIATE 1-34, HARD 35-44, INTERMEDIATE 45-57; the SC passes are visits', () => {
    const by = stintsByDriver(rows);
    expect(by.NOR.map((x) => `${x.Compound} ${x.StartLap}-${x.EndLap}`))
      .toEqual(['INTERMEDIATE 1-34', 'HARD 35-44', 'INTERMEDIATE 45-57']);
    expect(pitStops(rows).filter((p) => p.Driver === 'NOR').map((p) => p.outLap)).toEqual([35, 45]);
    expect(pitLaneVisits(rows).filter((v) => v.Driver === 'NOR').map((v) => v.inLap).slice(0, 3))
      .toEqual([2, 3, 4]);
  });
});

describe.skipIf(!hasCachedSession(2025, 6))('stints on cached 2025 R6 (Stint column missing early)', () => {
  const rows = hasCachedSession(2025, 6) ? loadCachedSession(2025, 6).lap_times : [];

  it('a pit-out made while Stint is null opens a new stint at the out-lap', () => {
    const by = stintsByDriver(rows);
    const nullPitOuts = rows.filter((r) => r.Stint == null && r.LapNumber > 1 && r.PitOutTimeSeconds);
    expect(nullPitOuts.length).toBeGreaterThan(0);
    for (const r of nullPitOuts) {
      expect(by[r.Driver].map((st) => st.StartLap)).toContain(r.LapNumber);
    }
  });
});

// Badge and bars agree on every cached race at every instant: per driver, the
// number of stops = visible stints - 1, and every stop's new stint is visible
const RACES = listCachedRaces();

describe.skipIf(RACES.length === 0)('pit stops = stints - 1 on every cached race (R2/R3)', () => {
  it.each(RACES.map((r) => [r.year, r.round]))('%i round %i', (year, round) => {
    const rows = loadCachedSession(year, round).lap_times;
    const start = computeSessionTimeOffset(rows);
    const end = Math.max(...rows.map((r) => r.Time).filter(Number.isFinite));
    for (let k = 0; k <= 40; k++) {
      const now = start + ((end - start) * k) / 40;
      const by = stintsByDriver(rows, { sessionNow: now });
      const stops = pitStops(rows, { sessionNow: now });
      for (const [drv, list] of Object.entries(by)) {
        const mine = stops.filter((p) => p.Driver === drv);
        expect(mine.length).toBe(list.length - 1);
        mine.forEach((p, i) => {
          expect(p.outLap).toBe(list[i + 1].StartLap);
          expect(p.toCompound).toBe(list[i + 1].Compound);
          if (p.pitOutTime != null) expect(p.pitOutTime).toBeLessThanOrEqual(now);
          else expect(isLapCompleted(rows.find((r) => r.Driver === drv && r.LapNumber === p.outLap), now)).toBe(true);
        });
      }
    }
  });
});
