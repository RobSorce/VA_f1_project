import { evalCssLength } from './cssLength.js';

// The palette module: every semantic colour of the dashboard is defined here
// and nowhere else (views import these constants; they hold no hex literals of
// their own for a meaning). The rules each palette follows, and the script that
// checks them, are:
//  - text >= 4.5:1 and marks >= 3:1 against the dark surfaces below (WCAG 2.1
//    AA, SC 1.4.3 / 1.4.11): contrastRatio, contrastText, textColor, markColor;
//  - every categorical / diverging palette is either distinguishable under
//    protanopia, deuteranopia and tritanopia (Machado et al. 2009, severity 1,
//    CIEDE2000 between every pair) or always drawn with a redundant cue (a
//    letter, glyph, sign or dash): scripts/cvd_check.mjs prints both, its
//    output is docs/evidence/cvd_check.txt.

// ── Surfaces of the dark theme (styles/tokens.css) ─────────────────────
// page = --color-bg-primary; panel = --color-bg-panel over the page; raised =
// --color-bg-tertiary (headers, cards, chart backgrounds); elevated =
// --color-bg-elevated (tooltips, hovered rows): the lightest dark surface.
export const SURFACES = {
  page: '#0f0f1e',
  panel: '#131326',
  raised: '#1a1f33',
  elevated: '#242938',
};
// Surface the mark and text rules are checked against by default: the
// lightest surface a chart is drawn on (a chart's own background is the panel)
export const CHART_SURFACE = SURFACES.raised;

// Neutral text of the views (dark theme). Contrast on the elevated surface:
// primary 14.49, secondary 9.03, muted 6.05, and muted 5.10 on a hovered row
// (docs/evidence/cvd_check.txt): every one passes 4.5:1 everywhere.
export const TEXT_COLORS = {
  primary: '#FFFFFF',
  secondary: '#C9CCD6',
  muted: '#A3A7B7',
};

// Strokes that are not data (grid, axis domain, separators): no contrast
// floor applies to them, they only have to stay behind the data.
export const GRID_COLORS = {
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.30)',
  rule: 'rgba(255,255,255,0.45)',
};

// ── Type sizes for D3 and inline styles ────────────────────────────────
// Floors (V13): data labels, axis ticks and table text >= 11 px, any other
// text >= 10 px. The size itself comes from the layout tokens of
// styles/tokens.css when they are defined (clamp() on the viewport), and can
// never fall under the floor (CSS max()). Use as a style value:
//   d3: .style('font-size', CHART_FONT.data)    React: { fontSize: CHART_FONT.data }
export const FONT_FLOOR_PX = { data: 11, label: 10 };
export const FONT_TOKENS = { data: '--font-size-data', label: '--font-size-label', fixed: '--font-size-data-fixed' };
// fixed: data text of a fixed-width table (the 480 px Timing Tower), whose
// columns do not grow with the viewport: the data floor at every size
export const CHART_FONT = {
  data: `max(${FONT_FLOOR_PX.data}px, var(${FONT_TOKENS.data}, ${FONT_FLOOR_PX.data}px))`,
  label: `max(${FONT_FLOOR_PX.label}px, var(${FONT_TOKENS.label}, ${FONT_FLOOR_PX.label}px))`,
  fixed: `max(${FONT_FLOOR_PX.data}px, var(${FONT_TOKENS.fixed}, ${FONT_FLOOR_PX.data}px))`,
};

/**
 * The size in CSS px a CHART_FONT kind resolves to now (for layout code that
 * measures text): the size the text is drawn at, never under the floor; the
 * floor itself without a DOM or without the token.
 *
 * A browser returns the token (an unregistered custom property) as declared,
 * e.g. 'clamp(11px, calc(7.786px + 0.4286vh), 12.5px)', math NOT evaluated,
 * so the value is evaluated here with the viewport (utils/cssLength.js):
 * 11.00 px at 1536x750, 12.41 px at 1920x1080, as CSS draws CHART_FONT.data.
 *
 * @param {'data'|'label'|'fixed'} kind
 * @returns {number}
 */
const _fontPxCache = new Map();
export function chartFontPx(kind = 'data') {
  const floor = FONT_FLOOR_PX[kind === 'fixed' ? 'data' : kind] ?? FONT_FLOOR_PX.data;
  try {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return floor;
    const rootStyle = getComputedStyle(document.documentElement);
    const raw = String(rootStyle.getPropertyValue(FONT_TOKENS[kind] || '') || '').trim();
    if (!raw) return floor;
    const W = typeof window !== 'undefined' ? Number(window.innerWidth) : NaN;
    const H = typeof window !== 'undefined' ? Number(window.innerHeight) : NaN;
    const root = parseFloat(rootStyle.fontSize) || 16;
    const key = `${raw}|${W}|${H}|${root}`;
    if (_fontPxCache.has(key)) return Math.max(floor, _fontPxCache.get(key));
    const px = evalCssLength(raw, { W, H, root });
    if (_fontPxCache.size > 64) _fontPxCache.clear();
    _fontPxCache.set(key, Number.isFinite(px) ? px : floor);
    return Number.isFinite(px) ? Math.max(floor, px) : floor;
  } catch {
    return floor;
  }
}

// ── Colour science ─────────────────────────────────────────────────────

/**
 * Parse '#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'rgb(...)' or 'rgba(...)'.
 *
 * @param {string} color
 * @returns {{r:number,g:number,b:number,a:number}|null} channels 0-255, alpha 0-1
 */
export function parseColor(color) {
  if (typeof color !== 'string') return null;
  const s = color.trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const v = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) / 255 : 1 };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i);
  if (m) {
    const a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/** '#rrggbb' (upper case) of a parsed colour or any colour string. */
export function toHex(color) {
  const c = typeof color === 'string' ? parseColor(color) : color;
  if (!c) return null;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase();
}

/** The colour as 'rgba(r,g,b,alpha)' (a tint of a semantic colour). */
export function withAlpha(color, alpha) {
  const c = parseColor(color);
  if (!c) return color;
  return `rgba(${c.r},${c.g},${c.b},${alpha})`;
}

/** Linear mix in sRGB: weight 0 = a, 1 = b. */
export function mixColors(a, b, weight) {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  return toHex({
    r: x.r + (y.r - x.r) * weight,
    g: x.g + (y.g - x.g) * weight,
    b: x.b + (y.b - x.b) * weight,
  });
}

/** An (optionally translucent) colour as it shows over an opaque background. */
export function compositeOver(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return toHex(fg);
  const base = b.a < 1 ? parseColor(compositeOver(bg, SURFACES.page)) : b;
  return toHex({
    r: f.r * f.a + base.r * (1 - f.a),
    g: f.g * f.a + base.g * (1 - f.a),
    b: f.b * f.a + base.b * (1 - f.a),
  });
}

const linear = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const unlinear = (v) => {
  const x = Math.max(0, Math.min(1, v));
  return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
};

/** WCAG 2.1 relative luminance of an opaque colour. */
export function relativeLuminance(color) {
  const c = parseColor(color);
  if (!c) return 0;
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
}

/**
 * WCAG 2.1 contrast ratio of a foreground (alpha composited) on a background.
 *
 * @param {string} fg
 * @param {string} [bg=CHART_SURFACE]
 * @returns {number} 1..21
 */
export function contrastRatio(fg, bg = CHART_SURFACE) {
  const back = compositeOver(bg, SURFACES.page);
  const front = compositeOver(fg, back);
  const [hi, lo] = [relativeLuminance(front), relativeLuminance(back)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white, whichever has the higher contrast on the background: the
 * text of every team-colour or compound badge, in HTML and SVG.
 *
 * @param {string} background
 * @returns {'#000000'|'#FFFFFF'}
 */
export function contrastText(background) {
  const bg = compositeOver(background, SURFACES.page);
  return contrastRatio('#000000', bg) >= contrastRatio('#FFFFFF', bg) ? '#000000' : '#FFFFFF';
}

const _liftCache = new Map();
/**
 * The colour itself when it reaches `min` contrast on the surface, else the
 * colour mixed toward white (on a dark surface; toward black on a light one)
 * in 5 % steps until it does.
 */
export function liftToContrast(color, surface = CHART_SURFACE, min = 3) {
  const key = `${color}|${surface}|${min}`;
  if (_liftCache.has(key)) return _liftCache.get(key);
  let out = color;
  if (parseColor(color) && contrastRatio(color, surface) < min) {
    const target = relativeLuminance(compositeOver(surface, SURFACES.page)) < 0.18 ? '#FFFFFF' : '#000000';
    const opaque = compositeOver(color, surface);
    out = target;
    for (let w = 0.05; w <= 1.0001; w += 0.05) {
      const c = mixColors(opaque, target, w);
      if (contrastRatio(c, surface) >= min) { out = c; break; }
    }
  }
  _liftCache.set(key, out);
  return out;
}

/**
 * Colour of a data mark (line, dot, bar, symbol) drawn in a team / category
 * colour: >= 3:1 on the surface (WCAG 2.1 SC 1.4.11). Documented rule: a dark
 * team colour (Red Bull, Ferrari, Alfa Romeo, Audi on the elevated surface) is
 * lightened toward white just enough; every other colour is drawn as is.
 */
export function markColor(color, surface = CHART_SURFACE) {
  return liftToContrast(color, surface, 3);
}

/** Colour of text drawn in a team / category colour: >= 4.5:1 on the surface. */
export function textColor(color, surface = CHART_SURFACE) {
  return liftToContrast(color, surface, 4.5);
}

// ── Focus + context (D7) ───────────────────────────────────────────────
// A de-emphasised (context) item is drawn in its colour mixed toward the
// surface it sits on, never at a lower opacity: its text keeps >= 3:1 and its
// marks >= 2:1 on that surface (docs/COLOR_ENCODING.md, focus + context).
// Disabled controls are exempt (WCAG 2.1 SC 1.4.3 / 1.4.11).
export const CONTEXT_FLOOR = Object.freeze({ text: 3, mark: 2 });
// How far toward the surface a context item is mixed when its floor allows it
export const CONTEXT_MIX = 0.5;
// The mix of a chart of many lines (a line per driver: Championship, Position
// Tracker, Lap Delta, Telemetry), where the context lines would otherwise
// compete with the focus: further toward the surface, still at the floors
export const CONTEXT_MIX_LINES = 0.75;

const _contextCache = new Map();
/**
 * Colour of a context item: `color` (alpha composited on the surface) mixed
 * toward the surface by `mix`, or by less where that would take it under
 * `min` contrast on the surface; a colour already under `min` is lifted to it
 * (liftToContrast). Always opaque ('#RRGGBB'), so nothing is drawn at an
 * opacity below 1.
 *
 * @param {string} color
 * @param {string} [surface=CHART_SURFACE] - the background the item is drawn on
 * @param {{min?: number, mix?: number}} [opts] - min: CONTEXT_FLOOR.mark
 *   (default, lines / bars / dots) or CONTEXT_FLOOR.text; mix: 0..1
 * @returns {string}
 */
export function contextColor(color, surface = CHART_SURFACE, { min = CONTEXT_FLOOR.mark, mix = CONTEXT_MIX } = {}) {
  const key = `${color}|${surface}|${min}|${mix}`;
  if (_contextCache.has(key)) return _contextCache.get(key);
  const back = compositeOver(surface, SURFACES.page);
  const opaque = parseColor(color) && back ? compositeOver(color, back) : null;
  let out = opaque || color;
  if (opaque) {
    if (contrastRatio(opaque, back) < min) {
      out = liftToContrast(opaque, back, min);
    } else {
      // the largest mix (1 % steps down from `mix`) that keeps the floor
      for (let w = Math.round(Math.max(0, Math.min(1, mix)) * 100); w >= 0; w -= 1) {
        const c = mixColors(opaque, back, w / 100);
        if (contrastRatio(c, back) >= min) { out = c; break; }
      }
    }
  }
  _contextCache.set(key, out);
  return out;
}

/** Text of a context item: contextColor at the text floor (>= 3:1 on the surface). */
export function contextText(color, surface = CHART_SURFACE, mix = CONTEXT_MIX) {
  return contextColor(color, surface, { min: CONTEXT_FLOOR.text, mix });
}

// The tint of a brushed lap range (the Position Tracker's d3-brush): the
// CSS fill, --color-brush at 16 % (visualizations.css .pos-chart__brush
// .selection), at the fill-opacity 0.3 that d3-brush sets on the selection
export const BRUSH_TINT_ALPHA = 0.16 * 0.3;
/**
 * A surface under the brushed range's tint: the lightest background of an
 * item drawn above the brush. Context text drawn there is computed on it
 * (contextText), so it keeps 3:1 inside the range as well as outside (on the
 * panel alone the labels read 3.00-3.07:1, and 2.79-2.84:1 inside the range).
 *
 * @param {string} [surface=SURFACES.panel]
 * @returns {string} '#RRGGBB'
 */
export function brushTintOver(surface = SURFACES.panel) {
  return compositeOver(withAlpha(UI_COLORS.brush, BRUSH_TINT_ALPHA), compositeOver(surface, SURFACES.page));
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied to linear RGB
export const CVD_MATRICES = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

/** The colour as seen with a colour-vision deficiency ('normal' = itself). */
export function simulateCvd(color, type) {
  const c = parseColor(compositeOver(color, CHART_SURFACE));
  const m = CVD_MATRICES[type];
  if (!c || !m) return toHex(c || color);
  const v = [linear(c.r), linear(c.g), linear(c.b)];
  const o = m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  return toHex({ r: unlinear(o[0]), g: unlinear(o[1]), b: unlinear(o[2]) });
}

function toLab(color) {
  const c = parseColor(color);
  const [r, g, b] = [linear(c.r), linear(c.g), linear(c.b)];
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). */
export function deltaE2000(a, b) {
  const [L1, a1, b1] = toLab(compositeOver(a, CHART_SURFACE));
  const [L2, a2, b2] = toLab(compositeOver(b, CHART_SURFACE));
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (bb, ap) => {
    if (bb === 0 && ap === 0) return 0;
    const v = Math.atan2(bb, ap) / rad;
    return v < 0 ? v + 360 : v;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    hbp = Math.abs(h1p - h2p) > 180
      ? (h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2)
      : (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Cbp7 = Cbp ** 7;
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTh * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// Smallest CIEDE2000 distance between two colours of a palette with which
// they still count as distinguishable without a redundant cue
export const CVD_MIN_DELTA_E = 10;

/**
 * The closest pair of a palette under a vision type.
 *
 * @param {Object<string,string>} palette - key → colour
 * @param {'normal'|'protanopia'|'deuteranopia'|'tritanopia'} type
 * @returns {{deltaE:number, pair:[string,string]}}
 */
export function closestPair(palette, type = 'normal') {
  const keys = Object.keys(palette);
  const seen = keys.map((k) => (type === 'normal' ? palette[k] : simulateCvd(palette[k], type)));
  let best = { deltaE: Infinity, pair: [null, null] };
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const d = deltaE2000(seen[i], seen[j]);
      if (d < best.deltaE) best = { deltaE: d, pair: [keys[i], keys[j]] };
    }
  }
  return best;
}

// ── Diverging pair (better / worse) ────────────────────────────────────
// Blue / orange instead of green / red: CIEDE2000 between the two >= 47.2
// under every vision type, both >= 5.53:1 on the elevated surface (text-safe,
// docs/evidence/cvd_check.txt). Always
// shown with the sign of the value (+ / −, signedDelta) or a ▲ ▼ glyph, so the
// colour is never the only cue. "better" = faster / gained / closing in.
export const DIVERGING = {
  better: '#5DA5E8',
  worse: '#F0883E',
  neutral: TEXT_COLORS.muted,
};

/**
 * Colour of a signed difference: better (blue) or worse (orange); neutral
 * inside the dead band.
 *
 * @param {number} value
 * @param {{lowerIsBetter?: boolean, deadband?: number}} [opts] - lap-time and
 *   gap deltas: lower is better (default); positions gained / health: false
 */
export function deltaColor(value, { lowerIsBetter = true, deadband = 0 } = {}) {
  if (value == null || !Number.isFinite(value) || Math.abs(value) <= deadband) return DIVERGING.neutral;
  const better = lowerIsBetter ? value < 0 : value > 0;
  return better ? DIVERGING.better : DIVERGING.worse;
}

/** '+0.123' / '−0.123' (true minus sign) / '0.000': the sign is always shown. */
export function signedDelta(value, digits = 3) {
  if (value == null || !Number.isFinite(value)) return '';
  const abs = Math.abs(value).toFixed(digits);
  if (Number(abs) === 0) return abs;
  return value > 0 ? `+${abs}` : `−${abs}`;
}

// ── Timing status (one map for every view) ─────────────────────────────
// F1 timing convention kept (purple overall best, green personal best, yellow
// no improvement), lightened to >= 5.47:1 on the elevated surface; the closest
// pair (overall best / pit) is CIEDE2000 11.9 apart under protanopia
// (cvd_check.txt), and each status is drawn with its glyph / text too
// (STATUS_GLYPHS), so colour is never the only cue.
export const STATUS_COLORS = {
  overallBest: '#C084FC',
  personalBest: '#34D399',
  slower: '#FDE047',
  muchSlower: DIVERGING.worse,
  fast: DIVERGING.better,
  normal: '#E5E7EB',
  pit: '#F472B6',
  retired: TEXT_COLORS.muted,
  running: TEXT_COLORS.secondary,
  predicted: '#F5A623',
};

// Bands of the timing colours (V2): one definition for every view that
// colours a time against a reference (the driver's personal best in the
// Timing Tower and the Pit Wall sector panel, the driver's median lap in the
// Race Pace Grid), in s over that reference. One ordered scale everywhere:
// within `slower` normal, beyond it yellow (STATUS_COLORS.slower), beyond
// `muchSlower` orange (STATUS_COLORS.muchSlower), never back to white; the
// pace grid also marks `fast` (blue) under its median. A best (purple ◆ /
// green ●) is a time within `tolerance` of it.
export const TIMING_BANDS = Object.freeze({
  lap: Object.freeze({ fast: 0.3, slower: 0.5, muchSlower: 2.0 }),
  sector: Object.freeze({ slower: 0.3, muchSlower: 1.0 }),
  tolerance: 0.010,
});

/**
 * Timing colour of a time `delta` s over its reference (TIMING_BANDS of
 * `kind`): normal, slower (yellow) or much slower (orange), in that order.
 *
 * @param {number} delta - time minus reference, s
 * @param {'lap'|'sector'} [kind='lap']
 * @returns {string} a STATUS_COLORS colour
 */
export function timingBandColor(delta, kind = 'lap') {
  const band = TIMING_BANDS[kind] || TIMING_BANDS.lap;
  if (!Number.isFinite(delta) || delta <= band.slower) return STATUS_COLORS.normal;
  return delta > band.muchSlower ? STATUS_COLORS.muchSlower : STATUS_COLORS.slower;
}

// Redundant cue of each status (the legend repeats it)
export const STATUS_GLYPHS = {
  overallBest: '◆', // ◆
  personalBest: '●', // ●
  pit: 'P',
  pitOut: 'O',
  retired: 'RET',
};

/**
 * The glyph drawn next to a time shown in a timing colour (◆ overall best,
 * ● personal best), '' for any other colour: the redundant cue of the purple /
 * green convention.
 */
export function timingGlyph(color) {
  if (color === STATUS_COLORS.overallBest) return STATUS_GLYPHS.overallBest;
  if (color === STATUS_COLORS.personalBest) return STATUS_GLYPHS.personalBest;
  return '';
}

// ── Flags / track status (FIA colours, always with their label) ───────
// Lightened for text (red 5.24:1 on the elevated surface); green is the
// emerald of personal best, so green and red flags are not the same colour
// under deuteranopia; yellow flag / safety car stay CIEDE2000 7.3 apart
// (deuteranopia) and are never shown without their label (cvd_check.txt).
export const FLAG_COLORS = {
  green: '#34D399',
  yellow: '#FACC15',
  safetyCar: '#F59E0B',
  red: '#F87171',
  blue: '#60A5FA',
  chequered: '#FFFFFF',
};

// FastF1 TrackStatus code → label (the redundant cue) and colour
export const TRACK_STATUS_STYLES = {
  '1': { label: 'Green Flag', short: 'GREEN', color: FLAG_COLORS.green },
  '2': { label: 'Yellow Flag', short: 'YELLOW FLAG', color: FLAG_COLORS.yellow },
  '4': { label: 'Safety Car', short: 'SAFETY CAR', color: FLAG_COLORS.safetyCar },
  '5': { label: 'Red Flag', short: 'RED FLAG', color: FLAG_COLORS.red },
  '6': { label: 'Virtual Safety Car', short: 'VSC', color: FLAG_COLORS.safetyCar },
  '7': { label: 'Virtual Safety Car ending', short: 'VSC', color: FLAG_COLORS.safetyCar },
};

/**
 * Style of a banner / chip tinted with a semantic colour: the tint behind,
 * the text in the colour lifted to 4.5:1 on that tint (no red on dark red).
 *
 * @param {string} color
 * @param {number} [alpha=0.15] - opacity of the tint
 * @param {string} [surface=CHART_SURFACE]
 * @returns {{background:string, color:string, borderColor:string}}
 */
export function tintedChip(color, alpha = 0.15, surface = CHART_SURFACE) {
  const background = withAlpha(color, alpha);
  const under = compositeOver(background, surface);
  return { background, color: textColor(color, under), borderColor: markColor(color, under) };
}

// ── Telemetry channels and categorical series ─────────────────────────
// Okabe & Ito (2008) colours, designed for colour-vision deficiency: throttle
// sky blue, brake orange (not green / red), speed yellow.
export const CHANNEL_COLORS = {
  speed: '#F0E442',
  throttle: '#56B4E9',
  brake: '#E69F00',
};
// Low ends of the Track Map channel ramps, >= 3:1 on the panel so 0 % brake
// (most of a lap) and the slowest corners never vanish into the background
// (docs/evidence/ramp_ends.txt): throttle / brake start at
// the track grey lifted to 3:1 (3.15:1), speed is cividis from t = 0.37, its
// first t at 3:1 (3.07:1)
export const CHANNEL_RAMP_LOW = '#5C6677';
export const SPEED_RAMP_START = 0.37;

// Up to four comparison series of one chart (laps of a driver, sectors of the
// track): Okabe-Ito, each >= 4.73:1 on the elevated surface, closest pair
// CIEDE2000 11.1 (tritanopia; cvd_check.txt).
export const SERIES_COLORS = ['#56B4E9', '#E69F00', '#CC79A7', '#F0E442'];

// Track sectors 1 / 2 / 3 on the track map (always labelled S1 / S2 / S3)
export const SECTOR_COLORS = { 1: SERIES_COLORS[2], 2: SERIES_COLORS[3], 3: SERIES_COLORS[0] };

// Track map surface and overlays that carry no category of their own: the
// unsectored track, the DRS zones (white edges and the label "DRS", so they
// never compete with the sector colours or a flag) and the north arrow
export const TRACK_COLORS = {
  surface: '#4A5568',
  drs: '#FFFFFF',
  drsFill: 'rgba(255,255,255,0.14)',
  drsDetection: '#C9CCD6',
  north: '#FF6B63',
};

// Podium medals of the final classification (flat fills; the position number
// is drawn on them in contrastText: black on all three, >= 6.6:1)
export const MEDAL_COLORS = { 1: '#FFD700', 2: '#C0C0C0', 3: '#CD7F32' };

// Finishing-outcome classes of the PCA biplot (ordered, brighter = better):
// podium and no points are cividis at t = 1 and 0.37, the lowest t still at
// 3:1 on the panel; points is a cyan at the lightness of cividis' middle
// class (its khaki read as grey next to the no-points grey on small marks)
// (scripts/pca_outcome_palette.mjs; docs/evidence/pca_outcome_palette.txt);
// ordered by lightness, so it stands on colour alone under every vision type
// (cvd_check.txt)
export const OUTCOME_COLORS = {
  podium: '#fdea45',
  points: '#13b1ce',
  none: '#61636f',
};

// Neutral accents that carry no category: selection / brush and highlight
export const UI_COLORS = {
  brush: '#8AB4F8',
  brushFill: 'rgba(138,180,248,0.16)',
  // F1 red of the brand (header gradients, live dot): never a data encoding
  accent: '#E10600',
  accentDark: '#B80500',
  accentEnd: '#1A1A2E',
  focusRing: '#FFFFFF',
  // Boundary of a text field or an outlined control: >= 3:1 on every dark
  // surface (WCAG 2.1 SC 1.4.11; 4.16:1 on the elevated surface, 4.49:1 on
  // the panel; docs/evidence/contrast_pairs.txt)
  controlBorder: 'rgba(255,255,255,0.45)',
  predicted: STATUS_COLORS.predicted,
  // The pit window, in every view that draws one (Circle of Doom band and
  // rejoin diamond, Position Tracker band, Tyre Degradation "next pit
  // window"): one colour for one meaning (V2); as text, pitWindowText
  // (textColor on the elevated surface: >= 4.55:1 on every dark surface)
  pitWindow: '#A855F7',
  pitWindowText: '#B56FF8',
};

// F1 Team Colors - 2024 Official. Every TeamName of the cached sessions
// (driver_info) has a key: 'Racing Bulls' is RB renamed for 2025 (FastF1's
// TeamColor #6692FF in 2025 R1, the RB colour); 'Audi' and 'Cadillac' (2026)
// carry FastF1's TeamColor of the cached 2026 sessions.
export const TEAM_COLORS = {
  'Red Bull Racing': '#3671C6',
  'Ferrari': '#E8002D',
  'Mercedes': '#27F4D2',
  'McLaren': '#FF8000',
  'Aston Martin': '#229971',
  'Alpine': '#FF87BC',
  'Williams': '#64C4FF',
  'RB': '#6692FF',
  'Racing Bulls': '#6692FF',
  'AlphaTauri': '#5E8FAA',
  'Haas F1 Team': '#B6BABD',
  'Kick Sauber': '#52E252',
  'Alfa Romeo': '#C92D4B',
  'Audi': '#F50537',
  'Cadillac': '#909090',
};

// Colour of a team name that matches no key
export const UNKNOWN_TEAM_COLOR = '#888888';

// Driver abbreviation → team color (static fallback for the 2024 season).
// The live `_dynamicDriverColors` map below overrides this whenever a
// session is loaded, so 2025 line-up changes (HAM → Ferrari, SAI →
// Williams, ANT → Mercedes, etc.) are picked up automatically.
//
// Note: `BEA` appears twice intentionally — Bearman raced for both
// Ferrari (2024 reserve appearances) and Haas (2025 full season). The
// dynamic map will override this with whichever team the loaded
// session assigns him to.
export const DRIVER_COLORS = {
  VER: '#3671C6', PER: '#3671C6',
  LEC: '#E8002D', SAI: '#E8002D',
  HAM: '#27F4D2', RUS: '#27F4D2', ANT: '#27F4D2',
  NOR: '#FF8000', PIA: '#FF8000',
  ALO: '#229971', STR: '#229971',
  GAS: '#FF87BC', OCO: '#FF87BC', DOO: '#FF87BC',
  ALB: '#64C4FF', SAR: '#64C4FF', COL: '#64C4FF',
  TSU: '#6692FF', RIC: '#6692FF', LAW: '#6692FF', HAD: '#6692FF',
  BOT: '#52E252', ZHO: '#52E252', BOR: '#52E252',
  HUL: '#B6BABD', MAG: '#B6BABD', BEA: '#B6BABD',
};

// Mutable driver → team-color map populated from the loaded session's
// `driver_info` (each entry has `Abbreviation` + `TeamName`). This makes
// driver colours track season-specific lineups instead of being frozen
// to the 2024 map. The store calls `setSessionDriverColors(...)` once
// per session load.
let _dynamicDriverColors = {};
// Driver → place in his team (0 = first driver, drawn solid in the team
// colour; 1+ = teammate, drawn dashed and in the teammate tint), from the same
// driver_info: ascending car number, then code.
let _dynamicTeammateIndex = {};

export function setSessionDriverColors(driverInfoArray) {
  if (!Array.isArray(driverInfoArray) || driverInfoArray.length === 0) {
    _dynamicDriverColors = {};
    _dynamicTeammateIndex = {};
    return;
  }
  const next = {};
  const teams = {};
  for (const d of driverInfoArray) {
    const abbr = d?.Abbreviation || d?.abbreviation;
    const team = d?.TeamName || d?.teamName;
    if (!abbr) continue;
    const color = getTeamColor(team);
    if (color && color !== UNKNOWN_TEAM_COLOR) {
      next[abbr] = color;
      const key = String(team).toLowerCase();
      const num = Number(d?.DriverNumber ?? d?.driverNumber);
      (teams[key] ||= []).push({ abbr, num: Number.isFinite(num) ? num : Infinity });
    }
  }
  const index = {};
  for (const list of Object.values(teams)) {
    list.sort((a, b) => (a.num - b.num) || a.abbr.localeCompare(b.abbr));
    list.forEach((d, i) => { if (index[d.abbr] == null) index[d.abbr] = i; });
  }
  _dynamicDriverColors = next;
  _dynamicTeammateIndex = index;
}

// Tyre compound colors — F1 broadcast standard (FIA compound colours: kept, and
// always drawn with the compound letter of TYRE_LABELS: soft and intermediate
// are CIEDE2000 5.7 apart under deuteranopia, cvd_check.txt)
export const TYRE_COLORS = {
  SOFT: '#FF3333',
  MEDIUM: '#FFC300',
  HARD: '#EEEEEE',
  INTERMEDIATE: '#39B54A',
  WET: '#00AAFF',
  UNKNOWN: '#888888',
};

// Tyre compound short labels
export const TYRE_LABELS = {
  SOFT: 'S',
  MEDIUM: 'M',
  HARD: 'H',
  INTERMEDIATE: 'I',
  WET: 'W',
};

/** Compound colour (UNKNOWN for anything else) and letter ('?' if none). */
export function tyreColor(compound) {
  return TYRE_COLORS[compound] || TYRE_COLORS.UNKNOWN;
}
export function tyreLetter(compound) {
  return TYRE_LABELS[compound] || (compound ? String(compound)[0] : '?');
}

// Get team color by team name: exact key (case-insensitive) first, then a
// fuzzy match (one name contains the other, e.g. 'Visa Cash App RB')
export function getTeamColor(teamName) {
  if (!teamName) return UNKNOWN_TEAM_COLOR;
  const name = String(teamName).toLowerCase();
  const keys = Object.keys(TEAM_COLORS);
  const key = keys.find((k) => k.toLowerCase() === name)
    || keys.find((k) => name.includes(k.toLowerCase()) || k.toLowerCase().includes(name));
  return key ? TEAM_COLORS[key] : UNKNOWN_TEAM_COLOR;
}

// Teammate order of the static 2024 map: alphabetical within each colour
const _staticTeammateIndex = (() => {
  const groups = {};
  for (const [abbr, color] of Object.entries(DRIVER_COLORS)) (groups[color] ||= []).push(abbr);
  const out = {};
  for (const list of Object.values(groups)) list.sort().forEach((a, i) => { out[a] = i; });
  return out;
})();

/** The team colour of a driver (the session's line-up first, then 2024). */
export function getDriverTeamColor(abbr) {
  return _dynamicDriverColors[abbr] || DRIVER_COLORS[abbr] || UNKNOWN_TEAM_COLOR;
}

/**
 * Place of the driver in his team: 0 = first driver (lower car number), 1 =
 * his teammate (2 = a third driver of the same team in one session).
 */
export function teammateIndex(abbr) {
  if (_dynamicDriverColors[abbr]) return _dynamicTeammateIndex[abbr] ?? 0;
  return _staticTeammateIndex[abbr] ?? 0;
}

/**
 * The driver's place in his team in the loaded session's line-up, with the
 * team colour of that line-up; null for a driver who is not in it. Views that
 * list more drivers than the session (the championship) give these drivers
 * exactly their session style, so a driver looks the same in every view (V3).
 *
 * @param {string} abbr
 * @returns {{index: number, teamColor: string}|null}
 */
export function sessionTeammate(abbr) {
  const teamColor = _dynamicDriverColors[abbr];
  return teamColor ? { index: _dynamicTeammateIndex[abbr] ?? 0, teamColor } : null;
}

/**
 * The static 2024 place of a driver in his team (alphabetical within a team
 * colour), used when no session line-up names him.
 *
 * @param {string} abbr
 * @returns {number}
 */
export function staticTeammateIndex(abbr) {
  return _staticTeammateIndex[abbr] ?? 0;
}

const _tintCache = new Map();
const CVD_TYPES = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
const _worstDeltaE = (a, b) => Math.min(...CVD_TYPES.map((t) => (t === 'normal'
  ? deltaE2000(a, b) : deltaE2000(simulateCvd(a, t), simulateCvd(b, t)))));
/**
 * Teammate tint (V3). Index 1 (the second driver of a team): a dark or mid
 * team colour (luminance < 0.4) mixed 45 % toward white, a light one 38 %
 * toward black, so the two drivers of a team differ by CIEDE2000 >= 11 under
 * every vision type (cvd_check.mjs). Index 2+ (a third driver of the team,
 * a reserve of the championship): the mix toward white or black, in 5 % steps
 * from 10 to 60 %, whose mark is farthest (worst vision type) from the marks
 * of the team colour and of tint 1: CIEDE2000 >= 10.1 for every team colour
 * (docs/evidence/third_tint_hue.txt), so three drivers of a
 * team are never drawn alike. The mix keeps at least 40 % of the team colour,
 * so its hue: with mixes up to 90 % most third tints were near-white or
 * near-black and the third drivers of two teams were CIEDE2000 0.7 apart
 * (Alpine #FFF3F8 / Haas #F8F8F8).
 *
 * @param {string} color - team colour
 * @param {number} [index=1] - place of the driver in his team (teammateIndex)
 */
export function teammateTint(color, index = 1) {
  const key = `${color}|${index >= 2 ? 2 : 1}`;
  if (_tintCache.has(key)) return _tintCache.get(key);
  let out = relativeLuminance(color) < 0.4 ? mixColors(color, '#FFFFFF', 0.45) : mixColors(color, '#000000', 0.38);
  if (index >= 2 && parseColor(color)) {
    const m0 = markColor(color);
    const m1 = markColor(out);
    let best = null;
    for (const target of ['#FFFFFF', '#000000']) {
      for (let step = 2; step <= 12; step += 1) {
        const c = mixColors(color, target, step * 0.05);
        const m = markColor(c);
        const v = Math.min(_worstDeltaE(m0, m), _worstDeltaE(m1, m));
        if (!best || v > best.v) best = { v, c };
      }
    }
    out = best.c;
  }
  _tintCache.set(key, out);
  return out;
}

// Line dash of a teammate (1) and of a third driver of the team (2): dashed
// and dash-dot, never dotted (a dotted line is a projection: the predicted
// total of the championship chart, PREDICTION_DASH '1,4')
export const TEAMMATE_DASHES = [null, '6,3', '8,3,2,3'];

/**
 * Colour of a driver: his team colour, or the teammate tint for the second
 * (and a third) driver of a team (V3), so they are never drawn identical. Live
 * session-derived team assignments (set via `setSessionDriverColors`) take
 * priority over the static 2024 fallback map, so 2025 line-up changes (HAM →
 * Ferrari, SAI → Williams, ANT → Mercedes, etc.) are reflected automatically.
 */
export function getDriverColor(abbr) {
  const base = getDriverTeamColor(abbr);
  if (base === UNKNOWN_TEAM_COLOR) return base;
  const i = teammateIndex(abbr);
  return i > 0 ? teammateTint(base, i) : base;
}

/** stroke-dasharray of a driver's line: null (solid) or the teammate dash. */
export function getDriverDash(abbr) {
  const i = teammateIndex(abbr);
  return TEAMMATE_DASHES[Math.min(i, TEAMMATE_DASHES.length - 1)] || null;
}

/**
 * Everything a view needs to draw a driver: identity colour (teammate tint
 * included), dash, mark colour (>= 3:1), text colour (>= 4.5:1) and the text
 * colour of a badge filled with the identity colour.
 *
 * @param {string} abbr
 * @param {string} [surface=CHART_SURFACE]
 */
export function driverStyle(abbr, surface = CHART_SURFACE) {
  const color = getDriverColor(abbr);
  return {
    color,
    teamColor: getDriverTeamColor(abbr),
    teammate: teammateIndex(abbr),
    dash: getDriverDash(abbr),
    mark: markColor(color, surface),
    text: textColor(color, surface),
    badgeText: contrastText(color),
  };
}

// Tyre compound text color (for contrast on tyre background): black or white
// by contrast (contrastText)
export function getTyreTextColor(compound) {
  return contrastText(tyreColor(compound));
}

// 3-letter IOC/FIFA country codes (used by FastF1) → 2-letter ISO 3166-1 alpha-2
const COUNTRY_TO_ISO2 = {
  NED: 'NL', GBR: 'GB', ESP: 'ES', MON: 'MC', AUS: 'AU', MEX: 'MX',
  FRA: 'FR', CAN: 'CA', GER: 'DE', FIN: 'FI', JPN: 'JP', THA: 'TH',
  CHN: 'CN', DEN: 'DK', USA: 'US', NZL: 'NZ', ITA: 'IT', BRA: 'BR',
  ARG: 'AR', COL: 'CO', IND: 'IN', RUS: 'RU', POL: 'PL', ISR: 'IL',
  SUI: 'CH', AUT: 'AT', BEL: 'BE', POR: 'PT', RSA: 'ZA', KOR: 'KR',
  SWE: 'SE', IRL: 'IE', VEN: 'VE', IDN: 'ID', MAL: 'MY',
};

// Convert 3-letter country code to flag emoji
export function countryFlag(code3) {
  const iso2 = COUNTRY_TO_ISO2[code3];
  if (!iso2) return '';
  return String.fromCodePoint(...[...iso2].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

// F1 points system (top 10 finishers)
export const F1_POINTS = { 1:25, 2:18, 3:15, 4:12, 5:10, 6:8, 7:6, 8:4, 9:2, 10:1 };
