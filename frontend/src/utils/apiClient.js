import axios from 'axios';

const API_BASE = '/api';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
});

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
  return client.get(`/telemetry/${year}/${round}/${driver}`, { params }).then((r) => r.data);
};
export const getCircuit = (year, round) =>
  client.get(`/circuit/${year}/${round}`, { timeout: 600000 }).then((r) => r.data);
export const getStrategy = (year, round) =>
  client.get(`/strategy/${year}/${round}`, { timeout: 600000 }).then((r) => r.data);
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

// ── t-SNE & PCA ────────────────────────────────────────────────────
export const getTSNEEmbeddings = () =>
  client.get('/tsne/embeddings').then((r) => r.data);
export const getPCAEmbeddings = () =>
  client.get('/pca/embeddings').then((r) => r.data);
export const analyzeTSNESelection = (pointIds) =>
  client.post('/tsne/analyze-selection', { point_ids: pointIds }).then((r) => r.data);

// ── Predictions ─────────────────────────────────────────────────────
export const predictLSTM = (data) =>
  client.post('/predict/lstm', data).then((r) => r.data);
export const predictDegradation = (data) =>
  client.post('/predict/degradation', data).then((r) => r.data);

// ── Gemini ──────────────────────────────────────────────────────────
export const queryGemini = (data) =>
  client.post('/gemini/strategy', data).then((r) => r.data);

// ── Analytics ────────────────────────────────────────────────────────
export const getSectors = (year, round) =>
  client.get(`/analytics/sectors/${year}/${round}`).then((r) => r.data);
export const getConsistency = (year, round) =>
  client.get(`/analytics/consistency/${year}/${round}`).then((r) => r.data);
export const getSpeedRankings = (year, round) =>
  client.get(`/analytics/speed-rankings/${year}/${round}`).then((r) => r.data);

// ── Championship ──────────────────────────────────────────────────────
export const getChampionship = (year, loadAll = false) =>
  client.get(`/championship/${year}`, { params: loadAll ? { load_all: true } : {}, timeout: 600000 }).then((r) => r.data);

// ── Live Timing ─────────────────────────────────────────────────────
export const getLiveStatus = () => client.get('/live/status').then((r) => r.data);
export const getLiveSnapshot = () => client.get('/live/snapshot').then((r) => r.data);
export const getLiveFrames = () => client.get('/live/frames').then((r) => r.data);
export const connectSignalR = () => client.get('/live/connect-signalr').then((r) => r.data);
export const disconnectSignalR = () => client.get('/live/disconnect-signalr').then((r) => r.data);
export const getMockSessions = () => client.get('/live/mock/sessions').then((r) => r.data);
export const startMockReplay = (year, round, speed = 10) =>
  client.get('/live/mock/start', { params: { year, round, speed } }).then((r) => r.data);
export const stopMockReplay = () => client.get('/live/mock/stop').then((r) => r.data);

// ── Health ──────────────────────────────────────────────────────────
export const healthCheck = () => client.get('/health').then((r) => r.data);
