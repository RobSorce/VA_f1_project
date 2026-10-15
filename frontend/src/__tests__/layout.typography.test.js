// V13 target (3): type floors. Data labels, axis ticks and table text >= 11 px,
// any other text >= 10 px, at every target viewport. The floors are two CSS
// tokens (styles/tokens.css: --font-size-data, --font-size-label, clamp() on
// the viewport height); utils/colors.js CHART_FONT hands them to D3 and inline
// styles. Checked here: every font-size of the CSS at the four viewports, and
// every literal font size in the components of the layout lane.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIEWPORTS, listFiles, parseCssFile, rootTokens, resolveVars, evalLength, rootFontPx, mediaMatches,
} from './helpers/layoutCss.js';
import { CHART_FONT, FONT_TOKENS, FONT_FLOOR_PX } from '../utils/colors.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = listFiles(SRC, ['.css']).flatMap((f) => parseCssFile(f));
const tokens = rootTokens(rules);
const at = (expr, vp) => evalLength(resolveVars(expr, tokens), { W: vp.W, H: vp.H, root: rootFontPx(rules, tokens, vp.W, vp.H) });

describe('the type tokens', () => {
  it('--font-size-data never under 11 px and --font-size-label never under 10 px at the four viewports', () => {
    for (const vp of VIEWPORTS) {
      expect(at('var(--font-size-data)', vp)).toBeGreaterThanOrEqual(11);
      expect(at('var(--font-size-label)', vp)).toBeGreaterThanOrEqual(10);
      // the data type of the fixed-width Timing Tower: the data floor at every size
      expect(at('var(--font-size-data-fixed)', vp)).toBeGreaterThanOrEqual(11);
      // the small rem steps never go under the data floor (fluid root 13.23 px at 1366)
      expect(at('var(--font-size-xs)', vp)).toBeGreaterThanOrEqual(11);
      expect(at('var(--font-size-sm)', vp)).toBeGreaterThanOrEqual(11);
    }
  });

  it('colors.js CHART_FONT reads the same tokens, with the same floors', () => {
    expect(FONT_TOKENS).toEqual({ data: '--font-size-data', label: '--font-size-label', fixed: '--font-size-data-fixed' });
    expect(FONT_FLOOR_PX).toEqual({ data: 11, label: 10 });
    expect(CHART_FONT.data).toContain('var(--font-size-data');
    expect(CHART_FONT.label).toContain('var(--font-size-label');
    expect(CHART_FONT.fixed).toContain('var(--font-size-data-fixed');
    // every kind keeps its floor even without the token (max(floor, var(..., floor)))
    expect(CHART_FONT.data).toMatch(/^max\(11px, /);
    expect(CHART_FONT.label).toMatch(/^max\(10px, /);
    expect(CHART_FONT.fixed).toMatch(/^max\(11px, /);
    expect(tokens.has('--font-size-data')).toBe(true);
    expect(tokens.has('--font-size-label')).toBe(true);
    expect(tokens.has('--font-size-data-fixed')).toBe(true);
  });
});

describe('every font-size of the CSS respects its floor at the four viewports', () => {
  for (const vp of VIEWPORTS) {
    it(vp.name, () => {
      const fails = [];
      for (const r of rules) {
        if (!mediaMatches(r.media, vp)) continue;
        for (const d of r.decls) {
          if (d.prop !== 'font-size') continue;
          const floor = /var\(\s*--font-size-label\b/.test(d.value) ? 10 : 11;
          const px = at(d.value, vp);
          // keywords such as inherit carry their parent's (checked) size
          if (!Number.isFinite(px)) {
            if (!/^(inherit|1em|100%)$/.test(d.value)) fails.push(`${path.basename(r.file)}:${d.line} ${r.selector} unevaluated ${d.value}`);
            continue;
          }
          if (px < floor - 1e-6) fails.push(`${path.basename(r.file)}:${d.line} ${r.selector} ${d.value} = ${px.toFixed(2)} px < ${floor}`);
        }
      }
      expect(fails).toEqual([]);
    });
  }
});

describe('literal font sizes in the layout lane components', () => {
  const LANE = [
    'components/layout', 'components/ShortcutHints', 'components/ShortcutCheatsheet', 'components/CommandPalette',
    ...['Header', 'Footer', 'BottomTabBar', 'LayoutPresetBar', 'LayoutDockPopover', 'DockCustomizePopover',
      'DockOverflowPopover', 'DockContextMenu', 'Panel', 'SessionInfoBar', 'WeatherBar', 'WeatherMini',
      'TimelinePlayer', 'ToastStack', 'WelcomeToast', 'HelpOverlay', 'SessionSelectorScreen', 'SessionSelector']
      .map((n) => `components/ui/${n}.jsx`),
  ];
  const files = LANE.flatMap((p) => {
    const abs = path.join(SRC, p);
    return fs.statSync(abs).isDirectory() ? listFiles(abs, ['.jsx', '.js']) : [abs];
  });

  it('no literal size under 10 px, and a size under 11 px only through the label token', () => {
    const pats = [
      /fontSize\s*:\s*(['"`]?)([\d.]+)(px)?\1\s*[,}\n]/g,
      /fontSize\s*=\s*\{\s*([\d.]+)\s*\}/g,
      /\.(?:attr|style)\(\s*['"]font-size['"]\s*,\s*['"]([\d.]+)(?:px)?['"]\s*\)/g,
      /font-size\s*:\s*([\d.]+)px/g,
    ];
    const fails = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((ln, i) => {
        if (/^\s*(\/\/|\*)/.test(ln)) return;
        for (const re of pats) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(ln))) {
            const px = Number(re === pats[0] ? m[2] : m[1]);
            if (px < 11) fails.push(`${path.relative(SRC, file)}:${i + 1} ${px}px`);
          }
        }
      });
    }
    expect(fails).toEqual([]);
  });

  it('the timeline draws its tick labels and marker letters with the CHART_FONT tokens', () => {
    const code = fs.readFileSync(path.join(SRC, 'components/ui/TimelinePlayer.jsx'), 'utf8');
    expect(code).not.toMatch(/\.attr\('font-size'/);
    expect((code.match(/\.style\('font-size', CHART_FONT\.(data|label)\)/g) || []).length).toBeGreaterThanOrEqual(6);
  });
});
