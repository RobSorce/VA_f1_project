/**
 * Use case UC2, "Monza 2024, data analyst: post-race debrief of the strategy
 * split": every number of the use case, computed the way the static demo
 * (https://robsorce.github.io/VA_f1_project/) computes what its views show,
 * plus the local backend's answers and a restricted-archive check.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/):
 *     npx vite-node scripts/usecases/uc2_monza24_analyst.mjs [--out <file>]
 * Writes docs/evidence/usecase_uc2_monza24_analyst.txt (or the --out file,
 * relative to frontend/) and prints the same text. Sections 5 and 6 come
 * from backend/scripts/usecase_monza24_analyst.py, run here with the backend
 * virtual environment (backend/.venv, or the interpreter named by $PYTHON);
 * it reads the shipped PCA artefacts (backend/data/processed) and the cached
 * race sessions (backend/data/processed_cache, git-ignored, filled by
 * backend/scripts/bulk_download.py). Section 1 also reads the backend's
 * replay frames of the race from that cache when present.
 *
 * The dashboard path: the real store (store/useF1Store.js) in demo mode
 * (utils/demoMode.js), its API answered by utils/demoData.js from the files
 * of frontend/public/data (read from disk here, as the browser fetches them):
 * loadSession of 2024 R16 (session payload and the demo's replay frames,
 * every 2nd backend frame), the seeks the keys and the timeline make,
 * loadPCAEmbeddings and fetchPCAAnalysis as PCABiplot.jsx calls them (a lasso
 * or a click: setSelectedPCAPoints, fetchPCAAnalysis, setSelectedDrivers),
 * and the panel's own view model (utils/views/pcaSelection.js, the helpers
 * PCAAnalysisPanel.jsx draws with). No request reaches /api.
 *
 * Clocks:
 *  - the race on screen at its end (store pcaRequestOf raceClock 'ended',
 *    request params null): the Timeline Player's skip-to-end button
 *    (useReplayEngine skipToEnd -> store showRaceOver -> the last replay
 *    frame, session clock Infinity). Every number of sections 2-5 is read
 *    there: the post-race biplot and the post-race lasso analysis;
 *  - for contrast (section 1): the End key (useKeyboardShortcuts: setCurrentLap
 *    (maxLap), the frame where the leader starts the last lap; the biplot
 *    and lassos A and B there) and the frame before the last one: the race
 *    is still running at both, and the biplot is the replay-clock biplot
 *    (axes fitted without the race, its rows at the clock), so their
 *    readings are not the post-race ones. Section 7 reads the lap rows of
 *    the whole race (the outcome).
 *
 * Sections:
 *  1. reaching the post-race state in the demo (clock, request, frames);
 *  2. the post-race biplot: axes, the 19 stars, stops, groups, lasso feasibility;
 *  3. lassos A (one-stoppers), B (two-or-more-stoppers), C (all 19 stars):
 *     the Cross-Race Analysis panel tab by tab;
 *  4. click selections LEC, LEC + SAI, PIA + NOR: how uncertainty is shown;
 *  5. the local backend gives the same answers (pca_compute.analyze_selection,
 *     pca_embeddings.json);
 *  6. restricted archives (NOT shown by the dashboard): the same readings with
 *     only the races run by the end of Monza 2024, and before Monza 2025;
 *  7. outcome from the lap rows of the race.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import axios from 'axios';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '../..');
const REPO = path.resolve(FRONTEND, '..');
const BACKEND = path.join(REPO, 'backend');
const DATA = path.join(FRONTEND, 'public/data');
const OUT_ARG = process.argv.indexOf('--out');
const OUT_FILE = OUT_ARG > 0
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.join(REPO, 'docs/evidence/usecase_uc2_monza24_analyst.txt');
const YEAR = 2024;
const ROUND = 16;

// ── The browser's environment: storage, the demo data files, no backend ──────
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}
const DATA_URL = 'http://demo.local/data/';
const fetched = new Set();
globalThis.fetch = async (url) => {
  const u = String(url);
  const file = u.startsWith(DATA_URL) ? path.join(DATA, u.slice(DATA_URL.length)) : null;
  if (!file || !fs.existsSync(file)) return new Response('Not Found', { status: 404 });
  fetched.add(u.slice(DATA_URL.length));
  return new Response(fs.readFileSync(file), { status: 200 });
};
const apiCalls = [];
axios.defaults.adapter = async (config) => {
  apiCalls.push(config.url);
  throw Object.assign(new Error(`no backend in this script: ${config.url}`), { config });
};

const { useDemoMode } = await import('../../src/utils/demoMode.js');
useDemoMode.setState({ active: true, source: 'build', reason: null });
const { setDemoDataRoot } = await import('../../src/utils/demoData.js');
setDemoDataRoot(DATA_URL);
const { useF1Store, pcaRequestOf, sessionScopeOf } = await import('../../src/store/useF1Store.js');
const {
  loadedRaceOf, causalPoints, filterOptions, filterPoints, shownFinish, outcomeClass, OUTCOME_CLASSES,
} = await import('../../src/utils/views/pcaBiplot.js');
const {
  selectionRows, selectionStatistics, fmtSigned, fmtInterval, fmtMean, missingIntervalNote, sameSelection,
} = await import('../../src/utils/views/pcaSelection.js');
const { pointInPolygon } = await import('../../src/utils/lasso.js');
const { pitStops, stintsByDriver } = await import('../../src/utils/stints.js');
const { patternStopCount } = await import('../../src/utils/strategyViews.js');
const { resolveSessionNow } = await import('../../src/utils/raceTime.js');

const S = () => useF1Store.getState();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lines = [];
const out = (s = '') => { lines.push(String(s)); console.log(String(s)); };
const quiet = async (fn) => {
  const keep = [console.log, console.info, console.warn];
  console.log = () => {}; console.info = () => {}; console.warn = () => {};
  try { return await fn(); } finally { [console.log, console.info, console.warn] = keep; }
};
const f2 = (v) => (v == null ? 'none' : Number(v).toFixed(2));
const f3 = (v) => (v == null ? 'none' : Number(v).toFixed(3));
const sgn = (v, d = 2) => (v == null ? 'none' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}`);
const pct1 = (v) => `${(100 * v).toFixed(1)}%`;

// ── Load the race as the start screen does (season, event, session) ─────────
await quiet(async () => {
  S().setYear(YEAR);
  S().setRound(ROUND);
  S().setSessionType('R');
  await S().loadSession();
  for (let i = 0; i < 200 && !(S().totalFrames > 0); i++) await sleep(25);
  await sleep(300);
});
if (S().error) throw new Error(`loadSession: ${S().error}`);
const lapTimes = S().sessionData.lap_times;
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
const race = manifest.races.find((r) => r.year === YEAR && r.round === ROUND);

/** What the PCA requests are at the store's clock now (pcaRequestOf). */
const clockState = () => {
  const s = S();
  const req = pcaRequestOf(s);
  const fr = s.frameData?.frames?.[s.currentFrameIndex];
  return {
    frame: s.currentFrameIndex, frameT: fr?.t, lap: s.currentLap, now: s.getSessionNow(),
    raceClock: req.raceClock, params: req.params, key: req.key,
  };
};
const clockText = (c) => `frame index ${c.frame} of ${S().totalFrames} (replay t ${f2(c.frameT)} s), lap on screen ${c.lap}, `
  + `session clock ${Number.isFinite(c.now) ? `${c.now.toFixed(3)} s` : 'Infinity'}; pcaRequestOf: raceClock '${c.raceClock}', `
  + `params ${c.params ? JSON.stringify(c.params) : 'null (post-race artefact)'}, key '${c.key}'`;

/**
 * The ids a lasso around `group` returns: the points drawn (filter), in their
 * drawing order, that fall inside it (utils/lasso.js keeps that order; the
 * order decides which pattern comes first when two patterns are equally
 * common).
 */
const lassoIds = (drawn, group) => {
  const ids = new Set(group.map((p) => p.id));
  return drawn.filter((p) => ids.has(p.id)).map((p) => p.id);
};

/** A lasso or a click on the biplot (PCABiplot.jsx selectPoints) and the answer it lands. */
async function select(ids, points) {
  S().setSelectedPCAPoints(ids);
  const pending = S().fetchPCAAnalysis(ids);
  const drivers = [...new Set(ids.map((id) => points.find((p) => p.id === id)?.driver).filter(Boolean))];
  S().setSelectedDrivers(drivers);
  await quiet(async () => { await pending; await sleep(30); });
  const a = S().pcaStrategyAnalysis;
  if (!a || !sameSelection(S().pcaAnalysisIds, ids)) throw new Error(`no analysis landed for ${ids.join(',')}`);
  return a;
}
const clearSelection = () => { S().setSelectedPCAPoints([]); S().setSelectedDrivers([]); };

/** Convex hull (monotone chain) of [x, y] points. */
function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (const q of p.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
/** Drawn points that are not in the group but inside its hull (the lasso test of utils/lasso.js). */
const intruders = (group, drawn) => {
  const poly = hull(group.map((p) => [p.x, p.y]));
  const ids = new Set(group.map((p) => p.id));
  return drawn.filter((p) => !ids.has(p.id) && pointInPolygon([p.x, p.y], poly)).map((p) => p.id);
};

/** The Cross-Race Analysis panel, tab by tab, as PCAAnalysisPanel.jsx draws it. */
function printPanel(a, { tabs = ['summary', 'patterns', 'differences', 'details'], top = 12, intervals = false } = {}) {
  const rows = selectionRows(a);
  const st = selectionStatistics(a);
  const banner = `N = ${st.nSelected} selected vs ${st.nRest} other rows`
    + (st.threshold != null && rows.length ? ` · ${st.nAboveRandom} of ${st.nFeatures} features above random` : '');
  if (tabs.includes('summary')) {
    out(`  Summary: label "${a.cluster_label}"`);
    out(`    text: ${a.summary}`);
    out(`    banner: ${st.label.toUpperCase()} | ${banner} | ${st.composition}`);
    if (a.common_patterns?.length) {
      out(`    compound chips: ${a.common_patterns.map((p) => `${p.compound} ${p.count} stints · avg ${p.avg_stint_length?.toFixed(0)}L`).join(' | ')}`);
    }
  }
  if (tabs.includes('patterns')) {
    out(`  Patterns (${a.strategies.length}): ${a.strategies.map((s, i) => `${s.count}× (${(s.frequency * 100).toFixed(0)}%)${i === 0 ? ' most common' : ''} `
      + `${patternStopCount(s.stints)}-stop ${s.stints.map((x) => `${x.compound} ${x.length}L`).join(' > ')}`).join(' | ')}`);
  }
  if (tabs.includes('differences')) {
    out(`  Differences (rows by |g|, numbered in the tab's order; tick g, bar = interval, shaded = random |g|, dashed = threshold; Method: "Above random: |g| > ${st.threshold}"):`);
    for (const [i, r] of rows.slice(0, top).entries()) {
      const iv = fmtInterval(r.ciLow, r.ciHigh);
      const width = iv ? `  (width ${(r.ciHigh - r.ciLow).toFixed(2)}${r.ciLow > 0 || r.ciHigh < 0 ? ', excludes 0' : ''})` : '';
      out(`    ${String(i + 1).padStart(2)}. ${r.label.padEnd(25)} ${r.exceedsRandom ? 'above random' : '            '}  g ${fmtSigned(r.g)} ${iv || `[${missingIntervalNote(r, st.minGroupForInterval)}]`}`
        + `  random |g| ${r.baseline?.toFixed(2)}  | tooltip: selection mean ${fmtMean(r.selectedMean, r.unit)}, other rows ${fmtMean(r.restMean, r.unit)}`
        + `${intervals ? width : ''}`);
    }
  }
  if (tabs.includes('details')) {
    out(`  Details, Common Pit Windows: ${a.pit_windows.map((w, i) => `L${w.lap_start}–L${w.lap_end} ${w.count} stops in this window${i === 0 ? ' (most)' : ''}`).join(' | ')}`);
  }
  return { rows, st };
}

out('Use case UC2: Monza 2024 (2024 R16), data analyst, post-race debrief of the strategy split');
out('Script: frontend/scripts/usecases/uc2_monza24_analyst.mjs (backend half: backend/scripts/usecase_monza24_analyst.py)');
out(`Data: the static demo's files (frontend/public/data: ${race.race_name} ${YEAR} R${ROUND}, ${race.lap_rows} lap rows, `
  + `${race.frames_in_demo} replay frames = every ${manifest.frame_step}nd of ${race.frames_in_backend}), the store in demo mode.`);
out(`Race: ${race.laps} laps, ${race.drivers} drivers, safety-car periods ${race.safety_car_periods}, VSC periods ${race.virtual_safety_car_periods}, `
  + `wet-tyre laps ${race.wet_tyre_laps} (manifest); the classification has ${S().sessionData.race_results.length} rows.`);
out('');

// ── 1. Clocks ────────────────────────────────────────────────────────────────
out('== 1. Reaching the post-race state (the clock of every number in sections 2-5) ==');
out(`after the load: ${clockText(clockState())}`);
out(`frames: ${S().totalFrames}, frameDt ${f2(S().frameDt)} s, max_time ${f2(S().maxTime)} s; maxLap ${S().maxLap}`);
await quiet(async () => { const st = S(); if (st.maxLap) st.setCurrentLap(st.maxLap); await sleep(300); });
const endKey = clockState();
out(`End key (setCurrentLap(maxLap)): ${clockText(endKey)}`);
await quiet(async () => { await S().loadPCAEmbeddings(); await sleep(50); });
const embEnd = S().pcaEmbeddings;
out(`  biplot at that clock: ${embEnd.n_points} points, stars as_of '${embEnd.current_race?.as_of}' at lap ${embEnd.current_race?.as_of_lap} `
  + `(${embEnd.current_race?.n_points} rows of the race), axes fitted without the race: "${embEnd.pc1_label}" ${pct1(embEnd.explained_variance[0])} / `
  + `"${embEnd.pc2_label}" ${pct1(embEnd.explained_variance[1])}`);
{
  // what a reader who pressed End instead of skip-to-end would read
  const ld = loadedRaceOf(sessionScopeOf(S()));
  const pts = causalPoints(embEnd.points, { loaded: ld, resultHidden: endKey.raceClock !== 'ended' });
  const drawn = filterPoints(pts, 'race', ld);
  const stopsNow = {};
  for (const s of pitStops(lapTimes, { sessionNow: endKey.now })) stopsNow[s.Driver] = (stopsNow[s.Driver] || 0) + 1;
  const a = drawn.filter((p) => stopsNow[p.driver] === 1);
  const b = drawn.filter((p) => (stopsNow[p.driver] || 0) >= 2);
  out(`  'This race' at that clock: ${drawn.length} stars; one-stoppers so far ${a.length}, y ${sgn(Math.min(...a.map((p) => p.y)))} to ${sgn(Math.max(...a.map((p) => p.y)))}; `
    + `two or more so far ${b.length}, y ${sgn(Math.min(...b.map((p) => p.y)))} to ${sgn(Math.max(...b.map((p) => p.y)))}`);
  for (const [name, grp] of [['A', a], ['B', b]]) {
    const ans = await select(lassoIds(drawn, grp), pts);
    const flagged = selectionRows(ans).filter((r) => r.exceedsRandom).map((r) => `${r.label} g ${fmtSigned(r.g)}${r.progressDependent ? ' (progress-dependent)' : ''}`);
    out(`  lasso ${name} at that clock: "${ans.cluster_label}", ${flagged.length} of ${ans.feature_importance.length} above random `
      + `(rule ${ans.statistics.threshold_rule})${flagged.length ? `: ${flagged.join('; ')}` : ''}; ${ans.statistics.composition_text}`);
  }
  clearSelection();
}
await quiet(async () => { S().setCurrentFrameIndex(S().totalFrames - 2); await sleep(300); });
const penult = clockState();
out(`frame before the last: ${clockText(penult)}`);
out(`  replay t + frameDt = ${f2(penult.frameT + S().frameDt)} s <= max_time ${f2(S().maxTime)} s: the clock is finite, the race is still running`);
await quiet(async () => { S().setIsPlaying(false); S().showRaceOver(); await sleep(300); });
const ended = clockState();
out(`skip-to-end button (skipToEnd -> showRaceOver): ${clockText(ended)}`);
out(`  replay t + frameDt = ${f2(ended.frameT + S().frameDt)} s > max_time ${f2(S().maxTime)} s: session clock Infinity, raceClock 'ended'`);
out(`  in the demo the post-race readout holds on the last frame only: 1 of ${S().totalFrames} frames (the last ${f2(S().frameDt)} s of replay)`);
{
  // the local app's replay (the backend's frames, every frame kept)
  const file = path.join(BACKEND, 'data/processed_cache/frames_2024_16_R.json');
  if (fs.existsSync(file)) {
    const fr = JSON.parse(fs.readFileSync(file, 'utf8'));
    const n = fr.frames.length;
    const dt = fr.frames[1].t - fr.frames[0].t;
    const at = (i) => resolveSessionNow({
      currentTime: fr.frames[i].t, sessionTimeOffset: S().sessionTimeOffset, replayActive: true,
      lapTimes, maxTime: fr.max_time, frameDt: dt,
    });
    out(`  local app (backend frames, processed_cache): ${n} frames, frameDt ${f2(dt)} s, max_time ${f2(fr.max_time)} s; `
      + `session clock at the last frame ${at(n - 1)}, at the one before ${at(n - 2).toFixed(3)} s: the post-race state is again the last frame only`);
  } else {
    out('  local app: backend/data/processed_cache/frames_2024_16_R.json not found, not checked');
  }
}
out('');

// ── 2. The post-race biplot ──────────────────────────────────────────────────
await quiet(async () => { await S().loadPCAEmbeddings(); await sleep(50); });
const emb = S().pcaEmbeddings;
const loaded = loadedRaceOf(sessionScopeOf(S()));
const resultHidden = ended.raceClock !== 'ended';
const points = causalPoints(emb.points, { loaded, resultHidden });
const options = filterOptions(points, loaded, { raceClock: ended.raceClock });
const stars = filterPoints(points, 'race', loaded);
const stopsOf = {};
for (const s of pitStops(lapTimes)) (stopsOf[s.Driver] ||= []).push(s);
const stints = stintsByDriver(lapTimes);
const results = S().sessionData.race_results;
out('== 2. The post-race biplot (Analytics (PCA) > PCA Biplot, the race at its end) ==');
out(`request: GET /api/pca/embeddings with no clock -> ${emb.n_points} points of ${emb.n_races} races; current_race ${emb.current_race ? 'present' : 'absent (post-race artefact)'}`);
out(`axis titles drawn: "PC1: ${emb.pc1_label} (${(emb.explained_variance[0] * 100).toFixed(0)}%)", "PC2: ${emb.pc2_label} (${(emb.explained_variance[1] * 100).toFixed(0)}%)" `
  + `(explained variance ${pct1(emb.explained_variance[0])} / ${pct1(emb.explained_variance[1])}, not drawn with decimals)`);
out(`loadings (pc1, pc2; PCABiplot.jsx draws an arrow for the first 8, largest first): ${emb.loadings
  .map((l, i) => `${l.label} ${sgn(l.pc1, 3)}, ${sgn(l.pc2, 3)}${i < 8 ? '' : ' (no arrow)'}`).join(' | ')}`);
out(`filter buttons: ${options.map((o) => `${o.label} ${o.count}${o.disabled ? ' (disabled)' : ''}`).join(' | ')}`);
out('crosshair through the origin (PCABiplot.jsx, axes on): a vertical and a horizontal dashed line; the text "avg" is drawn at the top of the vertical one');
out(`the ${stars.length} stars ('This race'; ${results.length - stars.length} classified row(s) without a star: `
  + `${results.filter((r) => !stars.some((p) => p.driver === r.Abbreviation)).map((r) => `${r.Abbreviation} ${r.Status}, ${(stopsOf[r.Abbreviation] || []).length} stops`).join(', ')}):`);
const table = stars.map((p) => {
  const fin = shownFinish(p, { loaded, resultHidden });
  const cls = OUTCOME_CLASSES.find((c) => c.key === outcomeClass(fin));
  const st = stints[p.driver] || [];
  return { p, fin, cls: cls ? cls.label : 'pending', stops: (stopsOf[p.driver] || []).length, st };
}).sort((a, b) => (a.fin ?? 99) - (b.fin ?? 99));
for (const r of table) {
  out(`  P${String(r.fin).padEnd(2)} ${r.p.driver} ${String(r.p.team).padEnd(18)} Finish colour: ${r.cls.padEnd(17)} stops ${r.stops}  `
    + `${r.st.map((s) => s.Compound).join('-').padEnd(22)} in-laps ${JSON.stringify((stopsOf[r.p.driver] || []).map((s) => s.inLap))}  `
    + `x ${sgn(r.p.x)} y ${sgn(r.p.y)} (${r.p.y > 0 ? 'above' : 'below'} the crosshair's horizontal dashed line y = 0)`);
}
const groupA = table.filter((r) => r.stops === 1).map((r) => r.p);
const groupB = table.filter((r) => r.stops >= 2).map((r) => r.p);
const yA = groupA.map((p) => p.y);
const yB = groupB.map((p) => p.y);
out(`group A, one-stoppers: ${groupA.length} stars, y ${sgn(Math.min(...yA))} to ${sgn(Math.max(...yA))}; `
  + `group B, two-or-more-stoppers: ${groupB.length} stars, y ${sgn(Math.min(...yB))} to ${sgn(Math.max(...yB))}; `
  + `gap on PC2 ${f2(Math.min(...yA) - Math.max(...yB))}; stars of A above y = 0: ${yA.filter((y) => y > 0).length} of ${yA.length}, of B below: ${yB.filter((y) => y < 0).length} of ${yB.length}`);
out(`podium stars (Finish colour 'Podium'): ${table.filter((r) => r.fin != null && r.fin <= 3).map((r) => `${r.p.driver} P${r.fin} in group ${r.stops === 1 ? 'A' : 'B'}`).join(', ')}`);
const allDrawn = filterPoints(points, 'all', loaded);
out(`lasso feasibility (a lasso around a group's convex hull; utils/lasso.js pointInPolygon on the points drawn): `
  + `'This race': other stars inside A ${JSON.stringify(intruders(groupA, stars))}, inside B ${JSON.stringify(intruders(groupB, stars))}; `
  + `'All races': other points inside A ${intruders(groupA, allDrawn).length}, inside B ${intruders(groupB, allDrawn).length}`);
out('');

// ── 3. Lassos ────────────────────────────────────────────────────────────────
const idsA = lassoIds(stars, groupA);
const idsB = lassoIds(stars, groupB);
const idsC = lassoIds(stars, stars);
out('== 3. Lassos on the post-race biplot, filter \'This race\' (Shift+drag; a lasso replaces the selection) ==');
const demoAnswers = {};
out(`-- Lasso A: the ${idsA.length} one-stoppers (stars above the crosshair's horizontal line): ${idsA.map((i) => i.split('_')[0]).join(', ')}`);
demoAnswers.A = await select(idsA, points);
printPanel(demoAnswers.A, { intervals: true });
out('');
out(`-- Lasso B: the ${idsB.length} two-or-more-stoppers (stars below the crosshair's horizontal line): ${idsB.map((i) => i.split('_')[0]).join(', ')}`);
demoAnswers.B = await select(idsB, points);
printPanel(demoAnswers.B, { intervals: true });
out('');
out(`-- Lasso C: all ${idsC.length} stars`);
demoAnswers.C = await select(idsC, points);
printPanel(demoAnswers.C, { tabs: ['summary', 'patterns', 'differences'], top: 4 });
out('');

// ── 4. Clicks ────────────────────────────────────────────────────────────────
out('== 4. Click selections (a click toggles one star; "Clear N selected" empties the selection) ==');
clearSelection();
out('-- click LEC: one row');
demoAnswers.LEC = await select(['LEC_2024_16'], points);
printPanel(demoAnswers.LEC, { tabs: ['summary', 'differences'], top: 5 });
out('-- click SAI as well: LEC + SAI');
demoAnswers['LEC+SAI'] = await select(['LEC_2024_16', 'SAI_2024_16'], points);
const ls = printPanel(demoAnswers['LEC+SAI'], { tabs: ['summary', 'differences', 'details'], top: 12, intervals: true });
const widths = (rows) => rows.filter((r) => r.ciLow != null).map((r) => r.ciHigh - r.ciLow);
out(`  interval widths: ${f2(Math.min(...widths(ls.rows)))} to ${f2(Math.max(...widths(ls.rows)))}; intervals excluding 0: ${ls.rows.filter((r) => r.ciLow > 0 || r.ciHigh < 0).length}`);
clearSelection();
out('-- Clear, then click PIA and NOR: PIA + NOR');
demoAnswers['PIA+NOR'] = await select(['PIA_2024_16', 'NOR_2024_16'], points);
const pn = printPanel(demoAnswers['PIA+NOR'], { tabs: ['summary', 'differences', 'details'], top: 12, intervals: true });
const excl = pn.rows.filter((r) => (r.ciLow > 0 || r.ciHigh < 0));
out(`  intervals excluding 0: ${excl.length} (${excl.map((r) => r.label).join(', ')}); above random: ${pn.rows.filter((r) => r.exceedsRandom).length}; `
  + `largest |g| ${f2(Math.max(...pn.rows.map((r) => r.absG)))} against the threshold ${pn.st.threshold}`);
out('');

// ── 5. The local backend ─────────────────────────────────────────────────────
const PY = process.env.PYTHON
  || [path.join(BACKEND, '.venv/Scripts/python.exe'), path.join(BACKEND, '.venv/bin/python')].find((p) => fs.existsSync(p))
  || 'python';
const tmp = path.join(os.tmpdir(), `uc2_monza24_backend_${process.pid}.json`);
const tmpIds = path.join(os.tmpdir(), `uc2_monza24_ids_${process.pid}.json`);
fs.writeFileSync(tmpIds, JSON.stringify({
  A: idsA, B: idsB, C: idsC, LEC: ['LEC_2024_16'], 'LEC+SAI': ['LEC_2024_16', 'SAI_2024_16'], 'PIA+NOR': ['PIA_2024_16', 'NOR_2024_16'],
}));
const run = spawnSync(PY, ['-m', 'scripts.usecase_monza24_analyst', '--ids', tmpIds, '--json', tmp], { cwd: BACKEND, encoding: 'utf8' });
fs.unlinkSync(tmpIds);
if (run.status !== 0) throw new Error(`backend/scripts/usecase_monza24_analyst.py failed:\n${run.stderr}`);
const backend = JSON.parse(fs.readFileSync(tmp, 'utf8'));
fs.unlinkSync(tmp);
out('== 5. The local backend gives the same answers (backend/scripts/usecase_monza24_analyst.py) ==');
const sameIds = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
out(`groups: one-stoppers by the lap rows' tyre changes (utils/stints.js pitStops) = matrix pit_count 1: ${sameIds(idsA, backend.selections.A)}; `
  + `two or more = pit_count >= 2: ${sameIds(idsB, backend.selections.B)}`);
let dxy = 0;
let missing = 0;
for (const p of emb.points) {
  const b = backend.served.points[p.id];
  if (!b) { missing += 1; continue; }
  dxy = Math.max(dxy, Math.abs(p.x - b[0]), Math.abs(p.y - b[1]));
}
out(`biplot: demo ${emb.points.length} points, backend ${backend.served.n_points}; not in the backend ${missing}; max |demo - backend| over x, y ${dxy.toExponential(2)}; `
  + `labels equal ${emb.pc1_label === backend.served.pc1_label && emb.pc2_label === backend.served.pc2_label}; `
  + `explained variance equal ${JSON.stringify(emb.explained_variance) === JSON.stringify(backend.served.explained)}`);
const NUM = ['g', 'ci_low', 'ci_high', 'selected_mean', 'rest_mean', 'baseline_abs_g', 'threshold_abs_g'];
for (const name of ['A', 'B', 'C', 'LEC', 'LEC+SAI', 'PIA+NOR']) {
  const J = demoAnswers[name];
  const P = backend.post[name];
  const pf = new Map(P.feature_importance.map((r) => [r.feature, r]));
  let d = 0;
  let flags = 0;
  for (const r of J.feature_importance) {
    const p = pf.get(r.feature);
    for (const k of NUM) {
      if (r[k] == null && p[k] == null) continue;
      if ((r[k] == null) !== (p[k] == null)) { d = Infinity; continue; }
      d = Math.max(d, Math.abs(r[k] - p[k]));
    }
    if (r.exceeds_random !== p.exceeds_random) flags += 1;
  }
  const texts = ['summary', 'cluster_label', 'strategies', 'pit_windows', 'common_patterns', 'n_selected', 'n_rest']
    .filter((k) => JSON.stringify(J[k]) !== JSON.stringify(P[k]));
  out(`  ${name.padEnd(8)} N ${J.n_selected}: max |demo - backend| over the feature rows ${d.toExponential(2)}; flags differing ${flags}; `
    + `fields differing ${texts.length ? texts.join(', ') : 'none'}`);
}
out('');

// ── 6. Restricted archives ───────────────────────────────────────────────────
out('== 6. Restricted archives: NOT what the dashboard shows (it fits the axes on, and compares with, all 30 cached races) ==');
out('Axes refitted on the archive (pca_compute.fit_pca, signs matched to the served loadings); panel statistics');
out('with pca_compute.feature_differences on the archive rows; label with _generate_cluster_label.');
{
  const early = new Set(backend.archives[0].races);
  const full = backend.archives[backend.archives.length - 1].races;
  out(`races of the dashboard's archive run after Monza 2024 (not in the first archive below): ${full.filter((r) => !early.has(r)).join(', ')} `
    + `(${full.filter((r) => !early.has(r)).length} of ${full.length})`);
}
for (const ar of backend.archives) {
  const g = ar.geometry;
  out(`-- ${ar.label}: ${ar.n_rows} rows of ${ar.n_races} races`);
  out(`  axes "${g.pc1_label}" ${pct1(g.explained[0])} / "${g.pc2_label}" ${pct1(g.explained[1])}`);
  out(`  PC2: one-stoppers y ${sgn(g.groups.A.y_min)} to ${sgn(g.groups.A.y_max)}, two-or-more-stoppers y ${sgn(g.groups.B.y_min)} to ${sgn(g.groups.B.y_max)}, `
    + `gap ${f2(g.gap_A_min_minus_B_max)}; other stars inside the hull ('This race'): A ${JSON.stringify(g.groups.A.intruders_this_race)}, `
    + `B ${JSON.stringify(g.groups.B.intruders_this_race)}; other rows inside ('All races'): A ${g.groups.A.intruders_all_rows}, B ${g.groups.B.intruders_all_rows}`);
  for (const name of ['A', 'B', 'C', 'LEC', 'LEC+SAI', 'PIA+NOR']) {
    const p = ar.panels[name];
    const above = p.rows.filter((r) => r.exceeds_random)
      .map((r) => `${r.label} g ${sgn(r.g)} [${sgn(r.ci_low)}, ${sgn(r.ci_high)}]`);
    const top = p.rows.slice(0, 3).map((r) => `${r.label} ${sgn(r.g)}`);
    const ex0 = p.rows.filter((r) => r.ci_low != null && (r.ci_low > 0 || r.ci_high < 0) && !r.exceeds_random)
      .map((r) => `${r.label} ${sgn(r.g)} [${sgn(r.ci_low)}, ${sgn(r.ci_high)}]`);
    out(`  ${name.padEnd(8)} N ${p.n_selected}: "${p.cluster_label}", ${p.n_above} of ${p.rows.length} above random (threshold ${f3(p.threshold)})`
      + `${above.length ? `: ${above.join('; ')}` : ''}; top |g|: ${top.join(', ')}`
      + `${['LEC+SAI', 'PIA+NOR'].includes(name) ? `; intervals excluding 0 but not above random: ${ex0.length}${ex0.length ? ` (${ex0.join('; ')})` : ''}` : ''}`);
  }
}
out('');

// ── 7. Outcome from the lap rows ─────────────────────────────────────────────
out('== 7. Outcome: the race from its lap rows (sessionData.lap_times, race_results) ==');
const lastRow = {};
const best = {};
for (const r of lapTimes) {
  const n = Number(r.LapNumber);
  if (!lastRow[r.Driver] || n > Number(lastRow[r.Driver].LapNumber)) lastRow[r.Driver] = r;
  const t = Number(r.LapTimeSeconds);
  if (Number.isFinite(t) && t > 0 && !r.Deleted && (!best[r.Driver] || t < best[r.Driver].t)) {
    best[r.Driver] = { t, lap: n, life: r.TyreLife, compound: r.Compound };
  }
}
const winner = results.find((r) => Number(r.Position) === 1).Abbreviation;
const bestRank = Object.entries(best).sort((a, b) => a[1].t - b[1].t).map(([d]) => d);
for (const r of results.slice(0, 8)) {
  const d = r.Abbreviation;
  const lr = lastRow[d];
  const gap = Number(lr.LapNumber) === Number(lastRow[winner].LapNumber)
    ? `${(Number(lr.Time) - Number(lastRow[winner].Time)).toFixed(3)} s` : `${Number(lastRow[winner].LapNumber) - Number(lr.LapNumber)} lap(s)`;
  const b = best[d];
  out(`  P${r.Position} ${d} ${String(r.TeamName).padEnd(16)} stops ${(stopsOf[d] || []).length} ${(stints[d] || []).map((s) => `${s.Compound} L${s.StartLap}-L${s.EndLap}`).join(', ')}; `
    + `behind the winner at the flag ${gap} (race_results Time ${r.Position === 1 ? 'winner' : `+${Number(r.Time).toFixed(3)} s`}); `
    + `best lap ${b.t.toFixed(3)} s on L${b.lap} (${b.compound}, tyre life ${b.life}), rank ${bestRank.indexOf(d) + 1} of ${bestRank.length}`);
}
const top5 = bestRank.slice(0, 5).map((d) => `${d} ${best[d].t.toFixed(3)} s L${best[d].lap} (${(stopsOf[d] || []).length} stops)`);
out(`  five fastest laps of the race: ${top5.join(', ')}`);
out('');
out(`Requests: /api calls ${apiCalls.length}; demo data files read: ${[...fetched].sort().join(', ')}`);

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`);
console.log(`-> ${OUT_FILE}`);
process.exit(0);
