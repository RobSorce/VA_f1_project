/**
 * The API answers of the static demo (utils/demoMode.js), read from the
 * files of public/data/ that backend/scripts/export_demo_data.py writes.
 *
 * DEMO_ANSWERS has one function per data function of utils/apiClient.js,
 * with the same arguments and the same answer shape as the backend route:
 *  - seasons, schedule, session (and the routes read from it: drivers,
 *    circuit, strategy, results, weather, lap times), replay frames,
 *    analytics (sectors, consistency, speed rankings), championship: the
 *    backend's own answers, exported as they are (frames: every
 *    manifest.frame_step-th frame);
 *  - PCA biplot at a replay clock and the lasso analysis: computed here with
 *    utils/pcaSelectionStats.js (the backend's pca_compute, ported; parity
 *    test src/__tests__/demo.pcaSelectionStats.test.js);
 *  - degradation fits of a brushed lap range: degradationResponse below
 *    (the backend's api/routers/predictions.py degradation_response over
 *    utils/degradation.js stintFits; parity test as above);
 *  - LSTM forecast, telemetry, live timing, raw positions, the sessions
 *    that are not demo races: BackendOnlyError.
 *
 * Files ending in .gz are gzip JSON, decompressed in the browser with
 * DecompressionStream (a server that already sent them decoded, with
 * Content-Encoding: gzip, is recognised by the missing gzip magic bytes).
 * Small files and the session payloads of the demo races are kept in memory;
 * the replay frames are read on each request (the store keeps them).
 */
import { BackendOnlyError } from './demoMode';
import { analyzeSelection, embeddingsAt, pyFixed } from './pcaSelectionStats';
import { stintFits, FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS } from './degradation';

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};

// ── Files ───────────────────────────────────────────────────────────────────

let _root = null;
const _cache = new Map();

/**
 * Where the data files are served: `${BASE_URL}data/` (vite base: '/' in
 * development, the Pages path in the demo build). setDemoDataRoot overrides
 * it (an absolute URL in node scripts and tests) and empties the cache.
 */
export function setDemoDataRoot(root) {
  _root = root;
  _cache.clear();
}

export function demoDataUrl(rel) {
  const base = _root ?? `${ENV.BASE_URL || '/'}data/`;
  return `${base.endsWith('/') ? base : `${base}/`}${rel}`;
}

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** JSON of a data file's bytes (gzip when they start with the gzip magic). */
export async function decodeDemoBytes(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isGzip(b)) {
    const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
    b = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(b));
}

async function fetchJson(rel) {
  const url = demoDataUrl(rel);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Static demo data not found: ${rel} (HTTP ${res.status})`);
  return decodeDemoBytes(new Uint8Array(await res.arrayBuffer()));
}

/** A data file, read once (concurrent readers share the request). */
function cached(rel) {
  if (!_cache.has(rel)) {
    const p = fetchJson(rel);
    _cache.set(rel, p);
    p.catch(() => { if (_cache.get(rel) === p) _cache.delete(rel); });
  }
  return _cache.get(rel);
}

/** public/data/manifest.json: the demo races, seasons, frame step, files. */
export const demoManifest = () => cached('manifest.json');

const typeCode = (t) => String(t || '').trim().toUpperCase() || 'R';
const raceDir = (year, round) => `${Number(year)}_${Number(round)}_R`;

/** The manifest entry of a demo race (session type R), or null. */
export async function demoRace(year, round, type = 'R') {
  if (typeCode(type) !== 'R') return null;
  const m = await demoManifest();
  return (m.races || []).find((r) => r.year === Number(year) && r.round === Number(round)) || null;
}

function demoRaceList(m) {
  return (m.races || []).map((r) => `${r.year} R${r.round} ${r.race_name}`).join(', ');
}

/** The demo race or a BackendOnlyError naming the races the demo has. */
async function requireRace(year, round, type = 'R') {
  const race = await demoRace(year, round, type);
  if (race) return race;
  const m = await demoManifest();
  throw new BackendOnlyError('session', `${year} R${round} ${typeCode(type)} is not in the static demo `
    + `(demo races: ${demoRaceList(m)})`);
}

/** GET /api/session payload of a demo race (BackendOnlyError for any other session). */
export async function demoSession(year, round, type = 'R') {
  await requireRace(year, round, type);
  return cached(`${raceDir(year, round)}/session.json.gz`);
}

async function demoAnalytics(year, round, type) {
  await requireRace(year, round, type);
  return cached(`${raceDir(year, round)}/analytics.json.gz`);
}

const backendOnly = (feature, detail) => async () => { throw new BackendOnlyError(feature, detail); };

// ── Degradation (api/routers/predictions.py degradation_response) ──────────

/** Fitted tyre-only loss since the stint's first lap that places the pit lap
 * (predictions.py PIT_DEG_THRESHOLD_S; parity-tested). */
export const PIT_DEG_THRESHOLD_S = 1.5;
/** Undercut window around the projected pit lap, laps before / after
 * (predictions.py UNDERCUT_WINDOW_LAPS_BEFORE / _AFTER; parity-tested). */
export const UNDERCUT_WINDOW_LAPS_BEFORE = 3;
export const UNDERCUT_WINDOW_LAPS_AFTER = 2;
const RACE_SESSION_TYPES = ['R', 'S'];

const signed4 = (x) => { const s = pyFixed(x, 4); return s.startsWith('-') ? s : `+${s}`; };

function raceLastLap(lapRows) {
  let last = null;
  for (const lap of lapRows) {
    const n = lap && typeof lap === 'object' ? lap.LapNumber : null;
    if (typeof n === 'number' && Number.isFinite(n)) last = last == null ? Math.trunc(n) : Math.max(last, Math.trunc(n));
  }
  return last;
}

/** predictions.py projected_pit_lap: [lap, reason]. */
function projectedPitLap(fit, lastLap, race) {
  if (!race) return [null, 'Not a race session: no pit lap projected (race strategy only).'];
  const { slope } = fit;
  if (slope == null) {
    return [null, `Fewer than ${MIN_FIT_LAPS} clean laps of this stint in the range: no fit, no pit lap projected.`];
  }
  if (!(slope > 0)) {
    return [null, `Fitted degradation ${signed4(slope)} s/lap (fuel-corrected) is not positive: `
      + 'no tyre loss to pit for, no pit lap projected.'];
  }
  const lap = Math.ceil(fit.start_lap + PIT_DEG_THRESHOLD_S / slope);
  if (lastLap != null && lap > lastLap) {
    return [null, `At ${signed4(slope)} s/lap the fitted loss reaches ${PIT_DEG_THRESHOLD_S} s only on lap ${lap}, `
      + `after the last lap (${lastLap}): no pit lap projected.`];
  }
  return [lap, null];
}

/** A utils/degradation.js stintFits row in the backend's field names. */
const snakeFit = (f) => ({
  driver: f.driver,
  stint_number: f.stintNumber,
  compound: f.compound,
  start_lap: f.startLap,
  end_lap: f.endLap,
  slope: f.slope,
  raw_slope: f.rawSlope,
  intercept: f.intercept,
  n: f.n,
  residual_sigma: f.residualSigma,
  slope_std_err: f.slopeStdErr,
  tyre_life_min: f.tyreLifeMin,
  tyre_life_max: f.tyreLifeMax,
});

function driverEntry(driver, primary, stints, lapStart, lapEnd, lastLap, race) {
  const [opt, why] = projectedPitLap(primary, lastLap, race);
  return {
    driver,
    stint_number: primary.stint_number,
    compound: primary.compound,
    stint_start_lap: primary.start_lap,
    stint_end_lap: primary.end_lap,
    slope: primary.raw_slope,
    raw_slope: primary.raw_slope,
    slope_fuel_corrected: primary.slope,
    degradation_per_lap: primary.slope,
    fuel_correction_per_lap: FUEL_EFFECT_S_PER_LAP,
    intercept: primary.intercept,
    n: primary.n,
    residual_sigma: primary.residual_sigma,
    slope_std_err: primary.slope_std_err,
    lap_start: lapStart,
    lap_end: lapEnd,
    optimal_pit_lap: opt,
    optimal_pit_lap_reason: why,
    pit_threshold_s: PIT_DEG_THRESHOLD_S,
    stints,
  };
}

/**
 * POST /api/predict/degradation from the lap rows of a race (the backend's
 * degradation_response): per requested driver the stint fits of the clean
 * laps in [lapStart, lapEnd] completed at sessionNow (null = the whole
 * race), the projected pit lap of each, the primary fit (latest fitted stint
 * of the first driver that has one) at the top level.
 */
export function degradationResponse(lapRows, drivers, lapStart, lapEnd, sessionNow = null, sessionType = 'R') {
  const code = typeCode(sessionType);
  const race = RACE_SESSION_TYPES.includes(code);
  const rows = Array.isArray(lapRows) ? lapRows : [];
  const lastLap = raceLastLap(rows);
  const now = sessionNow == null ? Infinity : sessionNow;
  const results = [];
  const cleanLaps = {};
  for (const driver of drivers || []) {
    const fits = stintFits(rows, { sessionNow: now, driver, lapStart, lapEnd }).map(snakeFit);
    let n = 0;
    for (const f of fits) n += f.n;
    cleanLaps[driver] = n;
    const stints = fits.map((f) => {
      const [opt, why] = projectedPitLap(f, lastLap, race);
      return { ...f, optimal_pit_lap: opt, optimal_pit_lap_reason: why };
    });
    const fitted = stints.filter((s) => s.slope != null);
    if (fitted.length) results.push(driverEntry(driver, fitted[fitted.length - 1], stints, lapStart, lapEnd, lastLap, race));
  }
  if (results.length) {
    const primary = results[0];
    const optimal = primary.optimal_pit_lap;
    return {
      ...primary,
      undercut_window: optimal != null
        ? [Math.max(1, optimal - UNDERCUT_WINDOW_LAPS_BEFORE), optimal + UNDERCUT_WINDOW_LAPS_AFTER]
        : null,
      all_drivers: results.map((r) => ({ ...r })),
      lap_count_per_driver: cleanLaps,
      session_now: sessionNow,
      session_type: code,
      reason: null,
    };
  }
  return {
    driver: null,
    stint_number: null,
    compound: null,
    stint_start_lap: null,
    stint_end_lap: null,
    slope: null,
    raw_slope: null,
    slope_fuel_corrected: null,
    degradation_per_lap: null,
    fuel_correction_per_lap: FUEL_EFFECT_S_PER_LAP,
    intercept: null,
    n: null,
    residual_sigma: null,
    slope_std_err: null,
    lap_start: lapStart,
    lap_end: lapEnd,
    optimal_pit_lap: null,
    optimal_pit_lap_reason: null,
    pit_threshold_s: PIT_DEG_THRESHOLD_S,
    stints: [],
    undercut_window: null,
    all_drivers: [],
    lap_count_per_driver: cleanLaps,
    session_now: sessionNow,
    session_type: code,
    reason: `No driver has a stint with at least ${MIN_FIT_LAPS} clean laps in [${lapStart}, ${lapEnd}] `
      + '(clean = green, not lap 1, no pit in-lap or out-lap, no slow outlier). Brush a wider window or '
      + 'pick a driver with race laps in it.',
  };
}

// ── PCA ─────────────────────────────────────────────────────────────────────

/** GET /api/pca/embeddings[?year&round&session_now] (main.py get_pca_embeddings). */
export async function demoPCAEmbeddings(clock = null) {
  if (!clock || clock.year == null || clock.round == null) return cached('pca/embeddings.json.gz');
  const year = Number(clock.year);
  const round = Number(clock.round);
  const race = await demoRace(year, round);
  if (!race) {
    // pca_embeddings_at for a race it has no payload of: the post-race biplot
    const base = await cached('pca/embeddings.json.gz');
    return { ...base, current_race: { year, round, available: false, reason: 'race not in the static demo' } };
  }
  const [fitWithout, payload] = await Promise.all([
    cached(`pca/fit_without_${year}_${round}.json.gz`), demoSession(year, round),
  ]);
  return embeddingsAt(fitWithout, payload, year, round, race.race_name, clock.session_now ?? null);
}

/** POST /api/pca/analyze-selection (main.py analyze_pca_selection). */
export async function demoAnalyzeSelection(pointIds, opts = {}) {
  const [matrix, strategies] = await Promise.all([cached('pca/matrix.json.gz'), cached('pca/strategies.json.gz')]);
  let race = null;
  if (opts.year != null && opts.round != null) {
    const entry = await demoRace(opts.year, opts.round);
    race = {
      year: Number(opts.year),
      round: Number(opts.round),
      payload: entry ? await demoSession(opts.year, opts.round) : null,
      raceName: entry ? entry.race_name : null,
    };
  }
  return analyzeSelection({ pointIds, matrix, strategies, race, sessionNow: opts.session_now ?? null });
}

// ── The answers, one per apiClient data function ────────────────────────────

const sessionField = (field, key) => async (year, round, type = 'R') => {
  const p = await demoSession(year, round, type);
  return key ? { [key]: p[field] } : p[field];
};

const ANSWERS = {
  getSeasons: async () => {
    const m = await demoManifest();
    return { seasons: [...(m.seasons || [])].sort((a, b) => a - b) };
  },
  getSchedule: async (year) => {
    const m = await demoManifest();
    if (!(m.seasons || []).includes(Number(year))) return { year: Number(year), events: [] };
    return cached(`schedule_${Number(year)}.json.gz`);
  },
  getSession: (year, round, type = 'R') => demoSession(year, round, type),
  getLapTimes: async (year, round, driver) => {
    const p = await demoSession(year, round);
    const laps = p.lap_times || [];
    return { lap_times: driver ? laps.filter((lt) => lt.Driver === driver) : laps };
  },
  getTelemetry: backendOnly('telemetry'),
  getCircuit: sessionField('circuit_info'),
  getStrategy: sessionField('tyre_strategy', 'strategies'),
  getDrivers: sessionField('driver_info', 'drivers'),
  getResults: sessionField('race_results', 'results'),
  getPositions: backendOnly('positions'),
  getFrames: async (year, round, type = 'R') => {
    await requireRace(year, round, type);
    return fetchJson(`${raceDir(year, round)}/frames.json.gz`);
  },
  getWeather: sessionField('weather_data', 'weather'),
  getReplayData: backendOnly('positions'),
  getPCAEmbeddings: (clock = null) => demoPCAEmbeddings(clock),
  analyzePCASelection: (pointIds, opts = {}) => demoAnalyzeSelection(pointIds, opts),
  predictLSTM: backendOnly('forecast'),
  predictDegradation: async (data = {}) => {
    const type = data.session_type ?? 'R';
    const p = await demoSession(data.year, data.round, type);
    return degradationResponse(p.lap_times || [], data.drivers || [], data.lap_start, data.lap_end,
      data.session_now ?? null, type);
  },
  getSectors: async (year, round, type = 'R') => (await demoAnalytics(year, round, type)).sectors,
  getConsistency: async (year, round, type = 'R') => (await demoAnalytics(year, round, type)).consistency,
  getSpeedRankings: async (year, round, type = 'R') => (await demoAnalytics(year, round, type)).speed_rankings,
  getChampionship: async (year) => {
    const m = await demoManifest();
    const rel = `championship_${Number(year)}.json.gz`;
    if (!m.files || !m.files[rel]) throw new BackendOnlyError('session', `the ${year} championship`);
    return cached(rel);
  },
  getLiveStatus: backendOnly('live'),
  getLiveSnapshot: backendOnly('live'),
  getLiveFrames: backendOnly('live'),
  connectSignalR: backendOnly('live'),
  disconnectSignalR: backendOnly('live'),
  loadLiveFullSession: backendOnly('live'),
  getMockSessions: backendOnly('live'),
  startMockReplay: backendOnly('live'),
  stopMockReplay: backendOnly('live'),
  startOpenF1Telemetry: backendOnly('live'),
  stopOpenF1Telemetry: backendOnly('live'),
  getOpenF1Status: backendOnly('live'),
  healthCheck: async () => ({ status: 'demo' }),
};

/** A copy the caller may change: the backend sends new objects on every
 * request, the demo keeps its files in memory (the frames are read anew). */
const fresh = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export const DEMO_ANSWERS = Object.freeze(Object.fromEntries(Object.entries(ANSWERS).map(([name, fn]) => [
  name, name === 'getFrames' ? fn : async (...args) => fresh(await fn(...args)),
])));
