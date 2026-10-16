// The dock never scrolls. BottomTabBar measures its buttons (their
// labels follow the type tokens) and dockCapacity says how many items fit next
// to the ⋯ overflow button; the rest go to the overflow popover.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockCapacity } from '../utils/dockCapacity.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('dockCapacity', () => {
  const room = { available: 1000, fixedWidth: 200, overflowWidth: 44, gap: 2 };

  it('shows every item when they all fit', () => {
    expect(dockCapacity([100, 100, 100], room)).toBe(3);
    // exactly at the edge: 7 x (110 + 2) = 784 <= 800
    expect(dockCapacity(Array(7).fill(110), room)).toBe(7);
  });

  it('keeps room for the ⋯ button when some items do not fit', () => {
    // 8 x 112 = 896 > 800; with the ⋯ button (44 + 2): 6 x 112 = 672 <= 754, 7 x 112 = 784 > 754
    expect(dockCapacity(Array(8).fill(110), room)).toBe(6);
  });

  it('uses the measured width of each item, not a fixed one', () => {
    const wide = [150, 150, 150, 150, 150, 150];
    const narrow = [60, 60, 60, 60, 60, 60];
    expect(dockCapacity(wide, room)).toBeLessThan(dockCapacity(narrow, room));
    expect(dockCapacity(narrow, room)).toBe(6);
  });

  it('never returns fewer than one item, and 0 for an empty dock', () => {
    expect(dockCapacity([900, 900], room)).toBe(1);
    expect(dockCapacity([], room)).toBe(0);
  });

  it('a non-numeric room (no DOM yet) shows everything', () => {
    expect(dockCapacity([100, 100], { available: NaN, fixedWidth: 0, overflowWidth: 44 })).toBe(2);
  });
});

describe('BottomTabBar uses the measured capacity', () => {
  const code = fs.readFileSync(path.join(SRC, 'components/ui/BottomTabBar.jsx'), 'utf8');
  it('no fixed per-item width or overhead constant is left', () => {
    expect(code).not.toMatch(/DOCK_ITEM_WIDTH|FIXED_OVERHEAD/);
    expect(code).toMatch(/dockCapacity\(widths, \{ available, fixedWidth, overflowWidth: OVERFLOW_BUTTON_W, gap \}\)/);
  });

  it('the dock never scrolls (CSS)', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles/dashboard.css'), 'utf8');
    const rule = css.slice(css.indexOf('.bottom-tab-bar {'), css.indexOf('}', css.indexOf('.bottom-tab-bar {')));
    expect(rule).toMatch(/overflow: hidden;/);
    expect(rule).not.toMatch(/overflow-x: auto/);
  });
});
