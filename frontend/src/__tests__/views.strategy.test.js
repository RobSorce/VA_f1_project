import { describe, it, expect } from 'vitest';
import {
  causalKey, stintBars, completedStints, groupLapsByStint, simulatorStints, formatStopLoss,
  describeStopLoss, pitStopMarkers, pitCountsByDriver, pitLossDisplay, tyreStintStatus,
  driverCompletedLaps, layoutStopLabels, pitLaneNow, patternStopCount, stintLapsText,
  viewSessionType, fittedLapRange, PIT_LOSS_LEGEND,
} from '../utils/strategyViews.js';
import { deriveStints, stintsByDriver, pitStops, pitLaneVisits } from '../utils/stints.js';
import { estimatePitLoss, driverGreenMedians, FALLBACK_PIT_LOSS } from '../utils/pitLoss.js';
import {
  computeSessionTimeOffset, resolveSessionNow, isLapCompleted, pitOutSeconds,
} from '../utils/raceTime.js';
import { extractRaceSituationFeatures } from '../utils/raceSituationFeatures.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

// Synthetic laps on the SESSION clock: lap n of every driver runs from
// T0 + (n - 1) * 90 to T0 + n * 90, driver index i adds i seconds.
const T0 = 1000;
const DUR = 90;
const DRIVERS = ['AAA', 'BBB', 'CCC'];
const FB = FALLBACK_PIT_LOSS.median;

function lap(driver, n, extra = {}) {
  const i = DRIVERS.indexOf(driver);
  const start = T0 + (n - 1) * DUR + i;
  return {
    Driver: driver, LapNumber: n, LapStartTime: start, Time: start + DUR, LapTimeSeconds: DUR,
    TrackStatus: '1', Stint: 1, Compound: 'MEDIUM', PitInTimeSeconds: null, PitOutTimeSeconds: null,
    ...extra,
  };
}

function laps(driver, from, to, extra = {}) {
  const out = [];
  for (let n = from; n <= to; n++) out.push(lap(driver, n, extra));
  return out;
}

/**
 * Pit times of a stop on lap inLap (PitInTime on the in-lap, PitOutTime on
 * the out-lap), in-lap and out-lap each `extra` seconds slower than DUR (the
 * loss is then 2 * extra). Tyre columns are left as they are.
 */
function withStop(rows, driver, inLap, extra = 12) {
  return rows.map((r) => {
    if (r.Driver !== driver) return r;
    if (r.LapNumber === inLap) {
      return { ...r, LapTimeSeconds: DUR + extra, PitInTimeSeconds: r.Time - 5, PitInTime: r.Time - 5 };
    }
    if (r.LapNumber === inLap + 1) {
      return {
        ...r, LapTimeSeconds: DUR + extra,
        PitOutTimeSeconds: r.LapStartTime + 20, PitOutTime: r.LapStartTime + 20,
      };
    }
    return r;
  });
}

/** A stop that changes tyres: withStop plus Stint + 1 and a new compound after inLap. */
function withTyreChange(rows, driver, inLap, extra = 12, toCompound = 'HARD') {
  return withStop(rows, driver, inLap, extra).map((r) => (
    r.Driver === driver && r.LapNumber > inLap
      ? { ...r, Stint: (r.Stint || 1) + 1, Compound: toCompound }
      : r
  ));
}

describe('causalKey', () => {
  const rows = withStop([
    ...laps('AAA', 1, 5, { Stint: 1 }),
    ...laps('AAA', 6, 10, { Stint: 2, Compound: 'HARD' }),
  ], 'AAA', 5);

  it('is equal between two events and changes when a lap completes', () => {
    // lap 2 ends at T0 + 180
    expect(causalKey(rows, T0 + 100)).toBe(causalKey(rows, T0 + 170));
    expect(causalKey(rows, T0 + 179)).not.toBe(causalKey(rows, T0 + 180));
  });

  it('changes when a pit entry becomes visible and when the pit exit passes', () => {
    const pitIn = T0 + 5 * DUR - 5; // in-lap 5 ends at T0 + 450
    const pitOut = T0 + 5 * DUR + 20;
    expect(causalKey(rows, pitIn - 1)).not.toBe(causalKey(rows, pitIn));
    expect(causalKey(rows, pitOut - 1)).not.toBe(causalKey(rows, pitOut));
  });

  it('counts started and ended track-status events', () => {
    const ts = [{ status: '4', start_time: T0 + 200, end_time: T0 + 300 }];
    expect(causalKey(rows, T0 + 199, ts)).not.toBe(causalKey(rows, T0 + 200, ts));
    expect(causalKey(rows, T0 + 299, ts)).not.toBe(causalKey(rows, T0 + 300, ts));
    expect(causalKey(rows, T0 + 210, ts)).toBe(causalKey(rows, T0 + 260, ts));
  });

  it('treats undefined / null / NaN now as the whole race', () => {
    expect(causalKey(rows)).toBe(causalKey(rows, Infinity));
    expect(causalKey(rows, null)).toBe(causalKey(rows, Infinity));
    expect(causalKey(rows, NaN)).toBe(causalKey(rows, Infinity));
    expect(causalKey(null, 5)).toBe(causalKey([], 5));
  });

  it('differs after a backward seek, so memos keyed on it recompute (D5 #1)', () => {
    expect(causalKey(rows, T0 + 300)).not.toBe(causalKey(rows, T0 + 800));
    expect(causalKey(rows, T0 + 800)).not.toBe(causalKey(rows, T0 + 300));
  });
});

describe('stint view helpers (synthetic)', () => {
  const rows = withStop(withStop([
    ...laps('AAA', 1, 4, { Stint: 1, Compound: 'medium' }),
    ...laps('AAA', 5, 8, { Stint: 2, Compound: 'HARD' }),
    ...laps('AAA', 9, 12, { Stint: 3, Compound: 'HARD' }),
  ], 'AAA', 4), 'AAA', 8);

  it('stintBars keeps the stint row and adds LapStart / StintLength, upper-case compound', () => {
    const bars = stintBars(deriveStints(rows));
    expect(bars.map((b) => `${b.Compound} ${b.LapStart}+${b.StintLength}`)).toEqual([
      'MEDIUM 1+4', 'HARD 5+4', 'HARD 9+4',
    ]);
    expect(bars[1]).toMatchObject({ Driver: 'AAA', StintNumber: 2, StartLap: 5, EndLap: 8, ongoing: false });
  });

  it('completedStints leaves out the ongoing stint', () => {
    const now = T0 + 10 * DUR; // laps 1..10 completed, lap 12 is the final row
    expect(deriveStints(rows, { sessionNow: now }).map((s) => s.ongoing)).toEqual([false, false, true]);
    expect(completedStints(rows, now).map((s) => s.StintNumber)).toEqual([1, 2]);
    expect(completedStints(rows).length).toBe(3);
  });

  it('groupLapsByStint assigns each lap to the stint containing it and drops empty stints', () => {
    const stints = deriveStints(rows);
    const subset = rows.filter((r) => r.LapNumber >= 6 && r.LapNumber <= 10).reverse();
    const groups = groupLapsByStint(subset, stints);
    expect(groups.map((g) => [g.stint.StintNumber, g.laps.map((l) => l.LapNumber)])).toEqual([
      [2, [6, 7, 8]], [3, [9, 10]],
    ]);
  });

  it('simulatorStints extends only an ongoing last stint to the race length', () => {
    const now = T0 + 10 * DUR;
    const live = deriveStints(rows, { sessionNow: now });
    expect(simulatorStints(live, 12)).toEqual([
      { compound: 'MEDIUM', lapStart: 1, length: 4 },
      { compound: 'HARD', lapStart: 5, length: 4 },
      { compound: 'HARD', lapStart: 9, length: 4 },
    ]);
    expect(simulatorStints(live, 20)[2]).toEqual({ compound: 'HARD', lapStart: 9, length: 12 });
    expect(simulatorStints(live)[2].length).toBe(2); // no race length: laps so far
    // a finished race: nothing is extended
    expect(simulatorStints(deriveStints(rows), 20)[2].length).toBe(4);
  });

  it('tyreStintStatus: real length when completed, race average of the compound when ongoing', () => {
    const now = T0 + 10 * DUR;
    const all = deriveStints(rows, { sessionNow: now });
    expect(tyreStintStatus(all[1], { allStints: all })).toMatchObject({
      compound: 'HARD', lapsOnTyre: 4, stintLength: 4, lengthSource: 'actual', tyreLife: 1,
    });
    // ongoing HARD stint on lap 3 of the set (laps 9, 10 completed); one HARD stint ended in a stop after 4 laps
    expect(tyreStintStatus(all[2], { allStints: all })).toMatchObject({
      compound: 'HARD', lapsOnTyre: 3, stintLength: 4, lengthSource: 'race-average',
      lengthSamples: 1, tyreLife: 0.75,
    });
    // reference = same-compound stints that ended in a pit stop after at least lapsOnTyre laps:
    // a retirement (no later stint) and a stint shorter than the current one are left out
    const ongoing = { Driver: 'AAA', StintNumber: 2, Compound: 'HARD', StartLap: 10, EndLap: 14, TotalLaps: 5, ongoing: true };
    const field = [
      ongoing,
      { Driver: 'BBB', StintNumber: 1, Compound: 'HARD', StartLap: 1, EndLap: 20, TotalLaps: 20, ongoing: false },
      { Driver: 'BBB', StintNumber: 2, Compound: 'SOFT', StartLap: 21, EndLap: 22, TotalLaps: 2, ongoing: true },
      { Driver: 'CCC', StintNumber: 1, Compound: 'HARD', StartLap: 1, EndLap: 4, TotalLaps: 4, ongoing: false },
      { Driver: 'CCC', StintNumber: 2, Compound: 'MEDIUM', StartLap: 5, EndLap: 22, TotalLaps: 18, ongoing: true },
      { Driver: 'DDD', StintNumber: 1, Compound: 'HARD', StartLap: 1, EndLap: 7, TotalLaps: 7, ongoing: false },
    ];
    expect(tyreStintStatus(ongoing, { allStints: field })).toMatchObject({
      lapsOnTyre: 6, stintLength: 20, lengthSamples: 1, tyreLife: 0.3,
    });
    // no completed stint on the compound yet: unknown, not a guess
    const early = deriveStints(rows, { sessionNow: T0 + 2 * DUR });
    expect(tyreStintStatus(early[0], { allStints: early })).toMatchObject({
      compound: 'MEDIUM', lapsOnTyre: 3, stintLength: null, lengthSource: null, tyreLife: null,
    });
  });

  it('tyreStintStatus at the pit exit: the new set, on its first lap (R3)', () => {
    const exit = rows.find((r) => r.LapNumber === 5).PitOutTimeSeconds;
    const before = deriveStints(rows, { sessionNow: exit - 0.001 });
    const after = deriveStints(rows, { sessionNow: exit });
    expect(tyreStintStatus(before[before.length - 1], { allStints: before }).compound).toBe('MEDIUM');
    expect(tyreStintStatus(after[after.length - 1], { allStints: after })).toMatchObject({
      compound: 'HARD', lapStart: 5, lapsOnTyre: 1,
    });
  });

  it('driverCompletedLaps never includes the lap in progress', () => {
    const now = T0 + 5 * DUR + 30; // lap 6 in progress
    expect(driverCompletedLaps(rows, 'AAA', now).map((l) => l.LapNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('stintLapsText: laps so far, or "no lap completed yet" for a stint just begun', () => {
    expect(stintLapsText({ StartLap: 17, EndLap: 38, TotalLaps: 22, ongoing: false })).toBe('17–38 (22 laps)');
    expect(stintLapsText({ StartLap: 39, EndLap: 39, TotalLaps: 1, ongoing: true })).toBe('39–39 (1 lap, ongoing)');
    expect(stintLapsText({ StartLap: 39, EndLap: 38, TotalLaps: 0, ongoing: true }))
      .toBe('from lap 39 (no lap completed yet)');
  });
});

describe('pit-loss labels (synthetic, decision R7)', () => {
  // Three drivers, 12 green laps each, so every driver has a green median of DUR
  const base = [
    ...laps('AAA', 1, 12), ...laps('BBB', 1, 12), ...laps('CCC', 1, 12),
  ];

  it('formatStopLoss: "26.8s" measured, "≈24.7s" estimate, "22.0s*" fallback, no number when pending or not a race', () => {
    expect(formatStopLoss({ loss: 26.84, source: 'measured', estimateSource: 'race' })).toBe('26.8s');
    expect(formatStopLoss({ loss: 24.7, source: 'estimate', estimateSource: 'race' })).toBe('≈24.7s');
    expect(formatStopLoss({ loss: FB, source: 'fallback', estimateSource: 'fallback' })).toBe(`${FB.toFixed(1)}s*`);
    expect(formatStopLoss({ loss: null, source: 'pending', estimateSource: 'race' })).toBe('');
    expect(formatStopLoss({ loss: null, source: 'not-applicable', estimateSource: 'not-applicable' })).toBe('');
    // the one-line legend under the timeline explains the two marks
    expect(PIT_LOSS_LEGEND).toContain('≈ estimate');
    expect(PIT_LOSS_LEGEND).toContain('* fallback');
    expect(PIT_LOSS_LEGEND).toMatch(/measuring/);
    expect(PIT_LOSS_LEGEND).not.toMatch(/\d/); // no invented number in the legend
  });

  it('labels a green stop with its own measured loss (in-lap + out-lap - 2 x green median)', () => {
    const rows = withTyreChange(withTyreChange(base, 'AAA', 5, 12), 'BBB', 6, 14, 'SOFT');
    const markers = pitStopMarkers(rows);
    expect(markers.map((m) => [m.Driver, m.inLap, m.outLap, m.source, m.label, m.fromCompound, m.toCompound])).toEqual([
      ['AAA', 5, 6, 'measured', '24.0s', 'MEDIUM', 'HARD'],
      ['BBB', 6, 7, 'measured', '28.0s', 'MEDIUM', 'SOFT'],
    ]);
    expect(pitCountsByDriver(markers)).toEqual({ AAA: 1, BBB: 1 });
    expect(describeStopLoss(markers[0])).toMatch(/measured/);
  });

  it('a stop that can never be measured shows the race median at now, "≈", with n in the tooltip', () => {
    let rows = withTyreChange(withTyreChange(withTyreChange(base, 'AAA', 5, 12), 'BBB', 6, 14), 'CCC', 8, 10);
    rows = rows.map((r) => (r.Driver === 'CCC' && r.LapNumber === 9 ? { ...r, TrackStatus: '4' } : r));
    const markers = pitStopMarkers(rows);
    const ccc = markers.find((m) => m.Driver === 'CCC');
    expect(ccc.source).toBe('estimate');
    expect(ccc.loss).toBeCloseTo(26, 9); // median of the two green samples, 24 and 28
    expect(ccc.label).toBe('≈26.0s');
    expect(describeStopLoss(ccc)).toMatch(/race median of 2 measured green stops/);
  });

  it('before any measured green stop a non-measurable stop shows the fallback, "*"', () => {
    let rows = withTyreChange(base, 'AAA', 5, 12);
    rows = rows.map((r) => (r.Driver === 'AAA' && r.LapNumber === 6 ? { ...r, TrackStatus: '6' } : r));
    const [m] = pitStopMarkers(rows);
    expect(m).toMatchObject({ source: 'fallback', estimateSource: 'fallback', loss: FB, n: 0 });
    expect(m.label).toBe(`${FB.toFixed(1)}s*`);
    expect(describeStopLoss(m)).toMatch(/fallback/);
  });

  it('is causal (R3): no stop in the pit lane, a marker without number from the pit exit, measured after the out-lap', () => {
    // BBB stops first (in-lap 7, 28 s); AAA stops later (in-lap 10, 24 s)
    const rows = withTyreChange(withTyreChange(base, 'AAA', 10, 12), 'BBB', 7, 14);
    const aIn = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 10);
    const aOut = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 11);
    const aaa = (now) => pitStopMarkers(rows, { sessionNow: now }).find((m) => m.Driver === 'AAA');
    const bars = (now) => stintBars(deriveStints(rows, { sessionNow: now })).filter((b) => b.Driver === 'AAA');

    // Pit lane: entry passed, exit not yet: no stop, one bar, the car shows as in the pit lane
    expect(aaa(aIn.PitInTimeSeconds - 0.001)).toBeUndefined();
    expect(aaa(aIn.PitInTimeSeconds)).toBeUndefined();
    expect(bars(aIn.PitInTimeSeconds).length).toBe(1);
    // (no pit-exit time: it is still in the future)
    expect(pitLaneNow(rows, aIn.PitInTimeSeconds)).toEqual([
      { Driver: 'AAA', inLap: 10, pitInTime: aIn.PitInTimeSeconds },
    ]);

    // Pit exit: the stop counts and the new bar exists at the same instant, no number yet
    const exit = aOut.PitOutTimeSeconds;
    expect(aaa(exit - 0.001)).toBeUndefined();
    const atExit = aaa(exit);
    expect(atExit).toMatchObject({ source: 'pending', loss: null, label: '', outLap: 11, toCompound: 'HARD' });
    expect(describeStopLoss(atExit)).toMatch(/^measuring…/);
    expect(bars(exit).map((b) => `${b.Compound} ${b.StartLap}-${b.EndLap} ${b.TotalLaps}`))
      .toEqual(['MEDIUM 1-10 10', 'HARD 11-10 0']);
    expect(pitLaneNow(rows, exit)).toEqual([]);

    // Out-lap completed: measured
    expect(aaa(aOut.Time)).toMatchObject({ source: 'measured', outLap: 11, label: '24.0s' });
  });

  it('a pit-lane pass without a tyre change is not a stop (R2): no marker, no count, one bar', () => {
    // AAA drives through the pit lane on lap 5 / 6: FastF1 Stint 1 -> 2, same set (TyreLife continues)
    const tl = base.map((r) => ({ ...r, TyreLife: r.LapNumber }));
    const rows = withStop(tl, 'AAA', 5, 10).map((r) => (
      r.Driver === 'AAA' && r.LapNumber > 5 ? { ...r, Stint: 2 } : r
    ));
    expect(pitStopMarkers(rows)).toEqual([]);
    expect(pitCountsByDriver(pitStopMarkers(rows))).toEqual({});
    expect(stintBars(deriveStints(rows)).filter((b) => b.Driver === 'AAA').length).toBe(1);
    expect(pitLaneVisits(rows).map((v) => [v.Driver, v.inLap, v.retired])).toEqual([['AAA', 5, false]]);
  });

  it('live rows without pit times (R2): the stop is the stint boundary, badge = bars - 1', () => {
    // Shape of backend/live/data_normalizer.py rows: no PitInTime / PitOutTime
    const rows = withTyreChange(base, 'AAA', 5, 12).map((r) => ({
      ...r, PitInTime: null, PitInTimeSeconds: null, PitOutTime: null, PitOutTimeSeconds: null,
    }));
    const outLap = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 6);
    // Without a pit exit time the new stint is known once its first lap is completed
    expect(pitStopMarkers(rows, { sessionNow: outLap.Time - 0.001 })).toEqual([]);
    const [m] = pitStopMarkers(rows, { sessionNow: outLap.Time });
    expect(m).toMatchObject({ Driver: 'AAA', inLap: 5, outLap: 6, pitInTime: null, pitOutTime: null });
    // No pit data at all: nothing is measurable, the labelled fallback
    expect(m).toMatchObject({ source: 'fallback', label: `${FB.toFixed(1)}s*` });
    // Live mode is sessionNow = Infinity
    const all = pitStopMarkers(rows, { sessionNow: Infinity });
    expect(pitCountsByDriver(all)).toEqual({ AAA: 1 });
    expect(stintBars(deriveStints(rows)).filter((b) => b.Driver === 'AAA').length).toBe(2);
  });

  it('qualifying / practice (R7): stops carry no pit-loss number; sprint keeps them', () => {
    const rows = withTyreChange(withTyreChange(base, 'AAA', 5, 12), 'BBB', 6, 14);
    for (const sessionType of ['Q', 'FP2', 'SQ']) {
      const markers = pitStopMarkers(rows, { sessionType });
      expect(markers.length).toBe(2); // the tyre changes are still there (runs as stints)
      for (const m of markers) {
        expect(m).toMatchObject({ source: 'not-applicable', loss: null, label: '' });
        expect(describeStopLoss(m)).toMatch(/race sessions only/);
      }
    }
    expect(pitStopMarkers(rows, { sessionType: 'S' }).map((m) => m.label)).toEqual(['24.0s', '28.0s']);
    expect(pitStopMarkers(rows, { sessionType: 'R' }).map((m) => m.label)).toEqual(['24.0s', '28.0s']);
  });
});

describe('layoutStopLabels (D6 #3: no overlapping pills)', () => {
  const x = (lap) => lap * 10; // 10 px per lap

  it('hides a label that would overlap the previous one on the same row, keeps other rows', () => {
    const markers = [
      { Driver: 'AAA', inLap: 2, label: `${FB.toFixed(1)}s*` },   // pill 36 px at x 25
      { Driver: 'AAA', inLap: 3, label: `${FB.toFixed(1)}s*` },   // x 35: overlaps
      { Driver: 'AAA', inLap: 9, label: '24.0s' },                // x 95: free
      { Driver: 'BBB', inLap: 3, label: '≈25.1s' },          // other row: drawn
      { Driver: 'BBB', inLap: 4, label: '' },                     // pending: no pill
    ];
    const out = layoutStopLabels(markers, x);
    expect(out.map((m) => m.showLabel)).toEqual([true, false, true, true, false]);
    expect(out[0]).toMatchObject({ x: 25, pillW: 36 });
    expect(out[4].pillW).toBe(0);
    // input order is kept
    expect(out.map((m) => `${m.Driver}${m.inLap}`)).toEqual(['AAA2', 'AAA3', 'AAA9', 'BBB3', 'BBB4']);
  });

  it('with the row positions, pills of adjacent rows never overlap (tight rows; round 2)', () => {
    const markers = [
      { Driver: 'AAA', inLap: 44, label: `${FB.toFixed(1)}s*` },
      { Driver: 'BBB', inLap: 44, label: `${FB.toFixed(1)}s*` },
      { Driver: 'CCC', inLap: 44, label: `${FB.toFixed(1)}s*` },
      { Driver: 'AAA', inLap: 2, label: '24.0s' },
      { Driver: 'AAA', inLap: 3, label: '24.1s' },
    ];
    const rows = (step) => (d) => ['AAA', 'BBB', 'CCC'].indexOf(d) * step + 20;
    // rows 10.97 px apart (the verifier's 2025 R1 at 261 px), pills 11 px tall
    const tight = layoutStopLabels(markers, x, { yOf: rows(10.97) });
    expect(tight.map((m) => m.showLabel)).toEqual([true, false, true, true, false]);
    // no two shown pills intersect
    const rect = (m, y) => ({ l: m.x - m.pillW / 2, r: m.x + m.pillW / 2, t: y(m.Driver) - 14, b: y(m.Driver) - 3 });
    const shown = tight.filter((m) => m.showLabel).map((m) => rect(m, rows(10.97)));
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = shown[i];
        const b = shown[j];
        expect(a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b).toBe(false);
      }
    }
    // rows far enough apart: every row keeps its label
    expect(layoutStopLabels(markers, x, { yOf: rows(15.4) }).map((m) => m.showLabel))
      .toEqual([true, true, true, true, false]);
  });
});

describe('pitLaneNow', () => {
  const rows = [
    ...withTyreChange(laps('AAA', 1, 8), 'AAA', 4),
    // BBB retires in the pits on lap 3: no later row
    ...laps('BBB', 1, 3).map((r) => (r.LapNumber === 3 ? { ...r, PitInTimeSeconds: r.Time - 5 } : r)),
  ];

  it('lists a car between its pit entry and its pit exit, never a car that stayed in the pits', () => {
    const aIn = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 4).PitInTimeSeconds;
    const aOut = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 5).PitOutTimeSeconds;
    const bIn = rows.find((r) => r.Driver === 'BBB' && r.LapNumber === 3).PitInTimeSeconds;
    expect(pitLaneNow(rows, aIn - 0.001)).toEqual([]);
    expect(pitLaneNow(rows, aIn).map((p) => p.Driver)).toEqual(['AAA']);
    expect(pitLaneNow(rows, aOut - 0.001).map((p) => p.Driver)).toEqual(['AAA']);
    expect(pitLaneNow(rows, aOut)).toEqual([]);
    expect(pitLaneNow(rows, bIn + 1)).toEqual([]);
    expect(pitLaneNow(rows, Infinity)).toEqual([]);
    expect(pitLaneNow(null, aIn)).toEqual([]);
  });
});

describe('small view helpers', () => {
  it('patternStopCount: N stints are N - 1 stops (PCAAnalysisPanel label, D1)', () => {
    expect(patternStopCount([{}, {}, {}])).toBe(2);
    expect(patternStopCount([{}])).toBe(0);
    expect(patternStopCount([])).toBe(0);
    expect(patternStopCount(undefined)).toBe(0);
  });

  it('viewSessionType: live SessionInfo type, quali replay, loaded / selected type', () => {
    expect(viewSessionType({ sessionType: 'R' })).toBe('R');
    expect(viewSessionType({ sessionType: 'Q' })).toBe('Q');
    expect(viewSessionType({ sessionType: 'R', loadedSessionType: 'FP2' })).toBe('FP2');
    expect(viewSessionType({ sessionType: 'R', isQualifyingReplay: true })).toBe('Q');
    expect(viewSessionType({ isLiveMode: true, liveSessionInfo: { session_type: 'Race', session_name: 'Race' } })).toBe('R');
    expect(viewSessionType({ isLiveMode: true, liveSessionInfo: { session_type: 'Race', session_name: 'Sprint' } })).toBe('S');
    expect(viewSessionType({ isLiveMode: true, liveSessionInfo: { session_type: 'Qualifying', session_name: 'Qualifying' } })).toBe('Q');
    expect(viewSessionType({ isLiveMode: true, liveSessionInfo: { session_type: 'Qualifying', session_name: 'Sprint Qualifying' } })).toBe('Q');
    expect(viewSessionType({ isLiveMode: true, liveSessionInfo: { session_type: 'Practice', session_name: 'Practice 2' } })).toBe('FP');
    expect(viewSessionType({ isLiveMode: true, liveSessionInfo: null })).toBe('R');
    expect(viewSessionType({})).toBe('R');
  });

  it('fittedLapRange: the laps the degradation fit used (D4 TireDegradation banner)', () => {
    expect(fittedLapRange({ lap_start: 10, lap_end: 25, lap_end_used: 17 })).toEqual({ start: 10, end: 17, partial: true });
    expect(fittedLapRange({ lap_start: 10, lap_end: 25, lap_end_used: 25 })).toEqual({ start: 10, end: 25, partial: false });
    expect(fittedLapRange({ lap_start: 10, lap_end: 25, lap_end_used: 9 })).toBeNull();
    expect(fittedLapRange({ lap_start: 10, lap_end: 25 })).toBeNull();
    expect(fittedLapRange(null)).toBeNull();
  });
});

describe('pitLossDisplay', () => {
  it('uses the estimator median, never the mean', () => {
    const est = { median: 26.8, mean: 27.6, stdDev: 4.3, p10: 23.5, p90: 34.3, n: 30, source: 'race' };
    expect(pitLossDisplay(est)).toEqual({
      value: 26.8, stdDev: 4.3, p10: 23.5, p90: 34.3, n: 30, isFallback: false, notApplicable: false,
    });
  });

  it('flags the fallback so the UI can print "fallback"', () => {
    const fb = estimatePitLoss([]);
    expect(fb.source).toBe('fallback');
    expect(pitLossDisplay(fb)).toMatchObject({ value: FB, isFallback: true, n: 0, notApplicable: false });
    expect(pitLossDisplay(undefined)).toMatchObject({ value: FB, isFallback: true });
    // an object without a median (old { mean, stdDev } shape) is not used as data
    expect(pitLossDisplay({ mean: 6.4, stdDev: 1 })).toMatchObject({ value: FB, isFallback: true });
  });

  it('has no value outside race sessions (R7)', () => {
    const q = estimatePitLoss(laps('AAA', 1, 12), { sessionType: 'Q' });
    expect(q.source).toBe('not-applicable');
    expect(pitLossDisplay(q)).toEqual({
      value: null, stdDev: null, p10: null, p90: null, n: 0, isFallback: false, notApplicable: true,
    });
  });
});

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per driver: [badge (StrategyTimeline), DriverComparePanel count, bars - 1]. */
function countsAt(lt, sessionNow) {
  const badge = pitCountsByDriver(pitStopMarkers(lt, { sessionNow }));
  const compare = pitCountsByDriver(pitStops(lt, { sessionNow }));
  const bars = {};
  for (const b of stintBars(deriveStints(lt, { sessionNow }))) bars[b.Driver] = (bars[b.Driver] || 0) + 1;
  return Object.keys(bars).map((d) => [d, badge[d] || 0, compare[d] || 0, bars[d] - 1]);
}

describe.skipIf(!hasCachedSession(2024, 16))('Strategy Timeline view model, Monza 2024 (cached)', () => {
  const session = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16) : null;
  const lt = session?.lap_times || [];
  const offset = computeSessionTimeOffset(lt);

  it('draws 50 stints (tyre_strategy merges them into 40); PIA = M 1-16, H 17-38, H 39-53', () => {
    const bars = stintBars(deriveStints(lt));
    expect(bars.length).toBe(50);
    expect(session.tyre_strategy.length).toBe(40);
    expect(bars.filter((b) => b.Driver === 'PIA').map((b) => `${b.Compound} ${b.LapStart}-${b.LapStart + b.StintLength - 1}`))
      .toEqual(['MEDIUM 1-16', 'HARD 17-38', 'HARD 39-53']);
  });

  it('per-stop labels are the race pit loss (~26.8 s), not the in-lap spike; TSU\'s retirement is no stop', () => {
    const markers = pitStopMarkers(lt);
    const est = estimatePitLoss(lt);
    expect(markers.length).toBe(30); // 50 stints - 20 drivers
    const measured = markers.filter((m) => m.source === 'measured');
    expect(measured.length).toBe(est.n); // all 30 are green-flag stops
    expect(measured.length).toBe(30);

    // Independent recomputation of each measured value from the raw rows
    const by = new Map(lt.map((r) => [`${r.Driver}|${r.LapNumber}`, r]));
    const greenMedian = {};
    for (const d of new Set(lt.map((r) => r.Driver))) {
      const g = lt.filter((r) => r.Driver === d && r.LapNumber > 1 && r.LapTimeSeconds > 0
        && r.LapTimeSeconds < 200 && !r.PitInTimeSeconds && !r.PitOutTimeSeconds
        && String(r.TrackStatus) === '1').map((r) => r.LapTimeSeconds);
      if (g.length > 5) greenMedian[d] = median(g);
    }
    for (const m of measured) {
      const loss = by.get(`${m.Driver}|${m.inLap}`).LapTimeSeconds
        + by.get(`${m.Driver}|${m.inLap + 1}`).LapTimeSeconds - 2 * greenMedian[m.Driver];
      expect(m.loss).toBeCloseTo(loss, 9);
      expect(m.label).toBe(`${loss.toFixed(1)}s`);
    }

    // Every label is at least 20 s (the old in-lap-only label had a 6.4 s median)
    const values = markers.map((m) => m.loss);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(20);
    expect(Math.abs(median(values) - 26.8)).toBeLessThanOrEqual(1.5);
    // Green stops: the bulk lies in 20-30 s; every stop above 30 s is a slow
    // stop, with an out-lap slower than the median out-lap of the 20-30 s stops
    const outLapTime = (m) => by.get(`${m.Driver}|${m.inLap + 1}`).LapTimeSeconds;
    const inRange = measured.filter((m) => m.loss >= 20 && m.loss <= 30);
    expect(inRange.length / measured.length).toBeGreaterThanOrEqual(0.75);
    const typicalOutLap = median(inRange.map(outLapTime));
    for (const m of measured.filter((x) => x.loss > 30)) {
      expect(outLapTime(m)).toBeGreaterThan(typicalOutLap);
    }
    // TSU entered the pits on lap 7 and stayed there: a pit-lane visit, not a stop
    expect(markers.some((m) => m.Driver === 'TSU')).toBe(false);
    expect(pitLaneVisits(lt).map((v) => [v.Driver, v.inLap, v.retired])).toEqual([['TSU', 7, true]]);
  });

  it('replay sweep (D6 #2, #4): every label is measured or pending; the 40.1 s "est" labels of laps 7-15 are gone', () => {
    const lastEnd = Math.max(...lt.map((r) => r.Time));
    let pendingSeen = 0;
    let measuredSeen = 0;
    for (let now = offset; now <= lastEnd + 1; now += 10) {
      const est = estimatePitLoss(lt, { sessionNow: now });
      const samples = new Map(est.samples.map((s) => [`${s.driver}|${s.inLap}`, s.loss]));
      for (const m of pitStopMarkers(lt, { sessionNow: now, estimate: est })) {
        // a stop is shown only from its pit exit
        expect(m.pitOutTime).toBeLessThanOrEqual(now);
        if (m.source === 'measured') {
          measuredSeen++;
          expect(m.label).toBe(`${samples.get(`${m.Driver}|${m.inLap}`).toFixed(1)}s`);
        } else {
          // all Monza stops are green-flag stops: not yet measurable = out-lap
          // still running, or the driver has no green-flag median yet
          expect(m.source).toBe('pending');
          expect(m.label).toBe('');
          const outRow = lt.find((r) => r.Driver === m.Driver && r.LapNumber === m.outLap);
          const noMedian = driverGreenMedians(lt, { sessionNow: now })[m.Driver] == null;
          expect(!isLapCompleted(outRow, now) || noMedian).toBe(true);
          pendingSeen++;
        }
      }
    }
    expect(pendingSeen).toBeGreaterThan(0);
    expect(measuredSeen).toBeGreaterThan(0);
  });

  it('is causal in lap mode at lap 20: no future stint, stop or pit exit', () => {
    const sessionNow = resolveSessionNow({ currentLap: 20, lapTimes: lt });
    const bars = stintBars(deriveStints(lt, { sessionNow }));
    for (const b of bars) {
      if (b.StintLength === 0) continue; // a stint just begun (pit exit passed)
      const last = lt.find((r) => r.Driver === b.Driver && r.LapNumber === b.LapStart + b.StintLength - 1);
      expect(isLapCompleted(last, sessionNow)).toBe(true);
      expect(b.LapStart + b.StintLength - 1).toBeLessThanOrEqual(19);
    }
    const piaDone = lt.filter((r) => r.Driver === 'PIA' && isLapCompleted(r, sessionNow))
      .map((r) => r.LapNumber);
    expect(bars.filter((b) => b.Driver === 'PIA').map((b) => `${b.Compound} ${b.StartLap}-${b.EndLap} ${b.ongoing}`))
      .toEqual(['MEDIUM 1-16 false', `HARD 17-${Math.max(...piaDone)} true`]);
    const markers = pitStopMarkers(lt, { sessionNow });
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(m.pitOutTime).toBeLessThanOrEqual(sessionNow);
    // every stop measured at lap 20 is also a sample of the estimate at lap 20
    const est = estimatePitLoss(lt, { sessionNow });
    expect(markers.filter((m) => m.source === 'measured').length).toBe(est.n);
    // a stop one lap later is not there yet
    expect(markers.some((m) => m.Driver === 'PER' && m.inLap === 23)).toBe(false);
  });

  it('lap mode at laps 1 and 2: every driver has a row (stint 1 from the race start, D1 #8)', () => {
    const drivers = new Set(lt.filter((r) => r.LapNumber === 1).map((r) => r.Driver));
    for (const currentLap of [1, 2]) {
      const sessionNow = resolveSessionNow({ currentLap, lapTimes: lt });
      const bars = stintBars(deriveStints(lt, { sessionNow }));
      expect(new Set(bars.map((b) => b.Driver))).toEqual(drivers);
      expect(bars.length).toBe(drivers.size);
      expect(pitStopMarkers(lt, { sessionNow })).toEqual([]);
    }
  });

  it('on the replay clock around PIA\'s first stop: pit lane, pit exit (badge and bars together), measured', () => {
    const inLap = lt.find((r) => r.Driver === 'PIA' && r.LapNumber === 16);
    const outLap = lt.find((r) => r.Driver === 'PIA' && r.LapNumber === 17);
    const at = (sessionTime) => {
      const sessionNow = resolveSessionNow({
        currentTime: sessionTime - offset, sessionTimeOffset: offset, replayActive: true, lapTimes: lt,
      });
      return {
        pia: pitStopMarkers(lt, { sessionNow }).find((m) => m.Driver === 'PIA' && m.inLap === 16),
        badge: pitCountsByDriver(pitStopMarkers(lt, { sessionNow })).PIA || 0,
        stints: stintsByDriver(lt, { sessionNow }).PIA,
        inLane: pitLaneNow(lt, sessionNow).some((p) => p.Driver === 'PIA'),
      };
    };
    const before = at(inLap.PitInTimeSeconds - 0.5);
    expect(before).toMatchObject({ pia: undefined, badge: 0, inLane: false });
    const inPit = at(inLap.PitInTimeSeconds + 0.5);
    expect(inPit).toMatchObject({ pia: undefined, badge: 0, inLane: true });
    expect(inPit.stints.map((s) => s.Compound)).toEqual(['MEDIUM']); // old set still current
    const exit = pitOutSeconds(outLap);
    const justBefore = at(exit - 0.1);
    expect(justBefore).toMatchObject({ pia: undefined, badge: 0, inLane: true });
    const atExit = at(exit);
    expect(atExit).toMatchObject({ badge: 1, inLane: false });
    expect(atExit.pia).toMatchObject({ source: 'pending', label: '', outLap: 17, toCompound: 'HARD' });
    expect(atExit.stints.map((s) => `${s.Compound} ${s.StartLap}-${s.EndLap}`)).toEqual(['MEDIUM 1-16', 'HARD 17-16']);
    const out = at(outLap.Time + 0.5);
    expect(out.pia).toMatchObject({ source: 'measured', outLap: 17 });
    expect(out.pia.loss).toBeGreaterThan(20);
    expect(out.badge).toBe(1);
  });

  it('live-shaped rows (no pit times): PIA, NOR, HAM still show 2 stops = 3 bars - 1 (D6 #1, D1 #4)', () => {
    const live = lt.map((r) => ({
      ...r, PitInTime: null, PitInTimeSeconds: null, PitOutTime: null, PitOutTimeSeconds: null,
    }));
    const badge = pitCountsByDriver(pitStopMarkers(live, { sessionNow: Infinity }));
    const bars = stintsByDriver(live, { sessionNow: Infinity });
    for (const d of ['PIA', 'NOR', 'HAM']) {
      expect(badge[d]).toBe(2);
      expect(bars[d].length).toBe(3);
    }
    for (const [d, b, c, n] of countsAt(live, Infinity)) expect([d, b, c]).toEqual([d, n, n]);
  });
});

describe.skipIf(!hasCachedSession(2024, 5))('pit-loss labels in a Safety-Car race, China 2024 (cached)', () => {
  const lt = hasCachedSession(2024, 5) ? loadCachedSession(2024, 5).lap_times : [];

  it('stops with a non-green lap around them show the race median, "≈"', () => {
    const est = estimatePitLoss(lt);
    const markers = pitStopMarkers(lt, { estimate: est });
    const by = new Map(lt.map((r) => [`${r.Driver}|${r.LapNumber}`, r]));
    const nonGreen = markers.filter((m) => [m.inLap - 1, m.inLap, m.inLap + 1]
      .some((n) => String(by.get(`${m.Driver}|${n}`)?.TrackStatus) !== '1'));
    expect(nonGreen.length).toBeGreaterThan(0);
    for (const m of nonGreen) {
      expect(m.source).toBe('estimate');
      expect(m.loss).toBe(est.median);
      expect(m.label).toBe(`≈${est.median.toFixed(1)}s`);
      expect(describeStopLoss(m)).toContain(`race median of ${est.n} measured green stops`);
    }
    expect(markers.filter((m) => m.source === 'measured').length).toBe(est.n);
  });
});

describe.skipIf(!hasCachedSession(2025, 1))('pit-loss labels without any green stop, Australia 2025 (cached)', () => {
  const lt = hasCachedSession(2025, 1) ? loadCachedSession(2025, 1).lap_times : [];

  it('labels every stop with the fallback, "22.0s*"; SC pit-lane passes are no stops', () => {
    const markers = pitStopMarkers(lt);
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) {
      expect(m).toMatchObject({ source: 'fallback', estimateSource: 'fallback', loss: FB });
      expect(m.label).toBe(`${FB.toFixed(1)}s*`);
    }
    // NOR: INTERMEDIATE 1-34, HARD 35-44, INTERMEDIATE 45-57; laps 2-4 under SC are pit-lane passes
    expect(markers.filter((m) => m.Driver === 'NOR').map((m) => [m.inLap, m.outLap]))
      .toEqual([[34, 35], [44, 45]]);
    expect(pitLaneVisits(lt).filter((v) => v.Driver === 'NOR').map((v) => v.inLap)).toEqual([2, 3, 4]);
    // the short fallback label no longer stacks into unreadable pills (D6 #3)
    expect(markers.every((m) => m.label.length <= 6)).toBe(true);
  });
});

describe.skipIf(!hasCachedSession(2024, 8, 'Q'))('qualifying, Monaco 2024 (cached, R7)', () => {
  const lt = hasCachedSession(2024, 8, 'Q') ? loadCachedSession(2024, 8, 'Q').lap_times : [];

  it('runs are drawn as stints and their tyre changes carry no pit-loss number', () => {
    expect(estimatePitLoss(lt, { sessionType: 'Q' })).toMatchObject({ source: 'not-applicable', median: null, n: 0 });
    const markers = pitStopMarkers(lt, { sessionType: 'Q' });
    const bars = stintBars(deriveStints(lt));
    const drivers = new Set(bars.map((b) => b.Driver));
    expect(markers.length).toBe(bars.length - drivers.size);
    for (const m of markers) {
      expect(m).toMatchObject({ source: 'not-applicable', loss: null, label: '' });
    }
    // Without the gate the race estimator would label them (garage runs, not pit losses)
    expect(pitStopMarkers(lt).some((m) => m.label !== '')).toBe(true);
  });
});

describe('one stop count everywhere (R2) and the new tyre at the pit exit (R3)', () => {
  const races = [[2024, 16], [2024, 5], [2025, 1]].filter(([y, r]) => hasCachedSession(y, r));

  it.skipIf(races.length === 0)('badge = DriverComparePanel count = bars - 1 = raceSituationFeatures pitStops, at every pit exit and lap', () => {
    for (const [year, round] of races) {
      const lt = loadCachedSession(year, round).lap_times;
      const instants = [];
      for (const s of pitStops(lt)) {
        if (s.pitOutTime != null) instants.push(s.pitOutTime - 0.001, s.pitOutTime, s.pitOutTime + 0.001);
      }
      const maxLap = Math.max(...lt.map((r) => r.LapNumber));
      const lapNows = [];
      for (let lap = 3; lap < maxLap; lap += 4) lapNows.push([lap, resolveSessionNow({ currentLap: lap, lapTimes: lt })]);
      for (const now of instants) {
        for (const [d, badge, compare, barsMinus1] of countsAt(lt, now)) {
          expect([year, round, now, d, badge, compare]).toEqual([year, round, now, d, barsMinus1, barsMinus1]);
        }
      }
      for (const [currentLap, now] of lapNows) {
        const badge = pitCountsByDriver(pitStopMarkers(lt, { sessionNow: now }));
        const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap, dnfMap: {}, sessionNow: now });
        if (!feats) continue;
        for (const d of feats.driverAbbrs) {
          expect([year, round, currentLap, d, feats.driverFeatures[d].pitStops])
            .toEqual([year, round, currentLap, d, badge[d] || 0]);
        }
      }
    }
  });
});
