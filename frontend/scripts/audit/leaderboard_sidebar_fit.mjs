// Repair 3 (V5 / V13 r2): the Leaderboard rows of the Analyse sidebar
// (App.jsx: Leaderboard, then SidebarFocusCards) at the four target viewports.
// Leaderboard.jsx now fits the rows to the room left (chartBox.fitRows, 28 px
// down to 18 px) and pages them below that (pageOf, 22 px pager line); the
// focus cards stay collapsed to their header lines below 1200 px of window
// height (SidebarFocusCards.jsx SIDEBAR_SHORT_VIEWPORT); there "Details" opens
// them in full as a card laid over the bottom of the sidebar, the Leaderboard
// keeping its layout; from 1200 px they are in the flow, open by default.
// Estimates (the formulae for the chrome and the full cards are those of
// layout_fit.mjs; the tower legend's
// lines computed from its 10 items). Collapsed cards: the
// toggle line (22 px), the sector panel header (1 + 8 + max(18 px bar, lap
// badge 2 + 1.2 x data + 2) + 8 + 1) and the focus widget header (1 + 8 +
// max(24 px bar, 14 px code + 1 + 1.2 x label) + 8 + 1).
// Run: node frontend/scripts/audit/leaderboard_sidebar_fit.mjs
// Writes docs/evidence/leaderboard_sidebar_fit.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('leaderboard_sidebar_fit.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const { fitRows } = await import(pathToFileURL(path.join(SRC, 'utils/views/chartBox.js')).href);
const css = M.loadCss(SRC);
const FIELD = 20;
const ROW = { rowMin: 18, rowMax: 28, rowDefault: 28, pagerH: 22 };
const SHORT = 1199; // (max-height: 1199px)
let worst = Infinity;
for (const vp of M.VIEWPORTS) {
  const dataPx = M.px(css, '--font-size-data', vp);
  const labelPx = M.px(css, '--font-size-label', vp);
  const xs = M.px(css, '--spacing-xs', vp);
  const s = M.shellAt(css, vp);
  const body = s.body;
  const widget = Math.min(280, 1 + 16 + Math.max(24, 15 + 1.25 * labelPx) + 1
    + 12 + 1.25 * labelPx + 5 + 3 * 1.25 * dataPx + 6 + 1
    + 12 + 1.25 * labelPx + 5 + 4 * 1.25 * dataPx + 9);
  const sector = 16 + 2 + 24 + (12 + 1.2 * dataPx + 2 + 22 + 8) + (8 + 2.4 * dataPx + 17 + 6)
    + (3 * (4 + 1.25 * labelPx) + 4 * xs) + (2 * (1.25 * dataPx + 6) + 3);
  // Tower legend (Leaderboard.jsx TOWER_LEGEND, 10 items): wrapped in the
  // sidebar width less 12 px; an item = 2 x xs padding + glyph (1 em) + 4 px
  // + label (0.6 em a character), xs between items; a line = 4 + 1.25 x label
  const labels = ['vs grid', 'lost', '', '', '', 'pit', '<30%', '≥30%', '≥60%', 'battle'];
  const room = s.sidebar - 12;
  let lines = 1; let x = 0;
  for (const l of labels) {
    const w = 2 * xs + labelPx + 4 + l.length * 0.6 * labelPx;
    if (x > 0 && x + w > room) { lines += 1; x = 0; }
    x += w + xs;
  }
  const legendH = lines * (4 + 1.25 * labelPx) + (lines + 1) * xs + 1;
  const chrome = (10 + 8 + 16) + 24 + (8 + Math.ceil(dataPx * 1.4) + 1) + legendH;
  const toggle = 22;
  const sectorHead = 1 + 8 + Math.max(18, 2 + 1.2 * dataPx + 2) + 8 + 1;
  const widgetHead = 1 + 8 + Math.max(24, 14 + 1 + 1.2 * labelPx) + 8 + 1;
  const collapsedDefault = vp.H <= SHORT;
  console.log(`${vp.W}x${vp.H}: app body ${body.toFixed(1)} px, sidebar ${s.sidebar.toFixed(0)} px, Leaderboard chrome ${chrome.toFixed(0)} px (legend ${lines} lines); cards in full: sector ${sector.toFixed(0)} + widget ${widget.toFixed(0)}; collapsed: toggle ${toggle} + ${sectorHead.toFixed(0)} + ${widgetHead.toFixed(0)}; the cards open ${collapsedDefault ? 'collapsed' : 'in full'} by default`);
  const inFlow = (full, head) => (collapsedDefault ? head : full);
  const states = [
    ['Analyse, no focus driver (hint line, est. 60 px)', 60],
    ['Analyse, focus driver, default', inFlow(toggle + sector + widget, toggle + sectorHead + widgetHead)],
    ['base state, focus driver, default', inFlow(toggle + widget, toggle + widgetHead)],
    ['Analyse, focus driver, "Details"', inFlow(toggle + sector + widget, toggle + sectorHead + widgetHead)],
    ['base state, focus driver, "Details"', inFlow(toggle + widget, toggle + widgetHead)],
  ];
  for (const [state, cards] of states) {
    const isDefault = true;
    const room = body - cards - chrome;
    const fit = fitRows(room, FIELD, ROW);
    const shown = fit.paged ? fit.perPage : FIELD;
    if (isDefault) worst = Math.min(worst, shown);
    const how = fit.paged
      ? `PAGED: ${fit.perPage} rows per page at ${fit.rowH} px + the pager (${Math.ceil(FIELD / fit.perPage)} pages), no row clipped`
      : `all ${FIELD} rows at ${fit.rowH} px`;
    const card = state.includes('Details') && collapsedDefault
      ? ` | the details card (${(toggle + (state.startsWith('Analyse') ? sector : 0) + widget).toFixed(0)} px of the ${body.toFixed(0)} px sidebar) is laid over its bottom until "Less"`
      : '';
    console.log(`  ${fit.paged ? 'paged' : 'fits '} ${state}: cards in the flow ${cards.toFixed(0)} px -> ${room.toFixed(0)} px for the rows: ${how}${card}`);
  }
}
console.log(`\nfewest rows on one page, every state above: ${worst} of ${FIELD} rows on one page`);
