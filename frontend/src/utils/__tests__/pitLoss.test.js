import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FALLBACK_PIT_LOSS, driverGreenMedians, estimatePitLoss, perStopLoss, isRaceSession,
} from '../pitLoss.js';
import { lapEndTime } from '../raceTime.js';
import { hasCachedSession, loadCachedSession, listCachedRaces } from '../../__tests__/helpers/cachedSession.js';

// Synthetic race on the SESSION clock. Each driver has a base pace; lap n of
// driver i starts at T0 + (n - 1) * 100 + i, lap times vary around the base so
// that the medians are known exactly.
const T0 = 1000;
const DRIVERS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];

function lap(driver, n, lapTime, extra = {}) {
  const start = T0 + (n - 1) * 100 + DRIVERS.indexOf(driver);
  return {
    Driver: driver, LapNumber: n, LapStartTime: start, Time: start + lapTime, LapTimeSeconds: lapTime,
    TrackStatus: '1', PitInTimeSeconds: null, PitOutTimeSeconds: null, ...extra,
  };
}

/**
 * A driver with `n` laps at `pace` s, a stop with in-lap `inLap` (`inLoss` s
 * slower) and out-lap inLap + 1 (`outLoss` s slower). Lap 1 is 10 s slower.
 */
function driverLaps(driver, { n = 12, pace = 90, inLap = 6, inLoss = 5, outLoss = 15, status = {} } = {}) {
  const rows = [];
  for (let k = 1; k <= n; k++) {
    let t = pace;
    const extra = {};
    if (k === 1) t += 10;
    if (inLap && k === inLap) { t += inLoss; extra.PitInTimeSeconds = 0; }
    if (inLap && k === inLap + 1) { t += outLoss; extra.PitOutTimeSeconds = 0; }
    if (status[k]) extra.TrackStatus = status[k];
    const row = lap(driver, k, t, extra);
    if (extra.PitInTimeSeconds === 0) row.PitInTimeSeconds = row.Time - 8;
    if (extra.PitOutTimeSeconds === 0) row.PitOutTimeSeconds = row.LapStartTime + 22;
    rows.push(row);
  }
  return rows;
}

describe('driverGreenMedians', () => {
  it('uses green laps > 1, < 200 s, without pit-in / pit-out', () => {
    const rows = driverLaps('AAA', { n: 12, pace: 90, inLap: 6 });
    rows[2].LapTimeSeconds = 250;          // lap 3: > 200 s, dropped
    rows[3].TrackStatus = '4';             // lap 4: SC, dropped
    rows[4].LapTimeSeconds = 91;           // lap 5: kept
    // kept: laps 2, 5, 8, 9, 10, 11, 12 -> 90 x 6 and 91 -> median 90
    expect(driverGreenMedians(rows)).toEqual({ AAA: 90 });
  });

  it('needs more than 5 green laps; even counts average the middle pair', () => {
    const five = driverLaps('AAA', { n: 6, inLap: null }); // green laps 2..6 = 5 laps
    expect(driverGreenMedians(five)).toEqual({});
    const six = driverLaps('AAA', { n: 7, inLap: null }).map((r, i) => ({ ...r, LapTimeSeconds: i === 0 ? 100 : 89 + i }));
    // laps 2..7 = 90, 91, 92, 93, 94, 95 -> (92 + 93) / 2
    expect(driverGreenMedians(six)).toEqual({ AAA: 92.5 });
  });

  it('is causal: only laps completed at sessionNow count', () => {
    const rows = driverLaps('AAA', { n: 12, inLap: null });
    expect(driverGreenMedians(rows, { sessionNow: rows[5].Time })).toEqual({}); // laps 2..6 only
    expect(driverGreenMedians(rows, { sessionNow: rows[6].Time })).toEqual({ AAA: 90 });
  });
});

describe('estimatePitLoss (synthetic)', () => {
  it('loss = in-lap + out-lap - 2 x driver green median', () => {
    const rows = driverLaps('AAA', { pace: 90, inLoss: 4, outLoss: 18 });
    const est = estimatePitLoss(rows);
    expect(est.n).toBe(1);
    expect(est.source).toBe('race');
    expect(est.samples).toEqual([{ driver: 'AAA', inLap: 6, loss: 22 }]);
    expect(est.median).toBe(22);
    expect(est.mean).toBe(22);
    expect(est.stdDev).toBe(0);
    expect(est.p10).toBe(22);
    expect(est.p90).toBe(22);
  });

  it('median, mean, sample stdDev and linear-interpolation percentiles', () => {
    // Five drivers, losses 20, 22, 24, 26, 28 (all in-lap + out-lap)
    const rows = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].flatMap((d, i) =>
      driverLaps(d, { inLoss: 5, outLoss: 15 + 2 * i }));
    const est = estimatePitLoss(rows);
    expect(est.samples.map((s) => s.loss)).toEqual([20, 22, 24, 26, 28]);
    expect(est.median).toBe(24);
    expect(est.mean).toBe(24);
    expect(est.stdDev).toBeCloseTo(Math.sqrt(10), 12); // (16 + 4 + 0 + 4 + 16) / 4
    expect(est.p10).toBeCloseTo(20.8, 12);              // 20 + 0.4 x 2
    expect(est.p90).toBeCloseTo(27.2, 12);
    expect(est.n).toBe(5);
  });

  it('drops stops with a non-green lap n - 1, n or n + 1', () => {
    for (const k of [5, 6, 7]) {
      const rows = driverLaps('AAA', { status: { [k]: '671' } });
      expect(estimatePitLoss(rows).n).toBe(0);
    }
    expect(estimatePitLoss(driverLaps('AAA', { status: { 4: '4' } })).n).toBe(1); // lap 4 is outside
  });

  it('keeps only 10 < loss < 60', () => {
    expect(estimatePitLoss(driverLaps('AAA', { inLoss: 2, outLoss: 8 })).n).toBe(0);   // 10
    expect(estimatePitLoss(driverLaps('AAA', { inLoss: 2, outLoss: 8.5 })).n).toBe(1); // 10.5
    expect(estimatePitLoss(driverLaps('AAA', { inLoss: 20, outLoss: 40 })).n).toBe(0); // 60
    expect(estimatePitLoss(driverLaps('AAA', { inLoss: 20, outLoss: 39 })).n).toBe(1); // 59
  });

  it('needs the driver green median, the out-lap and the lap before the in-lap', () => {
    expect(estimatePitLoss(driverLaps('AAA', { n: 8, inLap: 6 })).n).toBe(0);           // 4 green laps only
    expect(estimatePitLoss(driverLaps('AAA', { inLap: 12, n: 12 })).n).toBe(0);         // no out-lap row
    const noPrev = driverLaps('AAA').filter((r) => r.LapNumber !== 5);
    expect(estimatePitLoss(noPrev).n).toBe(0);
    const noOutMark = driverLaps('AAA').map((r) => (r.LapNumber === 7 ? { ...r, PitOutTimeSeconds: null } : r));
    expect(estimatePitLoss(noOutMark).n).toBe(0);
  });

  it('falls back to FALLBACK_PIT_LOSS with n = 0 and source "fallback"', () => {
    expect(FALLBACK_PIT_LOSS).toEqual({ median: 22, stdDev: 2.5 });
    expect(Object.isFrozen(FALLBACK_PIT_LOSS)).toBe(true);
    for (const input of [[], null, driverLaps('AAA', { inLap: null })]) {
      const est = estimatePitLoss(input);
      expect(est).toMatchObject({ median: 22, mean: 22, stdDev: 2.5, n: 0, source: 'fallback', samples: [] });
      expect(est.p10).toBeCloseTo(22 - 1.2816 * 2.5, 12);
      expect(est.p90).toBeCloseTo(22 + 1.2816 * 2.5, 12);
    }
  });

  it('is causal: a stop counts only once its out-lap is completed', () => {
    const rows = [...driverLaps('AAA', { inLap: 6 }), ...driverLaps('BBB', { inLap: 9, outLoss: 25 })];
    const bbbOut = rows.find((r) => r.Driver === 'BBB' && r.LapNumber === 10);
    const before = estimatePitLoss(rows, { sessionNow: bbbOut.Time - 0.001 });
    expect(before.samples.map((s) => s.driver)).toEqual(['AAA']);
    const at = estimatePitLoss(rows, { sessionNow: bbbOut.Time });
    expect(at.samples.map((s) => s.driver)).toEqual(['AAA', 'BBB']);
    const aaaIn = rows.find((r) => r.Driver === 'AAA' && r.LapNumber === 6);
    expect(estimatePitLoss(rows, { sessionNow: aaaIn.Time }).source).toBe('fallback');
  });
});

describe('perStopLoss', () => {
  const rows = [...driverLaps('AAA', { inLoss: 4, outLoss: 18 }), ...driverLaps('BBB', { status: { 6: '4' } })];

  it('returns the measured loss of a sampled stop', () => {
    expect(perStopLoss(rows, 'AAA', 6)).toEqual({ loss: 22, source: 'measured', estimateSource: 'race' });
  });

  it('returns the race median, labelled estimate, for a stop that can never be measured', () => {
    expect(perStopLoss(rows, 'BBB', 6)).toEqual({ loss: 22, source: 'estimate', estimateSource: 'race' });
  });

  it('reuses a precomputed estimate; a never-measurable stop with n = 0 is the fallback', () => {
    const est = estimatePitLoss(rows, { sessionNow: T0 });
    expect(est.source).toBe('fallback');
    // no sessionNow: the whole race is known, so nothing is pending
    expect(perStopLoss(rows, 'AAA', 6, { estimate: est }))
      .toEqual({ loss: FALLBACK_PIT_LOSS.median, source: 'fallback', estimateSource: 'fallback' });
    expect(perStopLoss(rows, 'AAA', 6, { sessionNow: T0 }).estimateSource).toBe('fallback');
    const sc = driverLaps('CCC', { status: { 6: '4' } });
    expect(perStopLoss(sc, 'CCC', 6)).toEqual({ loss: FALLBACK_PIT_LOSS.median, source: 'fallback', estimateSource: 'fallback' });
  });
});

describe('perStopLoss: measured / pending / estimate / fallback over time (R7)', () => {
  // AAA: green stop on lap 6 (loss 22 s). Its out-lap is lap 7, and AAA has
  // only 4 green laps (2-5) before the stop, so the stop becomes a sample when
  // the 6th green lap (lap 9) ends.
  const aaa = driverLaps('AAA', { inLoss: 4, outLoss: 18 });
  const at = (list, drv, n) => list.find((r) => r.Driver === drv && r.LapNumber === n);
  const label = (list, drv, inLap, now) => perStopLoss(list, drv, inLap, { sessionNow: now });

  it('pending (no number) while the out-lap runs and until the driver has a green median, then measured', () => {
    const out = at(aaa, 'AAA', 7);
    expect(label(aaa, 'AAA', 6, out.PitOutTimeSeconds))
      .toEqual({ loss: null, source: 'pending', estimateSource: 'fallback' });
    expect(label(aaa, 'AAA', 6, out.Time).source).toBe('pending'); // out-lap over, median not defined yet
    expect(label(aaa, 'AAA', 6, at(aaa, 'AAA', 9).Time - 0.001).source).toBe('pending');
    expect(label(aaa, 'AAA', 6, at(aaa, 'AAA', 9).Time))
      .toEqual({ loss: 22, source: 'measured', estimateSource: 'race' });
  });

  it('a pending stop whose out-lap ends under SC becomes an estimate (known only when it ends)', () => {
    // BBB stops on lap 10; its out-lap 11 runs under SC. AAA's stop gives the race median.
    const list = [...aaa, ...driverLaps('BBB', { inLap: 10, status: { 11: '4' } })];
    const out = at(list, 'BBB', 11);
    expect(label(list, 'BBB', 10, out.PitOutTimeSeconds))
      .toEqual({ loss: null, source: 'pending', estimateSource: 'race' });
    expect(label(list, 'BBB', 10, out.Time - 0.001).source).toBe('pending');
    expect(label(list, 'BBB', 10, out.Time)).toEqual({ loss: 22, source: 'estimate', estimateSource: 'race' });
  });

  it('a stop with a non-green lap before or on the in-lap is an estimate from its pit exit', () => {
    const list = [...aaa, ...driverLaps('CCC', { inLap: 10, status: { 10: '6' } })];
    const out = at(list, 'CCC', 11);
    expect(label(list, 'CCC', 10, out.PitOutTimeSeconds)).toEqual({ loss: 22, source: 'estimate', estimateSource: 'race' });
    const early = [...aaa, ...driverLaps('DDD', { inLap: 6, status: { 5: '2' } })];
    const fb = label(early, 'DDD', 6, at(early, 'DDD', 7).PitOutTimeSeconds);
    expect(fb).toEqual({ loss: FALLBACK_PIT_LOSS.median, source: 'fallback', estimateSource: 'fallback' });
  });

  it('at Infinity nothing is pending; a driver who stopped running is not pending either', () => {
    const short = driverLaps('AAA', { n: 8, inLoss: 4, outLoss: 18 }); // 5 green laps in total, retires after lap 8
    expect(perStopLoss(short, 'AAA', 6).source).toBe('fallback');
    expect(label(short, 'AAA', 6, at(short, 'AAA', 8).Time).source).toBe('fallback');
    expect(label(short, 'AAA', 6, at(short, 'AAA', 8).Time - 0.001).source).toBe('pending');
  });
});

describe('session type (R7): pit loss only for race sessions', () => {
  const rows = driverLaps('AAA', { inLoss: 4, outLoss: 18 });

  it('isRaceSession: R and S (any case) and a missing type are races; Q, SQ, FP are not', () => {
    for (const t of ['R', 'S', 'r', ' s ', undefined, null, '']) expect(isRaceSession(t), String(t)).toBe(true);
    for (const t of ['Q', 'SQ', 'FP1', 'FP2', 'FP3', 'SS']) expect(isRaceSession(t), t).toBe(false);
  });

  it('estimatePitLoss outside R / S: source not-applicable with no numbers', () => {
    for (const sessionType of ['Q', 'FP2', 'SQ']) {
      expect(estimatePitLoss(rows, { sessionType })).toEqual({
        median: null, mean: null, stdDev: null, p10: null, p90: null, n: 0, source: 'not-applicable', samples: [],
      });
    }
    expect(estimatePitLoss(rows, { sessionType: 'R' })).toEqual(estimatePitLoss(rows));
    expect(estimatePitLoss(rows, { sessionType: 'S' })).toEqual(estimatePitLoss(rows));
    expect(estimatePitLoss(rows).source).toBe('race');
  });

  it('perStopLoss outside R / S: not-applicable, no number', () => {
    const na = { loss: null, source: 'not-applicable', estimateSource: 'not-applicable' };
    expect(perStopLoss(rows, 'AAA', 6, { sessionType: 'Q' })).toEqual(na);
    expect(perStopLoss(rows, 'AAA', 6, { estimate: estimatePitLoss(rows, { sessionType: 'Q' }) })).toEqual(na);
    expect(perStopLoss(rows, 'AAA', 6, { sessionType: 'R' }).source).toBe('measured');
  });
});

describe.skipIf(!hasCachedSession(2024, 8, 'Q'))('qualifying, 2024 R8 Q (cached)', () => {
  const rows = hasCachedSession(2024, 8, 'Q') ? loadCachedSession(2024, 8, 'Q').lap_times : [];

  it('no pit loss: the in-lap / out-lap pairs are garage runs', () => {
    expect(rows.some((r) => r.PitInTimeSeconds)).toBe(true);
    expect(estimatePitLoss(rows, { sessionType: 'Q' }).source).toBe('not-applicable');
    const inLap = rows.find((r) => r.PitInTimeSeconds && r.LapNumber > 1);
    expect(perStopLoss(rows, inLap.Driver, inLap.LapNumber, { sessionType: 'Q' }).loss).toBeNull();
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('stop labels over the Monza 2024 replay (R7)', () => {
  const rows = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];
  const find = (drv, n) => rows.find((r) => r.Driver === drv && r.LapNumber === n);

  it('a stop measured at the end is pending, never an estimate, from its pit exit to its measurement', () => {
    const final = estimatePitLoss(rows);
    expect(final.n).toBe(30);
    for (const s of final.samples) {
      const out = find(s.driver, s.inLap + 1);
      const seq = [];
      for (let now = out.PitOutTimeSeconds; ; now += 30) {
        const r = perStopLoss(rows, s.driver, s.inLap, { sessionNow: now });
        seq.push(r.source);
        if (r.source === 'measured') { expect(r.loss).toBeGreaterThan(10); break; }
        expect(r).toMatchObject({ source: 'pending', loss: null });
        expect(now).toBeLessThan(out.Time + 30 * 100);
      }
      expect(seq[0]).toBe('pending'); // at the pit exit the out-lap is still running
    }
  });

  it('GAS lap 10: pending during the out-lap, measured when it ends (no early race median)', () => {
    const out = find('GAS', 11);
    expect(perStopLoss(rows, 'GAS', 10, { sessionNow: out.PitOutTimeSeconds }).source).toBe('pending');
    expect(perStopLoss(rows, 'GAS', 10, { sessionNow: out.Time - 0.001 }).source).toBe('pending');
    const m = perStopLoss(rows, 'GAS', 10, { sessionNow: out.Time });
    expect(m.source).toBe('measured');
    // the loss with GAS's green median at that moment (it moves as more green laps complete)
    const atEnd = estimatePitLoss(rows, { sessionNow: out.Time });
    expect(m.loss).toBe(atEnd.samples.find((x) => x.driver === 'GAS' && x.inLap === 10).loss);
    expect(m.loss).toBeGreaterThan(20);
    expect(m.loss).toBeLessThan(30);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('pit loss on cached Monza 2024 (R16)', () => {
  const rows = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];

  it('median within 26.8 +/- 1.5 s at the end of the race', () => {
    const est = estimatePitLoss(rows);
    expect(est.source).toBe('race');
    expect(Math.abs(est.median - 26.8)).toBeLessThanOrEqual(1.5);
    expect(est.p10).toBeLessThanOrEqual(est.median);
    expect(est.p90).toBeGreaterThanOrEqual(est.median);
    expect(est.samples).toHaveLength(est.n);
  });

  it('is causal: no stop counts before its out-lap ends, and it counts from then on', () => {
    const est = estimatePitLoss(rows);
    const outEnd = (s) => lapEndTime(rows.find((r) => r.Driver === s.driver && r.LapNumber === s.inLap + 1));
    const has = (e, s) => e.samples.some((x) => x.driver === s.driver && x.inLap === s.inLap);
    let onTime = 0;
    for (const s of est.samples) {
      const t = outEnd(s);
      expect(has(estimatePitLoss(rows, { sessionNow: t - 0.001 }), s)).toBe(false);
      if (has(estimatePitLoss(rows, { sessionNow: t }), s)) onTime += 1;
      // An early stop is not measurable yet when the driver has too few green laps
      else expect(driverGreenMedians(rows, { sessionNow: t })[s.driver]).toBeUndefined();
    }
    expect(onTime).toBeGreaterThan(est.n / 2);
  });

  it('mid race: every sample has its out-lap completed before sessionNow', () => {
    const lapEnd = new Map(rows.map((r) => [`${r.Driver}|${r.LapNumber}`, r.Time]));
    const now = Math.min(...rows.filter((r) => r.LapNumber === 30).map((r) => r.Time));
    const est = estimatePitLoss(rows, { sessionNow: now });
    expect(est.n).toBeGreaterThan(0);
    expect(est.n).toBeLessThan(estimatePitLoss(rows).n);
    for (const s of est.samples) expect(lapEnd.get(`${s.driver}|${s.inLap + 1}`)).toBeLessThanOrEqual(now);
  });
});

// Cross-check against backend/scripts/validate_pit_loss_and_rejoin.py: the JS
// estimator at sessionNow = Infinity must reproduce the script's per-race
// numbers. Nothing is hard-coded: the Python numbers come from running it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../../backend');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const SCRIPT = path.join(BACKEND, 'scripts', 'validate_pit_loss_and_rejoin.py');
const canCompare = !!PYTHON && fs.existsSync(SCRIPT) && listCachedRaces().length > 0;

function runPython(args) {
  const res = spawnSync(PYTHON, args, { cwd: BACKEND, encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
  return res.stdout;
}

// Exact per-race values from the script's own functions (green_medians, green_stops)
const EXACT_PY = `
import json, os, statistics as st, sys
sys.path.insert(0, 'scripts')
import validate_pit_loss_and_rejoin as v
out = {}
for f in sorted(os.listdir(v.CACHE_DIR)):
    if f.startswith('session_') and f.endswith('_R.json'):
        by = v.load(os.path.join(v.CACHE_DIR, f))
        stops = v.green_stops(by, v.green_medians(by))
        out[f[8:-7]] = {'n': len(stops), 'median': st.median(s['loss'] for s in stops) if stops else None}
print(json.dumps(out))
`;

describe.skipIf(!canCompare)('JS estimator vs validate_pit_loss_and_rejoin.py on every cached race', () => {
  const races = listCachedRaces();

  it('matches the printed true_loss table (n_green and median to 0.1 s)', () => {
    const printed = {};
    for (const line of runPython([SCRIPT]).split(/\r?\n/)) {
      const m = /^(\d{4}_\d+)\s+(\d+)\s+(-?[\d.]+)\s/.exec(line);
      if (m) printed[m[1]] = { n: Number(m[2]), median: Number(m[3]) };
    }
    expect(Object.keys(printed).length).toBeGreaterThan(0);
    const rowsOut = [];
    for (const { year, round } of races) {
      const key = `${year}_${round}`;
      const est = estimatePitLoss(loadCachedSession(year, round).lap_times);
      rowsOut.push({ race: key, n: est.n, js: est.median.toFixed(3), py: printed[key]?.median ?? '-', source: est.source });
      if (printed[key]) {
        expect(est.n, key).toBe(printed[key].n);
        expect(Math.abs(est.median - printed[key].median), key).toBeLessThanOrEqual(0.05 + 1e-9);
      } else {
        // The script prints no row for races without a qualifying stop
        expect(est.n, key).toBe(0);
        expect(est.source, key).toBe('fallback');
      }
    }
    if (process.env.PIT_LOSS_TABLE) console.table(rowsOut);
  });

  it('matches the script functions exactly (same samples, same median)', () => {
    const py = JSON.parse(runPython(['-c', EXACT_PY]));
    for (const { year, round } of races) {
      const key = `${year}_${round}`;
      const est = estimatePitLoss(loadCachedSession(year, round).lap_times);
      expect(est.n, key).toBe(py[key].n);
      if (py[key].n > 0) expect(Math.abs(est.median - py[key].median), key).toBeLessThan(1e-9);
      else expect(est.source, key).toBe('fallback');
    }
  });
});
