// The Monte Carlo jobs in the store: one writer of raceProjection, a seeded projection
// (same state -> same result) of 1,000 runs with badge states, and a what-if
// whose plan runs from the lap in progress against a baseline on the same
// random numbers (identical plan -> every difference exactly 0).
// Without Worker (Node) the simulation client runs each job synchronously.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { useF1Store, simulationJob } = await import('../store/useF1Store.js');
const { badgeOn, projectionBadges, PODIUM_BADGE_PCT } = await import('../utils/simulationClient.js');
const { DEFAULT_NUM_SIMULATIONS } = await import('../utils/raceSimulation.js');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { causalKey } = await import('../utils/strategyViews.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const store = () => useF1Store.getState();
const INITIAL = store();

const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;

/** Lap-mode Monza 2024 at currentLap: setting the race situation runs the projection. */
function monzaAt(currentLap, extra = {}) {
  const lapTimes = monza.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  const raceSituationData = extractRaceSituationFeatures({
    lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: offset,
  });
  useF1Store.setState({
    ...INITIAL,
    year: 2024,
    round: 16,
    sessionType: 'R',
    loadedSessionType: 'R',
    sessionData: monza,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: offset,
    maxLap: MAX_LAP,
    totalRaceLaps: null,
    currentLap,
    totalFrames: 0,
    currentTime: 0,
    raceSituationData,
    ...extra,
  });
  return raceSituationData;
}

const stints = (...parts) => {
  // parts: [compound, lapStart] pairs -> contiguous Strategy Simulator stints
  const out = parts.map(([compound, lapStart]) => ({ compound, lapStart }));
  return out.map((s, i) => ({ ...s, length: (out[i + 1]?.lapStart ?? MAX_LAP + 1) - s.lapStart }));
};

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
});

// ─────────────────────────────────────────────────────────────────────────
describe('one writer of raceProjection', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.jsx?$/.test(e.name)) files.push(p);
    }
  };
  walk(SRC);

  it('outside the store no source file writes it; in the store one set() writes a computed value', () => {
    const writers = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      // an object key `raceProjection: value`, the old setter, or an assignment
      // (a `const raceProjection = useF1Store(...)` reader is not a write)
      const re = /(?<!(?:const|let|var)\s+)raceProjection\s*(?::|=(?![=>]))\s*([^,;\n}]+)|setRaceProjection/g;
      for (const m of src.matchAll(re)) {
        const value = (m[1] || '').trim();
        if (value === 'null') continue; // a clear (session load, reset, clock jump)
        writers.push(`${rel}: ${m[0].trim()}`);
      }
    }
    console.log('raceProjection writers (clears excluded):', writers);
    expect(writers).toEqual(['store/useF1Store.js: raceProjection: request.result']);
    const panel = fs.readFileSync(path.join(SRC, 'components/visualizations/RacePredictionPanel.jsx'), 'utf8');
    expect(panel).not.toMatch(/simulateRaceFinish|setRaceProjection/);
    expect(panel).toMatch(/useF1Store\(\(s\) => s\.raceProjection\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!haveMonza)('the store: seeded projection, 1,000 runs, badges (Monza 2024)', () => {
  it('the race situation runs it; repeated requests with the same state are not run again', () => {
    monzaAt(30);
    const p = store().raceProjection;
    expect(p).not.toBeNull();
    expect(p.numSimulations).toBe(DEFAULT_NUM_SIMULATIONS);
    expect(p.numSimulations).toBeGreaterThanOrEqual(1000);
    expect(p.computedAtLap).toBe(30);
    expect(p.computedAtNow).toBe(store().getSessionNow());
    expect(p.seed).toBe(simulationJob(store()).seed);
    store().computeRaceProjection();
    store().computeRaceProjection({ replace: true });
    expect(store().raceProjection).toBe(p); // same inputs: the held one, not a rerun
  });

  it('same state -> same result: a fresh run of the same state is identical', () => {
    const rsd = monzaAt(30);
    const a = store().raceProjection;
    // equal inputs under a new identity: run again
    useF1Store.setState({ raceSituationData: { ...rsd } });
    const b = store().raceProjection;
    expect(b).not.toBe(a);
    expect(b.seed).toBe(a.seed);
    expect(b.projections).toEqual(a.projections);
    expect(b.battles).toEqual(a.battles);
    expect(b.risks).toEqual(a.risks);
    expect(b.badges).toEqual(a.badges);
    // another clock, another seed
    monzaAt(31);
    expect(store().raceProjection.seed).not.toBe(a.seed);
  });

  it('the seed follows what is known, not every replay frame', () => {
    const lapTimes = monza.lap_times;
    const offset = computeSessionTimeOffset(lapTimes);
    const replay = (t) => ({ ...INITIAL, year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R',
      sessionData: monza, trackStatus: monza.track_status, sessionTimeOffset: offset, maxLap: MAX_LAP,
      currentLap: 30, totalFrames: 10000, currentTime: t - offset, maxTime: 1e6, frameDt: 0.4,
      raceSituationData: { driverFeatures: { VER: {}, LEC: {} } } });
    // a 0.4 s frame step around lap 30 in which nothing completes, and one in which a lap completes
    const t30 = resolveSessionNow({ currentLap: 30, lapTimes }) + 20;
    let quiet = null;
    let busy = null;
    for (let t = t30; t < t30 + 80 && (quiet == null || busy == null); t += 0.4) {
      const same = causalKey(lapTimes, t, monza.track_status) === causalKey(lapTimes, t + 0.4, monza.track_status);
      if (same && quiet == null) quiet = t;
      if (!same && busy == null) busy = t;
    }
    expect(simulationJob(replay(quiet)).seed).toBe(simulationJob(replay(quiet + 0.4)).seed);
    expect(simulationJob(replay(busy)).seed).not.toBe(simulationJob(replay(busy + 0.4)).seed);
  });

  it('badges: Wilson interval + hysteresis against the projection held at the earlier clock', () => {
    monzaAt(29);
    const prev = store().raceProjection;
    monzaAt(30, { raceProjection: prev });
    const p = store().raceProjection;
    const job = simulationJob(store());
    const ctx = { driverFeatures: job.params.driverFeatures, currentLap: job.currentLap, maxLap: job.params.maxLap };
    expect(p.badges).toEqual(projectionBadges(p, prev.badges, ctx));
    for (const row of p.projections) {
      expect(p.badges.podium[row.driver])
        .toBe(badgeOn(row.podiumProb, p.numSimulations, PODIUM_BADGE_PCT, prev.badges.podium[row.driver]));
    }
    // the risk rows every view reads are the chained ones
    expect(p.risks).toEqual(p.badges.risks);
    expect(Array.isArray(p.badges.risks)).toBe(true);
  });

  it('the race length is the race\'s lap count (live: totalRaceLaps), not the furthest lap seen', () => {
    monzaAt(30, { maxLap: 30, totalRaceLaps: MAX_LAP });
    expect(simulationJob(store()).params.maxLap).toBe(MAX_LAP);
    expect(store().raceProjection).not.toBeNull(); // with maxLap 30 there would be no lap left
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe.skipIf(!haveMonza)('what-if in the store (Monza 2024, lap 12, LEC)', () => {
  const run = (plan, baseline = null) => {
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: baseline });
    store().runSimulation();
    return store().simulatorResult;
  };
  const STOP15 = () => stints(['MEDIUM', 1], ['HARD', 16]);
  const STOP25 = () => stints(['MEDIUM', 1], ['HARD', 26]);
  const TWO = () => stints(['MEDIUM', 1], ['HARD', 16], ['MEDIUM', 36]);

  it('identical plan -> every difference exactly 0', () => {
    monzaAt(12);
    const r = run(STOP15(), { label: 'A', stints: STOP15() });
    expect(r.delta).toEqual({ position: 0, podium: 0, points: 0 });
    expect(Object.is(r.delta.position, 0)).toBe(true);
    expect(r.simProjection).toEqual(r.baselineProjection);
    console.log('identical plan (stop lap 15 HARD vs itself):', JSON.stringify(r.delta));
  });

  it('plan A != plan B; the plan after the current lap is applied, each planned stop made and charged', () => {
    monzaAt(12);
    const a = run(STOP15());
    const b = run(STOP25());
    const ab = run(STOP25(), { label: 'stop 15', stints: STOP15() });
    const two = run(TWO(), { label: 'stop 15', stints: STOP15() });
    console.log('E[pos] stop 15:', a.simProjection.expectedPos, '| stop 25:', b.simProjection.expectedPos,
      '| stop 25 vs stop 15 delta:', JSON.stringify(ab.delta), '| two stops vs stop 15 delta:', JSON.stringify(two.delta));
    expect(a.simProjection).not.toEqual(b.simProjection);
    expect(ab.delta.position).not.toBe(0);
    // planned stops are made in every simulation (none from the stop model)
    expect(ab.simProjection.pitStopsRemaining).toEqual({ mean: 1, sd: 0, median: 1, range: [1, 1] });
    expect(two.simProjection.pitStopsRemaining).toEqual({ mean: 2, sd: 0, median: 2, range: [2, 2] });
    // and each one costs time: a second stop loses places against the one-stop plan
    expect(two.delta.position).toBeLessThan(0);
    // the comparison is paired: the baseline is the same in both
    expect(ab.baselineProjection).toEqual(two.baselineProjection);
    expect(ab.baselineProjection).toEqual(a.simProjection);
  });

  it('without a saved baseline the baseline is the stop model: the race projection\'s row', () => {
    monzaAt(12);
    const r = run(STOP15());
    const row = store().raceProjection.projections.find((p) => p.driver === 'LEC');
    expect(r.baselineProjection).toEqual(row);
    expect(r.seed).toBe(store().raceProjection.seed);
    expect(r.computedAtNow).toBe(store().getSessionNow());
    expect(r.baselineLabel).toBeNull();
  });

  it('planned stops on laps already run are ignored (the past is the race\'s)', () => {
    monzaAt(30);
    // LEC's real race: one stop; a plan whose only stop is in the past = no further stop
    const past = run(stints(['MEDIUM', 1], ['HARD', 16]));
    const none = run(stints(['HARD', 1]));
    expect(past.plan).toEqual([{ lap: 15, compound: 'HARD' }]);
    expect(past.simProjection).toEqual(none.simProjection);
    expect(past.simProjection.pitStopsRemaining.mean).toBe(0);
  });
});
