// Repair (V13 target 2, V1, V2, V3): the colour pairs a contrast review found
// under their threshold, re-evaluated on the working tree.
// Every value is read from the source (CSS declarations through the layout
// helpers, the palette of utils/colors.js, regexes on the components), then
// composited with its opacity / alpha over the surface it is drawn on
// (WCAG 2.1: text 4.5:1, marks and component boundaries 3:1).
// Also: every @keyframes that lowers the opacity of an element with text or a
// status mark, at its lowest opacity.
// Run: node frontend/scripts/audit/contrast_pairs.mjs
// Writes docs/evidence/contrast_pairs.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('contrast_pairs.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const H = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutCss.js')).href);
const C = await import(pathToFileURL(path.join(SRC, 'utils/colors.js')).href);
const d3 = await import(pathToFileURL(path.join(ROOT, 'frontend/node_modules/d3/src/index.js')).href);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const rules = H.listFiles(SRC, ['.css']).flatMap((f) => H.parseCssFile(f));
const tokens = H.rootTokens(rules);
const col = (v) => {
  const c = H.parseColor(H.resolveVars(String(v), tokens));
  if (!c) throw new Error(`colour ${v}`);
  return c;
};
const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const decl = (sel, prop) => H.declOf(rules, sel, prop);
const opacityOf = (sel) => {
  const v = decl(sel, 'opacity');
  return v == null ? 1 : Number(v);
};
const rows = [];
const add = (name, fg, bg, need, src) => {
  const r = H.contrast(fg, bg);
  rows.push({ ok: r >= need - 1e-9, r, need, name, fg: hex(fg), bg: hex(bg), src });
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const PANEL = col(C.SURFACES.panel);
const RAISED = col(C.SURFACES.raised);
const ELEVATED = col(C.SURFACES.elevated);
const WHITE = col('#FFFFFF');

// 1. Dock: glass (white 0.10) over the bottom of the app gradient; the fixed
//    and overflow buttons at the opacity of their own rule
const PAGE_LOW = col('#15152a');
const dockBg = H.over(col('rgba(255, 255, 255, 0.10)'), PAGE_LOW);
const dockText = col(decl('.bottom-tab-bar__tab', 'color'));
for (const [sel, need, name] of [
  ['.bottom-tab-bar__tab--fixed', 4.5, 'dock fixed buttons Layouts / Cmd K / Settings (label text)'],
  ['.bottom-tab-bar__tab--overflow', 3, 'dock overflow button ⋯ (the only way to the hidden items)'],
]) {
  const o = opacityOf(sel);
  add(`${name}, opacity ${o}`, H.over(dockText, dockBg, o), dockBg, need, `dashboard.css ${sel} (opacity ${decl(sel, 'opacity') ?? 'none'})`);
}

// 2. Shortcut hints: no faded state left; shown at full opacity, hidden whole
const hintsCss = read('components/ShortcutHints/ShortcutHints.css');
must(!/--faded/.test(hintsCss) && !/--faded/.test(read('components/ShortcutHints/ShortcutHints.jsx')), 'faded hints state still present');
must(/\.shortcut-hints--hidden \{[^}]*opacity: 0;[^}]*visibility: hidden;/.test(hintsCss), 'hidden state is not opacity 0 + visibility hidden');
const keyBg = col(decl('.shortcut-hint-key', 'background'));
add('shortcut hint key (shown; after 5 s hidden whole: opacity 0, visibility hidden)', col(decl('.shortcut-hint-key', 'color')), keyBg, 4.5, 'ShortcutHints.css .shortcut-hint-key');
add('shortcut hint label (shown)', col(decl('.shortcut-hint-label', 'color')), col(decl('.shortcut-hints', 'background')), 4.5, 'ShortcutHints.css .shortcut-hint-label');

// 3. Panel export button glyph on the panel header: the button takes its
//    colour from components.css .panel-export-btn (the theme's muted text,
//    secondary on hover / focus), drawn on the header over the panel glass
must(/className="panel-export-btn"/.test(read('components/ui/Panel.jsx')), 'Panel export button class not found');
const panelGlass = H.over(col(decl('.panel', 'background')), col(C.SURFACES.page));
const headerBg = H.over(col(decl('.panel-header', 'background')), panelGlass);
add(`Panel export icon (${decl('.panel-export-btn', 'color')}), non-text`, col(decl('.panel-export-btn', 'color')), headerBg, 3, 'components.css .panel-export-btn');
add(`Panel export icon, hover / focus (${decl('.panel-export-btn:hover', 'color')}), non-text`, col(decl('.panel-export-btn:hover', 'color')), headerBg, 3, 'components.css .panel-export-btn:hover, :focus-visible');

// 4. Championship: the standings' empty state
const champEmpty = read('components/visualizations/ChampionshipStandings.jsx').match(/color: (TEXT_COLORS\.\w+), fontSize: CHART_FONT\.data,\s*\}\}>\s*No championship data loaded/);
must(champEmpty, 'standings empty-state colour not found');
add(`Championship standings empty state (${champEmpty[1]})`, col(C.TEXT_COLORS[champEmpty[1].split('.')[1]]), panelGlass, 4.5, 'components/visualizations/ChampionshipStandings.jsx');

// 5. Race Pace Grid, focus + context: a context driver's header (secondary
//    text on the team tint) and cell (muted text, no tint, no opacity)
const paceJsx = read('components/visualizations/RacePaceGrid.jsx');
const tintA = Number((paceJsx.match(/compositeOver\(withAlpha\(teamColor, ([\d.]+)\), SURFACES\.panel\)/) || [])[1]);
must(Number.isFinite(tintA) && /color: dimmed \? TEXT_COLORS\.secondary : contrastText\(teamColor\)/.test(paceJsx), 'pace header dimming changed');
must(!/opacity: dimmed \?/.test(paceJsx) && /dimmed && cellStyle\?\.color !== 'transparent' \? \{ color: TEXT_COLORS\.muted, background: 'transparent' \}/.test(paceJsx), 'pace cell dimming changed');
let worstHeader = null;
for (const [team, c] of Object.entries(C.TEAM_COLORS)) {
  for (const colour of [c, C.teammateTint(c)]) {
    const bg = col(C.compositeOver(C.withAlpha(colour, tintA), C.SURFACES.panel));
    const r = H.contrast(col(C.TEXT_COLORS.secondary), bg);
    if (!worstHeader || r < worstHeader.r) worstHeader = { r, team, bg };
  }
}
add(`RacePaceGrid context header, secondary text on the team tint at ${tintA} (worst of ${Object.keys(C.TEAM_COLORS).length} teams and their tints: ${worstHeader.team})`, col(C.TEXT_COLORS.secondary), worstHeader.bg, 4.5, 'RacePaceGrid.jsx dimmedHeaderBg');
add('RacePaceGrid context cell (muted text, no opacity)', col(C.TEXT_COLORS.muted), PANEL, 4.5, 'RacePaceGrid.jsx PaceCell');

// 6. Circle of Doom: a context car's label (muted code, secondary gap tag), no opacity on the text
const codJsx = read('components/visualizations/CircleOfDoom.jsx');
must(/fill=\{c\.dim \? TEXT_COLORS\.muted : c\.text\}/.test(codJsx), 'Circle dim label colour changed');
must(!/<text[^>]*opacity=\{[^}]*dim/.test(codJsx), 'a Circle label is faded');
add('CircleOfDoom context ring label code (muted)', col(C.TEXT_COLORS.muted), PANEL, 4.5, 'CircleOfDoom.jsx cod-label__code');
add('CircleOfDoom ring label gap tag (secondary)', col(decl('.cod-label__gap', 'fill')), PANEL, 4.5, 'visualizations.css .cod-label__gap');
add('CircleOfDoom pit-lane arc (--status-pit, no opacity)', col(decl('.cod-pitlane', 'stroke')), PANEL, 3, `visualizations.css .cod-pitlane (opacity ${decl('.cod-pitlane', 'opacity') ?? 'none'})`);
must(decl('.cod-pitlane', 'opacity') == null, 'pit-lane arc has an opacity');
// A car lapped by the leader is hollow: the panel inside a ring of the car's
// mark colour (markColor(getDriverColor) on the panel: the team colour, the
// teammate tint for the second car, lifted toward white where it is under
// 3:1), the panel on both sides of the ring; no opacity (it was a 0.45 fill)
must(/color: markColor\(getDriverColor\(c\.driver\), SURFACES\.panel\),/.test(codJsx)
  && /className="cod-car__dot cod-car__dot--hollow"\s*r=\{c\.rad - HOLLOW_STROKE \/ 2\}\s*fill=\{SURFACES\.panel\}\s*stroke=\{c\.color\}/.test(codJsx)
  && !/fillOpacity/.test(codJsx), 'Circle hollow lapped car changed');
for (const [team, c] of Object.entries(C.TEAM_COLORS)) {
  let worst = null;
  const parts = [];
  for (const colour of [c, C.teammateTint(c), C.teammateTint(c, 2)]) {
    const mark = C.markColor(colour, C.SURFACES.panel);
    const fg = col(mark);
    const r = H.contrast(fg, PANEL);
    parts.push(mark === colour ? r.toFixed(2) : `${r.toFixed(2)} (markColor lifted ${colour} at ${H.contrast(col(colour), PANEL).toFixed(2)}:1)`);
    if (!worst || r < worst.r) worst = { r, fg };
  }
  add(`CircleOfDoom hollow lapped car ring, ${team}, the worst of its 1st / 2nd / 3rd car: ${parts.join(' / ')}`, worst.fg, PANEL, 3, 'CircleOfDoom.jsx cod-car__dot--hollow stroke');
}
add('CircleOfDoom hollow lapped car, second car\'s white cue outside the ring', WHITE, PANEL, 3, 'CircleOfDoom.jsx cod-car__second');

// 7. Track Map channel ramps: their low ends on the map backgrounds
for (const bgName of ['page', 'panel']) {
  const bg = col(C.SURFACES[bgName]);
  add(`TrackMap throttle / brake ramp low end CHANNEL_RAMP_LOW ${C.CHANNEL_RAMP_LOW} on ${bgName}`, col(C.CHANNEL_RAMP_LOW), bg, 3, 'utils/colors.js CHANNEL_RAMP_LOW');
  const lo = d3.interpolateCividis(C.SPEED_RAMP_START);
  add(`TrackMap speed ramp low end cividis(${C.SPEED_RAMP_START}) ${lo} on ${bgName}`, col(d3.color(lo).formatHex()), bg, 3, 'utils/colors.js SPEED_RAMP_START');
}

// 8. Retired rows: never faded
const lapJsx = read('components/visualizations/LapTimeChart.jsx');
must(!/retiredOpacity/.test(lapJsx), 'LapTimeChart retired opacity still present');
add('LapTimeChart retired row text (STATUS_COLORS.retired, no opacity)', col(C.STATUS_COLORS.retired), PANEL, 4.5, 'LapTimeChart.jsx');
must(decl('.tower-row--retired', 'opacity') == null, '.tower-row--retired has an opacity');
add('Leaderboard retired position text (--status-retired, no opacity)', col(decl('.tower-row__pos--retired', 'color').replace(' !important', '')), PANEL, 4.5, 'visualizations.css .tower-row--retired / .tower-row__pos--retired');

// 9. Delta areas (Lap Delta, telemetry GAP): the hatch lines are the diverging colours
const hatch = read('utils/views/deltaHatch.js');
must(/\.attr\('stroke', color\)/.test(hatch), 'hatch lines are not the diverging colour');
for (const [k, c] of Object.entries(C.DIVERGING).filter(([key]) => ['better', 'worse'].includes(key))) {
  add(`delta area hatch line (${k} ${c}) on the raised surface`, col(c), RAISED, 3, 'utils/views/deltaHatch.js');
  add(`delta area hatch line (${k} ${c}) on the panel`, col(c), PANEL, 3, 'utils/views/deltaHatch.js');
}

// 10. Championship standings bars: markColor, drawn opaque; a context bar is
//     mixed toward the panel (contextColor, >= 2:1, D7 phase 9c), no opacity
const standJsx = read('components/visualizations/ChampionshipStandings.jsx');
must(/const color = markColor\(style\.color, SURFACES\.panel\);/.test(standJsx)
  && /const barFill = isDimmed \? contextColor\(color, SURFACES\.panel\) : color;/.test(standJsx)
  && !/fill-opacity|stroke-opacity/.test(standJsx), 'standings bar colour changed');
let worstBar = null;
for (const [team, c] of Object.entries(C.TEAM_COLORS)) {
  for (const colour of [c, C.teammateTint(c), C.teammateTint(c, 2)]) {
    const r = H.contrast(col(C.markColor(colour, C.SURFACES.panel)), PANEL);
    if (!worstBar || r < worstBar.r) worstBar = { r, team, fg: col(C.markColor(colour, C.SURFACES.panel)) };
  }
}
add(`ChampionshipStandings bar, worst of ${Object.keys(C.TEAM_COLORS).length} teams x 3 drivers (${worstBar.team})`, worstBar.fg, PANEL, 3, 'ChampionshipStandings.jsx markColor');
let worstContext = null;
for (const [team, c] of Object.entries(C.TEAM_COLORS)) {
  for (const colour of [c, C.teammateTint(c), C.teammateTint(c, 2)]) {
    const fg = col(C.contextColor(C.markColor(colour, C.SURFACES.panel), C.SURFACES.panel));
    const r = H.contrast(fg, PANEL);
    if (!worstContext || r < worstContext.r) worstContext = { r, team, fg };
  }
}
add(`ChampionshipStandings context bar (contextColor, D7 mark floor), worst of the teams x 3 drivers (${worstContext.team})`, worstContext.fg, PANEL, 2, 'ChampionshipStandings.jsx barFill');
must(/style=\{l\.car\.dim \? \{ stroke: CONTEXT_LEADER \} : undefined\}/.test(codJsx), 'Circle context leader changed');
add('CircleOfDoom context leader line (contextColor of the leader grey, D7 mark floor)', col(C.contextColor('rgba(255,255,255,0.28)', C.SURFACES.panel)), PANEL, 2, 'CircleOfDoom.jsx CONTEXT_LEADER');

// 11. Tooltips and the session menu: --glass-bg-opaque, worst case over white
for (const sel of ['.tooltip', '.session-menu', '.telem-crosshair-tooltip']) {
  const bgDecl = decl(sel, 'background');
  const overWhite = H.over(col(bgDecl), WHITE);
  const overPanel = H.over(col(bgDecl), PANEL);
  for (const [tn, tc] of [['secondary', C.TEXT_COLORS.secondary], ['muted', C.TEXT_COLORS.muted]]) {
    add(`${sel} ${tn} text over white content (${bgDecl})`, col(tc), overWhite, 4.5, `${sel} background`);
  }
  add(`${sel} muted text over the panel (${bgDecl})`, col(C.TEXT_COLORS.muted), overPanel, 4.5, `${sel} background`);
}

// 12. Keyframes that fade an element with text or a status mark: at the lowest opacity
const allCss = H.listFiles(SRC, ['.css']).map((f) => [path.relative(SRC, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]);
const kfMin = new Map();
for (const [, src] of allCss) {
  for (const m of src.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
    const ops = [...m[2].matchAll(/opacity:\s*([\d.]+)/g)].map((x) => Number(x[1]));
    if (ops.length) kfMin.set(m[1], Math.min(...ops));
  }
}
const animated = [
  // [selector, keyframes, text colour, background (opaque), need, what]
  ['.tower-col-value--pit', 'pit-blink', decl('.tower-col-value--pit', 'color'), H.over(col('color-mix(in srgb, var(--status-pit) 8%, transparent)'), PANEL), 4.5, 'tower PIT value text'],
  ['.status-dot', 'pulse', decl('.status-dot', 'background-color'), col(C.SURFACES.page), 3, 'header status dot (non-text)'],
];
for (const [sel, kf, fgDecl, bg, need, what] of animated) {
  const anim = decl(sel, 'animation') || '';
  must(anim.includes(kf), `${sel} no longer runs ${kf}`);
  const lo = kfMin.get(kf);
  add(`${what}, ${kf} at its lowest opacity ${lo}`, H.over(col(fgDecl), bg, lo), bg, need, `${sel} animation ${kf}`);
}

// The battle glyph ⚔ no longer pulses and the battle row has a
// neutral tint (orange keeps one meaning in the tower): the glyph at full
// opacity on that tint, as text
must(!(decl('.tower-row__battle-badge', 'animation') || '').includes('battle-pulse'), '.tower-row__battle-badge pulses again');
add('tower battle glyph ⚔ (no animation) on the battle row tint', col(decl('.tower-row__battle-badge', 'color')),
  H.over(col(decl('.tower-row--battle', 'background').replace(/\s*!important/, '')), PANEL), 4.5, '.tower-row__battle-badge on .tower-row--battle');

// 13. The drawn wordmark (Wordmark.jsx): the line and the dot in
//     --color-brand-accent (a mark, 3:1), the word in --color-text-primary
//     and the start screen's tagline in --color-text-secondary (text, 4.5:1), on
//     the weather bar, the header and the start screen of each theme. A bar
//     is its glass over the top of the app background; the start screen is
//     each stop of its gradient, alone and under the centre of its glow.
//     The favicon: its line and dot on its square.
const lightTokens = new Map(tokens);
for (const r of rules) {
  if (!r.media && r.selector.trim() === '[data-theme="light"]') {
    for (const d of r.decls) if (d.prop.startsWith('--')) lightTokens.set(d.prop, d.value);
  }
}
const colIn = (v, toks) => {
  const c = H.parseColor(H.resolveVars(String(v), toks));
  if (!c) throw new Error(`colour ${v}`);
  return c;
};
const gradientColours = (v) => (String(v).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || []);
must(/<Wordmark className="weather-bar__wordmark" \/>/.test(read('components/ui/WeatherBar.jsx'))
  && /<Wordmark className="header-wordmark" \/>/.test(read('components/ui/Header.jsx'))
  && /<h1 className="session-screen__title"><Wordmark size="hero" tagline \/><\/h1>/.test(read('components/ui/SessionSelectorScreen.jsx')),
'the wordmark is not drawn where this check measures it');
must(decl('.wordmark-svg__line', 'stroke') === 'var(--color-brand-accent)' && decl('.wordmark-svg__dot', 'fill') === 'var(--color-brand-accent)'
  && decl('.wordmark-svg__name', 'fill') === 'var(--color-text-primary)'
  && decl('.wordmark-lockup__tagline', 'color') === 'var(--color-text-secondary)', 'wordmark colours changed');
for (const [theme, toks, pre] of [['dark', tokens, ''], ['light', lightTokens, '[data-theme="light"] ']]) {
  const accent = colIn('var(--color-brand-accent)', toks);
  const word = colIn('var(--color-text-primary)', toks);
  const tagline = colIn('var(--color-text-secondary)', toks);
  const appBg = theme === 'dark' ? gradientColours(decl('.app-container', 'background'))[0] : decl(`${pre}.app-container`, 'background');
  const bars = [
    ['weather bar', H.over(colIn(decl(`${pre}.weather-bar`, 'background'), toks), colIn(appBg, toks)), `${pre}.weather-bar over ${appBg}`],
    ['header', H.over(colIn(decl(`${pre}.app-header`, 'background'), toks), colIn(appBg, toks)), `${pre}.app-header over ${appBg}`],
  ];
  const glow = gradientColours(decl(`${pre}.session-screen__glow`, 'background'))[0];
  for (const stop of gradientColours(decl(`${pre}.session-screen`, 'background'))) {
    bars.push([`start screen ${stop}`, colIn(stop, toks), `${pre}.session-screen`]);
    bars.push([`start screen ${stop} under the glow ${glow}`, H.over(colIn(glow, toks), colIn(stop, toks)), `${pre}.session-screen, .session-screen__glow`]);
  }
  for (const [where, bg, src] of bars) {
    add(`wordmark line and dot (--color-brand-accent, ${theme}) on the ${where}`, accent, bg, 3, src);
    add(`wordmark word (--color-text-primary, ${theme}) on the ${where}`, word, bg, 4.5, src);
    if (where.startsWith('start screen')) add(`wordmark tagline (--color-text-secondary, ${theme}) on the ${where}`, tagline, bg, 4.5, src);
  }
}
const favicon = fs.readFileSync(path.join(ROOT, 'frontend/public/fonts/favicon.svg'), 'utf8');
const favSquare = (favicon.match(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/) || [])[1];
const favMarks = [...favicon.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]).filter((c) => c !== favSquare);
must(favSquare && favMarks.length > 0, 'favicon colours not found');
for (const c of new Set(favMarks)) add(`favicon mark ${c} on its square`, col(c), col(favSquare), 3, 'public/fonts/favicon.svg');
// The accent is no data colour: its nearest data colours (CIEDE2000), for
// the record (not gated: the wordmark is drawn away from every chart)
const DATA_COLOURS = {
  ...Object.fromEntries(Object.entries(C.TYRE_COLORS).filter(([k]) => k !== 'UNKNOWN').map(([k, v]) => [`TYRE_COLORS.${k}`, v])),
  ...Object.fromEntries(Object.entries(C.FLAG_COLORS).map(([k, v]) => [`FLAG_COLORS.${k}`, v])),
  ...Object.fromEntries(Object.entries(C.TEAM_COLORS).map(([k, v]) => [`TEAM_COLORS.${k}`, v])),
  ...Object.fromEntries(Object.entries(C.STATUS_COLORS).map(([k, v]) => [`STATUS_COLORS.${k}`, v])),
  ...Object.fromEntries(Object.entries(C.CHANNEL_COLORS).map(([k, v]) => [`CHANNEL_COLORS.${k}`, v])),
  ...Object.fromEntries(C.SERIES_COLORS.map((v, i) => [`SERIES_COLORS[${i}]`, v])),
  ...Object.fromEntries(Object.entries(C.OUTCOME_COLORS).map(([k, v]) => [`OUTCOME_COLORS.${k}`, v])),
  'DIVERGING.better': C.DIVERGING.better, 'DIVERGING.worse': C.DIVERGING.worse,
  'UI_COLORS.brush': C.UI_COLORS.brush, 'UI_COLORS.pitWindow': C.UI_COLORS.pitWindow,
};
const brandInfo = [];
{
  const accent = hex(col('var(--color-brand-accent)'));
  for (const t of ['normal', 'protanopia', 'deuteranopia', 'tritanopia']) {
    const sim = (c) => (t === 'normal' ? c : C.simulateCvd(c, t));
    const near = Object.entries(DATA_COLOURS).map(([k, v]) => [k, v, C.deltaE2000(sim(accent), sim(v))])
      .sort((a, b) => a[2] - b[2]).slice(0, 3);
    brandInfo.push(`--color-brand-accent ${accent}, ${t}: nearest data colours ${near.map(([k, v, d]) => `${k} ${v} ${d.toFixed(1)}`).join(', ')}`);
  }
}

// Before the repair, for the record (not gated): the PIT text blinked down to
// opacity 0.5; the delta areas were a 22 % tint
const info = [];
{
  const bg = H.over(col('color-mix(in srgb, var(--status-pit) 8%, transparent)'), PANEL);
  const fg = col(decl('.tower-col-value--pit', 'color'));
  info.push(`tower PIT value text at the former pit-blink low of 0.5: ${H.contrast(H.over(fg, bg, 0.5), bg).toFixed(2)}:1`);
  for (const [k, c] of Object.entries(C.DIVERGING).filter(([key]) => ['better', 'worse'].includes(key))) {
    info.push(`delta area as the former 22 % tint (${k}) on the raised surface: ${H.contrast(H.over(col(C.withAlpha(c, 0.22)), RAISED), RAISED).toFixed(2)}:1`);
  }
}

const fails = rows.filter((r) => !r.ok);
console.log(`Repair contrast check (WCAG 2.1), ${rows.length} pairs read from the working tree, ${new Date().toISOString().slice(0, 10)}`);
for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.r.toFixed(2)}:1 (needs ${r.need})  ${r.name}  fg ${r.fg} on ${r.bg}  [${r.src}]`);
}
for (const line of info) console.log(`INFO (before the repair, not gated) ${line}`);
for (const line of brandInfo) console.log(`INFO (brand accent, CIEDE2000, not gated) ${line}`);
console.log(`\n${fails.length} of ${rows.length} pairs under their threshold`);
process.exitCode = fails.length ? 1 : 0;
