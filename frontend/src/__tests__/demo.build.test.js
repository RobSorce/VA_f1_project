// The demo build (npm run build:demo = vite build --mode demo, the
// GitHub Pages site): demo mode is on from the start, nothing is ever asked
// of /api (axios here throws if called), every answer comes from
// frontend/public/data, and the demo build never leaves demo mode.
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
  const fail = (method) => vi.fn((url) => { axiosCalls.push([method, url]); throw new Error(`axios ${method} ${url} in a demo build`); });
  return { default: { create: vi.fn(() => ({ get: fail('GET'), post: fail('POST'), interceptors: { response: { use: vi.fn() } } })) } };
});
globalThis.fetch = vi.fn(async (url) => {
  const rel = String(url).slice(ROOT.length);
  const file = path.join(DATA, rel);
  if (!String(url).startsWith(ROOT) || !fs.existsSync(file)) return new Response('Not Found', { status: 404 });
  return new Response(fs.readFileSync(file));
});

const HAS_DATA = fs.existsSync(path.join(DATA, 'manifest.json'));

describe.skipIf(!HAS_DATA)('demo build', () => {
  it('demo mode from the start; the race, the biplot and the lasso analysis without any /api request', async () => {
    const { DEMO_BUILD, useDemoMode, deactivateDemo, BACKEND_ONLY_TEXT } = await import('../utils/demoMode.js');
    const { setDemoDataRoot } = await import('../utils/demoData.js');
    const api = await import('../utils/apiClient.js');
    setDemoDataRoot(ROOT);
    expect(DEMO_BUILD).toBe(true);
    expect(useDemoMode.getState()).toMatchObject({ active: true, source: 'build' });
    const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
    const race = manifest.races[manifest.races.length - 1];
    expect((await api.getSeasons()).seasons.length).toBe(manifest.seasons.length);
    const session = await api.getSession(race.year, race.round, 'R');
    expect(session.lap_times.length).toBe(race.lap_rows);
    expect((await api.getFrames(race.year, race.round, 'R')).frames.length).toBe(race.frames_in_demo);
    const emb = await api.getPCAEmbeddings({ year: race.year, round: race.round, session_now: null });
    const own = emb.points.filter((p) => p.year === race.year && p.round === race.round);
    expect(own.length).toBe(emb.current_race.n_points);
    const res = await api.analyzePCASelection(own.slice(0, 4).map((p) => p.id), { year: race.year, round: race.round, session_now: null });
    expect(res.n_selected).toBe(4);
    await expect(api.predictLSTM({ year: race.year, round: race.round, driver: own[0].driver })).rejects.toThrow(BACKEND_ONLY_TEXT);
    deactivateDemo();                    // a demo build stays a demo
    expect(useDemoMode.getState().active).toBe(true);
    expect(axiosCalls).toEqual([]);
  });
});
