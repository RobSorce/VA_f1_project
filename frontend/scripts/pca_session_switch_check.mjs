/**
 * The cross-race PCA answers across a session switch:
 * writes docs/evidence/pca_session_switch_check.txt and prints
 * the same text.
 *
 * Run from frontend/ (after backend: python -m scripts.pca_session_switch_answers):
 *     npx vite-node scripts/pca_session_switch_check.mjs
 *
 * The real store (loadSession, loadFrames, showRaceOver, fetchPCAAnalysis,
 * pcaRequestOf) and the real panel (PCAAnalysisPanel); the network answered
 * with the cached session / frames files and the backend's own answers
 * (docs/evidence/pca_session_switch_answers.json: the 19 rows of 2024 R16 post-race, and at
 * the race clock 0). A request with any other clock is answered with the
 * clock-0 answer as a stand-in (its content is not under test, only that it
 * is asked and lands). The FP2 payload is a stand-in too
 * (session_2026_1_FP2.json): its content does not enter the PCA requests.
 *  A. 2024 R16 race at its end (lap mode), lasso the 19 stars, then load the
 *     FP2 of that weekend: what the store holds, what is asked, what the
 *     panel and the pattern consumers read.
 *  B. 2024 R16 frame replay at its last frame, lasso the 19 stars, then load
 *     2024 R8 (frames): is the analysis asked again, and does the panel leave
 *     "Analyzing selection..."?
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { installMiniDom } from '../src/__tests__/helpers/miniDom.js';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EVIDENCE = path.join(ROOT, 'docs/evidence');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\bNaN\b/g, 'null'));
const ans = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'pca_session_switch_answers.json'), 'utf8'));
const emb = read('backend/data/processed/pca_embeddings.json');
const sessions = {
  'R-16': read('backend/data/processed_cache/session_2024_16_R.json'),
  'R-8': read('backend/data/processed_cache/session_2024_8_R.json'),
  'FP2-16': read('backend/data/processed_cache/session_2026_1_FP2.json'),
};
const frames = {
  16: read('backend/data/processed_cache/frames_2024_16_R.json'),
  8: read('backend/data/processed_cache/frames_2024_8_R.json'),
};

const requests = [];
let framesMode = true;
axios.defaults.adapter = async (config) => {
  const url = config.url;
  const body = config.data ? JSON.parse(config.data) : null;
  requests.push({ url, params: config.params || null, body });
  let data;
  let m;
  if (url === '/pca/analyze-selection') data = body.session_now == null ? ans.post : ans.at0;
  else if (url === '/pca/embeddings') data = emb;
  else if ((m = /^\/session\/2024\/(\d+)$/.exec(url))) data = sessions[`${config.params?.session_type || 'R'}-${m[1]}`];
  else if ((m = /^\/frames\/2024\/(\d+)$/.exec(url)) && framesMode && frames[m[1]]) data = frames[m[1]];
  if (data === undefined) throw Object.assign(new Error(`404 ${url}`), { config, response: { status: 404, data: {} } });
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store, pcaRequestOf } = await import('../src/store/useF1Store.js');
const { default: PCAAnalysisPanel } = await import('../src/components/visualizations/PCAAnalysisPanel.jsx');

const lines = [];
const out = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const S = () => useF1Store.getState();
const analysisRequests = () => requests.filter((r) => r.url === '/pca/analyze-selection');
const quiet = console.log;

async function panelText(tab) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 420, height: 480 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(PCAAnalysisPanel)); });
  if (tab) {
    const b = [...host.querySelectorAll('button')].find((x) => text(x).startsWith(tab));
    if (b) await act(async () => { dom.mouse(b, 'click'); });
  }
  const t = text(host.querySelector('.panel-content'));
  const note = !!host.querySelector('.pca-clock-note');
  await act(async () => { root.unmount(); });
  host.remove();
  return { t, note };
}
const loud = (fn) => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = quiet; } };
const load = loud(async () => { await S().loadSession(); });

// ── A ──
out('== A. 2024 R16 race at its end (lap mode), the 19 stars lassoed, then the FP2 of that weekend ==');
framesMode = false;
S().setYear(2024); S().setRound(16); S().setSessionType('R');
await load();
S().showRaceOver();
await sleep(300);
S().setSelectedPCAPoints(ans.ids);
await S().fetchPCAAnalysis(ans.ids);
const post = S().pcaStrategyAnalysis;
out(`race at its end: raceClock ${pcaRequestOf(S()).raceClock}; analysis _pcaAnalysisAt ${S()._pcaAnalysisAt}; pit windows ${JSON.stringify(post.pit_windows.map((w) => [w.lap_start, w.lap_end, w.count]))}`);
let before = analysisRequests().length;
S().setSessionType('FP2');
await load();
await sleep(500);
const reqA = pcaRequestOf(S());
const a2 = S().pcaStrategyAnalysis;
out(`FP2 on screen: raceClock ${reqA.raceClock}; request params ${JSON.stringify(reqA.params)}`);
out(`store: selection ${S().selectedPCAPoints.length}; the post-race answer still held: ${a2 === post}; analysis requests after the load ${analysisRequests().length - before}, body ${JSON.stringify(analysisRequests().at(-1).body).replace(/"point_ids":\[[^\]]*\],?/, '"point_ids":[19 ids],')}`);
out(`answer now held: n_selected ${a2?.n_selected}, pit windows ${JSON.stringify(a2?.pit_windows)}, strategies ${JSON.stringify(a2?.strategies)}, _pcaAnalysisAt ${S()._pcaAnalysisAt}`);
const sum = await panelText(null);
const det = await panelText('Details');
out(`panel (Summary) mentions the post-race strategy "MEDIUM -> HARD": ${sum.t.includes('MEDIUM -> HARD')}; (Details) shows the post-race pit windows "L5–L23": ${det.t.includes('L5–L23')}`);
out(`pattern consumers (Strategy Timeline ghost rows, Gemini pcaPatterns) read strategies: ${JSON.stringify((S().pcaStrategyAnalysis?.strategies || []).slice(0, 3))}`);

// ── B ──
out('');
out('== B. 2024 R16 frame replay at its last frame, the 19 stars lassoed, then 2024 R8 (frames) ==');
framesMode = true;
S().setSelectedPCAPoints([]);
S().setSessionType('R'); S().setRound(16);
await load();
S().setCurrentFrameIndex(S().totalFrames - 1);
await sleep(1500);
S().setSelectedPCAPoints(ans.ids);
await S().fetchPCAAnalysis(ans.ids);
out(`2024 R16 at its last frame: frames ${S().totalFrames}; sessionNow ${S().getSessionNow()}; analysis _pcaAnalysisAt ${S()._pcaAnalysisAt}`);
before = analysisRequests().length;
S().setRound(8);
await load();
await sleep(2500);
out(`2024 R8 loaded: frames ${S().totalFrames}; sessionNow ${S().getSessionNow()}; raceClock ${pcaRequestOf(S()).raceClock}; selection ${S().selectedPCAPoints.length}`);
const asked = analysisRequests().slice(before).map((r) => r.body.session_now ?? 'post-race');
out(`analysis requests after the load: ${asked.length} (session_now ${JSON.stringify(asked)}); analysis held: ${!!S().pcaStrategyAnalysis}, _pcaAnalysisAt ${S()._pcaAnalysisAt}, error ${S().pcaAnalysisError}`);
const pB = await panelText('Differences');
out(`panel: "Analyzing selection..." ${pB.t.includes('Analyzing selection')}; shows N ${/N = \d+ selected vs \d+ other rows/.test(pB.t)}`);

fs.writeFileSync(path.join(EVIDENCE, 'pca_session_switch_check.txt'), `${lines.join('\n')}\n`);
process.exit(0);
