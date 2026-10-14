// S4: every mark the views draw from a Monte Carlo projection changes only on
// evidence beyond the sampling error (utils/simulationClient.js
// projectionBadges, raceSimulation.js evaluateRisks), never on a point
// estimate within it: the battle list (no fill by a point estimate) and its
// order (badge level, then race order), the most likely position shown, the
// risk rows. Synthetic projections, n = 1000 runs.
import { describe, it, expect } from 'vitest';
import {
  projectionBadges, listedBattles, modePosition, projectionRisks, battleKey, wilsonInterval, BATTLE_LIST_SIZE,
} from '../utils/simulationClient.js';
import { evaluateRisks, identifyRisks, RISK_LIST_SIZE } from '../utils/raceSimulation.js';
import { generateInsights } from '../utils/insightsGenerator.js';

const N = 1000;
/** A battle between the cars in places `pos` and `pos + 1`. */
const battle = (pos, prob, gap = 1) => ({
  ahead: `A${pos}`, behind: `B${pos}`, aheadCurrentPos: pos, behindCurrentPos: pos + gap, prob,
  aheadCompound: 'HARD', behindCompound: 'HARD',
});
const result = (battles, extra = {}) => ({ battles, projections: [], numSimulations: N, ...extra });

describe('battle list: the pairs surely among the most likely, no fill by a point estimate', () => {
  it('first projection: the BATTLE_LIST_SIZE most likely', () => {
    const b = [90, 80, 70, 60, 50, 40, 30, 20].map((p, i) => battle(i + 1, p));
    const badges = projectionBadges(result(b));
    expect(badges.listed.sort()).toEqual(b.slice(0, BATTLE_LIST_SIZE).map(battleKey).sort());
  });

  it('a listed pair stays while fewer than 6 pairs are surely more likely; it leaves once 6 are', () => {
    const prev = { listed: ['B9>A9'] };
    // 5 pairs surely above the listed one (whole interval above), the rest close to it
    const five = [95, 93, 91, 89, 87].map((p, i) => battle(i + 1, p));
    const listed = battle(9, 60);
    const near = battle(10, 61);
    let badges = projectionBadges(result([...five, listed, near]), prev);
    expect(badges.listed).toContain('B9>A9');
    // a sixth pair surely above it: it leaves
    badges = projectionBadges(result([...five, battle(6, 85), listed, near]), prev);
    expect(badges.listed).not.toContain('B9>A9');
  });

  it('a pair not listed enters only when fewer than 6 others could be as likely; no slot is filled by the point estimate', () => {
    // the list had 4 pairs, two left the 4-position window: 4 free slots, and 3
    // candidates within the error of one another (60, 59, 58 %), plus 4 listed far above
    const top = [96, 94, 92, 90].map((p, i) => battle(i + 1, p));
    const prev = { listed: top.map(battleKey) };
    const close = [battle(7, 60), battle(8, 59), battle(9, 58)];
    const pack = [battle(11, 57), battle(12, 57), battle(13, 56)];
    const badges = projectionBadges(result([...top, ...close, ...pack]), prev);
    // each candidate is reached by the 4 listed ones above plus the others of the pack:
    // nobody is surely in the 6 most likely, so nobody enters
    expect(badges.listed.sort()).toEqual(prev.listed.sort());
    // a candidate clearly above the pack (and below the top 4) is surely in: it enters
    const clear = battle(7, 75);
    const b2 = projectionBadges(result([...top, clear, ...close.slice(1), ...pack]), prev);
    expect(b2.listed).toContain(battleKey(clear));
    expect(b2.listed.length).toBe(5);
    const [lo] = wilsonInterval(0.75, N);
    const [, hi] = wilsonInterval(0.59, N);
    expect(lo).toBeGreaterThan(hi);
  });

  it('same pairs, probabilities moved within the error: the same list (any seed)', () => {
    const base = [80, 70, 62, 61, 60, 59, 58, 40].map((p, i) => battle(i + 1, p));
    let badges = projectionBadges(result(base));
    const first = [...badges.listed].sort();
    for (const shift of [[0, 0, -1, 1, -1, 1, 1, 0], [1, -1, 1, -1, 1, -1, 2, 1], [0, 1, -2, 0, 2, -1, 1, -1]]) {
      const moved = base.map((b, i) => ({ ...b, prob: b.prob + shift[i] }));
      badges = projectionBadges(result(moved), badges);
      expect([...badges.listed].sort()).toEqual(first);
    }
  });
});

describe('listedBattles order: badge level, then race order (never the point estimate)', () => {
  it('green, gold, then the others; within a level the pair higher up the race order first', () => {
    const b = [battle(5, 72), battle(2, 66), battle(8, 45), battle(1, 40), battle(11, 10), battle(14, 12)];
    const proj = { ...result(b), badges: projectionBadges(result(b)) };
    const shown = listedBattles(proj);
    expect(shown.map((x) => x.level)).toEqual([2, 2, 1, 1, 0, 0]);
    expect(shown.map((x) => x.aheadCurrentPos)).toEqual([2, 5, 1, 8, 11, 14]);
  });

  it('the insight cards (first 3 gold / green) and the quick query (first) follow the list and the levels', () => {
    const a = [battle(5, 72), battle(2, 66), battle(8, 45), battle(1, 40), battle(11, 10), battle(14, 12)];
    const pa = { ...result(a), badges: projectionBadges(result(a)) };
    // the same state with new probabilities within the error: levels and list kept
    const b = [battle(5, 70), battle(2, 68), battle(8, 47), battle(1, 38), battle(11, 11), battle(14, 11)];
    const pb = { ...result(b), badges: projectionBadges(result(b), pa.badges) };
    const cards = (p) => generateInsights({ raceProjection: p, currentLap: 20, maxLap: 50 })
      .filter((i) => i.category === 'battle').map((i) => `${i.id}:${i.severity}`);
    expect(cards(pb)).toEqual(cards(pa));
    expect([...cards(pa)].sort()).toEqual(['battle-B1-A1:notable', 'battle-B2-A2:high', 'battle-B5-A5:high']);
    expect(battleKey(listedBattles(pb)[0])).toBe(battleKey(listedBattles(pa)[0]));
  });
});

describe('the most likely position shown: hysteresis on the shares', () => {
  const row = (dist, modePos) => ({ driver: 'DRV', modePos, posDistribution: dist });
  it('keeps the previous position while its share is within the error of the most frequent one', () => {
    const r1 = result([], { projections: [row({ 3: 30, 4: 28, 5: 20 }, 3)] });
    const b1 = projectionBadges(r1);
    expect(modePosition({ ...r1, badges: b1 }, r1.projections[0])).toBe(3);
    // P4 now most frequent by a share within the error: still P3 (and its gold mark)
    const r2 = result([], { projections: [row({ 3: 28, 4: 30, 5: 20 }, 4)] });
    const b2 = projectionBadges(r2, b1);
    expect(modePosition({ ...r2, badges: b2 }, r2.projections[0])).toBe(3);
    // P4 beyond the error: P4
    const r3 = result([], { projections: [row({ 3: 20, 4: 38, 5: 20 }, 4)] });
    const b3 = projectionBadges(r3, b2);
    expect(modePosition({ ...r3, badges: b3 }, r3.projections[0])).toBe(4);
    // no badges (a projection built outside the store): modePos
    expect(modePosition(r2, r2.projections[0])).toBe(4);
  });
});

describe('risk rows: judged beyond the sampling error, chained; race order within a severity', () => {
  const feat = (position) => ({ position, compoundName: 'HARD', tyreLife: 5, paceTrend: 0 });
  const raceParams = { pitLoss: { median: 22, source: 'race' }, tyreDeg: {}, stintLength: {} };
  // P5-P95 range with its order-statistic intervals; mean stops to come with its sd
  const proj = (driver, range, ci, stops = { mean: 0.6, sd: 0.5 }) => ({
    driver, posRange: range, posRangeCI: ci, pitStopsRemaining: { ...stops, median: 1, range: [0, 1] },
  });

  it('a range whose interval straddles 5 places keeps the previous state; clear evidence decides', () => {
    const features = { AAA: feat(4) };
    // point spread 5, interval of the spread [3, 7]: within the error
    const p = [proj('AAA', [3, 8], [[2, 4], [7, 9]])];
    const on = evaluateRisks(p, features, raceParams, 20, 50, { n: N, prev: { 'AAA|HIGH VARIANCE': 1 } });
    const off = evaluateRisks(p, features, raceParams, 20, 50, { n: N, prev: { 'AAA|HIGH VARIANCE': 0 } });
    expect(on.rows.map((r) => r.type)).toEqual(['HIGH VARIANCE']);
    expect(off.rows).toEqual([]);
    // no previous state: the point estimate (5 >= 5)
    expect(evaluateRisks(p, features, raceParams, 20, 50, { n: N }).rows.length).toBe(1);
    // whole interval below 5: off whatever came before
    const narrow = [proj('AAA', [3, 6], [[3, 3], [5, 6]])];
    expect(evaluateRisks(narrow, features, raceParams, 20, 50, { n: N, prev: { 'AAA|HIGH VARIANCE': 1 } }).rows).toEqual([]);
  });

  it('extra stop: the mean stops to come judged with sd / sqrt(n)', () => {
    const features = { AAA: feat(2) };
    const within = [proj('AAA', [2, 3], [[2, 2], [3, 3]], { mean: 1.8, sd: 0.6 })];
    expect(evaluateRisks(within, features, raceParams, 20, 50, { n: N, prev: { 'AAA|EXTRA STOP': 0 } }).rows).toEqual([]);
    expect(evaluateRisks(within, features, raceParams, 20, 50, { n: N, prev: { 'AAA|EXTRA STOP': 1 } }).rows
      .map((r) => r.type)).toEqual(['EXTRA STOP']);
    const clear = [proj('AAA', [2, 3], [[2, 2], [3, 3]], { mean: 1.95, sd: 0.3 })];
    expect(evaluateRisks(clear, features, raceParams, 20, 50, { n: N, prev: { 'AAA|EXTRA STOP': 0 } }).rows
      .map((r) => r.type)).toEqual(['EXTRA STOP']);
  });

  it('rows: most severe first, then the current race order (data), at most RISK_LIST_SIZE', () => {
    const features = {};
    const p = [];
    // projection order (by expected position) differs from the race order
    for (const [d, pos] of [['DDD', 7], ['AAA', 1], ['CCC', 5], ['BBB', 3], ['EEE', 9], ['FFF', 11]]) {
      features[d] = feat(pos);
      p.push(proj(d, [1, 12], [[1, 1], [12, 12]]));
    }
    const rows = identifyRisks(p, features, raceParams, 20, 50, { n: N });
    expect(rows.length).toBe(RISK_LIST_SIZE);
    expect(rows.map((r) => r.driver)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    // the store's rows (badges.risks) are what the views read
    const badges = projectionBadges({ projections: p, battles: [], numSimulations: N, raceParams },
      null, { driverFeatures: features, currentLap: 20, maxLap: 50 });
    expect(projectionRisks({ risks: [], badges })).toEqual(rows);
  });
});
