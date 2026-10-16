// Test helper: advance widths of the app's Formula1 faces read
// from the TTF files of public/fonts (cmap format 4 + hmtx), for the fit
// tests that measure labels (sectors / consistency / leaderboard keep their
// own copy of the reader). The CSS maps font-weight to the @font-face rules
// of tokens.css: up to 500 the Regular face, 600-700 the Bold, 800-900 the
// Wide. A glyph the face lacks counts 1 em (an upper bound for the fallback
// font that draws it).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FONTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/fonts');
const FILES = { 400: 'Formula1-Regular-1.ttf', 700: 'Formula1-Bold-4.ttf', 900: 'Formula1-Wide.ttf' };

/** True when the three Formula1 faces are in public/fonts. */
export const haveFormula1 = Object.values(FILES).every((f) => fs.existsSync(path.join(FONTS, f)));

/** (text, sizePx) -> advance width in px, for one TTF file. */
export function faceWidths(file) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = {};
  for (let i = 0; i < dv.getUint16(4); i++) {
    const o = 12 + i * 16;
    tables[String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])] = dv.getUint32(o + 8);
  }
  const upm = dv.getUint16(tables.head + 18);
  const nh = dv.getUint16(tables.hhea + 34);
  const adv = (g) => dv.getUint16(tables.hmtx + 4 * Math.min(g, nh - 1));
  let sub = null;
  for (let i = 0; i < dv.getUint16(tables.cmap + 2); i++) {
    const pid = dv.getUint16(tables.cmap + 4 + i * 8);
    const off = dv.getUint32(tables.cmap + 8 + i * 8);
    if (dv.getUint16(tables.cmap + off) === 4 && (pid === 3 || pid === 0)) sub = tables.cmap + off;
  }
  const segX2 = dv.getUint16(sub + 6);
  const ends = sub + 14; const starts = ends + segX2 + 2; const deltas = starts + segX2; const ranges = deltas + segX2;
  const glyph = (code) => {
    for (let i = 0; i < segX2 / 2; i++) {
      if (code > dv.getUint16(ends + 2 * i)) continue;
      const start = dv.getUint16(starts + 2 * i);
      if (code < start) return 0;
      const ro = dv.getUint16(ranges + 2 * i);
      if (!ro) return (code + dv.getInt16(deltas + 2 * i)) & 0xffff;
      const g = dv.getUint16(ranges + 2 * i + ro + 2 * (code - start));
      return g ? (g + dv.getInt16(deltas + 2 * i)) & 0xffff : 0;
    }
    return 0;
  };
  return (t, size) => [...t].reduce((a, ch) => { const g = glyph(ch.codePointAt(0)); return a + (g ? adv(g) : upm); }, 0) / upm * size;
}

let faces = null;
/**
 * Width (CSS px) of `text` at `size` px in the face of `weight`, plus the CSS
 * letter-spacing after every character (Chrome adds it after the last one
 * too); `upper` applies text-transform: uppercase.
 */
export function textWidth(text, size, weight = 400, { letterSpacingEm = 0, upper = false } = {}) {
  if (!faces) faces = Object.fromEntries(Object.entries(FILES).map(([w, f]) => [w, faceWidths(path.join(FONTS, f))]));
  const face = faces[weight <= 500 ? 400 : weight <= 700 ? 700 : 900];
  const t = upper ? text.toUpperCase() : text;
  return face(t, size) + [...t].length * letterSpacingEm * size;
}
