// Phase 5 frontend (G4, G5): the Tyre Degradation chart, the Consistency
// panel and the Driver Comparison consistency row on the shared degradation
// definition (utils/degradation.js, through utils/views/degradationViews.js).
//
// G4: stints of utils/stints.js (Monza 2024 ALO: 3 stints, the last two on
// HARD), lap 1 and non-green laps out of every fit (the old 1.3 x median rule
// kept them), the fuel constant labelled as an assumption on screen.
// G5: consistency = consistencySigma (pooled residual sigma of the per-stint
// fits), equal to backend/data/processors/degradation.py per driver (the
// Python side is executed here), every Monza 2024 finisher <= 0.8 s, causal.
//
// HEAD_RULE below is the previous chart's own per-stint regression, kept only
// as the reference the new definition is compared with.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Server rendering reads getServerState: point it at the live state so a
// setState before renderToString is what the components see
vi.mock('zustand', async (importOriginal) => {
  const orig = await importOriginal();
  const bind = (createState) => {
    const api = orig.createStore(createState);
    api.getServerState = api.getState;
    const useBound = (selector, equalityFn) => orig.useStore(api, selector, equalityFn);
    Object.assign(useBound, api);
    return useBound;
  };
  return { ...orig, create: (createState) => (createState ? bind(createState) : bind) };
});

// In-memory localStorage for the persist middleware
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { useF1Store } = await import('../store/useF1Store.js');
const { default: TireDegradation } = await import('../components/visualizations/TireDegradation.jsx');
const { default: ConsistencyPanel } = await import('../components/visualizations/ConsistencyPanel.jsx');
const { default: DriverComparePanel } = await import('../components/visualizations/DriverComparePanel.jsx');
const {
  tyreDegradationView, consistencyView, fitLapTime, formatSlope, FUEL_NOTE, FIT_NOTE,
  BRUSH_MIN_LAPS, LOW_DATA_FRACTION, LOW_DATA_MIN_LAPS,
} = await import('../utils/views/degradationViews.js');
const {
  stintFits, consistencySigma, compoundDegradation, FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS,
} = await import('../utils/degradation.js');
const {
  computeSessionTimeOffset, leaderLapEndTime, lapEndTime, isGreenLap,
} = await import('../utils/raceTime.js');
const { stintsByDriver } = await import('../utils/stints.js');
const { driverCompletedLaps, groupLapsByStint } = await import('../utils/strategyViews.js');
const {
  hasCachedSession, loadCachedSession, listCachedRaces, CACHE_DIR,
} = await import('./helpers/cachedSession.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../backend');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const VIZ = path.resolve(HERE, '../components/visualizations');

const INITIAL = useF1Store.getState();
const html = (Component) => renderToString(React.createElement(Component));
/** Visible text of a server render (tags dropped, entities decoded). */
const text = (Component) => html(Component)
  .replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ');

const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : { lap_times: [], race_results: [] };
const LT = monza.lap_times;
const MAX_LAP = LT.length ? Math.max(...LT.map((r) => r.LapNumber)) : 0;
const FINISHERS = (monza.race_results || [])
  .filter((r) => /^\d+$/.test(String(r.ClassifiedPosition)))
  .map((r) => r.Abbreviation);

/** End of the driver's lap `lap` (session s). */
const lapEnd = (drv, lap) => LT.find((r) => r.Driver === drv && r.LapNumber === lap).Time;

/** The previous chart's per-stint regression (HEAD TireDegradation.jsx), for comparison only. */
function HEAD_RULE(lapTimes, driver, sessionNow = Infinity) {
  const done = driverCompletedLaps(lapTimes, driver, sessionNow);
  const stints = stintsByDriver(lapTimes, { sessionNow })[driver] || [];
  return groupLapsByStint(done, stints).map(({ stint, laps }) => {
    const pts = laps.map((lap, i) => ({
      lapNumber: lap.LapNumber,
      t: lap.LapTimeSeconds,
      x: lap.TyreLife || i + 1,
      pit: lap.PitInTime != null || lap.PitOutTime != null,
      green: isGreenLap(lap),
    }));
    const sorted = pts.map((p) => p.t).sort((a, b) => a - b);
    const m = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const clean = pts.filter((p) => !(p.t > m * 1.3 || p.pit));
    let slope = null;
    if (clean.length >= 2) {
      const xm = clean.reduce((a, p) => a + p.x, 0) / clean.length;
      const ym = clean.reduce((a, p) => a + p.t, 0) / clean.length;
      let num = 0;
      let den = 0;
      for (const p of clean) { num += (p.x - xm) * (p.t - ym); den += (p.x - xm) ** 2; }
      slope = den ? num / den : null;
    }
    return { stintNumber: stint.StintNumber, compound: stint.Compound, clean, slope };
  });
}

/** Lap rows not completed at `now` replaced by a different, made-up future. */
function perturbFuture(lapTimes, now) {
  return lapTimes.map((lt) => {
    const end = lapEndTime(lt);
    if (end != null && end <= now) return lt;
    return {
      ...lt,
      LapTimeSeconds: (lt.LapTimeSeconds || 90) + 7.5,
      TrackStatus: lt.TrackStatus === '1' ? '4' : '1',
      Compound: lt.Compound === 'HARD' ? 'SOFT' : 'HARD',
      TyreLife: (lt.TyreLife || 1) + 3,
      PitInTime: lt.PitInTime == null ? lt.Time : null,
    };
  });
}

/** consistency_sigma of backend/data/processors/degradation.py, per driver, at each clock (null = whole race). */
function pythonSigma(file, drivers, clocks) {
  const PY = `
import json, math, os, sys
from data.processors.degradation import consistency_sigma
req = json.load(sys.stdin)
with open(req['file'], encoding='utf-8') as fh:
    laps = json.load(fh).get('lap_times') or []
out = []
for now in req['clocks']:
    now = math.inf if now is None else now
    out.append({d: consistency_sigma(laps, d, session_now=now) for d in req['drivers']})
print(json.dumps(out))
`;
  const res = spawnSync(PYTHON, ['-c', PY], {
    cwd: BACKEND,
    input: JSON.stringify({ file, drivers, clocks }),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
  return JSON.parse(res.stdout.replace(/\bNaN\b/g, 'null'));
}

/** Replay store state at a session time (frames loaded), Monza 2024. */
function monzaAt(sessionTime, extra = {}) {
  const offset = computeSessionTimeOffset(LT);
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    sessionData: monza,
    drivers: monza.driver_info,
    trackStatus: monza.track_status || [],
    sessionTimeOffset: offset,
    maxLap: MAX_LAP,
    totalRaceLaps: MAX_LAP,
    currentLap: MAX_LAP,
    totalFrames: 10000,
    currentTime: sessionTime - offset,
    ...extra,
  });
}
const RACE_END = LT.length ? Math.max(...LT.map((r) => r.Time).filter(Number.isFinite)) + 1 : 0;

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
});

describe.skipIf(!haveMonza)('G4 Tyre Degradation chart on the shared definition (Monza 2024)', () => {
  it('ALO: 3 stints (MEDIUM, HARD, HARD) — the same-compound stop opens a new stint, each with its own fit', () => {
    const view = tyreDegradationView(LT, 'ALO');
    const rows = view.stints.map((s) => `S${s.stintNumber} ${s.compound} L${s.startLap}-${s.endLap} n${s.cleanCount} `
      + `slope ${formatSlope(s.fit?.slope, 4)} raw ${formatSlope(s.fit?.rawSlope, 4)}`);
    console.log(`ALO stints:\n  ${rows.join('\n  ')}`);
    expect(view.stints.map((s) => s.compound)).toEqual(['MEDIUM', 'HARD', 'HARD']);
    expect(view.stints.map((s) => [s.startLap, s.endLap])).toEqual([[1, 12], [13, 35], [36, 53]]);
    // every stint is fitted, and the fit is stintFits' row (no fit of its own)
    const fits = stintFits(LT, { driver: 'ALO' });
    view.stints.forEach((s, i) => {
      expect(s.fit).toEqual(fits[i]);
      expect(s.cleanLaps.length).toBe(fits[i].n);
    });
  });

  it('LEC MEDIUM: lap 1 out of the fit, the slope does not depend on it and keeps its sign', () => {
    const view = tyreDegradationView(LT, 'LEC');
    const med = view.stints.find((s) => s.compound === 'MEDIUM');
    expect(med.cleanLaps.some((l) => l.lapNumber === 1)).toBe(false);
    expect(med.excludedLaps.some((l) => l.lapNumber === 1)).toBe(true);
    expect(med.fit.slope).toBeGreaterThan(0);
    expect(med.fit.rawSlope).toBeGreaterThan(0);

    // HEAD rule: lap 1 (88.179 s, standing start) is kept and flips the sign
    const head = HEAD_RULE(LT, 'LEC').find((s) => s.compound === 'MEDIUM');
    expect(head.clean.some((p) => p.lapNumber === 1)).toBe(true);
    expect(head.slope).toBeLessThan(0);
    const headNoLap1 = HEAD_RULE(LT.filter((r) => !(r.Driver === 'LEC' && r.LapNumber === 1)), 'LEC')
      .find((s) => s.compound === 'MEDIUM');
    expect(headNoLap1.slope).toBeGreaterThan(0);
    expect(headNoLap1.slope).toBeCloseTo(med.fit.rawSlope, 9);

    // Lap 1 changed to anything: the new fit is identical at every clock from
    // the first fit (8 clean laps) to the race end; the HEAD slope moves
    const series = [];
    for (let lap = 9; lap <= MAX_LAP; lap++) {
      const now = lapEnd('LEC', lap);
      const real = tyreDegradationView(LT, 'LEC', { sessionNow: now }).stints[0];
      for (const t1 of [80, 95, 120, 199]) {
        const alt = LT.map((r) => (r.Driver === 'LEC' && r.LapNumber === 1 ? { ...r, LapTimeSeconds: t1 } : r));
        expect(tyreDegradationView(alt, 'LEC', { sessionNow: now }).stints[0].fit).toEqual(real.fit);
      }
      if (lap <= 16) {
        const h = HEAD_RULE(LT, 'LEC', now)[0];
        series.push(`L${lap}: new ${formatSlope(real.fit.slope, 4)} (raw ${formatSlope(real.fit.rawSlope, 4)}, n ${real.fit.n}) | HEAD ${formatSlope(h.slope, 4)}`);
      }
    }
    console.log(`LEC MEDIUM slope at the end of each lap (new definition vs HEAD rule with lap 1):\n  ${series.join('\n  ')}`);
    // the whole MEDIUM stint (laps 2-14 clean) is complete from lap 14 on: one sign from then on
    const signs = [];
    for (let lap = 14; lap <= MAX_LAP; lap++) {
      signs.push(Math.sign(tyreDegradationView(LT, 'LEC', { sessionNow: lapEnd('LEC', lap) }).stints[0].fit.slope));
    }
    expect(new Set(signs)).toEqual(new Set([1]));
  });

  it('fit line drawn in raw lap time: slope = rawSlope, ends = the fitted laps', () => {
    for (const drv of FINISHERS) {
      for (const s of tyreDegradationView(LT, drv).stints) {
        if (!s.fit) { expect(s.line).toBeNull(); continue; }
        const { tyreMin, tyreMax, y1, y2 } = s.line;
        expect(tyreMin).toBe(s.fit.tyreLifeMin);
        expect(tyreMax).toBe(s.fit.tyreLifeMax);
        expect((y2 - y1) / (tyreMax - tyreMin)).toBeCloseTo(s.fit.rawSlope, 9);
        // each end is the fit at that lap, fuel correction taken back out
        const first = s.cleanLaps.find((l) => l.tyreLife === tyreMin);
        expect(y1).toBeCloseTo(s.fit.intercept + s.fit.slope * tyreMin
          - FUEL_EFFECT_S_PER_LAP * (first.lapNumber - 1), 9);
        expect(fitLapTime(s.fit, first)).toBe(y1);
      }
    }
  });

  it('brush L10-L25 (PIA): the laps and fits of the range, as stintFits lapStart / lapEnd', () => {
    const view = tyreDegradationView(LT, 'PIA', { lapRange: [10, 25] });
    expect(view.rangeApplied).toBe(true);
    const fits = stintFits(LT, { driver: 'PIA', lapStart: 10, lapEnd: 25 });
    expect(view.stints.map((s) => s.stintNumber)).toEqual(fits.map((f) => f.stintNumber));
    for (const s of view.stints) {
      expect(s.laps.every((l) => l.lapNumber >= 10 && l.lapNumber <= 25)).toBe(true);
    }
    const [s1, s2] = view.stints;
    console.log(`PIA L10-L25: S1 ${s1.compound} n ${s1.cleanCount} fit ${s1.fit ? 'yes' : 'no'}; `
      + `S2 ${s2.compound} n ${s2.cleanCount} slope ${formatSlope(s2.fit.slope, 4)} raw ${formatSlope(s2.fit.rawSlope, 4)}`);
    expect(s1.fit).toBeNull(); // 6 clean laps < MIN_FIT_LAPS
    expect(s1.cleanCount).toBeLessThan(MIN_FIT_LAPS);
    expect(s2.fit).toEqual(fits[1]);
    // too few completed laps in the range (lap mode at its start): whole race
    const early = tyreDegradationView(LT, 'PIA', { lapRange: [40, 50], sessionNow: lapEnd('PIA', 40) });
    expect(BRUSH_MIN_LAPS).toBe(3);
    expect(early.rangeApplied).toBe(false);
    expect(early.stints.length).toBeGreaterThan(0);
  });

  it('every cached race: no fitted lap is lap 1, a pit lap or non-green; the HEAD rule kept non-green laps', () => {
    const races = listCachedRaces();
    let fitted = 0;
    let headNonGreen = 0;
    let headLap1 = 0;
    let example = null;
    for (const { year, round } of races) {
      const lt = loadCachedSession(year, round).lap_times || [];
      const drivers = [...new Set(lt.map((r) => r.Driver))];
      for (const drv of drivers) {
        const byLap = new Map(lt.filter((r) => r.Driver === drv).map((r) => [r.LapNumber, r]));
        for (const s of tyreDegradationView(lt, drv).stints) {
          for (const l of s.cleanLaps) {
            const row = byLap.get(l.lapNumber);
            expect(l.lapNumber).toBeGreaterThan(1);
            expect(isGreenLap(row)).toBe(true);
            expect(row.PitInTime == null && row.PitOutTime == null).toBe(true);
            fitted++;
          }
        }
        for (const s of HEAD_RULE(lt, drv)) {
          for (const p of s.clean) {
            if (p.lapNumber === 1) headLap1++;
            if (!p.green) {
              headNonGreen++;
              const row = byLap.get(p.lapNumber);
              if (!example && /[67]/.test(String(row.TrackStatus))) {
                example = `${year} R${round} ${drv} lap ${p.lapNumber} TrackStatus ${row.TrackStatus} ${p.t.toFixed(3)} s`;
              }
            }
          }
        }
      }
    }
    console.log(`${races.length} races: ${fitted} laps in the new fits, 0 lap 1 / pit / non-green; `
      + `HEAD rule kept ${headLap1} lap-1 laps and ${headNonGreen} non-green laps (e.g. VSC: ${example})`);
    expect(races.length).toBeGreaterThan(0);
    expect(headNonGreen).toBeGreaterThan(0);
    expect(headLap1).toBeGreaterThan(0);
  });

  it('causal: the unknown future changes nothing in the view', () => {
    for (const lap of [12, 20, 37]) {
      const now = leaderLapEndTime(LT, lap);
      for (const drv of ['ALO', 'LEC', 'PIA']) {
        const real = tyreDegradationView(LT, drv, { sessionNow: now });
        expect(tyreDegradationView(perturbFuture(LT, now), drv, { sessionNow: now })).toEqual(real);
        for (const s of real.stints) for (const l of s.laps) expect(lapEnd(drv, l.lapNumber)).toBeLessThanOrEqual(now);
      }
    }
  });

  it('render: the fuel constant is labelled as an assumption, no "tyre only" claim', () => {
    expect(FUEL_NOTE).toBe(`fuel-corr. = raw + ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap (assumed fuel effect, not measured)`);
    monzaAt(RACE_END, { focusDriver: 'ALO' });
    const t = text(TireDegradation);
    console.log(`TireDegradation footer: "${t.slice(t.indexOf('*fuel-corr.'))}"`);
    expect(t).toContain(`*${FUEL_NOTE} · ${FIT_NOTE}`);
    expect(t).toContain(`raw + ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap (assumed fuel effect, not measured)`);
    expect(t).toContain(`≥ ${MIN_FIT_LAPS} clean laps`);
    // the brush banner (backend fit) labels its corrected slope the same way
    monzaAt(RACE_END, {
      focusDriver: 'PIA',
      selectedLapRange: [10, 25],
      degradationRegression: {
        slope: -0.1414, slope_fuel_corrected: -0.1114, lap_start: 10, lap_end: 25, lap_end_used: 25,
      },
    });
    const b = html(TireDegradation);
    expect(b).toContain('fuel-corr.*');
    expect(b).toContain('raw slope + 0.030 s/lap: an assumed fuel effect, not measured');
    expect(b).not.toContain('tyre only');
    // a fit without a corrected slope shows the raw one only (no "+ ms/lap")
    monzaAt(RACE_END, {
      focusDriver: 'PIA',
      selectedLapRange: [10, 25],
      degradationRegression: { slope: -0.1414, lap_start: 10, lap_end: 25, lap_end_used: 25 },
    });
    const rawOnly = text(TireDegradation);
    // signed with a true minus sign (utils/colors.js signedDelta, V1)
    expect(rawOnly).toContain('−141 ms/lap');
    expect(rawOnly).not.toContain('fuel-corr.* +');
    expect(rawOnly).not.toMatch(/\+\s*ms\/lap/);
    // the component no longer fits on its own nor hard-codes the constant
    const src = fs.readFileSync(path.join(VIZ, 'TireDegradation.jsx'), 'utf8');
    expect(src).not.toMatch(/linearRegression|FUEL_CORRECTION|0\.030|\* 1\.3/);
  });
});

describe.skipIf(!haveMonza)('G5 consistency on the shared definition (Monza 2024)', () => {
  const view = consistencyView(LT, Infinity);
  const byDriver = Object.fromEntries(view.drivers.map((d) => [d.driver, d]));

  it('every classified finisher: σ = consistencySigma, <= 0.8 s; lap 1 / pit / non-green laps do not count', () => {
    const rows = [];
    expect(FINISHERS.length).toBe(19);
    for (const drv of FINISHERS) {
      const d = byDriver[drv];
      const c = consistencySigma(LT, drv);
      expect(d.std_dev).toBe(c.sigma);
      expect(d.sample_size).toBe(c.n);
      expect(d.outliers).toBe(c.outliers);
      expect(d.std_dev).toBeLessThanOrEqual(0.8);
      rows.push(`${drv} ${d.std_dev.toFixed(3)} (n ${d.sample_size}, ${c.stints} stints)`);
    }
    console.log(`Monza consistency sigma per finisher (residual sigma of per-stint fits):\n  ${rows.join('\n  ')}`);
    // Lap 1 of every driver made 20 s slower: nothing changes (lap 1 is not a clean lap)
    const alt = LT.map((r) => (r.LapNumber === 1 ? { ...r, LapTimeSeconds: r.LapTimeSeconds + 20 } : r));
    expect(consistencyView(alt, Infinity)).toEqual(view);
    // a lap made non-green (VSC) leaves the sample
    const lec = byDriver.LEC;
    const vsc = LT.map((r) => (r.Driver === 'LEC' && r.LapNumber === 30 ? { ...r, TrackStatus: '6' } : r));
    expect(consistencyView(vsc, Infinity).drivers.find((d) => d.driver === 'LEC').sample_size).toBe(lec.sample_size - 1);
  });

  it.skipIf(!PYTHON)('frontend == backend (processors/degradation.py) per driver, whole race and mid-race', () => {
    const drivers = [...new Set(LT.map((r) => r.Driver))].sort();
    const mid = leaderLapEndTime(LT, 30);
    const [pyEnd, pyMid] = pythonSigma(path.join(CACHE_DIR, 'session_2024_16_R.json'), drivers, [null, mid]);
    const viewMid = consistencyView(LT, mid);
    let compared = 0;
    for (const [v, py] of [[view, pyEnd], [viewMid, pyMid]]) {
      const by = Object.fromEntries(v.drivers.map((d) => [d.driver, d]));
      for (const drv of drivers) {
        if (py[drv].sigma == null) { expect(by[drv]).toBeUndefined(); continue; }
        expect(Math.abs(by[drv].std_dev - py[drv].sigma)).toBeLessThan(1e-9);
        expect(by[drv].sample_size).toBe(py[drv].n);
        expect(by[drv].outliers).toBe(py[drv].outliers);
        compared++;
      }
    }
    console.log(`frontend vs Python consistency_sigma: ${compared} driver-clock pairs equal to 1e-9 `
      + `(LEC ${pyEnd.LEC.sigma.toFixed(6)} / ${byDriver.LEC.std_dev.toFixed(6)}, STR ${pyEnd.STR.sigma.toFixed(6)} / ${byDriver.STR.std_dev.toFixed(6)})`);
    expect(compared).toBeGreaterThanOrEqual(38);
  });

  it('per-compound degradation = compoundDegradation of the driver\'s fits; badge and LOW DATA from σ and n', () => {
    for (const d of view.drivers) {
      const deg = compoundDegradation(stintFits(LT, { driver: d.driver }));
      for (const [c, row] of Object.entries(d.compounds)) {
        expect(row.deg_slope).toBe(deg[c] ? deg[c].mean : null);
        expect(row.deg_fits).toBe(deg[c] ? deg[c].n : 0);
      }
    }
    // the true median (D10): the mean of the two middle values for an even count
    const sigmas = view.drivers.map((d) => d.std_dev).sort((a, b) => a - b);
    const mid = Math.floor(sigmas.length / 2);
    const median = sigmas.length % 2 ? sigmas[mid] : (sigmas[mid - 1] + sigmas[mid]) / 2;
    expect(view.medianSigma).toBe(median);
    for (const d of view.drivers) expect(d.is_consistent).toBe(d.std_dev <= median);
    // LOW DATA: laps completed below LOW_DATA_FRACTION of the most laps
    // completed in the field (the backend's MIN_RACE_SHARE rule)
    const most = Math.max(...view.drivers.map((d) => d.laps_completed));
    expect(view.minLapsThreshold).toBe(Math.max(LOW_DATA_MIN_LAPS, Math.floor(most * LOW_DATA_FRACTION)));
    for (const d of view.drivers) expect(d.insufficient_data).toBe(d.laps_completed < view.minLapsThreshold);
    // at the end no finisher is LOW DATA
    for (const drv of FINISHERS) expect(byDriver[drv].insufficient_data).toBe(false);
    // even count of drivers (a synthetic field without the last-listed one): the median is between two
    const even = consistencyView(LT.filter((r) => r.Driver !== view.drivers[view.drivers.length - 1].driver), Infinity);
    if (even.drivers.length % 2 === 0) {
      const ss = even.drivers.map((d) => d.std_dev).sort((a, b) => a - b);
      expect(even.medianSigma).toBe((ss[ss.length / 2 - 1] + ss[ss.length / 2]) / 2);
    }
  });

  it('causal: same cards whatever the unknown future; none before a stint has 8 clean laps', () => {
    for (const lap of [15, 30]) {
      const now = leaderLapEndTime(LT, lap);
      expect(consistencyView(perturbFuture(LT, now), now)).toEqual(consistencyView(LT, now));
    }
    expect(consistencyView(LT, leaderLapEndTime(LT, MIN_FIT_LAPS)).drivers).toEqual([]);
  });

  it('render: ConsistencyPanel shows consistencySigma per driver; empty state explains the 8-lap minimum', () => {
    monzaAt(RACE_END);
    const t = text(ConsistencyPanel);
    for (const drv of FINISHERS) {
      const m = new RegExp(`${drv} .*?±(\\d+\\.\\d{3})s`).exec(t.slice(t.indexOf(` ${drv} `) - 1));
      expect(m, drv).not.toBeNull();
      expect(m[1]).toBe(byDriver[drv].std_dev.toFixed(3));
    }
    monzaAt(leaderLapEndTime(LT, 5));
    expect(text(ConsistencyPanel)).toContain(`σ needs a stint with at least ${MIN_FIT_LAPS} clean laps`);
    // expanded card: residual σ and the per-compound degradation in s/lap
    monzaAt(RACE_END, { focusDriver: 'LEC' });
    const lec = text(ConsistencyPanel);
    expect(lec).toContain(`Residual σ ±${byDriver.LEC.std_dev.toFixed(3)}s`);
    expect(lec).toContain(`Deg: ${formatSlope(byDriver.LEC.compounds.MEDIUM.deg_slope)} s/lap`);
    expect(lec).not.toMatch(/Deg: [+-]?\d+(\.\d+)?%/);
  });

  it('render: DriverComparePanel Consistency row = consistencySigma of both drivers, at the end and mid-race', () => {
    for (const now of [RACE_END, leaderLapEndTime(LT, 30)]) {
      monzaAt(now, { compareDrivers: ['PIA', 'NOR'] });
      const t = text(DriverComparePanel);
      const m = /±(\d+\.\d{3})s Consistency ±(\d+\.\d{3})s/.exec(t);
      expect(m).not.toBeNull();
      expect(m[1]).toBe(consistencySigma(LT, 'PIA', { sessionNow: now }).sigma.toFixed(3));
      expect(m[2]).toBe(consistencySigma(LT, 'NOR', { sessionNow: now }).sigma.toFixed(3));
      console.log(`DriverComparePanel at ${now === RACE_END ? 'race end' : 'leader lap 30 end'}: "${m[0]}"`);
    }
    const src = fs.readFileSync(path.join(VIZ, 'DriverComparePanel.jsx'), 'utf8');
    expect(src).not.toMatch(/variance/);
    expect(fs.readFileSync(path.join(VIZ, 'ConsistencyPanel.jsx'), 'utf8')).not.toMatch(/consistencyStats|deg_rate/);
  });
});
