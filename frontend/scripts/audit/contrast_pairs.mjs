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
// The pit-lane segment: the pit colour at full strength, 2 px, dashed; the
// pit state is also told by place and the PIT / OUT label (never the colour alone)
must(decl('.cod-pitlane', 'stroke-width') === '2' && decl('.cod-pitlane', 'stroke-dasharray') != null, 'pit-lane segment is not a 2 px dashed stroke');
must(/<path className="cod-pitlane" d=\{pitPath\} data-r=/.test(codJsx), 'pit-lane segment path changed');
add('CircleOfDoom pit-lane segment (--status-pit, 2 px dashed, no opacity)', col(decl('.cod-pitlane', 'stroke')), PANEL, 3, `visualizations.css .cod-pitlane (opacity ${decl('.cod-pitlane', 'opacity') ?? 'none'})`);
must(decl('.cod-pitlane', 'opacity') == null, 'pit-lane segment has an opacity');
// Sector marks: the 1 px ticks (a mark, neutral), the S1 / S2 / S3 / PIT labels (text, neutral)
must(decl('.cod-sector-tick', 'stroke-width') === '1' && decl('.cod-sector-tick', 'opacity') == null, 'sector tick changed');
add('CircleOfDoom sector tick (1 px, no opacity)', col(decl('.cod-sector-tick', 'stroke')), PANEL, 3, 'visualizations.css .cod-sector-tick');
add('CircleOfDoom sector mark label S1 / S2 / S3 / PIT', col(decl('.cod-sector-mark', 'fill')), PANEL, 4.5, 'visualizations.css .cod-sector-mark');
// Gap list (CircleGapList.jsx): header and hint (label text), the numbers (data
// text), the clear button's glyph; the driver code is textColor(team, panel) (>= 4.5:1 by construction)
must(/'--cod-gaps-code': textColor\(getDriverColor\(row\.driver\), SURFACES\.panel\)/.test(read('components/visualizations/CircleGapList.jsx')), 'gap list code colour changed');
add('CircleOfDoom gap list header / hint (muted)', col(decl('.cod-gaps__hint', 'color')), PANEL, 4.5, 'visualizations.css .cod-gaps__head, .cod-gaps__hint');
add('CircleOfDoom gap list gap to the reference (primary)', col(decl('.cod-gaps__ref', 'color')), PANEL, 4.5, 'visualizations.css .cod-gaps__ref');
add('CircleOfDoom gap list gap to the row above, trend glyph (secondary)', col(decl('.cod-gaps__prev', 'color')), PANEL, 4.5, 'visualizations.css .cod-gaps__prev, .cod-gaps__trend');
add('CircleOfDoom gap list row hover (white 0.06), its numbers (secondary)', col(decl('.cod-gaps__prev', 'color')), H.over(col('rgba(255, 255, 255, 0.06)'), PANEL), 4.5, 'visualizations.css .cod-gaps__row:hover');
add('CircleOfDoom gap list clear button glyph (primary) on its fill', col(decl('.cod-gaps__clear', 'color')), H.over(col(decl('.cod-gaps__clear', 'background')), PANEL), 4.5, 'visualizations.css .cod-gaps__clear');
// The header toggle "gaps", on (pressed) and off, on the panel header over the panel glass
add('CircleOfDoom "gaps" toggle text, off', col(decl('.cod-gaps-toggle', 'color')), H.over(col(decl('.cod-gaps-toggle', 'background')), headerBg), 4.5, 'visualizations.css .cod-gaps-toggle');
add('CircleOfDoom "gaps" toggle text, on', col(decl('.cod-gaps-toggle', 'color')), H.over(col(decl('.cod-gaps-toggle[aria-pressed="true"]', 'background')), headerBg), 4.5, 'visualizations.css .cod-gaps-toggle[aria-pressed="true"]');
add('CircleOfDoom "gaps" toggle border, off (a control boundary)', H.over(col(decl('.cod-gaps-toggle', 'border').split(' solid ')[1]), headerBg), headerBg, 3, 'visualizations.css .cod-gaps-toggle');
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

// 13. The logo (Wordmark.jsx): the files of public/brand, their colours read
//     from the files and named by the intro files' own parts (class l: the
//     letters, with the masked stroke of the past; k: the kerb; dot: the
//     orange of now and the forecast; the rest of the forecast group: the
//     cone). Each mark colour (letters, orange, kerb red) at 3:1, as a
//     graphic, on the weather bar and the header (the primary file) and on
//     the start screen (the intro file: each stop of its gradient, alone and
//     under the centre of its glow), in each theme; a file that paints its
//     own panel puts its marks on that panel. The cone is decorative: printed,
//     not gated. The tagline is text, 4.5:1. The session menu and Settings >
//     About show the primary file too: printed, not gated.
//     The favicon: its marks on its own tile.
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
const wordmark = read('components/ui/Wordmark.jsx');
must(/<Wordmark className="weather-bar__wordmark" \/>/.test(read('components/ui/WeatherBar.jsx'))
  && /<Wordmark className="header-wordmark" \/>/.test(read('components/ui/Header.jsx'))
  && /<h1 className="session-screen__title"><Wordmark size="hero" tagline \/><\/h1>/.test(read('components/ui/SessionSelectorScreen.jsx'))
  && /<Wordmark \/>/.test(read('components/ui/SessionMenu.jsx'))
  && /<Wordmark \/>/.test(read('components/tabs/SettingsTabContent.jsx')),
'the logo is not shown where this check measures it');
must(/header: \{ file: 'variante_primary'/.test(wordmark) && /hero: \{ file: 'variante_intro_primary'/.test(wordmark)
  && /brand\/\$\{LOGO_FILES\[size\]\.file\}_\$\{theme\}\.svg/.test(wordmark), 'Wordmark.jsx no longer shows these files');
must(decl('.wordmark__img--light', 'display') === 'none' && decl('[data-theme="light"] .wordmark__img--dark', 'display') === 'none'
  && decl('[data-theme="light"] .wordmark__img--light', 'display') === 'block', 'the theme files are no longer shown one per theme');
must(decl('.wordmark__tagline', 'color') === 'var(--color-text-secondary)', 'tagline colour changed');
const BRAND = path.join(ROOT, 'frontend/public/brand');
const svgText = (f) => fs.readFileSync(path.join(BRAND, f), 'utf8').replace(/<defs>[\s\S]*?<\/defs>/g, '');
const fillOf = (attrs) => ((attrs.match(/\bfill="(#[0-9a-fA-F]{6})"/) || [])[1] || '').toUpperCase();
const viewBoxOf = (svg) => (svg.match(/viewBox="([^"]+)"/) || [])[1].trim().split(/\s+/).map(Number);
/** The panel a file paints under its drawing: a rect over its whole view box. */
function panelOf(svg) {
  const vb = viewBoxOf(svg);
  for (const m of svg.matchAll(/<rect\b([^>]*)>/g)) {
    const a = (k) => Number((m[1].match(new RegExp(`\\b${k}="([-\\d.]+)"`)) || [])[1]);
    if (['x', 'y', 'width', 'height'].every((k, i) => Math.abs(a(k) - vb[i]) < 0.01)) return fillOf(m[1]);
  }
  return null;
}
/** Colour -> role of an intro file, from its parts. */
function introRoles(svg) {
  const roles = new Map();
  const set = (c, role) => {
    must(c, `a ${role} part without a colour`);
    must(!roles.has(c) || roles.get(c) === role, `${c} is both ${roles.get(c)} and ${role}`);
    roles.set(c, role);
  };
  for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
    const cls = (m[1].match(/\bclass="([^"]*)"/) || [])[1] || '';
    if (/\bl\b/.test(cls) || /\bmask="url\(#mp\)"/.test(m[1])) set(fillOf(m[1]), 'letters');
    else if (/\bk\b/.test(cls)) set(fillOf(m[1]), 'kerb red');
    else if (/\bdot\b/.test(cls)) set(fillOf(m[1]), 'orange');
  }
  const forecast = (svg.match(/<g mask="url\(#mf\)">([\s\S]*?)<\/g>/) || [])[1] || '';
  for (const m of forecast.matchAll(/<path\b([^>]*)>/g)) {
    const c = fillOf(m[1]);
    if (roles.get(c) !== 'orange') set(c, 'cone');
  }
  must(['letters', 'orange', 'kerb red', 'cone'].every((r) => [...roles.values()].includes(r)), 'a part of the logo not found');
  return roles;
}
const logoInfo = [];
const ROLE_ORDER = ['letters', 'orange', 'kerb red', 'cone'];
const logoOf = (file, roles) => {
  const svg = svgText(file);
  const panel = panelOf(svg);
  const colours = new Set([...svg.matchAll(/<(?:path|rect|circle|polygon)\b([^>]*)>/g)].map((m) => fillOf(m[1])).filter(Boolean));
  if (panel) colours.delete(panel);
  for (const c of colours) must(roles.has(c), `${file}: ${c} is no colour of the logo`);
  const marks = [...colours].map((c) => [roles.get(c), c]).sort((a, b) => ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]));
  return { file, panel, marks };
};
const appBgOf = (theme, pre) => (theme === 'dark' ? gradientColours(decl('.app-container', 'background'))[0] : decl(`${pre}.app-container`, 'background'));
const logoColours = new Map();
for (const [theme, toks, pre] of [['dark', tokens, ''], ['light', lightTokens, '[data-theme="light"] ']]) {
  const roles = introRoles(svgText(`variante_intro_primary_${theme}.svg`));
  const primary = logoOf(`variante_primary_${theme}.svg`, roles);
  const intro = logoOf(`variante_intro_primary_${theme}.svg`, roles);
  for (const [role, c] of [...primary.marks, ...intro.marks]) logoColours.set(`${role} (${theme})`, c);
  const tagline = colIn('var(--color-text-secondary)', toks);
  const appBg = appBgOf(theme, pre);
  const app = colIn(appBg, toks);
  const surfaces = [
    ['weather bar', primary, H.over(colIn(decl(`${pre}.weather-bar`, 'background'), toks), app), `${pre}.weather-bar over ${appBg}`, true],
    ['header', primary, H.over(colIn(decl(`${pre}.app-header`, 'background'), toks), app), `${pre}.app-header over ${appBg}`, true],
  ];
  const glow = gradientColours(decl(`${pre}.session-screen__glow`, 'background'))[0];
  for (const stop of gradientColours(decl(`${pre}.session-screen`, 'background'))) {
    surfaces.push([`start screen ${stop}`, intro, colIn(stop, toks), `${pre}.session-screen`, true]);
    surfaces.push([`start screen ${stop} under the glow ${glow}`, intro, H.over(colIn(glow, toks), colIn(stop, toks)), `${pre}.session-screen, .session-screen__glow`, true]);
  }
  // the session menu: its glass over the open overlay over the app; Settings
  // > About: its section over the panel
  const overlay = decl(`${pre}.session-menu-overlay`, 'background');
  surfaces.push(['session menu', primary, H.over(colIn(decl(`${pre}.session-menu`, 'background'), toks), H.over(colIn(overlay, toks), app)),
    `${pre}.session-menu over ${pre}.session-menu-overlay over ${appBg}`, false]);
  const panel = theme === 'dark' ? PANEL : H.over(colIn('var(--color-bg-panel)', toks), app);
  surfaces.push(['Settings > About', primary, H.over(colIn(decl('.settings-tab__section', 'background'), toks), panel),
    `.settings-tab__section over the ${theme === 'dark' ? 'panel' : '--color-bg-panel over the app'}`, false]);
  for (const [where, logo, surface, src, gated] of surfaces) {
    const bg = logo.panel ? col(logo.panel) : surface;
    const on = logo.panel ? `${where}, on the file's own ${logo.panel} panel` : where;
    for (const [role, c] of logo.marks) {
      const what = `logo ${role} ${c} (${logo.file}) on the ${on}`;
      if (gated && role !== 'cone') add(what, col(c), bg, 3, `${src}; public/brand/${logo.file}`);
      else logoInfo.push(`${what}: ${H.contrast(col(c), bg).toFixed(2)}:1 [${src}]`);
    }
    if (logo.panel) logoInfo.push(`${logo.file} paints a ${logo.panel} panel over its whole view box: ${H.contrast(col(logo.panel), surface).toFixed(2)}:1 against the ${where} [${src}]`);
    if (where.startsWith('start screen')) add(`tagline (--color-text-secondary, ${theme}) on the ${where}`, tagline, surface, 4.5, src);
  }
}
const favicon = fs.readFileSync(path.join(ROOT, 'frontend/public/favicon.svg'), 'utf8');
const favTile = (favicon.match(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/) || [])[1];
const favMarks = [...favicon.matchAll(/(?:stroke|fill)="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]).filter((c) => c !== favTile);
must(favTile && favMarks.length > 0, 'favicon colours not found');
for (const c of new Set(favMarks)) add(`favicon mark ${c} on its own tile ${favTile}`, col(c), col(favTile), 3, 'public/favicon.svg');
// The logo's two hues are no data colours: their nearest data colours
// (CIEDE2000), for the record (not gated: the logo is drawn away from every
// chart and legend; its letters are the neutral white or navy)
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
for (const role of ['orange', 'kerb red']) {
  const c = logoColours.get(`${role} (dark)`);
  must(c && c === logoColours.get(`${role} (light)`), `the logo ${role} differs between the themes`);
  for (const t of ['normal', 'protanopia', 'deuteranopia', 'tritanopia']) {
    const sim = (x) => (t === 'normal' ? x : C.simulateCvd(x, t));
    const near = Object.entries(DATA_COLOURS).map(([k, v]) => [k, v, C.deltaE2000(sim(c), sim(v))])
      .sort((a, b) => a[2] - b[2]).slice(0, 3);
    brandInfo.push(`logo ${role} ${c}, ${t}: nearest data colours ${near.map(([k, v, d]) => `${k} ${v} ${d.toFixed(1)}`).join(', ')}`);
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
for (const line of logoInfo) console.log(`INFO (logo, not gated) ${line}`);
for (const line of brandInfo) console.log(`INFO (logo colours, CIEDE2000, not gated) ${line}`);
console.log(`\n${fails.length} of ${rows.length} pairs under their threshold`);
process.exitCode = fails.length ? 1 : 0;
