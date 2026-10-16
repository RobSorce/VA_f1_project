// Every mark the views draw from a Monte Carlo projection changes only on
// evidence beyond the sampling error (utils/simulationClient.js
// projectionBadges, raceSimulation.js evaluateRisks), never on a point
// estimate within it: the battle list (no fill by a point estimate) and its
// order (badge level, then race order), the most likely position shown, the
// risk rows. Synthetic projections, n = 1000 runs.
import { describe, it, expect } from 'vitest';
import {
  projectionBadges, listedBattles, modePosition, projectionRisks, battleKey, wilsonInterval, BATTLE_LIST_SIZE,
  shownPositions, positionChange, orderedProjections, withBadges, familyZ, battleLevel, BADGE_Z,
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

describe('the finishing position shown: the median, judged beyond the error of the whole column', () => {
  // counts per position over N runs
  const row = (driver, currentPos, posCount) => ({ driver, currentPos, posCount, modePos: null, posDistribution: {} });
  const res = (rows) => ({ numSimulations: N, projections: rows, battles: [] });
  // 20 rows, so the interval is the simultaneous one of the table (familyZ(20) = 3.02)
  const filler = Array.from({ length: 19 }, (_, i) => row(`F${i + 2}`, i + 2, { [i + 2]: N }));

  it('familyZ: Bonferroni over the rows (95 % together); one row is the plain 95 % interval', () => {
    expect(familyZ(1)).toBeCloseTo(BADGE_Z, 3);
    expect(familyZ(20)).toBeCloseTo(3.023, 3);
    expect(familyZ(70)).toBeGreaterThan(familyZ(20));
  });

  it('first projection: the median; later the previous position stays while the median is within the error', () => {
    // F(3) = 52 %: median P3
    const r1 = res([row('DRV', 5, { 1: 100, 2: 200, 3: 220, 4: 300, 5: 180 }), ...filler]);
    const b1 = projectionBadges(r1);
    expect(b1.mode.DRV).toBe(3);
    expect(modePosition({ ...r1, badges: b1 }, r1.projections[0])).toBe(3);
    // F(3) = 47 %: within the simultaneous error of 50 %, still P3 (and gold, and the podium badge)
    const r2 = res([row('DRV', 5, { 1: 100, 2: 170, 3: 200, 4: 330, 5: 200 }), ...filler]);
    const b2 = projectionBadges(r2, b1);
    expect(b2.mode.DRV).toBe(3);
    expect(b2.podium.DRV).toBe(true);
    // no previous state: the point (P4)
    expect(projectionBadges(r2).mode.DRV).toBe(4);
    // F(3) = 40 %: beyond the error, P4; the podium badge goes with it
    const r3 = res([row('DRV', 5, { 1: 100, 2: 150, 3: 150, 4: 400, 5: 200 }), ...filler]);
    const b3 = projectionBadges(r3, b2);
    expect(b3.mode.DRV).toBe(4);
    expect(b3.podium.DRV).toBe(false);
    // a 95 % interval per row would have moved already at 47 %: the column's interval is wider
    const [lo, hi] = wilsonInterval(0.47, N, familyZ(20));
    expect(lo < 0.5 && hi >= 0.5).toBe(true);
    expect(wilsonInterval(0.455, N)[1]).toBeLessThan(0.5);
  });

  it('a flat distribution never shows a gold place with a podium chance under 50 % (the most frequent position would)', () => {
    // most frequent P2 (9 %), podium 18 %: the old label was a gold P2
    const flat = { 1: 40, 2: 90, 3: 50, 4: 60, 5: 60, 6: 60, 7: 60, 8: 70, 9: 70, 10: 70, 11: 70, 12: 70, 13: 70, 14: 60, 15: 50, 16: 50 };
    const r = res([row('HUL', 20, flat), ...filler]);
    const b = projectionBadges(r);
    expect(b.mode.HUL).toBeGreaterThan(3);
    expect(b.podium.HUL).toBe(false);
    // the median: F(8) = 49 %, F(9) = 56 %
    expect(b.mode.HUL).toBe(9);
  });

  it('gold P label = podium badge, arrow = current - shown, rows by position shown then current place', () => {
    const r = res([
      row('AAA', 1, { 1: 600, 2: 400 }),
      row('BBB', 2, { 1: 400, 2: 600 }),
      row('CCC', 3, { 2: 100, 3: 300, 4: 600 }),
      row('DDD', 4, { 3: 700, 4: 300 }),
    ]);
    const p = withBadges(r, null);
    expect(p.badges.mode).toEqual({ AAA: 1, BBB: 2, CCC: 4, DDD: 3 });
    for (const d of ['AAA', 'BBB', 'CCC', 'DDD']) expect(p.badges.podium[d]).toBe(p.badges.mode[d] <= 3);
    expect(p.projections.map((x) => x.driver)).toEqual(['AAA', 'BBB', 'DDD', 'CCC']);
    expect(orderedProjections(p).map((x) => x.driver)).toEqual(['AAA', 'BBB', 'DDD', 'CCC']);
    const ch = Object.fromEntries(p.projections.map((x) => [x.driver, positionChange(p, x)]));
    expect(ch).toEqual({ AAA: 0, BBB: 0, CCC: -1, DDD: 1 });
    // no badges (a projection built outside the store): the same rule with no previous state
    expect(modePosition(r, r.projections[2])).toBe(4);
    expect(orderedProjections(r).map((x) => x.driver)).toEqual(['AAA', 'BBB', 'DDD', 'CCC']);
  });

  it('shownPositions reads posDistribution (percent) when the raw counts are absent', () => {
    const r = { numSimulations: N, projections: [{ driver: 'X', posDistribution: { 4: 30, 5: 30, 6: 40 } }] };
    expect(shownPositions(r).X).toBe(5);
  });

  it('battle colours: intervals simultaneous over the pairs of the projection', () => {
    const many = Array.from({ length: 40 }, (_, i) => battle(i + 1, 10));
    // 34 % is beyond the 30 % threshold for one pair (95 %), not for 41 pairs read together
    const one = projectionBadges(result([battle(1, 34)]));
    expect(one.battles['B1>A1'].level).toBe(1);
    const first = projectionBadges(result([battle(1, 25), ...many.slice(1)]));
    expect(first.battles['B1>A1'].level).toBe(0);
    const next = projectionBadges(result([battle(1, 34), ...many.slice(1)]), first);
    expect(next.battles['B1>A1'].level).toBe(0);
    expect(battleLevel(result([battle(1, 34), ...many.slice(1)]), battle(1, 34))).toBe(1); // no state: the point
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
