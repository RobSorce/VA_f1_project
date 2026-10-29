// V13 target (1), static part: does the dashboard fit the viewport at the
// four target sizes? Read from the CSS tokens and the layout components as
// written (frontend/src/__tests__/helpers/layoutModel.js); the real-browser
// pass checks what a static model cannot (view internals, font metrics).
//
//  1. page scroll: every rule on html / body / .app-container / .app-body
//     live at the viewport keeps overflow hidden and the shell at 100vh;
//  2. the chrome rows (weather bar, timeline collapsed / expanded, dock) and
//     the app body left to the panels;
//  3. the Pit Wall cells (PitWallLayout.jsx), the Circle of Doom's slot in
//     its cell (__tests__/helpers/pitWallMaps.js codSlotAt), how many Timing Tower rows fit
//     with no focus driver and with the focus cards in their default and
//     on-demand states (row height from TimingTower.jsx; card heights
//     estimated from the CSS), the tower and Race Pace Grid table widths
//     against their cells; the side column (Weather, Race Control);
//  4. every pane of every window preset (utils/windowPresets.js), content box;
//  5. the floating-overlay room against OverlayPanel's minimum size.
//
// Exit code 1 when the page can scroll at a target viewport or a Pit Wall row
// or a docked pane has no room. Run:
//   node frontend/scripts/audit/layout_fit.mjs
// Writes docs/evidence/layout_fit.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('layout_fit.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const PW = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/pitWallMaps.js')).href);
const { WINDOW_PRESETS } = await import(pathToFileURL(path.join(SRC, 'utils/windowPresets.js')).href);
// utils/views/racePaceGrid.js imports modules without extensions (Vite), so
// plain node cannot load it: its constants are read from the source and
// paceColumns is mirrored here (the real one is tested in
// frontend/src/__tests__/layout.gridFit.test.js)
const PG = (() => {
  const src = fs.readFileSync(path.join(SRC, 'utils/views/racePaceGrid.js'), 'utf8');
  const c = (name) => {
    const v = Number((src.match(new RegExp('export const ' + name + ' = (\\d+);')) || [])[1]);
    if (!Number.isFinite(v)) throw new Error(`racePaceGrid.js: ${name} not found`);
    return v;
  };
  const pad = Number((src.match(/const CELL_PAD_PX = (\d+);/) || [])[1]);
  const mono = Number((src.match(/const MONO_EM = ([\d.]+);/) || [])[1]);
  const k = {
    PACE_CELL_MAX_W: c('PACE_CELL_MAX_W'), PACE_CELL_MIN_W: c('PACE_CELL_MIN_W'), PACE_LAP_COL_W: c('PACE_LAP_COL_W'),
    PACE_HEADER_H: c('PACE_HEADER_H'), PACE_ROW_MIN: c('PACE_ROW_MIN'), PACE_ROW_MAX: c('PACE_ROW_MAX'),
  };
  k.paceColumns = (width, n, fontPx) => {
    const room = Math.max(0, width - k.PACE_LAP_COL_W);
    let cellW = Math.min(k.PACE_CELL_MAX_W, Math.floor(room / n));
    let perPage = n;
    if (cellW < k.PACE_CELL_MIN_W) { cellW = k.PACE_CELL_MIN_W; perPage = Math.max(1, Math.floor(room / k.PACE_CELL_MIN_W)); }
    const chars = Math.floor((cellW - pad) / (mono * fontPx));
    return { cellW, perPage, paged: perPage < n, format: chars >= 10 ? 'full' : chars >= 7 ? 'seconds' : 'short' };
  };
  return k;
})();
const { fitRows } = await import(pathToFileURL(path.join(SRC, 'utils/views/chartBox.js')).href);

const css = M.loadCss(SRC);
const spec = M.pitWallSpec(SRC);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const num = (text, re) => Number((text.match(re) || [])[1]);

const tower = read('components/visualizations/TimingTower.jsx');
// The tower fits its rows to its body (fitRows, ROW_MAX down to ROW_MIN) and
// draws its columns as shares of the table (table-layout fixed)
const towerRowH = num(tower, /const ROW_MAX = (\d+);/);
const towerRowMin = num(tower, /const ROW_MIN = (\d+);/);
const towerCols = (tower.match(/const COL = \{([\s\S]*?)\};/) || [])[1] || '';
const towerTableW = [...towerCols.matchAll(/:\s*(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
const towerFixed = /tableLayout: 'fixed'/.test(tower) && /width: colPct\(w\)/.test(tower);
const leaderboard = read('components/visualizations/Leaderboard.jsx');
const lbRowMin = num(leaderboard, /const ROW_MIN = (\d+);/);
const lbRowMax = num(leaderboard, /const ROW_MAX = (\d+);/);
const overlay = read('components/layout/OverlayPanel.jsx');
const overlayMinH = num(overlay, /const MIN_H = (\d+)/);
const overlayMinW = num(overlay, /const MIN_W = (\d+)/);

const f = (v) => (Number.isFinite(v) ? v.toFixed(0) : 'n/a');
let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL ${msg}`); };

console.log(`Layout fit at the V13 target viewports, CSS + components of the working tree, ${new Date().toLocaleDateString('sv-SE')}`);
console.log(`Pit Wall grid (PitWallLayout.jsx): columns "${spec.columns}", rows "${spec.rows}", map row "${spec.bottomColumns}"`);
console.log(`Timing Tower (TimingTower.jsx): rows ${towerRowMin}-${towerRowH} px (fitRows), column widths (COL) sum ${towerTableW} px${towerFixed ? ', drawn as percentages (table-layout fixed)' : ''}`);
console.log(`Race Pace Grid (utils/views/racePaceGrid.js): lap column ${PG.PACE_LAP_COL_W} px + 20 drivers x ${PG.PACE_CELL_MIN_W}-${PG.PACE_CELL_MAX_W} px cells (paceColumns), header ${PG.PACE_HEADER_H} px, rows ${PG.PACE_ROW_MIN}-${PG.PACE_ROW_MAX} px (fitRows), laps that do not fit paged`);
console.log(`Leaderboard (Leaderboard.jsx): rows ${lbRowMin}-${lbRowMax} px, each calc(100% / n) of a flex body moved by translateY(k x 100 %), 20 rows in ${20 * lbRowMin} px at the minimum, paged below that (fitRows); the Analyse sidebar in every state, the Sectors and Consistency panels, the weather event: panel_fit.mjs; the dock: dock_fit.mjs`);
console.log(`Floating overlay minimum (OverlayPanel.jsx): ${overlayMinW} x ${overlayMinH} px\n`);

for (const vp of M.VIEWPORTS) {
  console.log(`== ${vp.name} ==`);
  const bad = M.pageScrollRules(css, vp);
  if (bad.length) for (const b of bad) fail(`page can scroll: ${b.file}:${b.line} ${b.selector} { ${b.decl} }${b.media ? ` @media ${b.media}` : ''}`);
  else console.log('  page scroll: none (html, body, .app-container, .app-body overflow hidden; shell 100vh)');

  const s = M.shellAt(css, vp);
  console.log(`  root font ${s.root.toFixed(2)} px; chrome: weather ${f(s.weather)} + timeline ${f(s.timeline)} (expanded ${f(s.timelineExpanded)}) + dock ${s.dock.toFixed(1)} + margin ${s.dockMargin.toFixed(1)} = ${s.chrome.toFixed(1)} px`);
  console.log(`  app body ${vp.W} x ${s.body.toFixed(1)} px (timeline expanded: ${s.bodyExpanded.toFixed(1)} px, the event strip opens over the body); Leaderboard sidebar ${s.sidebar.toFixed(0)} px`);

  const pw = M.pitWallAt(css, spec, vp);
  console.log(`  Pit Wall: timing column ${f(pw.sidebar)} x ${f(pw.body)}; main ${f(pw.mainW)} wide: session bar ${f(pw.info)}, pace grid ${f(pw.middle)}, map row ${f(pw.bottom)} (Track Map / Circle of Doom ${f(pw.mapW)} x ${f(pw.bottom)}, side column ${f(pw.side)})`);
  if (!(pw.middle > 0)) fail(`Pit Wall pace-grid row has no room (${f(pw.middle)} px)`);
  // The circle's content box: the cell less the glass border, the header and
  // the content padding (.panel--dense: half that of .panel)
  const cod = PW.codSlotAt(css, SRC, vp);
  console.log(`  Circle of Doom slot (.cod, the content box of its ${PW.circleIsDense(SRC) ? '.panel--dense' : '.panel'} panel): ${f(cod.width)} x ${f(cod.height)} in its ${f(cod.cell.width)} x ${f(cod.cell.height)} cell`);
  if (!(cod.width > 0 && cod.height > 0)) fail(`Circle of Doom slot has no room (${f(cod.width)} x ${f(cod.height)})`);
  // Tower chrome: red header (8 + 7 px padding around a 16 px bar), column
  // header (4 + 4 px around one line of the tower's fixed 11 px type, 1.4) and
  // its rule, the legend under the rows (7 glyph items: 2 lines of label type
  // in the 480 px column, items 2 + 2 px padding, line 1.25, the legend's
  // padding and row gap --spacing-xs, 1 px rule); a flag banner adds a line
  const dataPx = M.px(css, '--font-size-data', vp);
  const labelPx = M.px(css, '--font-size-label', vp);
  const towerPx = M.px(css, '--font-size-data-fixed', vp);
  const xs = M.px(css, '--spacing-xs', vp);
  const legendH = 2 * (4 + 1.25 * labelPx) + 3 * xs + 1;
  const towerChrome = 31 + 8 + Math.ceil(towerPx * 1.4) + 1 + legendH;
  const banner = 6 + towerPx * 1.2;
  const rowsFit = Math.floor((pw.body - towerChrome) / towerRowH);
  console.log(`  Timing Tower chrome ${f(towerChrome)} px (header 31, column header ${8 + Math.ceil(towerPx * 1.4) + 1}, legend ${f(legendH)}; a flag banner adds ${f(banner)}); the 20 rows need ${towerRowMin * 20} px at ${towerRowMin} px`);
  console.log(`  Timing Tower, no focus driver: ${f(pw.body - towerChrome)} px for rows -> ${Math.min(20, rowsFit)} of 20 rows at ${towerRowH} px${rowsFit >= 20 ? ' (all)' : ''}; columns ${towerTableW} px of design widths in the ${f(pw.sidebar)} px column${towerTableW > pw.sidebar && !towerFixed ? ` (${towerTableW - pw.sidebar} px too wide)` : ' (fits)'}`);
  if (towerTableW > pw.sidebar && !towerFixed) fail(`Timing Tower columns ${towerTableW} px in a ${f(pw.sidebar)} px column`);
  // Focus cards under the tower (PitWallLayout.jsx, dashboard.css), side by
  // side, so the taller one counts; ESTIMATES from the CSS, upper side:
  //  focus widget: header 8 + 8 around max(24 bar, 14 + 1 + label 1.25) + rules;
  //   Predictions: 6 + 6, title label 1.25 + 5, 3 stats of data 1.25, gaps 3;
  //   Rivals: 6 + 6, title, 4 rows of data 1.25, gaps 3; capped at 280 px (CSS)
  //  sector panel: 8 + 8 padding, rules 2, header 18 + 6, lap-time box 6 + 6 +
  //   data 1.2 + 2 + 22 + 8, sectors 4 + 4 + data 1.2 + 2 + 13 + 2 + data 1.2
  //   + 6, legend 3 lines of label type, previous laps 2 lines of chips
  //  toggle line 22 px; collapsed: the header lines only
  const widget = Math.min(280, 1 + 16 + Math.max(24, 15 + 1.25 * labelPx) + 1
    + 12 + 1.25 * labelPx + 5 + 3 * 1.25 * dataPx + 6 + 1
    + 12 + 1.25 * labelPx + 5 + 4 * 1.25 * dataPx + 9);
  const sector = 16 + 2 + 24 + (12 + 1.2 * dataPx + 2 + 22 + 8) + (8 + 2.4 * dataPx + 17 + 6)
    + (3 * (4 + 1.25 * labelPx) + 4 * xs) + (2 * (1.25 * dataPx + 6) + 3);
  const focusOpen = 22 + Math.max(widget, sector);
  const focusClosed = 22 + Math.max(1 + 16 + Math.max(24, 15 + 1.25 * labelPx) + 1, 16 + 2 + 18);
  const openByDefault = vp.H >= 900; // PitWallLayout.jsx SHORT_VIEWPORT (max-height: 899px)
  for (const [state, h] of [[`focus cards ${openByDefault ? 'open (default here)' : 'collapsed (default here)'}`, openByDefault ? focusOpen : focusClosed],
    [`focus cards ${openByDefault ? 'collapsed (on demand)' : 'open (on demand)'}`, openByDefault ? focusClosed : focusOpen]]) {
    const room = pw.body - towerChrome - h;
    const fit = fitRows(room, 20, { rowMin: towerRowMin, rowMax: towerRowH });
    console.log(`  Timing Tower, ${state} (est. ${f(h)} px): ${f(room)} px for rows -> ${fit.paged ? `${fit.perPage} of 20 rows at ${towerRowMin} px, the body scrolls (justified)` : `20 of 20 rows at ${fit.rowH} px`}`);
    if (state.includes('default') && fit.paged) fail(`Timing Tower: 20 rows of ${towerRowMin} px do not fit with the ${state}`);
  }
  // Side column of the map row (WeatherMini, RaceControlFeed): Weather keeps
  // its height, Race Control takes the rest and shows the newest messages
  // that fit (one line each). ESTIMATES from the components' style objects:
  //  Weather: 8 + 8 padding, title line (DRY chip 1 + 1 + label 1.25 + 2) + 6,
  //   2 lines of max(16 px icon, data 1.25) + 4 gap, 1 px rule
  //  Race Control at least: 8 + 8, title label 1.25 + 6, one line ceil(data 1.3) + 5
  const weatherH = 16 + (4 + 1.25 * labelPx) + 6 + 2 * Math.max(16, 1.25 * dataPx) + 4 + 1;
  const rcLine = Math.ceil(dataPx * 1.3) + 5;
  const rcMin = 16 + 1.25 * labelPx + 6 + rcLine;
  const rcRoom = pw.bottom - weatherH;
  const rcRows = Math.max(0, Math.floor((rcRoom - 16 - 1.25 * labelPx - 6 + 2) / (rcLine + 2)));
  console.log(`  Pit Wall side column 280 x ${f(pw.bottom)}: Weather ${f(weatherH)} (est.) leaves Race Control ${f(rcRoom)} px -> ${rcRows} newest message lines of ${rcLine} px (needs >= ${f(rcMin)} for one)`);
  if (rcRoom < rcMin) fail(`Pit Wall side column: Race Control has ${f(rcRoom)} px, one message needs ${f(rcMin)}`);

  const pc = PG.paceColumns(pw.mainW, 20, dataPx);
  const paceTableW = PG.PACE_LAP_COL_W + pc.cellW * pc.perPage;
  const paceRows = fitRows(pw.middle - PG.PACE_HEADER_H, 53, { rowMin: PG.PACE_ROW_MIN, rowMax: PG.PACE_ROW_MAX });
  console.log(`  Race Pace Grid: ${pc.perPage} of 20 driver columns of ${pc.cellW} px (${pc.format} labels) = ${paceTableW} px in a ${f(pw.mainW)} px cell (${paceTableW > pw.mainW ? `${f(paceTableW - pw.mainW)} px too wide` : 'fits'}); ${paceRows.perPage} of 53 laps at ${paceRows.rowH} px in ${f(pw.middle)} px (legend row not counted)${paceRows.paged ? ', the others paged' : ''}`);
  if (paceTableW > pw.mainW) fail(`Race Pace Grid ${paceTableW} px in a ${f(pw.mainW)} px cell`);
  // The rows are fitted to the grid's measured height; the legend bar under
  // it must not change when the laps get paged (browser pass 2026-10-16: the
  // lap pager's arrival wrapped the bar onto a third line, the 12 rows fitted
  // before it were cut by 9 px). The lap pager's slot is always rendered
  // (hidden while every lap fits), so the bar is the same paged or not.
  const rpg = read('components/visualizations/RacePaceGrid.jsx');
  const slotAlways = /className="pace-grid__lap-pager"[^>]*visibility: rowFit\.paged \? 'visible' : 'hidden'/s.test(rpg)
    && !/\{\(rowFit\.paged \|\| driverPg\.pages > 1\) && \(/.test(rpg);
  console.log(`    legend bar: the lap pager's slot ${slotAlways ? 'is always in the bar (hidden while every lap fits): the grid the rows are fitted to is the final one' : 'appears only once the laps are paged: it can wrap the bar after the fit'}`);
  if (!slotAlways) fail('Race Pace Grid: the lap pager is rendered only when paged (its arrival changes the measured grid)');

  for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
    const panes = M.dockedPanesAt(css, preset.dockedLayout, vp);
    const minW = Math.min(...panes.map((p) => p.width));
    const minH = Math.min(...panes.map((p) => p.height));
    console.log(`  preset ${key.padEnd(10)} ${panes.map((p) => `${p.tabs.join('+')} ${f(p.width)}x${f(p.height)}`).join(', ')}  (smallest ${f(minW)} x ${f(minH)})`);
    if (!(minW > 0 && minH > 0)) fail(`preset ${key}: a pane has no room`);
  }

  const room = vp.H - s.overlayTop - s.overlayBottom;
  const roomExpanded = vp.H - s.overlayTop - s.overlayBottomExpanded;
  console.log(`  floating overlays: ${f(room)} px high (timeline expanded ${f(roomExpanded)}), minimum panel ${overlayMinH} + 2 x 8 px edge`);
  if (roomExpanded < overlayMinH + 16) fail(`overlay room ${f(roomExpanded)} px < minimum panel ${overlayMinH + 16} px`);
  console.log('');
}
console.log(failures ? `${failures} failure(s)` : 'All static layout checks pass at the four viewports.');
process.exitCode = failures ? 1 : 0;
