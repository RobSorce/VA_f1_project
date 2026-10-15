/**
 * The PCA biplot's lasso analysis and its rows at a replay clock, ported from
 * backend/data/processors/pca_compute.py for the static demo (utils/demoData.js
 * answers POST /api/pca/analyze-selection and GET /api/pca/embeddings with a
 * replay clock from public/data/ when there is no backend, utils/demoMode.js).
 *
 * Same definitions, same constants, same order of operations as the Python
 * module, so that both give the same answer to the same input:
 *  - raceFeatureRows: the feature rows of one race at session_now
 *    (race_feature_rows: eligibility, fuel-corrected pace, clean laps and
 *    fits of utils/degradation.js, visible stints, relative pace features);
 *  - embeddingsAt: the biplot during a replay (pca_embeddings_at): the rows of
 *    the race at the clock projected on the basis fitted without it (the
 *    basis comes from the export, scripts/export_demo_data.py);
 *  - analyzeSelection: Hedges' g and its 95% normal-approximation interval
 *    (Hedges and Olkin 1985), the seeded random-selection baseline
 *    stratified by row kind (numpy's default_rng: PCG64 seeded by
 *    SeedSequence, ported below, so the 1000 random selections are numpy's),
 *    the family-wise thresholds, the stints, pit windows and texts.
 * Python's float sum() (Neumaier-compensated since 3.12), numpy's pairwise
 * sum, median, linear quantile and round-half-even formatting are reproduced
 * where the Python module uses them. src/__tests__/demo.pcaSelectionStats.test.js
 * runs the Python module on the same input and compares every number (1e-9)
 * and every text.
 *
 * Pure module: no React, no D3, no store, no I/O.
 */
import { cleanStintLaps, stintFits, consistencySigma, fuelCorrectedTime } from './degradation';
import { deriveStints } from './stints';
import { isLapCompleted, lapEndTime } from './raceTime';

// ── Constants of pca_compute.py (the parity test compares them) ─────────────

export const MIN_LAP_SHARE = 0.9;
export const MIN_CLEAN_LAPS = 5;
export const RECENT_LAPS = 5;
export const FEATURE_COLS = Object.freeze([
  'pace_delta_pct', 'best_lap_delta_pct', 'recent_pace_delta_pct',
  'sector1_delta_pct', 'sector2_delta_pct', 'sector3_delta_pct',
  'consistency_pct', 'degradation_slope',
  'pit_count', 'avg_stint_length', 'max_stint_length',
  'grid_position',
]);
export const FEATURE_LABELS = Object.freeze({
  pace_delta_pct: ['Race Pace vs Field', '%', 'lower'],
  best_lap_delta_pct: ['Best Lap vs Field', '%', 'lower'],
  recent_pace_delta_pct: ['Last 5-Lap Pace vs Field', '%', 'lower'],
  sector1_delta_pct: ['Sector 1 vs Field', '%', 'lower'],
  sector2_delta_pct: ['Sector 2 vs Field', '%', 'lower'],
  sector3_delta_pct: ['Sector 3 vs Field', '%', 'lower'],
  consistency_pct: ['Lap-Time Scatter', '%', 'lower'],
  degradation_slope: ['Tyre Degradation', 's/lap', null],
  pit_count: ['Pit Stops', '', null],
  avg_stint_length: ['Avg Stint Length', 'laps', null],
  max_stint_length: ['Longest Stint', 'laps', null],
  grid_position: ['Grid Position', '', 'lower'],
});
export const FEATURE_CATEGORY = Object.freeze({
  pace_delta_pct: 'pace', best_lap_delta_pct: 'pace', recent_pace_delta_pct: 'pace',
  sector1_delta_pct: 'sectors', sector2_delta_pct: 'sectors', sector3_delta_pct: 'sectors',
  consistency_pct: 'consistency', degradation_slope: 'deg',
  pit_count: 'stops', avg_stint_length: 'stint_len', max_stint_length: 'stint_len',
  grid_position: 'position',
});
// raw driver statistic -> relative feature (100 * (s / race median - 1))
const RELATIVE = [
  ['_pace_s', 'pace_delta_pct'], ['_best_s', 'best_lap_delta_pct'], ['_recent_s', 'recent_pace_delta_pct'],
  ['_s1_s', 'sector1_delta_pct'], ['_s2_s', 'sector2_delta_pct'], ['_s3_s', 'sector3_delta_pct'],
];
export const SELECTION_SEED = 20261014;
export const MIN_GROUP_FOR_INTERVAL = 2;
export const BASELINE_DRAWS = 1000;
export const CI_LEVEL = 0.95;
export const BASELINE_QUANTILE = 0.95;
export const ROW_FINISHED = 'post-race';
export const ROW_LIVE = 'session_now';
export const PROGRESS_DEPENDENT_FEATURES = Object.freeze(
  ['degradation_slope', 'pit_count', 'avg_stint_length', 'max_stint_length'],
);
export const TIE_TOLERANCE = 1e-9;
export const THRESHOLD_MAX = 'max';
export const THRESHOLD_PER_FEATURE = 'per_feature';
export const ANALYSIS_LABEL = 'Descriptive differences, not a test';
export const ANALYSIS_NOTE = (
  'The selection was drawn on a projection of these same features, so large |g| values '
  + 'are expected by construction. Baseline = |g| of random selections of the same size and '
  + 'the same mix of row kinds (during a replay: rows of the race on screen at the clock, '
  + 'rows of finished races); exceeds_random marks a feature whose |g| is above the 95th '
  + 'percentile of the largest |g| over all features in those random selections. When the '
  + 'compared rows mix the two kinds, each feature is held to its own threshold instead: the '
  + 'same high percentile of its own random |g| for every feature, chosen so that 5% of the '
  + 'random selections pass the threshold of some feature (the progress-dependent features '
  + 'reach far larger |g| in random selections and would otherwise set the threshold of all).'
);
const CLUSTER_WORDS = {
  pace: ['Fast pace', 'Slow pace'],
  sectors: ['Fast sectors', 'Slow sectors'],
  position: ['Front of grid', 'Back of grid'],
  consistency: ['Consistent', 'Inconsistent'],
  stops: ['Few stops', 'Multi-stop'],
  stint_len: ['Short stints', 'Long stints'],
  deg: ['Low degradation', 'High degradation'],
};
const COMPOUND_ORDER = ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'];

// ── Python / numpy arithmetic ───────────────────────────────────────────────

/** Python's stripped float(): a finite number, else null (stints.py _number). */
export function pyNumber(v) {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
const nan = (v) => (v == null ? NaN : v);

/**
 * Python 3.12's built-in sum() of floats: Neumaier's compensated sum, the
 * compensation added at the end when it is finite and non-zero.
 */
export function pySum(values) {
  let f = 0;
  let c = 0;
  let first = true;
  for (const x of values) {
    if (first) { f = x; first = false; continue; } // 0 + x0 (int start + first float)
    const t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x;
    else c += (x - t) + f;
    f = t;
  }
  if (c && Number.isFinite(c)) f += c;
  return f;
}

/** pca_compute._mean: Python sum / count of the non-null values, NaN when none. */
function pyMean(values) {
  const vals = [];
  for (const v of values) if (v != null) vals.push(v);
  return vals.length ? pySum(vals) / vals.length : NaN;
}

function pairwise(a, lo, n) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[lo + i];
    return res;
  }
  if (n <= 128) {
    const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j] += a[lo + i + j];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwise(a, lo, n2) + pairwise(a, lo + n2, n - n2);
}

/** numpy's sum of a float64 array (pairwise summation; 0 + the pairwise sum). */
export function npSum(a) {
  return 0 + pairwise(a, 0, a.length);
}

/** numpy's mean (npSum / n). */
export function npMean(a) {
  return npSum(a) / a.length;
}

/** numpy's nanmean: NaN replaced by 0, summed, divided by the count of numbers. */
function npNanMean(a) {
  let cnt = 0;
  const z = a.map((v) => { if (Number.isNaN(v)) return 0; cnt += 1; return v; });
  return npSum(z) / cnt;
}

/** numpy's median of numbers (mean of the two middle values of an even count). */
export function npMedian(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * numpy's nanquantile, method 'linear': NaN dropped, virtual index (n - 1) q,
 * numpy's _lerp (b - (b - a)(1 - t) when t >= 0.5, monotone). NaN when no number.
 */
export function npNanQuantile(values, q) {
  const a = values.filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return NaN;
  const vi = (n - 1) * q;
  let prev = Math.floor(vi);
  let next = prev + 1;
  if (prev < 0) prev = 0;
  if (prev > n - 1) prev = n - 1;
  if (next > n - 1) next = n - 1;
  const t = vi - Math.floor(vi);
  const lo = a[prev];
  const hi = a[next];
  const diff = hi - lo;
  return t >= 0.5 ? hi - diff * (1 - t) : lo + diff * t;
}

/** Python's round(x, nd): correctly rounded, exact ties (odd multiples of 2^-(nd+1)) to even. */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  return Number(pyFixed(x, nd));
}

/** Python's round(x) to an integer (ties to even). */
export function pyRoundInt(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's f'{x:.{nd}f}': the exact value correctly rounded, exact ties to even. */
export function pyFixed(x, nd) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const ax = Math.abs(x);
  let s = ax.toFixed(nd); // nearest; an exact tie goes away from zero
  const scaled = ax * 2 ** (nd + 1);
  if (Number.isInteger(scaled) && scaled % 2 === 1 && ax < 2 ** 52) {
    // exact tie: Python keeps the even last digit, toFixed took the larger one
    const digits = s.replace('.', '');
    if (Number(digits[digits.length - 1]) % 2 === 1) {
      const dec = (BigInt(digits) - 1n).toString().padStart(digits.length, '0');
      s = nd ? `${dec.slice(0, dec.length - nd) || '0'}.${dec.slice(dec.length - nd)}` : dec;
    }
  }
  return neg ? `-${s}` : s;
}

/** Python's f'{x:.{nd}%}'. */
export function pyPercent(x, nd) {
  return `${pyFixed(x * 100, nd)}%`;
}

/** Python's f'{x:+.{nd}f}'. */
function pySigned(x, nd) {
  const s = pyFixed(x, nd);
  return s.startsWith('-') ? s : `+${s}`;
}

/** Python's statistics.NormalDist().inv_cdf(p) (Wichura 1988, AS241), mu 0, sigma 1. */
export function normalInvCdf(p) {
  const q = p - 0.5;
  let num;
  let den;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    num = (((((((2.5090809287301226727e+3 * r + 3.3430575583588128105e+4) * r
      + 6.7265770927008700853e+4) * r + 4.5921953931549871457e+4) * r
      + 1.3731693765509461125e+4) * r + 1.9715909503065514427e+3) * r
      + 1.3314166789178437745e+2) * r + 3.3871328727963666080e+0) * q;
    den = (((((((5.2264952788528545610e+3 * r + 2.8729085735721942674e+4) * r
      + 3.9307895800092710610e+4) * r + 2.1213794301586595867e+4) * r
      + 5.3941960214247511077e+3) * r + 6.8718700749205790830e+2) * r
      + 4.2313330701600911252e+1) * r + 1.0);
    return num / den;
  }
  let r = q <= 0 ? p : 1.0 - p;
  r = Math.sqrt(-Math.log(r));
  if (r <= 5.0) {
    r -= 1.6;
    num = (((((((7.74545014278341407640e-4 * r + 2.27238449892691845833e-2) * r
      + 2.41780725177450611770e-1) * r + 1.27045825245236838258e+0) * r
      + 3.64784832476320460504e+0) * r + 5.76949722146069140550e+0) * r
      + 4.63033784615654529590e+0) * r + 1.42343711074968357734e+0);
    den = (((((((1.05075007164441684324e-9 * r + 5.47593808499534494600e-4) * r
      + 1.51986665636164571966e-2) * r + 1.48103976427480074590e-1) * r
      + 6.89767334985100004550e-1) * r + 1.67638483018380384940e+0) * r
      + 2.05319162663775882187e+0) * r + 1.0);
  } else {
    r -= 5.0;
    num = (((((((2.01033439929228813265e-7 * r + 2.71155556874348757815e-5) * r
      + 1.24266094738807843860e-3) * r + 2.65321895265761230930e-2) * r
      + 2.96560571828504891230e-1) * r + 1.78482653991729133580e+0) * r
      + 5.46378491116411436990e+0) * r + 6.65790464350110377720e+0);
    den = (((((((2.04426310338993978564e-15 * r + 1.42151175831644588870e-7) * r
      + 1.84631831751005468180e-5) * r + 7.86869131145613259100e-4) * r
      + 1.48753612908506148525e-2) * r + 1.36929880922735805310e-1) * r
      + 5.99832206555887937690e-1) * r + 1.0);
  }
  const x = num / den;
  return q < 0 ? -x : x;
}

// ── numpy.random.default_rng(seed): SeedSequence + PCG64 ───────────────────

const INIT_A = 0x43b0d7e5;
const MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd;
const MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd;
const MIX_MULT_R = 0x4973f715;
const POOL_SIZE = 4;

/** A non-negative integer as little-endian 32-bit words (numpy _coerce_to_uint32_array). */
function uint32Words(n) {
  const out = [];
  let v = n;
  do {
    out.push(v % 4294967296);
    v = Math.floor(v / 4294967296);
  } while (v > 0);
  return out;
}

/** numpy SeedSequence(entropy).generate_state(nWords, uint32). */
export function seedSequenceState(entropy, nWords) {
  const words = uint32Words(entropy);
  const hc = { v: INIT_A };
  const hashmix = (value) => {
    let x = (value ^ hc.v) >>> 0;
    hc.v = Math.imul(hc.v, MULT_A) >>> 0;
    x = Math.imul(x, hc.v) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
  };
  const mix = (x, y) => {
    const r = (Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y)) >>> 0;
    return (r ^ (r >>> 16)) >>> 0;
  };
  const pool = new Array(POOL_SIZE);
  for (let i = 0; i < POOL_SIZE; i++) pool[i] = hashmix(i < words.length ? words[i] : 0);
  for (let s = 0; s < POOL_SIZE; s++) {
    for (let d = 0; d < POOL_SIZE; d++) {
      if (s !== d) pool[d] = mix(pool[d], hashmix(pool[s]));
    }
  }
  for (let s = POOL_SIZE; s < words.length; s++) {
    for (let d = 0; d < POOL_SIZE; d++) pool[d] = mix(pool[d], hashmix(words[s]));
  }
  const out = [];
  let hb = INIT_B;
  for (let i = 0; i < nWords; i++) {
    let x = (pool[i % POOL_SIZE] ^ hb) >>> 0;
    hb = Math.imul(hb, MULT_B) >>> 0;
    x = Math.imul(x, hb) >>> 0;
    out.push((x ^ (x >>> 16)) >>> 0);
  }
  return out;
}

/** 128-bit value from two 64-bit halves given as 32-bit words, as 8 little-endian 16-bit limbs. */
function limbs128(hiHi, hiLo, loHi, loLo) {
  return [loLo & 0xffff, loLo >>> 16, loHi & 0xffff, loHi >>> 16,
    hiLo & 0xffff, hiLo >>> 16, hiHi & 0xffff, hiHi >>> 16];
}

// PCG_DEFAULT_MULTIPLIER_128 = 2549297995355413924 * 2^64 + 4865540595714422341
const PCG_MULT = limbs128(0x2360ed05, 0x1fc65da4, 0x4385df64, 0x9fccf645);

/** out = a * b + c mod 2^128 (16-bit limbs; every partial sum stays below 2^53). */
function mulAdd(a, b, c, out) {
  let carry = 0;
  for (let i = 0; i < 8; i++) {
    let acc = carry + c[i];
    for (let j = 0; j <= i; j++) acc += a[j] * b[i - j];
    const low = acc % 65536;
    out[i] = low;
    carry = (acc - low) / 65536;
  }
}

/**
 * numpy's PCG64 (XSL-RR 128/64) seeded like numpy.random.default_rng(seed):
 * SeedSequence(seed).generate_state(4, uint64) -> (initstate, initseq),
 * pcg_setseq_128_srandom_r. random(n) = n doubles of Generator.random.
 */
export class Pcg64 {
  constructor(seed) {
    const w = seedSequenceState(seed, 8);
    // uint64 words: v0 = w1:w0, v1 = w3:w2, v2 = w5:w4, v3 = w7:w6 (little-endian view);
    // state seed = v0 << 64 | v1, sequence = v2 << 64 | v3 (pcg64_set_seed)
    const initState = limbs128(w[1], w[0], w[3], w[2]);
    const initSeq = limbs128(w[5], w[4], w[7], w[6]);
    this.inc = new Array(8);
    let carry = 1; // (initseq << 1) | 1
    for (let i = 0; i < 8; i++) {
      const v = initSeq[i] * 2 + carry;
      this.inc[i] = v & 0xffff;
      carry = v >>> 16;
    }
    this.state = [0, 0, 0, 0, 0, 0, 0, 0];
    this.tmp = new Array(8);
    this.step();
    let c = 0;
    for (let i = 0; i < 8; i++) {
      const v = this.state[i] + initState[i] + c;
      this.state[i] = v & 0xffff;
      c = v >>> 16;
    }
    this.step();
  }

  step() {
    mulAdd(this.state, PCG_MULT, this.inc, this.tmp);
    const t = this.state;
    this.state = this.tmp;
    this.tmp = t;
  }

  /** The next 64-bit output as [high 32 bits, low 32 bits]. */
  next64() {
    this.step();
    const s = this.state;
    const xh = ((s[7] * 65536 + s[6]) ^ (s[3] * 65536 + s[2])) >>> 0;
    const xl = ((s[5] * 65536 + s[4]) ^ (s[1] * 65536 + s[0])) >>> 0;
    const rot = s[7] >>> 10;
    if (rot === 0) return [xh, xl];
    if (rot < 32) {
      return [((xh >>> rot) | (xl << (32 - rot))) >>> 0, ((xl >>> rot) | (xh << (32 - rot))) >>> 0];
    }
    if (rot === 32) return [xl, xh];
    const r = rot - 32;
    return [((xl >>> r) | (xh << (32 - r))) >>> 0, ((xh >>> r) | (xl << (32 - r))) >>> 0];
  }

  /** Generator.random(): (next64 >> 11) * 2^-53. */
  nextDouble() {
    const [h, l] = this.next64();
    return (h * 2097152 + (l >>> 11)) / 9007199254740992;
  }

  random(n) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.nextDouble();
    return out;
  }
}

// ── Selection statistics ────────────────────────────────────────────────────

/** pca_compute._g_from_sums for one pair of groups (NaN when undefined). */
export function gFromSums(n1, s1, q1, n2, s2, q2) {
  const m1 = s1 / n1;
  const m2 = s2 / n2;
  const ss1 = Math.max(q1 - s1 * m1, 0);
  const ss2 = Math.max(q2 - s2 * m2, 0);
  const df = n1 + n2 - 2;
  const sp = Math.sqrt((ss1 + ss2) / df);
  const j = 1 - 3 / (4 * df - 1);
  const g = (j * (m1 - m2)) / sp;
  if (n1 < 1 || n2 < 1 || df < 2 || !(sp > 1e-12) || Number.isNaN(m1) || Number.isNaN(m2)) return NaN;
  return g;
}

const dropNaN = (a) => a.filter((v) => !Number.isNaN(v));

/** pca_compute.hedges_g: Hedges' g of x against y (NaN dropped), NaN when undefined. */
export function hedgesG(x0, y0) {
  const x = dropNaN(x0);
  const y = dropNaN(y0);
  const c = x.length + y.length ? npMean([...x, ...y]) : 0;
  const xc = x.map((v) => v - c);
  const yc = y.map((v) => v - c);
  return gFromSums(xc.length, npSum(xc), npSum(xc.map((v) => v * v)),
    yc.length, npSum(yc), npSum(yc.map((v) => v * v)));
}

/** pca_compute.g_standard_error (Hedges and Olkin 1985). */
export function gStandardError(g, n1, n2) {
  return Math.sqrt((n1 + n2) / (n1 * n2) + (g * g) / (2 * (n1 + n2)));
}

/** pca_compute.g_interval: [low, high], or [null, null] (a group below minGroup rows, g undefined). */
export function gInterval(x0, y0, level = CI_LEVEL, minGroup = MIN_GROUP_FOR_INTERVAL) {
  const x = dropNaN(x0);
  const y = dropNaN(y0);
  if (x.length < Math.max(1, minGroup) || y.length < Math.max(1, minGroup)) return [null, null];
  const g = hedgesG(x, y);
  if (Number.isNaN(g)) return [null, null];
  const half = normalInvCdf(1 - (1 - level) / 2) * gStandardError(g, x.length, y.length);
  return [g - half, g + half];
}

/** pca_compute._above: value > threshold beyond TIE_TOLERANCE (NaN never above). */
export function above(value, threshold) {
  return value > threshold + TIE_TOLERANCE * Math.max(1.0, threshold);
}

/**
 * pca_compute.common_level_thresholds over |g| of random selections
 * (absG[draw][feature], NaN = undefined): [level, thresholds].
 */
export function commonLevelThresholds(absG, rate = 1 - BASELINE_QUANTILE) {
  const draws = absG.length;
  const nFeat = draws ? absG[0].length : 0;
  if (draws === 0 || nFeat === 0) return [null, []];
  const S = [];
  for (let f = 0; f < nFeat; f++) {
    const col = new Float64Array(draws);
    for (let d = 0; d < draws; d++) col[d] = Number.isNaN(absG[d][f]) ? -Infinity : absG[d][f];
    col.sort();
    S.push(col);
  }
  const share = (i) => {
    let n = 0;
    for (let d = 0; d < draws; d++) {
      for (let f = 0; f < nFeat; f++) {
        if (above(absG[d][f], S[f][i])) { n += 1; break; }
      }
    }
    return n / draws;
  };
  let lo = 0;
  let hi = draws - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (share(mid) <= rate) hi = mid;
    else lo = mid + 1;
  }
  return [(lo + 1) / draws, S.map((col) => (Number.isFinite(col[lo]) ? col[lo] : null))];
}

/** Indices of the k smallest values (numpy argsort(...)[:k], as a set). */
function smallestK(values, k) {
  const idx = Array.from(values.keys());
  idx.sort((a, b) => values[a] - values[b]);
  return idx.slice(0, k);
}

const opt = (v) => (v == null || Number.isNaN(v) ? null : v);

/**
 * pca_compute.random_selection_baseline: |g| of `draws` seeded random
 * selections against the other rows, per feature. values[row][feature]
 * (NaN = missing). With strata (one label per row), nSelected is
 * {label: count} and each selection draws count rows of each label.
 *
 * @returns {{mean: Array<number|null>, p95: Array<number|null>, max_p95: number|null,
 *   level: number|null, thresholds: Array<number|null>}}
 */
export function randomSelectionBaseline(values, nSelected, {
  draws = BASELINE_DRAWS, seed = SELECTION_SEED, quantile = BASELINE_QUANTILE, strata = null,
} = {}) {
  const nRows = values.length;
  const nFeat = nRows ? values[0].length : 0;
  const rng = new Pcg64(seed);
  const picks = Array.from({ length: draws }, () => []);
  if (strata == null) {
    for (let d = 0; d < draws; d++) picks[d] = smallestK(rng.random(nRows), nSelected);
  } else {
    for (const lab of Object.keys(nSelected).sort()) {
      const k = Number(nSelected[lab]);
      const pool = [];
      strata.forEach((s, i) => { if (s === lab) pool.push(i); });
      if (k > pool.length) throw new Error(`${k} rows of kind '${lab}' asked, ${pool.length} available`);
      if (k <= 0) continue;
      for (let d = 0; d < draws; d++) {
        for (const i of smallestK(rng.random(pool.length), k)) picks[d].push(pool[i]);
      }
    }
    for (const p of picks) p.sort((a, b) => a - b);
  }
  const absG = Array.from({ length: draws }, () => new Array(nFeat).fill(NaN));
  for (let f = 0; f < nFeat; f++) {
    const col = values.map((row) => row[f]);
    const w = col.map((v) => (Number.isNaN(v) ? 0 : 1));
    const anyW = w.some((v) => v > 0);
    const mean = anyW ? npNanMean(col) : 0;
    const x = col.map((v, i) => (w[i] > 0 ? v - mean : 0));
    const xx = x.map((v) => v * v);
    const wTot = w.reduce((a, b) => a + b, 0);
    const xTot = npSum(x);
    const qTot = npSum(xx);
    for (let d = 0; d < draws; d++) {
      let n1 = 0;
      let s1 = 0;
      let q1 = 0;
      for (const i of picks[d]) { n1 += w[i]; s1 += x[i]; q1 += xx[i]; }
      absG[d][f] = Math.abs(gFromSums(n1, s1, q1, wTot - n1, xTot - s1, qTot - q1));
    }
  }
  const mean = [];
  const p95 = [];
  for (let f = 0; f < nFeat; f++) {
    let s = 0;
    let c = 0;
    const col = [];
    for (let d = 0; d < draws; d++) {
      const v = absG[d][f];
      col.push(v);
      if (!Number.isNaN(v)) { s += v; c += 1; }
    }
    mean.push(opt(c ? s / c : NaN));
    p95.push(opt(npNanQuantile(col, quantile)));
  }
  const mx = absG.map((row) => {
    let m = NaN;
    for (const v of row) if (!Number.isNaN(v) && (Number.isNaN(m) || v > m)) m = v;
    return m;
  });
  const maxP = mx.some((v) => !Number.isNaN(v)) ? npNanQuantile(mx, quantile) : NaN;
  const [level, thresholds] = commonLevelThresholds(absG, 1 - quantile);
  return { mean, p95, max_p95: opt(maxP), level, thresholds: thresholds.map(opt) };
}

const baselineCache = new Map();

/** randomSelectionBaseline of one composition, cached per rows key and composition. */
function cachedBaseline(V, kinds, nByKind, rowsKey) {
  const composition = Object.keys(nByKind).sort().map((k) => `${k}:${nByKind[k]}`).join(',');
  const key = rowsKey == null ? null : `${rowsKey}|${composition}`;
  if (key != null && baselineCache.has(key)) return baselineCache.get(key);
  const out = randomSelectionBaseline(V, nByKind, { strata: kinds });
  if (key != null) {
    if (baselineCache.size >= 64) baselineCache.delete(baselineCache.keys().next().value);
    baselineCache.set(key, out);
  }
  return out;
}

/**
 * pca_compute.feature_differences: per-feature differences of the selected
 * rows from the others against the stratified random baseline.
 *
 * @param {{rows: Array<Array>, featureIndex: Array<number>, kinds: Array<string>, key?: string}} m
 *   analysis matrix (analysisMatrix)
 * @param {Array<boolean>} sel - selected rows
 */
export function featureDifferences(m, sel) {
  const cols = m.featureCols;
  const V = m.rows.map((row) => m.featureIndex.map((j) => nan(row[j])));
  const kinds = m.kinds;
  const live = kinds.map((k) => k === ROW_LIVE);
  const anyLive = live.some(Boolean);
  const anyFinished = live.some((l) => !l);
  const nByKind = { [ROW_FINISHED]: sel.filter((s, i) => s && !live[i]).length };
  if (anyLive) nByKind[ROW_LIVE] = sel.filter((s, i) => s && live[i]).length;
  const base = cachedBaseline(V, kinds, nByKind, m.key);
  // every random selection with this composition is the selection itself
  let noAlternative = true;
  for (const [kind, k] of Object.entries(nByKind)) {
    const n = kinds.filter((x) => x === kind).length;
    if (!(k === 0 || k === n)) noAlternative = false;
  }
  const perFeature = anyLive && anyFinished;
  const rule = perFeature ? THRESHOLD_PER_FEATURE : THRESHOLD_MAX;
  const thresholds = perFeature ? base.thresholds : cols.map(() => base.max_p95);
  const featureImportance = [];
  cols.forEach((col, j) => {
    const xs = dropNaN(V.filter((_, i) => sel[i]).map((r) => r[j]));
    const ys = dropNaN(V.filter((_, i) => !sel[i]).map((r) => r[j]));
    if (!xs.length || !ys.length) return;
    const g = hedgesG(xs, ys);
    if (Number.isNaN(g)) return;
    const [lo, hi] = gInterval(xs, ys);
    const [label, unit] = FEATURE_LABELS[col] || [col, '', null];
    const absG = Math.abs(g);
    const p95 = base.p95[j];
    const threshold = thresholds[j];
    let valueLive = false;
    let valueFinished = false;
    V.forEach((r, i) => {
      if (!Number.isNaN(r[j])) { if (live[i]) valueLive = true; else valueFinished = true; }
    });
    const mixed = valueLive && valueFinished;
    const xm = npMean(xs);
    const ym = npMean(ys);
    featureImportance.push({
      feature: col,
      label,
      unit,
      selected_mean: pyRound(xm, 3),
      rest_mean: pyRound(ym, 3),
      g: pyRound(g, 3),
      abs_g: pyRound(absG, 3),
      effect_size: pyRound(absG, 3),
      ci_low: lo != null ? pyRound(lo, 3) : null,
      ci_high: hi != null ? pyRound(hi, 3) : null,
      n_selected: xs.length,
      n_rest: ys.length,
      baseline_abs_g: base.mean[j] != null ? pyRound(base.mean[j], 3) : null,
      baseline_abs_g_p95: p95 != null ? pyRound(p95, 3) : null,
      threshold_abs_g: threshold != null ? pyRound(threshold, 3) : null,
      exceeds_random: !noAlternative && threshold != null && above(absG, threshold),
      progress_dependent: mixed && PROGRESS_DEPENDENT_FEATURES.includes(col),
      direction: xm > ym ? 'higher' : 'lower',
      magnitude: absG < 0.5 ? 'small' : (absG < 0.8 ? 'medium' : 'large'),
    });
  });
  // sorted by abs_g, largest first (stable: ties keep the feature order)
  featureImportance.sort((a, b) => b.abs_g - a.abs_g);
  return {
    featureImportance, baseline: base, nByKind, live, noRandomAlternative: noAlternative,
    thresholdRule: rule, thresholdLevel: perFeature ? base.level : null,
  };
}

// ── Rows of a race at session_now ───────────────────────────────────────────

const normaliseNow = (now) => (now == null || Number.isNaN(now) ? Infinity : now);

/** {driver: rows sorted by LapNumber}, in order of first appearance; the last row of a lap wins. */
function groupByDriver(lapRows) {
  const by = new Map();
  for (const lap of lapRows || []) {
    if (!lap || typeof lap !== 'object' || !lap.Driver) continue;
    const n = pyNumber(lap.LapNumber);
    if (n == null) continue;
    if (!by.has(lap.Driver)) by.set(lap.Driver, new Map());
    by.get(lap.Driver).set(n, lap);
  }
  const out = new Map();
  for (const [drv, laps] of by) out.set(drv, [...laps.keys()].sort((a, b) => a - b).map((n) => laps.get(n)));
  return out;
}

const UNKNOWN_COMPOUNDS = new Set(['', 'UNKNOWN', 'TEST_UNKNOWN', 'NAN', 'NONE', 'NULL']);

function knownCompound(c) {
  if (c == null) return null;
  const s = String(c).trim().toUpperCase();
  return UNKNOWN_COMPOUNDS.has(s) ? null : s;
}

function dominantCompound(compounds) {
  const counts = new Map();
  for (const c of compounds) if (c) counts.set(c, (counts.get(c) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [c, n] of counts) if (n > bestCount) { best = c; bestCount = n; }
  return best || 'UNKNOWN';
}

const pitOutSeconds = (lap) => pyNumber(lap?.PitOutTimeSeconds) ?? pyNumber(lap?.PitOutTime);

/**
 * pca_compute.visible_stints: one driver's stints visible at sessionNow with
 * their completed laps (driverStints = the stints of the full rows).
 */
export function visibleStints(driverRows, driverStints, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const byLap = new Map();
  for (const lap of driverRows) {
    const n = pyNumber(lap.LapNumber);
    if (n != null) byLap.set(Math.trunc(n), lap);
  }
  const out = [];
  driverStints.forEach((st, i) => {
    if (out.length < i) return; // an earlier stint was not visible
    const first = byLap.get(st.StartLap);
    if (i > 0 && now !== Infinity) {
      const exitT = first != null ? pitOutSeconds(first) : null;
      const visible = exitT != null && exitT > 0 ? exitT <= now : (first != null && isLapCompleted(first, now));
      if (!visible) return;
    }
    const done = [];
    for (let n = st.StartLap; n <= st.EndLap; n++) {
      if (byLap.has(n) && isLapCompleted(byLap.get(n), now)) done.push(n);
    }
    const end = done.length ? done[done.length - 1] : st.StartLap - 1;
    const known = done.map((n) => byLap.get(n));
    if (first != null && (!known.length || known[0] !== first)) known.unshift(first);
    out.push({
      StintNumber: st.StintNumber,
      Compound: dominantCompound(known.map((lap) => knownCompound(lap.Compound))),
      StartLap: st.StartLap,
      EndLap: end,
      TotalLaps: end - st.StartLap + 1,
      InLap: i > 0 ? driverStints[i - 1].EndLap : null,
    });
  });
  return out;
}

/** build_tyre_strategy of the full rows, grouped by driver (deriveStints at Infinity: parity-tested). */
function fullStintsByDriver(rows) {
  const out = new Map();
  for (const st of deriveStints(rows)) {
    if (!out.has(st.Driver)) out.set(st.Driver, []);
    out.get(st.Driver).push(st);
  }
  return out;
}

/** The lap rows of a payload that pca_compute reads (dicts with a Driver). */
function lapRowsOf(payload) {
  return ((payload && payload.lap_times) || []).filter((lap) => lap && typeof lap === 'object' && lap.Driver);
}

/**
 * pca_compute.race_feature_rows: the feature rows of one race at sessionNow
 * (null / Infinity = post-race): eligible drivers only, in order of first
 * appearance in lap_times.
 */
export function raceFeatureRows(payload, year, round, raceName = null, sessionNow = null) {
  const now = normaliseNow(sessionNow);
  const rows = lapRowsOf(payload);
  const done = rows.filter((lap) => isLapCompleted(lap, now) && pyNumber(lap.LapNumber) != null);
  if (!done.length) return [];
  const raceLaps = Math.trunc(Math.max(...done.map((lap) => pyNumber(lap.LapNumber))));
  const grouped = groupByDriver(rows);
  const cleanByDriver = new Map();
  for (const st of cleanStintLaps(rows, { sessionNow: now })) {
    if (!cleanByDriver.has(st.driver)) cleanByDriver.set(st.driver, []);
    cleanByDriver.get(st.driver).push(...st.laps);
  }
  const fitsByDriver = new Map();
  for (const f of stintFits(rows, { sessionNow: now })) {
    if (f.slope == null) continue;
    if (!fitsByDriver.has(f.driver)) fitsByDriver.set(f.driver, []);
    fitsByDriver.get(f.driver).push(f);
  }
  const stintsByDriver = fullStintsByDriver(rows);
  const team = {};
  for (const di of (payload && payload.driver_info) || []) {
    if (di && di.Abbreviation) team[di.Abbreviation] = di.TeamName || 'Unknown';
  }
  const results = {};
  for (const r of (payload && payload.race_results) || []) if (r && r.Abbreviation) results[r.Abbreviation] = r;
  const nCars = Object.keys(results).length;

  const out = [];
  for (const [drv, drows] of grouped) {
    const ddone = drows.filter((lap) => isLapCompleted(lap, now));
    if (!ddone.length) continue;
    const lapsDone = Math.trunc(pyNumber(ddone[ddone.length - 1].LapNumber));
    if (lapsDone < MIN_LAP_SHARE * raceLaps) continue;
    const clean = [...(cleanByDriver.get(drv) || [])]
      .sort((a, b) => pyNumber(a.LapNumber) - pyNumber(b.LapNumber));
    if (clean.length < MIN_CLEAN_LAPS) continue;
    const fc = clean.map((lap) => fuelCorrectedTime(lap));
    const raw = clean.map((lap) => pyNumber(lap.LapTimeSeconds));
    const sectors = [1, 2, 3].map((k) => pyMean(clean
      .map((lap) => pyNumber(lap[`Sector${k}TimeSeconds`]))
      .filter((v) => v != null && v > 0)));
    const sigma = consistencySigma(rows, drv, { sessionNow: now }).sigma;
    const fits = fitsByDriver.get(drv) || [];
    let nFit = 0;
    for (const f of fits) nFit += f.n;
    const stints = visibleStints(drows, stintsByDriver.get(drv) || [], now);
    const lengths = stints.map((st) => st.TotalLaps).filter((n) => n > 0);
    const res = results[drv] || {};
    let grid = pyNumber(res.GridPosition);
    if (grid != null && grid <= 0) grid = nCars; // pit-lane start: the back of the grid
    const pos = pyNumber(ddone[ddone.length - 1].Position);
    const finish = now === Infinity ? pyNumber(res.Position) : null;
    let lenSum = 0;
    for (const n of lengths) lenSum += n;
    out.push({
      driver: drv,
      team: team[drv] || drows[0].Team || 'Unknown',
      year: Math.trunc(year),
      round: Math.trunc(round),
      race_name: raceName || `Round ${round}`,
      _pace_s: pyMean(fc),
      _best_s: Math.min(...raw),
      _recent_s: pyMean(fc.slice(-RECENT_LAPS)),
      _s1_s: sectors[0],
      _s2_s: sectors[1],
      _s3_s: sectors[2],
      consistency_pct: sigma != null ? (100 * sigma) / pyMean(raw) : NaN,
      degradation_slope: nFit ? pySum(fits.map((f) => f.slope * f.n)) / nFit : NaN,
      pit_count: stints.length - 1,
      avg_stint_length: lengths.length ? lenSum / lengths.length : NaN,
      max_stint_length: lengths.length ? Math.max(...lengths) : NaN,
      grid_position: grid != null ? grid : NaN,
      laps_completed: lapsDone,
      race_laps: raceLaps,
      n_clean_laps: clean.length,
      as_of_lap: raceLaps,
      session_now: now === Infinity ? null : now,
      position: pos,
      finish_position: finish,
    });
  }
  for (const [rawCol, feat] of RELATIVE) {
    const vals = out.map((r) => r[rawCol]).filter((v) => !Number.isNaN(v));
    const ref = vals.length ? npMedian(vals) : NaN;
    for (const r of out) {
      const v = r[rawCol];
      delete r[rawCol];
      r[feat] = ref && !Number.isNaN(v) && !Number.isNaN(ref) ? 100 * (v / ref - 1) : NaN;
    }
  }
  return out;
}

/** pca_compute._leader_laps_done: the largest LapNumber completed at now (0 before the first). */
export function leaderLapsDone(payload, now) {
  let best = null;
  for (const lap of (payload && payload.lap_times) || []) {
    if (!lap || typeof lap !== 'object' || !isLapCompleted(lap, now)) continue;
    const n = pyNumber(lap.LapNumber);
    if (n != null && (best == null || n > best)) best = n;
  }
  return best == null ? 0 : Math.trunc(best);
}

/** pca_compute._analysis_now: Infinity without a clock / race, or once every timed row has ended. */
export function analysisNow(payload, year, round, sessionNow) {
  const now = normaliseNow(sessionNow);
  if (now === Infinity || year == null || round == null) return now;
  let maxEnd = null;
  for (const lap of (payload && payload.lap_times) || []) {
    if (!lap || typeof lap !== 'object') continue;
    const e = lapEndTime(lap);
    if (e != null && (maxEnd == null || e > maxEnd)) maxEnd = e;
  }
  return maxEnd != null && maxEnd <= now ? Infinity : now;
}

// ── Biplot at a replay clock ────────────────────────────────────────────────

/**
 * The rows projected on a fitted basis (pca_compute._project): missing values
 * filled with the fit's medians (then 0), standardised by the scaler, then
 * X C^T - mean C^T (scikit-learn's PCA.transform).
 *
 * @param {Array<Object>} rows - feature rows (raceFeatureRows)
 * @param {{cols: string[], medians: Array<number|null>, scaler_mean: number[],
 *   scaler_scale: number[], pca_mean: number[], components: number[][]}} fit
 * @returns {Array<[number, number]>}
 */
export function projectRows(rows, fit) {
  const k = fit.components.length;
  const centre = [];
  for (let c = 0; c < k; c++) {
    let s = 0;
    fit.cols.forEach((_, j) => { s += fit.pca_mean[j] * fit.components[c][j]; });
    centre.push(s);
  }
  return rows.map((row) => {
    const z = fit.cols.map((col, j) => {
      let v = row[col];
      if (!isNum(v) || !Number.isFinite(v)) v = fit.medians[j] != null ? fit.medians[j] : 0;
      return (v - fit.scaler_mean[j]) / fit.scaler_scale[j];
    });
    const out = [];
    for (let c = 0; c < k; c++) {
      let s = 0;
      z.forEach((v, j) => { s += v * fit.components[c][j]; });
      out.push(s - centre[c]);
    }
    return out;
  });
}

/** pca_compute._points of feature rows. */
function pointsOf(rows, emb, asOf) {
  return rows.map((row, i) => {
    const fin = opt(row.finish_position);
    return {
      id: `${row.driver}_${Math.trunc(row.year)}_${Math.trunc(row.round)}`,
      x: emb[i][0],
      y: emb[i][1],
      driver: row.driver,
      team: row.team ?? 'Unknown',
      year: Math.trunc(row.year),
      round: Math.trunc(row.round),
      race_name: row.race_name ?? `Round ${row.round}`,
      grid_position: opt(row.grid_position),
      position: opt(row.position),
      finish_position: fin != null && asOf === 'post-race' ? Math.trunc(fin) : null,
      as_of: asOf,
      as_of_lap: opt(row.as_of_lap),
    };
  });
}

/**
 * pca_compute.pca_embeddings_at: the biplot during a replay of (year, round)
 * at sessionNow (null / Infinity = post-race). fitWithout = the export's
 * pca/fit_without_{year}_{round} ({payload: the biplot without the race's
 * rows, fit: its basis}); payload = the race's session payload.
 */
export function embeddingsAt(fitWithout, payload, year, round, raceName, sessionNow) {
  const now = normaliseNow(sessionNow);
  const cur = raceFeatureRows(payload, year, round, raceName, now === Infinity ? null : now);
  const asOf = now === Infinity ? 'post-race' : 'session_now';
  const points = [...fitWithout.payload.points];
  if (cur.length) points.push(...pointsOf(cur, projectRows(cur, fitWithout.fit), asOf));
  const reason = cur.length ? null
    : `no driver has ${MIN_CLEAN_LAPS} clean laps and ${pyPercent(MIN_LAP_SHARE, 0)} of the leader's laps yet`;
  return {
    ...fitWithout.payload,
    points,
    n_points: points.length,
    features_as_of: asOf === 'post-race' ? asOf : 'mixed',
    current_race: {
      year: Math.trunc(year),
      round: Math.trunc(round),
      available: true,
      session_now: now === Infinity ? null : now,
      as_of: asOf,
      as_of_lap: leaderLapsDone(payload, now),
      n_points: cur.length,
      excluded_from_fit: true,
      reason,
    },
  };
}

// ── Lasso analysis ──────────────────────────────────────────────────────────

/**
 * pca_compute._analysis_matrix: the rows the analysis compares. matrix = the
 * export's pca/matrix ({columns, feature_cols, rows} post-race, in the
 * backend's row order); race = {year, round, payload, raceName} of the race on
 * screen (payload null when it is not bundled).
 */
export function analysisMatrix(matrix, race, sessionNow) {
  const featureCols = matrix.feature_cols;
  const featureIndex = featureCols.map((c) => matrix.columns.indexOf(c));
  const base = { featureCols, featureIndex, columns: matrix.columns };
  const year = race?.year ?? null;
  const round = race?.round ?? null;
  const now = analysisNow(race?.payload, year, round, sessionNow);
  let cur = null;
  if (year != null && round != null && now !== Infinity && race?.payload) {
    cur = raceFeatureRows(race.payload, year, round, race.raceName, now);
  }
  if (cur == null) {
    return { ...base, rows: matrix.rows, kinds: matrix.rows.map(() => ROW_FINISHED), key: 'post-race' };
  }
  const rest = matrix.rows.filter((r) => !(r[2] === Number(year) && r[3] === Number(round)));
  const curRows = cur.map((r) => matrix.columns.map((c) => (c in r ? r[c] : null)));
  return {
    ...base,
    rows: [...rest, ...curRows],
    kinds: [...rest.map(() => ROW_FINISHED), ...curRows.map(() => ROW_LIVE)],
    key: `${year}-${round}-${now}`,
  };
}

const rowsText = (n) => `${n} row${n === 1 ? '' : 's'}`;

function compositionText(nLive, nFinished, lap, liveRowsPresent, noAlternative, restLive = 0) {
  const parts = [];
  if (nLive) parts.push(`${rowsText(nLive)} of the race on screen at lap ${lap}`);
  if (nFinished) parts.push(`${rowsText(nFinished)} of finished races`);
  let text = `selection: ${parts.join(', ')}; `;
  if (!nLive && restLive) text += `the other rows include ${rowsText(restLive)} of the race on screen at lap ${lap}; `;
  text += liveRowsPresent ? 'baseline drawn with the same mix' : 'baseline drawn from the same rows';
  if (noAlternative) {
    text += '; every random selection with this mix is the selection itself, so no feature can be above random';
  }
  return text;
}

function describeEffect(feature, effectSize, direction, selectedMean, restMean) {
  const [label, unit] = FEATURE_LABELS[feature] || [feature, '', null];
  const diff = Math.abs(selectedMean - restMean);
  const magnitude = effectSize < 0.5 ? 'slightly' : (effectSize < 0.8 ? 'notably' : 'much');
  let diffStr;
  if (unit === '%') diffStr = `${pyFixed(diff, 2)}%`;
  else if (unit === 'laps') diffStr = `${pyFixed(diff, 0)} laps`;
  else if (unit === 's/lap') diffStr = `${pyFixed(diff, 3)} s/lap`;
  else diffStr = pyFixed(diff, 1);
  if (['pace_delta_pct', 'best_lap_delta_pct', 'recent_pace_delta_pct'].includes(feature)) {
    const adj = direction === 'lower' ? 'faster' : 'slower';
    return `${magnitude} ${adj} relative to their race's field (${label.toLowerCase()}, ${diffStr})`;
  }
  if (feature === 'grid_position') {
    const adj = direction === 'lower' ? 'better' : 'worse';
    return `${magnitude} ${adj} grid positions (${pyFixed(selectedMean, 1)} vs ${pyFixed(restMean, 1)} avg)`;
  }
  if (feature === 'degradation_slope') {
    const adj = direction === 'higher' ? 'higher tyre degradation' : 'lower tyre degradation';
    return `${magnitude} ${adj} (${diffStr})`;
  }
  if (feature === 'consistency_pct') {
    const adj = direction === 'higher' ? 'less consistent' : 'more consistent';
    return `${magnitude} ${adj} lap times`;
  }
  if (feature === 'pit_count') {
    const adj = direction === 'higher' ? 'more' : 'fewer';
    return `${adj} pit stops (${pyFixed(selectedMean, 1)} vs ${pyFixed(restMean, 1)} avg)`;
  }
  if (feature === 'avg_stint_length' || feature === 'max_stint_length') {
    const adj = direction === 'higher' ? 'longer' : 'shorter';
    return `${adj} stints (${diffStr})`;
  }
  if (['sector1_delta_pct', 'sector2_delta_pct', 'sector3_delta_pct'].includes(feature)) {
    const adj = direction === 'higher' ? 'slower' : 'faster';
    return `${magnitude} ${adj} in sector ${feature[6]} relative to the field (${diffStr})`;
  }
  return `${label} ${direction} by ${diffStr}`;
}

function generateSummary(fi, nSelected, nRest, strategies, baselineMax, currentRace,
  { stratified = false, thresholdLevel = null, noAlternative = false } = {}) {
  const parts = [`Selection of ${nSelected} race entries, compared with the other ${nRest} `
    + `(${ANALYSIS_LABEL.toLowerCase()}).`];
  const mix = stratified ? ' and mix' : '';
  const seen = new Set();
  const descriptions = [];
  for (const f of fi) {
    if (!f.exceeds_random) continue;
    const cat = FEATURE_CATEGORY[f.feature] ?? f.feature;
    if (seen.has(cat)) continue;
    seen.add(cat);
    let text = describeEffect(f.feature, f.abs_g, f.direction, f.selected_mean, f.rest_mean);
    if (f.progress_dependent) text += ' (progress-dependent)';
    descriptions.push(text);
    if (descriptions.length >= 3) break;
  }
  if (descriptions.length) {
    parts.push(`Beyond what random selections of the same size${mix} show: ${descriptions[0]}.`);
    for (const d of descriptions.slice(1)) parts.push(`${d[0].toUpperCase()}${d.slice(1)}.`);
  } else if (noAlternative) {
    parts.push(`No feature can differ more than in random selections of the same size${mix}: every one `
      + 'of them is the selection itself.');
  } else if (thresholdLevel != null) {
    parts.push(`No feature differs more than in random selections of the same size${mix} `
      + `(each feature against the ${pyPercent(thresholdLevel, 1)} quantile of its own random |g|).`);
  } else if (baselineMax != null) {
    parts.push(`No feature differs more than in random selections of the same size${mix} `
      + `(95th percentile of the largest |g|: ${pyFixed(baselineMax, 2)}).`);
  }
  if (strategies.length) {
    const top = strategies[0];
    const compounds = top.stints.map((s) => s.compound).join(' -> ');
    const pct = pyRoundInt(top.frequency * 100);
    const stops = top.stints.length - 1;
    parts.push(`Most common strategy: ${compounds} (${stops}-stop, ${pct}% of the selection).`);
  }
  const cr = currentRace || {};
  if (cr.as_of === 'session_now' && cr.n_selected) {
    parts.push(`The ${cr.n_selected} selected rows of ${cr.year} R${cr.round} use only the laps `
      + `completed by lap ${cr.as_of_lap} (the replay clock): their stints and stops end `
      + 'there; the other races are whole races. The random selections of the baseline '
      + 'keep the same mix of rows.');
  }
  return parts.join(' ');
}

function clusterLabel(fi) {
  const seen = new Set();
  const labels = [];
  for (const f of fi) {
    if (!f.exceeds_random || labels.length >= 2) continue;
    const cat = FEATURE_CATEGORY[f.feature] ?? f.feature;
    if (seen.has(cat)) continue;
    seen.add(cat);
    const words = CLUSTER_WORDS[cat];
    if (!words) {
      const name = (FEATURE_LABELS[f.feature] || [f.feature])[0];
      labels.push(`${f.direction[0].toUpperCase()}${f.direction.slice(1)} ${name.toLowerCase()}`);
    } else {
      labels.push(f.direction === 'lower' ? words[0] : words[1]);
    }
  }
  return labels.length ? labels.join(', ') : 'Mixed cluster';
}

/**
 * pca_compute.analyze_selection: the descriptive analysis of a lasso
 * selection (ids 'DRV_YEAR_ROUND'), the response of POST
 * /api/pca/analyze-selection.
 *
 * @param {Object} p
 * @param {Array<string>} p.pointIds
 * @param {Object} p.matrix - the export's pca/matrix
 * @param {Object<string, Object<string, Array<Object>>>} p.strategies - the export's
 *   pca/strategies ({'YEAR_ROUND': {driver: post-race stints}})
 * @param {{year: number, round: number, payload: Object|null, raceName: string}|null} [p.race] -
 *   the race of the request's year / round (null without them)
 * @param {number|null} [p.sessionNow] - the request's session_now
 * @returns {Object} the backend's response shape
 */
export function analyzeSelection({ pointIds, matrix, strategies, race = null, sessionNow = null }) {
  const m = analysisMatrix(matrix, race, sessionNow);
  const year = race?.year ?? null;
  const round = race?.round ?? null;
  const asked = normaliseNow(sessionNow);
  const now = analysisNow(race?.payload, year, round, sessionNow);

  const selectedKeys = [];
  for (const pid of pointIds || []) {
    const s = String(pid);
    const parts = [];
    let rest = s;
    for (let k = 0; k < 2; k++) {
      const i = rest.lastIndexOf('_');
      if (i < 0) break;
      parts.unshift(rest.slice(i + 1));
      rest = rest.slice(0, i);
    }
    parts.unshift(rest);
    if (parts.length !== 3) continue;
    const y = /^\s*[+-]?\d+\s*$/.test(parts[1]) ? parseInt(parts[1], 10) : NaN;
    const r = /^\s*[+-]?\d+\s*$/.test(parts[2]) ? parseInt(parts[2], 10) : NaN;
    if (Number.isNaN(y) || Number.isNaN(r)) continue;
    selectedKeys.push(`${parts[0]}\u0000${y}\u0000${r}`);
  }
  const selSet = new Set(selectedKeys);
  const rowKeys = m.rows.map((row) => `${row[0]}\u0000${Math.trunc(row[2])}\u0000${Math.trunc(row[3])}`);
  const sel = rowKeys.map((k) => selSet.has(k));
  const nSel = sel.filter(Boolean).length;
  let currentRace = null;
  if (year != null && round != null) {
    const present = new Set(rowKeys);
    let nCur = 0;
    for (const k of present) {
      if (!selSet.has(k)) continue;
      const [, ky, kr] = k.split('\u0000');
      if (Number(ky) === Number(year) && Number(kr) === Number(round)) nCur += 1;
    }
    currentRace = {
      year: Math.trunc(year),
      round: Math.trunc(round),
      as_of: now === Infinity ? 'post-race' : 'session_now',
      session_now: asked === Infinity ? null : asked,
      as_of_lap: leaderLapsDone(race?.payload, now),
      n_selected: nCur,
    };
  }
  if (nSel === 0) {
    const out = {
      common_patterns: [], pit_windows: [], strategies: [], feature_importance: [],
      summary: 'No matching data found.', cluster_label: '', n_selected: 0,
      n_rest: m.rows.length, n_total: m.rows.length,
    };
    if (currentRace) out.current_race = currentRace;
    return out;
  }
  const present = new Set(rowKeys);
  const selKeysFound = [...new Set(selectedKeys)].filter((k) => present.has(k));

  // ── Stints and R2 pit stops of the selected rows ──
  const isCurrent = (y, r) => year != null && round != null && y === Number(year) && r === Number(round);
  const raceStints = new Map();
  const stintsOf = (y, r) => {
    const clock = isCurrent(y, r) ? now : Infinity;
    const key = `${y}_${r}_${clock}`;
    if (!raceStints.has(key)) {
      let st = {};
      if (clock === Infinity) st = (strategies || {})[`${y}_${r}`] || {};
      else if (race?.payload) {
        const rows = lapRowsOf(race.payload);
        const grouped = groupByDriver(rows);
        st = {};
        for (const [drv, sts] of fullStintsByDriver(rows)) {
          if (grouped.has(drv)) st[drv] = visibleStints(grouped.get(drv), sts, clock);
        }
      }
      raceStints.set(key, st);
    }
    return raceStints.get(key);
  };
  const allStints = [];
  const driverRaceStrategies = [];
  const pitLaps = [];
  for (const k of selKeysFound) {
    const [driver, ys, rs] = k.split('\u0000');
    const y = Number(ys);
    const r = Number(rs);
    const visible = stintsOf(y, r)[driver] || [];
    const stints = visible.filter((s) => s.TotalLaps > 0);
    if (!stints.length) continue;
    allStints.push(...stints);
    driverRaceStrategies.push(stints.map((s) => ({ compound: s.Compound, lap_start: s.StartLap, length: s.TotalLaps })));
    for (const s of visible) if (s.InLap) pitLaps.push(Math.trunc(s.InLap));
  }

  const compoundStints = new Map();
  for (const s of allStints) {
    if (!compoundStints.has(s.Compound)) compoundStints.set(s.Compound, []);
    compoundStints.get(s.Compound).push(s.TotalLaps);
  }
  const commonPatterns = [];
  for (const compound of COMPOUND_ORDER) {
    if (!compoundStints.has(compound)) continue;
    const lengths = compoundStints.get(compound);
    let total = 0;
    for (const n of lengths) total += n;
    commonPatterns.push({
      compound,
      avg_stint_length: pyRound(total / lengths.length, 1),
      count: lengths.length,
      total_laps: total,
    });
  }

  const pitWindows = [];
  if (pitLaps.length) {
    pitLaps.sort((a, b) => a - b);
    const windows = [];
    let current = [pitLaps[0]];
    for (const lap of pitLaps.slice(1)) {
      if (lap - current[current.length - 1] <= 5) current.push(lap);
      else { windows.push(current); current = [lap]; }
    }
    windows.push(current);
    for (const w of windows) {
      pitWindows.push({
        lap_start: Math.min(...w), lap_end: Math.max(...w), count: w.length, median_lap: Math.trunc(npMedian(w)),
      });
    }
  }

  const patternCount = new Map();
  const patternDetail = new Map();
  for (const seq of driverRaceStrategies) {
    const k = seq.map((s) => s.compound).join('-');
    patternCount.set(k, (patternCount.get(k) || 0) + 1);
    if (!patternDetail.has(k)) patternDetail.set(k, seq);
  }
  let totalStrat = 0;
  for (const c of patternCount.values()) totalStrat += c;
  const strategiesOut = [...patternCount.entries()]
    .map(([k, c], i) => ({ k, c, i }))
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .slice(0, 5)
    .map(({ k, c }) => ({ stints: patternDetail.get(k), frequency: totalStrat ? pyRound(c / totalStrat, 2) : 0, count: c }));

  // ── Feature differences: Hedges' g, its interval, random baseline ──
  const diff = featureDifferences(m, sel);
  const fi = diff.featureImportance;
  const base = diff.baseline;
  const live = diff.live;
  const anyLive = live.some(Boolean);
  const nRest = m.rows.length - nSel;
  const baselineMax = base.max_p95;
  const nLive = diff.nByKind[ROW_LIVE] || 0;
  const nFin = diff.nByKind[ROW_FINISHED];
  const lap = currentRace && anyLive ? currentRace.as_of_lap : null;
  const liveCount = live.filter(Boolean).length;
  const composition = {
    selected_live: nLive,
    selected_finished: nFin,
    rest_live: liveCount - nLive,
    rest_finished: (live.length - liveCount) - nFin,
    as_of_lap: lap,
    mixed: anyLive && live.some((l) => !l),
    no_random_alternative: diff.noRandomAlternative,
  };
  const progress = fi.filter((f) => f.progress_dependent).map((f) => f.feature);
  const q = pyPercent(BASELINE_QUANTILE, 0);
  const baselineText = anyLive
    ? `|g| of ${BASELINE_DRAWS} random selections of ${nSel} rows with the selection's mix `
      + `(${nLive} of the race on screen at lap ${lap}, ${nFin} of finished races, each drawn `
      + `from the rows of its kind; seed ${SELECTION_SEED}): mean per feature (baseline_abs_g) `
      + `and ${q} quantile (baseline_abs_g_p95)`
    : `|g| of ${BASELINE_DRAWS} random selections of ${nSel} rows (seed ${SELECTION_SEED}): `
      + `mean per feature (baseline_abs_g) and ${q} quantile (baseline_abs_g_p95)`;
  const level = diff.thresholdLevel;
  let thresholdText;
  if (diff.noRandomAlternative) {
    thresholdText = 'above random: not possible, every random selection with this mix is the selection itself';
  } else if (diff.thresholdRule === THRESHOLD_PER_FEATURE) {
    thresholdText = 'above random: |g| above the feature\'s own threshold (threshold_abs_g), the '
      + `${pyPercent(level, 1)} quantile of its random |g|, the same level for every feature, chosen so `
      + `that ${pyPercent(1 - BASELINE_QUANTILE, 0)} of the random selections pass the threshold of some `
      + 'feature (rows of two kinds: the progress-dependent features reach far larger random '
      + '|g| and would otherwise set the threshold of all)';
  } else {
    thresholdText = baselineMax != null
      ? `above random: |g| above ${pyFixed(baselineMax, 3)} for every feature, the `
        + `${q} quantile of the largest |g| over all features in the random selections`
      : null;
  }
  const z = normalInvCdf(1 - (1 - CI_LEVEL) / 2);
  const statistics = {
    label: ANALYSIS_LABEL,
    effect_size: "Hedges' g: (selection mean - rest mean) / pooled SD x (1 - 3 / (4 df - 1)), df = N - 2",
    interval: `${pyPercent(CI_LEVEL, 0)} normal-approximation interval of g, g +/- ${pyFixed(z, 2)} SE, `
      + 'SE^2 = (n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)) (Hedges and Olkin 1985); '
      + `none when a group has fewer than ${MIN_GROUP_FOR_INTERVAL} rows (one row has no `
      + 'spread of its own)',
    min_group_for_interval: MIN_GROUP_FOR_INTERVAL,
    baseline: baselineText,
    baseline_max_abs_g_p95: baselineMax != null ? pyRound(baselineMax, 3) : null,
    threshold_rule: diff.thresholdRule,
    threshold_level: level != null ? pyRound(level, 4) : null,
    threshold: thresholdText,
    composition,
    composition_text: compositionText(nLive, nFin, lap, anyLive, diff.noRandomAlternative, composition.rest_live),
    progress_dependent_features: progress,
    progress_note: progress.length
      ? `progress-dependent (${progress.map((f) => FEATURE_LABELS[f][0].toLowerCase()).join(', ')}): the rows of the `
        + `race on screen use only the laps completed by lap ${lap}, those of finished races the whole race, `
        + 'so the two kinds differ in these features whatever the drivers did; the random baseline draws '
        + 'the same mix, so read these rows against it'
      : null,
    note: ANALYSIS_NOTE,
  };
  const out = {
    common_patterns: commonPatterns,
    pit_windows: pitWindows,
    strategies: strategiesOut,
    feature_importance: fi,
    statistics,
    summary: generateSummary(fi, nSel, nRest, strategiesOut, baselineMax, currentRace, {
      stratified: anyLive, thresholdLevel: level, noAlternative: diff.noRandomAlternative,
    }),
    cluster_label: clusterLabel(fi),
    n_selected: nSel,
    n_rest: nRest,
    n_total: m.rows.length,
  };
  if (currentRace) out.current_race = currentRace;
  return out;
}
