/**
 * The marks the strategy views (Race Prediction, Strategy Simulator, Strategy
 * Analysis, Undercut Calculator, Sector Delta, PCA analysis, Race Control)
 * draw for a meaning: each is a colour of utils/colors.js
 * (no colour is defined here) plus the glyph or word that carries the same
 * meaning without colour (V1: no colour-only encoding, no red / green pair).
 *
 *  - gain / loss, faster / slower, ahead / behind: colors.js DIVERGING
 *    (better blue, worse orange) with ▲ / ▼ or the sign of the value;
 *  - severity (risks, alerts, insights): high / medium / low with !! / ! / i;
 *  - Monte Carlo levels (battle badges): two / one / no badge with ●● / ● / ○;
 *  - the podium highlight of a P label (P1-P3) is the P label itself.
 *
 * Pure constants and functions; no React.
 */
import {
  DIVERGING, STATUS_COLORS, TEXT_COLORS, UI_COLORS, GRID_COLORS, SURFACES, CHART_SURFACE,
  FLAG_COLORS, tintedChip,
} from '../colors';

export const UP = '▲';
export const DOWN = '▼';
export const MINUS = '−';

/** Colour and glyph of a change in places: + = places gained. */
export function placesMark(change) {
  if (!Number.isFinite(change) || change === 0) {
    return { color: DIVERGING.neutral, glyph: '•', word: 'no change' };
  }
  return change > 0
    ? { color: DIVERGING.better, glyph: UP, word: 'gains' }
    : { color: DIVERGING.worse, glyph: DOWN, word: 'loses' };
}

/**
 * Colour and glyph of a what-if verdict sign (+1 gained, -1 lost, 0 no clear
 * change), the same scheme as places.
 */
export function verdictMark(sign) {
  return placesMark(sign > 0 ? 1 : sign < 0 ? -1 : 0);
}

/**
 * Colour of a time delta where lower is better (focus minus reference, gap
 * behind): better (blue) when negative, worse (orange) when positive.
 */
export function timeDeltaColor(v) {
  if (!Number.isFinite(v) || v === 0) return DIVERGING.neutral;
  return v < 0 ? DIVERGING.better : DIVERGING.worse;
}

/** Colour of a gap where higher is better (focus ahead = +). */
export function gapColor(v) {
  if (!Number.isFinite(v) || v === 0) return DIVERGING.neutral;
  return v > 0 ? DIVERGING.better : DIVERGING.worse;
}

/** Severity of a risk / alert / insight: colour, glyph and word. */
export const SEVERITY = Object.freeze({
  high: Object.freeze({ color: DIVERGING.worse, glyph: '!!', word: 'high' }),
  medium: Object.freeze({ color: STATUS_COLORS.slower, glyph: '!', word: 'medium' }),
  low: Object.freeze({ color: TEXT_COLORS.secondary, glyph: 'i', word: 'low' }),
});
/** Severity of a key, 'notable' / 'info' (insightsGenerator) mapped to medium / low. */
export function severityOf(key) {
  if (key === 'high') return SEVERITY.high;
  if (key === 'medium' || key === 'notable') return SEVERITY.medium;
  return SEVERITY.low;
}

/** Monte Carlo badge level of a battle (0, 1, 2): colour and glyph. */
export function levelMark(level) {
  if (level >= 2) return { color: TEXT_COLORS.primary, glyph: '●●', word: 'two badges' };
  if (level === 1) return { color: STATUS_COLORS.slower, glyph: '●', word: 'one badge' };
  return { color: TEXT_COLORS.muted, glyph: '○', word: 'no badge' };
}

/** Emphasis of a P label in the podium places (the same statement as the gold "pod" figure). */
export const PODIUM_COLOR = STATUS_COLORS.slower;

/** Colours of the D3 strategy charts, from the palette. */
export const CHART_COLORS = Object.freeze({
  text: TEXT_COLORS.primary,
  secondary: TEXT_COLORS.secondary,
  muted: TEXT_COLORS.muted,
  grid: GRID_COLORS.grid,
  axis: GRID_COLORS.axis,
  rule: GRID_COLORS.rule,
  better: DIVERGING.better,
  worse: DIVERGING.worse,
  neutral: DIVERGING.neutral,
  surface: CHART_SURFACE,
  page: SURFACES.page,
  accent: UI_COLORS.brush,
  predicted: UI_COLORS.predicted,
});

/** A chip tinted with a colour, its text lifted to 4.5:1 on the tint (colors.js tintedChip). */
export function chipStyle(color, alpha = 0.15) {
  const t = tintedChip(color, alpha);
  return { background: t.background, color: t.color, border: `1px solid ${t.borderColor}` };
}

export { FLAG_COLORS };
