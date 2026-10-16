// Phase 9c, state-help lane: the contrast pairs of F8 (focus + context, D7)
// and F11 (small contrast items, D10), before (the value the former code drew)
// and after (read from the working tree's palette and CSS).
//   node frontend/scripts/audit/focus_context_contrast.mjs
// Writes docs/evidence/focus_context_contrast.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('focus_context_contrast.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const C = await import(pathToFileURL(path.join(SRC, 'utils/colors.js')).href);
const H = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutCss.js')).href);
const { contrastRatio: cr, compositeOver, withAlpha, SURFACES, TEXT_COLORS, TEAM_COLORS, TYRE_COLORS, markColor, contrastText, contextColor } = C;
const panel = SURFACES.panel;
let fails = 0;
const row = (name, before, after, need) => {
  const ok = after >= need - 1e-9;
  if (!ok) fails += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(78)} before ${before == null ? '   - ' : before.toFixed(2)}  after ${after.toFixed(2)}  (needs ${need})`);
};
const worst = (list) => list.reduce((a, b) => (b.r < a.r ? b : a));

console.log('F8 / D7 focus + context (dark theme, on the panel #131326)');
console.log(`INFO ConsistencyPanel cards (card opacity 0.35 not selected / 0.5 other hovered / 0.55 low data), muted text: ${[0.35, 0.5, 0.55].map((a) => cr(withAlpha(TEXT_COLORS.muted, a), panel).toFixed(2)).join(' / ')}:1, secondary: ${[0.35, 0.5, 0.55].map((a) => cr(withAlpha(TEXT_COLORS.secondary, a), panel).toFixed(2)).join(' / ')}:1 (ConsistencyPanel.jsx is not in this lane: left to its owner)`);
row('RacePaceGrid context header (secondary on the 25 % team tint, worst team)', cr(withAlpha(TEXT_COLORS.secondary, 0.35), panel),
  worst(Object.values(TEAM_COLORS).map((c) => ({ r: cr(TEXT_COLORS.secondary, compositeOver(withAlpha(c, 0.25), panel)) }))).r, 3);
row('RacePaceGrid context cell (muted, no opacity)', null, cr(TEXT_COLORS.muted, panel), 3);
row('CircleOfDoom context ring label (muted, no opacity)', null, cr(TEXT_COLORS.muted, panel), 3);
row('CircleOfDoom context leader line (contextColor of the leader grey)', cr('rgba(255,255,255,0.084)', panel), cr(contextColor('rgba(255,255,255,0.28)', panel), panel), 2);
const bars = Object.entries(TEAM_COLORS).flatMap(([t, c]) => [c, C.teammateTint(c), C.teammateTint(c, 2)].map((x) => {
  const m = markColor(x, panel);
  return { t, before: cr(withAlpha(m, 0.2), panel), r: cr(contextColor(m, panel), panel), m };
}));
row(`ChampionshipStandings context bar, worst of ${bars.length} (${worst(bars).t})`, Math.min(...bars.map((b) => b.before)), worst(bars).r, 2);
const dashes = bars.map((b) => { const f = contextColor(b.m, panel); return { r: cr(contextColor(contrastText(f), f), f) }; });
row('ChampionshipStandings teammate dash on a context bar, worst', null, worst(dashes).r, 2);
row('ChampionshipStandings context name / points (muted)', null, cr(TEXT_COLORS.muted, panel), 3);
const fRow = compositeOver(withAlpha(C.STATUS_COLORS.predicted, 0.03), panel);
// utils/views/lapTimeChart.js forecastRowMarks (its module imports need the
// bundler's resolution; the formula is repeated here, the vitest
// fade.context.test.jsx checks the helper itself)
const forecastRowMarks = (team, compound) => {
  const badge = contextColor(C.tyreColor(compound), fRow);
  return { bar: contextColor(markColor(team, fRow), fRow), badge, badgeText: contrastText(badge) };
};
const badges = Object.keys(TYRE_COLORS).map((k) => {
  const before = cr(compositeOver(withAlpha(contrastText(TYRE_COLORS[k]), 0.5), compositeOver(withAlpha(TYRE_COLORS[k], 0.5), fRow)), compositeOver(withAlpha(TYRE_COLORS[k], 0.5), fRow));
  const m = forecastRowMarks(TEAM_COLORS.Ferrari, k);
  return { k, before, r: cr(m.badgeText, m.badge), mark: cr(m.badge, fRow) };
});
row('LapTimeChart forecast row tyre letter on its badge, worst compound', Math.min(...badges.map((b) => b.before)), worst(badges).r, 4.5);
row('LapTimeChart forecast row tyre badge on the row, worst compound', null, Math.min(...badges.map((b) => b.mark)), 2);
row('LapTimeChart retired row text (retired grey, no opacity)', null, cr(C.STATUS_COLORS.retired, panel), 3);

console.log('\nF11 / D10 small contrast items');
const rules = H.listFiles(SRC, ['.css']).flatMap((f) => H.parseCssFile(f));
const tokens = H.rootTokens(rules);
const colorIn = (v) => { const s = H.resolveVars(String(v), tokens); return H.parseColor(s) || H.parseColor((s.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i) || [])[1]); };
const bar = H.flatten(['#0f0f1e', colorIn(H.declOf(rules, '.weather-bar', 'background'))]);
const field = H.flatten([bar, colorIn(H.declOf(rules, '.search-bar__wrap', 'background'))]);
const fieldF = H.flatten([bar, colorIn(H.declOf(rules, '.search-bar--focused .search-bar__wrap', 'background'))]);
const border = colorIn(H.declOf(rules, '.search-bar__wrap', 'border'));
const focus = colorIn(H.declOf(rules, '.search-bar--focused .search-bar__wrap', 'border-color'));
row('search field boundary on the field', H.contrast(H.over(colorIn('#2A2A2A'), field), field), H.contrast(H.over(border, field), field), 3);
row('search field boundary on the weather bar', H.contrast(H.over(colorIn('#2A2A2A'), field), bar), H.contrast(H.over(border, field), bar), 3);
row('search field focus boundary', H.contrast(H.over(colorIn('rgba(213,253,81,0.27)'), fieldF), fieldF), H.contrast(H.over(focus, fieldF), fieldF), 3);
for (const vp of H.VIEWPORTS) {
  const root = H.rootFontPx(rules, tokens, vp.W, vp.H);
  const b = H.evalLength(H.resolveVars(H.declOf(rules, '.welcome-toast', 'bottom'), tokens), { ...vp, root });
  const chrome = H.evalLength(H.resolveVars('var(--chrome-bottom)', tokens), { ...vp, root });
  const ok = b >= chrome + 4;
  if (!ok) fails += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} welcome toast bottom at ${vp.name}: ${b.toFixed(1)} px, top of the bottom chrome ${chrome.toFixed(1)} px (before: 72 px, inside the timeline row)`);
}
const lightMuted = '#5F6673';
for (const s of ['#F7F6F3', '#FFFFFF', '#EFEEE9', '#E8E7E1']) {
  row(`light-theme muted text on ${s} (#6B7280 -> var(--color-text-muted) ${lightMuted})`, cr('#6B7280', s), cr(lightMuted, s), 4.5);
}
const left = rules.filter((r) => r.selector.includes('[data-theme="light"]') && r.decls.some((d) => /#6b7280/i.test(d.value))).length;
console.log(`${left ? 'FAIL' : 'OK  '} light-theme rules still in #6B7280: ${left} (24 before)`);
if (left) fails += 1;
console.log(`\n${fails ? `${fails} FAIL` : 'all pass'}`);
process.exitCode = fails ? 1 : 0;
