import React from 'react';
import { APP_NAME, APP_TAGLINE } from '../../utils/brand';
import { publicAsset } from '../../utils/publicAsset';

/**
 * The logo files of public/brand, one per size, each with a dark and a light
 * version: the view box of each file in its own units, where the letters are
 * 100 units tall. 'header' is the static horizontal logo, its view box cut to
 * the drawing; 'hero' is the same logo animated (3 s, once; drawn at once
 * under prefers-reduced-motion), its view box holding the clear space the
 * animation needs.
 */
export const LOGO_FILES = {
  header: { file: 'variante_primary', width: 680.74, height: 102.16 },
  hero: { file: 'variante_intro_primary', width: 803.34, height: 224.76 },
};
export const LETTER_UNITS = 100;

// Letter height on screen, in px: the brand kit's 16 px minimum in the top
// bar, the session menu and Settings > About; 56 px on the start screen
export const LETTER_PX = { header: 16, hero: 56 };

const ceil1 = (v) => Math.ceil(v * 10 - 1e-6) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/** Path inside public/ of the logo file of `size` for `theme` ('dark' | 'light'). */
export const logoPath = (size, theme) => `brand/${LOGO_FILES[size].file}_${theme}.svg`;

/**
 * Box of the logo image of `size` on screen, in px: the height rounded up to
 * 0.1 px, so the letters stay at LETTER_PX or more once the browser snaps the
 * box to its layout unit (1/64 px in Chromium: 16.35 px drew 16.34), the
 * width from it at the file's ratio.
 */
export function logoBox(size) {
  const f = LOGO_FILES[size];
  const height = ceil1((f.height * LETTER_PX[size]) / LETTER_UNITS);
  return { width: round2((height * f.width) / f.height), height };
}

/**
 * The logo, from the brand files (never the name retyped in a font): one image
 * for assistive technology, named APP_NAME. Both theme files are in the page;
 * the CSS shows the dark one (white letters, for the dark surfaces) and, under
 * [data-theme="light"], the light one (components.css .wordmark). size 'hero'
 * with `tagline` adds APP_TAGLINE under the logo, as text outside the image.
 */
export default function Wordmark({ size = 'header', tagline = false, className = '' }) {
  const key = LOGO_FILES[size] ? size : 'header';
  const box = logoBox(key);
  const style = { width: `${box.width}px`, height: `${box.height}px` };
  return (
    <span className={`wordmark wordmark--${key}${className ? ` ${className}` : ''}`}>
      <span className="wordmark__logo" role="img" aria-label={APP_NAME}>
        {['dark', 'light'].map((theme) => (
          <img
            key={theme}
            className={`wordmark__img wordmark__img--${theme}`}
            src={publicAsset(logoPath(key, theme))}
            alt=""
            aria-hidden="true"
            draggable={false}
            style={style}
          />
        ))}
      </span>
      {tagline && key === 'hero' && <span className="wordmark__tagline">{APP_TAGLINE}</span>}
    </span>
  );
}
