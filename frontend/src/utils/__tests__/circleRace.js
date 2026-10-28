// Test helper (not a test file): synthetic races on the SESSION clock for the
// Circle of Doom modules (circlePitLane, circleSectors, circleGapList).
// Car `code` starts lap 1 at T0 and loses `offset` s on lap 1, then runs 90 s
// laps unless durations[k] says otherwise. Each lap's sectors are 30 / 33 / 27 s
// scaled to its length, with their end times; lap 1 has no sector-1 time, as
// in FastF1.
export const T0 = 1000;
export const LAP = 90;
export const SECTORS = [30, 33, 27];

export function car(code, {
  offset = 0, laps = 10, durations = {}, extra = {},
} = {}) {
  const rows = [];
  let start = T0;
  for (let k = 1; k <= laps; k++) {
    const dur = durations[k] ?? (k === 1 ? LAP + offset : LAP);
    const [s1, s2, s3] = SECTORS.map((s) => (s * dur) / LAP);
    rows.push({
      Driver: code,
      LapNumber: k,
      LapStartTime: start,
      Time: start + dur,
      LapTimeSeconds: dur,
      TrackStatus: '1',
      PitInTimeSeconds: null,
      PitOutTimeSeconds: null,
      Stint: 1,
      Compound: 'MEDIUM',
      TyreLife: k,
      Sector1Time: k === 1 ? null : s1,
      Sector2Time: s2,
      Sector3Time: s3,
      Sector1SessionTime: k === 1 ? null : start + s1,
      Sector2SessionTime: start + s1 + s2,
      Sector3SessionTime: start + dur,
      ...(extra[k] ? extra[k](start, start + dur) : {}),
    });
    start += dur;
  }
  return rows;
}

/**
 * Options of car() for a stop: pit entry `entry` s before the end of in-lap n,
 * pit exit `exit` s into out-lap n + 1 (lane time entry + exit), in-lap and
 * out-lap times; `inLapStatus` is the in-lap's TrackStatus.
 */
export function stop(n, {
  entry = 10, exit = 12, inLap = 95, outLap = 107, inLapStatus = '1',
} = {}) {
  return {
    durations: { [n]: inLap, [n + 1]: outLap },
    extra: {
      [n]: (s, e) => ({ PitInTimeSeconds: e - entry, TrackStatus: inLapStatus }),
      [n + 1]: (s) => ({ PitOutTimeSeconds: s + exit }),
    },
  };
}

/** Position of every row = order of the Times on its lap. */
export function withPositions(rows) {
  const byLap = new Map();
  for (const r of rows) {
    if (!byLap.has(r.LapNumber)) byLap.set(r.LapNumber, []);
    byLap.get(r.LapNumber).push(r);
  }
  for (const list of byLap.values()) list.sort((a, b) => a.Time - b.Time).forEach((r, i) => { r.Position = i + 1; });
  return rows;
}
