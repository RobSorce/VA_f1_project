/**
 * Value in CSS px of a length expression as tokens.css declares it, e.g.
 * 'clamp(11px, calc(7.786px + 0.4286vh), 12.5px)'.
 *
 * Why: a browser returns an unregistered custom property (no @property) as
 * its declared token sequence, math functions NOT evaluated (CSS Custom
 * Properties L1, section 2.2), so getPropertyValue('--font-size-data') is
 * that string and parseFloat of it is NaN. Layout code that measures text
 * (colors.js chartFontPx) evaluates it here with the viewport it runs in.
 *
 * Supported: numbers with px, rem, em (= rem: tokens are read on the root),
 * vh, vw, vmin, vmax or no unit; + - * / and parentheses; calc(), min(),
 * max(), clamp(). Anything else (var(), %, an unknown unit) -> NaN.
 *
 * Pure module: no DOM access.
 */

const UNIT = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|rem|em|vh|vw|vmin|vmax)?/i;

/**
 * @param {string} expr - the declared value
 * @param {{W: number, H: number, root?: number}} viewport - innerWidth,
 *   innerHeight and the root font size in px (16 when omitted)
 * @returns {number} px, NaN when the expression cannot be evaluated
 */
export function evalCssLength(expr, { W, H, root = 16 }) {
  if (typeof expr !== 'string') return NaN;
  const s = expr.trim().toLowerCase();
  if (!s) return NaN;
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
  const fail = () => { throw new Error(`cssLength: cannot read "${expr}" at ${i}`); };
  const unitPx = (n, unit) => {
    switch (unit) {
      case 'px': case undefined: case '': return n;
      case 'rem': case 'em': return n * root;
      case 'vh': return (n * H) / 100;
      case 'vw': return (n * W) / 100;
      case 'vmin': return (n * Math.min(W, H)) / 100;
      case 'vmax': return (n * Math.max(W, H)) / 100;
      default: return fail();
    }
  };
  let sum;
  const args = () => {
    const out = [];
    ws();
    if (s[i] !== '(') fail();
    i += 1;
    for (;;) {
      out.push(sum());
      ws();
      if (s[i] === ',') { i += 1; continue; }
      if (s[i] === ')') { i += 1; return out; }
      fail();
    }
  };
  const atom = () => {
    ws();
    const rest = s.slice(i);
    const fn = rest.match(/^(calc|min|max|clamp)(?=\()/);
    if (fn) {
      i += fn[1].length;
      const a = args();
      if (fn[1] === 'calc') { if (a.length !== 1) fail(); return a[0]; }
      if (fn[1] === 'min') return Math.min(...a);
      if (fn[1] === 'max') return Math.max(...a);
      if (a.length !== 3) fail();
      return Math.max(a[0], Math.min(a[1], a[2]));
    }
    if (s[i] === '(') {
      i += 1;
      const v = sum();
      ws();
      if (s[i] !== ')') fail();
      i += 1;
      return v;
    }
    if (s[i] === '-' && !/\d|\./.test(s[i + 1] || '')) { i += 1; return -atom(); }
    const m = rest.match(UNIT);
    if (!m) fail();
    i += m[0].length;
    if (/^[a-z%]/.test(s[i] || '')) fail(); // an unknown unit or a %
    return unitPx(parseFloat(m[1]), m[2]);
  };
  const product = () => {
    let v = atom();
    for (;;) {
      ws();
      if (s[i] === '*') { i += 1; v *= atom(); } else if (s[i] === '/') { i += 1; v /= atom(); } else return v;
    }
  };
  sum = () => {
    let v = product();
    for (;;) {
      ws();
      if (s[i] === '+') { i += 1; v += product(); } else if (s[i] === '-') { i += 1; v -= product(); } else return v;
    }
  };
  try {
    const v = sum();
    ws();
    return i === s.length && Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}
