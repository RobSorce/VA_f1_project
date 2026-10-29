import { describe, it, expect } from 'vitest';
import {
  gapText, rowParts, partsWidth, fitParts, rowTitle, gridCellWidth, GRID_COLS, PART_GAP_PX, ROW_PAD_PX,
} from '../views/circleGapRows.js';

const MINUS = '−';
const row = (o) => ({
  driver: 'SAI',
  position: 4,
  toRef: 4.83,
  toRefLaps: 0,
  toRefAtLap: 15,
  toPrev: -2.1,
  toPrevLaps: 0,
  toPrevAtLap: 15,
  status: null,
  laneSeconds: null,
  pitInTime: null,
  trend: 'closing',
  trendDelta: -0.52,
  ...o,
});

describe('gapText', () => {
  it("one decimal, + behind, − ahead; the lap tag across laps; '—' without a gap", () => {
    expect(gapText(4.83, 0)).toBe('+4.8');
    expect(gapText(-2.14, 0)).toBe(`${MINUS}2.1`);
    expect(gapText(0.02, 0)).toBe('0.0');
    expect(gapText(95, 1)).toBe('1L');
    expect(gapText(-95, -1)).toBe(`${MINUS}1L`);
    expect(gapText(null, null)).toBe('—');
  });
});

describe('rowParts', () => {
  it('code, gap to the reference, gap to the row above, the trend glyph (the focus card arrows)', () => {
    expect(rowParts(row(), 'LEC', 0)).toEqual({
      code: 'SAI', ref: '+4.8', prev: `${MINUS}2.1`, glyph: '↑',
    });
    expect(rowParts(row({ trend: 'opening' }), 'LEC', 0).glyph).toBe('↓');
    expect(rowParts(row({ trend: 'stable' }), 'LEC', 0).glyph).toBe('↔');
    expect(rowParts(row({ trend: null }), 'LEC', 0).glyph).toBe('');
  });

  it("the reference reads 'ref' (no trend); a stopping car 'PIT 14' or 'OUT' instead of numbers", () => {
    expect(rowParts(row({ driver: 'LEC', toRef: 0 }), 'LEC', 0)).toEqual({
      code: 'LEC', ref: 'ref', prev: `${MINUS}2.1`, glyph: '',
    });
    const lane = row({
      status: 'lane', pitInTime: 100, toRef: null, toPrev: null, trend: null,
    });
    expect(rowParts(lane, 'LEC', 114.6)).toEqual({
      code: 'SAI', ref: 'PIT 14', prev: '', glyph: '',
    });
    expect(rowParts({ ...lane, pitInTime: null }, 'LEC', 114.6).ref).toBe('PIT');
    expect(rowParts({ ...lane, status: 'out' }, 'LEC', 114.6).ref).toBe('OUT');
  });
});

describe('fitParts', () => {
  // 1 px a character at size 1
  const measure = (t, size) => t.length * size;
  it('all the parts when they fit, else without toPrev and the glyph', () => {
    const parts = rowParts(row(), 'LEC', 0); // SAI +4.8 −2.1 ↑: 3 + 4 + 4 + 1 characters
    expect(partsWidth(parts, measure, 10)).toBe(120 + 3 * PART_GAP_PX + ROW_PAD_PX);
    expect(fitParts(parts, 200, measure, 10)).toEqual(parts);
    expect(fitParts(parts, 100, measure, 10)).toEqual({ ...parts, prev: '', glyph: '' });
  });

  it('a grid cell: the slot less the column gaps, over the columns', () => {
    expect(gridCellWidth(371)).toBeCloseTo((371 - (GRID_COLS - 1) * PART_GAP_PX) / GRID_COLS, 12);
  });
});

describe('rowTitle', () => {
  it('states what each number is and on which lap it was read', () => {
    expect(rowTitle(row(), {
      reference: 'LEC', focus: 'LEC', prev: 'PIA', now: 0,
    })).toBe('SAI +4.8 s to LEC: the gap at the line of lap 15, the latest lap both completed; closing 0.5 s over 3 laps'
      + ` · ${MINUS}2.1 s to PIA (the row above), the gap at the line of lap 15, the latest lap both completed`);
    expect(rowTitle(row({ driver: 'LEC', toRef: 0 }), {
      reference: 'LEC', focus: 'LEC', prev: null, now: 0,
    })).toBe('LEC: the reference of the gaps (the focus car)');
    expect(rowTitle(row({
      status: 'lane', pitInTime: 100, toRef: null, toPrev: null,
    }), {
      reference: 'LEC', focus: 'LEC', prev: 'PIA', now: 114.6,
    })).toBe('SAI in the pit lane, 14 s since its pit entry: no gap until its stop is over (the latest lap both completed does not hold the stop yet)');
  });
});
