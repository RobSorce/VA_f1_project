import { describe, it, expect } from 'vitest';
import { extractRaceSituationFeatures } from '../raceSituationFeatures.js';
import { stintsByDriver, pitStops } from '../stints.js';
import { resolveSessionNow, completedLaps } from '../raceTime.js';
import { hasCachedSession, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';
import { perturbFuture } from './futureRows.js';

// Synthetic race on the SESSION clock: lap n of driver i starts at
// T0 + (n - 1) * 100 + i. Driver AAA stops on lap 6 and goes back out on the
// SAME compound (Stint 1 -> 2, MEDIUM -> MEDIUM), which tyre_strategy merges.
const T0 = 1000;
const DRIVERS = ['AAA', 'BBB', 'CCC', 'DDD'];

function syntheticRace({ n = 14 } = {}) {
  const rows = [];
  DRIVERS.forEach((drv, i) => {
    for (let k = 1; k <= n; k++) {
      const start = T0 + (k - 1) * 100 + i;
      const stop = drv === 'AAA';
      let t = 90 + i * 0.1 + (k % 3) * 0.1;
      const row = {
        Driver: drv, LapNumber: k, LapStartTime: start, TrackStatus: '1',
        Position: i + 1, GapToLeader: i * 1.5 + k * 0.01,
        Stint: stop && k >= 7 ? 2 : 1, Compound: 'MEDIUM', TyreLife: stop && k >= 7 ? k - 6 : k,
        PitInTimeSeconds: null, PitOutTimeSeconds: null,
      };
      if (stop && k === 6) { t += 5; row.PitInTimeSeconds = start + t - 8; }
      if (stop && k === 7) { t += 15; row.PitOutTimeSeconds = start + 22; }
      row.LapTimeSeconds = t;
      row.Time = start + t;
      rows.push(row);
    }
  });
  return rows;
}

function latestCompleted(lapTimes, driver, now) {
  const rows = completedLaps(lapTimes, now).filter((r) => r.Driver === driver);
  return rows.sort((a, b) => a.LapNumber - b.LapNumber)[rows.length - 1];
}

describe('extractRaceSituationFeatures: causal (D4)', () => {
  it('ignores everything not known at sessionNow (lap mode from currentLap)', () => {
    const rows = syntheticRace();
    for (const currentLap of [5, 7, 8, 11]) {
      const now = resolveSessionNow({ currentLap, lapTimes: rows });
      const a = extractRaceSituationFeatures({ lapTimes: rows, currentLap, dnfMap: {} });
      const b = extractRaceSituationFeatures({ lapTimes: perturbFuture(rows, now), currentLap, dnfMap: {} });
      expect(a).not.toBeNull();
      expect(b).toEqual(a);
    }
  });

  it('position, gap, tyre age and compound are those of the latest completed lap', () => {
    const rows = syntheticRace();
    const currentLap = 9;
    const now = resolveSessionNow({ currentLap, lapTimes: rows });
    const res = extractRaceSituationFeatures({ lapTimes: rows, currentLap, dnfMap: {} });
    for (const drv of res.driverAbbrs) {
      const last = latestCompleted(rows, drv, now);
      expect(last.LapNumber).toBeLessThan(currentLap); // never the unfinished current lap
      const f = res.driverFeatures[drv];
      expect(f.position).toBe(last.Position);
      expect(f.gapToLeader).toBe(last.GapToLeader);
      expect(f.tyreLife).toBe(last.TyreLife);
      expect(f.compoundName).toBe(last.Compound);
    }
  });

  it('an explicit sessionNow wins over currentLap', () => {
    const rows = syntheticRace();
    const aaa6 = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 6);
    const aaa7 = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 7);
    // In the pit lane: the in-lap is not over yet, still stint 1
    const inPits = extractRaceSituationFeatures({
      lapTimes: rows, currentLap: 12, dnfMap: {}, sessionNow: aaa6.PitInTimeSeconds + 1,
    });
    expect(inPits.driverFeatures.AAA.stintNumber).toBe(1);
    expect(inPits.driverFeatures.AAA.tyreLife).toBe(5);
    // Out-lap completed: stint 2, one stop, fresh set
    const out = extractRaceSituationFeatures({
      lapTimes: rows, currentLap: 12, dnfMap: {}, sessionNow: aaa7.Time,
    });
    expect(out.driverFeatures.AAA.stintNumber).toBe(2);
    expect(out.driverFeatures.AAA.pitStops).toBe(1);
    expect(out.driverFeatures.AAA.tyreLife).toBe(1);
  });

  it('uses the frame only to fill a tyre age / compound the lap row lacks', () => {
    const rows = syntheticRace();
    const frameDrivers = { AAA: { tyre: 3, tyre_life: 30 }, BBB: { tyre: 3, tyre_life: 30 } };
    const withRows = extractRaceSituationFeatures({ lapTimes: rows, currentLap: 9, dnfMap: {}, frameDrivers });
    expect(withRows.driverFeatures.AAA.compoundName).toBe('MEDIUM');
    expect(withRows.driverFeatures.AAA.tyreLife).not.toBe(30);

    const blank = rows.map((r) => (r.Driver === 'BBB' ? { ...r, TyreLife: null, Compound: null } : r));
    const filled = extractRaceSituationFeatures({ lapTimes: blank, currentLap: 9, dnfMap: {}, frameDrivers });
    expect(filled.driverFeatures.BBB.tyreLife).toBe(30);
    expect(filled.driverFeatures.BBB.compoundName).toBe('HARD');
  });
});

describe('extractRaceSituationFeatures: stints from lap_times (D1)', () => {
  it('counts a same-compound stop that tyre_strategy merges; strategies are ignored', () => {
    const rows = syntheticRace();
    const merged = DRIVERS.map((d) => ({ Driver: d, StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: 14, TotalLaps: 14 }));
    const res = extractRaceSituationFeatures({ lapTimes: rows, strategies: merged, currentLap: 14, dnfMap: {} });
    expect(res.driverFeatures.AAA.stintNumber).toBe(2);
    expect(res.driverFeatures.AAA.pitStops).toBe(1);
    expect(res.driverFeatures.BBB.stintNumber).toBe(1);
    expect(res.driverFeatures.BBB.pitStops).toBe(0);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16, cached)', () => {
  const s = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16) : null;
  const lapTimes = s?.lap_times || [];

  it('PIA has 3 stints / 2 stops after his lap-38 stop (tyre_strategy shows 2 stints)', () => {
    const res = extractRaceSituationFeatures({
      lapTimes, strategies: s.tyre_strategy, currentLap: 45, dnfMap: {},
    });
    const pia = res.driverFeatures.PIA;
    expect(pia.stintNumber).toBe(3);
    expect(pia.pitStops).toBe(2);
    expect(pia.compoundName).toBe('HARD');
    expect(s.tyre_strategy.filter((st) => st.Driver === 'PIA').length).toBe(2);
    const now = resolveSessionNow({ currentLap: 45, lapTimes });
    expect(pia.tyreLife).toBe(latestCompleted(lapTimes, 'PIA', now).TyreLife);
  });

  it('PIA during the lap-38 stop: stint 2 until the out-lap is over, then stint 3 on a new set', () => {
    const in38 = lapTimes.find((r) => r.Driver === 'PIA' && r.LapNumber === 38);
    const out39 = lapTimes.find((r) => r.Driver === 'PIA' && r.LapNumber === 39);
    const inPits = extractRaceSituationFeatures({
      lapTimes, currentLap: 38, dnfMap: {}, sessionNow: in38.PitInTimeSeconds + 1,
    });
    expect(inPits.driverFeatures.PIA.stintNumber).toBe(2);
    expect(inPits.driverFeatures.PIA.tyreLife).toBe(21); // lap 37, the last one completed
    const after = extractRaceSituationFeatures({
      lapTimes, currentLap: 40, dnfMap: {}, sessionNow: out39.Time,
    });
    expect(after.driverFeatures.PIA.stintNumber).toBe(3);
    expect(after.driverFeatures.PIA.tyreLife).toBe(1);
  });

  it('every driver: stint count = stintsByDriver at the same clock, features from completed laps', () => {
    for (const currentLap of [10, 20, 30, 45]) {
      const now = resolveSessionNow({ currentLap, lapTimes });
      const res = extractRaceSituationFeatures({ lapTimes, currentLap, dnfMap: {} });
      const stints = stintsByDriver(lapTimes, { sessionNow: now });
      for (const drv of res.driverAbbrs) {
        const f = res.driverFeatures[drv];
        const last = latestCompleted(lapTimes, drv, now);
        expect(last.Time).toBeLessThanOrEqual(now);
        expect(f.stintNumber).toBe(stints[drv].length);
        expect(f.position).toBe(last.Position);
        expect(f.gapToLeader).toBe(last.GapToLeader || 0);
        expect(f.tyreLife).toBe(last.TyreLife);
      }
      const b = extractRaceSituationFeatures({ lapTimes: perturbFuture(lapTimes, now), currentLap, dnfMap: {} });
      expect(b).toEqual(res);
    }
  });
});

describe('extractRaceSituationFeatures: pit exit (R3) and one stop count (R2)', () => {
  // AAA's lap-6 stop fits HARD tyres (Stint 2, TyreLife restarts at 1)
  const rows = syntheticRace().map((r) => (r.Driver === 'AAA' && r.LapNumber >= 7 ? { ...r, Compound: 'HARD' } : r));
  const aaa6 = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 6);
  const aaa7 = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 7);
  const at = (sessionNow) => extractRaceSituationFeatures({ lapTimes: rows, currentLap: 12, dnfMap: {}, sessionNow });

  it('in the pit lane the old set is current; from the pit exit the new set and the stop count', () => {
    const inLane = at(aaa7.PitOutTimeSeconds - 0.001).driverFeatures.AAA;
    expect(inLane).toMatchObject({ stintNumber: 1, pitStops: 0, compoundName: 'MEDIUM', tyreLife: aaa6.TyreLife });
    const exit = at(aaa7.PitOutTimeSeconds).driverFeatures.AAA;
    // the out-lap is still running: position / gap from the in-lap, tyres from the new set
    expect(exit).toMatchObject({ stintNumber: 2, pitStops: 1, compoundName: 'HARD', tyreLife: aaa7.TyreLife });
    expect(exit.position).toBe(aaa6.Position);
    expect(exit.gapToLeader).toBe(aaa6.GapToLeader);
    expect(pitStops(rows, { sessionNow: aaa7.PitOutTimeSeconds }).length).toBe(1);
    expect(pitStops(rows, { sessionNow: aaa7.PitOutTimeSeconds - 0.001 }).length).toBe(0);
  });

  it('is causal at the pit exit: future rows do not change the features', () => {
    for (const now of [aaa7.PitOutTimeSeconds - 0.001, aaa7.PitOutTimeSeconds, aaa7.Time - 0.001]) {
      expect(extractRaceSituationFeatures({ lapTimes: perturbFuture(rows, now), currentLap: 12, dnfMap: {}, sessionNow: now }))
        .toEqual(at(now));
    }
  });
});

describe('extractRaceSituationFeatures: a retired driver drops out when the retirement happens (R6)', () => {
  // DDD's last row is lap 8 (did not finish); the others run 14 laps
  const rows = syntheticRace().filter((r) => !(r.Driver === 'DDD' && r.LapNumber > 8));
  const dnfMap = { DDD: { status: 'Retired', lastLap: 8 } };
  const ddd8 = rows.find((r) => r.Driver === 'DDD' && r.LapNumber === 8);

  it('kept while the final lap is running, left out once it has ended', () => {
    const running = extractRaceSituationFeatures({ lapTimes: rows, currentLap: 12, dnfMap, sessionNow: ddd8.Time - 0.001 });
    expect(running.driverAbbrs).toContain('DDD');
    const ended = extractRaceSituationFeatures({ lapTimes: rows, currentLap: 12, dnfMap, sessionNow: ddd8.Time });
    expect(ended.driverAbbrs).not.toContain('DDD');
  });

  it('lap mode: not dropped from the leader\'s lap number before the retirement (old rule lastLap < currentLap)', () => {
    // at currentLap 9 the leader starts lap 9 before DDD's lap 8 has ended
    const now = resolveSessionNow({ currentLap: 9, lapTimes: rows });
    expect(now).toBeLessThan(ddd8.Time);
    expect(extractRaceSituationFeatures({ lapTimes: rows, currentLap: 9, dnfMap }).driverAbbrs).toContain('DDD');
    expect(extractRaceSituationFeatures({ lapTimes: rows, currentLap: 10, dnfMap }).driverAbbrs).not.toContain('DDD');
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024: PIA at the lap-38 pit exit (R3, cached)', () => {
  const lapTimes = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];

  it('stint 3 on the new HARD set with the out-lap TyreLife, 2 stops = stints.pitStops, from the pit exit', () => {
    const out39 = lapTimes.find((r) => r.Driver === 'PIA' && r.LapNumber === 39);
    const exit = out39.PitOutTimeSeconds;
    const before = extractRaceSituationFeatures({ lapTimes, currentLap: 39, dnfMap: {}, sessionNow: exit - 0.001 });
    expect(before.driverFeatures.PIA).toMatchObject({ stintNumber: 2, pitStops: 1 });
    const f = extractRaceSituationFeatures({ lapTimes, currentLap: 39, dnfMap: {}, sessionNow: exit });
    expect(f.driverFeatures.PIA).toMatchObject({
      stintNumber: 3, pitStops: 2, compoundName: 'HARD', tyreLife: out39.TyreLife,
    });
    expect(pitStops(lapTimes, { sessionNow: exit }).filter((s) => s.Driver === 'PIA').length).toBe(2);
    expect(f).toEqual(extractRaceSituationFeatures({
      lapTimes: perturbFuture(lapTimes, exit), currentLap: 39, dnfMap: {}, sessionNow: exit,
    }));
  });
});
