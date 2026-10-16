/**
 * What the PCA biplot and the cross-race analysis panel show (P2, P3, P5):
 * the components are mounted with the real artefact
 * (backend/data/processed/pca_embeddings.json) in a minimal DOM
 * (src/__tests__/helpers/miniDom.js), and the text, legend and marks they draw
 * are read back.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/ and
 * transforms the JSX):
 *     npx vite-node scripts/pca_views_probe.mjs [label]
 * Writes docs/evidence/pca_views_probe_<label>.txt (label default
 * 'now') and prints the same text.
 *
 * Sections:
 *  P5. every team name of the cached sessions (driver_info) -> getTeamColor,
 *      the ones left on the fallback grey; the biplot legend (labels, swatch
 *      kind, colour) against the marks (shape, fill, team): teams drawn with
 *      no legend entry, legend swatches that match no mark;
 *  P2. the biplot's controls, its legends, what decides the fill of a mark,
 *      the tooltip rows;
 *  P3. the lasso analysis: the route the store posts a selection to, and the
 *      text of every tab of the panel for a real analysis response
 *      (docs/evidence/pca_selection_sample.json, the backend's
 *      analyze_selection of 5 points; skipped when absent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from '../src/__tests__/helpers/miniDom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT_DIR = path.join(ROOT, 'docs/evidence');
const label = process.argv[2] || 'now';
const lines = [];
const emit = (s = '') => { lines.push(s); console.log(s); };

// In-memory localStorage for the store's persist middleware
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};

const dom = installMiniDom();
const EMBEDDINGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/data/processed/pca_embeddings.json'), 'utf8'));
const SAMPLE_FILE = path.join(OUT_DIR, 'pca_selection_sample.json');
const SAMPLE = fs.existsSync(SAMPLE_FILE) ? JSON.parse(fs.readFileSync(SAMPLE_FILE, 'utf8')) : null;

// Every request of the API client is answered here and recorded
const axios = (await import('axios')).default;
const requests = [];
axios.defaults.adapter = async (config) => {
  requests.push({ method: config.method, url: config.url, data: config.data ? JSON.parse(config.data) : null });
  let data = {};
  if (/pca\/embeddings/.test(config.url)) data = EMBEDDINGS;
  else if (/analyze-selection/.test(config.url) && SAMPLE) data = SAMPLE;
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const d3 = await import('d3');
const { getTeamColor } = await import('../src/utils/colors.js');
const { useF1Store } = await import('../src/store/useF1Store.js');
const { default: PCABiplot } = await import('../src/components/visualizations/PCABiplot.jsx');
const { default: PCAAnalysisPanel } = await import('../src/components/visualizations/PCAAnalysisPanel.jsx');

const FALLBACK = getTeamColor(null);
const INITIAL = useF1Store.getState();

async function mount(Component) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 640, height: 420 });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  return { host, async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// ── P5: team colours ────────────────────────────────────────────────
emit(`PCA views probe (${label})`);
emit('');
emit('P5. Team names of the cached sessions -> getTeamColor');
const cacheDir = path.join(ROOT, 'backend/data/processed_cache');
const teams = new Map();
if (fs.existsSync(cacheDir)) {
  for (const f of fs.readdirSync(cacheDir).filter((n) => /^session_.*\.json$/.test(n)).sort()) {
    const raw = fs.readFileSync(path.join(cacheDir, f), 'utf8').replace(/\bNaN\b/g, 'null');
    for (const d of JSON.parse(raw).driver_info || []) {
      if (d?.TeamName && !teams.has(d.TeamName)) teams.set(d.TeamName, f);
    }
  }
}
for (const [team, file] of [...teams].sort()) {
  const c = getTeamColor(team);
  emit(`  ${team.padEnd(16)} ${c}${c === FALLBACK ? '  <- fallback grey' : ''}   (first seen in ${file})`);
}
const greyTeams = [...teams.keys()].filter((t) => getTeamColor(t) === FALLBACK);
emit(`  team names: ${teams.size}; on the fallback grey: ${greyTeams.length} (${greyTeams.join(', ') || '-'})`);

// ── Biplot ──────────────────────────────────────────────────────────
useF1Store.setState({
  ...INITIAL,
  pcaEmbeddings: EMBEDDINGS, selectedPCAPoints: [], selectedDrivers: [],
  year: 2024, round: 16, loadedYear: 2024, loadedRound: 16, loadedSessionType: 'R',
});
const biplot = await mount(PCABiplot);
const svg = biplot.host.querySelector('.viz-container svg');
const marks = svg.querySelectorAll('path.pca-point');
const STAR = d3.symbol().type(d3.symbolStar);
const isStar = (d) => /^M0,-/.test(d) && (d.match(/L/g) || []).length >= 9;

const artefactTeams = [...new Set(EMBEDDINGS.points.map((p) => p.team))];
emit('');
emit(`  artefact: ${EMBEDDINGS.points.length} points, ${artefactTeams.length} team names (${artefactTeams.join(', ')})`);
emit(`  marks drawn: ${marks.length}`);

const readLegend = () => [...biplot.host.querySelectorAll('.legend-item')].map((el) => {
  const sw = el.querySelector('svg path') || el.querySelector('.legend-color');
  return {
    label: text(el.querySelector('.legend-label')) || text(el),
    kind: sw?.localName === 'path' ? (isStar(sw.getAttribute('d')) ? 'svg star' : 'svg symbol')
      : (sw?.getAttribute('class') || '').includes('circle') ? 'css circle' : 'css bar (14x3 px)',
    color: sw?.localName === 'path' ? (sw.style.fill || sw.getAttribute('fill') || '') : (sw?.style.backgroundColor || ''),
    outline: sw?.localName === 'path' ? (sw.getAttribute('class') || sw.style.stroke || '') : '',
  };
});
const legendItems = readLegend();
emit(`  legend titles: ${[...biplot.host.querySelectorAll('.legend-title')].map((t) => `"${text(t)}"`).join(', ') || '-'}`);
emit(`  legend entries: ${legendItems.length}`);
for (const it of legendItems) emit(`    ${it.label.padEnd(28)} ${it.kind.padEnd(18)} ${it.color} ${it.outline}`);

const markTeams = new Map();
let starMarks = 0;
const starFills = new Set();
for (const m of marks) {
  const d = m.__data__;
  const fill = m.getAttribute('fill');
  if (isStar(m.getAttribute('d'))) { starMarks += 1; starFills.add(fill); }
  if (!markTeams.has(d.team)) markTeams.set(d.team, { fills: new Set(), n: 0 });
  markTeams.get(d.team).fills.add(fill);
  markTeams.get(d.team).n += 1;
}
emit('  marks by team (fill colours):');
for (const [team, v] of markTeams) {
  const legend = legendItems.find((it) => it.label === team);
  emit(`    ${team.padEnd(16)} n=${String(v.n).padStart(3)}  fill ${[...v.fills].join('/')}  legend: ${legend ? `${legend.kind} ${legend.color}` : 'NONE'}`);
}
const noLegend = [...markTeams.keys()].filter((t) => !legendItems.some((it) => it.label === t));
emit(`  teams drawn with no legend entry: ${noLegend.length} (${noLegend.join(', ') || '-'})`);
emit(`  star marks (the loaded race, 2024 R16): ${starMarks}, fills: ${[...starFills].join(', ')}`);
const starLegend = legendItems.filter((it) => it.kind === 'svg star' || /current race/i.test(it.label));
emit(`  legend entries for the star marks: ${starLegend.map((it) => `"${it.label}" ${it.kind} ${it.color} ${it.outline}`).join('; ') || 'NONE'}`);
const starMark = [...marks].find((m) => isStar(m.getAttribute('d')));
const starSwatch = [...biplot.host.querySelectorAll('.legend-item svg path')].find((p) => isStar(p.getAttribute('d')));
emit(`  star swatch path === star mark path: ${!!starMark && !!starSwatch && starSwatch.getAttribute('d') === starMark.getAttribute('d')}`
  + `; star mark class "${starMark?.getAttribute('class')}", swatch class "${starSwatch?.getAttribute('class') || '-'}"`);
void STAR;

// ── P2 ──────────────────────────────────────────────────────────────
emit('');
emit('P2. Biplot controls, outcome encoding, tooltip');
const buttons = [...biplot.host.querySelectorAll('.panel-controls button, .panel-controls [role="radio"]')]
  .map((b) => text(b) || b.getAttribute('title'));
emit(`  header controls: ${buttons.map((b) => `[${b}]`).join(' ')}`);
const fillsByFinish = new Map();
for (const m of marks) {
  const fin = m.__data__.finish_position;
  const key = fin == null ? 'none' : fin <= 3 ? 'P1-P3' : fin <= 10 ? 'P4-P10' : 'P11+';
  if (!fillsByFinish.has(key)) fillsByFinish.set(key, new Set());
  fillsByFinish.get(key).add(m.getAttribute('fill'));
}
emit(`  distinct fills per finish class (team colouring gives every class the team colours): ${[...fillsByFinish].map(([k, v]) => `${k}: ${v.size}`).join(', ')}`);
const clickButton = async (label) => {
  const b = [...biplot.host.querySelectorAll('.panel-controls button')].find((x) => text(x) === label);
  if (!b) { emit(`  (no [${label}] button)`); return false; }
  await act(async () => { dom.mouse(b, 'click'); });
  return true;
};
const finishReport = (tag) => {
  const ms = [...svg.querySelectorAll('path.pca-point')];
  const byClass = new Map();
  for (const m of ms) {
    const fin = m.__data__.finish_position;
    const key = fin == null ? 'none' : fin <= 3 ? 'P1-P3' : fin <= 10 ? 'P4-P10' : 'P11+';
    if (!byClass.has(key)) byClass.set(key, new Set());
    byClass.get(key).add(m.getAttribute('fill'));
  }
  emit(`  ${tag}: ${ms.length} marks; fills per finish class: ${[...byClass].map(([k, v]) => `${k} ${[...v].join('/')}`).join(', ')}`);
  const stars = ms.filter((m) => isStar(m.getAttribute('d')));
  emit(`    star marks (2024 R16): ${stars.length}, fills ${[...new Set(stars.map((m) => m.getAttribute('fill')))].join('/') || '-'}`);
  emit(`    legend: ${readLegend().map((it) => `${it.label} [${it.color}${it.outline ? ` ${it.outline}` : ''}]`).join('; ')}`);
};
if (await clickButton('Finish')) {
  finishReport('colour = finish, session over');
  // a replay of 2024 R16 at lap 20: the loaded race's own result is withheld
  const monzaFile = path.join(cacheDir, 'session_2024_16_R.json');
  if (fs.existsSync(monzaFile)) {
    const monza = JSON.parse(fs.readFileSync(monzaFile, 'utf8'));
    const maxLap = Math.max(...monza.lap_times.map((r) => r.LapNumber || 0));
    await act(async () => { useF1Store.setState({ sessionData: { lap_times: monza.lap_times }, maxLap, currentLap: 20, totalFrames: 0, lapModeRaceOver: false }); });
    emit(`    store getSessionNow() = ${useF1Store.getState().getSessionNow()}`);
    finishReport('colour = finish, replay of 2024 R16 at lap 20');
    const star = [...svg.querySelectorAll('path.pca-point')].find((m) => isStar(m.getAttribute('d')));
    await act(async () => { dom.mouse(star, 'mouseenter', { clientX: 10, clientY: 10, bubbles: false }); });
    const html = dom.document.querySelector('.pca-tooltip')?.innerHTML || '';
    emit(`    tooltip of ${star.__data__.id} (finish ${star.__data__.finish_position} in the artefact): ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
    await act(async () => { useF1Store.setState({ sessionData: null, maxLap: 1, currentLap: 1 }); });
  }
  if (await clickButton('This race')) finishReport('filter = This race');
  await clickButton('All races');
  await clickButton('Team');
}
const firstMark = svg.querySelectorAll('path.pca-point')[0];
await act(async () => { dom.mouse(firstMark, 'mouseover', { clientX: 10, clientY: 10 }); dom.mouse(firstMark, 'mouseenter', { clientX: 10, clientY: 10, bubbles: false }); });
const tip = dom.document.querySelector('.pca-tooltip');
const tipLabels = (tip?.innerHTML.match(/tooltip-label">([^<]*)</g) || []).map((s) => s.replace(/.*">/, '').replace('<', ''));
emit(`  tooltip of ${firstMark.__data__.id}: rows [${tipLabels.join(', ')}]`);
emit(`  tooltip mentions the finishing position: ${/finish/i.test(tip?.innerHTML || '')}`);

// ── P3 ──────────────────────────────────────────────────────────────
emit('');
emit('P3. Lasso analysis: route and panel');
const ids = SAMPLE?._selection || EMBEDDINGS.points.slice(0, 5).map((p) => p.id);
requests.length = 0;
await act(async () => { await useF1Store.getState().fetchPCAAnalysis(ids); });
for (const r of requests) emit(`  fetchPCAAnalysis(${ids.length} ids) -> ${r.method.toUpperCase()} ${r.url} body keys [${Object.keys(r.data || {}).join(', ')}]`);
await biplot.unmount();

if (SAMPLE) {
  const { _selection, ...analysis } = SAMPLE;
  useF1Store.setState({ selectedPCAPoints: _selection, pcaStrategyAnalysis: analysis });
  const panel = await mount(PCAAnalysisPanel);
  const tabs = () => [...panel.host.querySelectorAll('button')].filter((b) => /^(Summary|Patterns|Features|Differences|Details)/.test(text(b)));
  emit(`  tabs: ${tabs().map((b) => `[${text(b)}]`).join(' ')}`);
  for (const name of tabs().map((b) => text(b))) {
    const btn = tabs().find((b) => text(b) === name);
    await act(async () => { dom.mouse(btn, 'click'); });
    const body = text(panel.host.querySelector('.panel-content'));
    emit(`  -- tab ${name}: ${body.length} chars`);
    const keys = ["Cohen", "Hedges", "95%", "interval", "random", "N =", "not a test", "NOT A TEST", "large", "medium", "small"];
    emit(`     mentions: ${keys.map((k) => `${k}:${body.includes(k) ? 'yes' : 'no'}`).join('  ')}`);
    const svgTexts = [...panel.host.querySelectorAll('.panel-content svg text')].map((t) => text(t)).filter(Boolean);
    if (svgTexts.length) emit(`     svg text: ${svgTexts.slice(0, 14).join(' | ')}`);
    const banner = panel.host.querySelector('.pca-stats-banner');
    if (banner) emit(`     banner: ${text(banner)}`);
    const forestRows = [...panel.host.querySelectorAll('.pca-forest-row')];
    for (const r of forestRows) {
      const tick = r.querySelector('.pca-forest-g');
      const band = r.querySelector('.pca-forest-baseline');
      emit(`     row: ${text(r)}  | tick x=${tick?.getAttribute('x1')}, interval ${r.querySelector('.pca-forest-interval')?.getAttribute('x1')}..${r.querySelector('.pca-forest-interval')?.getAttribute('x2')}, band ${band?.getAttribute('x')}+${band?.getAttribute('width')}`);
    }
  }
  await panel.unmount();
} else {
  emit('  (no pca_selection_sample.json: panel section skipped)');
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, `pca_views_probe_${label}.txt`), `${lines.join('\n')}\n`);
process.exit(0);
