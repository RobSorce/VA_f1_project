/**
 * Room of the Track Map in its panel (Phase 9d, G1 / G2).
 *
 * The browser pass (docs/evidence/browser_audit_2026-10-16.md,
 * "Re-check after Phase 9c") measured the Pit Wall Track Map at 1536 x 750:
 * panel 387 x 263, its header controls wrapped to 181 px (rotation, zoom,
 * the S1-S3 / DRS / Corners toggles, the channel buttons and two legends in
 * the header row), the map 354 x 34 px. Now:
 *  - the header holds one row of square icon buttons (TOOL_PX, never
 *    wrapped): zoom in / out / reset and the Layers button, plus the
 *    rotation buttons where the panel is wide enough (ROTATE_TOOLS_MIN_W);
 *  - the layers (sectors, DRS, corners), the channel overlay, the legend
 *    and the driver key are a strip above the map only in a tall panel
 *    (LAYERS_INLINE_MIN_H); below, they open from the Layers button and a
 *    one-line key of what is drawn sits on the map's top-left corner;
 *  - the panel content keeps half the usual padding (.panel--dense);
 *  - the map is never laid out at a degenerate size (MAP_LAYOUT_MIN_PX) and
 *    its drawing margin follows the box (mapDrawPadding): a fixed 70 px
 *    margin left 50 px of track in a 190 px tall map.
 *
 * Pure functions and constants (no React, no DOM): the component, its tests
 * and the static layout report (layout_fit.mjs, Pit Wall maps) read them.
 */

/** Side of a toolbar button (CSS px) and the gap between two of them. */
export const TOOL_PX = 24;
export const TOOL_GAP_PX = 4;
/** Width of a separator between two groups of the toolbar (CSS px). */
export const TOOL_SEPARATOR_PX = 1;

/**
 * Content height (CSS px, the panel less its header and padding) from
 * which the layers, the channel overlay and the legends are a strip above
 * the map; below it they are in the Layers popover. The four Pit Wall cells
 * (263-385 px tall panels) stay under it: the map keeps the content box.
 */
export const LAYERS_INLINE_MIN_H = 560;

/**
 * Content width (CSS px) from which the three rotation buttons are in the
 * toolbar (else in the Layers popover; the compass rose on the map and the
 * R / Shift+R keys rotate too). The header row then still holds the title,
 * the shortcut key, the toolbar and the export button
 * (__tests__/trackmap.toolbar.test.jsx, real font metrics).
 */
export const ROTATE_TOOLS_MIN_W = 440;

/** The map is laid out only when its box is at least this many px both ways. */
export const MAP_LAYOUT_MIN_PX = 48;

/** Drawing margin around the track (CSS px): 12 % of the smaller side, 28-70 px. */
export const MAP_PADDING = Object.freeze({ share: 0.12, min: 28, max: 70 });

/**
 * Where the controls go for a panel content box (the measured
 * .panel-content of the Track Map, CSS px; 0 x 0 = not measured: the
 * compact choice).
 *
 * @param {{width: number, height: number}|null} area
 * @returns {{layers: 'inline'|'popover', rotateTools: boolean}}
 */
export function trackMapControls(area) {
  const w = Number(area?.width) || 0;
  const h = Number(area?.height) || 0;
  return {
    layers: h >= LAYERS_INLINE_MIN_H ? 'inline' : 'popover',
    rotateTools: w >= ROTATE_TOOLS_MIN_W,
  };
}

/**
 * Width (CSS px) of a toolbar row of `buttons` square buttons and
 * `separators` group separators, a TOOL_GAP_PX gap between every two items.
 *
 * @param {number} buttons
 * @param {number} [separators]
 * @returns {number}
 */
export function toolbarWidth(buttons, separators = 0) {
  const n = Math.max(0, Math.floor(Number(buttons) || 0));
  const s = Math.max(0, Math.floor(Number(separators) || 0));
  const items = n + s;
  return n * TOOL_PX + s * TOOL_SEPARATOR_PX + Math.max(0, items - 1) * TOOL_GAP_PX;
}

/**
 * Buttons and separators of the toolbar for a controls choice: zoom in,
 * out, reset; the rotation group (clockwise, counter-clockwise, default
 * orientation) when `rotateTools`; the Layers button when the layers are
 * in the popover.
 *
 * @param {{layers: 'inline'|'popover', rotateTools: boolean}} controls
 * @returns {{buttons: number, separators: number, width: number}}
 */
export function toolbarLayout(controls) {
  const rotate = controls?.rotateTools ? 3 : 0;
  const layers = controls?.layers === 'inline' ? 0 : 1;
  const buttons = 3 + rotate + layers;
  const separators = (rotate ? 1 : 0) + (layers ? 1 : 0);
  return { buttons, separators, width: toolbarWidth(buttons, separators) };
}

/**
 * Margin (CSS px) kept around the track in a box of width x height: room for
 * the corner numbers, the DRS label and the car codes at the edge; never
 * more than a quarter of the smaller side (the track keeps half of it).
 *
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function mapDrawPadding(width, height) {
  const side = Math.max(0, Math.min(Number(width) || 0, Number(height) || 0));
  const pad = Math.max(MAP_PADDING.min, Math.min(MAP_PADDING.max, Math.round(side * MAP_PADDING.share)));
  return Math.min(pad, Math.floor(side / 4));
}

/* ── The overlays on the map, and the track fitted clear of them ─────────
 * Measured on the real Monza 2024 outline in the Pit Wall cells, before
 * this layout: one telemetry HUD card (148 px wide,
 * 168 px tall, at the map's bottom-left) hid 51 % of the track at
 * 1536 x 750 and 65 % at 1366 x 768; the focus driver and two selected
 * drivers, 100 % at both. Now:
 *  - in a map under HUD_CARDS_MIN_H the HUD is a table, one
 *    HUD_TABLE.rowPx row per driver under one header row; the cards stay
 *    in a big map;
 *  - the corner key, the HUD and the compass rose never overlap one
 *    another;
 *  - the track is fitted clear of the three (fitTrack): the largest scale
 *    at which some placement keeps every point of the outline at least
 *    OVERLAY_GAP_PX (the outline's 12 px half-width + 1 px) off each one.
 * Fitted around the HUD as drawn, the track was then laid out again at
 * every change of the selection: a click on a car (or its Leaderboard row)
 * shrank the track and moved every car 16-33 px at 1536 x 750 (Shanghai
 * 104 px, to the other half of the map), and the focus driver with two
 * selected left a 134 x 67 px track, 12 % of the map (key, HUD and compass
 * rose stacked into a 67 px band). Now the track is fitted around the map's
 * furniture, which does not depend on who is selected (mapPlan):
 *  - the key row: the corner key's whole line (mapKeyBox), whatever it lists;
 *  - the HUD's slot: its capacity, not its rows (hudSlot: HUD_CARDS_MAX
 *    cards, or a table of the rows HUD_MAX_SHARE allows); the drivers fill
 *    it from the bottom (hudTable), the ones past it counted on a last row;
 *  - the compass rose at one of COMPASS_PLACES, and the HUD table's columns,
 *    chosen for the map and the outline as drawn: the most columns whose
 *    track is HUD_KEEP_SHARE of the largest any choice gives;
 *  - a compass on the right is kept CAR_LABEL_REACH_PX further off the track
 *    on its left side: the car code labels are drawn right of the dots;
 *  - a car whose label would cross the map's right edge has it on
 *    the left of its dot (carLabelOnLeft), so the edge never cuts a label.
 * The sizes here are the sizes the CSS gives the boxes (visualizations.css,
 * "Track Map overlays"); __tests__/trackmap.overlays.test.jsx checks both.
 */

/** Distance (CSS px) the track's centre line keeps from an overlay: the 24 px outline's half-width + 1. */
export const OVERLAY_GAP_PX = 13;

/** The corner key (.track-map-key): its distance to the map's top-left corner and its one-line height. */
export const MAP_KEY = Object.freeze({ edge: 6, height: 24 });

/** The compass rose: its side and its distance to the map's edges (CSS px). */
export const COMPASS = Object.freeze({ size: 64, edge: 8 });

/**
 * The places the compass rose may take, in the order of preference: the
 * bottom-right corner (beside the HUD, or above it when the HUD reaches
 * under it), the top-right corner (under the key row), above the HUD on the
 * left, the top-left corner (under the key row).
 */
export const COMPASS_PLACES = Object.freeze(['br', 'tr', 'bl', 'tl']);

/**
 * The car code labels (TrackMap.jsx .car-label): `dx` px right of the dot,
 * at most `width` px wide: three capitals of Inter Bold (the focused car's
 * Black) at --font-size-data (at most 12.5 px; the focused car's at least
 * 12 px). The widest code of the demo races (MAG and HAM in Inter Black)
 * fits (__tests__/trackmap.overlays.test.jsx, real widths).
 */
export const CAR_LABEL = Object.freeze({ dx: 12, width: 32 });

/**
 * How far (CSS px) a car's code label reaches right of the outline's centre
 * line past OVERLAY_GAP_PX: an overlay on the right half of the map (the
 * compass rose there) is kept this much further off the track on its left.
 */
export const CAR_LABEL_REACH_PX = CAR_LABEL.dx + CAR_LABEL.width - OVERLAY_GAP_PX;

/**
 * How far (CSS px) a car's code label reaches right of its dot's centre:
 * the label's dx and its widest.
 */
export const CAR_LABEL_EDGE_PX = CAR_LABEL.dx + CAR_LABEL.width;

/**
 * Whether a car's code label goes on the left of its dot (dx -CAR_LABEL.dx,
 * text-anchor end): when, drawn on the right, it would cross the map's
 * right edge, where the svg clips it. The track keeps only the drawing
 * margin there (28 px in a Pit Wall map at 1536 x 750: a car at Monza's,
 * Shanghai's or Melbourne's rightmost point lost about 6 px of its label);
 * a margin for the whole label would cost the track up to 6 % of its size.
 * On the left the label stays off the key, the HUD and the compass too
 * (__tests__/trackmap.overlays.test.jsx: the three outlines in the four Pit
 * Wall maps at four rotations). A map narrower than two labels: the right.
 *
 * @param {number} x - the car's x in the map (CSS px, at the zoom of the whole track)
 * @param {number} width - the map's width
 * @returns {boolean}
 */
export function carLabelOnLeft(x, width) {
  const W = Number(width) || 0;
  return W > 2 * CAR_LABEL_EDGE_PX && Number.isFinite(x) && x + CAR_LABEL_EDGE_PX > W;
}

/**
 * A HUD table column is kept while the track it leaves is at least this
 * share of the largest track any choice of columns and compass place gives
 * (mapPlan).
 */
export const HUD_KEEP_SHARE = 0.95;

/** The HUD's distance to the map's bottom-left corner; the gap between two cards, and to the compass. */
export const HUD_EDGE_PX = 10;
export const HUD_GAP_PX = 6;

/** The HUD never takes more than this share of the map's height (its rows are capped to it). */
export const HUD_MAX_SHARE = 0.45;

/** Map height (CSS px) from which the HUD is a row of cards; below it, a table. */
export const HUD_CARDS_MIN_H = 440;
/** At most this many cards; more drivers, the table. */
export const HUD_CARDS_MAX = 4;

/** One HUD card (.track-telemetry-hud): width, border, padding, header and row heights (CSS px). */
export const HUD_CARD = Object.freeze({
  width: 148, border: 2, padY: 8, headPx: 24, headGap: 6, rowPx: 18,
});

/**
 * Height (CSS px) of a HUD card: the SPD, THR, BRK, GEAR, (DRS), TYRE rows
 * under the driver header; with the focused card's 2 px border (the others
 * have 1 px: an upper bound).
 *
 * @param {{drs?: boolean}} [opts]
 * @returns {number}
 */
export function hudCardHeight({ drs = true } = {}) {
  const rows = drs ? 6 : 5;
  return 2 * HUD_CARD.border + 2 * HUD_CARD.padY + HUD_CARD.headPx + HUD_CARD.headGap + rows * HUD_CARD.rowPx;
}

/**
 * The HUD table (.track-hud): border, padding, header and row heights, the
 * gap between two columns, and the columns, each as wide as its header
 * (mono, --font-size-label, at most 11.5 px) and its widest value (mono,
 * --font-size-data, at most 12.5 px; the driver code in Inter Bold, the
 * tyre letter in a 16 px badge) at 0.61 em per mono character.
 * Phase 10b B7: the columns in their order of use to a strategist, the
 * driver, the tyre (compound and laps on the set) and the speed always
 * shown, then the gear, the brake, the throttle and DRS as room allows; the
 * columns dropped first when the map is too narrow, or when they cost the
 * track (mapPlan): dropOrder, that order reversed. Before, the tyre was
 * dropped before the brake, and the speed and the throttle stayed: at
 * 1536 x 750 the HUD showed the driver, the speed and the throttle only,
 * and nothing said so. The columns left out are counted in the header
 * ("+k cols", hudColumnsHint) and named in the Layers popover. The three
 * always shown are 11 px wider than the three before: the side padding
 * (6 px before) gives 6 px of it back, so the track keeps 70.6 % of its
 * plain fit at 1536 x 750 and 90.6 % at 2048 x 1100 at the worst
 * (Melbourne 2025 in its default orientation; 68.5 % and 89.8 % with the
 * 6 px padding).
 */
export const HUD_TABLE = Object.freeze({
  border: 1,
  padX: 3,
  padY: 3,
  headPx: 14,
  rowPx: 16,
  gapPx: 5,
  columns: Object.freeze([
    Object.freeze({ id: 'drv', label: '', title: 'Driver', px: 38 }),
    Object.freeze({ id: 'tyre', label: 'TYRE', title: 'Tyre: compound and laps on the set', px: 35 }),
    Object.freeze({ id: 'speed', label: 'KPH', title: 'Speed (km/h)', px: 23 }),
    Object.freeze({ id: 'gear', label: 'GEAR', title: 'Gear', px: 30 }),
    Object.freeze({ id: 'brk', label: 'BRK', title: 'Brake (%)', px: 24 }),
    Object.freeze({ id: 'thr', label: 'THR', title: 'Throttle (%)', px: 24 }),
    Object.freeze({ id: 'drs', label: 'DRS', title: 'DRS: off, available or open', px: 40 }),
  ]),
  dropOrder: Object.freeze(['drs', 'thr', 'brk', 'gear']),
});

/**
 * Width (CSS px) of the HUD table with `columns`.
 *
 * @param {Array<{px: number}>} columns
 * @returns {number}
 */
export function hudTableWidth(columns) {
  const cols = Array.isArray(columns) ? columns : [];
  return 2 * HUD_TABLE.border + 2 * HUD_TABLE.padX
    + cols.reduce((a, c) => a + c.px, 0) + Math.max(0, cols.length - 1) * HUD_TABLE.gapPx;
}

/**
 * Height (CSS px) of the HUD table with `rows` rows under its header.
 *
 * @param {number} rows
 * @returns {number}
 */
export function hudTableHeight(rows) {
  const n = Math.max(0, Math.floor(Number(rows) || 0));
  return 2 * HUD_TABLE.border + 2 * HUD_TABLE.padY + HUD_TABLE.headPx + n * HUD_TABLE.rowPx;
}

/**
 * The HUD table's columns in `room` px: all of them (DRS only in a season
 * with DRS), dropping dropOrder's until the table fits.
 *
 * @param {number} room
 * @param {{drs?: boolean}} [opts]
 * @returns {Array<{id: string, label: string, title: string, px: number}>}
 */
export function hudTableColumns(room, { drs = true } = {}) {
  let cols = HUD_TABLE.columns.filter((c) => drs || c.id !== 'drs');
  for (const id of HUD_TABLE.dropOrder) {
    if (hudTableWidth(cols) <= room) break;
    cols = cols.filter((c) => c.id !== id);
  }
  return cols;
}

/**
 * The column sets the HUD table may take, widest first: `columns`, then
 * one more of dropOrder's dropped at a time (a drop that changes nothing
 * skipped), down to the driver, the tyre and the speed.
 *
 * @param {Array<{id: string, px: number}>} columns
 * @returns {Array<Array<{id: string, px: number}>>}
 */
export function hudColumnSets(columns) {
  let cols = Array.isArray(columns) ? columns.slice() : [];
  const out = [cols];
  for (const id of HUD_TABLE.dropOrder) {
    if (!cols.some((c) => c.id === id)) continue;
    cols = cols.filter((c) => c.id !== id);
    out.push(cols);
  }
  return out;
}

/**
 * The columns the HUD table leaves out (B7): those of HUD_TABLE.columns (DRS
 * only in a season with DRS) not in `shown`, in their order of priority.
 *
 * @param {Array<{id: string}>} shown
 * @param {{drs?: boolean}} [opts]
 * @returns {Array<{id: string, label: string, title: string, px: number}>}
 */
export function hudHiddenColumns(shown, { drs = true } = {}) {
  const ids = new Set((Array.isArray(shown) ? shown : []).map((c) => c.id));
  return HUD_TABLE.columns.filter((c) => (drs || c.id !== 'drs') && !ids.has(c.id));
}

/**
 * The hint of the columns left out, in the header of the driver column:
 * "+k cols" ('' for none). Drawn in Inter Regular at --font-size-label, it
 * runs past the driver column into the left of the tyre column's header,
 * whose label is right-aligned (__tests__/trackmap.hud.test.jsx: it never
 * reaches the label).
 *
 * @param {number} hidden - how many columns are left out
 * @returns {string}
 */
export function hudColumnsHint(hidden) {
  const n = Math.max(0, Math.floor(Number(hidden) || 0));
  return n > 0 ? `+${n} cols` : '';
}

// A rectangle of the map, origin top-left (CSS px)
const rect = (x0, y0, x1, y1) => ({
  x0, y0, x1, y1,
});

/**
 * The telemetry HUD's slot in a map box: the room it is given whatever the
 * number of drivers in it, so the track around it stays put when the
 * selection changes. In a big map (from HUD_CARDS_MIN_H, HUD_CARDS_MAX
 * cards beside the compass rose, a card under HUD_MAX_SHARE of the height)
 * HUD_CARDS_MAX cards; else a table of `columns` (the widest that fits by
 * default) and of the rows HUD_MAX_SHARE of the height allows (two at
 * least: the focus driver and a "+k more" row). `rows` / `columns`: the
 * table drawn in the slot for more drivers than cards. `box`: the slot in
 * the map (CSS px, origin top-left), on its bottom-left corner. null for an
 * unmeasured map.
 *
 * @param {{width: number, height: number}} map
 * @param {{drs?: boolean, columns?: Array}} [opts]
 * @returns {null|{mode: 'cards'|'table', cards: number, rows: number, columns: Array,
 *   box: {x0: number, y0: number, x1: number, y1: number}}}
 */
export function hudSlot(map, { drs = true, columns = null } = {}) {
  const W = Math.max(0, Number(map?.width) || 0);
  const H = Math.max(0, Number(map?.height) || 0);
  if (!W || !H) return null;
  const bottom = H - HUD_EDGE_PX;
  const cardsW = HUD_CARDS_MAX * HUD_CARD.width + (HUD_CARDS_MAX - 1) * HUD_GAP_PX;
  const cardH = hudCardHeight({ drs });
  if (H >= HUD_CARDS_MIN_H
    && HUD_EDGE_PX + cardsW + HUD_GAP_PX + COMPASS.size + COMPASS.edge <= W
    && HUD_EDGE_PX + cardH <= H * HUD_MAX_SHARE) {
    return {
      mode: 'cards',
      cards: HUD_CARDS_MAX,
      rows: Math.max(2, Math.floor((cardH - hudTableHeight(0)) / HUD_TABLE.rowPx)),
      columns: hudTableColumns(cardsW, { drs }),
      box: rect(HUD_EDGE_PX, bottom - cardH, HUD_EDGE_PX + cardsW, bottom),
    };
  }
  const cols = Array.isArray(columns) ? columns : hudTableColumns(W - 2 * HUD_EDGE_PX, { drs });
  const fit = Math.floor((H * HUD_MAX_SHARE - HUD_EDGE_PX - hudTableHeight(0)) / HUD_TABLE.rowPx);
  const rows = Math.max(2, fit);
  return {
    mode: 'table',
    cards: 0,
    rows,
    columns: cols,
    box: rect(HUD_EDGE_PX, bottom - hudTableHeight(rows), HUD_EDGE_PX + hudTableWidth(cols), bottom),
  };
}

/**
 * The HUD drawn in its slot for `n` drivers (the focus driver first, then
 * the selected ones): a card each while the slot holds cards and n is at
 * most its cards, else the slot's table, a row each, the drivers past its
 * rows counted on a last "+k more" row (B7: named in the Layers popover; the
 * names cut that row to an ellipsis). Anchored at the slot's bottom-left;
 * `box`: the drawn rectangle, inside the slot. null for no driver.
 *
 * @param {ReturnType<typeof hudSlot>} slot
 * @param {number} n
 * @returns {null|{mode: 'cards'|'table', shown: number, more: number, rows: number,
 *   columns: Array|null, box: {x0: number, y0: number, x1: number, y1: number}}}
 */
export function hudTable(slot, n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!slot || !count) return null;
  const { x0, y1 } = slot.box;
  if (slot.mode === 'cards' && count <= slot.cards) {
    return {
      mode: 'cards', shown: count, more: 0, rows: count, columns: null,
      box: rect(x0, slot.box.y0, x0 + count * HUD_CARD.width + (count - 1) * HUD_GAP_PX, y1),
    };
  }
  const rows = Math.min(count, slot.rows);
  const shown = count > rows ? rows - 1 : count;
  return {
    mode: 'table',
    shown,
    more: count - shown,
    rows,
    columns: slot.columns,
    box: rect(x0, y1 - hudTableHeight(rows), x0 + hudTableWidth(slot.columns), y1),
  };
}

/**
 * The HUD for `n` drivers in a map box's default slot (every column that
 * fits): hudTable(hudSlot(map), n).
 *
 * @param {{width: number, height: number}} map
 * @param {number} n
 * @param {{drs?: boolean}} [opts]
 * @returns {ReturnType<typeof hudTable>}
 */
export function hudLayout(map, n, { drs = true } = {}) {
  return hudTable(hudSlot(map, { drs }), n);
}

/**
 * The corner key's rectangle in the map: `width` px wide (as measured; 0:
 * the whole line it may take, the key row the track is fitted under,
 * whatever the key lists), one line high.
 *
 * @param {{width: number}} map
 * @param {number} [width]
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 */
export function mapKeyBox(map, width = 0) {
  const room = Math.max(0, (Number(map?.width) || 0) - 2 * MAP_KEY.edge);
  const w = Number(width) > 0 ? Math.min(Number(width), room) : room;
  return rect(MAP_KEY.edge, MAP_KEY.edge, MAP_KEY.edge + w, MAP_KEY.edge + MAP_KEY.height);
}

const overlaps = (a, b) => !!a && !!b && a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * The compass rose's rectangle at `place` (COMPASS_PLACES) in a map with
 * the key row `key` and the HUD slot box `hud` (either may be null): 'br'
 * the bottom-right corner, raised above the HUD when the HUD reaches under
 * it; 'tr' / 'tl' under the key row (the map's top edge without it); 'bl'
 * above the HUD on the left. null when it leaves the map or meets the key
 * or the HUD there.
 *
 * @param {{width: number, height: number}} map
 * @param {'br'|'tr'|'bl'|'tl'} place
 * @param {{key?: object|null, hud?: object|null}} [overlays]
 * @returns {null|{x0: number, y0: number, x1: number, y1: number}}
 */
export function compassAt(map, place, { key = null, hud = null } = {}) {
  const W = Math.max(0, Number(map?.width) || 0);
  const H = Math.max(0, Number(map?.height) || 0);
  const S = COMPASS.size;
  const E = COMPASS.edge;
  const right = W - E - S;
  const top = key ? key.y1 + HUD_GAP_PX : E;
  let y0;
  let x0;
  if (place === 'br') {
    x0 = right;
    y0 = H - E - S;
    if (hud && hud.x1 + HUD_GAP_PX > x0) y0 = hud.y0 - HUD_GAP_PX - S;
  } else if (place === 'tr') {
    x0 = right;
    y0 = top;
  } else if (place === 'tl') {
    x0 = E;
    y0 = top;
  } else if (place === 'bl') {
    if (!hud) return null; // without a HUD: the bottom-right corner
    x0 = E;
    y0 = hud.y0 - HUD_GAP_PX - S;
  } else {
    return null;
  }
  const box = rect(x0, y0, x0 + S, y0 + S);
  if (box.x0 < 0 || box.y0 < 0 || box.x1 > W || box.y1 > H) return null;
  // HUD_GAP_PX at least from the key and the HUD
  const g = HUD_GAP_PX - 1e-9;
  if (key && overlaps(box, rect(key.x0 - g, key.y0 - g, key.x1 + g, key.y1 + g))) return null;
  if (hud && overlaps(box, rect(hud.x0 - g, hud.y0 - g, hud.x1 + g, hud.y1 + g))) return null;
  return box;
}

/**
 * CSS offsets that put a box at its place in the map: from the edges it is
 * nearer to (right / bottom for a box on the right / bottom half).
 *
 * @param {{width: number, height: number}} map
 * @param {{x0: number, y0: number, x1: number, y1: number}} box
 * @returns {{left?: number, right?: number, top?: number, bottom?: number}}
 */
export function boxOffsets(map, box) {
  const W = Math.max(0, Number(map?.width) || 0);
  const H = Math.max(0, Number(map?.height) || 0);
  const out = {};
  if (box.x0 + box.x1 > W) out.right = W - box.x1; else out.left = box.x0;
  if (box.y0 + box.y1 > H) out.bottom = H - box.y1; else out.top = box.y0;
  return out;
}

/**
 * The outline as the map draws it: rotated by `deg` (the circuit's
 * rotation plus the user's) about its centroid, each point's other fields
 * kept; with the rotation, to place the cars and the corners the same way.
 *
 * @param {Array<{X: number, Y: number}>} points
 * @param {number} deg
 * @returns {{points: Array<{X: number, Y: number}>, cx: number, cy: number, cosR: number, sinR: number}}
 */
export function rotateOutline(points, deg) {
  const raw = Array.isArray(points) ? points : [];
  const rad = ((Number(deg) || 0) * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const n = raw.length || 1;
  const cx = raw.reduce((s, d) => s + d.X, 0) / n;
  const cy = raw.reduce((s, d) => s + d.Y, 0) / n;
  return {
    points: raw.map((d) => {
      const dx = d.X - cx;
      const dy = d.Y - cy;
      return { ...d, X: cx + dx * cosR - dy * sinR, Y: cy + dx * sinR + dy * cosR };
    }),
    cx,
    cy,
    cosR,
    sinR,
  };
}

/**
 * The map's furniture and the track fitted clear of it, for a map box and
 * the outline as drawn: the same whoever is selected or focused, whatever
 * the key lists (the selection, the channel overlay and the layers never
 * move the track; a new box, rotation, circuit or season may).
 *  - key: the key row (mapKeyBox at its full line) when `key`;
 *  - hud: the HUD's slot (hudSlot);
 *  - compass: { place, box } (compassAt);
 *  - list: the three rectangles as drawn; obstacles: as fitted (the
 *    compass on the right half widened by CAR_LABEL_REACH_PX on its left);
 *  - fit: fitTrack's result.
 * Chosen: for every compass place and every HUD table column set
 * (hudColumnSets; the cards slot has one), the track fitted clear of them;
 * of the choices whose track is HUD_KEEP_SHARE of the largest or more, the
 * one with the most columns, then the larger track, then the earlier place.
 * A map too small for its furniture: the narrowest table, the first place
 * that fits, the plain fit flagged (fit.clear false).
 *
 * @param {Array<{X: number, Y: number}>} points - the outline as drawn (rotateOutline), data units, Y up
 * @param {{width: number, height: number}} map
 * @param {{padding?: number, drs?: boolean, key?: boolean}} [opts]
 * @returns {null|{key: object|null, hud: object, compass: {place: string, box: object},
 *   list: Array, obstacles: Array, fit: ReturnType<typeof fitTrack>}}
 */
export function mapPlan(points, map, { padding = 0, drs = true, key = false } = {}) {
  const W = Math.max(0, Number(map?.width) || 0);
  const H = Math.max(0, Number(map?.height) || 0);
  if (!W || !H) return null;
  const box = { width: W, height: H };
  const keyRow = key ? mapKeyBox(box) : null;
  const widest = hudSlot(box, { drs });
  const sets = widest.mode === 'cards' ? [null] : hudColumnSets(widest.columns);
  const plans = new Map();
  const planOf = (si, place) => {
    const id = `${si}|${place}`;
    if (plans.has(id)) return plans.get(id);
    const hud = sets[si] ? hudSlot(box, { drs, columns: sets[si] }) : widest;
    const at = compassAt(box, place, { key: keyRow, hud: hud.box });
    let plan = null;
    if (at) {
      const reach = at.x0 + at.x1 > W ? CAR_LABEL_REACH_PX : 0;
      const obstacles = [keyRow, hud.box, rect(at.x0 - reach, at.y0, at.x1, at.y1)].filter(Boolean);
      plan = {
        key: keyRow,
        hud,
        compass: { place, box: at },
        list: [keyRow, hud.box, at].filter(Boolean),
        obstacles,
        fit: fitTrack(points, box, { padding, obstacles }),
      };
    }
    plans.set(id, plan);
    return plan;
  };
  // the largest track: the narrowest HUD at each place (fewer columns never
  // make it smaller); a place too small there is too small for any columns
  const last = sets.length - 1;
  const narrow = COMPASS_PLACES.map((p) => planOf(last, p)).filter(Boolean);
  const clear = narrow.filter((p) => p.fit.clear);
  if (!clear.length) {
    if (narrow.length) return narrow[0];
    // no place fits the compass: the bottom-right corner over whatever is there
    const hud = sets[last] ? hudSlot(box, { drs, columns: sets[last] }) : widest;
    const at = rect(W - COMPASS.edge - COMPASS.size, H - COMPASS.edge - COMPASS.size, W - COMPASS.edge, H - COMPASS.edge);
    const obstacles = [keyRow, hud.box, at].filter(Boolean);
    return {
      key: keyRow, hud, compass: { place: 'br', box: at }, list: obstacles, obstacles, fit: fitTrack(points, box, { padding, obstacles }),
    };
  }
  const best = Math.max(...clear.map((p) => p.fit.scale));
  const floor = HUD_KEEP_SHARE * best;
  const places = COMPASS_PLACES.filter((p) => {
    const q = planOf(last, p);
    return q && q.fit.clear && q.fit.scale >= floor;
  });
  for (let si = 0; si <= last; si += 1) {
    let pick = null;
    for (const p of places) {
      const q = planOf(si, p);
      if (!q || !q.fit.clear || q.fit.scale < floor) continue;
      // a larger track by more than half a percent; else the earlier place
      if (!pick || q.fit.scale > pick.fit.scale * 1.005) pick = q;
    }
    if (pick) return pick;
  }
  return clear[0];
}

// Placements tried along each axis at one scale
const FIT_STEPS = 24;

// Up to FIT_STEPS + 1 positions from a to b, and c (the centred one) when inside
function positions(a, b, c) {
  if (!(b > a + 0.5)) return [Math.max(a, Math.min(b, c))];
  const n = Math.min(FIT_STEPS, Math.ceil((b - a) / 2));
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(a + ((b - a) * i) / n);
  if (c > a && c < b) out.push(c);
  return out;
}

/**
 * Scale and place the track in a map box, clear of the overlays: the
 * largest scale (up to the plain fit within `padding` of the edges) at
 * which some placement keeps every point of the outline `gap` px or more
 * off every rectangle of `obstacles`; of those placements, the one nearest
 * the centre of the box. Found by bisection between the plain fit and the
 * "bands" fit (each overlay given the whole band along the edge it sits on,
 * or the whole column, whichever keeps the larger track: always clear);
 * each scale is tried at a grid of placements (FIT_STEPS per axis), from
 * the centre out. When nothing is clear (a map too small for its
 * overlays): the plain fit, centred, clear: false.
 *
 * @param {Array<{X: number, Y: number}>} points - the outline, data units, Y up
 * @param {{width: number, height: number}} box
 * @param {{padding?: number, obstacles?: Array<{x0: number, y0: number, x1: number, y1: number}>,
 *   gap?: number}} [opts]
 * @returns {{scale: number, left: number, top: number, width: number, height: number, clear: boolean}}
 *   px per data unit, and the track's bounding box in the map (CSS px)
 */
export function fitTrack(points, box, { padding = 0, obstacles = [], gap = OVERLAY_GAP_PX } = {}) {
  const W = Math.max(0, Number(box?.width) || 0);
  const H = Math.max(0, Number(box?.height) || 0);
  const pts = (Array.isArray(points) ? points : [])
    .filter((d) => d && Number.isFinite(d.X) && Number.isFinite(d.Y));
  if (!pts.length || !W || !H) {
    return {
      scale: 1, left: 0, top: 0, width: 0, height: 0, clear: true,
    };
  }
  let xmin = Infinity; let xmax = -Infinity; let ymin = Infinity; let ymax = -Infinity;
  for (const d of pts) {
    if (d.X < xmin) xmin = d.X;
    if (d.X > xmax) xmax = d.X;
    if (d.Y < ymin) ymin = d.Y;
    if (d.Y > ymax) ymax = d.Y;
  }
  const tw = xmax - xmin || 1;
  const th = ymax - ymin || 1;
  const p = Math.max(0, Number(padding) || 0);
  const sMax = Math.max(1e-6, Math.min((W - 2 * p) / tw, (H - 2 * p) / th));
  const centred = (s) => ({ left: (W - tw * s) / 2, top: (H - th * s) / 2 });
  const result = (s, at, clear) => ({
    scale: s, left: at.left, top: at.top, width: tw * s, height: th * s, clear,
  });
  const g = Math.max(0, Number(gap) || 0);
  const rects = (Array.isArray(obstacles) ? obstacles : [])
    .filter((r) => r && [r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) && r.x1 > r.x0 && r.y1 > r.y0)
    .map((r) => ({
      x0: r.x0 - g, y0: r.y0 - g, x1: r.x1 + g, y1: r.y1 + g,
    }))
    .filter((r) => r.x1 > 0 && r.y1 > 0 && r.x0 < W && r.y0 < H);
  if (!rects.length) return result(sMax, centred(sMax), true);

  // The points from the track's top-left corner (screen y down), visited in
  // a strided order: a placement that hits an overlay is rejected early
  const n = pts.length;
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  const stride = Math.max(1, Math.floor(Math.sqrt(n)));
  let k = 0;
  for (let s0 = 0; s0 < stride; s0 += 1) {
    for (let i = s0; i < n; i += stride) {
      u[k] = pts[i].X - xmin;
      v[k] = ymax - pts[i].Y;
      k += 1;
    }
  }
  const hits = (s, left, top) => {
    for (let i = 0; i < n; i += 1) {
      const x = left + u[i] * s;
      const y = top + v[i] * s;
      for (const r of rects) {
        if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
      }
    }
    return false;
  };
  const place = (s) => {
    const c = centred(s);
    const ls = positions(p, W - p - tw * s, c.left);
    const ts = positions(p, H - p - th * s, c.top);
    const cands = [];
    for (const l of ls) for (const t of ts) cands.push([l, t, (l - c.left) ** 2 + (t - c.top) ** 2]);
    cands.sort((a, b) => a[2] - b[2]);
    for (const [l, t] of cands) if (!hits(s, l, t)) return { left: l, top: t };
    return null;
  };

  const first = place(sMax);
  if (first) return result(sMax, first, true);

  // The bands fit: always clear, the lower end of the bisection
  let lo = 0;
  let loAt = null;
  for (let mask = 0; mask < (1 << rects.length); mask += 1) {
    let t = p; let r = p; let b = p; let l = p;
    rects.forEach((o, i) => {
      if (mask & (1 << i)) {
        if ((o.x0 + o.x1) / 2 < W / 2) l = Math.max(l, o.x1); else r = Math.max(r, W - o.x0);
      } else if ((o.y0 + o.y1) / 2 < H / 2) t = Math.max(t, o.y1); else b = Math.max(b, H - o.y0);
    });
    const s = Math.min((W - l - r) / tw, (H - t - b) / th);
    if (s > lo) {
      lo = s;
      loAt = { left: l + (W - l - r - tw * s) / 2, top: t + (H - t - b - th * s) / 2 };
    }
  }
  let hi = sMax;
  for (let i = 0; i < 14 && hi - lo > sMax * 0.004; i += 1) {
    const mid = (lo + hi) / 2;
    const at = place(mid);
    if (at) {
      lo = mid;
      loAt = at;
    } else {
      hi = mid;
    }
  }
  if (loAt && lo > 0) return result(lo, loAt, true);
  return result(sMax, centred(sMax), false);
}
