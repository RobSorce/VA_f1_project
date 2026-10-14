import axios from 'axios';

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

// Network errors + 5xx = backend unreachable. 4xx = user/bad-request; those
// don't trip the global banner.
client.interceptors.response.use(
  (response) => { _healthReporter.ok(); return response; },
  (error) => {
    const isNetwork = !error.response;
    const is5xx = error.response && error.response.status >= 500;
    if (isNetwork || is5xx) _healthReporter.fail(error.message || 'network error');
    return Promise.reject(error);
  },
);

// ── Session & Schedule ──────────────────────────────────────────────
export const getSeasons = () => client.get('/seasons').then((r) => r.data);
export const getSchedule = (year) => client.get(`/schedule/${year}`).then((r) => r.data);
export const getSession = (year, round, type = 'R') =>
  client.get(`/session/${year}/${round}`, { params: { session_type: type }, timeout: 600000 }).then((r) => r.data);

// ── Race Data ───────────────────────────────────────────────────────
export const getLapTimes = (year, round, driver) => {
  const params = driver ? { driver } : {};
  return client.get(`/laptimes/${year}/${round}`, { params }).then((r) => r.data);
};
export const getTelemetry = (year, round, driver, lap, sessionType = 'R') => {
  const params = { ...(lap ? { lap } : {}), session_type: sessionType };
  return client.get(`/telemetry/${year}/${round}/${driver}`, { params, timeout: 600000 }).then((r) => r.data);
};
export const getCircuit = (year, round) =>
  client.get(`/circuit/${year}/${round}`, { timeout: 600000 }).then((r) => r.data);
export const getStrategy = (year, round, type = 'R') =>
  client.get(`/strategy/${year}/${round}`, { params: { session_type: type }, timeout: 600000 }).then((r) => r.data);
export const getDrivers = (year, round) =>
  client.get(`/drivers/${year}/${round}`).then((r) => r.data);
export const getResults = (year, round) =>
  client.get(`/results/${year}/${round}`).then((r) => r.data);
export const getPositions = (year, round) =>
  client.get(`/positions/${year}/${round}`).then((r) => r.data);
export const getFrames = (year, round, type = 'R') =>
  client.get(`/frames/${year}/${round}`, { params: { session_type: type }, timeout: 600000 }).then((r) => r.data);
export const getWeather = (year, round) =>
  client.get(`/weather/${year}/${round}`).then((r) => r.data);
export const getReplayData = (year, round, type = 'R') =>
  client.get(`/session/${year}/${round}/${type}/replay`).then((r) => r.data);

// ── PCA ──────────────────────────────────────────────────────────────
// clock {year, round, session_now}: that race's rows at session_now, on axes
// fitted without it (backend pca_compute.pca_embeddings_at); none = post-race
export const getPCAEmbeddings = (clock = null) =>
  client.get('/pca/embeddings', clock ? { params: clock } : undefined).then((r) => r.data);
// Descriptive analysis of a lasso selection (Hedges' g, its 95% interval, N,
// random-selection baseline: backend pca_compute.analyze_selection). opts
// {year, round, session_now} ask for the rows of that race at session_now.
export const analyzePCASelection = (pointIds, opts = {}) =>
  client.post('/pca/analyze-selection', { point_ids: pointIds, ...opts }).then((r) => r.data);
// Former name; the backend keeps /tsne/analyze-selection as an alias of the route
export const analyzeTSNESelection = analyzePCASelection;

// ── Predictions ─────────────────────────────────────────────────────
// POST bodies carry session_type (D16; 'R' when the caller names none) and
// /degradation its session_now (session seconds or null, D6)
export const predictLSTM = (data) =>
  client.post('/predict/lstm', { session_type: 'R', ...data }).then((r) => r.data);
export const predictDegradation = (data) =>
  client.post('/predict/degradation', { session_type: 'R', session_now: null, ...data }).then((r) => r.data);

// ── Gemini ──────────────────────────────────────────────────────────
export const queryGemini = (data) =>
  client.post('/gemini/strategy', data).then((r) => r.data);

// ── Analytics ────────────────────────────────────────────────────────
// Every analytics / prediction call names the type of the session on screen
// (D16): session_type as a query parameter for GET, a body field for POST
// (store/useF1Store.js passes it); 'R' when a caller names none.
export const getSectors = (year, round, type = 'R') =>
  client.get(`/analytics/sectors/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data);
export const getConsistency = (year, round, type = 'R') =>
  client.get(`/analytics/consistency/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data);
export const getSpeedRankings = (year, round, type = 'R') =>
  client.get(`/analytics/speed-rankings/${year}/${round}`, { params: { session_type: type } }).then((r) => r.data);

// ── Championship ──────────────────────────────────────────────────────
export const getChampionship = (year, loadAll = false) =>
  client.get(`/championship/${year}`, { params: loadAll ? { load_all: true } : {}, timeout: 600000 }).then((r) => r.data);

// ── Live Timing ─────────────────────────────────────────────────────
export const getLiveStatus = () => client.get('/live/status').then((r) => r.data);
export const getLiveSnapshot = () => client.get('/live/snapshot').then((r) => r.data);
export const getLiveFrames = () => client.get('/live/frames').then((r) => r.data);
export const connectSignalR = () => client.get('/live/connect-signalr').then((r) => r.data);
export const disconnectSignalR = () => client.get('/live/disconnect-signalr').then((r) => r.data);
export const loadLiveFullSession = () => client.get('/live/load-full-session', { timeout: 600000 }).then((r) => r.data);
export const getMockSessions = () => client.get('/live/mock/sessions').then((r) => r.data);
export const startMockReplay = (year, round, speed = 10) =>
  client.get('/live/mock/start', { params: { year, round, speed } }).then((r) => r.data);
export const stopMockReplay = () => client.get('/live/mock/stop').then((r) => r.data);

// ── OpenF1 Telemetry ────────────────────────────────────────────────
export const startOpenF1Telemetry = (sessionKey) =>
  client.get('/live/openf1/start', { params: sessionKey ? { session_key: sessionKey } : {} }).then((r) => r.data);
export const stopOpenF1Telemetry = () => client.get('/live/openf1/stop').then((r) => r.data);
export const getOpenF1Status = () => client.get('/live/openf1/status').then((r) => r.data);

// ── Health ──────────────────────────────────────────────────────────
export const healthCheck = () => client.get('/health').then((r) => r.data);
