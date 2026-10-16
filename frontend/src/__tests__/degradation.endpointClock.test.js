// The brushed degradation fit the store holds and the Tyre
// Degradation chart agree at every replay clock. The store sends the clock
// (session_now) and the session on screen with every request, and re-asks
// whenever the fit's inputs change (brushFitKey: the clean laps of the
// range, whose slow-outlier status a later lap of a stint still growing can
// change), not only when the clamped lap end moves. The bodies the store
// sent are then answered by the real endpoint (backend
// api/routers/predictions.py predict_degradation, rows from the processed
// cache, executed in the backend venv) and compared with the chart's
// per-stint fits (stintFits of utils/degradation.js, the rows of
// tyreDegradationView) at each sampled clock and at the race end: every
// number to 1e-6. Monza 2024; skips without the cache or the venv. With
// WRITE_EVIDENCE=1 the measurement is also written to
// docs/evidence/g1_store_endpoint_vs_chart.txt.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  const fx = () => globalThis.__g1EndpointFx;
  mocked.setHealthReporter = vi.fn();
  mocked.getSession = vi.fn(async () => fx().session);
  mocked.getFrames = vi.fn(async () => fx().frames);
  // the bodies are answered by the real endpoint after the replay (below)
  mocked.predictDegradation = vi.fn(async () => ({ slope: 0, reason: null }));
  return mocked;
});
vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const fx = {};
globalThis.__g1EndpointFx = fx;
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const { stintFits } = await import('../utils/degradation.js');
const { tyreDegradationView, brushFitKey } = await import('../utils/views/degradationViews.js');
const { leaderLapEndTime } = await import('../utils/raceTime.js');
const {
  hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames,
} = await import('./helpers/cachedSession.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../backend');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const HAVE = hasCachedSession(2024, 16) && hasCachedFrames(2024, 16) && !!PYTHON;
// The store's re-request debounce (useF1Store.js DEGRADATION_REFRESH_MS)
const DEGRADATION_REFRESH_MS = 150;
const TOL = 1e-6;
// Brushes checked (driver, [lo, hi]): BOT and ALB 5-15 (both froze a fit of
// an earlier clock), PIA 10-25 (spans a stop) and longer windows
const BRUSHES = [
  ['BOT', [5, 15]], ['ALB', [5, 15]], ['PIA', [10, 25]], ['LEC', [10, 25]],
  ['NOR', [17, 38]], ['HAM', [20, 40]], ['VER', [30, 53]], ['SAI', [1, 53]],
];
// Endpoint row key -> stintFits key
const FIT_KEYS = {
  stint_number: 'stintNumber', compound: 'compound', start_lap: 'startLap', end_lap: 'endLap',
  slope: 'slope', raw_slope: 'rawSlope', intercept: 'intercept', n: 'n',
  residual_sigma: 'residualSigma', slope_std_err: 'slopeStdErr',
  tyre_life_min: 'tyreLifeMin', tyre_life_max: 'tyreLifeMax',
};

const PY = `
import asyncio, json, sys
import api.main as main
from data.extractors.fastf1_extractor import FastF1Extractor
def no_fastf1(*a, **k):
    raise AssertionError('FastF1 must not be called for a cached session')
main.raw_session_cache[main.get_cache_key(2024, 16, 'R')] = object()
main.get_raw_session = no_fastf1
FastF1Extractor.get_session = no_fastf1
from api.routers.predictions import DegradationRequest, predict_degradation
bodies = json.load(sys.stdin)
async def run():
    return [await predict_degradation(DegradationRequest(**b)) for b in bodies]
out = asyncio.run(run())
print(json.dumps([{'all_drivers': o['all_drivers'], 'lap_count_per_driver': o['lap_count_per_driver'],
                   'session_now': o.get('session_now')} for o in out]))
`;

const OUT = [];
afterAll(() => {
  if (!OUT.length || !process.env.WRITE_EVIDENCE) return;
  fs.writeFileSync(path.resolve(HERE, '../../../docs/evidence/g1_store_endpoint_vs_chart.txt'), `${OUT.join('\n')}\n`);
});

describe.skipIf(!HAVE)('the store\'s brushed fit = the chart at every replay clock (Monza 2024)', () => {
  const store = () => useF1Store.getState();
  let lapTimes;

  beforeAll(async () => {
    fx.session = loadCachedSession(2024, 16);
    fx.frames = loadCachedFrames(2024, 16);
    lapTimes = fx.session.lap_times;
    store().resetSession();
    useF1Store.setState({ year: 2024, round: 16, sessionType: 'R', isLiveMode: false });
    await store().loadSession();
    // Only the brushed fit is under test: the other clock-driven analytics stay idle
    useF1Store.setState({
      computeRaceSituation: () => {}, updateRivalContext: () => {},
    });
  }, 120000);

  it('every sampled clock and the race end: endpoint(body the store holds) == stintFits at the clock, to 1e-6', async () => {
    vi.useFakeTimers();
    const frames = store().frameData.frames;
    const lfm = store().lapFrameMap;
    // Clocks: the start, a third and two thirds of every leader lap, then the last frame (race end)
    const samples = [];
    for (let lap = 1; lap <= 53; lap++) {
      const a = lfm[lap];
      const b = lfm[lap + 1] ?? frames.length - 1;
      if (a == null) continue;
      for (const f of [0, 1 / 3, 2 / 3]) samples.push(Math.floor(a + (b - a) * f));
    }
    samples.push(frames.length - 1);

    const checks = []; // { driver, range, now, body (index into bodies), frame }
    const bodies = [];
    const bodyIndex = new Map();
    for (const [driver, range] of BRUSHES) {
      api.predictDegradation.mockClear();
      useF1Store.setState({
        brushLapRange: range, focusDriver: driver, selectedDrivers: [driver],
        _degradationRequest: null, degradationRegression: null,
      });
      store().setCurrentFrameIndex(0);
      vi.advanceTimersByTime(DEGRADATION_REFRESH_MS);
      await store().fetchDegradationRegression({ drivers: [driver], lap_start: range[0], lap_end: range[1] });
      for (const i of samples) {
        store().setCurrentFrameIndex(i);
        vi.advanceTimersByTime(DEGRADATION_REFRESH_MS);
        for (let k = 0; k < 5; k++) await Promise.resolve();
        const now = store().getSessionNow();
        const req = store()._degradationRequest;
        const calls = api.predictDegradation.mock.calls;
        const held = calls.length ? calls[calls.length - 1][0] : null;
        if (!req || req.lap_end_used < range[0] || !held) continue; // nothing of the range completed: no request
        if (!bodyIndex.has(held)) { bodyIndex.set(held, bodies.length); bodies.push(held); }
        checks.push({ driver, range, now, body: bodyIndex.get(held), frame: i });
        // the body the store holds is the clock's inputs (D6)
        expect(brushFitKey(lapTimes, [driver], {
          sessionNow: held.session_now == null ? Infinity : held.session_now, lapStart: range[0], lapEnd: range[1],
        }), `${driver} ${range} frame ${i}`).toBe(brushFitKey(lapTimes, [driver], { sessionNow: now, lapStart: range[0], lapEnd: range[1] }));
        expect(held.session_type).toBe('R');
        expect([held.year, held.round]).toEqual([2024, 16]);
      }
    }
    vi.useRealTimers();

    // The real endpoint on every held body
    const res = spawnSync(PYTHON, ['-c', PY], {
      cwd: BACKEND, input: JSON.stringify(bodies), encoding: 'utf8', maxBuffer: 1 << 28,
    });
    if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
    const answers = JSON.parse(res.stdout.trim().split('\n').pop());
    expect(answers.length).toBe(bodies.length);

    let rows = 0;
    let fitted = 0;
    let maxDiff = 0;
    let rangeApplied = 0;
    let atRaceEnd = 0;
    const examples = [];
    for (const c of checks) {
      const ans = answers[c.body];
      const chart = stintFits(lapTimes, { sessionNow: c.now, driver: c.driver, lapStart: c.range[0], lapEnd: c.range[1] });
      const view = tyreDegradationView(lapTimes, c.driver, { sessionNow: c.now, lapRange: c.range });
      if (view.rangeApplied) {
        rangeApplied++;
        // the chart draws exactly these stint rows
        for (const st of view.stints) {
          const row = chart.find((r) => r.stintNumber === st.stintNumber);
          expect(st.cleanCount).toBe(row.n);
        }
      }
      if (c.now === Infinity) atRaceEnd++;
      expect(ans.lap_count_per_driver[c.driver]).toBe(chart.reduce((a, r) => a + r.n, 0));
      if (!ans.all_drivers.length) {
        expect(chart.every((r) => r.slope == null), `${c.driver} ${c.range} no fit`).toBe(true);
        continue;
      }
      const got = ans.all_drivers[0].stints;
      expect(got.length, `${c.driver} ${c.range} at ${c.now}`).toBe(chart.length);
      got.forEach((g, k) => {
        const j = chart[k];
        rows++;
        if (g.slope != null) fitted++;
        for (const [py, js] of Object.entries(FIT_KEYS)) {
          const a = g[py];
          const b = j[js];
          if (typeof a === 'number' && typeof b === 'number') {
            maxDiff = Math.max(maxDiff, Math.abs(a - b));
            expect(Math.abs(a - b), `${c.driver} ${c.range} at ${c.now} ${py}`).toBeLessThanOrEqual(TOL);
          } else {
            expect(a, `${c.driver} ${c.range} at ${c.now} ${py}`).toEqual(b);
          }
        }
      });
      // the case that froze: ALB 5-15 at the first sampled clock after
      // the leader's laps 30, 40 and 50, and at the race end
      const first = (l) => checks.find((x) => x.driver === 'ALB' && x.now >= leaderLapEndTime(lapTimes, l));
      if (c.driver === 'ALB' && ([30, 40, 50].some((l) => first(l) === c) || c.now === Infinity)) {
        examples.push(`ALB 5-15 at ${c.now === Infinity ? 'race end' : `${c.now.toFixed(3)} s`}: endpoint `
          + `${got.map((g) => `${g.compound} ${g.slope?.toFixed(6)} n=${g.n}`).join(' | ')} = chart `
          + `${chart.map((r) => `${r.compound} ${r.slope?.toFixed(6)} n=${r.n}`).join(' | ')}`);
      }
    }
    const perBrush = BRUSHES.map(([d, r]) => `${d} ${r.join('-')}: ${new Set(checks.filter((c) => c.driver === d).map((c) => c.body)).size} requests`);
    OUT.push(`G1 endpoint vs chart, Monza 2024: ${BRUSHES.length} brushes x ${samples.length} sampled clocks; `
      + `${checks.length} clock checks (${atRaceEnd} at the race end, ${rangeApplied} with the brush applied in the chart), `
      + `${bodies.length} bodies answered by the endpoint; ${rows} stint rows compared, ${fitted} fitted; `
      + `max |endpoint - chart| = ${maxDiff.toExponential(2)}`);
    OUT.push(...perBrush, ...examples.slice(0, 6));
    console.log(OUT.join('\n'));
    expect(atRaceEnd).toBe(BRUSHES.length);
    expect(fitted).toBeGreaterThan(100);
  }, 600000);
});
