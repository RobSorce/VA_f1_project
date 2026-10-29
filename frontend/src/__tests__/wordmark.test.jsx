// The logo (components/ui/Wordmark.jsx) as rendered, at both sizes: one image
// named APP_NAME holding the dark and the light file of its size, from
// public/brand through the build's base (utils/publicAsset); the letters 16 px
// tall at the header size (the brand kit's minimum) and 56 px on the start
// screen, read from each file's view box; the CSS shows one file per theme
// and keeps the clear space; the tagline only under the hero, outside the
// image, so it stays text.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Wordmark, { LETTER_PX, LETTER_UNITS, LOGO_FILES, logoBox, logoPath } from '../components/ui/Wordmark.jsx';
import { APP_NAME, APP_TAGLINE } from '../utils/brand.js';
import { publicAsset } from '../utils/publicAsset.js';
import { logosIn, stylePx } from './helpers/logo.js';
import { listFiles, parseCssFile, declOf } from './helpers/layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.resolve(SRC, '../public');
const BASE = import.meta.env.BASE_URL || '/';
const viewBoxOf = (rel) => {
  const m = fs.readFileSync(path.join(PUBLIC, rel), 'utf8').match(/<svg\b[^>]*\bviewBox="([^"]+)"/);
  expect(m, rel).toBeTruthy();
  return m[1].trim().split(/\s+/).map(Number);
};
const rules = listFiles(SRC, ['.css']).flatMap((f) => parseCssFile(f));

describe.each(['header', 'hero'])('the %s logo as rendered', (size) => {
  const [logo, ...more] = logosIn(renderToStaticMarkup(<Wordmark size={size} />));

  it('one image named APP_NAME, holding the dark and the light file of its size', () => {
    expect(more).toEqual([]);
    expect(logo.size).toBe(size);
    expect(logo.image).toMatchObject({ role: 'img', 'aria-label': APP_NAME });
    expect(logo.imgs.map((i) => i.src)).toEqual(['dark', 'light'].map((t) => publicAsset(logoPath(size, t))));
    expect(logo.imgs.map((i) => i.class)).toEqual(['wordmark__img wordmark__img--dark', 'wordmark__img wordmark__img--light']);
    for (const img of logo.imgs) {
      // the image is the span: the files themselves say nothing to assistive
      // technology and cannot be dragged out
      expect(img).toMatchObject({ alt: '', 'aria-hidden': 'true', draggable: 'false' });
    }
    expect(LOGO_FILES[size].file).toBe(size === 'header' ? 'variante_primary' : 'variante_intro_primary');
  });

  it('every file it names is a file of public/, under the build\'s base', () => {
    for (const img of logo.imgs) {
      expect(img.src.startsWith(BASE), img.src).toBe(true);
      expect(fs.existsSync(path.join(PUBLIC, img.src.slice(BASE.length))), img.src).toBe(true);
    }
  });

  it(`the letters are ${LETTER_PX[size]} px tall: the box follows each file's view box`, () => {
    for (const theme of ['dark', 'light']) {
      const [, , w, h] = viewBoxOf(logoPath(size, theme));
      expect([w, h], theme).toEqual([LOGO_FILES[size].width, LOGO_FILES[size].height]);
    }
    for (const img of logo.imgs) {
      const w = stylePx(img.style, 'width');
      const h = stylePx(img.style, 'height');
      expect({ width: w, height: h }).toEqual(logoBox(size));
      const letters = (h * LETTER_UNITS) / LOGO_FILES[size].height;
      expect(letters).toBeGreaterThanOrEqual(LETTER_PX[size]);
      expect(letters).toBeLessThan(LETTER_PX[size] + 0.1);
      // still LETTER_PX once a browser snaps the box down to its layout unit
      // (1/64 px in Chromium, 1/60 in Firefox)
      expect(((Math.floor(h * 60) / 60) * LETTER_UNITS) / LOGO_FILES[size].height).toBeGreaterThanOrEqual(LETTER_PX[size]);
      expect(((Math.floor(h * 64) / 64) * LETTER_UNITS) / LOGO_FILES[size].height).toBeGreaterThanOrEqual(LETTER_PX[size]);
      // the file's ratio, to rounding (0.01 px)
      expect(Math.abs((w / h) / (LOGO_FILES[size].width / LOGO_FILES[size].height) - 1)).toBeLessThan(1e-3);
    }
  });
});

describe('the logo\'s sizes and tagline', () => {
  it('16 px letters in the top bar (the brand kit\'s minimum), 56 px on the start screen', () => {
    expect(LETTER_PX).toEqual({ header: 16, hero: 56 });
    // header: 16 x 102.16 / 100 = 16.35 px of image, 16.4 rounded up;
    // hero: 56 x 224.76 / 100 = 125.87, 125.9 rounded up
    expect(logoBox('header')).toEqual({ width: 103.16, height: 16.4 });
    expect(logoBox('hero')).toEqual({ width: 428.63, height: 125.9 });
  });

  it('the tagline only under the hero with the prop, after the image, as text', () => {
    const hero = logosIn(renderToStaticMarkup(<Wordmark size="hero" tagline />))[0];
    expect(hero.tagline).toBe(APP_TAGLINE);
    expect(hero.image['aria-label']).toBe(APP_NAME);
    expect(logosIn(renderToStaticMarkup(<Wordmark size="hero" />))[0].tagline).toBeNull();
    expect(logosIn(renderToStaticMarkup(<Wordmark size="header" tagline />))[0].tagline).toBeNull();
    expect(renderToStaticMarkup(<Wordmark size="header" tagline />)).not.toContain(APP_TAGLINE);
  });

  it('an unknown size is the header size; a class name joins the lockup\'s', () => {
    const [logo] = logosIn(renderToStaticMarkup(<Wordmark size="huge" className="x-place" />));
    expect(logo.size).toBe('header');
    expect(logo.classes).toEqual(['wordmark', 'wordmark--header', 'x-place']);
  });
});

describe('the logo\'s CSS', () => {
  it('the dark file by default, the light file under [data-theme="light"]', () => {
    expect(declOf(rules, '.wordmark__img', 'display')).toBe('block');
    expect(declOf(rules, '.wordmark__img--light', 'display')).toBe('none');
    expect(declOf(rules, '[data-theme="light"] .wordmark__img--dark', 'display')).toBe('none');
    expect(declOf(rules, '[data-theme="light"] .wordmark__img--light', 'display')).toBe('block');
  });

  it('clear space of half the letter height: the header size\'s margin, the hero file\'s own view box', () => {
    const margin = declOf(rules, '.wordmark--header', 'margin').split(/\s+/);
    const side = margin[1] ?? margin[0];
    expect(side).toMatch(/^[\d.]+px$/);
    expect(parseFloat(side)).toBeGreaterThanOrEqual(LETTER_PX.header / 2);
    // the primary file's view box is cut to the drawing: the intro file's
    // view box leaves at least 50 units (half the letters) around it
    const [dx, dy, dw, dh] = viewBoxOf(logoPath('header', 'dark'));
    const [ix, iy, iw, ih] = viewBoxOf(logoPath('hero', 'dark'));
    for (const room of [dx - ix, dy - iy, ix + iw - (dx + dw), iy + ih - (dy + dh)]) {
      expect(room).toBeGreaterThanOrEqual(LETTER_UNITS / 2);
    }
  });
});
