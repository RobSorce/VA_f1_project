/**
 * The Lap Times timing sheet fitted to its pane (components/visualizations/
 * LapTimeChart.jsx, columns TIMING_COLUMNS of ./lapTimeChart.js).
 *
 * No imports: frontend/scripts/audit/panel_fit.mjs loads this module in
 * plain node. Pure functions, tested in __tests__/laptimes.fit.test.jsx.
 */

/* ── The sheet fitted to its pane (Phase 9c r2, D3) ─────────────────
   The header and the rows are one grid of px columns inside a panel that
   clips (overflow hidden): at their 743 px of default widths (775 px with the
   gaps and the padding) the columns past the pane's right edge were cut with
   their values, no ellipsis and no scroll, in 7 of the 16 preset x viewport
   cases (Gap, Tyre and Laps hidden at 1536 x 750 Pace, Lap Time cut by 6 px).
   Now the columns shrink to the pane, down to floors that keep every value
   whole; only a pane too narrow for the floors (a floating window near its
   420 px minimum) gives up whole columns, named in a "+N" header cell. */

/** Grid gap and horizontal padding of the header and the rows (px). */
export const TIMING_GAP = 2;
export const TIMING_PAD_X = 6;

/**
 * Floor of each column: the width its values need at the data size, in
 * data-type ems (JetBrains Mono 0.6 em a character: "◆28.123" 4.38 em,
 * "◆1:21.123" 5.58 em, "+12.345" 4.2 em, "RET" 1.86 em; the widest surname,
 * HULKENBERG, 8.45 em in Formula1 Bold) or in px (the 3 px team bar, the
 * 16-20 px logo, the 14 px compound badge). Measured in
 * docs/evidence/timing_floors.txt. A header label
 * wider than its floor ends in an ellipsis (its full name in the title).
 */
export const TIMING_FLOORS = Object.freeze({
  pos: { em: 2.2 },
  bar: { px: 3 },
  team: { px: 22 },
  driver: { em: 8.6 },
  s1: { em: 4.4 },
  s2: { em: 4.4 },
  s3: { em: 4.4 },
  lapTime: { em: 5.6 },
  gap: { em: 4.4 },
  tyre: { px: 22 },
  laps: { em: 2.4 },
});

/** Columns given up, in this order, when even the floors do not fit. */
export const TIMING_DROP_ORDER = Object.freeze(['team', 'laps', 'tyre', 'gap', 's3', 's2', 's1']);

/** The header's "+N" cell (hidden columns), in data-type ems. */
export const TIMING_HIDDEN_EM = 2.6;

/**
 * Floors of the columns (px) at a data type size: TIMING_FLOORS (a column
 * without one: its minW). They are also the drag minimum: the minW of
 * TIMING_COLUMNS (56 px for Gap, 36 for Tyre) was more than the values need
 * and kept every column at 1366 x 768 Pace from fitting.
 *
 * @param {Array<{key: string, minW: number}>} columns - TIMING_COLUMNS
 * @param {number} dataPx - the data type size (CHART_FONT.data on screen, >= 11)
 * @returns {number[]}
 */
export function columnFloors(columns, dataPx) {
  const d = Number.isFinite(dataPx) && dataPx > 0 ? dataPx : 11;
  return columns.map((c) => {
    const f = TIMING_FLOORS[c.key] || { px: c.minW };
    return Math.ceil(f.px != null ? f.px : f.em * d);
  });
}

/**
 * Column widths that fit the sheet into `available` px (the rows' box): the
 * user's widths (defaults, or dragged) raised to the floors, then, when the
 * sheet is wider than the box, every column shrunk by its share of the room
 * above its floor; when even the floors do not fit, columns are given up in
 * TIMING_DROP_ORDER and the header gets a "+N" cell `hiddenW` px wide. An
 * unknown width (0: not measured) keeps the widths as they are.
 *
 * @param {Array<{key: string, defaultW: number}>} columns - TIMING_COLUMNS
 * @param {number[]} widths - one per column
 * @param {number} available - px of the rows' box
 * @param {number[]} floors - timingColumnFloors
 * @param {{hiddenW?: number}} [opts]
 * @returns {{widths: number[], shown: boolean[], hidden: string[], hiddenW: number, total: number}}
 *   widths: 0 for a hidden column; total: px of the rows (padding and gaps included)
 */
export function fitColumns(columns, widths, available, floors, { hiddenW = 29 } = {}) {
  const n = columns.length;
  const want = columns.map((c, i) => Math.max(Number(widths?.[i]) || c.defaultW, floors[i] || 0));
  const shown = columns.map(() => true);
  const frame = (k) => 2 * TIMING_PAD_X + TIMING_GAP * Math.max(0, k - 1);
  const totalOf = (ws) => {
    const idx = ws.map((w, i) => (shown[i] ? i : -1)).filter((i) => i >= 0);
    return idx.reduce((a, i) => a + ws[i], 0) + frame(idx.length);
  };
  const avail = Number(available);
  if (!Number.isFinite(avail) || avail <= 0) {
    return { widths: want, shown, hidden: [], hiddenW: 0, total: totalOf(want) };
  }
  // Give up whole columns while the floors do not fit (the "+N" cell then
  // takes its own room and a gap in the header)
  let budget = avail;
  for (const key of TIMING_DROP_ORDER) {
    if (totalOf(floors) <= budget) break;
    const k = columns.findIndex((c) => c.key === key);
    if (k >= 0) shown[k] = false;
    budget = avail - hiddenW - TIMING_GAP;
  }
  const hidden = columns.filter((c, i) => !shown[i]).map((c) => c.key);
  const out = want.map((w, i) => (shown[i] ? w : 0));
  const over = totalOf(out) - budget;
  if (over > 0) {
    const slack = out.map((w, i) => (shown[i] ? Math.max(0, w - floors[i]) : 0));
    const room = slack.reduce((a, s) => a + s, 0);
    for (let i = 0; i < n; i++) {
      if (!shown[i]) continue;
      out[i] = room > over
        ? Math.max(floors[i], Math.floor(out[i] - (over * slack[i]) / room))
        : floors[i];
    }
  }
  return { widths: out, shown, hidden, hiddenW: hidden.length ? hiddenW : 0, total: totalOf(out) };
}
