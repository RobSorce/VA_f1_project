// Real font metrics for the static layout checks (V13 / Phase 9c): advance
// widths and vertical metrics read from the TTF files (cmap format 4, hmtx,
// head, hhea, OS/2), the same reader as
// frontend/src/__tests__/circleOfDoom.viewport.test.js.
//
//   const F = loadFaces();          // Formula1 faces of frontend/public/fonts
//   F.width('PIT WALL', 10, 700, { letterSpacingEm: 0.05, upper: true })
//   F.lineHeight(11, 700)           // CSS line-height: normal of the face
//
// The CSS maps font-weight to the @font-face rules of tokens.css: 400
// Regular, 700 Bold, 900 Wide (500 falls back to 400, 600 to 700, 800 to
// 900: CSS font matching). A glyph
// missing from the face (e.g. ⌘) is counted at 1 em, an upper bound for the
// fallback font that draws it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FONTS = path.join(ROOT, 'frontend/public/fonts');

export function readFace(file) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = {};
  for (let i = 0; i < dv.getUint16(4); i++) {
    const o = 12 + i * 16;
    tables[String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3])] = dv.getUint32(o + 8);
  }
  const unitsPerEm = dv.getUint16(tables.head + 18);
  const ascender = dv.getInt16(tables.hhea + 4);
  const descender = dv.getInt16(tables.hhea + 6);
  const lineGap = dv.getInt16(tables.hhea + 8);
  const numHMetrics = dv.getUint16(tables.hhea + 34);
  const advance = (gid) => dv.getUint16(tables.hmtx + 4 * Math.min(gid, numHMetrics - 1));
  let sub = null;
  for (let i = 0; i < dv.getUint16(tables.cmap + 2); i++) {
    const pid = dv.getUint16(tables.cmap + 4 + i * 8);
    const off = dv.getUint32(tables.cmap + 8 + i * 8);
    if (dv.getUint16(tables.cmap + off) === 4 && (pid === 3 || pid === 0)) sub = tables.cmap + off;
  }
  const segX2 = dv.getUint16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  const glyph = (code) => {
    for (let i = 0; i < segX2 / 2; i++) {
      if (code > dv.getUint16(ends + 2 * i)) continue;
      const start = dv.getUint16(starts + 2 * i);
      if (code < start) return 0;
      const delta = dv.getInt16(deltas + 2 * i);
      const ro = dv.getUint16(ranges + 2 * i);
      if (!ro) return (code + delta) & 0xffff;
      const g = dv.getUint16(ranges + 2 * i + ro + 2 * (code - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  return {
    unitsPerEm,
    /** Units of a text; a glyph the face lacks counts 1 em. */
    units(text) {
      let u = 0;
      for (const ch of text) {
        const g = glyph(ch.codePointAt(0));
        u += g ? advance(g) : unitsPerEm;
      }
      return u;
    },
    /** CSS line-height: normal (hhea ascender - descender + lineGap), in em. */
    normalLineEm: (ascender - descender + lineGap) / unitsPerEm,
  };
}

/** The Formula1 faces of the app (null when the font files are missing). */
export function loadFaces(dir = FONTS) {
  const files = { 400: 'Formula1-Regular-1.ttf', 700: 'Formula1-Bold-4.ttf', 900: 'Formula1-Wide.ttf' };
  if (!Object.values(files).every((f) => fs.existsSync(path.join(dir, f)))) return null;
  const faces = Object.fromEntries(Object.entries(files).map(([w, f]) => [w, readFace(path.join(dir, f))]));
  // CSS font matching over the faces 400 / 700 / 900: up to 500 the 400
  // face; above, the lightest face at least as heavy (600, 700 -> 700;
  // 800, 900 -> 900)
  const face = (weight) => faces[weight <= 500 ? 400 : weight <= 700 ? 700 : 900];
  return {
    face,
    /**
     * Width (CSS px) of `text` at `size` px: advance widths plus the CSS
     * letter-spacing after every character (Chrome adds it after the last one too).
     */
    width(text, size, weight = 400, { letterSpacingEm = 0, upper = false } = {}) {
      const t = upper ? text.toUpperCase() : text;
      const f = face(weight);
      return (f.units(t) / f.unitsPerEm) * size + [...t].length * letterSpacingEm * size;
    },
    lineHeight(size, weight = 400) { return face(weight).normalLineEm * size; },
  };
}

/** A system face (e.g. Segoe UI Bold, the system-ui fallback on Windows), or null. */
export function loadSystemFace(file) {
  if (!fs.existsSync(file)) return null;
  const f = readFace(file);
  return {
    width(text, size, { letterSpacingEm = 0, upper = false } = {}) {
      const t = upper ? text.toUpperCase() : text;
      return (f.units(t) / f.unitsPerEm) * size + [...t].length * letterSpacingEm * size;
    },
  };
}
