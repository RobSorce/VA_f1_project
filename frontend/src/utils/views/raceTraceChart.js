/**
 * View model of the Race Trace (components/visualizations/RaceTrace.jsx):
 * the fit modes of the pane, the legend rows, the provenance line, the
 * pit-loss label, the end-label placement and the band patterns. The trace
 * itself is utils/raceTrace.js.
 *
 * Kept out of the component module on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component.
 *
 * Pure module: no React, no D3 import, no store access (the D3 selection of
 * the patterns is passed in).
 */
import {
  FLAG_COLORS, TEXT_COLORS, TYRE_COLORS, TYRE_LABELS, SURFACES, CONTEXT_MIX_LINES,
  withAlpha, markColor, contextColor, getDriverColor, getDriverDash,
} from '../colors';
import { TOP_WINDOW_CARS, FOCUS_WINDOW } from '../raceTrace';

/**
 * Fit floors of the pane (CSS px of the view's content box): from FULL up
 * the end labels are drawn and the legend has every row; under FULL the
 * labels show on hover only and the legend keeps its short rows; under
 * ANSWER only the answer line is drawn (no chart).
 */
export const RACE_TRACE_FIT = Object.freeze({
  full: Object.freeze({ width: 420, height: 200 }),
  answer: Object.freeze({ width: 300, height: 150 }),
});

/**
 * Fit mode of a pane size: 'full', 'compact' (under 420 x 200: labels on
 * hover, short legend) or 'answer' (under 300 x 150: the answer line only).
 * An unmeasured box (0 x 0) is 'full' (tests, server render).
 *
 * @param {{width: number, height: number}} box
 * @returns {'full'|'compact'|'answer'}
 */
export function raceTraceMode(box) {
  const w = Number(box?.width) || 0;
  const h = Number(box?.height) || 0;
  if (w <= 0 && h <= 0) return 'full';
  if (w < RACE_TRACE_FIT.answer.width || h < RACE_TRACE_FIT.answer.height) return 'answer';
  if (w < RACE_TRACE_FIT.full.width || h < RACE_TRACE_FIT.full.height) return 'compact';
  return 'full';
}

/** Stroke widths of the trace lines (px): the focus, a selected or hovered car, the others. */
export const LINE_WIDTHS = Object.freeze({ focus: 3, selected: 2, other: 1 });

/**
 * How a driver's line is drawn: team colour (teammate tint, markColor >= 3:1),
 * the second car of a team dashed (getDriverDash); 3 px for the focus, 2 px
 * for a selected or hovered car, 1 px for the others, which turn to context
 * (contextColor, >= 2:1 on the panel) while any car is emphasised.
 *
 * @param {string} driver
 * @param {{focus?: string|null, selected?: string[], highlighted?: string|null}} state
 * @returns {{stroke: string, width: number, dash: string|null, context: boolean, rank: number}}
 *   rank: drawing order (0 context, 1 plain, 2 selected / hovered, 3 focus)
 */
export function traceLineStyle(driver, { focus = null, selected = [], highlighted = null } = {}) {
  const color = markColor(getDriverColor(driver));
  const dash = getDriverDash(driver);
  if (driver === focus) return { stroke: color, width: LINE_WIDTHS.focus, dash, context: false, rank: 3 };
  if (selected.includes(driver) || driver === highlighted) {
    return { stroke: color, width: LINE_WIDTHS.selected, dash, context: false, rank: 2 };
  }
  const emphasis = !!(focus || selected.length || highlighted);
  return {
    stroke: emphasis ? contextColor(color, SURFACES.panel, { mix: CONTEXT_MIX_LINES }) : color,
    width: LINE_WIDTHS.other,
    dash,
    context: emphasis,
    rank: emphasis ? 0 : 1,
  };
}

/** Hatch of an SC band, dots of a VSC band, tint of a red flag (V1: never hue alone). */
export const BAND_STYLE = Object.freeze({
  // the hatch lines and dots at `ink` alpha: a band behind the lines, not over them
  SC: Object.freeze({ color: FLAG_COLORS.safetyCar, label: 'SC', tint: 0.06, ink: 0.45, spacing: 8, width: 1 }),
  VSC: Object.freeze({ color: FLAG_COLORS.safetyCar, label: 'VSC', tint: 0.04, ink: 0.55, spacing: 6, dot: 1 }),
  RED: Object.freeze({ color: FLAG_COLORS.red, label: 'RED', tint: 0.16 }),
});

/**
 * Append the SC hatch and the VSC dot patterns to `defs` (a D3 selection).
 *
 * @param {Object} defs
 * @param {string} id - id prefix, unique in the document
 * @returns {{SC: string, VSC: string, RED: string}} fill values
 */
export function defineBandPatterns(defs, id) {
  const sc = BAND_STYLE.SC;
  const S = sc.spacing;
  const hatch = defs.append('pattern').attr('id', `${id}-sc`)
    .attr('patternUnits', 'userSpaceOnUse').attr('width', S).attr('height', S);
  hatch.append('rect').attr('width', S).attr('height', S).attr('fill', withAlpha(sc.color, sc.tint));
  for (const [x1, y1, x2, y2] of [[0, S, S, 0], [-1, 1, 1, -1], [S - 1, S + 1, S + 1, S - 1]]) {
    hatch.append('line').attr('x1', x1).attr('y1', y1).attr('x2', x2).attr('y2', y2)
      .attr('stroke', withAlpha(sc.color, sc.ink)).attr('stroke-width', sc.width);
  }
  const vsc = BAND_STYLE.VSC;
  const D = vsc.spacing;
  const dots = defs.append('pattern').attr('id', `${id}-vsc`)
    .attr('patternUnits', 'userSpaceOnUse').attr('width', D).attr('height', D);
  dots.append('rect').attr('width', D).attr('height', D).attr('fill', withAlpha(vsc.color, vsc.tint));
  dots.append('circle').attr('cx', D / 2).attr('cy', D / 2).attr('r', vsc.dot).attr('fill', withAlpha(vsc.color, vsc.ink));
  return {
    SC: `url(#${id}-sc)`,
    VSC: `url(#${id}-vsc)`,
    RED: withAlpha(BAND_STYLE.RED.color, BAND_STYLE.RED.tint),
  };
}

/** The same fills as CSS backgrounds, for the legend swatches. */
export function bandCss(kind) {
  const s = BAND_STYLE[kind];
  if (kind === 'SC') {
    return `repeating-linear-gradient(-45deg, ${withAlpha(s.color, s.ink)} 0 ${s.width}px, ${withAlpha(s.color, s.tint)} ${s.width}px ${s.spacing / Math.SQRT2}px)`;
  }
  if (kind === 'VSC') {
    return `radial-gradient(${withAlpha(s.color, s.ink)} ${s.dot}px, ${withAlpha(s.color, s.tint)} ${s.dot + 0.5}px) 0 0 / ${s.spacing}px ${s.spacing}px`;
  }
  return withAlpha(s.color, s.tint);
}

/**
 * Label of the pit-loss bracket from an estimatePitLoss result:
 * 'measured' (the median of this race's measured green-flag stops) or
 * 'fallback' (no measured stop yet: an assumption); null outside race
 * sessions (no bracket).
 *
 * @param {{median: number|null, n: number, source: string}} est
 * @returns {{loss: number, source: 'measured'|'fallback', text: string}|null}
 */
export function pitLossLabel(est) {
  if (!est || est.source === 'not-applicable' || !Number.isFinite(est.median)) return null;
  if (est.source === 'fallback') {
    return { loss: est.median, source: 'fallback', text: `pit loss ${est.median.toFixed(1)} s, fallback (no measured stop yet)` };
  }
  const stops = `${est.n} stop${est.n === 1 ? '' : 's'}`;
  return { loss: est.median, source: 'measured', text: `pit loss ${est.median.toFixed(1)} s, measured (median of ${stops})` };
}

/** Name of a window mode on the provenance line. */
export function windowText(mode, focusDriver) {
  if (mode === 'focus') {
    return `window: ${focusDriver} ± max(${FOCUS_WINDOW.minS} s, pit loss + ${FOCUS_WINDOW.pitMarginS} s)`;
  }
  if (mode === 'all') return 'window: every car';
  return `window: top ${TOP_WINDOW_CARS} of the lead lap`;
}

export const WET_NOTE = 'wet race: the reference is unreliable while the field changes tyres together';

/**
 * The provenance line: source · as of lap · reference definition and car
 * count (raceTrace.js referenceText) · window · pit loss · wet note.
 *
 * @param {Object} p
 * @param {Object} p.trace - buildRaceTrace result
 * @param {string} p.reference - referenceText(trace)
 * @param {{mode: string}} p.window - traceWindow result
 * @param {Object|null} p.pitLoss - pitLossLabel result
 * @param {boolean} p.wet
 * @returns {string}
 */
export function provenanceLine({
  trace, reference, window, pitLoss, wet,
}) {
  const parts = ['lap end times (Time) of the timing', `as of L${trace?.lastLap || 0}`, reference];
  if (window) parts.push(windowText(window.mode, trace?.focusDriver));
  if (pitLoss) parts.push(pitLoss.text);
  if (wet) parts.push(WET_NOTE);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Legend rows, as drawn: the second car of a team dashed, the focus line
 * thicker, a provisional lap hollow, a stop chip (new compound and letter),
 * a pit visit with the same tyres, the bands present, the one-stop bracket.
 * `compact`: the short rows only (dash, provisional, stop, the bands).
 *
 * @param {Object} p
 * @param {Array<string>} p.bands - band kinds present ('SC', 'VSC', 'RED')
 * @param {boolean} p.compact
 * @param {boolean} p.bracket - the pit-loss bracket is drawn
 * @param {boolean} p.focus - a focus line is drawn
 * @returns {Array<Object>} Legend items
 */
export function raceTraceLegend({
  bands = [], compact = false, bracket = false, focus = false,
}) {
  const items = [];
  if (focus && !compact) items.push({ label: 'focus', color: TEXT_COLORS.secondary, shape: 'line', strokeWidth: 3 });
  items.push({ label: '2nd car of a team', color: TEXT_COLORS.secondary, shape: 'line', dash: '6,3', strokeWidth: 1.5 });
  items.push({ label: 'provisional lap', color: TEXT_COLORS.secondary, shape: 'glyph', glyph: '○' });
  items.push({ label: compact ? 'stop' : 'stop: new tyres', color: TYRE_COLORS.HARD, shape: 'badge', glyph: TYRE_LABELS.HARD });
  if (!compact) items.push({ label: 'pit, same tyres', color: TEXT_COLORS.secondary, shape: 'glyph', glyph: 'P' });
  for (const kind of ['SC', 'VSC', 'RED']) {
    if (!bands.includes(kind)) continue;
    items.push({ label: BAND_STYLE[kind].label, color: BAND_STYLE[kind].color, shape: 'band', fill: bandCss(kind) });
  }
  if (bracket && !compact) items.push({ label: 'one pit stop', color: TEXT_COLORS.secondary, shape: 'glyph', glyph: '⊐' });
  return items;
}

/**
 * End labels of the trace: each wanted at `y` (px), placed in priority order
 * (focus, selected / highlighted, then race order) where it keeps `gap` px
 * from those already placed, nudged by up to one gap; a label with no room is
 * left out. Within [top, bottom].
 *
 * @param {Array<{key: string, y: number, priority: number}>} wanted - lower priority first
 * @param {Object} opts
 * @param {number} opts.gap - px between two labels
 * @param {number} opts.top
 * @param {number} opts.bottom
 * @returns {Map<string, number>} key -> y
 */
export function placeEndLabels(wanted, { gap, top, bottom }) {
  const placed = [];
  const out = new Map();
  const free = (y) => y >= top && y <= bottom && placed.every((p) => Math.abs(p - y) >= gap);
  for (const w of [...wanted].sort((a, b) => a.priority - b.priority)) {
    const y0 = Math.max(top, Math.min(bottom, w.y));
    const tries = [y0];
    for (let d = 1; d <= gap; d += 1) tries.push(y0 - d, y0 + d);
    const y = tries.find(free);
    if (y == null) continue;
    placed.push(y);
    out.set(w.key, y);
  }
  return out;
}

/** '+4.2' / '−4.2' (true minus), one decimal: an end label's gap. */
export function gapText(v) {
  const abs = Math.abs(v).toFixed(1);
  if (Number(abs) === 0) return '0.0';
  return v > 0 ? `+${abs}` : `−${abs}`;
}
