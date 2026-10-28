// Race pace of this race (utils/fieldPace.js): the comparable-lap filter rule
// by rule, LapRep, the sign of pct, the deterministic moving-block bootstrap,
// the team-mate verdicts, the lap range, causality under perturbFuture, and
// the five tracked demo races (frontend/public/data).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  comparableLaps, fieldPace, blockBootstrapMedians, tyreClass, gapLine, pctText, gapVerdict,
  PACE_MIN_LAP_FIELD, PACE_LOW_DATA_LAPS, PACE_BLOCK_LAPS, PACE_BOOTSTRAP_RUNS, PACE_INTERVAL,
} from '../fieldPace.js';
import { seedFrom, uniformAt } from '../prng.js';
import { resolveSessionNow } from '../raceTime.js';
import { perturbFuture } from './futureRows.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../../public/data');
const demo = (year, round) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, `${year}_${round}_R/session.json.gz`))));

// Synthetic field: `codes` run `nLaps` laps; car i's lap k takes base(k) +
// pace[i] + a small deterministic wobble; consecutive laps of a car chain on Time.
const T0 = 1000;
function field(codes, pace, nLaps, {
  teams = null, extra = () => ({}), base = () => 90, wobbleOf = (i) => i,
} = {}) {
  const rows = [];
  codes.forEach((d, i) => {
    let t = T0;
    for (let k = 1; k <= nLaps; k++) {
      const wobble = (((wobbleOf(i) * 7 + k * 13) % 11) - 5) * 0.02;
      const dur = base(k) + pace[i] + wobble;
      const row = {
        Driver: d, Team: teams ? teams[i] : `T${Math.floor(i / 2)}`, LapNumber: k, LapStartTime: t, Time: t + dur,
        LapTimeSeconds: dur, TrackStatus: '1', Compound: 'MEDIUM', Deleted: false, PitInTimeSeconds: null,
        PitOutTimeSeconds: null, Position: i + 1,
      };
      Object.assign(row, extra(d, k, row));
      rows.push(row);
      t = row.Time;
    }
  });
  return rows;
}
const CODES = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];
const lapsOf = (res, d) => res.laps.filter((e) => e.driver === d).map((e) => e.lap);

describe('comparable laps, rule by rule', () => {
  it('lap 1, pit in / out, a non-green lap, t >= 200 s, a deleted lap: out', () => {
    const rows = field(CODES, [0, 0.1, 0.2, 0.3, 0.4, 0.5], 8, {
      extra: (d, k) => {
        if (d !== 'AAA') return {};
        if (k === 3) return { PitInTimeSeconds: 1 };
        if (k === 4) return { PitOutTimeSeconds: 1 };
        if (k === 5) return { TrackStatus: '12' };
        if (k === 6) return { LapTimeSeconds: 201 };
        if (k === 7) return { Deleted: true };
        return {};
      },
    });
    const res = comparableLaps(rows);
    expect(lapsOf(res, 'AAA')).toEqual([2, 8]);
    expect(lapsOf(res, 'BBB')).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('the lap\'s tyre class must be the majority of its lap number; a tie keeps no lap of it', () => {
    const rows = field(CODES, [0, 0.1, 0.2, 0.3, 0.4, 0.5], 4, {
      extra: (d, k) => {
        if (k === 2 && d === 'AAA') return { Compound: 'INTERMEDIATE' };
        if (k === 3 && ['AAA', 'BBB', 'CCC'].includes(d)) return { Compound: 'INTERMEDIATE' };
        return {};
      },
    });
    const res = comparableLaps(rows);
    expect(res.laps.filter((e) => e.lap === 2).map((e) => e.driver)).toEqual(['BBB', 'CCC', 'DDD', 'EEE', 'FFF']);
    expect(res.laps.filter((e) => e.lap === 3)).toEqual([]);
    expect(tyreClass('WET')).toBe('wet');
    expect(tyreClass('HARD')).toBe('dry');
    expect(tyreClass('nan')).toBe(null);
  });

  it('red-flag restart laps: from the red flag\'s lap to two laps after its end', () => {
    const rows = field(CODES, [0, 0.1, 0.2, 0.3, 0.4, 0.5], 9);
    // AAA's lap 4 runs 1270-1360: the red flag starts and ends inside it
    const status = [{ status: '5', start_time: 1300, end_time: 1340 }];
    const res = comparableLaps(rows, { trackStatus: status });
    expect([...new Set(res.laps.map((e) => e.lap))]).toEqual([2, 3, 7, 8, 9]);
  });

  it(`LapRep needs ${PACE_MIN_LAP_FIELD} comparable laps on the lap; pct < 0 = faster than the median`, () => {
    expect(PACE_MIN_LAP_FIELD).toBe(5);
    const four = field(CODES.slice(0, 4), [0, 0.1, 0.2, 0.3], 4);
    expect(comparableLaps(four).laps).toEqual([]);
    const res = comparableLaps(field(CODES, [-1, 0, 0, 0, 0, 1], 3, { extra: () => ({}) }));
    const lap2 = res.laps.filter((e) => e.lap === 2);
    const rep = lap2[0].rep;
    expect(lap2.find((e) => e.driver === 'AAA').pct).toBeCloseTo(100 * (lap2.find((e) => e.driver === 'AAA').t / rep - 1), 12);
    expect(lap2.find((e) => e.driver === 'AAA').pct).toBeLessThan(0);
    expect(lap2.find((e) => e.driver === 'FFF').pct).toBeGreaterThan(0);
  });

  it('the lap range keeps its laps only', () => {
    const res = comparableLaps(field(CODES, [0, 0.1, 0.2, 0.3, 0.4, 0.5], 10), { lapRange: [4, 6] });
    expect([...new Set(res.laps.map((e) => e.lap))]).toEqual([4, 5, 6]);
  });
});

describe('the moving-block bootstrap', () => {
  const series = Array.from({ length: 40 }, (_, i) => Math.sin(i / 4) + i * 0.01);
  it('deterministic: the same laps, the same resamples; another seed, others', () => {
    const a = blockBootstrapMedians(series, seedFrom('field-pace', 'AAA', 40, 2, 41));
    const b = blockBootstrapMedians(series, seedFrom('field-pace', 'AAA', 40, 2, 41));
    const c = blockBootstrapMedians(series, seedFrom('field-pace', 'BBB', 40, 2, 41));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBe(PACE_BOOTSTRAP_RUNS);
    expect(PACE_BLOCK_LAPS).toBe(5);
    expect(PACE_INTERVAL).toBe(0.8);
  });

  it('wider than an iid bootstrap on correlated laps (the reason for blocks)', () => {
    const seed = seedFrom('test', 1);
    const width = (meds) => {
      const s = [...meds].sort((x, y) => x - y);
      return s[Math.round(0.9 * (s.length - 1))] - s[Math.round(0.1 * (s.length - 1))];
    };
    const iid = [];
    for (let r = 0; r < PACE_BOOTSTRAP_RUNS; r++) {
      const sample = series.map((_, i) => series[Math.floor(uniformAt(seed, r, 0, i, 7) * series.length)]).sort((x, y) => x - y);
      iid.push((sample[19] + sample[20]) / 2);
    }
    expect(width(blockBootstrapMedians(series, seed))).toBeGreaterThan(width(iid));
  });

  it('blocks are consecutive laps of the driver', () => {
    const ramp = Array.from({ length: 12 }, (_, i) => i);
    // the median of a resample of ramp is a value or a half-value of it
    for (const m of blockBootstrapMedians(ramp, 99)) expect(Number.isInteger(m * 2)).toBe(true);
  });
});

describe('drivers and team-mates', () => {
  // T0: AAA 1 % faster than BBB; T1: CCC and DDD the same lap times; T2: EEE with 6 laps
  const pace = [-0.9, 0, 0.1, 0.1, 0.2, 0.3];
  const rows = field(CODES, pace, 30, { wobbleOf: (i) => (i === 3 ? 2 : i) })
    .filter((r) => r.Driver !== 'EEE' || r.LapNumber <= 7);
  const res = fieldPace(rows);
  it('median pct, an 80 % interval around it, LOW DATA under 10 laps', () => {
    expect(PACE_LOW_DATA_LAPS).toBe(10);
    const a = res.drivers.AAA;
    expect(a.n).toBe(29);
    expect(a.lo).toBeLessThanOrEqual(a.median + 1e-9);
    expect(a.hi).toBeGreaterThanOrEqual(a.median - 1e-9);
    expect(res.drivers.EEE).toMatchObject({ n: 6, lowData: true });
  });
  it('a clear gap is decisive, a tie is not, a driver under 10 laps makes it low data', () => {
    const t0 = res.teams.find((t) => t.team === 'T0');
    expect(t0.gap).toMatchObject({ faster: 'AAA', slower: 'BBB', verdict: 'decisive' });
    expect(t0.gap.hi).toBeLessThan(0);
    expect(gapLine(t0.gap)).toMatch(/^AAA −\d\.\d\d % \[−\d\.\d\d, −\d\.\d\d\] · decisive$/);
    const t1 = res.teams.find((t) => t.team === 'T1');
    expect(t1.gap.verdict).toBe('not decisive');
    // the interval holds 0 (with identical laps it is often [0, 0])
    expect(t1.gap.lo).toBeLessThanOrEqual(0);
    expect(t1.gap.hi).toBeGreaterThanOrEqual(0);
    expect(res.teams.find((t) => t.team === 'T2').gap.verdict).toBe('low data');
  });
  it('decisive on the interval as printed: a bound that prints 0.00 is not decisive', () => {
    // hi in (-0.005, 0) prints '0.00': the line must not read "[−1.01, 0.00] · decisive"
    expect(gapVerdict(-1.01, -0.003)).toBe('not decisive');
    expect(gapLine({ faster: 'AAA', slower: 'BBB', value: -0.5, lo: -1.01, hi: -0.003, verdict: gapVerdict(-1.01, -0.003) }))
      .toBe('AAA −0.50 % [−1.01, 0.00] · not decisive');
    expect(gapVerdict(0.004, 0.8)).toBe('not decisive');
    expect(gapVerdict(-1.01, -0.006)).toBe('decisive');
    expect(gapVerdict(0.006, 0.8)).toBe('decisive');
    expect(gapVerdict(-0.4, 0.3)).toBe('not decisive');
    expect(gapVerdict(-1.01, -0.5, true)).toBe('low data');
  });
  it('2025 R16 at the leader\'s lap-53 start: Alpine\'s interval prints 0.00 at its end, not decisive', () => {
    const monza25 = demo(2025, 16);
    const now = resolveSessionNow({ currentLap: 53, lapTimes: monza25.lap_times });
    const alpine = fieldPace(monza25.lap_times, { sessionNow: now, trackStatus: monza25.track_status, driverInfo: monza25.driver_info })
      .teams.find((t) => t.team === 'Alpine');
    expect(alpine.gap.hi).toBeLessThan(0);
    expect(alpine.gap.hi).toBeGreaterThan(-0.005);
    expect(gapLine(alpine.gap)).toMatch(/\[−\d\.\d\d, 0\.00\] · not decisive$/);
  });
  it('rows sorted by the team median (pooled laps of both drivers)', () => {
    expect(res.teams.map((t) => t.team)).toEqual(['T0', 'T1', 'T2']);
    expect(pctText(-0.234)).toBe('−0.23 %');
  });
  it('deterministic: the same rows give the same pace', () => {
    expect(fieldPace(rows)).toEqual(res);
  });
});

describe('causality: nothing after sessionNow changes the pace', () => {
  const rows = field(CODES, [-0.4, 0, 0.1, 0.1, 0.2, 0.3], 20);
  for (const now of [T0 + 300, T0 + 905.5, T0 + 1500]) {
    it(`now = ${now}`, () => {
      const status = [{ status: '4', start_time: T0 + 800, end_time: T0 + 1000 }];
      const opts = { sessionNow: now, trackStatus: status };
      expect(fieldPace(perturbFuture(rows, now), opts)).toEqual(fieldPace(rows, opts));
    });
  }
});

describe('demo races (frontend/public/data)', () => {
  it('2024 R16: TSU (4 comparable laps) is low data; every gap reads one of the three verdicts', () => {
    const s = demo(2024, 16);
    const res = fieldPace(s.lap_times, { trackStatus: s.track_status, driverInfo: s.driver_info });
    expect(res.teams).toHaveLength(10);
    expect(res.drivers.TSU).toMatchObject({ n: 4, lowData: true });
    expect(res.teams.find((t) => t.team === 'RB').gap.verdict).toBe('low data');
    for (const t of res.teams) expect(['decisive', 'not decisive', 'low data']).toContain(t.gap.verdict);
    // the team median order: the first row is faster than the last
    expect(res.teams[0].median).toBeLessThan(res.teams[9].median);
  });

  it('2025 R1 (wet): the laps kept on each lap number are of its majority tyre class', () => {
    const s = demo(2025, 1);
    const { laps } = comparableLaps(s.lap_times, { trackStatus: s.track_status });
    const rows = new Map(s.lap_times.map((r) => [`${r.Driver}|${r.LapNumber}`, r]));
    const byLap = new Map();
    for (const e of laps) {
      const cls = tyreClass(rows.get(`${e.driver}|${e.lap}`).Compound);
      if (!byLap.has(e.lap)) byLap.set(e.lap, new Set());
      byLap.get(e.lap).add(cls);
    }
    for (const classes of byLap.values()) expect(classes.size).toBe(1);
    expect([...byLap.values()].some((c) => c.has('wet'))).toBe(true);
    expect([...byLap.values()].some((c) => c.has('dry'))).toBe(true);
    // SAI crashed on lap 1: no comparable lap, no team-mate gap
    const res = fieldPace(s.lap_times, { trackStatus: s.track_status, driverInfo: s.driver_info });
    expect(res.drivers.SAI.n).toBe(0);
    expect(res.teams.find((t) => t.drivers.includes('SAI')).gap).toBe(null);
  });

  it('causal on 2024 R5 at three clocks', () => {
    const s = demo(2024, 5);
    for (const lap of [12, 30, 50]) {
      const now = resolveSessionNow({ currentLap: lap, lapTimes: s.lap_times }) + 29;
      const opts = { sessionNow: now, trackStatus: s.track_status, driverInfo: s.driver_info };
      expect(fieldPace(perturbFuture(s.lap_times, now), opts)).toEqual(fieldPace(s.lap_times, opts));
    }
  });
});
