/**
 * View model of the Circle of Doom's gap list (components/visualizations/
 * CircleGapList.jsx): a row of utils/circleGapList.js gapRows as printed, its
 * width, the rule that fits it in its room, and its title.
 *
 * A row: the driver code, the gap to the reference (toRef: '+4.8' behind it,
 * '−2.1' ahead, '1L' across laps, 'ref' on the reference's own row, '—'
 * without a gap), the gap to the row above (toPrev) and the trend glyph of the
 * gap to the reference (↑ closing, ↓ opening, ↔ stable: the focus card's
 * arrows, FocusDriverWidget.jsx). A car in the middle of its stop prints
 * 'PIT 14' (whole seconds since its pit entry) or 'OUT' instead of numbers.
 * A row whose measured text is wider than its room drops toPrev and the glyph
 * (fitParts).
 *
 * Pure module: no React, no D3, no store access.
 */
import { CHAR_EM } from '../circleLabelLayout';
import { laneSecondsAt, TREND_LAPS } from '../circleGapList';

const MINUS = '−';
/** Height of a row of the list beside the plot, px (.cod-gaps__row). */
export const GAP_ROW_PX = 15;
/** Columns of the grid that takes the place of the legend under the plot. */
export const GRID_COLS = 3;
/** The focus card's arrows (FocusDriverWidget.jsx TREND_ARROWS). */
export const TREND_GLYPHS = Object.freeze({ closing: '↑', opening: '↓', stable: '↔' });
/** Weights the parts are drawn at (.cod-gaps__code, the numbers). */
export const CODE_WEIGHT = 700;
export const NUMBER_WEIGHT = 600;
/** px between the parts of a row (and between grid cells), and a row's padding, both sides (.cod-gaps). */
export const PART_GAP_PX = 4;
export const ROW_PAD_PX = 4;

function fmt1(s) {
  return Number(s).toFixed(1);
}

/** Lap tag: 1 -> '1L' (one lap down), -1 -> '−1L' (one lap up). */
function lapTag(k) {
  return k > 0 ? `${k}L` : `${MINUS}${-k}L`;
}

/**
 * A gap as printed: '+4.8' behind, '−2.1' ahead, the lap tag across laps,
 * '—' without one.
 *
 * @param {number|null} seconds
 * @param {number|null} laps - lapOffset of the gap
 * @returns {string}
 */
export function gapText(seconds, laps) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  if (laps) return lapTag(laps);
  if (Math.abs(seconds) < 0.05) return '0.0';
  return seconds > 0 ? `+${fmt1(seconds)}` : `${MINUS}${fmt1(-seconds)}`;
}

/** 'PIT 14' / 'PIT' / 'OUT' of a stopping row at the clock, else null. */
function stopText(row, now) {
  if (row.status === 'out') return 'OUT';
  if (row.status !== 'lane') return null;
  const secs = laneSecondsAt(row.pitInTime, now);
  return secs == null ? 'PIT' : `PIT ${secs}`;
}

/**
 * The parts of a row as printed (module header); empty strings for the parts
 * it has not.
 *
 * @param {Object} row - a gapRows row
 * @param {string|null} reference - the reference driver
 * @param {number} now - session seconds (the lane seconds)
 * @returns {{code: string, ref: string, prev: string, glyph: string}}
 */
export function rowParts(row, reference, now) {
  const stop = stopText(row, now);
  if (stop) {
    return {
      code: row.driver, ref: stop, prev: '', glyph: '',
    };
  }
  const isRef = row.driver === reference;
  return {
    code: row.driver,
    ref: isRef ? 'ref' : gapText(row.toRef, row.toRefLaps),
    prev: row.toPrev == null ? '' : gapText(row.toPrev, row.toPrevLaps),
    glyph: isRef ? '' : TREND_GLYPHS[row.trend] || '',
  };
}

/**
 * Width of a row's parts as drawn, px: measure(text, size, weight), else
 * CHAR_EM a character; the gaps between the parts and the row's padding.
 */
export function partsWidth(parts, measure, px) {
  const shown = [[parts.code, CODE_WEIGHT], [parts.ref, NUMBER_WEIGHT], [parts.prev, NUMBER_WEIGHT],
    [parts.glyph, NUMBER_WEIGHT]].filter(([t]) => t);
  const w = (t, weight) => (measure ? measure(t, px, weight) : t.length * px * CHAR_EM);
  return shown.reduce((sum, [t, weight]) => sum + w(t, weight), 0)
    + PART_GAP_PX * Math.max(0, shown.length - 1) + ROW_PAD_PX;
}

/** The parts that fit `width` px: all of them, else without toPrev and the trend glyph. */
export function fitParts(parts, width, measure, px) {
  if (partsWidth(parts, measure, px) <= width) return parts;
  return { ...parts, prev: '', glyph: '' };
}

/** Width of a cell of the grid in a slot `width` px wide. */
export function gridCellWidth(width) {
  return (width - (GRID_COLS - 1) * PART_GAP_PX) / GRID_COLS;
}

/** Trend for a title: 'closing 0.5 s over 3 laps', or why there is none. */
function trendText(row) {
  if (!row.trend) {
    return `no trend (a pit lap or a lap not green among the last ${TREND_LAPS + 1}, or fewer laps in common)`;
  }
  return `${row.trend} ${fmt1(Math.abs(row.trendDelta))} s over ${TREND_LAPS} laps`;
}

/** What a printed gap is: 'the gap at the line of lap 15, the latest lap both completed'. */
function gapDefinition(atLap) {
  return atLap != null ? `the gap at the line of lap ${atLap}, the latest lap both completed` : 'no lap completed by both yet';
}

/**
 * Title of a row: what each of its numbers is, e.g. 'SAI +4.8 s to LEC: the
 * gap at the line of lap 15, the latest lap both completed; closing 0.5 s
 * over 3 laps · −2.1 s to PIA (the row above), the gap at the line of lap 15,
 * the latest lap both completed'.
 *
 * @param {Object} row - a gapRows row
 * @param {{reference: string|null, focus: string|null, prev: string|null, now: number}} ctx
 * @returns {string}
 */
export function rowTitle(row, {
  reference, focus, prev, now,
}) {
  const stop = stopText(row, now);
  if (stop) {
    const secs = laneSecondsAt(row.pitInTime, now);
    const where = row.status === 'lane'
      ? `in the pit lane${secs != null ? `, ${secs} s since its pit entry` : ''}`
      : 'on its out-lap from the pit exit';
    return `${row.driver} ${where}: no gap until its stop is over (the latest lap both completed does not hold the stop yet)`;
  }
  const parts = [];
  const unit = (laps) => (laps ? '' : ' s');
  if (row.driver === reference) {
    parts.push(`${row.driver}: the reference of the gaps (${row.driver === focus ? 'the focus car' : 'the first selected car in race order'})`);
  } else if (row.toRef == null) {
    parts.push(`${row.driver}: no gap to ${reference} (${reference} is stopping, or no lap completed by both yet)`);
  } else {
    parts.push(`${row.driver} ${gapText(row.toRef, row.toRefLaps)}${unit(row.toRefLaps)} to ${reference}: `
      + `${gapDefinition(row.toRefAtLap)}; ${trendText(row)}`);
  }
  if (prev && row.toPrev != null) {
    parts.push(`${gapText(row.toPrev, row.toPrevLaps)}${unit(row.toPrevLaps)} to ${prev} (the row above), `
      + `${gapDefinition(row.toPrevAtLap)}`);
  }
  return parts.join(' · ');
}
