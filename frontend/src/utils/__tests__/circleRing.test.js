import { describe, it, expect } from 'vitest';
import {
  pitSpan, laneAngles, pitLanePath, rejoinAngle, stopTag, stopTagBox, PIT_SPAN_MIN, PIT_SPAN_MAX, LANE_PROGRESS_MAX,
} from '../views/circleRing.js';

const DEG = Math.PI / 180;

describe('pitSpan: three car slots (2 carR + 1 px) at rPit, within [20°, 60°]', () => {
  it('in the range, clamped below and above', () => {
    // carR 5: slot 11 px; at rPit 60 the span is 33 / 60 rad (31.5°)
    expect(pitSpan(5, 60)).toBeCloseTo(33 / 60, 12);
    expect(pitSpan(5, 200)).toBe(PIT_SPAN_MIN);
    expect(pitSpan(5, 20)).toBe(PIT_SPAN_MAX);
    expect(PIT_SPAN_MIN).toBeCloseTo(20 * DEG, 12);
    expect(PIT_SPAN_MAX).toBeCloseTo(60 * DEG, 12);
  });
});

describe('laneAngles: the cars in the pit lane on the segment [-θ, 0]', () => {
  const theta = 30 * DEG;
  const gap = 5 * DEG;

  it('with a median lane time: -θ + u θ, u = seconds since the pit entry / median, at most 0.95', () => {
    const a = laneAngles([{ driver: 'A', pitInTime: 100 }], {
      theta, gap, median: 20, now: 110,
    });
    expect(a.get('A')).toBeCloseTo(-theta + 0.5 * theta, 12);
    const late = laneAngles([{ driver: 'A', pitInTime: 100 }], {
      theta, gap, median: 20, now: 160,
    });
    expect(late.get('A')).toBeCloseTo(-theta + LANE_PROGRESS_MAX * theta, 12);
  });

  it('without a median (or a pit entry time): in entry order from the entry end, one slot apart, the first in furthest along', () => {
    const a = laneAngles([
      { driver: 'C', pitInTime: 120 }, { driver: 'A', pitInTime: 100 }, { driver: 'B', pitInTime: 110 },
    ], {
      theta, gap, median: null, now: 130,
    });
    expect(a.get('C')).toBeCloseTo(-theta, 12);
    expect(a.get('B')).toBeCloseTo(-theta + gap, 12);
    expect(a.get('A')).toBeCloseTo(-theta + 2 * gap, 12);
    // a car without a pit entry time (live rows) counts as the last in
    const live = laneAngles([{ driver: 'X', pitInTime: null }, { driver: 'A', pitInTime: 100 }], {
      theta, gap, median: 20, now: 101,
    });
    expect(live.get('X')).toBeCloseTo(-theta, 12);
    expect(live.get('A') - live.get('X')).toBeGreaterThanOrEqual(gap - 1e-12);
  });

  it('two cars closer than a slot are spread along the arc in entry order, inside the segment', () => {
    // 1 s apart on a 20 s lane: 1.5° apart, spread to one slot (5°)
    const a = laneAngles([{ driver: 'A', pitInTime: 100 }, { driver: 'B', pitInTime: 101 }], {
      theta, gap, median: 20, now: 110,
    });
    expect(a.get('A') - a.get('B')).toBeCloseTo(gap, 12);
    expect(a.get('A')).toBeCloseTo(-theta + 0.5 * theta, 12);
    // just in: the later car would fall before the entry end, so both move on
    const b = laneAngles([{ driver: 'A', pitInTime: 100 }, { driver: 'B', pitInTime: 100.5 }], {
      theta, gap, median: 20, now: 100.5,
    });
    expect(b.get('B')).toBeCloseTo(-theta, 12);
    expect(b.get('A')).toBeCloseTo(-theta + gap, 12);
  });

  it('more cars than the segment holds: evenly over it, in entry order, every angle in [-θ, 0]', () => {
    const lane = Array.from({ length: 9 }, (_, i) => ({ driver: `D${i}`, pitInTime: 100 + i }));
    const a = laneAngles(lane, {
      theta, gap, median: null, now: 120,
    });
    const angles = lane.map((c) => a.get(c.driver));
    for (const x of angles) {
      expect(x).toBeGreaterThanOrEqual(-theta - 1e-12);
      expect(x).toBeLessThanOrEqual(1e-12);
    }
    expect(angles[0]).toBeCloseTo(0, 12);
    expect(angles[8]).toBeCloseTo(-theta, 12);
    for (let i = 1; i < angles.length; i += 1) expect(angles[i - 1] - angles[i]).toBeCloseTo(theta / 8, 12);
  });
});

describe('pitLanePath', () => {
  it('the arc at rPit from -θ clockwise to the timing line (the top)', () => {
    const d = pitLanePath(100, 100, 50, Math.PI / 6);
    const [, x0, y0, x1, y1] = /^M([-\d.e]+),([-\d.e]+)A50,50 0 0 1 ([-\d.e]+),([-\d.e]+)$/.exec(d).map(Number);
    expect(x0).toBeCloseTo(100 - 50 * Math.sin(Math.PI / 6), 9);
    expect(y0).toBeCloseTo(100 - 50 * Math.cos(Math.PI / 6), 9);
    expect(x1).toBeCloseTo(100, 9);
    expect(y1).toBeCloseTo(50, 9);
  });
});

describe('rejoinAngle', () => {
  it('a car not stopping: the pending loss back from where it is drawn', () => {
    expect(rejoinAngle(2, { ongoingStop: false, rejoinOffset: 0.25 })).toBeCloseTo(2 - Math.PI / 2, 12);
  });

  it('a stop under way: the model rejoinPhase, within half a turn of the car (the band never wraps)', () => {
    // drawn at -10° (in the lane), rejoin point at 300°: 50° back
    const af = -10 * DEG;
    const a = rejoinAngle(af, { ongoingStop: true, rejoinPhase: 300 / 360, rejoinOffset: 0.1 });
    expect(af - a).toBeCloseTo(50 * DEG, 12);
    // a rejoin point just ahead of the car: a negative band (none is drawn), not a whole turn
    const b = rejoinAngle(af, { ongoingStop: true, rejoinPhase: 5 / 360, rejoinOffset: 0.1 });
    expect(af - b).toBeCloseTo(-15 * DEG, 12);
  });
});

describe('stopTag', () => {
  it("'PIT' and the whole seconds since the pit entry, 'PIT' without one, 'OUT'; '' without a stop", () => {
    expect(stopTag({ status: 'lane', pitInTime: 100 }, 114.9)).toBe('PIT 14');
    expect(stopTag({ status: 'lane', pitInTime: null }, 114.9)).toBe('PIT');
    expect(stopTag({ status: 'out', pitInTime: 100 }, 130)).toBe('OUT');
    expect(stopTag(null, 130)).toBe('');
    expect(stopTag({ status: null, pitInTime: null }, 130)).toBe('');
  });

  it('the label box is measured at two digits at least', () => {
    expect(stopTagBox({ status: 'lane', pitInTime: 100 }, 103)).toBe('PIT 88');
    expect(stopTagBox({ status: 'lane', pitInTime: 100 }, 114)).toBe('PIT 88');
    expect(stopTagBox({ status: 'lane', pitInTime: 100 }, 250)).toBe('PIT 888');
    expect(stopTagBox({ status: 'out', pitInTime: 100 }, 250)).toBe('OUT');
  });
});
