// Test helper (not a test file): change everything a lap row holds that is NOT
// known at session time `now`, so a causal function must give the same output
// on the perturbed rows.
//
// Known at `now` (R3, R6): every field of a completed row; on a lap in
// progress, its start, a pit entry or a pit exit already passed, and the tyre
// fields (Compound, Stint, TyreLife) of a row that opened a visible stint (its
// pit exit has passed, or it is the driver's first lap: the set on the grid).
// Fabricated pit times are put after `now`, so nothing in the past changes.
import {
  isLapCompleted, lapStartTime, pitInSeconds, pitOutSeconds,
} from '../raceTime.js';

export function perturbFuture(lapTimes, now) {
  const firstLap = new Map();
  for (const lt of lapTimes) {
    const n = Number(lt.LapNumber);
    if (!firstLap.has(lt.Driver) || n < firstLap.get(lt.Driver)) firstLap.set(lt.Driver, n);
  }
  return lapTimes.map((lt) => {
    if (isLapCompleted(lt, now)) return lt;
    const start = lapStartTime(lt);
    const started = start != null && start <= now;
    const pitIn = pitInSeconds(lt);
    const pitOut = pitOutSeconds(lt);
    const later = Math.max(now + 1, Number(lt.Time) || 0);
    const out = {
      ...lt,
      LapTimeSeconds: (lt.LapTimeSeconds || 90) + 37,
      Position: 20,
      GapToLeader: 99,
      TrackStatus: '1',
    };
    if (!(started && pitIn != null && pitIn <= now)) {
      const fake = pitIn != null ? null : later;
      out.PitInTimeSeconds = fake;
      out.PitInTime = fake;
    }
    const exited = started && pitOut != null && pitOut <= now;
    if (!exited) {
      const fake = pitOut != null ? null : later;
      out.PitOutTimeSeconds = fake;
      out.PitOutTime = fake;
    }
    const tyresKnown = started && (exited || Number(lt.LapNumber) === firstLap.get(lt.Driver));
    if (!tyresKnown) {
      out.Compound = 'SOFT';
      out.Stint = 99;
      out.TyreLife = 77;
    }
    return out;
  });
}
