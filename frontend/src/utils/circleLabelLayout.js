/**
 * Label layout of the Circle of Doom (components/visualizations/CircleOfDoom.jsx):
 * every label sits outside the ring on a circle of radius rLabel, as close as
 * possible to the angle of its mark, and no two label boxes overlap.
 *
 * Angles are radians clockwise from the top: anchor = (cx + r sin a, cy - r cos a).
 * Box of a label at angle a (labelBox): centred above its anchor at the top,
 * below it at the bottom, to its right / left on the sides, moving
 * continuously in between, so it always grows away from the ring.
 *
 * 1-D placement (resolveLabelAngles). The labels keep their order around the
 * circle. Two neighbours need the angle whose chord between their anchors
 * separates their boxes, horizontally or vertically, whichever comes first
 * (pairSeparation). Under those minimum gaps, the angles closest to the
 * wanted ones (least squares) are an isotonic regression, solved exactly by
 * pool-adjacent-violators on the chain cut at each possible place (the best
 * cut that also respects the gap across it wins). The gaps depend on the
 * angles (a box is wide at the top and short on the sides), so the solve runs
 * again from the new angles a few times.
 *
 * 2-D check (layoutProblems): every box inside the drawing, clear of the ring
 * (outside the disc of radius rClear), and no two boxes overlapping. The view
 * calls layoutLabels, which tries smaller fonts and other angles for the
 * rejoin label until the check passes, then shrinks the ring if it must.
 *
 * Pure module: no React, no D3, no DOM.
 */

const TWO_PI = 2 * Math.PI;
/**
 * Width of a character of the bold label font, in em: the estimate used where
 * the text cannot be measured (server rendering, tests); the view measures the
 * real font in the browser (geo.measure).
 */
export const CHAR_EM = 0.66;
/** Gap kept between two label boxes, px. */
export const LABEL_PAD = 3;
// Measured text: room for the tspan gap and the dark outline drawn around the glyphs
const MEASURE_SLACK = 4;
const RESOLVE_ITERATIONS = 6;
// Font sizes tried, as fractions of the base size
const FONT_STEPS = [1, 0.9, 0.8];
// Rejoin label: angles tried around its marker (5 degree steps), in bands of
// offset; a smaller font near the marker is preferred to the full font further away
const REJOIN_STEP = Math.PI / 36;
const REJOIN_BANDS = [Math.PI / 9, Math.PI / 4, (2 * Math.PI) / 3];
// Full layouts solved per layoutLabels call, at most
const MAX_SOLVES = 60;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Angle folded into [0, 2 pi). */
export function wrapAngle(a) {
  return a - TWO_PI * Math.floor(a / TWO_PI);
}

/** Point at `angle` on a circle of radius r around (cx, cy). */
export function polar(cx, cy, r, angle) {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

/**
 * Text box of a label: width and height in px for `lines` (strings) at font
 * size fs. With `measure(text, fs)` (px, the real font) the width is measured;
 * otherwise CHAR_EM per character.
 */
export function textBox(lines, fs, measure = null) {
  const w = measure
    ? Math.max(0, ...lines.map((l) => measure(l, fs))) + MEASURE_SLACK
    : Math.max(0, ...lines.map((l) => l.length)) * fs * CHAR_EM + 2;
  return { w, h: lines.length * (fs + 2) };
}

/** Offset of a label's box from its anchor at `angle`: [dx, dy] of the top-left corner. */
function labelOffset(label, angle) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return [
    -label.w / 2 + (label.w / 2) * clamp(2 * s, -1, 1),
    -label.h / 2 - (label.h / 2) * clamp(2 * c, -1, 1),
  ];
}

/**
 * Box of a label at `angle` on the label circle, [x0, y0, x1, y1] in px (not
 * clamped to the drawing).
 */
export function labelBox(label, angle, cx, cy, rLabel) {
  const [ax, ay] = polar(cx, cy, rLabel, angle);
  const [dx, dy] = labelOffset(label, angle);
  return [ax + dx, ay + dy, ax + dx + label.w, ay + dy + label.h];
}

/**
 * Angle between a (at ta) and the next label clockwise b (at tb >= ta) that
 * separates their boxes, with the boxes' offsets at ta and tb: the chord
 * between the anchors points along the mid angle, 2 r sin(d / 2) long.
 */
function pairSeparation(a, b, ta, tb, rLabel, pad) {
  const tm = (ta + tb) / 2;
  const [ax, ay] = labelOffset(a, ta);
  const [bx, by] = labelOffset(b, tb);
  const c = Math.cos(tm);
  const s = Math.sin(tm);
  let chord = Infinity;
  // b moves right (c > 0) or left (c < 0) of a; down (s > 0) or up (s < 0)
  const horizontal = c > 0 ? ax + a.w + pad - bx : bx + b.w + pad - ax;
  const vertical = s > 0 ? ay + a.h + pad - by : by + b.h + pad - ay;
  if (horizontal <= 0 || vertical <= 0) chord = 0;
  if (Math.abs(c) > 1e-9) chord = Math.min(chord, horizontal / Math.abs(c));
  if (Math.abs(s) > 1e-9) chord = Math.min(chord, vertical / Math.abs(s));
  if (!Number.isFinite(chord)) chord = 2 * rLabel;
  return 2 * Math.asin(clamp(chord / (2 * rLabel), 0, 1));
}

/** Non-decreasing least-squares fit of `values` (pool adjacent violators). */
function isotonic(values) {
  const sums = [];
  const counts = [];
  for (const v of values) {
    sums.push(v);
    counts.push(1);
    while (sums.length > 1) {
      const k = sums.length - 1;
      if (sums[k - 1] / counts[k - 1] <= sums[k] / counts[k]) break;
      sums[k - 1] += sums[k];
      counts[k - 1] += counts[k];
      sums.pop();
      counts.pop();
    }
  }
  const out = [];
  sums.forEach((sum, i) => {
    for (let j = 0; j < counts[i]; j++) out.push(sum / counts[i]);
  });
  return out;
}

/**
 * 1-D overlap removal along the angle (module header).
 *
 * @param {Array<{key: string, angle: number, w: number, h: number}>} labels - angle in radians, w/h in px
 * @param {number} rLabel - px
 * @param {Object} [opts]
 * @param {number} [opts.pad=3] - px kept between boxes
 * @returns {{labels: Array<Object>, feasible: boolean}} the labels (input order) with
 *   `placed` (radians in [0, 2 pi)); feasible = the gaps fit around the circle
 */
export function resolveLabelAngles(labels, rLabel, { pad = LABEL_PAD } = {}) {
  const n = labels.length;
  if (n < 2) return { labels: labels.map((l) => ({ ...l, placed: wrapAngle(l.angle) })), feasible: true };
  const order = labels.map((l, i) => i).sort((i, j) => (wrapAngle(labels[i].angle) - wrapAngle(labels[j].angle))
    || String(labels[i].key).localeCompare(String(labels[j].key)));
  const want = order.map((i) => wrapAngle(labels[i].angle));
  let at = want.slice();
  let feasible = true;
  for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
    // minimum gap between order[k] and order[k + 1], at the current angles
    const gaps = order.map((i, k) => {
      const next = (k + 1) % n;
      const ta = at[k];
      const tb = ta + wrapAngle(at[next] - ta);
      return pairSeparation(labels[i], labels[order[next]], ta, tb, rLabel, pad);
    });
    const total = gaps.reduce((s, g) => s + g, 0);
    feasible = total <= TWO_PI;
    if (!feasible) for (let k = 0; k < n; k++) gaps[k] *= TWO_PI / total;
    let best = null;
    for (let cut = 0; cut < n; cut++) {
      const wanted = [];
      const offsets = [];
      let off = 0;
      for (let m = 0; m < n; m++) {
        const k = (cut + m) % n;
        wanted.push(want[k] + (cut + m >= n ? TWO_PI : 0));
        offsets.push(off);
        off += gaps[k];
      }
      const fit = isotonic(wanted.map((w, m) => w - offsets[m]));
      const y = fit.map((z, m) => z + offsets[m]);
      const across = y[0] + TWO_PI - y[n - 1] - gaps[(cut + n - 1) % n];
      const cost = y.reduce((s, v, m) => s + (v - wanted[m]) ** 2, 0);
      const ok = across >= -1e-9;
      if (!best || (ok && !best.ok) || (ok === best.ok && (ok ? cost < best.cost : across > best.across))) {
        best = { ok, cost, across, cut, y };
      }
    }
    const next = new Array(n);
    for (let m = 0; m < n; m++) next[(best.cut + m) % n] = wrapAngle(best.y[m]);
    at = next;
  }
  const placed = new Array(n);
  order.forEach((i, k) => { placed[i] = at[k]; });
  return { labels: labels.map((l, i) => ({ ...l, placed: placed[i] })), feasible };
}

/** Overlap of two boxes along x and y (positive = overlapping by that much). */
function overlap(a, b) {
  return [Math.min(a[2], b[2]) - Math.max(a[0], b[0]), Math.min(a[3], b[3]) - Math.max(a[1], b[1])];
}

/** Distance from (cx, cy) to the nearest point of a box. */
function distanceToBox(box, cx, cy) {
  const dx = Math.max(box[0] - cx, 0, cx - box[2]);
  const dy = Math.max(box[1] - cy, 0, cy - box[3]);
  return Math.hypot(dx, dy);
}

/**
 * Problems of a set of boxes: outside the drawing, inside the ring's clear
 * disc, or overlapping another box (1 per pair).
 *
 * @param {Array<Array<number>>} boxes - [x0, y0, x1, y1] in px
 * @param {{width: number, height: number, cx: number, cy: number, rClear: number}} geo
 * @returns {number}
 */
export function layoutProblems(boxes, {
  width, height, cx, cy, rClear,
}) {
  let problems = 0;
  for (const b of boxes) {
    if (b[0] < 1 || b[1] < 1 || b[2] > width - 1 || b[3] > height - 1) problems += 1;
    if (distanceToBox(b, cx, cy) < rClear) problems += 1;
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [ox, oy] = overlap(boxes[i], boxes[j]);
      if (ox > 0 && oy > 0) problems += 1;
    }
  }
  return problems;
}

/**
 * Rejoin-label angles around its marker with an offset in (from, to]: nearest
 * first, alternately later / earlier (from = -1: the marker itself too).
 */
function rejoinAngles(angle, from, to) {
  const out = from < 0 ? [angle] : [];
  for (let d = REJOIN_STEP; d <= to + 1e-9; d += REJOIN_STEP) {
    if (d > from + 1e-9) out.push(angle + d, angle - d);
  }
  return out;
}

/**
 * Labels of the circle at their final angles and boxes.
 *
 * @param {Array<{key: string, angle: number, text: string}>} items - car labels:
 *   angle in radians, text = what is printed (its length sizes the box)
 * @param {{angle: number, variants: Array<Array<string>>}|null} rejoin - rejoin label:
 *   marker angle and the line sets it may use (preferred first)
 * @param {{width: number, height: number, cx: number, cy: number, rLabel: number,
 *   rClear: number, fontSize: number, minFontSize: number, measure?: function}} geo - px;
 *   measure(text, fontSize) = width in px of the text in the label font (optional)
 * @returns {{ok: boolean, problems: number, fontSize: number, lines: Array<string>|null,
 *   labels: Array<Object>}} labels: each item (and the rejoin label, key '__rejoin',
 *   rejoin: true) with w, h, placed (radians) and box [x0, y0, x1, y1]
 */
export function layoutLabels(items, rejoin, geo) {
  const {
    width, height, cx, cy, rLabel, rClear, fontSize, minFontSize, measure = null,
  } = geo;
  const boxOf = (lines, fs) => textBox(lines, fs, measure);
  const check = { width, height, cx, cy, rClear };
  let best = null;
  let solves = 0;

  const solve = (all) => {
    solves += 1;
    const { labels } = resolveLabelAngles(all, rLabel);
    const placed = labels.map((l) => ({ ...l, box: labelBox(l, l.placed, cx, cy, rLabel) }));
    return { placed, problems: layoutProblems(placed.map((l) => l.box), check) };
  };
  const keep = (result, fs, lines) => {
    if (!best || result.problems < best.problems) {
      best = {
        ok: result.problems === 0, problems: result.problems, fontSize: fs, lines, labels: result.placed,
      };
    }
    return result.problems === 0;
  };

  // Car labels at a font step; a crowded circle shrinks the font until the boxes can go round
  const carsAt = (step) => {
    let fs = Math.max(minFontSize, fontSize * step);
    let cars = items.map((it) => ({ key: it.key, angle: it.angle, ...boxOf([it.text], fs) }));
    const need = cars.reduce((s, l) => s + (2 / Math.PI) * (l.w + l.h) + LABEL_PAD, 0);
    if (need > TWO_PI * rLabel * 0.9) {
      fs = Math.max(minFontSize, fs * ((TWO_PI * rLabel * 0.9) / need));
      cars = items.map((it) => ({ key: it.key, angle: it.angle, ...boxOf([it.text], fs) }));
    }
    return { fs, cars };
  };

  if (!rejoin) {
    for (const step of FONT_STEPS) {
      const { fs, cars } = carsAt(step);
      if (keep(solve(cars), fs, null)) return best;
    }
    return best;
  }
  let from = -1;
  for (const to of REJOIN_BANDS) {
    for (const step of FONT_STEPS) {
      const { fs, cars } = carsAt(step);
      for (const lines of rejoin.variants) {
        const size = boxOf(lines, fs);
        for (const angle of rejoinAngles(rejoin.angle, from, to)) {
          // the rejoin label alone must fit at that angle first
          const own = labelBox(size, angle, cx, cy, rLabel);
          if (layoutProblems([own], check) > 0) continue;
          const label = {
            key: '__rejoin', angle, markerAngle: rejoin.angle, rejoin: true, ...size,
          };
          if (keep(solve([...cars, label]), fs, lines)) return best;
          if (solves >= MAX_SOLVES) break;
        }
        if (solves >= MAX_SOLVES) break;
      }
      if (solves >= MAX_SOLVES) break;
    }
    if (solves >= MAX_SOLVES) break;
    from = to;
  }
  if (!best && rejoin) {
    // Nowhere to put the rejoin label: report the car labels alone, not ok
    const fs = Math.max(minFontSize, fontSize * FONT_STEPS[FONT_STEPS.length - 1]);
    const cars = items.map((it) => ({ key: it.key, angle: it.angle, ...boxOf([it.text], fs) }));
    const result = solve(cars);
    best = {
      ok: false, problems: result.problems + 1, fontSize: fs, lines: null, labels: result.placed,
    };
  }
  return best;
}
