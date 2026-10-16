// S4 / lead decision D5: every categorical mark derived from the Monte Carlo
// output is stable on a same-state recompute with a different seed. The full
// measurement (30 races x 3 clocks x 10 seeds, every mark <= 5 %) is
// scripts/mc_stability.mjs (docs/evidence/mc_stability.txt); this
// regression test runs the same chain (utils/simulationClient.js withBadges,
// the store's) on two cached races and checks the marks the checkpoint drew
// from a raw statistic: the P label (it was the most frequent position), its
// gold, the gain / loss arrow (it was the expected position against +/-0.5),
// the row order (it was the expected position), and the battle colours of
// the Leaderboard's adjacent pairs.
import { describe, it, expect } from 'vitest';
import { simulateRaceFinish, extractRaceParams } from '../utils/raceSimulation.js';
import {
  withBadges, modePosition, positionChange, orderedProjections, battleKey, battleLevel, listedBattles,
} from '../utils/simulationClient.js';
import { seedFrom } from '../utils/prng.js';
import { extractRaceSituationFeatures } from '../utils/raceSituationFeatures.js';
import { computeSessionTimeOffset, resolveSessionNow } from '../utils/raceTime.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

const RACES = [[2024, 16], [2024, 5]].filter(([y, r]) => hasCachedSession(y, r));
const SEEDS = 6;

describe.skipIf(RACES.length < 2)('same state, new seed per recompute (D5), chained as the store', () => {
  it('P label, gold, arrow, row order, Leaderboard battle colours: changed in at most 10 % of the recomputes; the P label far less than the most frequent position', () => {
    const marks = {
      label: 0, gold: 0, arrow: 0, order: 0, adjacent: 0, listed: 0, oldMostFrequent: 0, oldArrow: 0, oldOrder: 0,
    };
    let recomputes = 0;
    for (const [y, r] of RACES) {
      const s = loadCachedSession(y, r);
      const lt = s.lap_times;
      const ml = Math.max(...lt.map((x) => Number(x.LapNumber) || 0));
      const offset = computeSessionTimeOffset(lt);
      for (const frac of [0.25, 0.5, 0.75]) {
        const lap = Math.round(ml * frac);
        const now = resolveSessionNow({ currentLap: lap, lapTimes: lt });
        const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: lap, dnfMap: {}, sessionNow: now, sessionTimeOffset: offset });
        const raceParams = extractRaceParams(lt, [], s.track_status, lap, { sessionNow: now, sessionType: 'R' });
        const ctx = { driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml };
        let prev = null;
        let prevView = null;
        for (let k = 0; k < SEEDS; k++) {
          const res = simulateRaceFinish({
            driverFeatures: feats.driverFeatures, currentLap: lap, maxLap: ml, lapTimes: lt, trackStatus: s.track_status,
            sessionNow: now, sessionType: 'R', raceParams, seed: seedFrom('d5-regression', y, r, lap, k),
          });
          const proj = withBadges(res, prev?.badges, ctx);
          const drivers = proj.projections.map((p) => p.driver).sort();
          const byDriver = new Map(proj.projections.map((p) => [p.driver, p]));
          const view = {
            label: drivers.map((d) => modePosition(proj, byDriver.get(d))).join(','),
            gold: drivers.map((d) => modePosition(proj, byDriver.get(d)) <= 3).join(','),
            arrow: drivers.map((d) => positionChange(proj, byDriver.get(d))).join(','),
            order: orderedProjections(proj).map((p) => p.driver).join(','),
            adjacent: proj.battles.filter((b) => Math.abs(b.aheadCurrentPos - b.behindCurrentPos) === 1)
              .map((b) => `${battleKey(b)}:${battleLevel(proj, b)}`).sort().join('|'),
            listed: listedBattles(proj).map(battleKey).sort().join('|'),
            oldMostFrequent: drivers.map((d) => byDriver.get(d).modePos).join(','),
            oldArrow: drivers.map((d) => {
              const { delta } = byDriver.get(d);
              return delta > 0.5 ? 1 : delta < -0.5 ? -1 : 0;
            }).join(','),
            oldOrder: [...res.projections].sort((a, b) => a.expectedPos - b.expectedPos).map((p) => p.driver).join(','),
          };
          // gold P label and the podium badge are one statement
          for (const d of drivers) expect(proj.badges.podium[d]).toBe(modePosition(proj, byDriver.get(d)) <= 3);
          if (prevView) {
            recomputes += 1;
            for (const m of Object.keys(marks)) if (view[m] !== prevView[m]) marks[m] += 1;
          }
          prev = proj;
          prevView = view;
        }
      }
    }
    console.log('D5 regression, recomputes', recomputes, marks);
    expect(recomputes).toBe(RACES.length * 3 * (SEEDS - 1));
    for (const m of ['label', 'gold', 'arrow', 'order', 'adjacent', 'listed']) {
      expect(marks[m] / recomputes).toBeLessThanOrEqual(0.1);
    }
    // the raw statistics the checkpoint drew change far more often on the same state
    expect(marks.oldMostFrequent).toBeGreaterThan(3 * Math.max(1, marks.label));
    expect(marks.oldArrow).toBeGreaterThan(3 * Math.max(1, marks.arrow));
    expect(marks.oldOrder).toBeGreaterThan(3 * Math.max(1, marks.order));
  });
});
