// Test helper (V5 / V13): a small, dependency-free reader of the app's CSS for
// the static layout, type and contrast checks. It is shared by the layout*
// tests and by the scripts in notes/experiments/v13_audit/.
//
//  - parseCss(text): flat list of style rules {selector, media, line, decls}
//    (@media blocks keep their condition; @keyframes / @font-face are skipped)
//  - rootTokens(rules): the custom properties declared on :root (dark theme)
//  - resolveVars(value, tokens): var(--x, fallback) substitution
//  - evalLength(expr, vp): px value of a CSS length (px, rem, vw, vh, calc,
//    clamp, min, max) at a viewport {W, H, root}
//  - mediaMatches(media, vp): simple width/height media features
//  - colour helpers: parseColor, over (alpha compositing), contrast (WCAG 2.1)

import fs from 'node:fs';
import path from 'node:path';

/** The four target viewports of V13 (CSS px of a maximised browser window). */
export const VIEWPORTS = [
  { name: '1536x750', W: 1536, H: 750 },
  { name: '1366x768', W: 1366, H: 768 },
  { name: '1920x1080', W: 1920, H: 1080 },
  { name: '2048x1100', W: 2048, H: 1100 },
];

// ── Files ────────────────────────────────────────────────────────────

export function listFiles(dir, exts) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '__tests__' || ent.name === 'dist') continue;
        walk(p);
      } else if (exts.some((e) => ent.name.endsWith(e))) {
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

// ── CSS parsing ──────────────────────────────────────────────────────

/** Comments blanked out, newlines kept, so offsets keep their line numbers. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function parseDecls(body, bodyStart, text) {
  const decls = [];
  let i = 0;
  let depth = 0;
  let start = 0;
  const push = (end) => {
    const raw = body.slice(start, end);
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const prop = raw.slice(0, colon).trim().toLowerCase();
      let value = raw.slice(colon + 1).trim();
      let important = false;
      if (/!important\s*$/i.test(value)) {
        important = true;
        value = value.replace(/\s*!important\s*$/i, '').trim();
      }
      if (prop && /^(--[\w-]+|-?[a-z][a-z-]*)$/.test(prop)) {
        const lead = raw.length - raw.trimStart().length;
        decls.push({ prop, value, important, line: lineAt(text, bodyStart + start + lead) });
      }
    }
    start = end + 1;
  };
  for (; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) push(i);
  }
  push(body.length);
  return decls;
}

/**
 * Style rules of a stylesheet. Each rule: {selector, media, line, decls}.
 * `media` is the condition of the enclosing @media block (or null).
 */
export function parseCss(source) {
  const text = stripComments(source);
  const rules = [];
  const walk = (from, to, media) => {
    let i = from;
    while (i < to) {
      const open = text.indexOf('{', i);
      if (open < 0 || open >= to) break;
      const prelude = text.slice(i, open).trim();
      // matching close brace
      let depth = 1;
      let j = open + 1;
      for (; j < to && depth > 0; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
      }
      const close = j - 1;
      if (prelude.startsWith('@media')) {
        const cond = prelude.slice(6).trim();
        walk(open + 1, close, media ? `${media} and ${cond}` : cond);
      } else if (prelude.startsWith('@')) {
        // @keyframes, @font-face, @supports ... not style rules for these checks
      } else if (prelude) {
        const lead = text.slice(i, open).length - text.slice(i, open).trimStart().length;
        rules.push({
          selector: prelude.replace(/\s+/g, ' '),
          media,
          line: lineAt(text, i + lead),
          decls: parseDecls(text.slice(open + 1, close), open + 1, text),
        });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, null);
  return rules;
}

export function parseCssFile(file) {
  return parseCss(fs.readFileSync(file, 'utf8')).map((r) => ({ ...r, file }));
}

/** Custom properties declared on :root outside any @media (the dark theme). */
export function rootTokens(rules) {
  const tokens = new Map();
  for (const r of rules) {
    if (r.media) continue;
    if (!r.selector.split(',').map((s) => s.trim()).includes(':root')) continue;
    for (const d of r.decls) if (d.prop.startsWith('--')) tokens.set(d.prop, d.value);
  }
  return tokens;
}

/** Replace var(--x[, fallback]) by the token value (recursively). */
export function resolveVars(value, tokens, depth = 0) {
  if (depth > 12 || !value.includes('var(')) return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    const k = value.indexOf('var(', i);
    if (k < 0) { out += value.slice(i); break; }
    out += value.slice(i, k);
    let d = 1;
    let j = k + 4;
    for (; j < value.length && d > 0; j++) {
      if (value[j] === '(') d++;
      else if (value[j] === ')') d--;
    }
    const inner = value.slice(k + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    const v = tokens.has(name) ? tokens.get(name) : fallback;
    out += v == null ? `UNRESOLVED(${name})` : resolveVars(v, tokens, depth + 1);
    i = j;
  }
  return out;
}

// ── Length evaluation ────────────────────────────────────────────────

function tokenize(expr) {
  const toks = [];
  const re = /\s*(?:(-?\d*\.?\d+(?:e-?\d+)?)(px|rem|em|vw|vh|vmin|vmax|%)?|([a-z-]+)\(|(\()|(\))|(,)|([+\-*/]))/iy;
  let m;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    m = re.exec(expr);
    if (!m) {
      if (/^\s*$/.test(expr.slice(pos))) break;
      throw new Error(`cannot tokenize "${expr}" at ${pos}`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) {
      // a leading "-" is a sign only after an operator, "(" or "," or at start
      const prev = toks[toks.length - 1];
      if (m[1].startsWith('-') && prev && (prev.t === 'num' || prev.t === ')')) {
        toks.push({ t: 'op', v: '-' });
        toks.push({ t: 'num', v: Number(m[1].slice(1)), u: (m[2] || '').toLowerCase() });
      } else {
        toks.push({ t: 'num', v: Number(m[1]), u: (m[2] || '').toLowerCase() });
      }
    } else if (m[3] !== undefined) toks.push({ t: 'fn', v: m[3].toLowerCase() });
    else if (m[4] !== undefined) toks.push({ t: '(' });
    else if (m[5] !== undefined) toks.push({ t: ')' });
    else if (m[6] !== undefined) toks.push({ t: ',' });
    else if (m[7] !== undefined) toks.push({ t: 'op', v: m[7] });
  }
  return toks;
}

/**
 * px value of a CSS length expression at a viewport. vp = {W, H, root, em?}.
 * Unitless numbers stay plain numbers (for calc(10px * 1.2)). NaN when the
 * expression cannot be evaluated (keywords, unresolved vars, %).
 */
export function evalLength(expr, vp) {
  const src = String(expr).trim();
  if (!src || /UNRESOLVED|inherit|initial|unset|auto|small|large|medium|smaller|larger/i.test(src)) return NaN;
  let toks;
  try { toks = tokenize(src); } catch { return NaN; }
  let i = 0;
  const unit = (n) => {
    switch (n.u) {
      case 'px': return n.v;
      case 'rem': return n.v * vp.root;
      case 'em': return n.v * (vp.em ?? vp.root);
      case 'vw': return (n.v * vp.W) / 100;
      case 'vh': return (n.v * vp.H) / 100;
      case 'vmin': return (n.v * Math.min(vp.W, vp.H)) / 100;
      case 'vmax': return (n.v * Math.max(vp.W, vp.H)) / 100;
      case '': return n.v;
      default: return NaN; // %
    }
  };
  const expr0 = () => {
    let v = term();
    while (toks[i] && toks[i].t === 'op' && (toks[i].v === '+' || toks[i].v === '-')) {
      const op = toks[i++].v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = () => {
    let v = factor();
    while (toks[i] && toks[i].t === 'op' && (toks[i].v === '*' || toks[i].v === '/')) {
      const op = toks[i++].v;
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const args = () => {
    const out = [expr0()];
    while (toks[i] && toks[i].t === ',') { i++; out.push(expr0()); }
    if (!toks[i] || toks[i].t !== ')') throw new Error('missing )');
    i++;
    return out;
  };
  const factor = () => {
    const t = toks[i++];
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') return unit(t);
    if (t.t === 'op' && t.v === '-') return -factor();
    if (t.t === '(') { const v = expr0(); if (!toks[i] || toks[i].t !== ')') throw new Error('missing )'); i++; return v; }
    if (t.t === 'fn') {
      const a = args();
      if (t.v === 'calc') return a[0];
      if (t.v === 'min') return Math.min(...a);
      if (t.v === 'max') return Math.max(...a);
      if (t.v === 'clamp') return Math.max(a[0], Math.min(a[1], a[2]));
      throw new Error(`unknown function ${t.v}`);
    }
    throw new Error(`unexpected ${t.t}`);
  };
  try {
    const v = expr0();
    if (i !== toks.length) return NaN;
    return v;
  } catch {
    return NaN;
  }
}

/** Root font size (px) of the html rule in base.css at a viewport. */
export function rootFontPx(rules, tokens, W, H) {
  let size = 16;
  for (const r of rules) {
    if (r.media) continue;
    if (!r.selector.split(',').map((s) => s.trim()).includes('html')) continue;
    for (const d of r.decls) {
      if (d.prop === 'font-size') {
        const v = evalLength(resolveVars(d.value, tokens), { W, H, root: 16 });
        if (Number.isFinite(v)) size = v;
      }
    }
  }
  return size;
}

/** Does a (simple) media condition hold at a viewport? */
export function mediaMatches(media, vp) {
  if (!media) return true;
  // "a, b" = or; "x and y" = and
  return media.split(',').some((alt) => alt.split(/\band\b/).every((part) => {
    const p = part.trim();
    if (!p) return true;
    if (/^(screen|all)$/i.test(p)) return true;
    const m = p.match(/^\(?\s*(min|max)-(width|height)\s*:\s*([\d.]+)px\s*\)?$/i);
    if (m) {
      const v = Number(m[3]);
      const have = m[2].toLowerCase() === 'width' ? vp.W : vp.H;
      return m[1].toLowerCase() === 'min' ? have >= v : have <= v;
    }
    // hover: none, prefers-reduced-motion, print ... do not apply on the target desktops
    return false;
  }));
}

// ── Colour ───────────────────────────────────────────────────────────

const NAMED = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0],
  red: [255, 0, 0, 1], currentcolor: null,
};

/** [r, g, b, a] (0-255, alpha 0-1) or null. */
export function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s in NAMED) return NAMED[s];
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    const n = (k) => parseInt(h.slice(k, k + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = m[4] == null ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  // color-mix(in srgb, A p%, B): premultiplied-alpha mix (CSS Color 5)
  m = s.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/);
  if (m) {
    const a = parseColor(m[1]);
    const b = parseColor(m[3]);
    if (!a || !b) return null;
    const p = Number(m[2]) / 100;
    const alpha = a[3] * p + b[3] * (1 - p);
    if (alpha === 0) return [0, 0, 0, 0];
    const ch = (k) => (a[k] * a[3] * p + b[k] * b[3] * (1 - p)) / alpha;
    return [ch(0), ch(1), ch(2), alpha];
  }
  return null;
}

/** Composite colour `top` (with its alpha, times `opacity`) over an opaque `bottom`. */
export function over(top, bottom, opacity = 1) {
  const a = top[3] * opacity;
  return [0, 1, 2].map((k) => top[k] * a + bottom[k] * (1 - a)).concat(1);
}

export function luminance(c) {
  const ch = c.slice(0, 3).map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Flatten a stack of layers (bottom first; strings or [r,g,b,a]) to an opaque colour. */
export function flatten(layers) {
  let acc = [0, 0, 0, 1];
  for (const l of layers) {
    const c = Array.isArray(l) ? l : parseColor(l);
    if (!c) throw new Error(`unparseable colour ${l}`);
    acc = over(c, acc);
  }
  return acc;
}

/** Last declaration of `prop` in a rule whose selector list contains `selector` (outside @media). */
export function declOf(rules, selector, prop) {
  let found = null;
  for (const r of rules) {
    if (r.media) continue;
    const sels = r.selector.split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) found = d.value;
  }
  return found;
}
