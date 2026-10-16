// V13 target (2), the chrome of the layout lane: the text the findings of
// 2026-10-14 measured as unreadable (key caps, shortcut hints, dock tab
// labels, weather labels, layout labels, the red-on-dark-red lap counter and
// session badge) and the new layout chrome (docked pane tabs, Pit Wall session
// bar), each against the surface it is drawn on, read from the CSS as
// written: >= 4.5:1 (WCAG 2.1 SC 1.4.3; 3:1 for large text).
// The full chrome sweep is frontend/scripts/audit/chrome_contrast.mjs.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listFiles, parseCssFile, rootTokens, resolveVars, parseColor, over, flatten, contrast, declOf,
} from './helpers/layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = listFiles(SRC, ['.css']).flatMap((f) => parseCssFile(f));
const tokens = rootTokens(rules);

const PAGE = '#0f0f1e';
const PAGE_LOW = '#15152a';
const colorOf = (v) => {
  if (!v) return null;
  const r = resolveVars(v, tokens).trim();
  return parseColor(r) || parseColor((r.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i) || [])[1]);
};
const bg = (sel) => colorOf(declOf(rules, sel, 'background') || declOf(rules, sel, 'background-color'));

/** Contrast of a selector's text colour on a stack of surfaces (selectors or colours, bottom first). */
function ratioOf(selector, layers) {
  const fg = colorOf(declOf(rules, selector, 'color'));
  expect(fg, `${selector} has a text colour`).toBeTruthy();
  const stack = layers.map((l) => (typeof l === 'string' && l.startsWith('.') ? bg(l) : parseColor(l))).filter(Boolean);
  const own = bg(selector);
  const under = flatten(own ? [...stack, own] : stack);
  const opacity = Number(declOf(rules, selector, 'opacity') ?? 1) || 1;
  const behind = flatten(stack);
  return contrast(over(over(fg, under), behind, opacity), over(under, behind, opacity));
}

const CASES = [
  // [name, selector, surface stack]
  ['dock key cap', '.tab-kbd', [PAGE_LOW, '.bottom-tab-bar']],
  ['dock tab label', '.bottom-tab-bar__tab', [PAGE_LOW, '.bottom-tab-bar']],
  ['shortcut hint key', '.shortcut-hint-key', [PAGE, '.shortcut-hints']],
  ['shortcut hint label', '.shortcut-hint-label', [PAGE, '.shortcut-hints']],
  ['search bar key', '.search-bar__kbd', [PAGE, '.weather-bar', '.search-bar__wrap']],
  ['weather pill label', '.weather-bar__pill-label', [PAGE, '.weather-bar', '.weather-bar__center', '.weather-bar__pill']],
  ['session badge (red on red tint)', '.weather-bar__session-badge', [PAGE, '.weather-bar']],
  ['lap counter (red on red tint)', '.timeline-player__lap-text', [PAGE_LOW, '.timeline-player']],
  ['layout preset label', '.layout-preset-bar__label', [PAGE, '.weather-bar']],
  ['layout preset button', '.layout-preset-bar__btn', [PAGE, '.weather-bar']],
  ['timeline legend', '.timeline-player__legend-item', [PAGE_LOW, '.timeline-player']],
  ['docked pane tab', '.docked-pane__tab', [PAGE, '.docked-pane', '.docked-pane__tabs']],
  ['docked layout label', '.docked-layout__label', [PAGE, '.docked-layout__toolbar']],
  ['Pit Wall session bar lap', '.session-info-bar__lap', [PAGE, '.session-info-bar']],
  ['Pit Wall focus toggle', '.pitwall-layout__focus-toggle', [PAGE, 'rgba(12, 12, 28, 0.95)']],
  ['cheatsheet key', '.cs-key', [PAGE, '.cs-modal']],
  ['dock popover kbd', '.layout-dock-popover__kbd', [PAGE, '.layout-dock-popover']],
];

describe('chrome text contrast >= 4.5:1 (dark theme)', () => {
  for (const [name, sel, layers] of CASES) {
    it(`${name} (${sel})`, () => {
      expect(ratioOf(sel, layers)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the key caps are fully opaque: no opacity below 1 on .tab-kbd', () => {
    const op = declOf(rules, '.tab-kbd', 'opacity');
    expect(op == null || Number(op) === 1).toBe(true);
  });

  it('text red tokens: the F1 red is never the colour of chrome text, its text variant is', () => {
    const red = colorOf('var(--color-f1-red)');
    const redText = colorOf('var(--color-f1-red-text)');
    expect(contrast(red, parseColor(PAGE))).toBeLessThan(4.5); // why the variant exists
    expect(contrast(redText, flatten([PAGE, 'rgba(225,6,0,0.12)']))).toBeGreaterThanOrEqual(4.5);
    for (const sel of ['.timeline-player__lap-text', '.weather-bar__session-badge', '.timeline-player__speed-pill.active']) {
      expect(declOf(rules, sel, 'color'), sel).toBe('var(--color-f1-red-text)');
    }
  });
});
