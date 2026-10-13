import { describe, it, expect } from 'vitest';
import {
  resolveLabelAngles, layoutLabels, layoutProblems, labelBox, textBox, wrapAngle, polar,
} from '../circleLabelLayout.js';

const DEG = Math.PI / 180;
const GEO = {
  width: 520, height: 360, cx: 260, cy: 180, rLabel: 140, rClear: 125, fontSize: 10, minFontSize: 7,
};
const label = (key, angleDeg, text = `${key} +12.3`, fs = 10) => ({ key, angle: angleDeg * DEG, ...textBox([text], fs) });

function overlaps(boxes) {
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const w = Math.min(boxes[i][2], boxes[j][2]) - Math.max(boxes[i][0], boxes[j][0]);
      const h = Math.min(boxes[i][3], boxes[j][3]) - Math.max(boxes[i][1], boxes[j][1]);
      if (w > 0 && h > 0) n += 1;
    }
  }
  return n;
}

describe('label boxes', () => {
  it('grow away from the ring: above at the top, right on the right, below at the bottom, left on the left', () => {
    const l = { w: 40, h: 12 };
    const { cx, cy, rLabel } = GEO;
    const [ax, ay] = polar(cx, cy, rLabel, 0);
    expect(labelBox(l, 0, cx, cy, rLabel)).toEqual([ax - 20, ay - 12, ax + 20, ay].map((v) => expect.closeTo(v, 9)));
    const right = labelBox(l, 90 * DEG, cx, cy, rLabel);
    expect(right[0]).toBeCloseTo(cx + rLabel, 9);
    const bottom = labelBox(l, 180 * DEG, cx, cy, rLabel);
    expect(bottom[1]).toBeCloseTo(cy + rLabel, 9);
    const left = labelBox(l, 270 * DEG, cx, cy, rLabel);
    expect(left[2]).toBeCloseTo(cx - rLabel, 9);
  });
});

describe('resolveLabelAngles', () => {
  it('labels with room stay at their angles', () => {
    const labels = [label('A', 10), label('B', 100), label('C', 200), label('D', 300)];
    const { labels: out, feasible } = resolveLabelAngles(labels, GEO.rLabel);
    expect(feasible).toBe(true);
    out.forEach((l, i) => expect(l.placed).toBeCloseTo(labels[i].angle, 9));
  });

  it('a pile at one angle fans out symmetrically, keeps a stable order, and no two boxes overlap', () => {
    const labels = ['VER', 'NOR', 'LEC', 'PIA', 'SAI', 'HAM', 'RUS', 'PER'].map((d) => label(d, 0, d));
    const { labels: out } = resolveLabelAngles(labels, GEO.rLabel);
    const signed = out.map((l) => (l.placed > Math.PI ? l.placed - 2 * Math.PI : l.placed));
    // centred on the wanted angle (least squares)
    expect(signed.reduce((s, a) => s + a, 0) / signed.length).toBeCloseTo(0, 6);
    // order around the circle = key order (ties broken by key)
    const byAngle = [...out].sort((a, b) => (a.placed > Math.PI ? a.placed - 2 * Math.PI : a.placed)
      - (b.placed > Math.PI ? b.placed - 2 * Math.PI : b.placed)).map((l) => l.key);
    expect(byAngle).toEqual([...byAngle].sort());
    expect(overlaps(out.map((l) => labelBox(l, l.placed, GEO.cx, GEO.cy, GEO.rLabel)))).toBe(0);
  });

  it('works across the timing line (a pile at 359 and 1 degrees)', () => {
    const labels = [label('A', 359), label('B', 359.5), label('C', 0.5), label('D', 1)];
    const { labels: out } = resolveLabelAngles(labels, GEO.rLabel);
    expect(overlaps(out.map((l) => labelBox(l, l.placed, GEO.cx, GEO.cy, GEO.rLabel)))).toBe(0);
    for (const l of out) expect(Math.min(l.placed, 2 * Math.PI - l.placed)).toBeLessThan(40 * DEG);
  });

  it('reports when the labels cannot go round the circle', () => {
    const labels = Array.from({ length: 40 }, (_, i) => label(`L${i}`, i, 'AAAAAAAAAAAAAAAA'));
    expect(resolveLabelAngles(labels, 60).feasible).toBe(false);
  });
});

describe('layoutLabels', () => {
  const cars = (n, at = () => 0) => Array.from({ length: n }, (_, i) => ({ key: `C${String(i).padStart(2, '0')}`, angle: at(i), text: `C${i} +88.8` }));

  it('20 cars at the line (race over): every box in the drawing, off the ring, no overlap', () => {
    const out = layoutLabels(cars(20), null, GEO);
    expect(out.ok).toBe(true);
    const boxes = out.labels.map((l) => l.box);
    expect(layoutProblems(boxes, GEO)).toBe(0);
    expect(overlaps(boxes)).toBe(0);
  });

  it('the rejoin label sits at its marker when there is room, and moves along the ring when there is not', () => {
    const spread = cars(20, (i) => (i * 18 + 9) * DEG);
    const rejoin = { angle: 45 * DEG, variants: [['P7 40% · P10 19%'], ['P7 40%', 'P10 19%']] };
    const roomy = layoutLabels(spread, rejoin, { ...GEO, width: 900, height: 700, cx: 450, cy: 350 });
    expect(roomy.ok).toBe(true);
    const r1 = roomy.labels.find((l) => l.rejoin);
    expect(r1.markerAngle).toBeCloseTo(45 * DEG, 9);
    expect(Math.abs(wrapAngle(r1.placed - r1.markerAngle + Math.PI) - Math.PI)).toBeLessThan(20 * DEG);
    // a slot just wide enough for the car labels: the wide rejoin label cannot sit at 90 degrees
    const tight = { ...GEO, width: 391, height: 306, cx: 195.5, cy: 153, rLabel: 137, rClear: 130, fontSize: 8 };
    const side = layoutLabels(spread, { ...rejoin, angle: 90 * DEG }, tight);
    expect(side.ok).toBe(true);
    expect(layoutProblems(side.labels.map((l) => l.box), tight)).toBe(0);
  });

  it('never returns an overlapping layout as ok', () => {
    const tiny = { ...GEO, width: 120, height: 120, cx: 60, cy: 60, rLabel: 40, rClear: 35 };
    const out = layoutLabels(cars(20), { angle: 0, variants: [['P1 100%']] }, tiny);
    expect(out.ok).toBe(false);
    expect(out.problems).toBeGreaterThan(0);
  });
});
