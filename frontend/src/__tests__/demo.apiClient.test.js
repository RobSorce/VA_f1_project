// V12, the static demo seen from the store's side (utils/apiClient.js,
// utils/demoData.js, utils/demoMode.js): with no backend every data call of
// the store is answered from frontend/public/data (gzip JSON decoded with
// DecompressionStream), with the backend's answer shape; the model features
// reject with "Requires the local backend"; a backend that answers keeps
// the old behaviour (its errors reach the caller and trip the banner); a
// run-time demo leaves when /api/health answers again.
// fetch serves the files of public/data from disk; axios is a mock whose
// behaviour each test sets.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { hasCachedSession, loadCachedSession, hasCachedFrames, loadCachedFrames } from './helpers/cachedSession.js';
import { pyRoundInt } from '../utils/pcaSelectionStats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../public/data');
const ROOT = 'http://pages.test/VA_f1_project/data/';

const backend = { mode: 'down', calls: [] };
const netError = () => Object.assign(new Error('Network Error'), { isAxiosError: true });
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: {} } });
async function answer(method, url, cfg) {
  backend.calls.push([method, url]);
  if (backend.mode === 'down') throw netError();
  if (backend.mode === 'pages') throw httpError(404);
  if (backend.mode === 'proxy') throw httpError(500);
  // 'up': healthy backend, its routes answer; 'error500': healthy, the route fails
  if (url === '/health') return { data: { status: 'healthy' } };
  if (backend.mode === 'error500') throw httpError(500);
  return { data: { live: true, url, cfg } };
}
let interceptor = null;
vi.mock('axios', () => {
  const instance = {
    get: vi.fn((url, cfg) => answer('GET', url, cfg).then((r) => { interceptor?.(r); return r; })),
    post: vi.fn((url, body) => answer('POST', url, body).then((r) => { interceptor?.(r); return r; })),
    interceptors: { response: { use: vi.fn((ok) => { interceptor = ok; }) } },
  };
  return { default: { create: vi.fn(() => instance) } };
});

const fetched = [];
globalThis.fetch = vi.fn(async (url) => {
  fetched.push(String(url));
  const rel = String(url).startsWith(ROOT) ? String(url).slice(ROOT.length) : null;
  const file = rel && path.join(DATA, rel);
  if (!file || !fs.existsSync(file)) return new Response('Not Found', { status: 404 });
  return new Response(fs.readFileSync(file), { status: 200, headers: { 'Content-Type': rel.endsWith('.gz') ? 'application/gzip' : 'application/json' } });
});

const api = await import('../utils/apiClient.js');
const { useDemoMode, BACKEND_ONLY_TEXT, BACKEND_RECHECK_MS, DEMO_BUILD, isBackendOnlyError } = await import('../utils/demoMode.js');
const { setDemoDataRoot, demoDataUrl, decodeDemoBytes } = await import('../utils/demoData.js');

const readData = (rel) => {
  const b = fs.readFileSync(path.join(DATA, rel));
  return JSON.parse((rel.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8'));
};
const HAS_DATA = fs.existsSync(path.join(DATA, 'manifest.json'));
const MANIFEST = HAS_DATA ? readData('manifest.json') : { races: [], seasons: [] };
const health = { ok: 0, fail: [] };
api.setHealthReporter(() => { health.ok += 1; }, (m) => { health.fail.push(m); });

let clock = 1_000_000;
beforeEach(() => {
  clock += 10 * BACKEND_RECHECK_MS; // past every probe / recheck window
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  useDemoMode.setState({ active: false, source: null, reason: null });
  backend.calls.length = 0;
  fetched.length = 0;
  health.ok = 0;
  health.fail.length = 0;
  setDemoDataRoot(ROOT);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('demo answers', () => {
  it('every API function of apiClient.js has its demo answer (same name)', async () => {
    const { DEMO_ANSWERS } = await import('../utils/demoData.js');
    const fns = Object.entries(api).filter(([k, v]) => typeof v === 'function' && k !== 'setHealthReporter').map(([k]) => k);
    expect(fns.length).toBeGreaterThan(30);
    for (const k of fns) if (k !== 'analyzeTSNESelection') expect(typeof DEMO_ANSWERS[k], k).toBe('function');
    expect(Object.keys(DEMO_ANSWERS).sort()).toEqual(fns.filter((k) => k !== 'analyzeTSNESelection').sort());
  });
});

describe('demo data files', () => {
  it('the data URL is BASE_URL + data/ (tests: overridden), gzip and plain bytes both decode', async () => {
    setDemoDataRoot(null);
    expect(demoDataUrl('manifest.json')).toBe(`${import.meta.env.BASE_URL}data/manifest.json`);
    setDemoDataRoot(ROOT);
    const obj = { a: [1, 2.5, null], s: 'x' };
    const raw = Buffer.from(JSON.stringify(obj));
    expect(await decodeDemoBytes(zlib.gzipSync(raw))).toEqual(obj);   // served as application/gzip (GitHub Pages)
    expect(await decodeDemoBytes(raw)).toEqual(obj);                  // already decoded (Content-Encoding: gzip)
    expect(DEMO_BUILD).toBe(false);                                   // the test build is not the demo build
  });
});

describe.skipIf(!HAS_DATA)('V12: no backend -> the static demo answers', () => {
  it('a failed call with no /api/health switches to the demo; the store\'s race load is answered from public/data', async () => {
    backend.mode = 'down';
    const seasons = await api.getSeasons();
    expect(seasons).toEqual({ seasons: [...MANIFEST.seasons].sort((a, b) => a - b) });
    expect(useDemoMode.getState()).toMatchObject({ active: true, source: 'fallback' });
    expect(backend.calls).toEqual([['GET', '/seasons'], ['GET', '/health']]);
    expect(health.fail).toEqual([]); // no "Backend unreachable" banner: the demo answered

    const race = MANIFEST.races[0];
    backend.calls.length = 0;
    const schedule = await api.getSchedule(race.year);
    expect(schedule.events.map((e) => e.RoundNumber).sort((a, b) => a - b))
      .toEqual(MANIFEST.races.filter((r) => r.year === race.year).map((r) => r.round).sort((a, b) => a - b));
    expect((await api.getSchedule(2019)).events).toEqual([]);
    const session = await api.getSession(race.year, race.round, 'R');
    expect(session.lap_times.length).toBe(race.lap_rows);
    expect((await api.getDrivers(race.year, race.round)).drivers).toEqual(session.driver_info);
    expect(await api.getCircuit(race.year, race.round)).toEqual(session.circuit_info);
    expect((await api.getStrategy(race.year, race.round, 'R')).strategies).toEqual(session.tyre_strategy);
    expect((await api.getResults(race.year, race.round)).results).toEqual(session.race_results);
    expect((await api.getWeather(race.year, race.round)).weather).toEqual(session.weather_data);
    const one = session.lap_times[0].Driver;
    expect((await api.getLapTimes(race.year, race.round, one)).lap_times.every((l) => l.Driver === one)).toBe(true);
    const frames = await api.getFrames(race.year, race.round, 'R');
    expect(frames.frames.length).toBe(race.frames_in_demo);
    expect(frames.demo_frame_step).toBe(MANIFEST.frame_step);
    const analytics = readData(`${race.year}_${race.round}_R/analytics.json.gz`);
    expect(await api.getSectors(race.year, race.round, 'R')).toEqual(analytics.sectors);
    expect(await api.getConsistency(race.year, race.round, 'R')).toEqual(analytics.consistency);
    expect(await api.getSpeedRankings(race.year, race.round, 'R')).toEqual(analytics.speed_rankings);
    expect(await api.getChampionship(race.year)).toEqual(readData(`championship_${race.year}.json.gz`));
    expect(backend.calls).toEqual([]); // in demo mode nothing is asked of the backend
    // every answer is a copy: changing it does not change the next answer
    session.lap_times.length = 0;
    expect((await api.getSession(race.year, race.round)).lap_times.length).toBe(race.lap_rows);
  });

  it('the session answer is the backend\'s cached payload; the frames are every frame_step-th cached frame', async () => {
    backend.mode = 'down';
    for (const race of MANIFEST.races) {
      if (!hasCachedSession(race.year, race.round)) continue;
      // tyre_strategy: the API rebuilds it from the lap rows (main.py
      // load_session; backend/tests/test_export_demo_data.py compares the
      // export with load_session); every other key is the cache file's
      const { tyre_strategy: _cachedStrategy, ...cached } = loadCachedSession(race.year, race.round);
      const { tyre_strategy: strategy, ...demoSession } = await api.getSession(race.year, race.round);
      expect(demoSession, `${race.year} R${race.round}`).toEqual(cached);
      expect(strategy.length).toBeGreaterThan(0);
      if (!hasCachedFrames(race.year, race.round)) continue;
      const full = loadCachedFrames(race.year, race.round).frames;
      const demo = (await api.getFrames(race.year, race.round)).frames;
      expect(demo.length).toBe(Math.ceil(full.length / MANIFEST.frame_step));
      for (const k of [0, 1, Math.floor(demo.length / 2), demo.length - 1]) {
        const src = full[k * MANIFEST.frame_step];
        expect(demo[k].t).toBe(src.t);
        for (const [code, d] of Object.entries(src.drivers)) {
          expect(demo[k].drivers[code].x).toBe(d.x == null ? d.x : pyRoundInt(d.x)); // Python round(): ties to even
          expect(demo[k].drivers[code].tyre).toBe(d.tyre);
          expect(demo[k].drivers[code].lap).toBe(d.lap);
        }
      }
    }
  });

  it('PCA biplot (post-race and at a replay clock) and the lasso analysis come from the demo, computed in the browser', async () => {
    backend.mode = 'down';
    const race = MANIFEST.races[0];
    const post = await api.getPCAEmbeddings();
    expect(post).toEqual(readData('pca/embeddings.json.gz'));
    expect(backend.calls).toEqual([['GET', '/pca/embeddings'], ['GET', '/health']]); // the first call found no backend
    backend.calls.length = 0;
    const session = await api.getSession(race.year, race.round);
    const laps = session.lap_times;
    const mid = laps.find((l) => l.LapNumber === Math.round(race.laps / 2) && l.Position === 1).Time;
    const at = await api.getPCAEmbeddings({ year: race.year, round: race.round, session_now: mid });
    expect(at.current_race).toMatchObject({ year: race.year, round: race.round, available: true, as_of: 'session_now', excluded_from_fit: true });
    expect(at.current_race.n_points).toBeGreaterThan(0);
    const live = at.points.filter((p) => p.as_of === 'session_now');
    expect(live.length).toBe(at.current_race.n_points);
    const ids = live.slice(0, 5).map((p) => p.id);
    const res = await api.analyzePCASelection(ids, { year: race.year, round: race.round, session_now: mid });
    expect(res.n_selected).toBe(5);
    expect(res.current_race).toMatchObject({ n_selected: 5, as_of: 'session_now' });
    expect(res.feature_importance.length).toBeGreaterThan(0);
    expect(res.statistics.label).toBe('Descriptive differences, not a test');
    // the former name is the same function
    expect(api.analyzeTSNESelection).toBe(api.analyzePCASelection);
    // a race the demo does not hold: the post-race biplot, said so
    const other = await api.getPCAEmbeddings({ year: 2023, round: 1, session_now: 100 });
    expect(other.current_race).toEqual({ year: 2023, round: 1, available: false, reason: 'race not in the static demo' });
    expect(backend.calls).toEqual([]);
  });

  it('degradation of a brushed range is fitted in the browser (predictions.degradation_response port)', async () => {
    backend.mode = 'down';
    const race = MANIFEST.races[0];
    const s = await api.getSession(race.year, race.round);
    const winner = s.race_results.find((r) => Number(r.Position) === 1).Abbreviation;
    const res = await api.predictDegradation({ year: race.year, round: race.round, drivers: [winner], lap_start: 1, lap_end: race.laps });
    expect(res.driver).toBe(winner);
    expect(res.session_type).toBe('R');
    expect(res.all_drivers.length).toBe(1);
    expect(res.stints.length).toBeGreaterThan(0);
  });

  it('model-only features and races outside the demo reject with "Requires the local backend"', async () => {
    backend.mode = 'down';
    await api.getSeasons();
    backend.calls.length = 0;
    const cases = [
      [() => api.predictLSTM({ year: 2024, round: 16, driver: 'LEC' }), 'forecast'],
      [() => api.queryGemini({ question: 'x' }), 'gemini'],
      [() => api.getTelemetry(2024, 16, 'LEC', 10), 'telemetry'],
      [() => api.getLiveStatus(), 'live'],
      [() => api.startMockReplay(2024, 16), 'live'],
      [() => api.getSession(2023, 1, 'R'), 'session'],
      [() => api.getSession(MANIFEST.races[0].year, MANIFEST.races[0].round, 'Q'), 'session'],
      [() => api.getFrames(2023, 1), 'session'],
      [() => api.predictDegradation({ year: 2023, round: 1, drivers: ['VER'], lap_start: 1, lap_end: 9 }), 'session'],
    ];
    for (const [call, feature] of cases) {
      const err = await call().then(() => null, (e) => e);
      expect(isBackendOnlyError(err), feature).toBe(true);
      expect(err.feature).toBe(feature);
      expect(err.message.startsWith(`${BACKEND_ONLY_TEXT}: `)).toBe(true);
    }
    const err = await api.getSession(2023, 1).catch((e) => e);
    expect(err.message).toContain('is not in the static demo (demo races: ');
    expect(health.fail).toEqual([]);
    expect(backend.calls).toEqual([]);
  });

  it('GitHub Pages (404 on /api) and the Vite proxy with no backend (500) also fall back', async () => {
    for (const mode of ['pages', 'proxy']) {
      useDemoMode.setState({ active: false, source: null, reason: null });
      clock += 10 * BACKEND_RECHECK_MS;
      backend.mode = mode;
      expect((await api.getSeasons()).seasons.length).toBe(MANIFEST.seasons.length);
      expect(useDemoMode.getState().active, mode).toBe(true);
      expect(health.fail, mode).toEqual([]);
    }
  });
});

describe.skipIf(!HAS_DATA)('a backend that answers keeps the old behaviour', () => {
  it('answers come from the backend; a route error reaches the caller and trips the banner (5xx), no demo', async () => {
    backend.mode = 'up';
    expect(await api.getSeasons()).toMatchObject({ live: true, url: '/seasons' });
    expect(useDemoMode.getState().active).toBe(false);
    backend.mode = 'error500';
    const err = await api.getSession(2024, 16).catch((e) => e);
    expect(err.response.status).toBe(500);
    expect(useDemoMode.getState().active).toBe(false);
    expect(health.fail).toEqual(['Request failed with status code 500']);
  });

  it('a run-time demo asks /api/health again after BACKEND_RECHECK_MS and leaves when the backend is back', async () => {
    backend.mode = 'down';
    await api.getSeasons();
    expect(useDemoMode.getState().active).toBe(true);
    backend.mode = 'up';
    backend.calls.length = 0;
    clock += BACKEND_RECHECK_MS - 1;             // too early: still the demo, nothing asked
    expect((await api.getSeasons()).live).toBeUndefined();
    expect(backend.calls).toEqual([]);
    clock += 2;
    expect(await api.getSeasons()).toMatchObject({ live: true });
    expect(useDemoMode.getState().active).toBe(false);
    expect(backend.calls).toEqual([['GET', '/health'], ['GET', '/seasons']]);
  });
});
