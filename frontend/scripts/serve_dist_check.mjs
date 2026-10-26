#!/usr/bin/env node
/**
 * Headless check of the static demo build (V12): serves frontend/dist the
 * way GitHub Pages does and runs, against that server, the requests the
 * dashboard makes to load a race, its PCA biplot and a lasso analysis,
 * without any backend.
 *
 *   npm run build:demo && npm run check:demo
 *   node scripts/serve_dist_check.mjs [--dist DIR] [--report FILE]
 *
 * 1. Pages-like static server (in this process, closed at the end): the files
 *    of dist/ under the base path of the build (read from dist/index.html),
 *    404 for anything else, /api included; .gz files as application/gzip with
 *    no Content-Encoding (Pages does not decode them: the page does, with
 *    DecompressionStream). Every request is logged.
 * 2. The page: index.html and every asset it references answer 200 under
 *    the base path; the bundle holds the demo data layer (data file names).
 * 3. The fetches: src/utils/apiClient.js loaded through Vite in mode 'demo'
 *    (the build's own config and env, nothing served by Vite), its data URL
 *    checked equal to the path the page fetches (BASE_URL + data/), then
 *    pointed at the static server and asked, for every demo race, what the
 *    store asks when a race is loaded (seasons, schedule, drivers, session,
 *    circuit, strategy, frames, sectors, consistency, speed rankings,
 *    championship), the biplot (post-race, before the start, mid-race), the
 *    lasso analysis of a mid-race selection, a degradation fit, and the LSTM
 *    forecast (must say it needs the local backend).
 * 4. The same requests from a host that sends the .gz files decoded
 *    (Content-Encoding: gzip), the other way a static host may serve them.
 * Exit code 1 on any failure. The report is printed (and written to --report).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DIST = path.resolve(opt('--dist', path.join(FRONTEND, 'dist')));
const REPORT = opt('--report', null);

const lines = [];
const failures = [];
const log = (s = '') => { lines.push(s); console.log(s); };
const check = (ok, what) => { log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); return ok; };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.gz': 'application/gzip',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

/** A GitHub-Pages-like static server of DIST under base; decoded = send .gz with Content-Encoding. */
function pagesServer(base, { decoded = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const send = (status, body, headers = {}) => {
      requests.push({ method: req.method, url, status, bytes: body ? body.length : 0 });
      res.writeHead(status, headers);
      res.end(body);
    };
    if (!url.startsWith(base)) { send(404, Buffer.from('Not Found'), { 'Content-Type': 'text/plain' }); return; }
    let rel = url.slice(base.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      send(404, Buffer.from('Not Found'), { 'Content-Type': 'text/plain' });
      return;
    }
    const ext = path.extname(file);
    const body = fs.readFileSync(file);
    if (decoded && ext === '.gz') {
      send(200, body, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    } else {
      send(200, body, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

const ms = (t0) => `${Math.round(performance.now() - t0)} ms`;

async function timed(label, fn) {
  const t0 = performance.now();
  try {
    const out = await fn();
    return { out, ms: ms(t0) };
  } catch (e) {
    check(false, `${label}: ${e?.message || e}`);
    return { out: null, ms: ms(t0), error: e };
  }
}

/** The store's requests for one demo race; returns a summary line. */
async function loadRace(api, race, { full = true } = {}) {
  const { year, round } = race;
  const tag = `${year} R${round} ${race.race_name}`;
  const parts = [];
  const r = async (label, fn, test) => {
    const res = await timed(`${tag} ${label}`, fn);
    if (res.out != null && test) check(test(res.out), `${tag} ${label}`);
    parts.push(`${label} ${res.ms}`);
    return res.out;
  };
  await r('schedule', () => api.getSchedule(year), (s) => s.events.some((e) => e.RoundNumber === round));
  await r('drivers', () => api.getDrivers(year, round), (d) => d.drivers.length === race.drivers);
  const session = await r('session', () => api.getSession(year, round, 'R'), (s) => s.lap_times.length === race.lap_rows);
  if (!session) return parts.join(', ');
  if (full) {
    await r('circuit', () => api.getCircuit(year, round), (c) => Array.isArray(c.corners) || typeof c === 'object');
    await r('strategy', () => api.getStrategy(year, round, 'R'), (s) => s.strategies.length > 0);
    await r('frames', () => api.getFrames(year, round, 'R'), (f) => f.frames.length === race.frames_in_demo);
    await r('sectors', () => api.getSectors(year, round, 'R'), (x) => x && typeof x === 'object');
    await r('consistency', () => api.getConsistency(year, round, 'R'), (x) => x && typeof x === 'object');
    await r('speed rankings', () => api.getSpeedRankings(year, round, 'R'), (x) => x && typeof x === 'object');
    await r('championship', () => api.getChampionship(year), (x) => x && typeof x === 'object');
  }
  const laps = session.lap_times;
  const midLap = Math.round(race.laps / 2);
  const mid = laps.find((l) => l.LapNumber === midLap && l.Position === 1)?.Time
    ?? laps.find((l) => l.LapNumber === midLap)?.Time;
  await r('biplot before the start', () => api.getPCAEmbeddings({ year, round, session_now: 0 }),
    (e) => e.current_race.available && e.current_race.n_points === 0);
  const emb = await r(`biplot at lap ${midLap}`, () => api.getPCAEmbeddings({ year, round, session_now: mid }),
    (e) => e.current_race.available && e.current_race.n_points > 0 && e.current_race.as_of === 'session_now');
  if (emb) {
    const live = emb.points.filter((p) => p.as_of === 'session_now').map((p) => p.id);
    const finished = emb.points.filter((p) => p.as_of === 'post-race').slice(0, 3).map((p) => p.id);
    const ids = [...live.slice(0, Math.ceil(live.length / 2)), ...finished];
    await r(`lasso of ${ids.length} points`, () => api.analyzePCASelection(ids, { year, round, session_now: mid }),
      (a) => a.n_selected === ids.length && a.feature_importance.length > 0 && a.current_race.as_of === 'session_now');
  }
  if (full) {
    const winner = (session.race_results || []).find((x) => Number(x.Position) === 1)?.Abbreviation;
    await r('degradation fit', () => api.predictDegradation({
      year, round, drivers: [winner], lap_start: 1, lap_end: race.laps, session_now: mid,
    }), (d) => d.driver === winner || d.reason != null);
    const lstm = await api.predictLSTM({ year, round, driver: winner }).then(() => null, (e) => e);
    check(Boolean(lstm?.backendOnly) && /^Requires the local backend/.test(lstm.message),
      `${tag} LSTM forecast: "${lstm?.message}"`);
  }
  return parts.join(', ');
}

async function main() {
  log('Static demo check (frontend/scripts/serve_dist_check.mjs)');
  if (!check(fs.existsSync(path.join(DIST, 'index.html')), `dist present (${path.relative(FRONTEND, DIST) || '.'})`)) return;
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u));
  const first = assets.find((u) => /\/assets\//.test(u)) || '';
  const BASE = first.slice(0, first.indexOf('assets/'));
  if (!check(BASE.startsWith('/'), `demo build: absolute base path in index.html (${BASE || 'none'}; npm run build:demo)`)) return;
  log(`base path: ${BASE}`);

  // ── 1-2. the page ──
  const pages = await pagesServer(BASE);
  const page = await fetch(`${pages.origin}${BASE}`);
  check(page.status === 200 && /text\/html/.test(page.headers.get('content-type')), `GET ${BASE} -> ${page.status}`);
  let bundle = '';
  for (const a of assets) {
    const res = await fetch(`${pages.origin}${a}`);
    const body = await res.text();
    check(res.status === 200 && body.length > 0, `GET ${a} -> ${res.status} (${body.length} bytes)`);
    if (a.endsWith('.js')) bundle += body;
  }
  const workers = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /worker.*\.js$/.test(f));
  for (const w of workers) {
    const res = await fetch(`${pages.origin}${BASE}assets/${w}`);
    check(res.status === 200 && bundle.includes(w), `worker ${w} referenced by the bundle and served -> ${res.status}`);
  }
  for (const name of ['manifest.json', 'pca/matrix.json.gz', 'pca/strategies.json.gz', 'session.json.gz', 'frames.json.gz']) {
    check(bundle.includes(name), `bundle holds the demo data layer ("${name}")`);
  }
  const api404 = await fetch(`${pages.origin}/api/seasons`);
  check(api404.status === 404, `GET /api/seasons on the Pages host -> ${api404.status} (no backend there)`);

  // ── 3. the fetches, through the app's own modules (Vite, mode 'demo') ──
  process.env.DEMO_BASE = BASE;
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: FRONTEND, mode: 'demo', logLevel: 'error', appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const demoMode = await vite.ssrLoadModule('/src/utils/demoMode.js');
    const demoData = await vite.ssrLoadModule('/src/utils/demoData.js');
    const api = await vite.ssrLoadModule('/src/utils/apiClient.js');
    check(demoMode.DEMO_BUILD === true && demoMode.useDemoMode.getState().active, 'mode demo: demo mode on from the start');
    check(demoData.demoDataUrl('manifest.json') === `${BASE}data/manifest.json`,
      `the page fetches ${demoData.demoDataUrl('manifest.json')} (BASE_URL + data/)`);
    demoData.setDemoDataRoot(`${pages.origin}${BASE}data/`);
    const t0 = performance.now();
    const seasons = await api.getSeasons();
    const manifest = await (await fetch(`${pages.origin}${BASE}data/manifest.json`)).json();
    check(JSON.stringify(seasons.seasons) === JSON.stringify([...manifest.seasons].sort((a, b) => a - b)),
      `seasons ${JSON.stringify(seasons.seasons)}`);
    for (const race of manifest.races) {
      const summary = await loadRace(api, race);
      log(`  ${race.year} R${race.round} ${race.race_name}: ${summary}`);
    }
    log(`all demo races loaded in ${ms(t0)} (Pages-like host, gzip decoded with DecompressionStream)`);
    // /api is never a file of the site, under the base "/" too
    const outside = pages.requests.filter((q) => !q.url.startsWith(BASE) || q.url.startsWith('/api/'));
    const apiHits = pages.requests.filter((q) => q.url.startsWith('/api') && q.url !== '/api/seasons');
    const dataReqs = pages.requests.filter((q) => q.url.startsWith(`${BASE}data/`));
    check(apiHits.length === 0, `requests to /api by the app: ${apiHits.length}`);
    check(outside.length === 1, `requests outside ${BASE}: ${outside.length} (the probe of /api/seasons above)`);
    check(dataReqs.every((q) => q.status === 200), `data requests: ${dataReqs.length}, all 200`);
    const bytes = dataReqs.reduce((s, q) => s + q.bytes, 0);
    log(`data transferred: ${(bytes / 1e6).toFixed(2)} MB in ${dataReqs.length} requests`);
    const byFile = new Map();
    for (const q of dataReqs) byFile.set(q.url, (byFile.get(q.url) || 0) + 1);
    log(`distinct data files: ${byFile.size}; files asked more than once: ${[...byFile].filter(([, n]) => n > 1).map(([u, n]) => `${u.slice(BASE.length)} x${n}`).join(', ') || 'none'}`);

    // ── 4. a host that sends the .gz files decoded ──
    const decoded = await pagesServer(BASE, { decoded: true });
    demoData.setDemoDataRoot(`${decoded.origin}${BASE}data/`);
    const race = manifest.races[0];
    const summary = await loadRace(api, race, { full: false });
    log(`  Content-Encoding host, ${race.year} R${race.round}: ${summary}`);
    check(decoded.requests.every((q) => q.status === 200), `Content-Encoding host: ${decoded.requests.length} requests, all 200`);
    decoded.server.close();
  } finally {
    await vite.close();
    pages.server.close();
  }
}

await main().catch((e) => { check(false, `unexpected: ${e?.stack || e}`); });
log('');
log(failures.length ? `FAILED: ${failures.length} check(s)` : 'PASSED: every check');
if (REPORT) {
  fs.mkdirSync(path.dirname(path.resolve(REPORT)), { recursive: true });
  fs.writeFileSync(path.resolve(REPORT), `${lines.join('\n')}\n`);
}
process.exit(failures.length ? 1 : 0);
