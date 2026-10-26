import axios from 'axios';
import {
  BACKEND_RECHECK_MS, activateDemo, deactivateDemo, isDemoActive, isFallbackDemo,
} from './demoMode';
import { DEMO_ANSWERS } from './demoData';

const API_BASE = '/api';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
});

// Health reporter — injected by the store after both modules are loaded
// so we don't create a circular import. See useF1Store.js.
let _healthReporter = { ok: () => {}, fail: () => {} };
export const setHealthReporter = (ok, fail) => { _healthReporter = { ok, fail }; };

// Any answer of the backend = reachable. Failures are reported by demoable
// below (network errors + 5xx trip the global banner, 4xx do not), after the
// static demo had its chance to answer.
client.interceptors.response.use(
  (response) => { _healthReporter.ok(); return response; },
  (error) => Promise.reject(error),
);

// ── Static demo (utils/demoMode.js, utils/demoData.js) ─────────────────
// In a demo build every call is answered from public/data. Otherwise a call
// that fails with no answer, a 404 (a static host such as GitHub Pages) or a
// 5xx (the Vite dev proxy answers 500 when nothing listens on :8000) asks
// GET /api/health; when that does not answer either, the app switches to the
// static demo and the call is answered from public/data. A run-time demo
// asks /api/health again at most every BACKEND_RECHECK_MS and leaves the
// demo when the backend is back.

// ASSUMPTION: a backend that has not answered /health in 3 s is not there;
// one probe answers every failure of the next 5 s (a burst of parallel
// requests asks once).
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_PROBE_TTL_MS = 5000;
let _probe = null;
let _lastRecheck = 0;

const mayBeUnreachable = (error) => {
  if (!error || error.backendOnly) return false;
  const status = error.response?.status;
  return !error.response || status === 404 || status >= 500;
};

/** True when GET /api/health answers {status: 'healthy'} (one probe per HEALTH_PROBE_TTL_MS). */
function backendAnswers() {
  const now = Date.now();
  if (!_probe || now - _probe.at >= HEALTH_PROBE_TTL_MS) {
    _probe = {
      at: now,
      promise: client.get('/health', { timeout: HEALTH_TIMEOUT_MS })
        .then((r) => r?.data?.status === 'healthy', () => false),
    };
  }
  return _probe.promise;
}

function reportFailure(error) {
  const isNetwork = !error?.response;
  const is5xx = error?.response && error.response.status >= 500;
  if (isNetwork || is5xx) _healthReporter.fail(error?.message || 'network error');
}

/**
 * The exported API call `name`: the backend (live) when it answers, else
 * the static demo's answer (DEMO_ANSWERS[name], same arguments, same shape;
 * a BackendOnlyError for what only the backend can do).
 */
function demoable(name, live) {
  const demo = DEMO_ANSWERS[name];
  if (typeof demo !== 'function') throw new Error(`utils/demoData.js has no demo answer for ${name}`);
  return async (...args) => {
    if (isDemoActive()) {
      const recheck = isFallbackDemo() && Date.now() - _lastRecheck >= BACKEND_RECHECK_MS;
      if (!recheck) return demo(...args);
      _lastRecheck = Date.now();
      if (!(await backendAnswers())) return demo(...args);
      deactivateDemo();
    }
    try {
      return await live(...args);
    } catch (error) {
      if (!mayBeUnreachable(error) || (await backendAnswers())) {
        reportFailure(error);
        throw error;
      }
      _lastRecheck = Date.now();
      activateDemo(`${error?.message || 'no answer'}; GET ${API_BASE}/health did not answer`);
      return demo(...args);
    }
  };
}

// ── Session & Schedule ──────────────────────────────────────────────
export const getSeasons = demoable('getSeasons', () => client.get('/seasons').then((r) => r.data));
export const getSchedule = demoable('getSchedule', (year) => client.get(`/schedule/${year}`).then((r) => r.data));
export const getSession = demoable('getSession', (year, round, type = 'R') =>
  client.get(`/session/${year}/${round}`, { params: { session_type: type }, timeout: 600000 }).then((r) => r.data));

// ── Race Data ───────────────────────────────────────────────────────
export const getLapTimes = demoable('getLapTimes', (year, round, driver) => {
  const params = driver ? { driver } : {};
  return client.get(`/laptimes/${year}/${round}`, { params }).then((r) => r.data);
});
export const getTelemetry = demoable('getTelemetry', (year, round, driver, lap, sessionType = 'R') => {
  const params = { ...(lap ? { lap } : {}), session_type: sessionType };
  return client.get(`/telemetry/${year}/${round}/${driver}`, { params, timeout: 600000 }).then((r) => r.data);
});
export const getCircuit = demoable('getCircuit', (year, round) =>
  client.get(`/circuit/${year}/${round}`, { timeout: 600000 }).then((r) => r.data));
export const getStrategy = demoable('getStrategy', (year, round, type = 'R') =>
  client.get(`/strategy/${year}/${round}`, { params: { session_type: type }, timeout: 600000 }).then((r) => r.data));
export const getDrivers = demoable('getDrivers', (year, round) =>
  client.get(`/drivers/${year}/${round}`).then((r) => r.data));
export const getResults = demoable('getResults', (year, round) =>
  client.get(`/results/${year}/${round}`).then((r) => r.data));
// session_type as every session route takes it ('R' when the caller names none)
export const getPositions = demoable('getPositions', (year, round, type = 'R') =>
  client.get(`/positions/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data));
export const getFrames = demoable('getFrames', (year, round, type = 'R') =>
  client.get(`/frames/${year}/${round}`, { params: { session_type: type }, timeout: 600000 }).then((r) => r.data));
export const getWeather = demoable('getWeather', (year, round) =>
  client.get(`/weather/${year}/${round}`).then((r) => r.data));
export const getReplayData = demoable('getReplayData', (year, round, type = 'R') =>
  client.get(`/session/${year}/${round}/${type}/replay`).then((r) => r.data));

// ── PCA ──────────────────────────────────────────────────────────────
// clock {year, round, session_now}: that race's rows at session_now, on axes
// fitted without it (backend pca_compute.pca_embeddings_at); none = post-race
export const getPCAEmbeddings = demoable('getPCAEmbeddings', (clock = null) =>
  client.get('/pca/embeddings', clock ? { params: clock } : undefined).then((r) => r.data));
// Descriptive analysis of a lasso selection (Hedges' g, its 95% interval, N,
// random-selection baseline: backend pca_compute.analyze_selection). opts
// {year, round, session_now} ask for the rows of that race at session_now.
export const analyzePCASelection = demoable('analyzePCASelection', (pointIds, opts = {}) =>
  client.post('/pca/analyze-selection', { point_ids: pointIds, ...opts }).then((r) => r.data));
// Alias (former name, kept for one release): the same function as
// analyzePCASelection, as the backend keeps /tsne/analyze-selection as an alias route
export const analyzeTSNESelection = analyzePCASelection;

// ── Predictions ─────────────────────────────────────────────────────
// POST bodies carry session_type (D16; 'R' when the caller names none) and
// /degradation its session_now (session seconds or null, D6)
export const predictLSTM = demoable('predictLSTM', (data) =>
  client.post('/predict/lstm', { session_type: 'R', ...data }).then((r) => r.data));
export const predictDegradation = demoable('predictDegradation', (data) =>
  client.post('/predict/degradation', { session_type: 'R', session_now: null, ...data }).then((r) => r.data));

// ── Gemini ──────────────────────────────────────────────────────────
export const queryGemini = demoable('queryGemini', (data) =>
  client.post('/gemini/strategy', data).then((r) => r.data));

// ── Analytics ────────────────────────────────────────────────────────
// Every analytics / prediction call names the type of the session on screen
// (D16): session_type as a query parameter for GET, a body field for POST
// (store/useF1Store.js passes it); 'R' when a caller names none.
export const getSectors = demoable('getSectors', (year, round, type = 'R') =>
  client.get(`/analytics/sectors/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data));
export const getConsistency = demoable('getConsistency', (year, round, type = 'R') =>
  client.get(`/analytics/consistency/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data));
export const getSpeedRankings = demoable('getSpeedRankings', (year, round, type = 'R') =>
  client.get(`/analytics/speed-rankings/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data));

// ── Championship ──────────────────────────────────────────────────────
export const getChampionship = demoable('getChampionship', (year, loadAll = false) =>
  client.get(`/championship/${year}`, { params: loadAll ? { load_all: true } : {}, timeout: 600000 }).then((r) => r.data));

// ── Live Timing ─────────────────────────────────────────────────────
export const getLiveStatus = demoable('getLiveStatus', () => client.get('/live/status').then((r) => r.data));
export const getLiveSnapshot = demoable('getLiveSnapshot', () => client.get('/live/snapshot').then((r) => r.data));
export const getLiveFrames = demoable('getLiveFrames', () => client.get('/live/frames').then((r) => r.data));
// The controls that change the live session are POSTs with a JSON body (an
// empty object when they take no parameter): the backend refuses them as GET
// and without JSON (backend/api/commands.py)
export const connectSignalR = demoable('connectSignalR', (reset = false) =>
  client.post('/live/connect-signalr', { reset }).then((r) => r.data));
export const disconnectSignalR = demoable('disconnectSignalR', () =>
  client.post('/live/disconnect-signalr', {}).then((r) => r.data));
export const loadLiveFullSession = demoable('loadLiveFullSession', () =>
  client.get('/live/load-full-session', { timeout: 600000 }).then((r) => r.data));
export const getMockSessions = demoable('getMockSessions', () => client.get('/live/mock/sessions').then((r) => r.data));
export const startMockReplay = demoable('startMockReplay', (year, round, speed = 10) =>
  client.post('/live/mock/start', { year, round, speed }).then((r) => r.data));
export const stopMockReplay = demoable('stopMockReplay', () => client.post('/live/mock/stop', {}).then((r) => r.data));

// ── OpenF1 Telemetry ────────────────────────────────────────────────
export const startOpenF1Telemetry = demoable('startOpenF1Telemetry', (sessionKey) =>
  client.post('/live/openf1/start', { session_key: sessionKey || null }).then((r) => r.data));
export const stopOpenF1Telemetry = demoable('stopOpenF1Telemetry', () =>
  client.post('/live/openf1/stop', {}).then((r) => r.data));
export const getOpenF1Status = demoable('getOpenF1Status', () => client.get('/live/openf1/status').then((r) => r.data));

// ── Health ──────────────────────────────────────────────────────────
export const healthCheck = demoable('healthCheck', () => client.get('/health').then((r) => r.data));
