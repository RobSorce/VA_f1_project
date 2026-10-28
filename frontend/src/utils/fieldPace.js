/**
 * Race pace of this race: who had the pace, how sure is that, and who beat
 * his team-mate. The view is components/visualizations/FieldPace.jsx.
 *
 * Comparable lap (all of): lap > 1, no pit-in and no pit-out, TrackStatus
 * exactly '1' (green for the whole lap), 0 < LapTimeSeconds < 200, not
 * deleted, its tyre class (dry: SOFT / MEDIUM / HARD; wet: INTERMEDIATE /
 * WET) the majority class among the laps of that lap number passing the
 * rules before (no lap of a lap number with a tie counts), and not a red-flag
 * restart lap (from the lap of a red flag to two laps after its end).
 *
 * LapRep(j) = the median of the comparable laps of lap j, when at least
 * PACE_MIN_LAP_FIELD of them exist; a lap is then
 *     pct = 100 * (t / LapRep(j) - 1)
 * negative = faster than the same-lap field median. Comparing each lap with
 * the field on the same lap takes out what every car shares on that lap
 * (fuel, track evolution, wind).
 *
 * A driver: the median pct over his comparable laps, with an 80 % interval
 * from a moving-block bootstrap (blocks of PACE_BLOCK_LAPS consecutive laps of
 * the driver, PACE_BOOTSTRAP_RUNS resamples, seeded with prng.js seedFrom so
 * the same laps always give the same interval). Laps of one car are
 * correlated (tyre age, traffic), so an iid bootstrap would give intervals
 * too narrow. Under PACE_LOW_DATA_LAPS laps: LOW DATA.
 *
 * A team: the median pct of its drivers' laps together (the row order), and
 * the team-mate gap = the faster driver's median minus the slower's, with
 * the 80 % interval of the same difference over the paired resamples.
 * "decisive" when that interval, as printed (two decimals), excludes 0, so a
 * line never reads "[−1.01, 0.00] · decisive"; a gap with a driver under
 * PACE_LOW_DATA_LAPS laps reads "low data" (at 5 laps or fewer the bootstrap
 * has one block: its interval collapses to a point and would always exclude 0).
 *
 * Causal: only laps completed at sessionNow (raceTime.js completedLaps),
 * red flags started by then.
 *
 * Pure module: no React, no D3, no store access.
 */
import { completedLaps, hasPitIn, hasPitOut, isGreenLap } from './raceTime';
import { traceBands } from './raceTrace';
import { seedFrom, uniformAt } from './prng';

/** LapRep(j) needs at least this many comparable laps of lap j. */
export const PACE_MIN_LAP_FIELD = 5;
/** A driver with fewer comparable laps is LOW DATA. */
export const PACE_LOW_DATA_LAPS = 10;
/** Laps of a moving block of the bootstrap. */
export const PACE_BLOCK_LAPS = 5;
/** Resamples of the bootstrap. */
export const PACE_BOOTSTRAP_RUNS = 1000;
/** Coverage of the interval (p10 to p90 of the resampled medians). */
export const PACE_INTERVAL = 0.8;
/** A comparable lap is shorter than this (s). */
export const PACE_MAX_LAP_S = 200;
/** Laps after the end of a red flag that are restart laps. */
export const RED_RESTART_LAPS = 2;

const DRY = new Set(['SOFT', 'MEDIUM', 'HARD']);
const WET = new Set(['INTERMEDIATE', 'WET']);
// prng stream of the bootstrap draws (prng.js STREAMS holds the simulation's)
const BOOTSTRAP_STREAM = 101;

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Empirical quantile with linear interpolation of a sorted array. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** 'dry', 'wet' or null (unknown compound). */
export function tyreClass(compound) {
  const c = String(compound ?? '').trim().toUpperCase();
  if (DRY.has(c)) return 'dry';
  if (WET.has(c)) return 'wet';
  return null;
}

function isDeleted(row) {
  const d = row?.Deleted;
  return d === true || d === 1 || String(d).toLowerCase() === 'true';
}

/**
 * The comparable laps at sessionNow (see the module comment), each with its
 * LapRep and pct; laps of a lap number with fewer than PACE_MIN_LAP_FIELD
 * comparable laps have no LapRep and are left out.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {Array<Object>} [opts.trackStatus] - sessionData.track_status (red flags)
 * @param {[number, number]|null} [opts.lapRange] - only these laps (inclusive)
 * @returns {{laps: Array<{driver: string, lap: number, t: number, rep: number, pct: number}>,
 *   reps: Map<number, {rep: number, n: number}>}}
 */
export function comparableLaps(lapTimes, { sessionNow = Infinity, trackStatus = [], lapRange = null } = {}) {
  const red = traceBands(trackStatus, lapTimes, sessionNow)
    .filter((b) => b.kind === 'RED')
    .map((b) => [b.startLap, b.endLap + RED_RESTART_LAPS]);
  const byLap = new Map();
  const seen = new Set();
  for (const r of completedLaps(lapTimes, sessionNow)) {
    const lap = toNum(r?.LapNumber);
    const t = toNum(r?.LapTimeSeconds);
    if (!r?.Driver || lap == null || lap <= 1 || t == null || !(t > 0 && t < PACE_MAX_LAP_S)) continue;
    if (lapRange && (lap < lapRange[0] || lap > lapRange[1])) continue;
    if (hasPitIn(r) || hasPitOut(r) || !isGreenLap(r) || isDeleted(r)) continue;
    if (red.some(([a, b]) => lap >= a && lap <= b)) continue;
    const cls = tyreClass(r.Compound);
    if (!cls) continue;
    const key = `${r.Driver}|${lap}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byLap.has(lap)) byLap.set(lap, []);
    byLap.get(lap).push({ driver: r.Driver, lap, t, cls });
  }
  const laps = [];
  const reps = new Map();
  for (const [lap, list] of [...byLap.entries()].sort((a, b) => a[0] - b[0])) {
    const dry = list.filter((e) => e.cls === 'dry').length;
    const wet = list.length - dry;
    if (dry === wet) continue;
    const major = dry > wet ? 'dry' : 'wet';
    const kept = list.filter((e) => e.cls === major);
    if (kept.length < PACE_MIN_LAP_FIELD) continue;
    const rep = median(kept.map((e) => e.t));
    reps.set(lap, { rep, n: kept.length });
    for (const e of kept) laps.push({ driver: e.driver, lap, t: e.t, rep, pct: 100 * (e.t / rep - 1) });
  }
  return { laps, reps };
}

/**
 * Medians of the moving-block bootstrap resamples of `values` (in lap
 * order): PACE_BOOTSTRAP_RUNS resamples of n values, each the concatenation
 * of blocks of min(PACE_BLOCK_LAPS, n) consecutive values starting at a
 * uniform position, cut to n. Deterministic for a seed.
 *
 * @param {number[]} values
 * @param {number} seed - uint32 (prng.js seedFrom)
 * @returns {number[]} one median per resample, in resample order
 */
export function blockBootstrapMedians(values, seed) {
  const n = values.length;
  if (!n) return [];
  const L = Math.min(PACE_BLOCK_LAPS, n);
  const starts = n - L + 1;
  const blocks = Math.ceil(n / L);
  const out = new Array(PACE_BOOTSTRAP_RUNS);
  // a typed array sorts numerically in place, without a comparator
  const sample = new Float64Array(n);
  const mid = Math.floor(n / 2);
  for (let r = 0; r < PACE_BOOTSTRAP_RUNS; r++) {
    let k = 0;
    for (let b = 0; b < blocks && k < n; b++) {
      const s = Math.min(starts - 1, Math.floor(uniformAt(seed, r, 0, b, BOOTSTRAP_STREAM) * starts));
      for (let i = 0; i < L && k < n; i++) sample[k++] = values[s + i];
    }
    sample.sort();
    out[r] = n % 2 ? sample[mid] : (sample[mid - 1] + sample[mid]) / 2;
  }
  return out;
}

/** A value as gapLine prints it (two decimals), sign kept: -0.004 -> -0. */
function shown2(v) {
  return Math.sign(v) * Number(Math.abs(v).toFixed(2));
}

/**
 * Verdict of a team-mate gap: 'low data' when a driver is LOW DATA, else
 * 'decisive' when the interval as printed (two decimals) excludes 0, else
 * 'not decisive'.
 *
 * @param {number} lo - lower bound of the gap's interval (pct)
 * @param {number} hi - upper bound (pct)
 * @param {boolean} [lowData=false]
 * @returns {'decisive'|'not decisive'|'low data'}
 */
export function gapVerdict(lo, hi, lowData = false) {
  if (lowData) return 'low data';
  return shown2(hi) < 0 || shown2(lo) > 0 ? 'decisive' : 'not decisive';
}

/** p10 / p90 (PACE_INTERVAL) of resampled values. */
function interval(resamples) {
  const sorted = [...resamples].sort((a, b) => a - b);
  const tail = (1 - PACE_INTERVAL) / 2;
  return [quantile(sorted, tail), quantile(sorted, 1 - tail)];
}

/**
 * The race pace at sessionNow.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow=Infinity] - session seconds
 * @param {Array<Object>} [opts.trackStatus]
 * @param {[number, number]|null} [opts.lapRange] - the brushed lap range
 * @param {Array<Object>} [opts.driverInfo] - sessionData.driver_info (TeamName), else the rows' Team
 * @returns {{comparable: number, repLaps: number, lapRange: [number, number]|null,
 *   drivers: Object<string, {driver: string, team: string, n: number, median: number|null,
 *     lo: number|null, hi: number|null, lowData: boolean, firstLap: number|null, lastLap: number|null}>,
 *   teams: Array<{team: string, drivers: string[], median: number|null, n: number,
 *     gap: {faster: string, slower: string, value: number, lo: number, hi: number,
 *       verdict: 'decisive'|'not decisive'|'low data'}|null}>}}
 *   pct values (negative = faster than the same-lap field median); teams sorted by median
 */
export function fieldPace(lapTimes, {
  sessionNow = Infinity, trackStatus = [], lapRange = null, driverInfo = null,
} = {}) {
  const { laps, reps } = comparableLaps(lapTimes, { sessionNow, trackStatus, lapRange });
  const teamOf = new Map();
  for (const d of Array.isArray(driverInfo) ? driverInfo : []) {
    if (d?.Abbreviation && d.TeamName) teamOf.set(d.Abbreviation, d.TeamName);
  }
  for (const r of Array.isArray(lapTimes) ? lapTimes : []) {
    if (r?.Driver && r.Team && !teamOf.has(r.Driver)) teamOf.set(r.Driver, r.Team);
  }
  const lapsOf = new Map();
  for (const e of laps) {
    if (!lapsOf.has(e.driver)) lapsOf.set(e.driver, []);
    lapsOf.get(e.driver).push(e);
  }
  const drivers = {};
  const resamples = new Map();
  for (const driver of new Set([...teamOf.keys(), ...lapsOf.keys()])) {
    const list = (lapsOf.get(driver) || []).sort((a, b) => a.lap - b.lap);
    const values = list.map((e) => e.pct);
    const seed = seedFrom('field-pace', driver, values.length, list[0]?.lap ?? 0, list[list.length - 1]?.lap ?? 0);
    const boot = blockBootstrapMedians(values, seed);
    resamples.set(driver, boot);
    const [lo, hi] = boot.length ? interval(boot) : [null, null];
    drivers[driver] = {
      driver,
      team: teamOf.get(driver) || '?',
      n: values.length,
      median: median(values),
      lo,
      hi,
      lowData: values.length < PACE_LOW_DATA_LAPS,
      firstLap: list[0]?.lap ?? null,
      lastLap: list[list.length - 1]?.lap ?? null,
    };
  }

  const byTeam = new Map();
  for (const d of Object.values(drivers)) {
    if (!byTeam.has(d.team)) byTeam.set(d.team, []);
    byTeam.get(d.team).push(d.driver);
  }
  const teams = [];
  for (const [team, list] of byTeam) {
    const members = list.sort((a, b) => (a < b ? -1 : 1));
    const pooled = members.flatMap((d) => (lapsOf.get(d) || []).map((e) => e.pct));
    let gap = null;
    const racing = members.filter((d) => drivers[d].n > 0);
    if (racing.length === 2) {
      const [a, b] = racing;
      const fa = drivers[a].median <= drivers[b].median;
      const faster = fa ? a : b;
      const slower = fa ? b : a;
      const ra = resamples.get(faster);
      const rb = resamples.get(slower);
      const diffs = ra.map((v, i) => v - rb[i]);
      const [lo, hi] = interval(diffs);
      const low = drivers[faster].lowData || drivers[slower].lowData;
      gap = {
        faster,
        slower,
        value: drivers[faster].median - drivers[slower].median,
        lo,
        hi,
        verdict: gapVerdict(lo, hi, low),
      };
    }
    teams.push({
      team, drivers: members, median: median(pooled), n: pooled.length, gap,
    });
  }
  teams.sort((a, b) => {
    if (a.median == null || b.median == null) return a.median == null ? (b.median == null ? 0 : 1) : -1;
    return a.median - b.median;
  });
  return {
    comparable: laps.length,
    repLaps: reps.size,
    lapRange: lapRange ? [lapRange[0], lapRange[1]] : null,
    drivers,
    teams,
  };
}

/** '−0.23 %' (true minus) / '+0.23 %', two decimals. */
export function pctText(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v).toFixed(2);
  if (Number(abs) === 0) return '0.00 %';
  return v > 0 ? `+${abs} %` : `−${abs} %`;
}

/** Interval as '[−0.41, −0.05]'. */
function signed2(v) {
  const abs = Math.abs(v).toFixed(2);
  if (Number(abs) === 0) return '0.00';
  return v > 0 ? `+${abs}` : `−${abs}`;
}

/**
 * The team-mate line of a team row: 'LEC −0.23 % [−0.41, −0.05] · decisive'.
 *
 * @param {Object|null} gap - a fieldPace team's gap
 * @returns {string}
 */
export function gapLine(gap) {
  if (!gap) return '';
  return `${gap.faster} ${pctText(gap.value)} [${signed2(gap.lo)}, ${signed2(gap.hi)}] · ${gap.verdict}`;
}
