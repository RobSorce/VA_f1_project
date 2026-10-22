// Label layout of the PCA biplot's loading arrows (utils/views/pcaLoadingLabels.js):
// the boxes grow away from the tip along the arrow, a crowded label moves
// along the arrow or sideways by whole lanes with a leader line, the order
// of the tips is kept, points are avoided where there is room, obstacles and
// the bounds never, and a label with no room is left to hover and focus,
// the longest loadings labelled first. Then the real artefact
// (backend/data/processed/pca_embeddings.json) laid out as the biplot draws
// it, 2024 R16 filtered ("This race"), at the plot sizes of the owner's screens.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as d3 from 'd3';
import {
  placeLoadingLabels, loadingArrows, labelBox, boxesOverlap, segmentHitsBox, estimateLabelSize,
  arrowDirection, segmentsCross, LABEL_GAP, MAX_ARROWS, NEAR_H,
} from '../utils/views/pcaLoadingLabels.js';
import { markRadius } from '../utils/views/pcaBiplot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMBEDDINGS = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../../backend/data/processed/pca_embeddings.json'), 'utf8'));

const BOUNDS = { x0: 0, y0: 0, x1: 600, y1: 400 };
const arrow = (key, x1, y1, { x0 = 300, y0 = 200, w = 100, h = 14 } = {}) => ({ key, x0, y0, x1, y1, w, h });
const overlapPairs = (boxes) => {
  const out = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i], boxes[j])) out.push([i, j]);
  return out;
};
const contains = (outer, b) => b.x0 >= outer.x0 - 1e-9 && b.y0 >= outer.y0 - 1e-9 && b.x1 <= outer.x1 + 1e-9 && b.y1 <= outer.y1 + 1e-9;

describe('label boxes', () => {
  it('grow away from the tip: right of a rightward arrow, above an upward one, never across the arrow', () => {
    const right = labelBox(10, 20, 1, 0, 80, 12);
    expect(right).toEqual({ x0: 10, y0: 14, x1: 90, y1: 26 });
    const up = labelBox(10, 20, 0, -1, 80, 12);
    expect(up).toEqual({ x0: -30, y0: 8, x1: 50, y1: 20 });
    // any direction: the anchor on the box edge, the line behind it outside
    for (let deg = 0; deg < 360; deg += 7.5) {
      const ux = Math.cos((deg * Math.PI) / 180);
      const uy = Math.sin((deg * Math.PI) / 180);
      const b = labelBox(100, 100, ux, uy, 90, 13);
      const onEdge = Math.abs(b.x0 - 100) < 1e-6 || Math.abs(b.x1 - 100) < 1e-6 || Math.abs(b.y0 - 100) < 1e-6 || Math.abs(b.y1 - 100) < 1e-6;
      expect(onEdge).toBe(true);
      expect(segmentHitsBox({ x0: 100 - 60 * ux, y0: 100 - 60 * uy, x1: 100, y1: 100 }, b)).toBe(false);
    }
  });

  it('segments: two crossing, two apart, two meeting at an end', () => {
    expect(segmentsCross({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 0, y0: 10, x1: 10, y1: 0 })).toBe(true);
    expect(segmentsCross({ x0: 0, y0: 0, x1: 10, y1: 0 }, { x0: 0, y0: 5, x1: 10, y1: 5 })).toBe(false);
    expect(segmentsCross({ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 10, y0: 10, x1: 20, y1: 0 })).toBe(false);
  });

  it('segments: through, beside, and touching a box', () => {
    const b = { x0: 0, y0: 0, x1: 10, y1: 10 };
    expect(segmentHitsBox({ x0: -5, y0: 5, x1: 15, y1: 5 }, b)).toBe(true);
    expect(segmentHitsBox({ x0: 2, y0: 2, x1: 3, y1: 3 }, b)).toBe(true);
    expect(segmentHitsBox({ x0: -5, y0: 12, x1: 15, y1: 12 }, b)).toBe(false);
    expect(segmentHitsBox({ x0: -5, y0: 10, x1: 15, y1: 10 }, b)).toBe(false);
  });
});

describe('placeLoadingLabels', () => {
  it('a lone arrow keeps its label at the tip, with no leader', () => {
    const [l] = placeLoadingLabels({ arrows: [arrow('a', 400, 200)], bounds: BOUNDS });
    expect(l.placed).toBe(true);
    expect(l.moved).toBe(false);
    expect(l.leader).toBeNull();
    expect(l.box.x0).toBeCloseTo(400 + LABEL_GAP, 9);
    expect((l.box.y0 + l.box.y1) / 2).toBeCloseTo(200, 9);
  });

  it('a bundle of near-parallel arrows: every label placed, none overlapping, in the order of the tips, leaders from the tips', () => {
    // four arrows within 6 degrees of each other, tips a few px apart (the PC1 features)
    const tip = (deg, len) => [300 + len * Math.cos((deg * Math.PI) / 180), 200 - len * Math.sin((deg * Math.PI) / 180)];
    const arrows = [
      arrow('race', ...tip(-1.7, 109)), arrow('s2', ...tip(0.4, 101)),
      arrow('s3', ...tip(-3.8, 100)), arrow('s1', ...tip(-5.4, 98)),
    ];
    const out = placeLoadingLabels({ arrows, bounds: BOUNDS });
    expect(out.every((l) => l.placed)).toBe(true);
    expect(overlapPairs(out.map((l) => l.box))).toEqual([]);
    const byTip = [...arrows].sort((a, b) => a.y1 - b.y1).map((a) => a.key);
    const byBox = [...out].sort((a, b) => a.box.y0 - b.box.y0).map((l) => l.key);
    expect(byBox).toEqual(byTip);
    // the longest keeps its place; the others moved and point back to their tips
    expect(out[0].moved).toBe(false);
    for (const l of out.slice(1)) {
      const a = arrows.find((x) => x.key === l.key);
      expect(l.moved).toBe(true);
      expect([l.leader.x1, l.leader.y1]).toEqual([a.x1, a.y1]);
      // the leader ends on the label's edge
      const { x2, y2 } = l.leader;
      expect(x2 >= l.box.x0 && x2 <= l.box.x1 && y2 >= l.box.y0 && y2 <= l.box.y1).toBe(true);
    }
  });

  it('a point on the first choice moves the label off it (with a leader); obstacles and bounds are never covered', () => {
    const a = arrow('a', 400, 200);
    const first = labelBox(400 + LABEL_GAP, 200, 1, 0, a.w, a.h);
    const point = { x0: first.x0 + 20, y0: 195, x1: first.x0 + 30, y1: 205 };
    const [l] = placeLoadingLabels({ arrows: [a], bounds: BOUNDS, points: [point] });
    expect(l.placed).toBe(true);
    expect(l.points).toBe(0);
    expect(boxesOverlap(l.box, point)).toBe(false);
    expect(l.leader).not.toBeNull();

    // a text above and below, the right edge close: still clear of all three
    const obstacles = [{ x0: 380, y0: 170, x1: 600, y1: 192 }, { x0: 380, y0: 208, x1: 600, y1: 230 }];
    const tight = { ...BOUNDS, x1: 520 };
    const [m] = placeLoadingLabels({ arrows: [a], bounds: tight, obstacles });
    if (m.placed) {
      expect(contains(tight, m.box)).toBe(true);
      expect(obstacles.some((o) => boxesOverlap(o, m.box))).toBe(false);
    }
  });

  it('covers points only when nothing else fits, and then as few as it can', () => {
    const a = arrow('a', 400, 200, { w: 60, h: 12 });
    // points everywhere in reach but one gap row
    const points = [];
    for (let x = 300; x < 600; x += 8) for (let y = 150; y < 260; y += 8) if (y !== 222) points.push({ x0: x, y0: y, x1: x + 4, y1: y + 4 });
    const [l] = placeLoadingLabels({ arrows: [a], bounds: BOUNDS, points });
    expect(l.placed).toBe(true);
    const covered = points.filter((p) => boxesOverlap(p, l.box)).length;
    expect(covered).toBe(l.points);
    // a crowded field: the label stays near its arrow, covering points rather than vanishing
    expect(Math.hypot((l.box.x0 + l.box.x1) / 2 - 434, (l.box.y0 + l.box.y1) / 2 - 200)).toBeLessThan(150);
  });

  it('never goes far to dodge points: in a dense cloud it stays within NEAR_H label heights, over as few points as it can', () => {
    const a = arrow('a', 300, 200, { x0: 200, w: 60, h: 12 });
    // points everywhere within 70 px of the tip; free space beyond
    const points = [];
    for (let x = 230; x < 380; x += 6) for (let y = 130; y < 270; y += 6) points.push({ x0: x, y0: y, x1: x + 3, y1: y + 3 });
    const [l] = placeLoadingLabels({ arrows: [a], bounds: BOUNDS, points });
    const first = labelBox(300 + LABEL_GAP, 200, 1, 0, a.w, a.h);
    const moved = Math.hypot(l.box.x0 - first.x0, l.box.y0 - first.y0);
    expect(l.placed).toBe(true);
    expect(moved).toBeLessThanOrEqual(NEAR_H * a.h + 1e-9);
    expect(l.points).toBeGreaterThan(0);
  });

  it('no room: the label is not placed (shown on hover), the longest loading keeps its label, the box stays in the bounds', () => {
    // two arrows to the same tip in a plot only wide enough for one label beside it
    const bounds = { x0: 0, y0: 0, x1: 520, y1: 216 };
    const arrows = [arrow('short', 398, 200), arrow('long', 400, 200)];
    const out = placeLoadingLabels({ arrows, bounds, obstacles: [{ x0: 0, y0: 0, x1: 520, y1: 192 }] });
    const long = out.find((l) => l.key === 'long');
    const short = out.find((l) => l.key === 'short');
    expect(long.placed).toBe(true);
    expect(short.placed).toBe(false);
    expect(short.leader).toBeNull();
    expect(contains(bounds, short.box)).toBe(true);
  });

  it('is pure: the input is left as it was and the same input gives the same layout', () => {
    const arrows = [arrow('a', 400, 200), arrow('b', 401, 203), arrow('c', 300, 120)];
    const copy = JSON.parse(JSON.stringify(arrows));
    const one = placeLoadingLabels({ arrows, bounds: BOUNDS });
    expect(arrows).toEqual(copy);
    expect(placeLoadingLabels({ arrows, bounds: BOUNDS })).toEqual(one);
    expect(placeLoadingLabels({ arrows: [], bounds: BOUNDS })).toEqual([]);
  });
});

describe('the real loadings, 2024 R16 ("This race"), as the biplot lays them out', () => {
  const MARGIN = { top: 15, right: 15, bottom: 36, left: 46 };
  // plot svg sizes of the biplot pane at 1536x864, 1920x1080 and 2048x1152
  // (the pane's own size changes with the dock and the window), and a small one
  const SIZES = [[702, 494], [893, 709], [956, 781], [420, 300]];
  const FONT_PX = 12;

  function layout([width, height]) {
    const innerW = width - MARGIN.left - MARGIN.right;
    const innerH = height - MARGIN.top - MARGIN.bottom;
    const pts = EMBEDDINGS.points;
    const xe = d3.extent(pts, (p) => p.x);
    const ye = d3.extent(pts, (p) => p.y);
    const xp = (xe[1] - xe[0]) * 0.12;
    const yp = (ye[1] - ye[0]) * 0.12;
    const x = d3.scaleLinear().domain([xe[0] - xp, xe[1] + xp]).range([0, innerW]);
    const y = d3.scaleLinear().domain([ye[0] - yp, ye[1] + yp]).range([innerH, 0]);
    const arrows = loadingArrows(EMBEDDINGS.loadings, { originX: x(0), originY: y(0), innerW, innerH })
      .map((a) => ({ ...a, ...estimateLabelSize(a.label, FONT_PX) }));
    const r = markRadius(true) + 1;
    const stars = pts.filter((p) => p.year === 2024 && p.round === 16)
      .map((p) => ({ x0: x(p.x) - r, y0: y(p.y) - r, x1: x(p.x) + r, y1: y(p.y) + r }));
    const bounds = { x0: 0, y0: 0, x1: innerW, y1: innerH };
    return { arrows, stars, bounds, out: placeLoadingLabels({ arrows, bounds, points: stars }) };
  }

  it(`draws the ${MAX_ARROWS} largest loadings, the four PC1 pace features within 6 degrees of each other`, () => {
    const { arrows } = layout(SIZES[0]);
    expect(arrows).toHaveLength(MAX_ARROWS);
    const angle = (key) => {
      const a = arrows.find((v) => v.key === key);
      const { ux, uy } = arrowDirection(a);
      return (Math.atan2(-uy, ux) * 180) / Math.PI;
    };
    const pace = ['pace_delta_pct', 'sector2_delta_pct', 'sector3_delta_pct', 'sector1_delta_pct']
      .filter((k) => arrows.some((a) => a.key === k));
    expect(pace).toHaveLength(4);
    const angles = pace.map(angle);
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(6);
  });

  for (const size of SIZES) {
    it(`${size[0]} x ${size[1]}: no two labels overlap, none leaves the plot or crosses its arrow${size[0] > 600 ? ', every label placed clear of the stars' : ''}`, () => {
      const { arrows, stars, bounds, out } = layout(size);
      const shown = out.filter((l) => l.placed);
      expect(overlapPairs(shown.map((l) => l.box))).toEqual([]);
      for (const l of shown) {
        expect(contains(bounds, l.box)).toBe(true);
        expect(segmentHitsBox(arrows.find((a) => a.key === l.key), l.box)).toBe(false);
      }
      if (size[0] > 600) {
        expect(shown).toHaveLength(arrows.length);
        expect(shown.filter((l) => stars.some((s) => boxesOverlap(s, l.box))).map((l) => l.key)).toEqual([]);
      }
    });
  }
});
