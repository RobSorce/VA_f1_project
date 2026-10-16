// View model of the Race Situation Map (utils/views/raceSituationMap.js):
// the drawn state advances only on new lap data (a hover re-render never
// moves the points; trails hold the drawn positions), and the crosshair /
// arrows / axis titles drawn from the refitted PCA. Each dot is
// drawn at its score, so on every lap of every cached race the dots drawn sit
// at the crosshair + sum of z x arrow and their mean is the crosshair. The
// component draws exactly these values (RaceSituationMap.jsx: advanceDisplay
// in both effects, the render one idempotent).
import { describe, it, expect } from 'vitest';
import {
  advanceDisplay, situationKey, fieldMean, biplotArrows, axisTitles,
  MAX_TRAIL_LENGTH, ARROW_COUNT,
} from '../utils/views/raceSituationMap.js';
import { computePCA, standardize, LIVE_PCA_ALIGN } from '../utils/livePCA.js';
import { extractRaceSituationFeatures, FEATURE_NAMES } from '../utils/raceSituationFeatures.js';
import { resolveSessionNow } from '../utils/raceTime.js';
import { hasCachedSession, loadCachedSession, listCachedRaces } from './helpers/cachedSession.js';

const rsd = (lap, scores, abbrs = ['AAA', 'BBB', 'CCC']) => ({
  driverAbbrs: abbrs, scores, computedAtLap: lap, computedAtNow: 1000 + lap * 90,
});

describe('advanceDisplay: new lap data only, each dot at its score (P13, P10)', () => {
  const lap10 = rsd(10, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: -1, y: 0.5 }]);
  // AAA jumps by 5 PC units, the others move a little
  const lap11 = rsd(11, [{ x: 5, y: 0 }, { x: 1.2, y: 0.9 }, { x: -1, y: 0.4 }]);

  it('a hover / selection re-render (same data) returns the drawn state: no point moves', () => {
    const s10 = advanceDisplay(null, lap10);
    const s11 = advanceDisplay(s10, lap11);
    const drawn = JSON.parse(JSON.stringify(s11.positions));
    let s = s11;
    for (let k = 0; k < 10; k++) {
      s = advanceDisplay(s, lap11);
      expect(s).toBe(s11);
    }
    expect(s.positions).toEqual(drawn);
  });

  it('every dot is drawn at its score, a large move included (no dot left short of its data)', () => {
    const s11 = advanceDisplay(advanceDisplay(null, lap10), lap11);
    lap11.driverAbbrs.forEach((abbr, i) => expect(s11.positions[abbr]).toEqual(lap11.scores[i]));
    // so the drawn field's mean is the crosshair
    expect(fieldMean(Object.values(s11.positions))).toEqual(fieldMean(lap11.scores));
    expect(s11).not.toHaveProperty('smoothed');
  });

  it('trails hold the drawn positions (a trail ends at its dot), one point per lap, at most MAX_TRAIL_LENGTH', () => {
    let s = null;
    for (let lap = 3; lap <= 3 + MAX_TRAIL_LENGTH + 5; lap++) {
      s = advanceDisplay(s, rsd(lap, [{ x: lap % 2 ? 4 : -4, y: 0 }, { x: 0, y: lap / 10 }, { x: 1, y: 1 }]));
      for (const abbr of ['AAA', 'BBB', 'CCC']) {
        expect(s.trails[abbr].at(-1)).toEqual({ ...s.positions[abbr], lap });
      }
    }
    expect(s.trails.AAA.length).toBe(MAX_TRAIL_LENGTH);
    // a recompute of the same lap (new clock) replaces that lap's point
    const again = advanceDisplay(s, { ...rsd(s.lap, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]), computedAtNow: 1 });
    expect(again.trails.BBB.filter((pt) => pt.lap === s.lap).length).toBe(1);
  });

  it('a rewind trims the trails to its lap', () => {
    let s = null;
    for (const lap of [10, 11, 12, 13]) s = advanceDisplay(s, rsd(lap, [{ x: lap, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]));
    const back = advanceDisplay(s, rsd(11, [{ x: -20, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]));
    expect(back.trails.AAA.map((pt) => pt.lap)).toEqual([10, 11]);
    expect(back.positions.AAA).toEqual({ x: -20, y: 0 });
    expect(situationKey(back)).not.toBe(s.key);
  });
});

describe.skipIf(!listCachedRaces().length)('every cached race, the store chain: the dots drawn and the arrows agree (P10, P11)', () => {
  it('on every lap each drawn dot is crosshair + sum of z x arrow, and the dots\' mean is the crosshair', () => {
    let laps = 0;
    for (const { year, round } of listCachedRaces()) {
      const lapTimes = loadCachedSession(year, round).lap_times;
      const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
      let prev = null;
      let display = null;
      for (let lap = 3; lap <= maxLap; lap++) {
        const now = resolveSessionNow({ currentLap: lap, lapTimes });
        const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
        if (!res) continue;
        // the store's call (computeRaceSituation)
        const p = computePCA(res.matrix, FEATURE_NAMES, prev, { align: LIVE_PCA_ALIGN });
        prev = p;
        display = advanceDisplay(display, { driverAbbrs: res.driverAbbrs, scores: p.scores, computedAtLap: lap, computedAtNow: now });
        // the arrows the component draws (biplotArrows default, ARROW_COUNT)
        const arrows = new Map(biplotArrows(p.loadings).map((a) => [a.feature, a]));
        const mean = fieldMean(p.scores);
        const { standardized } = standardize(res.matrix);
        const drawn = res.driverAbbrs.map((d) => display.positions[d]);
        standardized.forEach((z, i) => {
          let x = mean.x; let y = mean.y;
          FEATURE_NAMES.forEach((name, j) => { const a = arrows.get(name); if (a) { x += z[j] * a.pc1; y += z[j] * a.pc2; } });
          expect(Math.hypot(drawn[i].x - x, drawn[i].y - y)).toBeLessThan(1e-9);
        });
        const dm = fieldMean(drawn);
        expect(Math.hypot(dm.x - mean.x, dm.y - mean.y)).toBeLessThan(1e-9);
        laps += 1;
      }
    }
    expect(laps).toBeGreaterThan(1000);
  });
});

describe.skipIf(!hasCachedSession(2024, 16))('Monza 2024 (R16, cached): crosshair, arrows, titles', () => {
  const lapTimes = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];
  let prev = null;
  const laps = [];
  for (let lap = 4; lap <= 53; lap++) {
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
    if (!res) continue;
    const p = computePCA(res.matrix, FEATURE_NAMES, prev);
    laps.push({ lap, res, p });
    prev = p;
  }

  it('the field-average crosshair is the mean of the current scores, the origin of the refit', () => {
    for (const { p } of laps) {
      const m = fieldMean(p.scores);
      expect(Math.hypot(m.x, m.y)).toBeLessThan(1e-9);
    }
  });

  it('arrows: a driver sits at field mean + sum of z x arrow (the arrows are in the points\' basis)', () => {
    // the arrows the component draws (biplotArrows' default): one per input
    expect(ARROW_COUNT).toBe(FEATURE_NAMES.length);
    for (const { res, p } of laps) {
      const all = biplotArrows(p.loadings);
      // every input with a non-zero loading has its arrow
      expect(all.length).toBe(p.loadings.filter((l) => Math.hypot(l.pc1, l.pc2) > 1e-9).length);
      const byFeature = new Map(all.map((a) => [a.feature, a]));
      const mean = fieldMean(p.scores);
      const { standardized } = standardize(res.matrix);
      standardized.forEach((z, i) => {
        let x = mean.x; let y = mean.y;
        FEATURE_NAMES.forEach((name, j) => {
          const a = byFeature.get(name);
          if (a) { x += z[j] * a.pc1; y += z[j] * a.pc2; }
        });
        expect(p.scores[i].x).toBeCloseTo(x, 9);
        expect(p.scores[i].y).toBeCloseTo(y, 9);
      });
      expect(biplotArrows(p.loadings).length).toBeLessThanOrEqual(ARROW_COUNT);
    }
  });

  it('lap 4 (pace out of the fit): no pace arrow, no pace in the axis titles', () => {
    const at4 = laps.find((x) => x.lap === 4);
    expect(at4.res.paceInPca).toBe(false);
    const arrows = biplotArrows(at4.p.loadings, FEATURE_NAMES.length).map((a) => a.feature);
    expect(arrows).not.toContain('recent_pace');
    expect(arrows).not.toContain('pace_trend');
    const t = axisTitles(at4.p.loadings, at4.p.explainedVariance);
    expect(t.x).not.toMatch(/Pace/);
    expect(t.y).not.toMatch(/Pace/);
  });

  it('axis titles carry the variance each axis captures at that lap, and the PC1-PC2 plane the sum', () => {
    for (const { p } of laps) {
      const t = axisTitles(p.loadings, p.explainedVariance);
      // the axes are turned inside the PC1-PC2 plane to follow the previous lap: "Axis", not "PC"
      expect(t.x).toMatch(new RegExp(`^Axis 1: .+ \\(${(p.explainedVariance[0] * 100).toFixed(0)}%\\)$`));
      expect(t.y).toMatch(new RegExp(`^Axis 2: .+ \\(${(p.explainedVariance[1] * 100).toFixed(0)}%\\)$`));
      // the two axes together capture PC1 + PC2
      expect(p.explainedVariance[0] + p.explainedVariance[1]).toBeCloseTo(p.eigenShare[0] + p.eigenShare[1], 12);
      expect(t.plane).toBe(`PC1–PC2 plane: ${((p.eigenShare[0] + p.eigenShare[1]) * 100).toFixed(0)}% of the variance`);
    }
  });
});

describe('RaceSituationMap.jsx draws the view model (no smoothing of its own)', () => {
  it('both effects go through advanceDisplay; the points are display.positions', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.resolve(here, '../components/visualizations/RaceSituationMap.jsx'), 'utf8');
    expect(src.match(/advanceDisplay\(displayRef\.current, /g)?.length).toBe(2);
    expect(src).toMatch(/const drawn = display\.positions\[abbr\]/);
    expect(src).not.toMatch(/SMOOTHING_ALPHA|JUMP_THRESHOLD/);
    expect(src).toMatch(/const mean = fieldMean\(scores\)/);
    expect(src).toMatch(/\.text\(titles\.plane\)/);
  });
});
