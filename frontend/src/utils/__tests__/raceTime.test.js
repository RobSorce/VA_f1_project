import { describe, it, expect } from 'vitest';
import {
  computeSessionTimeOffset, lapEndTime, lapStartTime, leaderLapEndTime, pitInSeconds, pitOutSeconds,
  hasPitIn, hasPitOut, resolveSessionNow, isLapCompleted, completedLaps, isGreenLap, isPitVisible,
  lapWindows, leaderLapAt, mapTrackStatusToLaps,
} from '../raceTime.js';
import {
  hasCachedSession, loadCachedSession, hasCachedFrames, loadCachedFrames, listCachedRaces,
} from '../../__tests__/helpers/cachedSession.js';

// Synthetic race on the SESSION clock: lap 1 starts at T0, every lap lasts DUR
// seconds, driver i runs i * GAP seconds behind the leader.
const T0 = 1000;
const DUR = 90;
const GAP = 2;

function lap(driver, n, extra = {}) {
  const i = ['AAA', 'BBB', 'CCC'].indexOf(driver);
  const start = T0 + (n - 1) * DUR + (n > 1 ? i * GAP : 0);
  const end = T0 + n * DUR + i * GAP;
  return {
    Driver: driver, LapNumber: n, LapStartTime: start, Time: end, LapTimeSeconds: end - start,
    TrackStatus: '1', Stint: 1, Compound: 'MEDIUM', PitInTimeSeconds: null, PitOutTimeSeconds: null,
    ...extra,
  };
}

function race(laps = 5, drivers = ['AAA', 'BBB', 'CCC']) {
  const rows = [];
  for (const d of drivers) for (let n = 1; n <= laps; n++) rows.push(lap(d, n));
  return rows;
}

describe('computeSessionTimeOffset', () => {
  it('is the smallest positive LapStartTime', () => {
    const rows = race(3);
    rows[4].LapStartTime = 0; // a zero start is ignored, not taken as the minimum
    expect(computeSessionTimeOffset(rows)).toBe(T0);
  });

  it('falls back to min(Time - LapTimeSeconds) when no LapStartTime exists', () => {
    const rows = race(3).map(({ LapStartTime, ...r }) => r);
    expect(computeSessionTimeOffset(rows)).toBe(T0);
  });

  it('returns 0 when nothing usable exists (live rows, empty, not an array)', () => {
    const live = [{ Driver: 'AAA', LapNumber: 3, LapTimeSeconds: 91.2, Time: null, LapStartTime: null }];
    expect(computeSessionTimeOffset(live)).toBe(0);
    expect(computeSessionTimeOffset([])).toBe(0);
    expect(computeSessionTimeOffset(null)).toBe(0);
    expect(computeSessionTimeOffset(undefined)).toBe(0);
  });

  it('accepts numeric strings', () => {
    expect(computeSessionTimeOffset([{ LapStartTime: '1234.5' }, { LapStartTime: '2000' }])).toBe(1234.5);
  });
});

describe('lapEndTime and pit fields', () => {
  it('uses Time, else LapStartTime + LapTimeSeconds, else null', () => {
    expect(lapEndTime({ Time: 1100, LapStartTime: 1000, LapTimeSeconds: 50 })).toBe(1100);
    expect(lapEndTime({ Time: null, LapStartTime: 1000, LapTimeSeconds: 90 })).toBe(1090);
    expect(lapEndTime({ LapTimeSeconds: 90 })).toBeNull();
    expect(lapEndTime(null)).toBeNull();
  });

  it('reads pit times from the *Seconds fields, else from numeric PitInTime/PitOutTime', () => {
    expect(pitInSeconds({ PitInTimeSeconds: 1500, PitInTime: 1499 })).toBe(1500);
    expect(pitInSeconds({ PitInTime: 1499 })).toBe(1499);
    expect(pitInSeconds({ PitInTime: 'not a number' })).toBeNull();
    expect(pitOutSeconds({ PitOutTimeSeconds: 1520 })).toBe(1520);
    expect(pitOutSeconds({})).toBeNull();
    expect(hasPitIn({ PitInTime: 'x' })).toBe(true);
    expect(hasPitIn({ PitInTimeSeconds: null, PitInTime: null })).toBe(false);
    expect(hasPitOut({ PitOutTimeSeconds: 1520 })).toBe(true);
    expect(hasPitOut({})).toBe(false);
  });
});

describe('isLapCompleted / completedLaps', () => {
  const l = lap('AAA', 2); // ends at T0 + 180

  it('a lap is completed once its Time is <= now (inclusive)', () => {
    expect(isLapCompleted(l, T0 + 179.999)).toBe(false);
    expect(isLapCompleted(l, T0 + 180)).toBe(true);
  });

  it('rows without Time use LapStartTime + LapTimeSeconds', () => {
    const noTime = { ...l, Time: null };
    expect(isLapCompleted(noTime, T0 + 179)).toBe(false);
    expect(isLapCompleted(noTime, T0 + 180)).toBe(true);
  });

  it('rows with no clock at all are completed only at Infinity', () => {
    const live = { Driver: 'AAA', LapNumber: 4, LapTimeSeconds: 90 };
    expect(isLapCompleted(live, 1e12)).toBe(false);
    expect(isLapCompleted(live, Infinity)).toBe(true);
  });

  it('undefined / null now means no limit', () => {
    expect(isLapCompleted(l)).toBe(true);
    expect(isLapCompleted(l, null)).toBe(true);
  });

  it('completedLaps keeps only finished rows, in input order', () => {
    const rows = race(3);
    // At the leader's end of lap 2: AAA laps 1-2, BBB/CCC lap 1 only
    const done = completedLaps(rows, T0 + 2 * DUR);
    expect(done.map((r) => `${r.Driver}${r.LapNumber}`)).toEqual(['AAA1', 'AAA2', 'BBB1', 'CCC1']);
    expect(completedLaps(rows, Infinity)).toHaveLength(rows.length);
    expect(completedLaps(rows)).toHaveLength(rows.length);
    expect(completedLaps(null, 5)).toEqual([]);
  });
});

describe('isGreenLap', () => {
  it('only TrackStatus exactly "1" is green', () => {
    expect(isGreenLap({ TrackStatus: '1' })).toBe(true);
    expect(isGreenLap({ TrackStatus: 1 })).toBe(true);
    expect(isGreenLap({ TrackStatus: '12' })).toBe(false); // yellow during the lap
    expect(isGreenLap({ TrackStatus: '4' })).toBe(false);  // SC
    expect(isGreenLap({ TrackStatus: '671' })).toBe(false); // VSC
    expect(isGreenLap({ TrackStatus: null })).toBe(false);
    expect(isGreenLap({})).toBe(false);
  });
});

describe('isPitVisible', () => {
  const inLap = lap('AAA', 3, { PitInTimeSeconds: T0 + 260, PitInTime: T0 + 260 });

  it('is false for a lap without a pit entry', () => {
    expect(isPitVisible(lap('AAA', 3), Infinity)).toBe(false);
  });

  it('becomes true when PitInTime <= now, before the in-lap ends', () => {
    expect(isPitVisible(inLap, T0 + 259.9)).toBe(false);
    expect(isPitVisible(inLap, T0 + 260)).toBe(true);
    expect(isLapCompleted(inLap, T0 + 260)).toBe(false); // in-lap ends at T0 + 270
  });

  it('falls back to lap completion without a numeric pit time', () => {
    const marker = { ...inLap, PitInTimeSeconds: null, PitInTime: 'set' };
    expect(isPitVisible(marker, T0 + 269)).toBe(false);
    expect(isPitVisible(marker, T0 + 270)).toBe(true);
  });

  it('is true at Infinity / undefined', () => {
    expect(isPitVisible(inLap, Infinity)).toBe(true);
    expect(isPitVisible(inLap)).toBe(true);
  });
});

describe('resolveSessionNow', () => {
  const rows = race(5);

  it('live mode is Infinity, whatever the other inputs', () => {
    expect(resolveSessionNow({ isLiveMode: true, replayActive: true, currentTime: 5, currentLap: 1, maxLap: 50 }))
      .toBe(Infinity);
  });

  it('replay mode is currentTime + sessionTimeOffset', () => {
    expect(resolveSessionNow({ replayActive: true, currentTime: 123.4, sessionTimeOffset: T0, currentLap: 2, maxLap: 5 }))
      .toBeCloseTo(T0 + 123.4, 9);
  });

  it('replay mode computes the offset from lapTimes when it is not given', () => {
    expect(resolveSessionNow({ replayActive: true, currentTime: 10, lapTimes: rows })).toBe(T0 + 10);
  });

  it('replay mode returns Infinity on the last frame (currentTime + frameDt > maxTime)', () => {
    const base = { replayActive: true, sessionTimeOffset: T0, maxTime: 450, frameDt: 0.4 };
    expect(resolveSessionNow({ ...base, currentTime: 449.8 })).toBe(Infinity);   // last frame
    expect(resolveSessionNow({ ...base, currentTime: 449.4 })).toBe(T0 + 449.4); // one frame before
    // without maxTime / frameDt the rule is off
    expect(resolveSessionNow({ replayActive: true, sessionTimeOffset: T0, currentTime: 449.8 })).toBe(T0 + 449.8);
  });

  it('replay flag with a non-finite currentTime falls back to lap mode', () => {
    expect(resolveSessionNow({ replayActive: true, currentTime: undefined, currentLap: 1, maxLap: 5, lapTimes: rows }))
      .toBe(T0);
  });

  it('lap mode: the last lap is the leader starting it (R4), beyond it and raceOver are Infinity, currentLap <= 1 is the offset', () => {
    expect(resolveSessionNow({ currentLap: 5, maxLap: 5, lapTimes: rows })).toBe(T0 + 4 * DUR);
    expect(resolveSessionNow({ currentLap: 5, maxLap: 5, lapTimes: rows, raceOver: true })).toBe(Infinity);
    expect(resolveSessionNow({ currentLap: 6, maxLap: 5, lapTimes: rows })).toBe(Infinity);
    // raceOver only applies to the lap clock: replay frames keep their own
    expect(resolveSessionNow({ replayActive: true, currentTime: 10, sessionTimeOffset: T0, raceOver: true }))
      .toBe(T0 + 10);
    // no lap rows (no session): nothing has a clock
    expect(resolveSessionNow({ currentLap: 1, maxLap: 1, lapTimes: [], sessionTimeOffset: 0 })).toBe(Infinity);
    expect(resolveSessionNow({ currentLap: 1, maxLap: 5, lapTimes: rows })).toBe(T0);
    expect(resolveSessionNow({ currentLap: 0, maxLap: 5, sessionTimeOffset: 777, lapTimes: rows })).toBe(777);
  });

  it('lap mode: the race leader starts lap k at min Time of lap k - 1', () => {
    const now = resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: rows, sessionTimeOffset: T0 });
    expect(now).toBe(T0 + 2 * DUR);
    // The leader's laps 1..k-1 are completed, nobody's lap k is
    const done = completedLaps(rows, now);
    expect(done.filter((r) => r.Driver === 'AAA').map((r) => r.LapNumber)).toEqual([1, 2]);
    expect(done.some((r) => r.LapNumber >= 3)).toBe(false);
  });

  it('lap mode: maxLap is derived from lapTimes when omitted', () => {
    expect(resolveSessionNow({ currentLap: 6, lapTimes: rows })).toBe(Infinity);
    expect(resolveSessionNow({ currentLap: 5, lapTimes: rows })).toBe(T0 + 4 * DUR);
    expect(resolveSessionNow({ currentLap: 4, lapTimes: rows })).toBe(T0 + 3 * DUR);
  });

  it('lap mode: without lap k - 1 times it uses min LapStartTime of lap k', () => {
    const noTimes = rows.map((r) => (r.LapNumber === 2 ? { ...r, Time: null } : r));
    expect(resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: noTimes })).toBe(T0 + 2 * DUR);
  });

  it('lap mode: Infinity when the lap has no clock, or currentLap is missing', () => {
    const noClock = rows.map(({ Time, LapStartTime, ...r }) => r);
    expect(resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: noClock })).toBe(Infinity);
    expect(resolveSessionNow({ maxLap: 5, lapTimes: rows })).toBe(Infinity);
    expect(resolveSessionNow()).toBe(Infinity);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('race clock on cached Monza 2024 (R16)', () => {
  const rows = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];

  it('offset is the race start: the shared LapStartTime of lap 1', () => {
    const offset = computeSessionTimeOffset(rows);
    const lap1Starts = new Set(rows.filter((r) => r.LapNumber === 1).map((r) => r.LapStartTime));
    expect(lap1Starts.size).toBe(1);
    expect(offset).toBe([...lap1Starts][0]);
    expect(offset).toBeCloseTo(3350.5, 0);
  });

  it('lap mode at lap 20: only the leader has finished lap 19, nobody lap 20', () => {
    const now = resolveSessionNow({ currentLap: 20, maxLap: 53, lapTimes: rows, sessionTimeOffset: computeSessionTimeOffset(rows) });
    const done = completedLaps(rows, now);
    expect(Math.max(...done.map((r) => r.LapNumber))).toBe(19);
    expect(done.filter((r) => r.LapNumber === 19)).toHaveLength(1);
    expect(done.every((r) => r.Time <= now)).toBe(true);
  });
});

// Evidence for the comment at the top of raceTime.js: replay time + offset is
// session time. At the frame where a driver's lap counter steps from n to n + 1,
// frame.t + offset must match lap n's Time within one frame step.
const FRAME_RACES = [[2024, 16], [2024, 5]].filter(([y, r]) => hasCachedSession(y, r) && hasCachedFrames(y, r));

describe.skipIf(FRAME_RACES.length === 0)('replay clock alignment on cached frames', () => {
  it.each(FRAME_RACES)('%i round %i: frame.t + offset = lap end time within one frame step', (year, round) => {
    const rows = loadCachedSession(year, round).lap_times;
    const { frames } = loadCachedFrames(year, round);
    const offset = computeSessionTimeOffset(rows);
    const step = frames[1].t - frames[0].t;
    const end = new Map(rows.map((r) => [`${r.Driver}|${r.LapNumber}`, r.Time]));
    const errs = [];
    const prev = {};
    for (const f of frames) {
      for (const [drv, d] of Object.entries(f.drivers)) {
        const p = prev[drv];
        const t = end.get(`${drv}|${p}`);
        if (p != null && d.lap === p + 1 && t != null) errs.push(f.t + offset - t);
        prev[drv] = d.lap;
      }
    }
    errs.sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)];
    const p95 = errs[Math.floor(errs.length * 0.95)];
    expect(errs.length).toBeGreaterThan(rows.length * 0.8);
    expect(Math.abs(med)).toBeLessThan(step);
    expect(Math.abs(p95)).toBeLessThan(step);
  });

  it.each(FRAME_RACES)('%i round %i: at a mid-race frame each car has completed (frame lap - 1) laps, +/- 1', (year, round) => {
    const rows = loadCachedSession(year, round).lap_times;
    const { frames } = loadCachedFrames(year, round);
    const offset = computeSessionTimeOffset(rows);
    const f = frames[Math.floor(frames.length / 2)];
    const now = resolveSessionNow({ replayActive: true, currentTime: f.t, sessionTimeOffset: offset });
    const done = completedLaps(rows, now);
    let exact = 0;
    const drivers = Object.keys(f.drivers).filter((d) => rows.some((r) => r.Driver === d));
    for (const drv of drivers) {
      const n = done.filter((r) => r.Driver === drv).length;
      expect(Math.abs(n - (f.drivers[drv].lap - 1))).toBeLessThanOrEqual(1);
      if (n === f.drivers[drv].lap - 1) exact += 1;
    }
    expect(exact / drivers.length).toBeGreaterThanOrEqual(0.8);
  });
});

describe('lapStartTime / leaderLapEndTime', () => {
  it('lapStartTime: LapStartTime when > 0, else Time - LapTimeSeconds, else null', () => {
    expect(lapStartTime({ LapStartTime: 1000, Time: 1100, LapTimeSeconds: 90 })).toBe(1000);
    expect(lapStartTime({ LapStartTime: 0, Time: 1100, LapTimeSeconds: 90 })).toBe(1010);
    expect(lapStartTime({ LapStartTime: null, Time: '1100', LapTimeSeconds: '90' })).toBe(1010);
    expect(lapStartTime({ Time: 1100 })).toBeNull();
    expect(lapStartTime(null)).toBeNull();
  });

  it('leaderLapEndTime: the Position-1 row, never a truncated row without a Position', () => {
    const rows = [
      { LapNumber: 4, Time: 1300, Position: 2 },
      { LapNumber: 4, Time: 1310, Position: 1 },
      { LapNumber: 4, Time: 1250, Position: null }, // retiring car, ends early
      { LapNumber: 5, Time: 1420, Position: 3 },
      { LapNumber: 5, Time: 1400, Position: null },
      { LapNumber: 6, Time: 1500, Position: null },
      { LapNumber: 6, Time: 1490 },
    ];
    expect(leaderLapEndTime(rows, 4)).toBe(1310);
    expect(leaderLapEndTime(rows, 5)).toBe(1420); // no P1 row: earliest classified row
    expect(leaderLapEndTime(rows, 6)).toBe(1490); // nobody classified: earliest Time
    expect(leaderLapEndTime(rows, 7)).toBeNull();
    expect(leaderLapEndTime(null, 4)).toBeNull();
  });
});

describe('resolveSessionNow lap mode: the race leader\'s clock (R4)', () => {
  // AAA leads; DDD retires on lap 2 with a truncated row that ends first
  const rows = race(5).map((r) => ({ ...r, Position: ['AAA', 'BBB', 'CCC'].indexOf(r.Driver) + 1 }));
  const withRetirement = [
    ...rows,
    { Driver: 'DDD', LapNumber: 1, LapStartTime: T0, Time: T0 + DUR + 6, LapTimeSeconds: DUR + 6, Position: 4 },
    { Driver: 'DDD', LapNumber: 2, LapStartTime: T0 + DUR + 6, Time: T0 + 2 * DUR - 30, LapTimeSeconds: DUR - 36, Position: null },
  ];

  it('now at lap L = Time of the Position-1 row of lap L - 1, not a retiring car\'s row', () => {
    expect(resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: withRetirement })).toBe(T0 + 2 * DUR);
  });

  it('follows the leader when the lead changes', () => {
    const swapped = rows.map((r) => {
      if (r.LapNumber !== 2) return r;
      if (r.Driver === 'BBB') return { ...r, Position: 1 };
      if (r.Driver === 'AAA') return { ...r, Position: 2 };
      return r;
    });
    expect(resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: swapped })).toBe(T0 + 2 * DUR + GAP);
  });

  it('without a Position-1 row: earliest classified row, then earliest Time', () => {
    const noLeader = withRetirement.map((r) => (r.Position === 1 ? { ...r, Position: null } : r));
    // AAA is now unclassified on every lap: BBB (P2) is the earliest classified row of lap 2
    expect(resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: noLeader })).toBe(T0 + 2 * DUR + GAP);
    const bare = withRetirement.map(({ Position, ...r }) => r);
    expect(resolveSessionNow({ currentLap: 3, maxLap: 5, lapTimes: bare })).toBe(T0 + 2 * DUR - 30);
  });
});

describe.skipIf(!hasCachedSession(2024, 5))('lap-mode clock on cached China 2024 (R5)', () => {
  const rows = hasCachedSession(2024, 5) ? loadCachedSession(2024, 5).lap_times : [];

  it('lap 28 starts when VER (P1) ends lap 27 (6304.279 s), not at TSU\'s truncated lap 27 (6257.294 s)', () => {
    const now = resolveSessionNow({ currentLap: 28, lapTimes: rows });
    expect(now).toBeCloseTo(6304.279, 6);
    const tsu = rows.find((r) => r.Driver === 'TSU' && r.LapNumber === 27);
    expect(tsu.Position).toBeNull();
    expect(tsu.Time).toBeLessThan(now);
  });
});

const ALL_RACES = listCachedRaces();

describe.skipIf(ALL_RACES.length === 0)('lap-mode clock = the leader\'s lap end on every cached race (R4)', () => {
  it.each(ALL_RACES.map((r) => [r.year, r.round]))('%i round %i', (year, round) => {
    const rows = loadCachedSession(year, round).lap_times;
    const maxLap = Math.max(...rows.map((r) => r.LapNumber));
    for (let lap = 2; lap < maxLap; lap++) {
      const leader = rows.find((r) => r.LapNumber === lap - 1 && r.Position === 1);
      expect(resolveSessionNow({ currentLap: lap, lapTimes: rows }), `lap ${lap}`).toBe(leader.Time);
    }
  });
});

// ---------------------------------------------------------------------------
// Track status -> leader lap (R5): same rule as the backend
// ---------------------------------------------------------------------------

function rowsTwoCars() {
  // leader A: laps of 100 s from t = 1000; B one lap behind from lap 3 on
  const out = [];
  for (let n = 1; n <= 5; n++) {
    out.push({ Driver: 'A', LapNumber: n, LapStartTime: 1000 + 100 * (n - 1), Time: 1000 + 100 * n, LapTimeSeconds: 100, Position: 1 });
  }
  for (let n = 1; n <= 4; n++) {
    const start = 1000 + 125 * (n - 1);
    out.push({ Driver: 'B', LapNumber: n, LapStartTime: start, Time: start + 125, LapTimeSeconds: 125, Position: 2 });
  }
  return out;
}

/** Laps whose LEADER (Position 1) TrackStatus carries the code. */
function leaderLapsWith(lapTimes, code) {
  return new Set(lapTimes.filter((r) => r.Position === 1 && String(r.TrackStatus ?? '').includes(code))
    .map((r) => Number(r.LapNumber)));
}

function mappedLaps(mapped, code) {
  const out = new Set();
  for (const p of mapped) {
    if (String(p.status) !== code) continue;
    for (let l = p.start_lap; l <= p.end_lap; l++) out.add(l);
  }
  return out;
}

const symDiff = (a, b) => [...new Set([...a, ...b])].filter((x) => a.has(x) !== b.has(x)).sort((x, y) => x - y);

// Known differences with the Position-1 TrackStatus, explained by the data
// (same list as backend/tests/test_track_status_laps.py):
//  - 2024 R21 '7' lap 29: RUS, leading on the road, has started lap 29 when the
//    VSC ends; the row classified P1 on lap 29 (OCO) starts after it ended;
//  - 2024 R8 '4' lap 1: at the red-flag restart the lap-1 rows end after the
//    lap-2 rows start.
const KNOWN_DIFFERENCES = { '2024_21_7': [29], '2024_8_4': [1] };

describe('mapTrackStatusToLaps (synthetic)', () => {
  it('lapWindows falls back to Time - LapTimeSeconds and skips unusable rows', () => {
    expect(lapWindows([
      { LapNumber: 1, LapStartTime: null, Time: 1100, LapTimeSeconds: 100 },
      { LapNumber: 2.0, LapStartTime: 1100, Time: 1200, LapTimeSeconds: 100 },
      { LapNumber: 3, LapStartTime: 1300, Time: 1200 },
      { LapNumber: null, LapStartTime: 1, Time: 2 },
      null,
    ])).toEqual([[1, 1000, 1100], [2, 1100, 1200]]);
  });

  it('leaderLapAt: the highest lap whose window contains t', () => {
    const w = lapWindows(rowsTwoCars());
    // t = 1310: A (leader) on lap 4 (1300-1400), B on its lap 3 (1250-1375)
    expect(leaderLapAt(w, 1310)).toBe(4);
    expect(leaderLapAt(w, 1000)).toBe(1);
    expect(leaderLapAt(w, 999)).toBeNull();
    expect(leaderLapAt([[1, 0, 10], [3, 20, 30]], 15)).toBe(1); // gap: highest lap started
  });

  it('start and end go to the leader\'s lap; periods outside the race are dropped', () => {
    const ts = [
      { status: '2', start_time: 0, end_time: 500, message: 'Yellow' },
      { status: '1', start_time: 500, end_time: 1310, message: 'AllClear' },
      { status: '4', start_time: 1310, end_time: 1420, message: 'SCDeployed' },
      { status: '1', start_time: 1420, end_time: 1600, message: 'AllClear' },
      { status: '2', start_time: 1600, end_time: null, message: 'Yellow' },
    ];
    const out = mapTrackStatusToLaps(ts, rowsTwoCars());
    expect(out.map((p) => [p.status, p.start_lap, p.end_lap])).toEqual([['1', 1, 4], ['4', 4, 5], ['1', 5, 5]]);
    expect(out[1]).toEqual({ ...ts[2], start_lap: 4, end_lap: 5 });
    expect(mapTrackStatusToLaps(ts, [])).toEqual([]);
    expect(mapTrackStatusToLaps(null, rowsTwoCars())).toEqual([]);
  });

  it('a period without an end lasts to the last lap', () => {
    const out = mapTrackStatusToLaps([{ status: '4', start_time: 1150, end_time: null }], rowsTwoCars());
    expect([out[0].start_lap, out[0].end_lap]).toEqual([2, 5]);
  });
});

describe.skipIf(!hasCachedSession(2024, 5))('mapTrackStatusToLaps on cached China 2024', () => {
  const s = hasCachedSession(2024, 5) ? loadCachedSession(2024, 5) : null;

  it('VSC deployed on lap 22, SC on laps 23 and 27 (FIA race control); leader TrackStatus laps', () => {
    const out = mapTrackStatusToLaps(s.track_status, s.lap_times);
    const sc = out.filter((p) => p.status === '4');
    const vsc = out.filter((p) => p.status === '6' || p.status === '7');
    expect(vsc.map((p) => [p.start_lap, p.end_lap])).toEqual([[22, 23]]);
    expect(sc.map((p) => [p.start_lap, p.end_lap])).toEqual([[23, 26], [27, 31]]);
    expect([...mappedLaps(out, '6')].sort((a, b) => a - b)).toEqual([22, 23]);
    expect(symDiff(mappedLaps(out, '4'), leaderLapsWith(s.lap_times, '4'))).toEqual([]);
    expect(out.every((p) => p.start_time > 0)).toBe(true); // the pre-race yellow is dropped
  });
});

describe.skipIf(ALL_RACES.length === 0)('mapTrackStatusToLaps = leader TrackStatus laps on every cached race', () => {
  it.each(ALL_RACES.map((r) => [r.year, r.round]))('%i round %i', (year, round) => {
    const s = loadCachedSession(year, round);
    const out = mapTrackStatusToLaps(s.track_status, s.lap_times);
    for (const code of ['2', '4', '5', '6', '7']) {
      const diff = symDiff(mappedLaps(out, code), leaderLapsWith(s.lap_times, code));
      expect(diff, code).toEqual(KNOWN_DIFFERENCES[`${year}_${round}_${code}`] || []);
    }
  });
});
