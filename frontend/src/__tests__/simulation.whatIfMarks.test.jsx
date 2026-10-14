// S4 (lead decision D5), Strategy Simulator: the marks its result draws from
// the what-if's Monte Carlo output (the verdict PLACES GAINED / LOST / NO
// CLEAR CHANGE with its arrow and colour, the cards' P labels, the colours of
// the podium / points differences, the saved comparison row) change only on
// evidence beyond the Monte Carlo error: utils/simulationClient.js
// pairedDifferences / pairedSign / whatIfMarks, chained by the store over the
// recomputes of the same what-if. The flip rates over 30 races x 3 clocks x 10
// seeds are in notes/experiments/phase45c/whatif_stability.txt
// (scripts/whatif_stability.mjs).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const {
  pairedDifferences, pairedInterval, pairedSign, whatIfVerdict, whatIfMarks, whatIfMarksOf, whatIfKey,
  familyZ, WHATIF_MARKS, shownPositions, shownPositionRange, whatIfContradiction, modePosition,
} = await import('../utils/simulationClient.js');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: StrategySimulator } = await import('../components/visualizations/StrategySimulator.jsx');
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { extractRaceSituationFeatures } = await import('../utils/raceSituationFeatures.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const store = () => useF1Store.getState();
const INITIAL = store();

/** A projection row with `count` runs at each position of `posCount`. */
const row = (driver, posCount) => ({ driver, currentPos: 5, posCount, posDistribution: {}, modePos: null });

describe('paired differences of a what-if (common random numbers)', () => {
  it('position, podium and points differences per run, signed so that positive = the plan does better', () => {
    // baseline / plan positions in four runs
    const p = pairedDifferences([4, 3, 11, 2], [2, 3, 9, 4]);
    expect(p.position.n).toBe(4);
    expect(p.position.mean).toBeCloseTo((2 + 0 + 2 - 2) / 4, 12);
    // podium: run 1 the plan enters it (+1), run 4 the plan leaves it (-1)
    expect(p.podium.mean).toBeCloseTo(0, 12);
    // points: run 3 the plan enters them (+1)
    expect(p.points.mean).toBeCloseTo(1 / 4, 12);
    const sd = Math.sqrt(((2 - 0.5) ** 2 + (0 - 0.5) ** 2 + (2 - 0.5) ** 2 + (-2 - 0.5) ** 2) / 3);
    expect(p.position.sd).toBeCloseTo(sd, 12);
    expect(pairedDifferences([], [])).toBeNull();
    expect(pairedDifferences([1, null], [2, 3]).position.n).toBe(1);
  });

  it('interval mean -/+ z sd / sqrt(n), z simultaneous over the result\'s marks', () => {
    const z = familyZ(WHATIF_MARKS);
    expect(WHATIF_MARKS).toBe(5);
    const [lo, hi] = pairedInterval({ mean: 0.2, sd: 2, n: 400 });
    expect(lo).toBeCloseTo(0.2 - z * 0.1, 12);
    expect(hi).toBeCloseTo(0.2 + z * 0.1, 12);
  });

  it('sign beyond the error, with hysteresis while the mean stays on its side', () => {
    const se = 0.1; // sd 2, n 400
    const z = familyZ(WHATIF_MARKS);
    const at = (mean) => ({ mean, sd: 2, n: 400 });
    expect(pairedSign(at(z * se + 0.01))).toBe(1);
    expect(pairedSign(at(-z * se - 0.01))).toBe(-1);
    expect(pairedSign(at(0.1))).toBe(0); // within the error, no previous sign
    expect(pairedSign(at(0.1), 1)).toBe(1); // within it, the previous gain kept while the mean is > 0
    expect(pairedSign(at(-0.05), 1)).toBe(0); // the mean changed side: no gain any more
    expect(pairedSign(at(-0.1), -1)).toBe(-1);
    expect(pairedSign(at(0.05), -1)).toBe(0);
    expect(pairedSign(at(-z * se - 0.01), 1)).toBe(-1); // the opposite beyond the error
    // an identical plan: every difference 0
    expect(pairedSign({ mean: 0, sd: 0, n: 1000 }, 1)).toBe(0);
    expect(pairedSign(null)).toBeNull();
  });

  it('verdict from the paired position difference; without it, the sign of delta.position', () => {
    expect(whatIfVerdict({ paired: { position: { mean: 0.6, sd: 2, n: 1000 } }, delta: { position: 0.6 } })).toBe(1);
    expect(whatIfVerdict({ paired: { position: { mean: -0.2, sd: 3.3, n: 1000 } }, delta: { position: -0.2 } })).toBe(0);
    expect(whatIfVerdict({ delta: { position: -0.2 } })).toBe(-1);
  });

  it('card P labels: the median, kept by the previous label while the median is within the error', () => {
    // 1000 runs: P5 49.5 %, P6 50.5 %: the point median is P6, within the error of 50 %
    const result = {
      numSimulations: 1000,
      simProjection: row('LEC', { 5: 495, 6: 505 }),
      baselineProjection: row('LEC', { 5: 520, 6: 480 }),
      paired: { position: { mean: 0, sd: 1, n: 1000 }, podium: { mean: 0, sd: 0, n: 1000 }, points: { mean: 0, sd: 0, n: 1000 } },
      delta: { position: 0, podium: 0, points: 0 },
    };
    const first = whatIfMarks(result);
    expect(first.shown).toEqual({ custom: 6, baseline: 5 });
    // with a previous P5 on the plan's card, the label stays (F(5) = 49.5 % is within the error)
    expect(whatIfMarks(result, { shown: { custom: 5, baseline: 5 }, verdict: 0 }).shown).toEqual({ custom: 5, baseline: 5 });
    // a median beyond the error moves the label
    const moved = { ...result, simProjection: row('LEC', { 5: 300, 6: 700 }) };
    expect(whatIfMarks(moved, { shown: { custom: 5, baseline: 5 }, verdict: 0 }).shown.custom).toBe(6);
    expect(first.podium).toBe(0);
    expect(first.points).toBe(0);
  });

  it('whatIfKey: the driver, the plan and the baseline (model stops or a saved plan)', () => {
    const plan = [{ lap: 20, compound: 'HARD' }];
    expect(whatIfKey('LEC', plan, null)).toBe('LEC|20:HARD|model');
    expect(whatIfKey('LEC', plan, [{ lap: 15, compound: 'HARD' }])).toBe('LEC|20:HARD|15:HARD');
    expect(whatIfKey('LEC', [], null)).toBe('LEC||model');
  });
});

const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const MAX_LAP = monza ? Math.max(...monza.lap_times.map((r) => r.LapNumber)) : 0;

function monzaAt(currentLap) {
  const lapTimes = monza.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const sessionNow = resolveSessionNow({ currentLap, lapTimes });
  useF1Store.setState({
    year: 2024, round: 16, sessionType: 'R', loadedSessionType: 'R', loadedYear: 2024, loadedRound: 16,
    sessionData: monza, trackStatus: monza.track_status || [], sessionTimeOffset: offset,
    maxLap: MAX_LAP, totalRaceLaps: null, currentLap, totalFrames: 0, currentTime: 0, isLiveMode: false,
    raceSituationData: extractRaceSituationFeatures({ lapTimes, currentLap, dnfMap: {}, sessionNow, sessionTimeOffset: offset }),
  });
}
const stints = (...list) => list.map(([compound, lapStart], i) => ({
  compound, lapStart, length: (list[i + 1]?.[1] ?? MAX_LAP + 1) - lapStart,
}));

/**
 * Server-render against the store's CURRENT state: zustand serves
 * getInitialState() as the server snapshot, so the current state is copied
 * into that object for the render and restored after.
 */
function renderWithStore(element) {
  const initial = useF1Store.getInitialState();
  const saved = { ...initial };
  Object.assign(initial, useF1Store.getState());
  try {
    return renderToString(element);
  } finally {
    for (const k of Object.keys(initial)) delete initial[k];
    Object.assign(initial, saved);
  }
}

describe.skipIf(!haveMonza)('what-if marks in the store and the panel (Monza 2024, LEC)', () => {
  it('an identical plan: every paired difference 0, NO CLEAR CHANGE, both cards equal', () => {
    useF1Store.setState({ ...INITIAL });
    monzaAt(12);
    const plan = stints(['MEDIUM', 1], ['HARD', 16]);
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: { label: 'A', stints: plan } });
    store().runSimulation();
    const r = store().simulatorResult;
    expect(r.paired.position).toEqual({ mean: 0, sd: 0, n: r.numSimulations });
    expect(r.marks.verdict).toBe(0);
    expect(r.marks.shown.custom).toBe(r.marks.shown.baseline);
  });

  it('the store chains the marks over recomputes of the same what-if only', () => {
    useF1Store.setState({ ...INITIAL });
    monzaAt(12);
    const plan = stints(['MEDIUM', 1], ['HARD', 26]);
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: null });
    // the stop-model baseline's card is judged with the panel's chained labels
    const opts = () => ({ stopModel: true, panelMode: store().raceProjection?.badges?.mode ?? null });
    store().runSimulation();
    const r1 = store().simulatorResult;
    expect(r1.whatIfKey).toBe('LEC|25:HARD|model');
    expect(r1.marks).toEqual(whatIfMarks(r1, null, opts()));
    // the next lap, the same what-if: judged against the marks held
    monzaAt(13);
    store().runSimulation();
    const r2 = store().simulatorResult;
    expect(r2.seed).not.toBe(r1.seed);
    expect(r2.marks).toEqual(whatIfMarks(r2, r1.marks, opts()));
    // another plan: no previous state
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: stints(['MEDIUM', 1], ['HARD', 30]) } });
    store().runSimulation();
    const r3 = store().simulatorResult;
    expect(r3.whatIfKey).toBe('LEC|29:HARD|model');
    expect(r3.marks).toEqual(whatIfMarks(r3, null, opts()));
  });

  it('the panel draws the stored marks: P labels, verdict, the interval and the saved comparison row', () => {
    useF1Store.setState({ ...INITIAL });
    monzaAt(12);
    const plan = stints(['MEDIUM', 1], ['HARD', 26]);
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: null, focusDriver: 'LEC' });
    store().runSimulation();
    const r = store().simulatorResult;
    // marks forced to a state the point estimates would not give, to see that the panel reads them
    const marks = { ...r.marks, verdict: 0, shown: { custom: 17, baseline: 18 }, podium: 0, points: 0 };
    useF1Store.setState({
      simulatorResult: { ...r, marks },
      simulatorComparisons: [{ label: 'M-H', stints: plan, result: { ...r, marks } }],
    });
    const html = renderWithStore(<StrategySimulator />).replace(/<!-- -->/g, '');
    expect(html).toContain('P17');
    expect(html).toContain('P18');
    expect(html).toContain('NO CLEAR CHANGE');
    expect(html).not.toContain('PLACES GAINED');
    expect(html).not.toContain('PLACES LOST');
    const half = (pairedInterval(r.paired.position)[1] - pairedInterval(r.paired.position)[0]) / 2;
    expect(html).toContain(`±${half.toFixed(2)}`);
    expect(whatIfMarksOf({ ...r, marks })).toBe(marks);
  });
});

describe('the verdict and the cards never contradict each other within the Monte Carlo error', () => {
  const paired = (mean, sd = 1) => ({
    position: { mean, sd, n: 1000 }, podium: { mean: 0, sd: 0, n: 1000 }, points: { mean: 0, sd: 0, n: 1000 },
  });
  const result = (sim, base, mean, sd) => ({
    numSimulations: 1000,
    simProjection: row('VER', sim),
    baselineProjection: row('VER', base),
    paired: paired(mean, sd),
    delta: { position: mean, podium: 0, points: 0 },
  });
  const z = familyZ(WHATIF_MARKS);
  const marksOf = (verdict, custom, baseline) => ({ verdict, shown: { custom, baseline }, podium: 0, points: 0 });

  it('shownPositionRange: the positions the label may take within the error, shownPositions inside it', () => {
    // F(3) = 48 %: within the error of 50 %, F(4) = 100 %: surely at least half
    expect(shownPositionRange(row('VER', { 3: 480, 4: 520 }), 1000, z)).toEqual([3, 4]);
    expect(shownPositionRange(row('VER', { 3: 600, 4: 400 }), 1000, z)).toEqual([3, 3]);
    expect(shownPositionRange(row('VER', {}), 1000, z)).toBeNull();
    for (const was of [undefined, 1, 3, 4, 9]) {
      const shown = shownPositions({ numSimulations: 1000, projections: [row('VER', { 3: 480, 4: 520 })] },
        was ? { VER: was } : undefined, z).VER;
      expect(shown).toBeGreaterThanOrEqual(3);
      expect(shown).toBeLessThanOrEqual(4);
    }
  });

  it('a card held within its error by hysteresis yields to a verdict beyond the error', () => {
    // plan: P3 or P4 within the error (held at P4); baseline surely P3; the plan gains beyond the error
    const r = result({ 3: 480, 4: 520 }, { 3: 600, 4: 400 }, 0.5);
    expect(pairedInterval(r.paired.position)[0]).toBeGreaterThan(0);
    const m = whatIfMarks(r, marksOf(1, 4, 3));
    expect(m.verdict).toBe(1);
    expect(m.shown).toEqual({ custom: 3, baseline: 3 });
    expect(whatIfContradiction(m.verdict, m.shown.custom, m.shown.baseline)).toBe(false);
  });

  it("a saved plan's card moves within its error when the plan's card cannot", () => {
    // plan surely P4; baseline P3 or P4 within the error (held at P3)
    const r = result({ 4: 1000 }, { 3: 480, 4: 520 }, 0.5);
    const m = whatIfMarks(r, marksOf(1, 4, 3));
    expect(m.shown).toEqual({ custom: 4, baseline: 4 });
    expect(m.verdict).toBe(1);
  });

  it('a verdict held only by hysteresis yields to cards beyond their error: NO CLEAR CHANGE', () => {
    // plan surely P4, baseline surely P3, the paired mean 0.05 +/- 0.08: the gain was only held
    const r = result({ 4: 1000 }, { 3: 1000 }, 0.05);
    expect(pairedInterval(r.paired.position)[0]).toBeLessThan(0);
    const m = whatIfMarks(r, marksOf(1, 4, 3));
    expect(m.verdict).toBe(0);
    expect(m.shown).toEqual({ custom: 4, baseline: 3 });
  });

  it('both beyond the error (the mean and the medians of the runs disagree): the marks say what the runs say', () => {
    const r = result({ 4: 1000 }, { 3: 1000 }, 0.5);
    const m = whatIfMarks(r, null);
    expect(m.verdict).toBe(1);
    expect(m.shown).toEqual({ custom: 4, baseline: 3 });
  });

  it("a loss: the plan's card moves down to the baseline's, never past it", () => {
    const r = result({ 4: 480, 5: 520 }, { 5: 600, 6: 400 }, -0.5);
    const m = whatIfMarks(r, marksOf(-1, 4, 5));
    expect(m.verdict).toBe(-1);
    expect(m.shown).toEqual({ custom: 5, baseline: 5 });
  });

  it("the stop-model baseline card is the panel's P label (its rule, its intervals, its previous label)", () => {
    // the panel's table: 20 rows (familyZ(20)); VER's F(3) = 47.5 % is within the error
    const others = Array.from({ length: 19 }, (_, i) => row(`D${i}`, { [i + 1]: 1000 }));
    const baseline = { numSimulations: 1000, projections: [row('VER', { 3: 475, 4: 525 }), ...others] };
    const r = { ...result({ 4: 1000 }, { 3: 475, 4: 525 }, 0), baseline };
    for (const panelMode of [null, { VER: 3 }, { VER: 4 }]) {
      const m = whatIfMarks(r, null, { stopModel: true, panelMode });
      expect(m.shown.baseline).toBe(shownPositions(baseline, panelMode || undefined).VER);
    }
    // the panel held P3: the card shows P3, whatever the Simulator's own chain held
    expect(whatIfMarks(r, marksOf(0, 4, 4), { stopModel: true, panelMode: { VER: 3 } }).shown.baseline).toBe(3);
    // a saved plan as the baseline: its own card, its own chain
    expect(whatIfMarks(r, marksOf(0, 4, 4)).shown.baseline).toBe(4);
  });

  it("a stop-model baseline card the verdict contradicts stays the panel's label; the plan's card moves", () => {
    const others = Array.from({ length: 19 }, (_, i) => row(`D${i}`, { [i + 1]: 1000 }));
    const baseline = { numSimulations: 1000, projections: [row('VER', { 3: 600, 4: 400 }), ...others] };
    const r = { ...result({ 3: 480, 4: 520 }, { 3: 600, 4: 400 }, 0.5), baseline };
    const m = whatIfMarks(r, marksOf(1, 4, 3), { stopModel: true, panelMode: { VER: 3 } });
    expect(m.shown).toEqual({ custom: 3, baseline: 3 });
  });
});

describe.skipIf(!haveMonza)('the Simulator and the Race Prediction panel show one finishing position per driver', () => {
  it("stop-model baseline card = the panel's P label of the driver, in the store", () => {
    useF1Store.setState({ ...INITIAL });
    monzaAt(30);
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: stints(['HARD', 1], ['MEDIUM', 36]) }, simulatorBaseline: null });
    store().runSimulation();
    const r = store().simulatorResult;
    const proj = store().raceProjection;
    expect(r.seed).toBe(proj.seed);
    expect(r.marks.shown.baseline).toBe(modePosition(proj, proj.projections.find((p) => p.driver === 'LEC')));
  });

  it('the result cards always show both chips (0 % included)', () => {
    useF1Store.setState({ ...INITIAL });
    monzaAt(12);
    const plan = stints(['MEDIUM', 1], ['HARD', 26]);
    useF1Store.setState({ simulatorStrategy: { driver: 'LEC', stints: plan }, simulatorBaseline: null, focusDriver: 'LEC' });
    store().runSimulation();
    const r = store().simulatorResult;
    const zero = {
      ...r,
      simProjection: { ...r.simProjection, podiumProb: 0, pointsProb: 0 },
      marks: { ...r.marks, shown: { custom: 12, baseline: 2 } },
    };
    useF1Store.setState({ simulatorResult: zero });
    const html = renderWithStore(<StrategySimulator />).replace(/<!-- -->/g, '');
    expect(html).toContain('0% podium');
    expect(html).toContain('0% points');
    expect((html.match(/% podium/g) || []).length).toBe(2);
    expect((html.match(/% points/g) || []).length).toBe(2);
  });
});
