/**
 * View models of the tyre-degradation and consistency views
 * (components/visualizations/TireDegradation.jsx, ConsistencyPanel.jsx,
 * DriverComparePanel.jsx), all on the shared degradation definition of
 * utils/degradation.js: clean stint laps (lap 1, in-laps, out-laps and
 * non-green laps left out, slow outliers removed), per-stint fits on TyreLife
 * with the fuel correction, compound degradation and the consistency sigma.
 * Nothing here fits a line or computes a sigma on its own.
 *
 * Every function is causal at sessionNow (session seconds, raceTime.js):
 * only laps completed by then are used.
 *
 * Kept out of the component modules on purpose: React Fast Refresh hot-swaps
 * a module only when every export is a component, so a component file that
 * also exported these helpers was invalidated on each update instead.
 *
 * Pure module: no React, no D3, no store access.
 */
import {
  cleanStintLaps, stintFits, compoundDegradation, consistencySigma,
  FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS,
} from '../degradation';
import { driverCompletedLaps } from '../strategyViews';

/**
 * Fewest completed laps of the driver inside a brushed lap range for the
 * degradation chart to draw that range only; with fewer (the replay has not
 * reached the range yet) the whole race is drawn and the brush banner still
 * reports the range. The threshold the chart already used: a display rule,
 * not a model parameter.
 */
export const BRUSH_MIN_LAPS = 3;

/**
 * LOW DATA cut of the consistency cards: a driver who completed fewer race
 * laps than this share of the most laps completed in the field so far is
 * flagged. ASSUMPTION kept from the previous rule (H1/V1.4: a driver who
 * retires early gets an artificially narrow sigma from a small sample, HUL at
 * Sao Paulo 2024), and the same rule as the backend's /consistency
 * (backend/api/routers/analytics.py MIN_RACE_SHARE): it counts completed
 * laps, not the clean laps of the sigma, because SC, VSC and wet races leave
 * full-distance drivers with few clean laps and the flag is for DNFs.
 */
export const LOW_DATA_FRACTION = 0.75;

/**
 * Floor of the LOW DATA cut, laps: the backend's max(3, ...) in
 * analytics.py consistency_response, so both flag the same drivers.
 * ASSUMPTION kept from that rule, not measured.
 */
export const LOW_DATA_MIN_LAPS = 3;

/** The fuel-correction note shown with every fuel-corrected slope. */
export const FUEL_NOTE = `fuel-corr. = raw + ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap`
  + ' (assumed fuel effect, not measured)';

/** The clean-lap rule in one line, as the views state it. */
export const FIT_NOTE = `fit on stints with ≥ ${MIN_FIT_LAPS} clean laps; `
  + 'lap 1, pit in/out laps and non-green laps left out';

function finite(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Signed slope text, e.g. '+0.050' / '-0.128' (s/lap); '—' when null.
 *
 * @param {number|null} v
 * @param {number} [digits=3]
 * @returns {string}
 */
export function formatSlope(v, digits = 3) {
  const n = finite(v);
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
}

/**
 * The lap time a stint fit predicts for one lap, in raw (not fuel-corrected)
 * seconds: fit.intercept + fit.slope x TyreLife - FUEL_EFFECT_S_PER_LAP x
 * (LapNumber - 1), i.e. the fitted fuel-corrected time with the fuel
 * correction of degradation.js fuelCorrectedTime taken back out. Inside a
 * stint LapNumber - TyreLife is constant (docs/DEGRADATION_METHODOLOGY.md),
 * so these points lie on a line of slope fit.rawSlope over TyreLife.
 *
 * @param {{intercept: number, slope: number}} fit - a fitStint / stintFits row with a slope
 * @param {{LapNumber: number, TyreLife: number}} lap - lap_times row (or { lapNumber, tyreLife })
 * @returns {number|null}
 */
export function fitLapTime(fit, lap) {
  const slope = finite(fit?.slope);
  const intercept = finite(fit?.intercept);
  const tl = finite(lap?.TyreLife ?? lap?.tyreLife);
  const n = finite(lap?.LapNumber ?? lap?.lapNumber);
  if (slope == null || intercept == null || tl == null || n == null) return null;
  return intercept + slope * tl - FUEL_EFFECT_S_PER_LAP * (n - 1);
}

/**
 * JetBrains Mono, the face of the chart's labels (public/fonts): every
 * character 0.6 em wide; a line 1.32 em high, 1.02 em of it above the
 * baseline (hhea ascent and descent, the same in every weight).
 */
export const MONO_ADVANCE_EM = 0.6;
export const MONO_ASCENT_EM = 1.02;
export const MONO_DESCENT_EM = 0.3;

/**
 * Box (plot px) of a one-line JetBrains Mono label drawn at x, baseline y,
 * text-anchor start.
 *
 * @param {string} text
 * @param {number} x
 * @param {number} y - baseline
 * @param {number} fontPx
 * @returns {{x0: number, y0: number, x1: number, y1: number}}
 */
export function monoLabelBox(text, x, y, fontPx) {
  return {
    x0: x,
    y0: y - MONO_ASCENT_EM * fontPx,
    x1: x + [...String(text)].length * MONO_ADVANCE_EM * fontPx,
    y1: y + MONO_DESCENT_EM * fontPx,
  };
}

const boxesOverlap = (a, b) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0)
  && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Where the slope labels of the Tyre Degradation chart go: per fitted stint a
 * block of its lines (the fuel-corrected slope, then the raw one), one line
 * under the other, inside the plot and over no other label. The near places
 * are right of the end of the fit line (the place it had), above the end,
 * below it and left of it, first where each fits as it is, then each moved
 * inside the plot; a near place counts only where the block is nearer the
 * end of its own line than the end of any other stint's. Tried in order:
 *  (a) the near places for the whole block;
 *  (b) the near places for the first line alone;
 *  (c) any place in the plot, nearest the end of the line first, for the
 *      whole block with its first line led by the stint's tag ('S2 H'): a
 *      block far from its line could sit next to another stint's line end,
 *      and colour alone would not tell them apart (two stints on one
 *      compound share it);
 *  (d) the same for the tagged first line alone.
 * A block with no room left (a plot narrower than its line) is not drawn: the
 * slopes stay in the tooltip and the brush banner.
 *
 * @param {Array<{key: string, x: number, y: number, lines: string[], tag?: string}>} items -
 *   x, y: end of the stint's fit line (plot px); tag: the stint's name ('S<n> <tyre letter>')
 * @param {{width: number, height: number, fontPx: number,
 *   obstacles?: Array<{x0: number, y0: number, x1: number, y1: number}>}} plot -
 *   the plot area (px), the labels' size and the boxes of the other labels
 * @returns {Array<{key: string, x: number, lines: Array<{text: string, y: number}>,
 *   box: {x0: number, y0: number, x1: number, y1: number}}>} x: the lines' start,
 *   y: their baselines (text-anchor start)
 */
export function placeSlopeLabels(items, {
  width, height, fontPx, obstacles = [],
}) {
  const lineH = (MONO_ASCENT_EM + MONO_DESCENT_EM) * fontPx;
  const PAD = 4;
  const GAP = 3;
  const taken = [...obstacles];
  const out = [];
  // px from a box to a point (0 inside it)
  const distance = (b, p) => Math.hypot(Math.max(0, b.x0 - p.x, p.x - b.x1), Math.max(0, b.y0 - p.y, p.y - b.y1));
  for (const item of items) {
    const ownEnd = (b) => items.every((o) => o === item || distance(b, o) > distance(b, item));
    const tagged = item.tag ? [`${item.tag} ${item.lines[0]}`, ...item.lines.slice(1)] : item.lines;
    const attempts = [
      { lines: item.lines, far: false },
      { lines: item.lines.slice(0, 1), far: false },
      { lines: tagged, far: true },
      { lines: tagged.slice(0, 1), far: true },
    ];
    for (const { lines, far } of attempts) {
      const n = lines.length;
      const w = Math.max(...lines.map((t) => [...String(t)].length)) * MONO_ADVANCE_EM * fontPx;
      const h = n * lineH;
      if (w > width || h > height) continue;
      const at = (x0, y0) => {
        const x = clamp(x0, 0, width - w);
        const y = clamp(y0, 0, height - h);
        return {
          x0: x, y0: y, x1: x + w, y1: y + h, moved: x !== x0 || y !== y0,
        };
      };
      const free = (b) => !taken.some((t) => boxesOverlap(b, t));
      const near = (b) => free(b) && ownEnd(b);
      const tries = [
        at(item.x + PAD, item.y - h / 2),
        at(item.x - w, item.y - GAP - h),
        at(item.x - w, item.y + GAP),
        at(item.x - PAD - w, item.y - h / 2),
      ];
      // a place as it is first (moved inside the plot, the right and left
      // ones would sit on the fit line), then moved ones
      let box = far ? null : tries.find((b) => !b.moved && near(b)) || tries.find(near);
      if (far) {
        // every place of the plot (4 px apart sideways, 1 px up and down),
        // the block's nearest corner closest to the end of the line first
        const xs = new Set(tries.map((b) => b.x0));
        for (let x0 = 0; x0 <= width - w; x0 += 4) xs.add(x0);
        const spots = [];
        for (const x0 of xs) {
          for (let y0 = 0; y0 <= height - h; y0 += 1) {
            const dx = Math.max(0, x0 - item.x, item.x - (x0 + w));
            const dy = Math.max(0, y0 - item.y, item.y - (y0 + h));
            spots.push({ x0, y0, d: dx * dx + dy * dy });
          }
        }
        spots.sort((a, b) => a.d - b.d);
        const spot = spots.find((p) => free({ x0: p.x0, y0: p.y0, x1: p.x0 + w, y1: p.y0 + h }));
        if (spot) box = { x0: spot.x0, y0: spot.y0, x1: spot.x0 + w, y1: spot.y0 + h };
      }
      if (!box) continue;
      const placed = {
        x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1,
      };
      taken.push(placed);
      out.push({
        key: item.key,
        x: placed.x0,
        lines: lines.map((text, i) => ({ text, y: placed.y0 + i * lineH + MONO_ASCENT_EM * fontPx })),
        box: placed,
      });
      break;
    }
  }
  return out;
}

/**
 * Tyre-degradation chart of one driver at sessionNow: per stint (deriveStints
 * via cleanStintLaps, so a same-compound stop opens a new stint) its completed
 * laps, which of them are clean, and its stintFits row.
 *
 * Brush: with a lapRange [lo, hi] (either end null = open) the chart shows and
 * fits only the laps in the range (stintFits lapStart / lapEnd), unless the
 * driver has fewer than BRUSH_MIN_LAPS completed laps in it (rangeApplied
 * false: whole race).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string} driver
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {Array<number|null>|null} [opts.lapRange] - brushed [lo, hi] lap range
 * @returns {{stints: Array<{stintNumber: number, stintIndex: number, compound: string,
 *   startLap: number, endLap: number, laps: Array<Object>, cleanLaps: Array<Object>,
 *   excludedLaps: Array<Object>, cleanCount: number, fit: Object|null,
 *   line: {tyreMin: number, tyreMax: number, y1: number, y2: number}|null}>,
 *   yExtent: number[], rangeApplied: boolean}}
 *   laps: { lapNumber, lapTime, tyreLife, compound, clean, slowOutlier } of the
 *   completed laps (0 < time < 300 s) of the stint in the range; cleanLaps = the
 *   clean ones (the fit's laps, cleanCount of them); excludedLaps = the others
 *   with a TyreLife; fit = the stintFits row when it has a slope, else null;
 *   line = the fit drawn in raw lap time (fitLapTime at the clean laps with the
 *   lowest and highest TyreLife); yExtent = [min, max] clean lap time
 */
export function tyreDegradationView(lapTimes, driver, { sessionNow = Infinity, lapRange = null } = {}) {
  const empty = { stints: [], yExtent: [80, 100], rangeApplied: false };
  if (!driver || !Array.isArray(lapTimes) || lapTimes.length === 0) return empty;
  const done = driverCompletedLaps(lapTimes, driver, sessionNow);
  if (done.length === 0) return empty;

  const [lo, hi] = Array.isArray(lapRange) ? lapRange : [null, null];
  const inRange = (n) => (lo == null || n >= lo) && (hi == null || n <= hi);
  const rangeApplied = Array.isArray(lapRange)
    && done.filter((lt) => inRange(lt.LapNumber)).length >= BRUSH_MIN_LAPS;
  const use = rangeApplied ? inRange : () => true;
  const bounds = rangeApplied ? { lapStart: lo, lapEnd: hi } : {};

  // Rows of stintFits: stints with no lap in the range are left out there
  const fits = new Map(
    stintFits(lapTimes, { sessionNow, driver, ...bounds }).map((f) => [f.stintNumber, f]),
  );
  const stints = [];
  const allClean = [];
  for (const st of cleanStintLaps(lapTimes, { sessionNow, driver })) {
    const fitRow = fits.get(st.stintNumber);
    if (!fitRow) continue;
    const clean = new Set(st.laps.map((lt) => Number(lt.LapNumber)));
    const slow = new Set(st.outliers.map((lt) => Number(lt.LapNumber)));
    const laps = done
      .filter((lt) => lt.LapNumber >= st.startLap && lt.LapNumber <= st.endLap && use(lt.LapNumber))
      .map((lt) => ({
        lapNumber: lt.LapNumber,
        lapTime: lt.LapTimeSeconds,
        tyreLife: finite(lt.TyreLife),
        compound: st.compound,
        clean: clean.has(Number(lt.LapNumber)),
        slowOutlier: slow.has(Number(lt.LapNumber)),
      }));
    if (laps.length === 0) continue;
    const cleanLaps = laps.filter((l) => l.clean);
    cleanLaps.forEach((l) => allClean.push(l.lapTime));
    const fit = finite(fitRow.slope) != null ? fitRow : null;
    let line = null;
    if (fit && cleanLaps.length) {
      let first = cleanLaps[0];
      let last = cleanLaps[0];
      for (const l of cleanLaps) {
        if (l.tyreLife < first.tyreLife) first = l;
        if (l.tyreLife > last.tyreLife) last = l;
      }
      line = {
        tyreMin: first.tyreLife,
        tyreMax: last.tyreLife,
        y1: fitLapTime(fit, first),
        y2: fitLapTime(fit, last),
      };
    }
    stints.push({
      stintNumber: st.stintNumber,
      stintIndex: st.stintNumber - 1,
      compound: st.compound,
      startLap: st.startLap,
      endLap: st.endLap,
      laps,
      cleanLaps,
      excludedLaps: laps.filter((l) => !l.clean && l.tyreLife != null),
      cleanCount: fitRow.n,
      fit,
      line,
    });
  }
  const yExtent = allClean.length > 0
    ? [Math.min(...allClean), Math.max(...allClean)]
    : [80, 100];
  return { stints, yExtent, rangeApplied };
}

/** Median of a list of numbers (the mean of the two middle values for an even count); null when empty. */
function trueMedian(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Consistency cards (ConsistencyPanel) at sessionNow, the fields and rules of
 * the backend's /consistency (backend/api/routers/analytics.py
 * consistency_response; frontend == backend per driver, every cached race,
 * src/__tests__/degradation.consistencyParity.test.js): per driver with a
 * consistency sigma (at least one stint fitted)
 *  std_dev       consistencySigma: pooled residual sigma of the per-stint
 *                fits, seconds (tyre wear, fuel burn and stops do not count)
 *  sample_size / lap_count  its n (laps of the fitted stints)
 *  outliers      slow outliers left out of the fitted stints
 *  avg_lap, fastest, slowest, range  over the laps of the sigma (the clean
 *                laps of the driver's fitted stints)
 *  cv_percent    std_dev / avg_lap x 100
 *  compounds     per compound of the fitted stints: avg, count,
 *                avg_tyre_life (of those laps), deg_slope =
 *                compoundDegradation mean of those stints' slopes
 *                (fuel-corrected s/lap) and deg_fits = their number
 *  laps_completed  the driver's last completed lap
 *  is_consistent std_dev <= the median std_dev of the drivers listed (the
 *                true median: the mean of the two middle values for an even
 *                count, D10)
 *  insufficient_data  laps_completed < minLapsThreshold
 * sorted by avg_lap. minLapsThreshold = max(LOW_DATA_MIN_LAPS,
 * floor(LOW_DATA_FRACTION x the most laps completed by any driver));
 * sessionAvg = mean of the laps of every listed sigma.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {{drivers: Array<Object>, sessionAvg: number|null, minLapsThreshold: number,
 *   medianSigma: number|null}}
 */
export function consistencyView(lapTimes, sessionNow = Infinity) {
  const none = { drivers: [], sessionAvg: null, minLapsThreshold: 0, medianSigma: null };
  if (!Array.isArray(lapTimes) || lapTimes.length === 0) return none;
  const stints = cleanStintLaps(lapTimes, { sessionNow });
  const fits = stintFits(lapTimes, { sessionNow });
  const drivers = [...new Set(stints.map((s) => s.driver))];
  // Laps completed per driver (the last lap of its stints at sessionNow), and
  // the most laps completed in the field: the reference of the LOW DATA cut
  const lapsCompleted = {};
  for (const st of stints) lapsCompleted[st.driver] = Math.max(lapsCompleted[st.driver] || 0, st.endLap);
  let raceLength = 0;
  for (const n of Object.values(lapsCompleted)) raceLength = Math.max(raceLength, n);
  const minLapsThreshold = raceLength
    ? Math.max(LOW_DATA_MIN_LAPS, Math.floor(raceLength * LOW_DATA_FRACTION)) : LOW_DATA_MIN_LAPS;
  // Stints with a fit (whole-stint fit, as consistencySigma): the laps of the sigma
  const fitted = new Set(fits.filter((f) => f.slope != null).map((f) => `${f.driver}|${f.stintNumber}`));

  const results = [];
  const allClean = [];
  for (const drv of drivers) {
    const c = consistencySigma(lapTimes, drv, { sessionNow });
    if (c.sigma == null) continue;
    const laps = [];
    for (const st of stints) {
      if (st.driver !== drv || !fitted.has(`${drv}|${st.stintNumber}`)) continue;
      for (const lt of st.laps) {
        laps.push({ time: Number(lt.LapTimeSeconds), compound: st.compound, tyreLife: Number(lt.TyreLife) });
      }
    }
    const times = laps.map((l) => l.time);
    let sum = 0;
    for (const t of times) sum += t;
    const avg = sum / times.length;
    const fastest = Math.min(...times);
    const slowest = Math.max(...times);
    allClean.push(...times);

    const deg = compoundDegradation(fits.filter((f) => f.driver === drv));
    const byCompound = new Map();
    for (const l of laps) {
      if (!byCompound.has(l.compound)) byCompound.set(l.compound, []);
      byCompound.get(l.compound).push(l);
    }
    const compounds = {};
    for (const [compound, cl] of byCompound) {
      let t = 0;
      let age = 0;
      for (const l of cl) { t += l.time; age += l.tyreLife; }
      compounds[compound] = {
        avg: t / cl.length,
        count: cl.length,
        avg_tyre_life: Math.round((age / cl.length) * 10) / 10,
        deg_slope: deg[compound] ? deg[compound].mean : null,
        deg_fits: deg[compound] ? deg[compound].n : 0,
      };
    }

    results.push({
      driver: drv,
      team: '',
      number: '',
      avg_lap: avg,
      fastest,
      slowest,
      range: slowest - fastest,
      std_dev: c.sigma,
      cv_percent: avg > 0 ? (c.sigma / avg) * 100 : 0,
      sample_size: c.n,
      lap_count: c.n,
      laps_completed: lapsCompleted[drv],
      fitted_stints: c.stints,
      outliers: c.outliers,
      compounds,
    });
  }

  const medianSigma = trueMedian(results.map((r) => r.std_dev));
  for (const r of results) {
    r.insufficient_data = r.laps_completed < minLapsThreshold;
    r.is_consistent = r.std_dev <= medianSigma;
  }
  results.sort((a, b) => a.avg_lap - b.avg_lap);

  let total = 0;
  for (const t of allClean) total += t;
  return {
    drivers: results,
    sessionAvg: allClean.length ? total / allClean.length : null,
    minLapsThreshold,
    medianSigma,
  };
}

/**
 * What a brushed degradation fit (POST /api/predict/degradation, the store's
 * fetchDegradationRegression) depends on at sessionNow: per requested driver,
 * every stint that overlaps [lapStart, lapEnd] with its number, compound,
 * first and last completed lap, and its clean laps (cleanStintLaps, slow
 * outliers removed) inside the range. Two clocks with the same key give the
 * same stintFits rows, every field (the fit uses exactly these laps; the row
 * also names the stint's laps so far), so the store re-requests the fit
 * whenever the key changes (D6): a new lap in the range, a later lap of a
 * stint still growing (which can change which laps of the range are
 * outliers), a new stint in the range.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {string[]} drivers
 * @param {Object} opts - { sessionNow, lapStart, lapEnd } (session seconds; laps inclusive)
 * @returns {string}
 */
export function brushFitKey(lapTimes, drivers, { sessionNow = Infinity, lapStart, lapEnd } = {}) {
  if (!Array.isArray(lapTimes) || !Array.isArray(drivers)) return '';
  const lo = finite(lapStart) ?? -Infinity;
  const hi = finite(lapEnd) ?? Infinity;
  return drivers.map((drv) => {
    const parts = [];
    for (const st of cleanStintLaps(lapTimes, { sessionNow, driver: drv })) {
      if (st.endLap < lo || st.startLap > hi) continue;
      const laps = st.laps.map((lt) => Number(lt.LapNumber)).filter((n) => n >= lo && n <= hi);
      parts.push(`${st.stintNumber}:${st.compound}:${st.startLap}-${st.endLap}:${laps.join('.')}`);
    }
    return `${drv}=${parts.join('/')}`;
  }).join(';');
}
