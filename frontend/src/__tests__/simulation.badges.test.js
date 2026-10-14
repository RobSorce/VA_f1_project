// S4 badges: RacePredictionPanel's podium (>= 50 %) and battle (>= 30 % /
// >= 60 %) badges change only when the Wilson interval of the share of the
// simulations clears the threshold (utils/simulationClient.js badgeOn), and
// the battles listed change only when a pair's interval clears the cut of the
// list (listedBattles). The stability checks recompute the same race state
// with different seeds (as a replay does when something new becomes known)
// and count badge flips and listed rows appearing / disappearing, with the
// bare thresholds / the former top-6 cut and with the rule. The saved figures
// are scripts/mc_benchmark.mjs section 5 (notes/experiments/mc_benchmark.txt).
import { describe, it, expect } from 'vitest';
import {
  wilsonInterval, badgeOn, projectionBadges, battleKey, listedBattles, PODIUM_BADGE_PCT, BATTLE_BADGE_PCT,
  BATTLE_LIST_SIZE,
} from '../utils/simulationClient.js';
import {
  simulateRaceFinish, extractRaceParams, runSimulations, DEFAULT_NUM_SIMULATIONS,
} from '../utils/raceSimulation.js';
import { seedFrom } from '../utils/prng.js';
import { extractRaceSituationFeatures } from '../utils/raceSituationFeatures.js';
import { computeSessionTimeOffset, resolveSessionNow } from '../utils/raceTime.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

describe('badge rule', () => {
  it('Wilson interval: textbook values', () => {
    const [lo, hi] = wilsonInterval(0.5, 1000);
    expect(lo).toBeCloseTo(0.4691, 4);
    expect(hi).toBeCloseTo(0.5309, 4);
    const [lo0, hi0] = wilsonInterval(0, 1000);
    expect(lo0).toBe(0);
    expect(hi0).toBeCloseTo(0.00383, 5);
    expect(wilsonInterval(0.3, 0)).toEqual([0, 1]);
  });

  it('clear evidence decides; within the sampling error the previous state is kept', () => {
    // n = 1000: 50 % +/- about 3.1 pp
    expect(badgeOn(54, 1000, 50, false)).toBe(true);   // interval [50.9, 57.1] above
    expect(badgeOn(46, 1000, 50, true)).toBe(false);   // interval [42.9, 49.1] below
    expect(badgeOn(51, 1000, 50, false)).toBe(false);  // inside: keeps off
    expect(badgeOn(49, 1000, 50, true)).toBe(true);    // inside: keeps on
    expect(badgeOn(51, 1000, 50)).toBe(true);          // no previous state: the point estimate
    expect(badgeOn(49, 1000, 50)).toBe(false);
    // fewer simulations, wider band
    expect(badgeOn(54, 100, 50, false)).toBe(false);
  });

  it('battle levels use both thresholds, each with its own hysteresis', () => {
    const r = (prob) => ({ numSimulations: 1000, projections: [], battles: [{ behind: 'B', ahead: 'A', prob }] });
    const level = (prob, prev) => projectionBadges(r(prob), prev).battles['B>A'].level;
    expect(level(65)).toBe(2);
    expect(level(45)).toBe(1);
    expect(level(10)).toBe(0);
    const at2 = projectionBadges(r(65));
    expect(level(59, at2)).toBe(2); // 59 % is within the error of 60 %: stays green
    expect(level(55, at2)).toBe(1); // clearly below 60 %
    const at1 = projectionBadges(r(45));
    expect(level(61, at1)).toBe(1); // within the error of 60 %: stays gold
  });

  it('battle list: the most likely first; afterwards a pair enters or leaves only beyond the error of the cut', () => {
    const b = (behind, prob) => ({ behind, ahead: 'X', prob });
    const res = (probs) => ({ numSimulations: 1000, projections: [], battles: probs.map(([d, p]) => b(d, p)) });
    // seven pairs, the 6th and 7th at 62 / 61 %
    const first = res([['A', 90], ['B', 85], ['C', 80], ['D', 75], ['E', 70], ['F', 62], ['G', 61]]);
    const st1 = projectionBadges(first);
    expect(BATTLE_LIST_SIZE).toBe(6);
    expect(st1.listed).toEqual(['A>X', 'B>X', 'C>X', 'D>X', 'E>X', 'F>X']);
    // new seed: G 63 %, F 61 %: within the Monte Carlo error, the list keeps F
    const second = res([['A', 90], ['B', 85], ['C', 80], ['D', 75], ['E', 70], ['G', 63], ['F', 61]]);
    const st2 = projectionBadges(second, st1);
    expect(st2.listed).toContain('F>X');
    expect(st2.listed).not.toContain('G>X');
    expect(listedBattles({ ...second, badges: st2 }).map(battleKey)).toEqual(st2.listed);
    // clear evidence: G 75 %, F 50 % (F's interval entirely below the cut's): G replaces F
    const third = res([['A', 90], ['B', 85], ['C', 80], ['G', 75], ['D', 74], ['E', 70], ['F', 50]]);
    const st3 = projectionBadges(third, st2);
    expect(st3.listed).toContain('G>X');
    expect(st3.listed).not.toContain('F>X');
    expect(st3.listed).toHaveLength(6);
    // a projection without badges (built outside the store): the six most likely
    expect(listedBattles(second).map(battleKey)).toEqual(['A>X', 'B>X', 'C>X', 'D>X', 'E>X', 'G>X']);
  });
});

// ─── Stability on cached races ───
const RACES = [[2024, 16, 'Monza'], [2024, 5, 'China'], [2024, 1, 'Bahrain']].filter(([y, r]) => hasCachedSession(y, r));
const SEEDS = 20;
const LAP = 30;

function raceAt(year, round, currentLap) {
  const s = loadCachedSession(year, round);
  const lapTimes = s.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  const rsd = extractRaceSituationFeatures({ lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: offset });
  const maxLap = Math.max(...lapTimes.map((r) => Number(r.LapNumber) || 0));
  const common = {
    driverFeatures: rsd.driverFeatures, currentLap, maxLap, lapTimes, trackStatus: s.track_status,
    sessionNow, sessionTimeOffset: offset, sessionType: 'R',
  };
  return { ...common, raceParams: extractRaceParams(lapTimes, [], s.track_status, currentLap, { sessionNow, sessionType: 'R' }) };
}

/** Badge states as the panel drew them before the rule: the bare thresholds. */
function rawBadges(result) {
  const podium = {};
  for (const p of result.projections) podium[p.driver] = p.podiumProb >= PODIUM_BADGE_PCT;
  const battles = {};
  for (const b of result.battles) battles[battleKey(b)] = { level: BATTLE_BADGE_PCT.filter((t) => b.prob >= t).length };
  return { podium, battles };
}

/** Flips between consecutive badge states: [flips, pairs, items that flip at least once]. */
function countFlips(states) {
  const items = new Set();
  for (const st of states) {
    for (const d of Object.keys(st.podium)) items.add(`P:${d}`);
    for (const k of Object.keys(st.battles)) items.add(`B:${k}`);
  }
  const value = (st, item) => (item.startsWith('P:')
    ? !!st.podium[item.slice(2)]
    : (st.battles[item.slice(2)]?.level ?? 0));
  let flips = 0;
  const flipping = new Set();
  for (let i = 1; i < states.length; i++) {
    for (const item of items) {
      if (value(states[i], item) !== value(states[i - 1], item)) { flips += 1; flipping.add(item); }
    }
  }
  return { flips, pairs: items.size * (states.length - 1), items: items.size, flipping: flipping.size };
}

const pct = (a, b) => `${((100 * a) / b).toFixed(2)}%`;

describe.skipIf(RACES.length === 0)('badge stability on repeated recompute (cached races)', () => {
  // The items and seeds of scripts/mc_benchmark.mjs section 5 (every driver's
  // podium, every pair within 4 positions; seedFrom('badge', year, round,
  // lap, k)), so the bare-threshold rows reproduce that table; the rule rows
  // apply badgeOn to the same series, each state against the previous seed's.
  it(`same state, ${SEEDS} seeds: flips with the bare thresholds and with the rule, at 100 and ${DEFAULT_NUM_SIMULATIONS} runs`, () => {
    const lines = [
      `Badge stability: the same state (lap ${LAP}, lap-mode clock) recomputed with ${SEEDS} seeds, one after the other.`,
      'Items: every driver (podium >= 50 %) and every pair within 4 positions (overtake >= 30 % / >= 60 %),',
      `${RACES.map(([y, , n]) => `${n} ${y}`).join(', ')}. A flip = two consecutive seeds giving a different badge state.`,
      'The rule (utils/simulationClient.js badgeOn): a state changes only when the 95 % Wilson interval of the',
      'share of the runs lies entirely on the other side of the threshold; otherwise the previous state is kept.',
      '  runs   items   bare thresholds: flips / pairs (rate), items flipping   rule: flips / pairs (rate), items flipping',
    ];
    const totals = {};
    for (const n of [100, DEFAULT_NUM_SIMULATIONS]) {
      let items = 0;
      let pairs = 0;
      const raw = { flips: 0, flipping: 0 };
      const rule = { flips: 0, flipping: 0 };
      for (const [year, round] of RACES) {
        const s = loadCachedSession(year, round);
        const lt = s.lap_times;
        const feats = extractRaceSituationFeatures({ lapTimes: lt, currentLap: LAP, dnfMap: {} });
        const params = extractRaceParams(lt, [], s.track_status, LAP);
        const maxLap = Math.max(...lt.map((r) => Number(r.LapNumber) || 0));
        const drivers = Object.keys(feats.driverFeatures);
        const series = new Map(); // item -> { thresholds, pct: [] }
        const add = (key, thresholds, value) => {
          if (!series.has(key)) series.set(key, { thresholds, pct: [] });
          series.get(key).pct.push(value);
        };
        for (let k = 0; k < SEEDS; k++) {
          const { sims } = runSimulations({
            driverFeatures: feats.driverFeatures, currentLap: LAP, maxLap, lapTimes: lt,
            raceParams: params, seed: seedFrom('badge', year, round, LAP, k), numSimulations: n,
          });
          for (const d of drivers) {
            add(`podium ${d}`, [PODIUM_BADGE_PCT], Math.round((100 * sims.filter((sm) => sm[d].pos <= 3).length) / sims.length));
          }
          for (let i = 0; i < drivers.length; i++) {
            for (let j = i + 1; j < drivers.length; j++) {
              const a = feats.driverFeatures[drivers[i]];
              const b = feats.driverFeatures[drivers[j]];
              if (Math.abs(a.position - b.position) > 4) continue;
              const [ahead, behind] = a.position < b.position ? [drivers[i], drivers[j]] : [drivers[j], drivers[i]];
              add(`battle ${behind}>${ahead}`, BATTLE_BADGE_PCT,
                Math.round((100 * sims.filter((sm) => sm[behind].pos < sm[ahead].pos).length) / sims.length));
            }
          }
        }
        for (const { thresholds, pct: values } of series.values()) {
          items += 1;
          pairs += values.length - 1;
          const rawStates = values.map((v) => thresholds.filter((t) => v >= t).length);
          const ruleStates = [];
          let prev = null;
          for (const v of values) {
            prev = thresholds.map((t, i) => badgeOn(v, n, t, prev ? prev[i] : undefined));
            ruleStates.push(prev.filter(Boolean).length);
          }
          for (const [states, acc] of [[rawStates, raw], [ruleStates, rule]]) {
            let fl = 0;
            for (let k = 1; k < states.length; k++) if (states[k] !== states[k - 1]) fl += 1;
            acc.flips += fl;
            if (fl) acc.flipping += 1;
          }
        }
      }
      totals[n] = { raw: raw.flips, rule: rule.flips, pairs };
      lines.push(`  ${String(n).padStart(4)}   ${String(items).padStart(5)}   ${`${raw.flips} / ${pairs} (${pct(raw.flips, pairs)}), ${raw.flipping}`.padEnd(54)}`
        + `${rule.flips} / ${pairs} (${pct(rule.flips, pairs)}), ${rule.flipping}`);
    }
    console.log(lines.join('\n'));
    for (const t of Object.values(totals)) expect(t.rule).toBeLessThan(t.raw);
    const app = totals[DEFAULT_NUM_SIMULATIONS];
    expect(app.rule / app.pairs).toBeLessThan(0.005);
  }, 120000);

  it(`same state, ${SEEDS} seeds, as the views draw it: listed battle rows change no more with the rule than with the top-6 cut, in under 5 % of the recomputes`, () => {
    let recomputes = 0;
    const changed = { rule: 0, bare: 0 };
    for (const [year, round] of RACES) {
      const st = raceAt(year, round, LAP);
      let prevBadges = null;
      let prev = null;
      for (let k = 0; k < SEEDS; k++) {
        const res = simulateRaceFinish({ ...st, seed: seedFrom('badge-list', year, round, LAP, k) });
        const badges = projectionBadges(res, prevBadges);
        const view = {
          rule: new Set(listedBattles({ ...res, badges }).map(battleKey)),
          bare: new Set(res.battles.filter((b) => b.prob >= 5).slice(0, 6).map(battleKey)),
        };
        if (prev) {
          recomputes += 1;
          for (const kind of ['rule', 'bare']) {
            const a = prev[kind];
            const b = view[kind];
            if (a.size !== b.size || [...a].some((x) => !b.has(x))) changed[kind] += 1;
          }
        }
        prev = view;
        prevBadges = badges;
      }
    }
    console.log(`listed battle rows changed between consecutive recomputes: rule ${pct(changed.rule, recomputes)}, `
      + `top-6 cut ${pct(changed.bare, recomputes)} (${recomputes} recomputes)`);
    expect(changed.rule).toBeLessThanOrEqual(changed.bare);
    expect(changed.rule / recomputes).toBeLessThan(0.05);
  }, 120000);

  it.skipIf(!hasCachedSession(2024, 16))('lap by lap through Monza 2024 (laps 10-50): fewer badge changes, fewer immediate reversals', () => {
    const raw = [];
    const rule = [];
    let prev = null;
    for (let lap = 10; lap <= 50; lap++) {
      const result = simulateRaceFinish(raceAt(2024, 16, lap));
      raw.push(rawBadges(result));
      prev = projectionBadges(result, prev);
      rule.push(prev);
    }
    // immediate reversals: a state that changes and changes back on the next lap
    const reversals = (states) => {
      let n = 0;
      const items = new Set();
      for (const st of states) { for (const d of Object.keys(st.podium)) items.add(`P:${d}`); for (const k of Object.keys(st.battles)) items.add(`B:${k}`); }
      const v = (st, item) => (item.startsWith('P:') ? !!st.podium[item.slice(2)] : (st.battles[item.slice(2)]?.level ?? 0));
      for (let i = 2; i < states.length; i++) {
        for (const item of items) {
          const a = v(states[i - 2], item);
          const b = v(states[i - 1], item);
          const c = v(states[i], item);
          if (a !== b && a === c) n += 1;
        }
      }
      return n;
    };
    const r = countFlips(raw);
    const h = countFlips(rule);
    // where the changes are: podium badges; battles returned on both laps; a
    // battle entering or leaving the engine's output (the pairs within 4
    // positions), the same with and without the rule
    const split = (states) => {
      const out = { podium: 0, listed: 0, membership: 0 };
      for (let i = 1; i < states.length; i++) {
        const [a, b] = [states[i - 1], states[i]];
        for (const d of new Set([...Object.keys(a.podium), ...Object.keys(b.podium)])) {
          if (!!a.podium[d] !== !!b.podium[d]) out.podium += 1;
        }
        for (const k of new Set([...Object.keys(a.battles), ...Object.keys(b.battles)])) {
          const la = a.battles[k]?.level ?? 0;
          const lb = b.battles[k]?.level ?? 0;
          if (la === lb) continue;
          if (a.battles[k] && b.battles[k]) out.listed += 1; else out.membership += 1;
        }
      }
      return out;
    };
    const sr = split(raw);
    const sh = split(rule);
    const lines = [
      'Monza 2024 laps 10-50, one projection per lap (simulateRaceFinish default seed, from the clock): every change',
      'here also carries new data (a lap, stops), so it is not all Monte Carlo noise.',
      `  badge changes: raw ${r.flips}, rule ${h.flips}; immediate reversals (A -> B -> A on consecutive laps): raw ${reversals(raw)}, rule ${reversals(rule)}`,
      `  of which podium: raw ${sr.podium}, rule ${sh.podium}; battle listed on both laps: raw ${sr.listed}, rule ${sh.listed}; `
        + `battle entering / leaving the pairs within 4 positions: raw ${sr.membership}, rule ${sh.membership}`,
    ];
    console.log(lines.join('\n'));
    expect(h.flips).toBeLessThanOrEqual(r.flips);
    expect(reversals(rule)).toBeLessThanOrEqual(reversals(raw));
  }, 120000);
});
