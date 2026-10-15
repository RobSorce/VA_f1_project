// V5 / V13 target (1) inside the Pit Wall: the Timing Tower and the Race Pace
// Grid fit their cells at the four target viewports instead of scrolling.
//  - Timing Tower: column widths in shares of the 480 px timing column (no
//    horizontal scroll), rows fitted to the body (fitRows, 24 px down to
//    18 px), so the 20 rows fit even with the focus cards expanded;
//  - Race Pace Grid: cell width from the panel width (paceColumns), the label
//    shortened to what the cell holds (the glyph always kept), rows fitted to
//    the height and the laps that do not fit paged (paceLapWindow): the most
//    recent laps follow the replay, older ones a page back.
// Static model of the layout (helpers/layoutModel.js) and the pure helpers;
// the lead's browser pass checks the rendered tables.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIEWPORTS, loadCss, pitWallSpec, pitWallAt, px, dockedPanesAt,
} from './helpers/layoutModel.js';
import { WINDOW_PRESETS } from '../utils/windowPresets.js';
import {
  compareSections, comparePages, COMPARE_GAP, COMPARE_COL_MIN_W,
} from '../utils/views/driverCompare.js';
import {
  paceColumns, paceLabel, paceLapWindow,
  PACE_CELL_MAX_W, PACE_CELL_MIN_W, PACE_LAP_COL_W, PACE_HEADER_H, PACE_ROW_MIN, PACE_ROW_MAX,
} from '../utils/views/racePaceGrid.js';
import { fitRows } from '../utils/views/chartBox.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const css = loadCss(SRC);
const spec = pitWallSpec(SRC);
const tower = read('components/visualizations/TimingTower.jsx');
const grid = read('components/visualizations/RacePaceGrid.jsx');

describe('Timing Tower: the columns share the panel width, the rows fit the body', () => {
  it('COL sums to at most 476 px (the 480 px column minus its borders), drawn as percentages, table-layout fixed, no horizontal scroll', () => {
    const cols = tower.match(/const COL = \{([\s\S]*?)\};/)[1];
    const sum = [...cols.matchAll(/:\s*(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    console.log(`Timing Tower: COL sum ${sum} px`);
    expect(sum).toBeLessThanOrEqual(476);
    expect(tower).toMatch(/tableLayout: 'fixed'/);
    expect(tower).toMatch(/<col key=\{key\} style=\{\{ width: colPct\(w\) \}\} \/>/);
    expect(tower).not.toMatch(/overflowX/);
  });

  it('rows: 24 px while the 20 rows fit, 18 px at least; 20 rows fit in 416 px (focus cards expanded)', () => {
    const rowMin = Number(tower.match(/const ROW_MIN = (\d+);/)[1]);
    const rowMax = Number(tower.match(/const ROW_MAX = (\d+);/)[1]);
    expect([rowMin, rowMax]).toEqual([18, 24]);
    const at416 = fitRows(416, 20, { rowMin, rowMax, rowDefault: rowMax });
    expect(at416).toEqual({ rowH: 20, perPage: 20, paged: false });
    expect(fitRows(568, 20, { rowMin, rowMax }).rowH).toBe(24);
    // server render (not measured): 24 px rows
    expect(fitRows(0, 20, { rowMin, rowMax, rowDefault: rowMax }).rowH).toBe(24);
  });
});

describe('Race Pace Grid: no scroll, the cells fit the Pit Wall centre at the four viewports', () => {
  it('the component has no scroll area and no scrollIntoView', () => {
    expect(grid).not.toMatch(/overflow: 'auto'|overflowX|overflowY|scrollIntoView|position: 'sticky'/);
    expect(grid).toMatch(/paceColumns\(gridBox\.width, sortedDrivers\.length, chartFontPx\('data'\)\)/);
    expect(grid).toMatch(/paceLapWindow\(gridMaxLap, currentLap, rowFit\.perPage, pinnedLast\)/);
  });

  for (const vp of VIEWPORTS) {
    it(`${vp.name}: 20 driver columns fit the centre cell, with a time label that fits the cell`, () => {
      const pw = pitWallAt(css, spec, vp);
      const fontPx = px(css, '--font-size-data', vp);
      const c = paceColumns(pw.mainW, 20, fontPx);
      const width = PACE_LAP_COL_W + c.cellW * c.perPage;
      const rows = fitRows(pw.middle - PACE_HEADER_H, 53, { rowMin: PACE_ROW_MIN, rowMax: PACE_ROW_MAX });
      console.log(`${vp.name}: centre ${pw.mainW.toFixed(0)} x ${pw.middle.toFixed(0)} px, data font ${fontPx.toFixed(2)} px -> cell ${c.cellW} px, ${c.perPage} drivers per page, format ${c.format}; ${rows.perPage} of 53 laps at ${rows.rowH} px (legend row not counted)`);
      expect(c.paged).toBe(false);
      expect(c.perPage).toBe(20);
      expect(width).toBeLessThanOrEqual(pw.mainW);
      // the label the format allows fits the cell at the data font (JetBrains Mono, 0.6 em)
      const chars = { full: 10, seconds: 7, short: 5 }[c.format];
      expect(chars * 0.6 * fontPx + 4).toBeLessThanOrEqual(c.cellW);
    });
  }

  it('paceColumns: 78 px cells at most, 36 px at least, then the drivers are paged; unmeasured = every driver, full labels', () => {
    expect(paceColumns(0, 20)).toEqual({ cellW: PACE_CELL_MAX_W, perPage: 20, paged: false, format: 'full' });
    expect(paceColumns(5000, 20, 11).cellW).toBe(PACE_CELL_MAX_W);
    expect(paceColumns(5000, 20, 11).format).toBe('full');
    const narrow = paceColumns(432, 20, 11);
    expect(narrow.cellW).toBe(PACE_CELL_MIN_W);
    expect(narrow.perPage).toBe(Math.floor((432 - PACE_LAP_COL_W) / PACE_CELL_MIN_W));
    expect(narrow.paged).toBe(true);
    expect(narrow.format).toBe('short');
  });

  it('paceLabel: full time, seconds or tenths; other labels unchanged', () => {
    expect(paceLabel('1:21.123', 'full')).toBe('1:21.123');
    expect(paceLabel('1:21.123', 'seconds')).toBe('21.123');
    expect(paceLabel('1:21.163', 'short')).toBe('21.2');
    expect(paceLabel('58.012', 'seconds')).toBe('58.012');
    for (const l of ['IN PIT', 'RET', '-', 'OUT', '']) expect(paceLabel(l, 'short')).toBe(l);
  });

  it('paceLapWindow: every lap when they fit; else the most recent laps up to the lap in progress, paged back on demand', () => {
    expect(paceLapWindow(20, 7, 25)).toMatchObject({ first: 1, last: 20, following: true, canOlder: false });
    // 53 laps, 14 fit, replay at lap 30: laps 17-30
    const w = paceLapWindow(53, 30, 14);
    expect(w).toMatchObject({ first: 17, last: 30, following: true, canOlder: true, canNewer: false });
    // one page back (older): 3-16; the replay moves on, the pinned window stays
    const back = paceLapWindow(53, 31, 14, w.last - w.size);
    expect(back).toMatchObject({ first: 3, last: 16, following: false, canNewer: true });
    // back as far as it goes: laps 1-14
    expect(paceLapWindow(53, 31, 14, 2)).toMatchObject({ first: 1, last: 14, canOlder: false });
    // a pinned window at or past the lap in progress follows the replay again
    expect(paceLapWindow(53, 31, 14, 30 + 14)).toMatchObject({ first: 18, last: 31, following: true });
    // early in the race: laps 1-14, the future ones blank
    expect(paceLapWindow(53, 5, 14)).toMatchObject({ first: 1, last: 14 });
  });
});

// V13 (verifier): the Driver Comparison cut its lap chart and never showed its
// metric tables in the overview preset (fixed 200 + 160 px charts, body
// overflow hidden). Now its sections flow into columns and pages that fit the
// pane (utils/views/driverCompare.js; notes/experiments/phase9/repair_compare_fit.mjs)
describe('Driver Comparison: every section in a column of a page that fits its pane', () => {
  const view = read('components/visualizations/DriverComparePanel.jsx');
  it('the panel lays its sections with comparePages, a pager when there are several pages, no scroll', () => {
    expect(view).toMatch(/comparePages\(bodyBox, compareSections\(/);
    expect(view).toMatch(/className="compare-panel__pager"/);
    expect(view).not.toMatch(/overflow(Y|X)?: 'auto'/);
  });
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: in every preset holding the compare view, a table always fits its column`, () => {
      const data = px(css, 'var(--font-size-data)', vp);
      // header 6 + 6 padding around a driver card (4 + 4 padding, the 18 px code, 1 px and a data line), its 1 px rule
      const header = 12 + (8 + Math.max(28, 18 + 1 + Math.ceil(data * 1.3)) + 2) + 1;
      const sections = compareSections({ sectors: 3, speeds: 4, summary: 5, tyres: true }, data);
      const byKey = Object.fromEntries(sections.map((x) => [x.key, x]));
      let panes = 0;
      for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
        for (const pane of dockedPanesAt(css, preset.dockedLayout, vp)) {
          if (!pane.tabs.includes('compare')) continue;
          panes += 1;
          const body = { width: Math.floor(pane.width - 20), height: Math.floor(pane.height - header - 12) };
          const { pages, cols, pagerH } = comparePages(body, sections);
          const room = body.height - pagerH - (pagerH ? COMPARE_GAP : 0);
          expect(cols * COMPARE_COL_MIN_W).toBeLessThanOrEqual(body.width + COMPARE_GAP * cols);
          // every section is on exactly one page
          expect(pages.flat(2).sort()).toEqual(sections.map((x) => x.key).sort());
          for (const col of pages.flat(1)) {
            const tables = col.filter((k) => byKey[k].kind === 'table').reduce((a, k) => a + byKey[k].h, 0)
              + (col.length - 1) * COMPARE_GAP;
            expect(tables, `${vp.name} ${key} ${col.join('+')}`).toBeLessThanOrEqual(room);
          }
          console.log(`${vp.name} ${key}: compare pane ${pane.width.toFixed(0)}x${pane.height.toFixed(0)} -> ${cols} column(s), ${pages.length} page(s)`);
        }
      }
      expect(panes).toBeGreaterThan(0);
    });
  }
});

// V13 (verifier): the Strategy Timeline put 20 driver rows on a band of the
// pane height with no fitRows (7.4 px rows for 11 px labels in the Pit Window
// preset at 1536 x 750). Now the rows keep ceil(data type + ROW_MIN_PAD) px;
// a wide, low pane lays them in up to MAX_COLS columns, the rest is paged
// (notes/experiments/phase9/repair_strategy_fit.mjs)
describe('Strategy Timeline: driver rows never under their minimum, in columns then pages', () => {
  const view = read('components/visualizations/StrategyTimeline.jsx');
  const pad = Number(view.match(/const ROW_MIN_PAD = (\d+);/)[1]);
  const maxCols = Number(view.match(/const MAX_COLS = (\d+);/)[1]);
  const colMinW = Number(view.match(/const COL_MIN_W = (\d+);/)[1]);
  const [mt, mb] = [Number(view.match(/const MARGIN = \{ top: (\d+)/)[1]), Number(view.match(/bottom: (\d+), left/)[1])];
  const right = Number(view.match(/const MARGIN = \{[^}]*right: (\d+)/)[1]);
  it('the view fits its rows (fitRows with the row minimum) and pages the drivers (pageOf)', () => {
    expect(view).toMatch(/const rowMin = Math\.ceil\(chartFontPx\('data'\) \+ ROW_MIN_PAD\);/);
    expect(view).toMatch(/fitRows\(box\.height - MARGIN\.top - MARGIN\.bottom, driverList\.length, \{ rowMin, rowMax: 1000 \}\)/);
    expect(view).toMatch(/pageOf\(driverList, page, fit\.perPage\)/);
  });
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: Pit Window preset shows all 20 drivers on one page, rows >= the minimum`, () => {
      const data = px(css, 'var(--font-size-data)', vp);
      const label = px(css, 'var(--font-size-label)', vp);
      const sm = px(css, 'var(--spacing-sm)', vp);
      const md = px(css, 'var(--spacing-md)', vp);
      const rowMin = Math.ceil(data + pad);
      const dense = /className="panel--dense"/.test(view);
      const panes = dockedPanesAt(css, WINDOW_PRESETS.pitwindow.dockedLayout, vp).filter((p) => p.tabs.includes('strategy'));
      expect(panes.length).toBe(1);
      const pane = panes[0];
      const padIn = dense ? sm : md;
      const chart = pane.height - (2 * sm + 22 + 1) - 2 * padIn - (label * 1.3 + 6);
      const width = pane.width - 2 * padIn;
      const rows = fitRows(chart - mt - mb, 20, { rowMin, rowMax: 1000 });
      const cols = rows.paged ? Math.max(1, Math.min(maxCols, Math.floor((width - right) / colMinW))) : 1;
      console.log(`${vp.name} pitwindow strategy pane ${pane.width.toFixed(0)}x${pane.height.toFixed(0)}: ${cols} column(s) of ${rows.perPage} rows (>= ${rowMin} px)`);
      expect(Math.min(20, rows.perPage * cols)).toBe(20);
      expect(rows.rowH >= rowMin || rows.paged).toBe(true);
    });
  }
});

// V5 / V13 r2: in the Analyse sidebar the Leaderboard rows were clipped under
// the focus cards. The cards now stay collapsed to their header lines below
// 1200 px of window height (SidebarFocusCards.jsx), "Details" laying them
// over the sidebar, and the rows fit (fitRows 28 -> 18 px) or page. Phase 9c
// (D1): the legend (three lines in the sidebar) opens from a "?" key below
// 900 px of height, the header, column header and banner are a step tighter
// (the full model, with the real font widths and the flag banner and the
// forecast footer: __tests__/leaderboard.fit.test.jsx and
// notes/experiments/v13_audit/panel_fit.mjs). Here: the Leaderboard chrome
// (header, mode bar, column header, the legend from 900 px) and the collapsed
// cards (toggle 22 px + the two header lines).
describe('Analyse sidebar: the 20 Leaderboard rows fit with the focus cards collapsed', () => {
  const cards = read('components/layout/SidebarFocusCards.jsx');
  const lb = read('components/visualizations/Leaderboard.jsx');
  it('the cards collapse below 1200 px of height; the rows fit 28 -> 18 px with a pager; the legend behind a key below 900 px', () => {
    expect(cards).toMatch(/const SIDEBAR_SHORT_VIEWPORT = '\(max-height: 1199px\)';/);
    expect(lb).toMatch(/const ROW_MIN = 18;/);
    expect(lb).toMatch(/const ROW_MAX = 28;/);
    expect(lb).toMatch(/const LEGEND_POPOVER_VIEWPORT = '\(max-height: 899px\)';/);
  });
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: 20 rows on one page with a focus driver (cards collapsed)`, () => {
      const data = px(css, '--font-size-data', vp);
      const label = px(css, '--font-size-label', vp);
      const xs = px(css, '--spacing-xs', vp);
      const body = vp.H - px(css, '--weather-bar-height', vp) - px(css, '--timeline-height', vp)
        - px(css, '--bottom-tab-height', vp) - px(css, '--dock-margin', vp);
      const legend = vp.H >= 900 ? 3 * (4 + 1.4 * label) + 4 * xs : 0;
      const chrome = (6 + 6 + 24 + 1) + 24 + (6 + Math.ceil(data * 1.4) + 1) + legend;
      const collapsed = 22 + (1 + 8 + Math.max(18, 2 + 1.2 * data + 2) + 8 + 1) + (1 + 8 + Math.max(24, 14 + 1 + 1.2 * label) + 8 + 1);
      expect(vp.H).toBeLessThanOrEqual(1199);
      const fit = fitRows(body - chrome - collapsed, 20, { rowMin: 18, rowMax: 28, rowDefault: 28, pagerH: 22 });
      console.log(`${vp.name}: ${(body - chrome - collapsed).toFixed(0)} px for the rows -> ${fit.paged ? `paged, ${fit.perPage} per page` : `20 rows at ${fit.rowH} px`}`);
      expect(fit.paged).toBe(false);
      expect(fit.rowH).toBeGreaterThanOrEqual(18);
    });
  }
});
