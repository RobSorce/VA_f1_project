// The static demo through the real store (store/useF1Store.js with the
// real utils/apiClient.js in a demo build, the data files of
// frontend/public/data read from disk by fetch): the session menu's seasons
// and schedule, a race load (session, frames, circuit, strategy, analytics),
// the PCA biplot at the replay clock and a lasso analysis land in the store
// as with the backend; the LSTM forecast and a race outside the demo end
// with nothing on screen but the store's error text "Requires the local
// backend: ...". No request reaches /api (axios throws if called).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.stubEnv('MODE', 'demo');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../public/data');
const ROOT = 'http://pages.test/VA_f1_project/data/';
const axiosCalls = [];
vi.mock('axios', () => {
  const fail = (method) => vi.fn((url) => { axiosCalls.push([method, url]); return Promise.reject(new Error(`axios ${method} ${url}`)); });
  return { default: { create: vi.fn(() => ({ get: fail('GET'), post: fail('POST'), interceptors: { response: { use: vi.fn() } } })) } };
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
const fetched = [];
globalThis.fetch = vi.fn(async (url) => {
  fetched.push(String(url));
  const rel = String(url).slice(ROOT.length);
  const file = path.join(DATA, rel);
  if (!String(url).startsWith(ROOT) || !fs.existsSync(file)) return new Response('Not Found', { status: 404 });
  return new Response(fs.readFileSync(file));
});

const HAS_DATA = fs.existsSync(path.join(DATA, 'manifest.json'));
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

describe.skipIf(!HAS_DATA)('the store on the static demo', () => {
  it('seasons, schedule, a race, its biplot at the clock and a lasso analysis; model features say they need the backend', async () => {
    const { setDemoDataRoot } = await import('../utils/demoData.js');
    setDemoDataRoot(ROOT);
    const { useF1Store } = await import('../store/useF1Store.js');
    const { BACKEND_ONLY_TEXT, useDemoMode } = await import('../utils/demoMode.js');
    const store = () => useF1Store.getState();
    const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
    const race = manifest.races.find((r) => r.year === 2024 && r.round === 16) || manifest.races[0];
    expect(useDemoMode.getState().active).toBe(true);

    await store().fetchSeasons();
    expect(store().seasons).toEqual([...manifest.seasons].sort((a, b) => b - a));
    await store().fetchSchedule(race.year);
    expect(store().schedule.map((e) => e.RoundNumber)).toContain(race.round);

    store().setYear(race.year);
    store().setRound(race.round);
    store().setSessionType('R');
    await store().loadSession();
    await settle();
    expect(store().error).toBe(null);
    expect(store().sessionData.lap_times.length).toBe(race.lap_rows);
    expect(store().frameData.frames.length).toBe(race.frames_in_demo);
    expect(store().frameDt).toBeCloseTo(manifest.frame_dt_s, 9);
    expect(store().circuitInfo).toBeTruthy();
    expect(store().sectorRankings).toBeTruthy();
    expect(store().consistencyData).toBeTruthy();
    expect(store().speedRankings).toBeTruthy();

    await store().loadPCAEmbeddings();
    await settle();
    const emb = store().pcaEmbeddings;
    expect(emb.points.length).toBeGreaterThan(100);
    expect(emb.current_race).toMatchObject({ year: race.year, round: race.round, available: true });

    const ids = emb.points.filter((p) => p.year !== race.year || p.round !== race.round).slice(0, 8).map((p) => p.id);
    await store().fetchPCAAnalysis(ids);
    await settle();
    expect(store().pcaAnalysisError).toBe(null);
    expect(store().pcaStrategyAnalysis.n_selected).toBe(8);
    expect(store().pcaStrategyAnalysis.feature_importance.length).toBeGreaterThan(0);

    // the LSTM forecast: nothing lands, nothing stays loading
    const driver = store().sessionData.race_results[0].Abbreviation;
    store().setFocusDriver?.(driver);
    await store().triggerPrediction(driver, 10);
    await settle();
    expect(store().predictionLoading).toBe(false);
    expect(store().lstmPredictions?.[driver]).toBeUndefined();

    // a race outside the demo: the store's error names the backend
    store().setYear(2023);
    store().setRound(1);
    await store().loadSession();
    await settle();
    expect(store().error.startsWith(`${BACKEND_ONLY_TEXT}: 2023 R1 R is not in the static demo`)).toBe(true);

    expect(axiosCalls).toEqual([]);
    expect(fetched.every((u) => u.startsWith(ROOT))).toBe(true);
    console.log(`demo store: ${new Set(fetched).size} data files read, 0 /api requests; `
      + `${race.year} R${race.round}: ${store().frameData?.frames?.length ?? race.frames_in_demo} frames, `
      + `${emb.points.length} biplot points, lasso of ${ids.length}`);
  }, 120000);
});
