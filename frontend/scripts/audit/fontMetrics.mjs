// Real font metrics for the static layout checks (V13 / Phase 9c) and the
// fit tests (frontend/src/__tests__/helpers/fontWidths.js): advance widths
// and vertical metrics read from the font files of frontend/public/fonts
// (TTF / OTF, or WOFF2 decoded with node's Brotli: cmap format 4, hmtx, head,
// hhea, GSUB).
//
//   const F = loadFaces();          // the Inter faces of tokens.css
//   F.width('PIT WALL', 10, 700, { letterSpacingEm: 0.05, upper: true })
//   F.lineHeight(11, 700)           // CSS line-height: normal of the face
//
// The faces are the @font-face rules of frontend/src/styles/tokens.css for
// the family (one static face per weight). CSS font matching picks the face
// of a weight (an exact face, else the nearest by the CSS rules). With
// { tabular: true } the glyphs are the tabular forms (GSUB tnum), for an
// element with font-variant-numeric: tabular-nums; in Inter tnum also sets
// the space, the punctuation and the signs (+ - . : ( ) ...) to their tabular
// widths, not the digits only. Kerning and contextual alternates are not
// applied: Inter's kerning pairs are mostly negative (the sum is then wider
// than the line Chrome draws), a few positive ones make it a little
// narrower. A glyph missing from the face is counted at 1 em, an upper bound
// for the fallback font that draws it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const PUBLIC = path.join(ROOT, 'frontend/public');
export const FONTS = path.join(PUBLIC, 'fonts');
export const TOKENS_CSS = path.join(ROOT, 'frontend/src/styles/tokens.css');

// WOFF2 known table tags, by the 6-bit index of the table directory (W3C WOFF2, 5.1)
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ',
  'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc',
  'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop',
  'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/**
 * The tables of a font file: a DataView, the offset of each table in it and
 * whether hmtx is in the WOFF2 transformed form (advances only, 2 bytes each,
 * after a flags byte) instead of the sfnt one (advance + lsb, 4 bytes each).
 */
function fontTables(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'wOF2') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const at = {};
    for (let i = 0; i < dv.getUint16(4); i++) {
      const o = 12 + i * 16;
      at[b.toString('latin1', o, o + 4)] = dv.getUint32(o + 8);
    }
    return { dv, at, hmtxTransformed: false };
  }
  // WOFF2: header (48 bytes), table directory, then one Brotli stream with
  // the tables in directory order (transformed length for a transformed one)
  const head = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const x = b[p++];
      v = v * 128 + (x & 0x7f);
      if (!(x & 0x80)) return v;
    }
    throw new Error(`${file}: bad UIntBase128`);
  };
  const dir = [];
  for (let i = 0; i < head.getUint16(12); i++) {
    const flags = b[p++];
    const tag = (flags & 0x3f) === 0x3f ? b.toString('latin1', p, (p += 4)) : WOFF2_TAGS[flags & 0x3f];
    const version = flags >> 6;
    const origLength = base128();
    // glyf / loca: version 0 is the transform, 3 none; any other table: 0 is none
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    dir.push({ tag, length: transformed ? base128() : origLength, transformed });
  }
  const data = zlib.brotliDecompressSync(b.subarray(p, p + head.getUint32(20)));
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const at = {};
  let offset = 0;
  let hmtxTransformed = false;
  for (const t of dir) {
    at[t.tag] = offset;
    if (t.tag === 'hmtx') hmtxTransformed = t.transformed;
    offset += t.length;
  }
  return { dv, at, hmtxTransformed };
}

/** cmap format 4 lookup: code point -> glyph id (0 when the face lacks it). */
function cmapLookup(dv, cmap) {
  let sub = null;
  for (let i = 0; i < dv.getUint16(cmap + 2); i++) {
    const pid = dv.getUint16(cmap + 4 + i * 8);
    const off = dv.getUint32(cmap + 8 + i * 8);
    if (dv.getUint16(cmap + off) === 4 && (pid === 3 || pid === 0)) sub = cmap + off;
  }
  const segX2 = dv.getUint16(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  return (code) => {
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
}

/** Glyph id -> coverage index of an OpenType Coverage table (-1 when not covered). */
function coverageIndex(dv, cov, gid) {
  const format = dv.getUint16(cov);
  const count = dv.getUint16(cov + 2);
  for (let i = 0; i < count; i++) {
    if (format === 1) {
      if (dv.getUint16(cov + 4 + 2 * i) === gid) return i;
    } else {
      const r = cov + 4 + 6 * i;
      const start = dv.getUint16(r);
      if (gid >= start && gid <= dv.getUint16(r + 2)) return dv.getUint16(r + 4) + gid - start;
    }
  }
  return -1;
}

/**
 * The single substitutions (lookup type 1, or type 7 extensions of it) of a
 * GSUB feature, e.g. 'tnum': glyph id -> the glyph id it becomes (itself
 * when the feature leaves it), cached.
 */
function singleSubstitution(dv, gsub, feature) {
  if (gsub == null) return (gid) => gid;
  const features = gsub + dv.getUint16(gsub + 6);
  const lookups = gsub + dv.getUint16(gsub + 8);
  const indices = new Set();
  for (let i = 0; i < dv.getUint16(features); i++) {
    const rec = features + 2 + 6 * i;
    const tag = String.fromCharCode(dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3));
    if (tag !== feature) continue;
    const table = features + dv.getUint16(rec + 4);
    for (let k = 0; k < dv.getUint16(table + 2); k++) indices.add(dv.getUint16(table + 4 + 2 * k));
  }
  const subtables = [];
  for (const li of [...indices].sort((a, b) => a - b)) {
    const lookup = lookups + dv.getUint16(lookups + 2 + 2 * li);
    const type = dv.getUint16(lookup);
    for (let s = 0; s < dv.getUint16(lookup + 4); s++) {
      let st = lookup + dv.getUint16(lookup + 6 + 2 * s);
      if (type === 7) {
        if (dv.getUint16(st + 2) !== 1) continue;
        st += dv.getUint32(st + 4);
      } else if (type !== 1) continue;
      subtables.push(st);
    }
  }
  const cache = new Map();
  return (gid) => {
    if (cache.has(gid)) return cache.get(gid);
    let out = gid;
    for (const st of subtables) {
      const ci = coverageIndex(dv, st + dv.getUint16(st + 2), gid);
      if (ci < 0) continue;
      out = dv.getUint16(st) === 1 ? (gid + dv.getInt16(st + 4)) & 0xffff : dv.getUint16(st + 6 + 2 * ci);
      break;
    }
    cache.set(gid, out);
    return out;
  };
}

export function readFace(file) {
  const { dv, at, hmtxTransformed } = fontTables(file);
  const unitsPerEm = dv.getUint16(at.head + 18);
  const ascender = dv.getInt16(at.hhea + 4);
  const descender = dv.getInt16(at.hhea + 6);
  const lineGap = dv.getInt16(at.hhea + 8);
  const numHMetrics = dv.getUint16(at.hhea + 34);
  const advance = (gid) => {
    const i = Math.min(gid, numHMetrics - 1);
    return hmtxTransformed ? dv.getUint16(at.hmtx + 1 + 2 * i) : dv.getUint16(at.hmtx + 4 * i);
  };
  const glyph = cmapLookup(dv, at.cmap);
  const tnum = singleSubstitution(dv, at.GSUB, 'tnum');
  return {
    unitsPerEm,
    /** Units of a text (tabular: the tnum forms); a glyph the face lacks counts 1 em. */
    units(text, { tabular = false } = {}) {
      let u = 0;
      for (const ch of text) {
        let g = glyph(ch.codePointAt(0));
        if (g && tabular) g = tnum(g);
        u += g ? advance(g) : unitsPerEm;
      }
      return u;
    },
    /** True when the face has a glyph for the character. */
    has: (ch) => glyph(ch.codePointAt(0)) !== 0,
    /** CSS line-height: normal (hhea ascender - descender + lineGap), in em. */
    normalLineEm: (ascender - descender + lineGap) / unitsPerEm,
    /** hhea ascender and descender (both positive), in em: a line's box above and below its baseline. */
    ascentEm: ascender / unitsPerEm,
    descentEm: -descender / unitsPerEm,
  };
}

/**
 * The @font-face rules of tokens.css for `family`: weight -> font file
 * (the url is public/ relative, '/fonts/...').
 */
export function fontFaceFiles(family = 'Inter', css = TOKENS_CSS) {
  const text = fs.readFileSync(css, 'utf8');
  const out = {};
  for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1];
    const fam = /font-family:\s*['"]?([^'";]+)['"]?\s*;/.exec(body)?.[1];
    const url = /src:\s*url\(['"]?([^'")]+)['"]?\)/.exec(body)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(body)?.[1] ?? 400);
    if (fam === family && url && !/font-style:\s*(italic|oblique)/.test(body)) {
      out[weight] = path.join(PUBLIC, url.replace(/^\/+/, ''));
    }
  }
  return out;
}

/**
 * The face CSS font matching draws `weight` with, out of the weights
 * available (CSS Fonts 4, 5.2): an exact face; for 400-500 the next heavier
 * up to 500, then the lighter ones, then the heavier; under 400 the lighter
 * ones, then the heavier; over 500 the heavier ones, then the lighter.
 */
export function matchWeight(weight, available) {
  const ws = [...available].map(Number).sort((a, b) => a - b);
  if (ws.includes(weight)) return weight;
  const lighter = ws.filter((w) => w < weight).reverse();
  const heavier = ws.filter((w) => w > weight);
  if (weight >= 400 && weight <= 500) {
    const upTo500 = heavier.filter((w) => w <= 500);
    return [...upTo500, ...lighter, ...heavier.filter((w) => w > 500)][0];
  }
  return (weight < 400 ? [...lighter, ...heavier] : [...heavier, ...lighter])[0];
}

/** The faces of `family` in tokens.css (null when a font file is missing). */
export function loadFaces(family = 'Inter') {
  const files = fontFaceFiles(family);
  if (!Object.keys(files).length || !Object.values(files).every((f) => fs.existsSync(f))) return null;
  const faces = Object.fromEntries(Object.entries(files).map(([w, f]) => [w, readFace(f)]));
  const face = (weight) => faces[matchWeight(weight, Object.keys(faces))];
  return {
    face,
    weights: Object.keys(faces).map(Number),
    /**
     * Width (CSS px) of `text` at `size` px: advance widths plus the CSS
     * letter-spacing after every character (Chrome adds it after the last one too).
     */
    width(text, size, weight = 400, { letterSpacingEm = 0, upper = false, tabular = false } = {}) {
      const t = upper ? text.toUpperCase() : text;
      const f = face(weight);
      return (f.units(t, { tabular }) / f.unitsPerEm) * size + [...t].length * letterSpacingEm * size;
    },
    lineHeight(size, weight = 400) { return face(weight).normalLineEm * size; },
    /** Ascent and descent (CSS px) of the face of `weight` at `size` px. */
    ascent(size, weight = 400) { return face(weight).ascentEm * size; },
    descent(size, weight = 400) { return face(weight).descentEm * size; },
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
