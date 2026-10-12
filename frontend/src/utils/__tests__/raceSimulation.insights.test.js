import { describe, it, expect } from 'vitest';
import { generateInsights } from '../insightsGenerator.js';
import { simulateRaceFinish } from '../raceSimulation.js';
import { extractRaceSituationFeatures } from '../raceSituationFeatures.js';
import { hasCachedSession, loadCachedSession } from '../../__tests__/helpers/cachedSession.js';

describe('generateInsights: strategy stop count', () => {
  it('N stints is an (N - 1)-stop strategy', () => {
    const pcaStrategyAnalysis = {
      selection_count: 12,
      strategies: [{
        stints: [{ compound: 'MEDIUM', lap_start: 1, length: 16 }, { compound: 'HARD', lap_start: 17, length: 37 }],
        frequency: 0.6, count: 7,
      }],
    };
    const out = generateInsights({ pcaStrategyAnalysis, currentLap: 10, maxLap: 53 });
    const pca = out.find((i) => i.category === 'pattern' && i.id.startsWith('pca-'));
    expect(pca.text).toContain('1-stop M-H strategy');
    expect(pca.text).not.toContain('2-stop');
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('generateInsights on a Monza 2024 projection (cached)', () => {
  it('builds insights from the lap-30 simulation without errors', () => {
    const s = loadCachedSession(2024, 16);
    const lapTimes = s.lap_times;
    const maxLap = Math.max(...lapTimes.map((lt) => lt.LapNumber));
    const raceSituationData = extractRaceSituationFeatures({ lapTimes, currentLap: 30, dnfMap: {} });
    const raceProjection = simulateRaceFinish({
      driverFeatures: raceSituationData.driverFeatures, currentLap: 30, maxLap,
      lapTimes, strategies: s.tyre_strategy, trackStatus: s.track_status,
    });
    const out = generateInsights({ raceProjection, raceSituationData, currentLap: 30, maxLap });
    expect(Array.isArray(out)).toBe(true);
    for (const ins of out) {
      expect(typeof ins.text).toBe('string');
      expect(ins.text).not.toMatch(/NaN|undefined/);
    }
  });
});
