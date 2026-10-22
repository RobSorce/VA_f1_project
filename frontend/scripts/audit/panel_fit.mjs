// Phase 9c F1 / F3 / F4 (D1, D3): static fit of the views of the layout lane
// at the four V13 target viewports, from the CSS tokens and rules as written,
// the components' constants and the real font metrics (fontMetrics.mjs):
//
//  1. the Analyse sidebar's race tower (Leaderboard.jsx): the room its rows
//     get under the header, the mode bar, the column header, the legend (in
//     the panel from 900 px of window height, behind the "?" key below), a
//     flag banner and the forecast footer, over the focus cards; 20 rows
//     must fit at >= 18 px in every state (no pager needed);
//  2. the Sectors panel (SectorsPanel.jsx) in its preset panes and the
//     smallest floating overlay: rows per page (sectorsRowFit), ranked
//     columns per page (sectorsColumnsFit), a ranked row's content against
//     its column, the live row against the pane;
//  3. the Consistency panel (ConsistencyPanel.jsx): columns, collapsed row
//     height, pages, with every card collapsed and with the focus driver's
//     card expanded (3 compounds), and the collapsed line's content against
//     CONSISTENCY_CARD_EM;
//  4. the weather bar's event name (WeatherBar.jsx) against its box;
//  5. the Lap Times timing sheet (LapTimeChart.jsx, Phase 9c r2): its columns
//     fitted to the rows' box (utils/views/timingSheetFit.js) in every preset
//     pane and the smallest floating overlay: every column at or above its
//     floor, the sheet no wider than the box (a 6 px scrollbar taken off),
//     no column given up in a preset pane.
//
// Heights use the CSS line-height of the text (body 1.4 unless a rule sets
// another); widths use the Inter faces (the weight's face) and 0.6 em for
// JetBrains Mono (its advance is 600/1000), 1 em for a glyph the face lacks.
// Exit code 1 when a row is cut or a page holds nothing. Run:
//   node frontend/scripts/audit/panel_fit.mjs
// Writes docs/evidence/panel_fit.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFaces } from './fontMetrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const { WINDOW_PRESETS } = await import(pathToFileURL(path.join(SRC, 'utils/windowPresets.js')).href);
const { fitRows } = await import(pathToFileURL(path.join(SRC, 'utils/views/chartBox.js')).href);
const CL = await import(pathToFileURL(path.join(SRC, 'utils/views/consistencyLayout.js')).href);
const TS = await import(pathToFileURL(path.join(SRC, 'utils/views/timingSheetFit.js')).href);
// sectorsPanel.js imports modules without extensions (Vite): its fit rules
// are mirrored here from the constants read in its source
import fs from 'node:fs';
import { teeToEvidence } from './evidence.mjs';
const SP = (() => {
  const src = fs.readFileSync(path.join(SRC, 'utils/views/sectorsPanel.js'), 'utf8');
  const c = (name) => Number((src.match(new RegExp(`export const ${name} = (\\d+);`)) || [])[1]);
  const k = {
    ROW_MIN: c('SECTORS_ROW_MIN'), ROW_MAX: c('SECTORS_ROW_MAX'), PAGER_H: c('SECTORS_PAGER_H'),
    COL_GAP: c('SECTORS_COL_GAP'), COL_EM: c('SECTORS_COL_EM'),
  };
  if (!Object.values(k).every(Number.isFinite)) throw new Error('sectorsPanel.js constants not found');
  k.rowFit = (h, n) => {
    if (!(h > 0)) return { rowH: k.ROW_MAX, perPage: n, paged: false };
    if (n * k.ROW_MIN <= h) return { rowH: Math.max(k.ROW_MIN, Math.min(k.ROW_MAX, Math.floor(h / n))), perPage: n, paged: false };
    const perPage = Math.max(1, Math.floor((h - k.PAGER_H) / k.ROW_MIN));
    return { rowH: k.ROW_MIN, perPage, paged: perPage < n };
  };
  k.colsFit = (w, n, minW) => Math.max(1, Math.min(n, Math.floor((w + k.COL_GAP) / (minW + k.COL_GAP))));
  return k;
})();

const css = M.loadCss(SRC);
const F = loadFaces('Inter');
if (!F) { console.log('Inter font files missing'); process.exit(1); }
const mono = (text, size) => [...text].length * 0.6 * size;
const LH = 1.4; // body line-height
// The timing sheet's columns, read from lapTimeChart.js (it imports modules
// without extensions: Vite)
const TIMING_COLUMNS = (() => {
  const src = fs.readFileSync(path.join(SRC, 'utils/views/lapTimeChart.js'), 'utf8');
  const block = src.match(/export const TIMING_COLUMNS = Object\.freeze\(\[([\s\S]*?)\]\);/)[1];
  const cols = [...block.matchAll(/\{ key: '(\w+)',[^}]*?defaultW: (\d+),\s*minW: (\d+),[^}]*\}/g)]
    .map((m) => ({ key: m[1], defaultW: Number(m[2]), minW: Number(m[3]) }));
  const declared = (block.match(/\{ key: '/g) || []).length;
  if (cols.length !== declared) throw new Error(`TIMING_COLUMNS: ${cols.length} of ${declared} columns read`);
  return cols;
})();
const SCROLLBAR_W = 6; // base.css ::-webkit-scrollbar (the rows' body scrolls when they do not fit)
const lb = fs.readFileSync(path.join(SRC, 'components/visualizations/Leaderboard.jsx'), 'utf8');
const LB_ROW_MIN = Number(lb.match(/const ROW_MIN = (\d+);/)[1]);
const LB_ROW_MAX = Number(lb.match(/const ROW_MAX = (\d+);/)[1]);
const LB_PAGER_H = Number(lb.match(/const PAGER_H = (\d+);/)[1]);
const LB_LEGEND_POPOVER_H = Number(lb.match(/LEGEND_POPOVER_VIEWPORT = '\(max-height: (\d+)px\)'/)[1]) + 1;
const cards = fs.readFileSync(path.join(SRC, 'components/layout/SidebarFocusCards.jsx'), 'utf8');
const CARDS_OPEN_H = Number(cards.match(/SIDEBAR_SHORT_VIEWPORT = '\(max-height: (\d+)px\)'/)[1]) + 1;

// The expanded Consistency card's fallback when it is taller than the area
// (a floating overlay near its minimum size): capped at the area, details scroll
const CARD_SCROLL_FALLBACK = (() => {
  const dash = fs.readFileSync(path.join(SRC, 'styles/dashboard.css'), 'utf8');
  const m = dash.match(/\n\.consistency-card__details \{([^}]*)\}/);
  const jsx = fs.readFileSync(path.join(SRC, 'components/visualizations/ConsistencyPanel.jsx'), 'utf8');
  return !!(m && /overflow-y: auto;/.test(m[1]) && /min-height: 0;/.test(m[1]) && /maxHeight: area\.height/.test(jsx));
})();

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL ${msg}`); };
const f1 = (v) => v.toFixed(1);

/** Lines of a wrapping row of items (widths) in `width`, gap between items. */
function lines(widths, width, gap) {
  let n = 1;
  let x = 0;
  for (const w of widths) {
    if (x > 0 && x + gap + w > width) { n += 1; x = w; } else x += (x > 0 ? gap : 0) + w;
  }
  return n;
}

/* ── 1. Analyse sidebar: the race tower ─────────────────────────────── */
export function towerModel(vp) {
  const s = M.shellAt(css, vp);
  const data = M.px(css, '--font-size-data', vp);
  const label = M.px(css, '--font-size-label', vp);
  const xs = M.px(css, '--spacing-xs', vp);
  const fontXs = Math.max(data, 0.6875 * s.root);
  // broadcast header: 6 + 6 padding, 1 px rule, the LAP 16 px number (line 1.4) baseline-aligned: 24 px upper bound
  const header = 6 + 6 + Math.max(18, 13 * LH, 16 * LH + 1.5) + 1;
  const modeBar = 24;
  const colHeader = 6 + data * LH + 1;
  const banner = 6 + Math.max(label * LH, 12 * LH) + 1;
  // legend: 10 items of TOWER_LEGEND (glyph or badge, label at weight 500 -> Regular)
  const ITEMS = [['▲', 'vs grid'], ['▼', 'lost'], ['S', ''], ['M', ''], ['H', ''], ['P', 'pit'],
    ['⇅', '<30%'], ['⇅', '≥30%'], ['⇅', '≥60%'], ['⚔', 'battle']];
  const itemW = ([g, t], i) => 2 * xs + (i >= 2 && i <= 4 ? Math.max(14, F.width(g, label, 800)) + 6 : Math.max(10, F.width(g, label, 800)))
    + 4 + (t ? F.width(t, label, 500) : 0);
  const legendLines = lines(ITEMS.map(itemW), s.sidebar - 12, xs);
  const legendInline = vp.H >= LB_LEGEND_POPOVER_H;
  const legend = legendInline ? 2 * xs + legendLines * (4 + label * LH) + (legendLines - 1) * xs : 0;
  const forecast = 8 + 2 * data * LH + 2 + 1;
  // focus cards (SidebarFocusCards.jsx): open from CARDS_OPEN_H px of height, else collapsed to their header lines
  const sectorHeader = 1 + 1 + 16 + Math.max(18, 13 * LH, data * LH + 4);
  const widgetHeader = 1 + 16 + Math.max(24, 14 + 1 + data * LH) + 1;
  const collapsedCards = 22 + sectorHeader + widgetHeader;
  const hint = 1 + 24 + fontXs * 1.6;
  return { s, data, label, header, modeBar, colHeader, banner, legend, legendLines, legendInline, forecast, collapsedCards, hint };
}

/* ── 2. Sectors panel in a pane W x H (content box) ─────────────────── */
export function sectorsModel(vp, W, H) {
  const data = M.px(css, '--font-size-data', vp);
  const label = M.px(css, '--font-size-label', vp);
  const xs = M.px(css, '--spacing-xs', vp);
  const innerW = W - 16;
  const innerH = H - 8;
  // toggle line: LIVE / BEST / TOP SPEEDS (bold, uppercase, 0.06 em, 6 px sides) + legend + export
  const btn = (t) => F.width(t, label, 700, { letterSpacingEm: 0.06, upper: true }) + 12 + 2;
  const buttons = btn('Live') + btn('Best') + btn('Top Speeds') + 2 * 2;
  const LEG = { live: [['◆', 'Session best'], ['●', 'Personal best'], ['31.2', 'Other sector'], ['12.3', 'Sector running']],
    speeds: [['◆', 'Fastest']], best: [['◆', 'Session best (its time)'], ['■', 'Bar: gap to the session best (s)']] };
  const legendItems = (v) => LEG[v].map(([g, t]) => 2 * xs + Math.max(10, F.width(g, label, 800)) + 4 + F.width(t, label, 500));
  const lineH = Math.max(22, 14 * 1 + label * LH, 2 * xs + 4 + label * LH);
  const toggleH = (v) => {
    const items = legendItems(v);
    const legendW = items.reduce((a, b) => a + b, 0) + (items.length - 1) * xs;
    const oneLine = buttons + 2 + 8 + legendW + 2 + 22 <= innerW;
    if (oneLine) return 8 + lineH;
    const legLines = lines(items, innerW, xs);
    return 8 + lineH + 2 + legLines * (4 + label * LH) + (legLines - 1) * xs + 2 * xs;
  };
  // live table: card border 2, header 3 + 3 + data line + 1
  const liveHeader = 2 + 6 + data * LH + 1;
  const liveRowW = 16 + 20 + 3 + Math.max(36, F.width('VER', data, 700)) + 3 * Math.max(56, mono('◆ 31.234', data)) + Math.max(64, mono('1:21.234', data)) + 6 * 5;
  // ranked columns: header 4 + 4 + its lines + 1, border 2. The columns of a
  // page share one header row (dashboard.css @supports subgrid): every body
  // is as tall as the first column's, under the tallest header of the page
  const minColW = Math.ceil(SP.COL_EM * data);
  const rankedRowW = (kind) => 12 + 16 + 4 + 3 + 4 + Math.max(30, F.width('VER', data, 700)) + 4
    + (kind === 'best' ? mono('◆ 31.234', data) : mono('◆ 352.1', data)) + 4 + 44;
  const TITLES = { best: ['SECTOR 1', 'SECTOR 2', 'SECTOR 3'], speeds: ['SECTOR 1', 'SECTOR 2', 'FINISH LINE', 'SPEED TRAP'] };
  // lines of one column's header: the title with its "Lap N" (Bold, 0.06 em;
  // it wraps inside when wider than the column), then the best value on the
  // same line when it fits, else on the next
  const headerLines = (kind, t, colW) => {
    const content = colW - 2 - 16;
    const title = F.width(t, data, 700, { letterSpacingEm: 0.06 }) + 4 + F.width('Lap 53', label, 400);
    const best = kind === 'best' ? mono('31.234', data) : mono('352.1 km/h', data);
    const titleLines = Math.ceil(title / content);
    return titleLines + (titleLines === 1 && title + 6 + best <= content ? 0 : 1);
  };
  const colHeaderH = (kind, colW, titles) => {
    const n = Math.max(...titles.map((t) => headerLines(kind, t, colW)));
    return { h: 2 + 8 + n * data * LH + 1, lines: n, each: titles.map((t) => headerLines(kind, t, colW)) };
  };
  const out = { innerW, innerH, liveRowW, minColW };
  const live = innerH - toggleH('live') - liveHeader;
  out.live = { rowsRoom: live, fit: SP.rowFit(live, 20) };
  for (const kind of ['best', 'speeds']) {
    const n = kind === 'best' ? 3 : 4;
    const cols = SP.colsFit(innerW, n, minColW);
    const colW = (innerW - (cols - 1) * SP.COL_GAP) / cols;
    const colPaged = cols < n;
    // every page of columns: its header row is its tallest header; the worst page is reported
    let worst = null;
    for (let p0 = 0; p0 < n; p0 += cols) {
      const hdr = colHeaderH(kind, colW, TITLES[kind].slice(p0, p0 + cols));
      const room = innerH - toggleH(kind) - hdr.h - (colPaged ? SP.PAGER_H : 0);
      if (!worst || room < worst.room) worst = { room, hdr };
    }
    out[kind] = {
      cols, colW, colPaged, rowW: rankedRowW(kind), fit: SP.rowFit(worst.room, 20), room: worst.room,
      headerLines: worst.hdr.lines, headerEach: worst.hdr.each,
    };
  }
  return out;
}

/* ── 3. Consistency panel in a pane W x H ───────────────────────────── */
export function consistencyModel(vp, W, H, { expandedCompounds = 0 } = {}) {
  const root = M.shellAt(css, vp).root;
  const data = M.px(css, '--font-size-data', vp);
  const label = M.px(css, '--font-size-label', vp);
  const xs = M.px(css, '--spacing-xs', vp);
  const fontXs = Math.max(data, 0.6875 * root);
  const fontSm = Math.max(data, 0.8125 * root);
  const innerW = W - 16;
  const innerH = H - 16;
  // header line: summary | pager (when paged) | buttons | legend, wrapping
  const summary = 20 + 2 + F.width('Avg ', fontXs, 400) + mono('1:25.123', fontXs) + 10 + F.width('20 drivers', fontXs, 400);
  const legItems = [['S', 'Soft'], ['M', 'Medium'], ['H', 'Hard'], ['■', 'Consistent: σ ≤ field median'], ['■', 'Inconsistent']]
    .map(([g, t], i) => 2 * xs + (i < 3 ? 20 : 9) + 4 + F.width(t, label, 500));
  const legendW = legItems.reduce((a, b) => a + b, 0) + (legItems.length - 1) * xs;
  const actions = 2 * (mono('Collapse all', label) + 16 + 2) + 22 + 2 * 6;
  const pager = 2 * 24 + 2 * 6 + mono('15–20/20', label);
  const barLineH = Math.max(fontXs * LH + 10, 2 * xs + 4 + label * LH, 22);
  const barOf = (paged) => {
    let n = 1;
    let x = summary;
    for (const w of [...(paged ? [pager] : []), actions, legendW]) { if (x + 10 + w > innerW) { n += 1; x = w; } else x += 10 + w; }
    return { lines: n, h: n * barLineH + (n - 1) * 4 };
  };
  const minCardW = Math.ceil(CL.CONSISTENCY_CARD_EM * data);
  const cols = CL.consistencyColumns(innerW, 20, minCardW);
  // collapsed line content: team bar, code (Bold), σ, badge (Bold, line 1.2), CV, chevron room, card padding and border
  const lineW = 4 + F.width('VER', fontSm, 700) + mono('±0.123s', fontXs)
    + F.width('Inconsistent', label, 700, { letterSpacingEm: 0.03, upper: true }) + 12 + 2 + mono('CV: 0.45%', fontXs)
    + 4 * 6 + 24 + 16 + 2;
  const lowDataW = lineW - (F.width('Inconsistent', label, 700, { letterSpacingEm: 0.03, upper: true }) + 14)
    + mono('LOW DATA', label) + 0.08 * label * 8 + 14;
  // expanded card (wide: three sections side by side)
  const wide = innerW >= CL.CONSISTENCY_WIDE_CARD;
  const title = label * LH + 2 + 1 + 2;
  const stat = fontXs * LH + 2;
  const perf = title + 4 * stat;
  const tyreW = wide ? (innerW - 16 - 2 - 32) * 1.6 / 3.6 : innerW - 16 - 2;
  const tyreRowW = 13 + 6 + F.width('MEDIUM', label, 700, { letterSpacingEm: 0.04, upper: true })
    + 6 + mono('Avg: 1:25.123', data) + 6 + mono('Deg: +0.045 s/lap', data) + 6 + mono('12L, Age 8', data);
  const tyreLines = tyreRowW > tyreW ? 2 : 1;
  const tyres = title + expandedCompounds * tyreLines * data * LH + Math.max(0, expandedCompounds - 1) * 2;
  const details = wide ? Math.max(perf, tyres) : perf + 4 + tyres;
  const expandedH = 12 + 2 + Math.max(22, fontSm * LH) + 4 + details;
  const cardsList = Array.from({ length: 20 }, (_, i) => ({ expanded: expandedCompounds > 0 && i === 3, height: expandedH }));
  // the pager joins the header line once the cards are paged: lay out again with it
  let bar = barOf(false);
  let room = innerH - bar.h - 6;
  let layout = CL.consistencyPages(cardsList, { cols, room });
  if (layout.pages.length > 1) {
    bar = barOf(true);
    room = innerH - bar.h - 6;
    layout = CL.consistencyPages(cardsList, { cols, room });
  }
  return { innerW, innerH, bar: bar.h, barLines: bar.lines, room, minCardW, cols, lineW, lowDataW, wide, expandedH, layout, tyreLines };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  teeToEvidence('panel_fit.txt');
  console.log(`Fit of the layout lane's views at the V13 target viewports (CSS + components + Inter metrics), ${new Date().toLocaleDateString('sv-SE')}`);
  console.log(`Leaderboard rows ${LB_ROW_MIN}-${LB_ROW_MAX} px, pager ${LB_PAGER_H} px, legend inline from ${LB_LEGEND_POPOVER_H} px of height; focus cards open from ${CARDS_OPEN_H} px`);
  console.log(`Sectors rows ${SP.ROW_MIN}-${SP.ROW_MAX} px, pager ${SP.PAGER_H} px, ranked columns >= ${SP.COL_EM} em; Consistency rows ${CL.CONSISTENCY_ROW_MIN}-${CL.CONSISTENCY_ROW_MAX} px, cards >= ${CL.CONSISTENCY_CARD_EM} em\n`);
  for (const vp of M.VIEWPORTS) {
    console.log(`== ${vp.name} ==`);
    // 1. tower
    const t = towerModel(vp);
    const chrome = t.header + t.modeBar + t.colHeader + t.legend;
    console.log(`  Race tower (sidebar ${t.s.sidebar.toFixed(0)} x ${t.s.body.toFixed(1)}): header ${f1(t.header)}, mode bar ${t.modeBar}, column header ${f1(t.colHeader)}, legend ${t.legendInline ? `${t.legendLines} lines, ${f1(t.legend)} px` : 'behind the "?" key (0 px)'}`);
    const focusH = vp.H >= CARDS_OPEN_H ? NaN : t.collapsedCards;
    for (const [name, extra] of [
      ['no focus driver', t.hint],
      ['focus driver, cards collapsed', focusH],
      ['focus driver + flag banner + forecast footer', focusH + t.banner + t.forecast],
    ]) {
      const room = t.s.body - chrome - extra;
      const fit = fitRows(room, 20, { rowMin: LB_ROW_MIN, rowMax: LB_ROW_MAX, rowDefault: LB_ROW_MAX, pagerH: LB_PAGER_H });
      console.log(`    ${name.padEnd(46)} ${f1(room)} px for the rows -> ${fit.paged ? `PAGED ${fit.perPage} a page` : `20 of 20 at ${Math.min(LB_ROW_MAX, Math.floor(room / 20))} px (body ${Math.min(room, 20 * LB_ROW_MAX).toFixed(0)} px)`}`);
      if (fit.paged) fail(`${vp.name} race tower, ${name}: ${f1(room)} px < 20 x ${LB_ROW_MIN}`);
    }
    // 2. sectors
    const panes = [];
    for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
      for (const p of M.dockedPanesAt(css, preset.dockedLayout, vp)) {
        if (p.tabs.includes('sectors')) panes.push([`preset ${key}`, p.width, p.height]);
      }
    }
    panes.push(['floating overlay minimum 420 x 320 (content ~ 418 x 280)', 418, 280]);
    for (const [name, W, H] of panes) {
      const s = sectorsModel(vp, W, H);
      const live = s.live.fit;
      console.log(`  Sectors ${name} ${W.toFixed(0)}x${H.toFixed(0)}: live ${live.paged ? `${live.perPage} rows a page (pager)` : `20 rows at ${live.rowH} px`}; best ${s.best.cols}/3 columns${s.best.colPaged ? ' (column pages)' : ''} x ${s.best.fit.paged ? `${s.best.fit.perPage} rows a page` : `20 rows at ${s.best.fit.rowH} px`}; speeds ${s.speeds.cols}/4 columns${s.speeds.colPaged ? ' (column pages)' : ''} x ${s.speeds.fit.paged ? `${s.speeds.fit.perPage} rows a page` : `20 rows at ${s.speeds.fit.rowH} px`}`);
      console.log(`    live row ${f1(s.liveRowW)} px in ${f1(s.innerW - 2)}; ranked row best ${f1(s.best.rowW)} / speeds ${f1(s.speeds.rowW)} px in columns of ${f1(s.best.colW)} / ${f1(s.speeds.colW)} px (min ${s.minColW})`);
      console.log(`    column headers (lines per column of the worst page; the row of a page is its tallest): best ${s.best.headerEach.join('/')} -> ${s.best.headerLines}, speeds ${s.speeds.headerEach.join('/')} -> ${s.speeds.headerLines}`);
      for (const k of ['best', 'speeds']) {
        const f = s[k].fit;
        const rowsH = (f.paged ? f.perPage : 20) * f.rowH + (f.paged ? SP.PAGER_H : 0);
        if (rowsH > s[k].room + (s[k].colPaged ? SP.PAGER_H : 0) + 0.01) fail(`${vp.name} sectors ${name} ${k}: ${rowsH} px of rows in ${f1(s[k].room)} px`);
      }
      if (s.liveRowW > s.innerW - 2) fail(`${vp.name} sectors ${name}: the live row (${f1(s.liveRowW)} px) is wider than the table`);
      if (s.speeds.rowW > s.speeds.colW) fail(`${vp.name} sectors ${name}: a speed row (${f1(s.speeds.rowW)}) wider than its column (${f1(s.speeds.colW)})`);
      if (s.best.rowW - 30 > s.best.colW) fail(`${vp.name} sectors ${name}: a best row without its bar (${f1(s.best.rowW - 30)}) wider than its column (${f1(s.best.colW)})`);
      for (const k of ['live', 'best', 'speeds']) if (s[k].fit.perPage < 1) fail(`${vp.name} sectors ${name} ${k}: no row fits`);
    }
    // 3. consistency
    const cpanes = [];
    for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
      for (const p of M.dockedPanesAt(css, preset.dockedLayout, vp)) {
        if (p.tabs.includes('consistency')) cpanes.push([`preset ${key}`, p.width, p.height]);
      }
    }
    // the floating overlay (min 420 x 320) is not a preset: an expanded card
    // taller than the area is capped at it and scrolls its details (the
    // fallback must be there: CSS overflow-y and the JSX maxHeight), never cut
    cpanes.push(['floating overlay minimum (content ~ 418 x 280)', 418, 280, { overlay: true }]);
    for (const [name, W, H, opts = {}] of cpanes) {
      const all = consistencyModel(vp, W, H);
      const foc = consistencyModel(vp, W, H, { expandedCompounds: 3 });
      const pages = (m) => `${m.cols} col x ${m.layout.pages.length} page(s) at ${m.layout.rowH} px`;
      console.log(`  Consistency ${name} ${W.toFixed(0)}x${H.toFixed(0)}: header ${all.barLines} line(s), room ${f1(all.room)} px; all collapsed: ${pages(all)}; focus card expanded (${foc.wide ? 'wide' : 'narrow'}, ${f1(foc.expandedH)} px, tyre rows ${foc.tyreLines} line(s)): ${pages(foc)}`);
      console.log(`    collapsed line ${f1(all.lineW)} px (LOW DATA ${f1(all.lowDataW)}) in cards >= ${all.minCardW} px`);
      if (all.lineW > all.minCardW || all.lowDataW > all.minCardW) fail(`${vp.name} consistency: the collapsed line is wider than CONSISTENCY_CARD_EM`);
      if (foc.expandedH > foc.room) {
        const msg = `${vp.name} consistency ${name}: an expanded card (${f1(foc.expandedH)}) taller than a page (${f1(foc.room)})`;
        if (!opts.overlay) fail(msg);
        else if (!CARD_SCROLL_FALLBACK) fail(`${msg}, and no scroll fallback (dashboard.css .consistency-card__details overflow-y: auto, ConsistencyPanel.jsx maxHeight)`);
        else console.log(`    ${msg}: capped at the area, its details scroll (SCROLL_JUSTIFICATIONS.md "Consistency expanded card")`);
      }
    }
    // 5. Lap Times timing sheet
    const dataPx = Math.max(11, M.px(css, '--font-size-data', vp));
    const spacingMd = M.px(css, '--spacing-md', vp);
    const floors = TS.columnFloors(TIMING_COLUMNS, dataPx);
    const defaults = TIMING_COLUMNS.map((c) => c.defaultW);
    const lpanes = [];
    for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
      for (const p of M.dockedPanesAt(css, preset.dockedLayout, vp)) {
        if (p.tabs.includes('laptimes')) lpanes.push([`preset ${key}`, p.width - 2 - 2 * spacingMd, false]);
      }
    }
    // floating overlay at its 420 px minimum: the panel's border and padding off
    lpanes.push(['floating overlay minimum 420 px', 420 - 2 - 2 * spacingMd, true]);
    for (const [name, content, overlay] of lpanes) {
      const box = content - SCROLLBAR_W;
      const fit = TS.fitColumns(TIMING_COLUMNS, defaults, box, floors, { hiddenW: Math.ceil(TS.TIMING_HIDDEN_EM * dataPx) });
      const used = fit.total + (fit.hiddenW ? fit.hiddenW + TS.TIMING_GAP : 0);
      const shrunk = TIMING_COLUMNS.filter((c, i) => fit.shown[i] && fit.widths[i] < c.defaultW).map((c, i) => c.key);
      console.log(`  Lap Times ${name}: rows' box ${f1(box)} px (data ${f1(dataPx)} px): sheet ${f1(used)} px${fit.hidden.length ? `, +${fit.hidden.length} hidden (${fit.hidden.join(', ')})` : ', every column'}${shrunk.length ? `, shrunk: ${shrunk.join(', ')}` : ', default widths'}`);
      if (used > box + 0.01) fail(`${vp.name} lap times ${name}: the sheet (${f1(used)} px) is wider than its box (${f1(box)} px)`);
      fit.widths.forEach((w, i) => { if (fit.shown[i] && w < floors[i]) fail(`${vp.name} lap times ${name}: ${TIMING_COLUMNS[i].key} ${w} px under its floor ${floors[i]}`); });
      if (fit.hidden.length && !overlay) fail(`${vp.name} lap times ${name}: columns given up in a preset pane (${fit.hidden.join(', ')})`);
    }
    // 4. weather event name
    const s = M.shellAt(css, vp);
    const fontXs = Math.max(M.px(css, '--font-size-data', vp), 0.6875 * s.root);
    const box = vp.W <= 1440 ? 0.08 * vp.W : Math.max(96, Math.min(0.11 * vp.W, 260));
    const name = vp.W <= 1440 ? 'Italian GP' : 'Italian Grand Prix';
    const w = F.width(name, fontXs, 700, { letterSpacingEm: 0.04 });
    console.log(`  Weather bar event: "${name}" ${f1(w)} px in a ${f1(box)} px box ${w <= box ? 'fits' : '(ellipsis + title)'}`);
    if (vp.name === '1366x768' && w > box) fail('weather bar: "Italian GP" cut at 1366 x 768');
    console.log('');
  }
  console.log(failures ? `${failures} failure(s)` : 'Every row and card of these views is on screen at the four viewports (fitted or paged, never cut).');
  process.exitCode = failures ? 1 : 0;
}
