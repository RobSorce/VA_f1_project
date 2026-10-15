/**
 * View model of the Sectors panel's "Best" tab (D5, Phase 9c):
 * components/visualizations/SectorsBestChart.jsx draws one D3 chart per
 * sector from it: a band scale of the drivers in ranking order, a linear
 * scale of the gap to the session best (bars from 0, the gap axis in seconds
 * when the column has room for it under the rows), the value of every bar
 * written next to it, the driver as a badge in his team colour with its code
 * in contrastText. The rows on the page and their height come from the
 * panel's fit (SectorsPanel.jsx, utils/views/sectorsPanel.js sectorsRowFit:
 * 18 px at the least, the ranks paged below that, D1).
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component.
 *
 * Pure module: no React, no D3, no store access.
 */
import { STATUS_COLORS, STATUS_GLYPHS, TEXT_COLORS } from '../colors';

// Bar of a gap (neutral: the driver is named by his badge, the gap by the
// bar's length and its value), >= 3:1 on the chart surface
export const GAP_BAR_COLOR = TEXT_COLORS.muted;

// Row height when the panel gives none (18 px floor of a data row, D1)
export const BEST_ROW_MIN = 18;
export const BEST_ROW_MAX = 26;
// Room the gap axis needs under the rows: its ticks, the unit on the last one
export const BEST_AXIS_H = 20;
// Horizontal layout: rank, team badge, then the bars; the value after the bar
export const BEST_RANK_W = 18;
export const BEST_BADGE_W = 36;
const GAP_AFTER_BADGE = 8;
const VALUE_GAP = 4;
// Width of a mono digit in em (the value labels: "+0.123", "◆ 26.123")
const MONO_EM = 0.62;

/**
 * Rows of one sector, in ranking order, with the gap to the session best.
 *
 * @param {Array<{driver: string, best: number, rank: number}>} items - sectorsPanelData bestRankings[s]
 * @param {number|null} sessionBest - bestSessionBests[s]
 * @returns {Array<{driver: string, rank: number, time: number, gap: number, isBest: boolean}>}
 */
export function bestGapRows(items, sessionBest) {
  const list = Array.isArray(items) ? [...items] : [];
  list.sort((a, b) => (a.rank - b.rank) || (a.best - b.best));
  const ref = Number.isFinite(sessionBest) ? sessionBest : (list[0]?.best ?? 0);
  return list.map((e) => {
    const gap = Math.max(0, Math.round((e.best - ref) * 1000) / 1000);
    return {
      driver: e.driver, rank: e.rank, time: e.best, gap, isBest: !!e.is_session_best || gap === 0,
    };
  });
}

/** Value written next to a bar: the time of the best (with ◆), "+0.123" for a gap. */
export function bestValueLabel(row) {
  if (!row) return '';
  return row.isBest ? `${STATUS_GLYPHS.overallBest} ${row.time.toFixed(3)}` : `+${row.gap.toFixed(3)}`;
}

/**
 * Tick of the gap axis: "0", then "+0.2", with two decimals when the ticks
 * are closer than 0.1 s; the last tick carries the unit ("+0.6 s").
 *
 * @param {number} v - s
 * @param {number} [step=0.1] - the distance between two ticks (s)
 * @param {boolean} [last=false] - the last tick of the axis
 */
export function gapTick(v, step = 0.1, last = false) {
  if (v === 0) return last ? '0 s' : '0';
  return `+${Number(v).toFixed(step < 0.1 - 1e-9 ? 2 : 1)}${last ? ' s' : ''}`;
}

/**
 * Row height of the chart: the panel's (its fit), else the height shared by
 * the rows, 18 to 26 px.
 *
 * @param {number|undefined} rowH - from the panel
 * @param {number} height - px of the chart
 * @param {number} n - rows on the page
 * @returns {number}
 */
export function bestRowHeight(rowH, height, n) {
  if (Number.isFinite(rowH) && rowH > 0) return rowH;
  if (!(n > 0) || !(height > 0)) return BEST_ROW_MIN;
  return Math.max(BEST_ROW_MIN, Math.min(BEST_ROW_MAX, Math.floor(height / n)));
}

/**
 * Margins of one sector's chart: the rank and the badge on the left, the
 * longest value label of the sector (at the data size) on the right.
 *
 * @param {{width: number, rows: Array, fontPx: number}} args
 * @returns {{top: number, right: number, left: number, valueW: number}}
 */
export function bestChartMargins({ width, rows, fontPx }) {
  const longest = (rows || []).reduce((m, r) => Math.max(m, bestValueLabel(r).length), 6);
  const valueW = Math.ceil(longest * MONO_EM * fontPx) + VALUE_GAP + 2;
  const left = BEST_RANK_W + BEST_BADGE_W + GAP_AFTER_BADGE;
  return {
    top: 0,
    left,
    right: Math.min(Math.max(0, width - left - 20), valueW),
    valueW,
  };
}

/**
 * Legend rows of the Best tab (V4): the session best (◆, its colour, the
 * time written next to it) and the bar (its length is the gap to the best,
 * its value written next to it, the axis in seconds).
 */
export function sectorsBestLegend() {
  return [
    {
      label: 'Session best (its time)', color: STATUS_COLORS.overallBest, glyph: STATUS_GLYPHS.overallBest, shape: 'glyph',
    },
    { label: 'Bar: gap to the session best (s)', color: GAP_BAR_COLOR, shape: 'square' },
  ];
}
