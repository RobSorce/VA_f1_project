// Test helper: advance widths of the app's Inter faces, read from the font
// files of public/fonts that the @font-face rules of tokens.css name (one
// static face per weight, CSS font matching for the others), by the reader of
// frontend/scripts/audit/fontMetrics.mjs (WOFF2, cmap, hmtx; the tabular
// forms of GSUB tnum for an element with font-variant-numeric: tabular-nums).
// Shared by the fit tests that measure labels. A glyph the face lacks counts
// 1 em (an upper bound for the fallback font that draws it).
import { FONTS, loadFaces } from '../../../scripts/audit/fontMetrics.mjs';

export { FONTS };

const faces = loadFaces('Inter');

/** True when every Inter face of tokens.css is in public/fonts. */
export const haveWebFont = faces != null;

/** (text, sizePx) -> advance width in px, in the face CSS draws `weight` with. */
export function faceWidths(weight = 400, { tabular = false } = {}) {
  return (t, size) => faces.width(t, size, weight, { tabular });
}

/**
 * Width (CSS px) of `text` at `size` px in the face of `weight`, plus the CSS
 * letter-spacing after every character (Chrome adds it after the last one
 * too); `upper` applies text-transform: uppercase.
 */
export function textWidth(text, size, weight = 400, { letterSpacingEm = 0, upper = false, tabular = false } = {}) {
  return faces.width(text, size, weight, { letterSpacingEm, upper, tabular });
}

/** CSS line-height: normal of the face of `weight`, in px at `size`. */
export function lineHeight(size, weight = 400) {
  return faces.lineHeight(size, weight);
}
