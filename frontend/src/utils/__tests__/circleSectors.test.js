import { describe, it, expect } from 'vitest';
import {
  sectorFractions, sectorShares, placeRingMarks, MARK_STEP, PIT_MARK_REACH, RING_MARK_TEXTS,
} from '../circleSectors.js';
import { referenceLap, REF_MIN_SAMPLES } from '../circleOfDoom.js';
import { textBox, LABEL_PAD } from '../circleLabelLayout.js';
import { perturbFuture } from './futureRows.js';
import {
  T0, car, stop, withPositions,
} from './circleRace.js';

// Three cars, ten 90 s laps with sectors 30 / 33 / 27 s: f1 = 1/3, f12 = 0.7.
// ODD runs laps 2-5 with sectors 40 / 25 / 25 s (same lap time).
const odd = (k) => (k >= 2 && k <= 5
  ? () => ({
    Sector1Time: 40, Sector2Time: 25, Sector3Time: 25,
  })
  : null);
const plain = (code, offset, opts = {}) => car(code, { offset, ...opts });
const RACE = withPositions([
  ...plain('A', 0),
  ...plain('B', 3),
  ...plain('C', 6, { extra: Object.fromEntries([2, 3, 4, 5].map((k) => [k, odd(k)])) }),
]);
// lap k of A ends at T0 + 90 k
const afterLeaderLap = (k) => T0 + 90 * k + 7;

describe('sectorFractions', () => {
  it('medians of the sector shares over the clean laps of the reference lap window', () => {
    const ref = referenceLap(RACE);
    expect(ref.laps).toEqual([6, 10]);
    const f = sectorFractions(RACE, ref, Infinity);
    expect(f).toEqual({
      f1: expect.closeTo(1 / 3, 12), f12: expect.closeTo(0.7, 12), n: 15, laps: [6, 10],
    });
  });

  it('a median: one car with another split moves it only when it is the middle value', () => {
    // laps 2-5 (window after A's lap 5, 12 laps): C's 4 laps at 40 / 90 do not move the median
    const now = afterLeaderLap(5);
    const ref = referenceLap(RACE, { sessionNow: now });
    expect(ref.laps).toEqual([2, 5]);
    expect(sectorFractions(RACE, ref, now)).toMatchObject({ f1: expect.closeTo(1 / 3, 12), n: 12 });
    // with two such cars of three it does
    const two = withPositions([
      ...plain('A', 0),
      ...plain('B', 3, { extra: Object.fromEntries([2, 3, 4, 5].map((k) => [k, odd(k)])) }),
      ...plain('C', 6, { extra: Object.fromEntries([2, 3, 4, 5].map((k) => [k, odd(k)])) }),
    ]);
    expect(sectorFractions(two, referenceLap(two, { sessionNow: now }), now))
      .toMatchObject({ f1: expect.closeTo(40 / 90, 12), f12: expect.closeTo(65 / 90, 12) });
    // the window has moved past them by the end
    expect(sectorFractions(two, referenceLap(two), Infinity).f1).toBeCloseTo(1 / 3, 12);
  });

  it('only clean, completed laps with all three sector times; Sector{k}TimeSeconds first', () => {
    const rows = withPositions([
      ...plain('A', 0),
      ...plain('B', 3, { extra: { 8: () => ({ Sector2Time: null }), 9: () => ({ Sector3Time: '' }) } }),
      ...plain('C', 6, { extra: { 7: () => ({ Sector1TimeSeconds: 45 }) } }),
      ...plain('D', 9, { ...stop(7), extra: { ...stop(7).extra, 9: () => ({ TrackStatus: '4' }) } }),
    ]);
    const ref = referenceLap(rows);
    expect(ref.laps).toEqual([6, 10]);
    // A 5 + B 3 (laps 8, 9 lack a sector) + C 5 + D 2 (7, 8 pit laps, 9 under SC)
    const f = sectorFractions(rows, ref, Infinity);
    expect(f.n).toBe(15);
    expect(f.f1).toBeCloseTo(1 / 3, 12); // C's 45 s lap 7 is one value of 15
    expect(f.f12).toBeCloseTo(0.7, 12);
    // every row's Sector1TimeSeconds (36 s) wins over its Sector1Time (30 s)
    const seconds = RACE.map((r) => ({ ...r, Sector1TimeSeconds: r.Sector1Time == null ? null : 36 }));
    expect(sectorFractions(seconds, referenceLap(seconds), Infinity))
      .toMatchObject({ f1: expect.closeTo(0.4, 12), f12: expect.closeTo(69 / 90, 12), n: 15 });
  });

  it(`null below ${REF_MIN_SAMPLES} laps, and so on lap 1`, () => {
    // only lap 1 completed: the fallback reference lap [1, 1] has no clean lap
    const lapOne = afterLeaderLap(1);
    expect(referenceLap(RACE, { sessionNow: lapOne })).toMatchObject({ source: 'fallback', laps: [1, 1] });
    expect(sectorFractions(RACE, referenceLap(RACE, { sessionNow: lapOne }), lapOne)).toBeNull();
    expect(sectorFractions(RACE, undefined, T0 + 50)).toBeNull(); // nothing completed
    // after A's lap 4: laps 2-4 of three cars = 9 laps
    const four = afterLeaderLap(4);
    expect(sectorFractions(RACE, referenceLap(RACE, { sessionNow: four }), four)).toBeNull();
    expect(sectorFractions(RACE, referenceLap(RACE, { sessionNow: afterLeaderLap(5) }), afterLeaderLap(5)).n).toBe(12);
  });

  it('sectorShares: the per-lap shares the medians are taken of', () => {
    const now = afterLeaderLap(5);
    const ref = referenceLap(RACE, { sessionNow: now });
    const sh = sectorShares(RACE, ref, now);
    expect(sh.laps).toEqual([2, 5]);
    expect(sh.s1).toHaveLength(12);
    expect(sh.s1.filter((x) => Math.abs(x - 40 / 90) < 1e-12)).toHaveLength(4); // C's laps 2-5
    expect(sh.s12.filter((x) => Math.abs(x - 0.7) < 1e-12)).toHaveLength(8);
    expect(sectorShares(RACE, undefined, T0 + 50)).toEqual({ s1: [], s12: [], laps: null });
  });

  it('without a laps window the reference lap is computed at sessionNow', () => {
    const now = afterLeaderLap(7);
    const ref = referenceLap(RACE, { sessionNow: now });
    expect(sectorFractions(RACE, 90, now)).toEqual(sectorFractions(RACE, ref, now));
    expect(sectorFractions(RACE, null, now)).toEqual(sectorFractions(RACE, ref, now));
  });

  it('causal: future rows (their sectors included) changed, the same fractions', () => {
    for (const now of [afterLeaderLap(1), T0 + 455, T0 + 470, afterLeaderLap(6), T0 + 702, T0 + 860]) {
      const ref = referenceLap(RACE, { sessionNow: now });
      const future = perturbFuture(RACE, now);
      expect(sectorFractions(future, referenceLap(future, { sessionNow: now }), now)).toEqual(sectorFractions(RACE, ref, now));
    }
    // the perturbation does reach the sectors still to run on a lap in progress
    const mid = T0 + 455; // A is 5 s into lap 6: no sector of it run yet
    const a6 = perturbFuture(RACE, mid).find((r) => r.Driver === 'A' && r.LapNumber === 6);
    expect(a6.Sector1SessionTime).toBeGreaterThan(mid);
    expect(a6.Sector1Time).not.toBe(30);
    const late = T0 + 485; // 35 s in: sector 1 run (30 s), sector 2 not
    const b = perturbFuture(RACE, late).find((r) => r.Driver === 'A' && r.LapNumber === 6);
    expect(b).toMatchObject({ Sector1Time: 30, Sector1SessionTime: T0 + 480 });
    expect(b.Sector2SessionTime).toBeGreaterThan(late);
  });
});

describe('placeRingMarks', () => {
  const measure = (text, fs) => text.length * fs * 0.6;
  const GEO = {
    cx: 200, cy: 200, rIn: 150, rOut: 180, fontPx: 10, measure,
  };
  const SECT = [0, 1 / 3, 0.7, 1];
  const DEG = Math.PI / 180;
  const mid = (k) => Math.PI * (SECT[k] + SECT[k + 1]);
  const angleOf = (x, y) => {
    const a = Math.atan2(x - 200, 200 - y);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const corners = (b) => [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
  const inAnnulus = (b) => {
    const nx = Math.min(Math.max(200, b.x0), b.x1) - 200;
    const ny = Math.min(Math.max(200, b.y0), b.y1) - 200;
    return Math.hypot(nx, ny) >= 150 - 1e-9 && corners(b).every(([x, y]) => Math.hypot(x - 200, y - 200) <= 180 + 1e-9);
  };
  /** Angular extent of a box, [lo, hi] around angle a. */
  const extent = (b, a) => {
    const d = corners(b).map(([x, y]) => {
      let v = angleOf(x, y) - a;
      while (v >= Math.PI) v -= 2 * Math.PI;
      while (v < -Math.PI) v += 2 * Math.PI;
      return v;
    });
    return [a + Math.min(...d), a + Math.max(...d)];
  };
  /** Box of a label centred at angle a on the mid radius, as the module builds it. */
  const boxAt = (text, a) => {
    const { w, h } = textBox([text], 10, measure);
    const x = 200 + 165 * Math.sin(a);
    const y = 200 - 165 * Math.cos(a);
    return {
      x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2,
    };
  };
  const apart = (p, q) => p.x1 + LABEL_PAD <= q.x0 || q.x1 + LABEL_PAD <= p.x0
    || p.y1 + LABEL_PAD <= q.y0 || q.y1 + LABEL_PAD <= p.y0;

  it('S1 / S2 / S3 at the mid-angle of their sector when nothing is in the way; angles clockwise from the top', () => {
    const marks = placeRingMarks({ ...GEO, sectors: SECT });
    expect(marks.map((m) => m.text)).toEqual(RING_MARK_TEXTS);
    for (const k of [0, 1, 2]) {
      const m = marks[k];
      expect(m.angle).toBeCloseTo(mid(k), 12);
      expect(m.x).toBeCloseTo(200 + 165 * Math.sin(mid(k)), 9);
      expect(m.y).toBeCloseTo(200 - 165 * Math.cos(mid(k)), 9);
      const { w, h } = textBox([m.text], 10, measure);
      expect(m.box.x1 - m.box.x0).toBeCloseTo(w, 9);
      expect(m.box.y1 - m.box.y0).toBeCloseTo(h, 9);
      expect(inAnnulus(m.box)).toBe(true);
    }
    // S1 at 60 degrees: right of and above the centre
    expect(marks[0].x).toBeGreaterThan(200);
    expect(marks[0].y).toBeLessThan(200);
    // no pit span: no PIT
    expect(marks[3]).toEqual({ text: 'PIT', dropped: true });
  });

  it('PIT just before the start of the pit span; nothing touches a reserved span', () => {
    const pit = [0.95 * 2 * Math.PI, 1.03 * 2 * Math.PI]; // across the top
    const marks = placeRingMarks({ ...GEO, sectors: SECT, reserved: [pit] });
    const p = marks[3];
    expect(p.dropped).toBeUndefined();
    const [lo, hi] = extent(p.box, p.angle);
    expect(hi).toBeLessThanOrEqual(pit[0]);
    expect(pit[0] - hi).toBeLessThan(3 * DEG);
    // one step closer to the span, the same box would touch it: the closest spot was taken
    const step = boxAt('PIT', p.angle + MARK_STEP);
    expect(extent(step, p.angle + MARK_STEP)[1]).toBeGreaterThan(pit[0]);
    expect(lo).toBeGreaterThan(pit[0] - 20 * DEG);
    // S3's mid (306 deg) is clear of the span (342 deg on): unchanged
    expect(marks[2].angle).toBeCloseTo(mid(2), 12);
    for (const m of marks) expect(inAnnulus(m.box)).toBe(true);
  });

  it('a reserved span on a sector mid pushes its label outward, inside the sector', () => {
    const block = [mid(0) - 10 * DEG, mid(0) + 10 * DEG];
    const marks = placeRingMarks({ ...GEO, sectors: SECT, reserved: [[1.9 * Math.PI, 1.95 * Math.PI], block] });
    const s1 = marks[0];
    const [lo, hi] = extent(s1.box, s1.angle);
    expect(hi <= block[0] || lo >= block[1]).toBe(true);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(SECT[1] * 2 * Math.PI);
    // the first angle out, in steps of MARK_STEP: within one step of clearing the block
    const off = Math.abs(s1.angle - mid(0));
    expect(off / MARK_STEP).toBeCloseTo(Math.round(off / MARK_STEP), 9);
    const half = (hi - lo) / 2;
    expect(off).toBeLessThan(10 * DEG + half + MARK_STEP + 1e-9);
  });

  it('labels never overlap: PIT steps back past S3 when its first spots collide', () => {
    // pit span from 315 deg, just after S3's mid (306 deg)
    const pit = [315 * DEG, 340 * DEG];
    const marks = placeRingMarks({ ...GEO, sectors: SECT, reserved: [pit] });
    const [s3, p] = [marks[2], marks[3]];
    expect(s3.angle).toBeCloseTo(mid(2), 12);
    expect(p.dropped).toBeUndefined();
    expect(apart(s3.box, p.box)).toBe(true);
    expect(p.angle).toBeLessThan(s3.angle);
    expect(extent(p.box, p.angle)[1]).toBeLessThanOrEqual(pit[0]);
  });

  it('a label with no valid angle is dropped', () => {
    // a sector too narrow for its label, a band too thin for any label, no sectors
    const narrow = placeRingMarks({ ...GEO, sectors: [0, 0.005, 0.7, 1] });
    expect(narrow[0]).toEqual({ text: 'S1', dropped: true });
    expect(narrow[1].dropped).toBeUndefined();
    const thin = placeRingMarks({
      ...GEO, rIn: 160, rOut: 165, sectors: SECT, reserved: [[0, 0.1]],
    });
    expect(thin.every((m) => m.dropped)).toBe(true);
    expect(placeRingMarks({ ...GEO, sectors: null, reserved: [[0, 0.1]] }).slice(0, 3))
      .toEqual(['S1', 'S2', 'S3'].map((text) => ({ text, dropped: true })));
    expect(placeRingMarks({ ...GEO, sectors: [0, 0.8, 0.4, 1] })[0].dropped).toBe(true);
    // a pit span the whole way round leaves PIT nowhere to go
    expect(placeRingMarks({ ...GEO, sectors: SECT, reserved: [[0, 2 * Math.PI]] }).every((m) => m.dropped)).toBe(true);
    expect(PIT_MARK_REACH).toBeCloseTo(Math.PI / 2, 12);
  });

  it('without a measure, the CHAR_EM estimate of circleLabelLayout', () => {
    const m = placeRingMarks({ ...GEO, measure: undefined, sectors: SECT })[0];
    expect(m.box.x1 - m.box.x0).toBeCloseTo(textBox(['S1'], 10).w, 9);
  });
});
