// F11 / D10, small contrast items of the chrome, read from the CSS as written:
//  - the command search field (weather bar): its boundary >= 3:1 against the
//    field and the bar (WCAG 2.1 SC 1.4.11; --rh-border read 1.28:1) and a
//    visible focus (the 27 % accent read 2.25:1), dark and light theme;
//  - the welcome toast sits above the bottom chrome (timeline row + dock) at
//    every target viewport: at bottom 72px it overlapped the timeline row;
//  - light theme: no muted text in #6B7280 (4.16-4.47:1 on the light
//    surfaces), the token --color-text-muted (>= 4.5:1) instead.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listFiles, parseCssFile, rootTokens, resolveVars, parseColor, over, flatten, contrast, declOf, evalLength,
  rootFontPx, VIEWPORTS,
} from './helpers/layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = listFiles(SRC, ['.css']).flatMap((f) => parseCssFile(f));
const dark = rootTokens(rules);
// light theme: the [data-theme="light"] token overrides over the dark ones
const light = new Map(dark);
for (const r of rules) {
  if (r.media || r.selector.trim() !== '[data-theme="light"]') continue;
  for (const d of r.decls) if (d.prop.startsWith('--')) light.set(d.prop, d.value);
}
const PAGE = '#0f0f1e';
const LIGHT_PAGE = '#F7F6F3';
const colorIn = (value, tokens) => {
  const v = resolveVars(value, tokens).trim();
  return parseColor(v) || parseColor((v.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i) || [])[1]);
};
const borderColorOf = (sel, tokens) => colorIn(declOf(rules, sel, 'border-color') || declOf(rules, sel, 'border'), tokens);

describe('command search field (CommandBar.css)', () => {
  const bar = flatten([PAGE, colorIn(declOf(rules, '.weather-bar', 'background'), dark)]);
  const field = flatten([bar, colorIn(declOf(rules, '.search-bar__wrap', 'background'), dark)]);
  const fieldFocus = flatten([bar, colorIn(declOf(rules, '.search-bar--focused .search-bar__wrap', 'background'), dark)]);

  it('dark: the boundary >= 3:1 on the field and on the weather bar', () => {
    const b = borderColorOf('.search-bar__wrap', dark);
    expect(b).toBeTruthy();
    expect(contrast(over(b, field), field)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(b, field), bar)).toBeGreaterThanOrEqual(3);
    // the former token
    expect(contrast(colorIn('var(--rh-border)', dark), field)).toBeLessThan(1.5);
  });

  it('dark: focus is visible, the boundary >= 3:1 on the focused field', () => {
    const f = borderColorOf('.search-bar--focused .search-bar__wrap', dark);
    expect(contrast(over(f, fieldFocus), fieldFocus)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(colorIn('var(--rh-border-focus)', dark), fieldFocus), fieldFocus)).toBeLessThan(3);
  });

  it('light: the boundary and the focus >= 3:1 on the light field and bar', () => {
    const lbar = flatten([LIGHT_PAGE, colorIn(declOf(rules, '[data-theme="light"] .weather-bar', 'background'), light)]);
    const lfield = flatten([lbar, colorIn(declOf(rules, '[data-theme="light"] .search-bar__wrap', 'background'), light)]);
    const lfocus = flatten([lbar, colorIn(declOf(rules, '[data-theme="light"] .search-bar--focused .search-bar__wrap', 'background'), light)]);
    const b = borderColorOf('[data-theme="light"] .search-bar__wrap', light);
    const f = borderColorOf('[data-theme="light"] .search-bar--focused .search-bar__wrap', light);
    expect(contrast(over(b, lfield), lfield)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(b, lfield), lbar)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(f, lfocus), lfocus)).toBeGreaterThanOrEqual(3);
  });
});

describe('welcome toast above the bottom chrome (D10)', () => {
  it.each(VIEWPORTS)('$name: the toast\'s bottom edge clears the timeline row', ({ W, H }) => {
    const root = rootFontPx(rules, dark, W, H);
    const vp = { W, H, root };
    const bottom = evalLength(resolveVars(declOf(rules, '.welcome-toast', 'bottom'), dark), vp);
    const chrome = evalLength(resolveVars('var(--chrome-bottom)', dark), vp);
    expect(Number.isFinite(bottom) && Number.isFinite(chrome)).toBe(true);
    expect(bottom).toBeGreaterThanOrEqual(chrome + 4);
    // the former 72 px was inside the timeline row (dock + margin .. chrome-bottom)
    expect(72).toBeLessThan(chrome);
  });
});

describe('light theme: muted text through the token (D10)', () => {
  it('no light-theme rule draws text in #6B7280', () => {
    const offenders = rules.filter((r) => r.selector.includes('[data-theme="light"]')
      && r.decls.some((d) => /#6b7280/i.test(d.value))).map((r) => `${r.selector} (line ${r.line})`);
    expect(offenders).toEqual([]);
  });

  it('the token --color-text-muted reads >= 4.5:1 on every light surface; #6B7280 did not', () => {
    const muted = colorIn('var(--color-text-muted)', light);
    for (const s of ['#F7F6F3', '#FFFFFF', '#EFEEE9', '#E8E7E1', '#F0EFE9']) {
      expect(contrast(muted, parseColor(s)), s).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(parseColor('#6B7280'), parseColor('#F7F6F3'))).toBeLessThan(4.5);
  });

  it('the rules that used #6B7280 now read the token', () => {
    for (const sel of ['[data-theme="light"] .panel-shortcut-hint', '[data-theme="light"] .tower-col-header',
      '[data-theme="light"] .settings-tab__pill', '[data-theme="light"] .pos-chart-legend__item']) {
      expect(declOf(rules, sel, 'color'), sel).toBe('var(--color-text-muted)');
    }
    expect(declOf(rules, '[data-theme="light"] .axis text', 'fill')).toBe('var(--color-text-muted)');
  });
});
