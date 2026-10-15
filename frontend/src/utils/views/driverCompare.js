/**
 * Layout of the Driver Comparison panel (components/visualizations/
 * DriverComparePanel.jsx) in the box its pane gives it (V13: nothing cut,
 * nothing scrolls): the sections (gap chart, lap-time chart, the three metric
 * tables, tyre strategy) flow into side-by-side columns of at least
 * COMPARE_COL_MIN_W px, each column filled top to bottom while the sections
 * fit its height; what does not fit goes to the next page (◀ ▶). A chart
 * never gets less than COMPARE_CHART_MIN_H px and takes what its column
 * leaves; a table keeps its natural height (title + one line per row).
 *
 * Pure module: no React, no D3, no DOM (React Fast Refresh hot-swaps a
 * component module only when every export is a component).
 */

export const COMPARE_COL_MIN_W = 320;
export const COMPARE_CHART_MIN_H = 140;
export const COMPARE_GAP = 8;
export const COMPARE_PAGER_H = 22;
// Legend line above the lap-time chart and under the tyre strategy (one line)
export const COMPARE_LEGEND_H = 26;

/**
 * Heights (px) of the sections at a data font size, as dashboard.css draws
 * them: a metric table is its title line (data type x 1.3 + 5 + 5 px padding
 * + 1 px rule, + the card's 1 px borders) and one line per row (data type x
 * 1.3 + 4 + 4 px padding + 1 px rule).
 *
 * @param {{sectors: number, speeds: number, summary: number, tyres: boolean}} rows - rows per table
 * @param {number} fontPx - the data type in px (CHART_FONT.data)
 * @returns {Array<{key: string, kind: 'chart'|'table', h: number}>}
 */
export function compareSections(rows, fontPx) {
  const line = Math.ceil(fontPx * 1.3);
  const title = line + 10 + 1 + 2;
  const row = line + 8 + 1;
  const table = (n) => title + n * row;
  const out = [
    { key: 'gap', kind: 'chart', h: COMPARE_CHART_MIN_H },
    { key: 'laps', kind: 'chart', h: COMPARE_CHART_MIN_H + COMPARE_LEGEND_H },
  ];
  if (rows.sectors > 0) out.push({ key: 'sectors', kind: 'table', h: table(rows.sectors) });
  if (rows.speeds > 0) out.push({ key: 'speeds', kind: 'table', h: table(rows.speeds) });
  if (rows.summary > 0) out.push({ key: 'summary', kind: 'table', h: table(rows.summary) });
  // two D3 stint strips (DriverComparePanel StrategyComparison: rows of
  // max(18, round(1.6 x data)) px, at most 20 px at the 12.5 px type) and their
  // 20 px lap axis = at most 60 px, and the compound legend
  if (rows.tyres) out.push({ key: 'tyres', kind: 'table', h: title + 2 * 30 + COMPARE_LEGEND_H });
  return out;
}

/**
 * Pages of columns of sections fitted to a box. An unmeasured box (0: server
 * render, first paint) gives one page with one column of every section.
 *
 * @param {{width: number, height: number}} box - px of the panel body
 * @param {Array<{key: string, h: number}>} sections
 * @returns {{pages: Array<Array<Array<string>>>, cols: number, pagerH: number}}
 *   pages[p][c] = the section keys of column c on page p
 */
export function comparePages(box, sections) {
  const W = Number(box?.width) || 0;
  const H0 = Number(box?.height) || 0;
  if (W <= 0 || H0 <= 0) return { pages: [[sections.map((s) => s.key)]], cols: 1, pagerH: 0 };
  const cols = Math.max(1, Math.floor((W + COMPARE_GAP) / (COMPARE_COL_MIN_W + COMPARE_GAP)));
  const pack = (H) => {
    const pages = [];
    let page = [];
    let col = [];
    let used = 0;
    for (const s of sections) {
      const need = (col.length ? COMPARE_GAP : 0) + s.h;
      if (col.length && used + need > H) {
        page.push(col);
        col = [];
        used = 0;
        if (page.length === cols) { pages.push(page); page = []; }
      }
      col.push(s.key);
      used += (used ? COMPARE_GAP : 0) + s.h;
    }
    if (col.length) page.push(col);
    if (page.length) pages.push(page);
    return pages;
  };
  let pages = pack(H0);
  let pagerH = 0;
  if (pages.length > 1) {
    pagerH = COMPARE_PAGER_H;
    pages = pack(H0 - pagerH - COMPARE_GAP);
  }
  return { pages, cols, pagerH };
}
