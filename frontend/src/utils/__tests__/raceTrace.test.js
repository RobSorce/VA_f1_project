// Race Trace (utils/raceTrace.js): every rule of the computation on synthetic
// rows, causality under perturbFuture, and the five tracked demo races
// (frontend/public/data), whose leader-reference trace is the timing's
// -GapToLeader.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  raceStartTime, redFlagSuspensions, suspensionBefore, raceClock, fieldReferenceLaps, raceOrder,
  buildRaceTrace, traceBands, traceStops, wetRace, traceWindow, traceAnswer, referenceText, latestPoint,
  FOCUS_WINDOW, TOP_WINDOW_CARS,
} from '../raceTrace.js';
import { resolveSessionNow, isLapCompleted } from '../raceTime.js';
import { perturbFuture } from './futureRows.js';
import { leaderGapCheck } from '../../../scripts/race_trace_check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../../public/data');
export const DEMO_RACES = [[2024, 16], [2024, 5], [2024, 7], [2025, 16], [2025, 1]];
const demo = (year, round) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, `${year}_${round}_R/session.json.gz`))));

// Synthetic race: car i (0-based) runs every lap in `lapTime[i]` s from the
// common start T0, so its lap k ends at T0 + k * lapTime[i] (+ extra).
const T0 = 1000;
function race(codes, lapTimes, nLaps, { extra = () => ({}) } = {}) {
  const rows = [];
  codes.forEach((d, i) => {
    let t = T0;
    for (let k = 1; k <= nLaps; k++) {
      const dur = typeof lapTimes[i] === 'function' ? lapTimes[i](k) : lapTimes[i];
      const row = {
        Driver: d, LapNumber: k, LapStartTime: t, Time: t + dur, LapTimeSeconds: dur,
        TrackStatus: '1', Compound: 'MEDIUM', Stint: 1, TyreLife: k, PitInTimeSeconds: null, PitOutTimeSeconds: null,
        Position: i + 1,
      };
      Object.assign(row, extra(d, k, row));
      rows.push(row);
      t = row.Time;
    }
  });
  return rows;
}
const at = (trace, d, lap) => trace.drivers.find((x) => x.driver === d)?.points.find((p) => p.lap === lap && !p.start);

describe('race clock', () => {
  it('T0 is the lap-1 LapStartTime the cars share; cum = Time - T0', () => {
    const rows = race(['AAA', 'BBB'], [90, 91], 3);
    expect(raceStartTime(rows)).toBe(T0);
    const clock = raceClock(rows);
    expect(clock.byDriver.get('BBB').get(2).cum).toBeCloseTo(182, 9);
    expect(clock.grid).toBe(2);
    expect(clock.rowsWithoutTime).toBe(0);
  });

  it('builds from Time, never from summed lap times: a row without a lap time keeps the trace', () => {
    const rows = race(['AAA', 'BBB'], [90, 91], 4).map((r) => (r.Driver === 'BBB' && r.LapNumber === 2
      ? { ...r, LapTimeSeconds: null } : r));
    const tr = buildRaceTrace(rows, { reference: 'leader' });
    expect(at(tr, 'BBB', 4).y).toBeCloseTo(-4, 9);
    expect(at(tr, 'BBB', 2).y).toBeCloseTo(-2, 9);
  });

  it('lap 1 uses Time - T0, not LapTimeSeconds (FastF1 lap 1 reads 0.24-0.27 s shorter in the demo races)', () => {
    const rows = race(['AAA', 'BBB', 'CCC'], [90, 90, 90], 2).map((r) => (r.LapNumber === 1
      ? { ...r, LapTimeSeconds: r.LapTimeSeconds - 0.26 } : r));
    const tr = buildRaceTrace(rows);
    for (const d of ['AAA', 'BBB', 'CCC']) expect(at(tr, d, 1).y).toBeCloseTo(0, 9);
  });

  // Red flag at 1250 (cars on lap 3), status until 2000; lap 3 ends in the pit
  // lane (AAA 1290, BBB 1296), lap 4 spans the stop (ends 2100 / 2106), lap 5
  // starts at 2100: the first LapStartTime at or after the status end.
  function redRace() {
    const ends = { AAA: [1100, 1200, 1290, 2100, 2200, 2300], BBB: [1101, 1202, 1296, 2106, 2207, 2309] };
    const rows = [];
    for (const [d, list] of Object.entries(ends)) {
      list.forEach((t, i) => {
        const start = i === 0 ? T0 : list[i - 1];
        rows.push({
          Driver: d, LapNumber: i + 1, LapStartTime: start, Time: t, LapTimeSeconds: t - start,
          TrackStatus: i === 2 || i === 3 ? '15' : '1', Compound: 'MEDIUM', Stint: 1, TyreLife: i + 1,
        });
      });
    }
    const status = [
      { status: '1', start_time: 900, end_time: 1250, message: 'AllClear' },
      { status: '5', start_time: 1250, end_time: 2000, message: 'Red' },
      { status: '1', start_time: 2000, end_time: null, message: 'AllClear' },
    ];
    return { rows, status };
  }

  it('red flag: the window runs from the red start to the first lap start after the status ends', () => {
    const { rows, status } = redRace();
    expect(redFlagSuspensions(status, rows)).toEqual([{ start: 1250, restart: 2100 }]);
    expect(suspensionBefore(1200, [{ start: 1250, restart: 2100 }])).toBe(0);
    expect(suspensionBefore(1290, [{ start: 1250, restart: 2100 }])).toBe(40);
    expect(suspensionBefore(2200, [{ start: 1250, restart: 2100 }])).toBe(850);
    const clock = raceClock(rows, { trackStatus: status });
    expect(clock.byDriver.get('AAA').get(5).cum).toBeCloseTo(2200 - T0 - 850, 9);
    // after the restart the gap is the real one: BBB 6 s behind on lap 4, 7 s on lap 5
    const tr = buildRaceTrace(rows, { trackStatus: status, reference: 'leader' });
    expect(at(tr, 'BBB', 4).y).toBeCloseTo(-6, 9);
    expect(at(tr, 'BBB', 5).y).toBeCloseTo(-7, 9);
    // the field reference does not jump by the suspension
    const field = buildRaceTrace(rows, { trackStatus: status });
    const m = fieldReferenceLaps(raceClock(rows, { trackStatus: status }));
    expect(m.every((l) => l.median < 120)).toBe(true);
    expect(Math.abs(at(field, 'AAA', 5).y - at(field, 'AAA', 2).y)).toBeLessThan(10);
  });

  it('red flag, causally: while the status runs the window has no end yet, and nothing later is read', () => {
    const { rows, status } = redRace();
    const now = 1500;
    expect(redFlagSuspensions(status, rows, now)).toEqual([{ start: 1250, restart: null }]);
    const a = raceClock(rows, { trackStatus: status, sessionNow: now });
    expect(a.byDriver.get('AAA').get(3).cum).toBeCloseTo(1290 - T0 - 40, 9);
    // the status ended but no lap has started since: still open
    expect(redFlagSuspensions(status, rows, 2050)).toEqual([{ start: 1250, restart: null }]);
    expect(redFlagSuspensions(status, rows, 2100)).toEqual([{ start: 1250, restart: 2100 }]);
  });
});

describe('field reference', () => {
  it('m_j = the median race-clock lap of the cars without a pit-in or pit-out on that lap', () => {
    const rows = race(['AAA', 'BBB', 'CCC', 'DDD'], [90, 91, 92, 93], 4, {
      extra: (d, k, r) => (d === 'DDD' && k === 2 ? { PitInTimeSeconds: r.Time - 3, LapTimeSeconds: 120, Time: r.Time + 27 } : {}),
    });
    // DDD's later laps shift by the 27 s of its in-lap
    const fixed = rows.map((r) => (r.Driver === 'DDD' && r.LapNumber > 2 ? { ...r, Time: r.Time + 27, LapStartTime: r.LapStartTime + 27 } : r));
    const m = fieldReferenceLaps(raceClock(fixed));
    expect(m[1]).toMatchObject({ lap: 2, final: true, nonPit: true, cars: 3 });
    expect(m[1].median).toBeCloseTo(91, 9);
    const tr = buildRaceTrace(fixed);
    // AAA: 90 s laps against a 91.5 then 91 s median car
    expect(at(tr, 'AAA', 1).y).toBeCloseTo(91.5 - 90, 9);
    expect(at(tr, 'AAA', 2).y).toBeCloseTo(91.5 + 91 - 180, 9);
  });

  it('when fewer than half the cars have a non-pit lap, every car\'s lap counts', () => {
    const rows = race(['AAA', 'BBB', 'CCC', 'DDD', 'EEE'], [90, 90, 90, 90, 90], 3, {
      extra: (d, k) => (k === 2 && d !== 'AAA' && d !== 'BBB' ? { PitOutTimeSeconds: 1, PitOutTime: 1 } : {}),
    });
    const m = fieldReferenceLaps(raceClock(rows));
    expect(m[1]).toMatchObject({ nonPit: false, cars: 5 });
  });

  it('a lap is provisional until half the running cars completed it; meanwhile m_k = m_(k-1)', () => {
    // lap 2 ends: AAA 1180, BBB 1182, CCC 1184, DDD 1186; lap 3 ends: BBB
    // 1273, CCC 1276, DDD 1279, AAA 1300 (a slow 120 s lap)
    const rows = race(['AAA', 'BBB', 'CCC', 'DDD'], [(k) => (k === 3 ? 120 : 90), 91, 92, 93], 3);
    // one crossing of the 4 cars running: provisional, its median carried
    const early = buildRaceTrace(rows, { sessionNow: 1273.5 });
    expect(early.laps[2]).toMatchObject({ final: false, carried: true, crossed: 1 });
    expect(early.laps[2].median).toBe(early.laps[1].median);
    expect(at(early, 'BBB', 3).provisional).toBe(true);
    expect(at(early, 'BBB', 2).provisional).toBe(false);
    // two of four: final, the median of the laps completed so far
    const half = buildRaceTrace(rows, { sessionNow: 1276.5 });
    expect(half.laps[2]).toMatchObject({ final: true, carried: false, cars: 2 });
    expect(half.laps[2].median).toBeCloseTo((91 + 92) / 2, 9);
    expect(at(half, 'BBB', 3).provisional).toBe(false);
    // a final median keeps following the cars that complete the lap later
    expect(buildRaceTrace(rows).laps[2].median).toBeCloseTo((92 + 93) / 2, 9);
  });

  it('once final a lap stays final, even when lapped cars join the running count', () => {
    // lap 4 ends: AAA 1360, BBB 1362, CCC 1380, DDD 1382, EEE 1460, FFF 1464;
    // lap 5 ends: AAA 1450, BBB 1452.5, CCC 1475, DDD 1477.5
    const rows = race(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'], [90, 90.5, 95, 95.5, 115, 116], 5);
    // at 1453: 2 of the 4 cars across lap 4 completed lap 5: final
    expect(buildRaceTrace(rows, { sessionNow: 1453 }).laps[4].final).toBe(true);
    // at 1465 six cars are across lap 4 and still two across lap 5 (2 < 0.5 x 6): it stays final
    const later = buildRaceTrace(rows, { sessionNow: 1465 });
    expect(later.laps[3].crossed).toBe(6);
    expect(later.laps[4].crossed).toBe(2);
    expect(later.laps[4].final).toBe(true);
    // a lap never final is provisional: lap 5 at 1450.5 (1 of 4)
    expect(buildRaceTrace(rows, { sessionNow: 1450.5 }).laps[4].final).toBe(false);
  });

  it('a retiring car\'s truncated row (no Position, no lap time) is not a crossing', () => {
    const rows = race(['AAA', 'BBB', 'CCC'], [90, 91, 92], 3).map((r) => (r.Driver === 'CCC' && r.LapNumber === 3
      ? { ...r, Time: 1200, Position: null, LapTimeSeconds: null } : r));
    const tr = buildRaceTrace(rows, { reference: 'leader' });
    expect(tr.truncatedRows).toBe(1);
    expect(at(tr, 'CCC', 3)).toBeUndefined();
    expect(at(tr, 'AAA', 3).y).toBeCloseTo(0, 9);
  });
});

describe('the three references', () => {
  const rows = race(['AAA', 'BBB', 'CCC'], [90, 91, 89.5], 4);
  it('leader: y = -(Time - the first car across the lap)', () => {
    const tr = buildRaceTrace(rows, { reference: 'leader' });
    expect(tr.reference).toBe('leader');
    expect(at(tr, 'CCC', 4).y).toBeCloseTo(0, 9);
    expect(at(tr, 'AAA', 4).y).toBeCloseTo(-2, 9);
    expect(at(tr, 'BBB', 4).y).toBeCloseTo(-6, 9);
  });
  it('focus: y = Time of the focus car - Time of the car', () => {
    const tr = buildRaceTrace(rows, { reference: 'focus', focusDriver: 'AAA' });
    expect(tr.reference).toBe('focus');
    expect(at(tr, 'AAA', 3).y).toBeCloseTo(0, 9);
    expect(at(tr, 'BBB', 3).y).toBeCloseTo(-3, 9);
    expect(at(tr, 'CCC', 3).y).toBeCloseTo(1.5, 9);
  });
  it('focus without a focus car falls back to the field reference', () => {
    const tr = buildRaceTrace(rows, { reference: 'focus', focusDriver: null });
    expect(tr).toMatchObject({ reference: 'field', asked: 'focus' });
  });
  it('field: y = sum of the median laps - cum; up = ahead', () => {
    const tr = buildRaceTrace(rows);
    expect(at(tr, 'AAA', 4).y).toBeCloseTo(0, 9);
    expect(at(tr, 'CCC', 4).y).toBeCloseTo(2, 9);
    expect(at(tr, 'BBB', 4).y).toBeCloseTo(-4, 9);
    // every trace starts at the common start
    expect(tr.drivers.every((d) => d.points[0].start && d.points[0].y === 0)).toBe(true);
  });
});

describe('race order, lapped cars, answer and window', () => {
  const rows = race(['AAA', 'BBB', 'CCC'], [90, 91, 140], 6).filter((r) => r.Driver !== 'CCC' || r.LapNumber <= 4);
  const tr = buildRaceTrace(rows, { reference: 'leader' });
  it('orders by laps completed, then crossing time; a car crossed by the leader reads laps down', () => {
    const order = raceOrder(raceClock(rows));
    expect(order.map((o) => o.driver)).toEqual(['AAA', 'BBB', 'CCC']);
    // CCC finished lap 4 at 1560: AAA had done lap 6 (1540), so two laps down
    expect(order.find((o) => o.driver === 'CCC').lapsDown).toBe(2);
    expect(order.find((o) => o.driver === 'BBB').lapsDown).toBe(0);
  });
  it('answer line', () => {
    expect(traceAnswer(tr, 'BBB')).toBe('BBB −6.0 s behind the leader at L6, P2');
    expect(traceAnswer(tr, 'AAA')).toBe('AAA leads at L6, P1');
    const field = buildRaceTrace(rows, { focusDriver: 'AAA' });
    expect(traceAnswer(field)).toMatch(/^AAA \+\d+\.\d s ahead of the field-median car at L6, P1$/);
    const focus = buildRaceTrace(rows, { reference: 'focus', focusDriver: 'BBB' });
    expect(traceAnswer(focus)).toBe('BBB at L6, P2: AAA +6.0 s ahead');
  });
  it('field reference: the answer on the newest final lap, "(provisional)" only without one', () => {
    // 2024 R5 at currentLap 33: VER's L32 is provisional at +35.3 s (final −7.1 s)
    const china = demo(2024, 5);
    const now = resolveSessionNow({ currentLap: 33, lapTimes: china.lap_times });
    const tr33 = buildRaceTrace(china.lap_times, { trackStatus: china.track_status, sessionNow: now });
    expect(at(tr33, 'VER', 32)).toMatchObject({ provisional: true });
    expect(at(tr33, 'VER', 32).y).toBeCloseTo(35.3, 1);
    expect(traceAnswer(tr33, 'VER')).toBe('VER −9.6 s behind the field-median car at L31, P1');
    // one car of four across lap 1: no final lap yet
    const four = race(['AAA', 'BBB', 'CCC', 'DDD'], [90, 91, 92, 93], 3);
    const early = buildRaceTrace(four, { sessionNow: T0 + 90.5 });
    expect(traceAnswer(early, 'AAA')).toBe('AAA 0.0 s ahead of the field-median car at L1, P1 (provisional)');
  });
  it('focus reference, a subject that is not the reference car: the gaps from the subject', () => {
    // the y values are relative to the reference (BBB, y = 0), not to the subject
    const focus = buildRaceTrace(rows, { reference: 'focus', focusDriver: 'BBB' });
    expect(traceAnswer(focus, 'AAA')).toBe('AAA at L6, P1: BBB −6.0 s behind');
    const four = race(['AAA', 'BBB', 'CCC', 'DDD'], [90, 91, 92, 93], 6);
    const ref = buildRaceTrace(four, { reference: 'focus', focusDriver: 'AAA' });
    // CCC is 12 s behind AAA: BBB 6 s ahead of it, DDD 6 s behind
    expect(traceAnswer(ref, 'CCC')).toBe('CCC at L6, P3: BBB +6.0 s ahead, DDD −6.0 s behind');
    expect(traceAnswer(ref, 'DDD')).toBe('DDD at L6, P4: CCC +6.0 s ahead');
  });
  it('windows: top, focus +- max(20 s, pit loss + 5 s), all; outside cars counted by side', () => {
    const top = traceWindow(tr, { window: 'top' });
    expect(top.mode).toBe('top');
    // the top window spans the lead-lap cars: CCC, two laps down, is below it
    expect(top.below).toEqual(['CCC']);
    const focus = traceWindow(tr, { window: 'focus', focusDriver: 'BBB', pitLoss: 22 });
    expect(focus.hi - focus.lo).toBeCloseTo(2 * Math.max(FOCUS_WINDOW.minS, 22 + FOCUS_WINDOW.pitMarginS), 9);
    expect(traceWindow(tr, { window: 'focus', focusDriver: 'BBB', pitLoss: 10 }).hi - latestPoint(tr.drivers[1]).y)
      .toBeCloseTo(FOCUS_WINDOW.minS, 9);
    expect(traceWindow(tr, { window: 'focus', focusDriver: null }).mode).toBe('top');
    const all = traceWindow(tr, { window: 'all' });
    expect(all.lo).toBeLessThan(latestPoint(tr.drivers[2]).y);
    expect(all.above).toEqual([]);
    expect(all.below).toEqual([]);
    expect(TOP_WINDOW_CARS).toBe(10);
  });
  it('top window of lapped cars: the lapped car is counted below it', () => {
    const wide = race(['AAA', 'BBB', 'CCC'], [90, 91, 200], 6).filter((r) => r.Driver !== 'CCC' || r.LapNumber <= 2);
    const t = buildRaceTrace(wide, { reference: 'leader' });
    const w = traceWindow(t, { window: 'top' });
    expect(t.drivers.find((d) => d.driver === 'CCC').lapsDown).toBeGreaterThan(0);
    expect(w.below).toEqual(['CCC']);
  });
});

describe('scripts/race_trace_check.mjs: the leader gap, overall and outside the red-flag windows', () => {
  // AAA laps in 90 s, BBB in 91 s; a red flag from 1451 s to 1460 s falls
  // between their lap-5 crossings (1450 s, 1455 s): the race clock is frozen
  // from 1451 s to the restart (AAA's lap 7 start, 1540 s), the timing's gap is not
  const rows = race(['AAA', 'BBB'], [90, 91], 8).map((r) => ({ ...r, GapToLeader: r.Driver === 'AAA' ? 0 : r.LapNumber }));
  const red = [{ status: '5', start_time: 1451, end_time: 1460 }];
  it('every row: the lap-5 row across the window differs by the 4 s frozen; outside it: none', () => {
    const c = leaderGapCheck(rows, red);
    expect(c.leader.suspensions).toEqual([{ start: 1451, restart: 1540 }]);
    expect(c.all.max).toBeCloseTo(4, 9);
    expect(c.all.at).toBe('BBB L5');
    expect(c.redRows).toBe(1);
    expect(c.outside.rows).toBe(c.all.rows - 1);
    expect(c.outside.max).toBeLessThan(1e-9);
  });
  it('no red flag: both checks are the same', () => {
    const c = leaderGapCheck(rows, []);
    expect(c.redRows).toBe(0);
    expect(c.outside).toEqual(c.all);
  });
});

describe('bands, stops, wet race', () => {
  const rows = race(['AAA', 'BBB'], [100, 101], 8);
  // AAA laps end 1100, 1200, ..., 1800
  const status = [
    { status: '1', start_time: 900, end_time: 1250 },
    { status: '6', start_time: 1250, end_time: 1340 },
    { status: '7', start_time: 1340, end_time: 1360 },
    { status: '1', start_time: 1360, end_time: 1520 },
    { status: '4', start_time: 1520, end_time: 1730 },
    { status: '1', start_time: 1730, end_time: null },
  ];
  it('SC and VSC episodes on the leader\'s laps; VSC deployed + ending is one episode', () => {
    const b = traceBands(status, rows);
    expect(b.map((x) => `${x.kind} ${x.startLap}-${x.endLap} ${x.ongoing}`)).toEqual(['VSC 3-4 false', 'SC 6-8 false']);
  });
  it('causal: a period not started is absent, a running one ends at the leader\'s lap now', () => {
    expect(traceBands(status, rows, 1300).map((x) => x.kind)).toEqual(['VSC']);
    const running = traceBands(status, rows, 1650);
    expect(running[1]).toMatchObject({ kind: 'SC', startLap: 6, endLap: 7, ongoing: true });
  });
  it('red flag band', () => {
    const red = [{ status: '5', start_time: 1450, end_time: 1490 }];
    expect(traceBands(red, rows)).toMatchObject([{ kind: 'RED', startLap: 5, endLap: 5 }]);
  });
  it('stops at the out-lap with the new compound; a pit visit without a tyre change is a "P"', () => {
    const withStops = rows.map((r) => {
      if (r.Driver === 'AAA' && r.LapNumber === 3) return { ...r, PitInTimeSeconds: r.Time - 5 };
      if (r.Driver === 'AAA' && r.LapNumber >= 4) {
        return {
          ...r, Compound: 'HARD', Stint: 2, TyreLife: r.LapNumber - 3, ...(r.LapNumber === 4 ? { PitOutTimeSeconds: r.LapStartTime + 20 } : {}),
        };
      }
      if (r.Driver === 'BBB' && r.LapNumber === 5) return { ...r, PitInTimeSeconds: r.Time - 5 };
      if (r.Driver === 'BBB' && r.LapNumber === 6) return { ...r, PitOutTimeSeconds: r.LapStartTime + 20, Stint: 2 };
      return r;
    });
    const s = traceStops(withStops);
    expect(s).toEqual([
      { driver: 'AAA', kind: 'stop', inLap: 3, lap: 4, compound: 'HARD', fromCompound: 'MEDIUM' },
      { driver: 'BBB', kind: 'visit', inLap: 5, lap: 6, compound: null, fromCompound: null },
    ]);
  });
  it('wet: more than 10 % of the completed rows on INTER / WET', () => {
    const wet = rows.map((r) => (r.LapNumber <= 2 ? { ...r, Compound: 'INTERMEDIATE' } : r));
    expect(wetRace(wet)).toMatchObject({ wet: true, share: 0.25 });
    expect(wetRace(rows).wet).toBe(false);
    // causal: at the end of lap 2 every completed row is wet
    expect(wetRace(wet, 1202).share).toBe(1);
  });
});

describe('causality: nothing after sessionNow changes the trace', () => {
  // perturbFuture changes every field of the rows not completed at `now`;
  // here also their Time (kept after now)
  const later = (rows, now) => perturbFuture(rows, now).map((r) => (isLapCompleted(r, now) ? r : { ...r, Time: Math.max(r.Time, now) + 13 }));
  const rows = race(['AAA', 'BBB', 'CCC', 'DDD'], [90, 91, 92, (k) => (k === 4 ? 115 : 93)], 9, {
    extra: (d, k, r) => (d === 'DDD' && k === 4 ? { PitInTimeSeconds: r.Time - 2 } : {}),
  });
  const status = [{ status: '4', start_time: 1400, end_time: 1600 }, { status: '5', start_time: 1700, end_time: 1750 }];
  for (const now of [1150, 1275.5, 1450, 1650, 1720, 1800]) {
    it(`now = ${now}`, () => {
      for (const reference of ['field', 'leader', 'focus']) {
        const opts = { trackStatus: status, sessionNow: now, reference, focusDriver: 'BBB' };
        expect(buildRaceTrace(later(rows, now), opts)).toEqual(buildRaceTrace(rows, opts));
      }
      expect(traceBands(status, later(rows, now), now)).toEqual(traceBands(status, rows, now));
      expect(traceStops(later(rows, now), now)).toEqual(traceStops(rows, now));
      expect(wetRace(later(rows, now), now)).toEqual(wetRace(rows, now));
    });
  }
});

describe('demo races (frontend/public/data)', () => {
  for (const [year, round] of DEMO_RACES) {
    describe(`${year} R${round}`, () => {
      const s = demo(year, round);
      const lt = s.lap_times;
      it('every row has a Time; leader reference = -GapToLeader of the timing on every row', () => {
        const tr = buildRaceTrace(lt, { trackStatus: s.track_status, reference: 'leader' });
        expect(tr.rowsWithoutTime).toBe(0);
        expect(tr.truncatedRows).toBe(lt.filter((r) => r.Position == null && r.LapTimeSeconds == null).length);
        expect(tr.suspensions).toEqual([]); // no red flag in the demo races
        let n = 0;
        let worst = 0;
        for (const r of lt) {
          if (!Number.isFinite(r.GapToLeader)) continue;
          const p = at(tr, r.Driver, r.LapNumber);
          if (!p || r.Position == null) continue;
          worst = Math.max(worst, Math.abs(p.y + r.GapToLeader));
          n += 1;
        }
        expect(n).toBeGreaterThan(800);
        // GapToLeader is rounded to the millisecond
        expect(worst).toBeLessThan(0.0011);
      });
      it('field reference: every lap final at the flag, the order of the trace at the flag is the race order', () => {
        const tr = buildRaceTrace(lt, { trackStatus: s.track_status });
        expect(tr.laps.every((l) => l.final)).toBe(true);
        const finishers = tr.drivers.filter((d) => d.lastLap === tr.lastLap);
        const ys = finishers.map((d) => latestPoint(d).y);
        expect([...ys].sort((a, b) => b - a)).toEqual(ys);
        expect(referenceText(tr)).toMatch(/^reference: field-median lap, \d+ of \d+ cars on L\d+ \(laps without a pit stop\)$/);
      });
      it('causal at four clocks of the lap-indexed replay', () => {
        const maxLap = Math.max(...lt.map((r) => r.LapNumber));
        for (const lap of [2, Math.round(maxLap / 3), Math.round(maxLap / 2) + 1, maxLap - 2]) {
          const now = resolveSessionNow({ currentLap: lap, lapTimes: lt }) + 37;
          const opts = { trackStatus: s.track_status, sessionNow: now, reference: 'field' };
          expect(buildRaceTrace(perturbFuture(lt, now), opts)).toEqual(buildRaceTrace(lt, opts));
        }
      });
    });
  }

  it('only 2025 R1 is a wet race (81 % of its rows on intermediates)', () => {
    const wet = DEMO_RACES.filter(([y, r]) => wetRace(demo(y, r).lap_times).wet);
    expect(wet).toEqual([[2025, 1]]);
  });

  it('2024 R5: the VSC on lap 22 and the safety cars become bands', () => {
    const s = demo(2024, 5);
    const b = traceBands(s.track_status, s.lap_times);
    expect(b[0]).toMatchObject({ kind: 'VSC', startLap: 22 });
    expect(b.filter((x) => x.kind === 'SC').map((x) => x.startLap)).toEqual([23, 27]);
  });
});
