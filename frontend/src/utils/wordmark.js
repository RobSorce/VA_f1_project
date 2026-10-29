/**
 * Geometry of the drawn wordmark (components/ui/Wordmark.jsx): the name in
 * Inter Medium, wide tracked, over a thin line that runs straight, steps down
 * and back up in a short chicane jog under the 3rd-4th letter, with a dot at
 * the bottom of the jog, then runs on to the end of the word.
 *
 * Units: the SVG user unit, with the name drawn at font-size 100, so 1 em of
 * the element the SVG sits in is 100 units. The baseline is y = 0. The word
 * is drawn with textLength = width and lengthAdjust="spacing": whatever face
 * draws it (Inter, or the fallback before Inter has loaded), its advances end
 * at x = width, where the line ends.
 */

export const FONT_SIZE = 100;

// Wide tracking between the letters, in em (lengthAdjust="spacing" adds it
// between the glyphs, not after the last one)
export const TRACKING_EM = 0.14;

// Cap height of Inter (sCapHeight 1490 of 2048 units per em)
export const CAP_HEIGHT_EM = 1490 / 2048;

// Advance widths of Inter Medium (public/fonts/inter/Inter-Medium.woff2), in
// 1/1000 em; a character not listed counts FALLBACK_ADVANCE. Checked against
// the font file in wordmark.test.jsx.
export const ADVANCE = {
  A: 709, B: 657, C: 733, D: 722, E: 603, F: 589, G: 748, H: 745, I: 272, J: 575, K: 688, L: 565, M: 913,
  N: 756, O: 767, P: 642, Q: 769, R: 648, S: 646, T: 653, U: 740, V: 709, W: 1003, X: 701, Y: 696, Z: 641,
  ' ': 267,
};
export const FALLBACK_ADVANCE = 680;

// The jog: its width as a share of the word's width, the share of it each
// diagonal takes (the flat bottom is the rest)
export const JOG_SHARE = 0.1;
export const JOG_DIAGONAL_SHARE = 0.25;

// Per size, in em: the gap from the baseline to the line, the line's stroke
// width, the depth of the jog and the dot's radius. The header line is
// heavier and its jog deeper for their size: at 13 px of text the line is
// still 1.3 px and the jog a step, not a dent.
export const SIZES = {
  header: { gap: 0.26, stroke: 0.1, depth: 0.26, dot: 0.11, centerCaps: true },
  hero: { gap: 0.2, stroke: 0.055, depth: 0.15, dot: 0.08, centerCaps: false },
};

const round = (v) => Math.round(v * 100) / 100;

/** Natural advance of `name` at FONT_SIZE, without tracking. */
export function naturalWidth(name) {
  return [...name].reduce((s, ch) => s + (ADVANCE[ch] ?? FALLBACK_ADVANCE), 0) * (FONT_SIZE / 1000);
}

/**
 * Everything the SVG draws for `name` at `size`, in user units.
 *
 * header: the view box is centred on the middle of the capitals, so in a row
 * of centred items the word sits where a line of text of the same size sits,
 * and the line hangs below it. hero: the view box is tight.
 */
export function wordmarkGeometry(name, size = 'header') {
  const key = SIZES[size] ? size : 'header';
  const s = SIZES[key];
  const chars = [...name];
  const n = chars.length;
  const track = TRACKING_EM * FONT_SIZE;
  const width = round(naturalWidth(name) + track * Math.max(0, n - 1));

  // x of the start of each letter with the tracking
  const starts = [];
  let x = 0;
  for (const ch of chars) {
    starts.push(x);
    x += (ADVANCE[ch] ?? FALLBACK_ADVANCE) * (FONT_SIZE / 1000) + track;
  }
  // centre of the jog: under the 3rd and 4th letters, from the start of the
  // 3rd to the end of the 4th
  const center = n >= 4
    ? (starts[2] + starts[3] + (ADVANCE[chars[3]] ?? FALLBACK_ADVANCE) * (FONT_SIZE / 1000)) / 2
    : 0.4 * width;
  const jogW = JOG_SHARE * width;
  const diag = JOG_DIAGONAL_SHARE * jogW;
  const x0 = round(Math.max(0, Math.min(width - jogW, center - jogW / 2)));
  const x3 = round(x0 + jogW);
  const x1 = round(x0 + diag);
  const x2 = round(x3 - diag);

  const lineY = round(s.gap * FONT_SIZE);
  const bottomY = round(lineY + s.depth * FONT_SIZE);
  const stroke = round(s.stroke * FONT_SIZE);
  const dotR = round(s.dot * FONT_SIZE);
  const below = bottomY + Math.max(dotR, stroke / 2);
  const cap = CAP_HEIGHT_EM * FONT_SIZE;
  // rounded outward: the capitals stay inside the view box
  const top = Math.floor((s.centerCaps ? -(cap + below) : -cap) * 100) / 100;
  const height = round(below - top);

  return {
    size: key,
    width,
    top,
    height,
    stroke,
    line: { y: lineY, bottom: bottomY, x0, x1, x2, x3 },
    path: `M0 ${lineY}H${x0}L${x1} ${bottomY}H${x2}L${x3} ${lineY}H${width}`,
    dot: { cx: round((x1 + x2) / 2), cy: bottomY, r: dotR },
  };
}
