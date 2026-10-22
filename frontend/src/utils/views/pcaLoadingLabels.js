/**
 * Label layout of the loading arrows of the PCA biplot
 * (components/visualizations/PCABiplot.jsx): each feature's name next to the
 * tip of its arrow, no two labels overlapping, clear of the chart's own text
 * and controls, and clear of the points where there is room.
 *
 * Box of a label (labelBox): beyond the tip of its arrow, along the arrow's
 * direction u, touching the anchor point (tip + gap along u): to the right of
 * a rightward arrow, above an upward one, moving continuously in between, so
 * the arrow's own line never runs through its label.
 *
 * Placement (placeLoadingLabels), greedy, longest loading first (the arrows
 * that matter most keep their place): the candidates of a label are its box
 * pushed further along u (steps of `step` px) and moved sideways, across u,
 * by whole lanes (a lane = the box's extent across u plus the pad), on either
 * side, also pulled back beside the arrow when the tip is near the edge.
 * A candidate is ruled out when it leaves the bounds, overlaps a label
 * already placed or a fixed obstacle (other text, a control), or crosses its
 * own arrow. Among the rest the cheapest wins: distance moved + POINT_COST
 * per point covered + LINE_COST per other arrow it covers and per leader or
 * label its own leader would cross, a side bias that keeps the labels in the
 * order of their tips. Points are avoided within NEAR_H label heights of the
 * first choice only: a label goes further only when nothing nearer is free
 * of the other labels, never to dodge points (a long leader through a dense
 * cloud reads worse than a label over a few points). A label that has moved
 * gets a leader line from the tip. A label with no candidate is not drawn
 * (placed: false); the view shows it on hover and keyboard focus.
 *
 * Boxes are {x0, y0, x1, y1} in the plot's coordinates (px, y down).
 *
 * Pure module: no React, no D3, no DOM.
 */

/** Gap between the tip of an arrow and its label, px. */
export const LABEL_GAP = 4;
/** Gap kept between two label boxes, px. */
export const LABEL_PAD = 2;
/** Cost of covering one point, in px of displacement: a point-free place within NEAR_H label heights wins. */
export const POINT_COST = 1000;
/** Cost of running across another arrow, in px of displacement. */
export const LINE_COST = 30;
/**
 * Width of a character of the label font, in em: the estimate used where the
 * text cannot be measured (tests, server rendering); the view measures the
 * real font in the browser.
 */
export const CHAR_EM = 0.62;
// Push along the arrow: step, and reach beyond the label's own extent, in label heights
const STEP_H = 0.5;
const REACH_H = 2;
/** Moves up to this many label heights are near: points are avoided within them. */
export const NEAR_H = 4;
// Cost of a move past NEAR_H: taken only when no nearer place is free of the labels
const FAR_COST = 1e6;
// Lanes tried on either side of the arrow
const LANES = 3;
// Cost of the side against the order of the tips (breaks ties only)
const SIDE_BIAS = 0.5;
const EPS = 1e-9;

/** Share of the smaller side of the plot the longest arrow drawn spans. */
export const ARROW_SHARE = 0.35;
/** Arrows drawn: the largest loadings, at most this many. */
export const MAX_ARROWS = 8;

/**
 * The loading arrows drawn: the MAX_ARROWS largest loadings (the artefact
 * lists them largest first), from the origin, scaled so that the longest
 * spans ARROW_SHARE of the plot's smaller side; an arrow whose tip falls more
 * than 10 px outside the plot is left out.
 *
 * @param {Array<{feature?: string, label: string, pc1: number, pc2: number}>} loadings
 * @param {{originX: number, originY: number, innerW: number, innerH: number}} plot
 * @returns {Array<{key: string, label: string, x0: number, y0: number, x1: number, y1: number}>}
 */
export function loadingArrows(loadings, {
  originX, originY, innerW, innerH,
}) {
  const top = (loadings || []).slice(0, MAX_ARROWS);
  if (!top.length) return [];
  const maxLoading = Math.max(...top.map((l) => Math.hypot(l.pc1, l.pc2)));
  const scale = (Math.min(innerW, innerH) * ARROW_SHARE) / (maxLoading || 1);
  return top.map((l) => ({
    key: l.feature || l.label,
    label: l.label,
    x0: originX,
    y0: originY,
    x1: originX + l.pc1 * scale,
    // y down on screen
    y1: originY - l.pc2 * scale,
  })).filter((a) => a.x1 >= -10 && a.x1 <= innerW + 10 && a.y1 >= -10 && a.y1 <= innerH + 10);
}

/** Estimated size of a label (where it cannot be measured). */
export function estimateLabelSize(text, fontPx) {
  return { w: String(text || '').length * fontPx * CHAR_EM, h: fontPx * 1.25 };
}

/** True when two boxes overlap (touching edges do not). */
export function boxesOverlap(a, b) {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS
    && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS;
}

/** Box grown by `pad` on every side. */
export function inflate(b, pad) {
  return { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
}

/** True when `b` lies inside `bounds`. */
function inside(b, bounds) {
  return b.x0 >= bounds.x0 - EPS && b.y0 >= bounds.y0 - EPS && b.x1 <= bounds.x1 + EPS && b.y1 <= bounds.y1 + EPS;
}

/**
 * True when the segment (x0, y0)-(x1, y1) passes through the box
 * (Liang-Barsky clipping; a segment that only touches an edge does not).
 */
export function segmentHitsBox(s, b) {
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    if (Math.abs(p) < EPS) return q > EPS;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, s.x0 - b.x0) || !clip(dx, b.x1 - s.x0) || !clip(-dy, s.y0 - b.y0) || !clip(dy, b.y1 - s.y0)) return false;
  return t1 - t0 > EPS;
}

/** Unit direction of an arrow (tip minus start), (1, 0) for a zero-length one. */
export function arrowDirection(a) {
  const dx = a.x1 - a.x0;
  const dy = a.y1 - a.y0;
  const len = Math.hypot(dx, dy);
  return len > EPS ? { ux: dx / len, uy: dy / len, len } : { ux: 1, uy: 0, len: 0 };
}

/**
 * Box of a label of size w x h whose anchor is (ax, ay), grown along the unit
 * direction (ux, uy): its centre on the ray from the anchor, at the distance
 * where the anchor lies on its edge.
 */
export function labelBox(ax, ay, ux, uy, w, h) {
  const tx = Math.abs(ux) > EPS ? w / 2 / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > EPS ? h / 2 / Math.abs(uy) : Infinity;
  const t = Math.min(tx, ty);
  const cx = ax + ux * t;
  const cy = ay + uy * t;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/** True when two segments cross (touching at an end does not count). */
export function segmentsCross(p, q) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(q.x0, q.y0, q.x1, q.y1, p.x0, p.y0);
  const d2 = d(q.x0, q.y0, q.x1, q.y1, p.x1, p.y1);
  const d3 = d(p.x0, p.y0, p.x1, p.y1, q.x0, q.y0);
  const d4 = d(p.x0, p.y0, p.x1, p.y1, q.x1, q.y1);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** Point of box `b` closest to (x, y): where a leader line from (x, y) ends. */
export function nearestPointOnBox(b, x, y) {
  return { x: Math.min(b.x1, Math.max(b.x0, x)), y: Math.min(b.y1, Math.max(b.y0, y)) };
}

const shift = (b, dx, dy) => ({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy });
const centre = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

/**
 * Place the labels of the loading arrows.
 *
 * @param {Object} o
 * @param {Array<{key: string, x0: number, y0: number, x1: number, y1: number, w: number, h: number}>} o.arrows
 *   arrow from (x0, y0) to its tip (x1, y1), and the size of its label
 * @param {{x0: number, y0: number, x1: number, y1: number}} o.bounds - where labels may go
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} [o.obstacles] - never covered
 * @param {Array<{x0: number, y0: number, x1: number, y1: number}>} [o.points] - covered only when nothing else fits
 * @param {number} [o.gap] - tip to label, px
 * @param {number} [o.pad] - between two labels, px
 * @returns {Array<{key: string, placed: boolean, box: Object, anchor: {x: number, y: number},
 *   moved: boolean, leader: {x1: number, y1: number, x2: number, y2: number}|null, points: number}>}
 *   one entry per arrow, in the order given; box of a label not placed = its
 *   first choice, clamped into the bounds (where the view shows it on hover)
 */
export function placeLoadingLabels({
  arrows, bounds, obstacles = [], points = [], gap = LABEL_GAP, pad = LABEL_PAD,
}) {
  const list = (arrows || []).map((a, i) => ({ ...a, i, ...arrowDirection(a) }));
  // longest first; equal lengths keep the order given
  const order = [...list].sort((a, b) => b.len - a.len || a.i - b.i);
  const segments = list.map((a) => ({ key: a.key, x0: a.x0, y0: a.y0, x1: a.x1, y1: a.y1 }));
  const placedBoxes = [];
  const out = new Array(list.length);

  for (const a of order) {
    const { ux, uy, w, h } = a;
    // across u (y down: the normal on the right of the direction)
    const nx = -uy;
    const ny = ux;
    const ax = a.x1 + ux * gap;
    const ay = a.y1 + uy * gap;
    const home = labelBox(ax, ay, ux, uy, w, h);
    const lane = Math.abs(nx) * w + Math.abs(ny) * h + pad;
    const along = Math.abs(ux) * w + Math.abs(uy) * h;
    const step = Math.max(1, h * STEP_H);
    const reach = h * REACH_H + along;
    // the side the tip lies on, against the labels its first choice overlaps:
    // moving that way keeps the labels in the order of their tips
    let side = 0;
    for (const p of placedBoxes) {
      if (boxesOverlap(inflate(home, pad / 2), inflate(p.box, pad / 2))) {
        const c = centre(p.box);
        side += nx * (a.x1 - c.x) + ny * (a.y1 - c.y);
      }
    }
    const sideSign = Math.sign(side);

    let best = null;
    const near = h * NEAR_H;
    const consider = (s, k) => {
      const box = shift(home, ux * s + nx * k * lane, uy * s + ny * k * lane);
      if (!inside(box, bounds)) return;
      const padded = inflate(box, pad / 2);
      for (const p of placedBoxes) if (boxesOverlap(padded, inflate(p.box, pad / 2))) return;
      for (const o of obstacles) if (boxesOverlap(box, o)) return;
      if (segmentHitsBox(a, box)) return;
      const moved = s !== 0 || k !== 0;
      const distance = Math.hypot(s, k * lane);
      let covered = 0;
      if (distance <= near + EPS) for (const p of points) if (boxesOverlap(box, p)) covered += 1;
      let crossed = 0;
      for (const sg of segments) if (sg.key !== a.key && segmentHitsBox(sg, box)) crossed += 1;
      if (moved) {
        const end = nearestPointOnBox(box, a.x1, a.y1);
        const leader = { x0: a.x1, y0: a.y1, x1: end.x, y1: end.y };
        for (const p of placedBoxes) {
          if (segmentHitsBox(leader, p.box)) crossed += 1;
          if (p.leader && segmentsCross(leader, p.leader)) crossed += 1;
        }
      }
      const cost = distance + POINT_COST * covered + LINE_COST * crossed + (distance > near + EPS ? FAR_COST : 0)
        + (k !== 0 && sideSign !== 0 && Math.sign(k) !== sideSign ? SIDE_BIAS : 0);
      if (!best || cost < best.cost - EPS) best = { box, cost, covered, moved };
    };
    for (let s = 0; s <= reach + EPS; s += step) {
      for (let k = 0; k <= LANES; k += 1) {
        consider(s, k);
        if (k) consider(s, -k);
      }
    }
    // pulled back beside the arrow (a tip near the edge of the plot)
    for (let s = -step; s >= -along - EPS; s -= step) {
      for (let k = 1; k <= LANES; k += 1) {
        consider(s, k);
        consider(s, -k);
      }
    }

    if (best) {
      const end = nearestPointOnBox(best.box, a.x1, a.y1);
      placedBoxes.push({
        key: a.key, box: best.box, leader: best.moved ? { x0: a.x1, y0: a.y1, x1: end.x, y1: end.y } : null,
      });
      out[a.i] = {
        key: a.key,
        placed: true,
        box: best.box,
        anchor: { x: ax, y: ay },
        moved: best.moved,
        leader: best.moved ? { x1: a.x1, y1: a.y1, x2: end.x, y2: end.y } : null,
        points: best.covered,
      };
    } else {
      // where it is shown on hover: the first choice, kept inside the bounds
      const dx = Math.max(bounds.x0 - home.x0, Math.min(0, bounds.x1 - home.x1));
      const dy = Math.max(bounds.y0 - home.y0, Math.min(0, bounds.y1 - home.y1));
      out[a.i] = {
        key: a.key, placed: false, box: shift(home, dx, dy), anchor: { x: ax, y: ay }, moved: false, leader: null, points: 0,
      };
    }
  }
  return out;
}
