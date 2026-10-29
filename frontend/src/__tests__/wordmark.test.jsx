// The drawn wordmark (components/ui/Wordmark.jsx, utils/wordmark.js) as
// rendered, at both sizes: the line ends where the word's text box ends
// (textLength), the jog lies under the word (under the 3rd-4th letter) with
// the dot at its bottom, no attribute is NaN; the advance table is the font
// file's; the colours are the tokens, the accent >= 3:1 on the bars in both
// themes.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Wordmark from '../components/ui/Wordmark.jsx';
import { APP_NAME, APP_TAGLINE } from '../utils/brand.js';
import {
  ADVANCE, CAP_HEIGHT_EM, FONT_SIZE, JOG_SHARE, TRACKING_EM, wordmarkGeometry,
} from '../utils/wordmark.js';
import { textWidth, haveWebFont } from './helpers/fontWidths.js';
import {
  listFiles, parseCssFile, rootTokens, resolveVars, parseColor, over, contrast, declOf,
} from './helpers/layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The attributes of the first <tag ...> of the markup. */
const attrs = (html, tag) => {
  const m = html.match(new RegExp(`<${tag}\\b([^>]*)>`));
  expect(m, `<${tag}>`).toBeTruthy();
  return Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
};
const nums = (s) => (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);

describe.each(['header', 'hero'])('the %s wordmark as rendered', (size) => {
  const html = renderToStaticMarkup(<Wordmark size={size} tagline />);
  const svg = attrs(html, 'svg');
  const text = attrs(html, 'text');
  const line = attrs(html, 'path');
  const dot = attrs(html, 'circle');

  it('no attribute is NaN, every number is finite', () => {
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
    for (const a of [svg.viewBox, svg.width, svg.height, text.textLength, line.d, line['stroke-width'], dot.cx, dot.cy, dot.r]) {
      expect(a, a).toBeTruthy();
      for (const v of nums(a)) expect(Number.isFinite(v), a).toBe(true);
    }
  });

  it('one image named APP_NAME; the word inside is APP_NAME, hidden from assistive technology', () => {
    expect(svg.role).toBe('img');
    expect(svg['aria-label']).toBe(APP_NAME);
    expect(text['aria-hidden']).toBe('true');
    expect(html).toContain(`>${APP_NAME}</text>`);
  });

  it('the line runs from the start of the text box to its end (textLength, lengthAdjust spacing)', () => {
    const w = Number(text.textLength);
    expect(text.lengthAdjust).toBe('spacing');
    expect(Number(text.x)).toBe(0);
    expect(line.d).toMatch(/^M0 /);
    const end = line.d.match(/H([\d.]+)$/);
    expect(end, line.d).toBeTruthy();
    expect(Number(end[1])).toBe(w);
    // the view box spans the text box's width: the SVG is as wide as the word
    const [vx, , vw] = nums(svg.viewBox);
    expect(vx).toBe(0);
    expect(vw).toBe(w);
    expect(parseFloat(svg.width)).toBeCloseTo(w / FONT_SIZE, 6);
  });

  it('the jog lies under the word, under its 3rd-4th letter, 8-10 % of its width, the dot at its bottom', () => {
    const g = wordmarkGeometry(APP_NAME, size);
    const w = Number(text.textLength);
    const [, y0, x0, x1, y1, x2, x3, y3, xEnd] = nums(line.d);
    expect([x0, x1, x2, x3, xEnd]).toEqual([g.line.x0, g.line.x1, g.line.x2, g.line.x3, w]);
    expect(0 < x0 && x0 < x1 && x1 < x2 && x2 < x3 && x3 < w).toBe(true);
    expect(y3).toBe(y0);
    expect(y1).toBeGreaterThan(y0);
    const share = (x3 - x0) / w;
    expect(share).toBeGreaterThanOrEqual(0.08);
    expect(share).toBeLessThanOrEqual(0.10 + 1e-9);
    expect(share).toBeCloseTo(JOG_SHARE, 3);
    // under the 3rd and 4th letters: its centre between the start of the 3rd
    // and the end of the 4th (advances + tracking)
    const adv = [...APP_NAME].map((ch) => ADVANCE[ch] * (FONT_SIZE / 1000));
    const track = TRACKING_EM * FONT_SIZE;
    const start3 = adv[0] + adv[1] + 2 * track;
    const end4 = start3 + adv[2] + track + adv[3];
    const centre = (x0 + x3) / 2;
    expect(centre).toBeGreaterThan(start3);
    expect(centre).toBeLessThan(end4);
    // the dot sits on the flat bottom of the jog
    expect(Number(dot.cy)).toBe(y1);
    expect(Number(dot.cx)).toBeGreaterThanOrEqual(x1);
    expect(Number(dot.cx)).toBeLessThanOrEqual(x2);
    // everything is inside the view box
    const [, vy, , vh] = nums(svg.viewBox);
    expect(vy).toBeLessThanOrEqual(-CAP_HEIGHT_EM * FONT_SIZE + 1e-9);
    expect(vy + vh).toBeGreaterThanOrEqual(Number(dot.cy) + Number(dot.r) - 1e-9);
  });

  it(size === 'header'
    ? 'header: the view box is centred on the capitals (a centred row keeps the word where text sits)'
    : 'hero: the tagline under the line', () => {
    const [, vy, , vh] = nums(svg.viewBox);
    if (size === 'header') {
      expect(vy + vh / 2).toBeCloseTo(-(CAP_HEIGHT_EM * FONT_SIZE) / 2, 1);
      expect(html).not.toContain(APP_TAGLINE);
    } else {
      expect(html).toMatch(new RegExp(`</svg><span class="wordmark-lockup__tagline">${APP_TAGLINE}</span>`));
    }
  });
});

describe('the drawn wordmark and its type', () => {
  it('the tagline only with the hero size and the prop', () => {
    expect(renderToStaticMarkup(<Wordmark size="hero" />)).not.toContain(APP_TAGLINE);
    expect(renderToStaticMarkup(<Wordmark size="header" tagline />)).not.toContain(APP_TAGLINE);
  });

  it.skipIf(!haveWebFont)('the advance table is Inter Medium\'s (the font file of public/fonts)', () => {
    for (const [ch, units] of Object.entries(ADVANCE)) {
      expect(Math.abs(textWidth(ch, 1000, 500) - units), ch).toBeLessThanOrEqual(0.5);
    }
  });

  it('the text wordmark (session menu, Settings > About) has the drawn one\'s weight and tracking', () => {
    const rules = listFiles(SRC, ['.css']).flatMap((f) => parseCssFile(f));
    expect(declOf(rules, '.wordmark', 'letter-spacing')).toBe(`${TRACKING_EM}em`);
    expect(declOf(rules, '.wordmark', 'font-weight')).toBe(declOf(rules, '.wordmark-svg__name', 'font-weight'));
    expect(declOf(rules, '.wordmark-svg__name', 'font-weight')).toBe('var(--font-weight-medium)');
  });
});

describe('the wordmark\'s colours', () => {
  const rules = listFiles(SRC, ['.css']).flatMap((f) => parseCssFile(f));
  const dark = rootTokens(rules);
  const light = new Map(dark);
  for (const r of rules) {
    if (!r.media && r.selector.trim() === '[data-theme="light"]') {
      for (const d of r.decls) if (d.prop.startsWith('--')) light.set(d.prop, d.value);
    }
  }
  const col = (v, toks) => parseColor(resolveVars(String(v), toks));

  it('the word is the primary text, the line and the dot the brand accent', () => {
    expect(declOf(rules, '.wordmark-svg__name', 'fill')).toBe('var(--color-text-primary)');
    expect(declOf(rules, '.wordmark-svg__line', 'stroke')).toBe('var(--color-brand-accent)');
    expect(declOf(rules, '.wordmark-svg__dot', 'fill')).toBe('var(--color-brand-accent)');
    expect(dark.get('--color-brand-accent')).not.toBe(light.get('--color-brand-accent'));
  });

  it('the accent is >= 3:1 on the weather bar and the header in both themes (contrast_pairs.txt has every surface)', () => {
    for (const [theme, toks, pre, page] of [['dark', dark, '', '#0f0f1e'], ['light', light, '[data-theme="light"] ', '#F7F6F3']]) {
      const accent = col('var(--color-brand-accent)', toks);
      for (const sel of ['.weather-bar', '.app-header']) {
        const bg = over(col(declOf(rules, `${pre}${sel}`, 'background'), toks), parseColor(page));
        expect(contrast(accent, bg), `${theme} ${sel}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
