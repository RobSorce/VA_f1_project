/**
 * Client of the Monte Carlo race simulation (utils/raceSimulation.js).
 *
 * Jobs run in a module Web Worker (workers/raceSimulation.worker.js) so the
 * thousand-run projections never block the main thread. Where Worker does not
 * exist (vitest in Node, server rendering, a browser without module workers)
 * or the worker fails to load, the same job runs synchronously on the calling
 * thread and its callback is called before request() returns.
 *
 * Every request belongs to a channel ('projection', 'whatif'): only the latest
 * request of a channel ever reaches its callback. A newer request supersedes
 * the older one (its result is dropped when it arrives), and while a job of a
 * channel is in the worker only the newest waiting request of that channel is
 * kept (the ones in between are never run), so the worker never queues stale
 * work behind a fast replay.
 *
 * Also here, as the plain-data post-processing of a simulation result:
 *  - planFromStints: a Strategy Simulator plan as the engine's planned stops;
 *  - runSimulationJob: the job dispatcher shared by the worker and the
 *    synchronous fallback (a what-if is two runs from the same seed);
 *  - the badge rule of the projection views (projectionBadges, withBadges,
 *    battleLevel, listedBattles, modePosition, positionChange,
 *    orderedProjections, projectionRisks): Wilson interval plus hysteresis,
 *    so a badge, the finishing position shown (the median) with its gold and
 *    its gain / loss arrow, the row order, the list of battles shown and its
 *    order, and the risk rows never change on Monte Carlo noise alone: only on
 *    evidence beyond the sampling error, or on new data. Marks drawn once per
 *    driver or per pair use intervals simultaneous over the table (familyZ).
 *    Measured by scripts/mc_stability.mjs (lead decision D5:
 *    docs/evidence/mc_stability.txt);
 *  - the same rule for the Strategy Simulator's what-if (pairedDifferences,
 *    pairedSign, whatIfVerdict, whatIfMarks): the verdict and the colours of
 *    the differences from the run-by-run differences of the two runs beyond
 *    their error, the cards' P labels as the projection's, chained over the
 *    recomputes of the same what-if. Measured by scripts/whatif_stability.mjs
 *    (docs/evidence/whatif_stability.txt).
 *
 * The worker is created by the caller (createWorker option): this module never
 * names the worker file, so the worker bundle, which imports this module, does
 * not contain itself.
 */
import { simulateRaceFinish, evaluateRisks, MC_INTERVAL_Z, RISK_LIST_SIZE } from './raceSimulation';

// ─── Strategy Simulator plans ───

/**
 * Planned stops of a Strategy Simulator plan: stint i + 1 starts on its
 * lapStart, so its stop is made at the end of lap lapStart - 1 (the in-lap,
 * as the engine's plans: { lap, compound fitted }). Stops on laps already run
 * or on the last lap are dropped by the engine (normalisePlans).
 *
 * @param {Array<{compound: string, lapStart: number, length: number}>} stints
 * @returns {Array<{lap: number, compound: string}>} by lap
 */
export function planFromStints(stints) {
  const list = (Array.isArray(stints) ? stints : [])
    .filter((s) => s && Number.isFinite(Number(s.lapStart)))
    .slice()
    .sort((a, b) => Number(a.lapStart) - Number(b.lapStart));
  const out = [];
  for (let i = 1; i < list.length; i++) {
    out.push({
      lap: Number(list[i].lapStart) - 1,
      compound: String(list[i].compound || 'UNKNOWN').trim().toUpperCase(),
    });
  }
  return out;
}

// ─── Jobs ───

/** Round to 0.1 with -0 as 0 (a position difference of identical runs is exactly 0). */
function round1(v) {
  return Math.round(v * 10) / 10 || 0;
}

/**
 * What-if job (S6): the baseline (basePlan, or the engine's stop model when
 * there is none) and the plan, both from the SAME seed and race parameters, so
 * the two runs share every random draw (common random numbers, utils/prng.js
 * draws are indexed by sim, driver, lap and stream). An identical plan gives
 * identical runs and every difference exactly 0. The plan run reuses the
 * baseline's race parameters (same clock, same values).
 *
 * @param {Object} params - simulateRaceFinish params (seed included) plus
 *   focusDriver, plan ([{ lap, compound }]) and basePlan ([{ lap, compound }] or null)
 * @returns {Object|null} { focusDriver, seed, numSimulations, baselineProjection,
 *   simProjection, delta: { position, podium, points }, paired, baseline, custom }
 *   delta.position = baseline expected position - plan expected position
 *   (positive = the plan gains places); podium / points in percentage points;
 *   paired = pairedDifferences of the two runs (whatIfMarks)
 */
function compareJob(params) {
  const { focusDriver, plan, basePlan, ...common } = params || {};
  const baseRun = simulateRaceFinish({
    ...common, plans: basePlan ? { [focusDriver]: basePlan } : undefined, tracePositionsOf: focusDriver,
  });
  const customRun = simulateRaceFinish({
    ...common, raceParams: baseRun?.raceParams, plans: { [focusDriver]: plan || [] }, tracePositionsOf: focusDriver,
  });
  if (!baseRun || !customRun) return null;
  const { positionsOf: basePositions, ...baseline } = baseRun;
  const { positionsOf: planPositions, ...custom } = customRun;
  const baselineProjection = baseline.projections.find((p) => p.driver === focusDriver);
  const simProjection = custom.projections.find((p) => p.driver === focusDriver);
  if (!baselineProjection || !simProjection) return null;
  return {
    focusDriver,
    seed: custom.seed,
    numSimulations: custom.numSimulations,
    baselineProjection,
    simProjection,
    delta: {
      position: round1(baselineProjection.expectedPos - simProjection.expectedPos),
      podium: simProjection.podiumProb - baselineProjection.podiumProb,
      points: simProjection.pointsProb - baselineProjection.pointsProb,
    },
    paired: pairedDifferences(basePositions, planPositions),
    baseline,
    custom,
  };
}

/**
 * The last place of a podium and of the points (the sporting regulations, not
 * a model value: P1-P3, P1-P10), as raceSimulation.js aggregateResults counts
 * podiumProb and pointsProb.
 */
const PODIUM_LAST = 3;
const POINTS_LAST = 10;

/**
 * The what-if's differences run by run: run i of the baseline and run i of
 * the plan share every random draw (common random numbers), so each
 * difference is taken per run and its mean is known better than the
 * difference of two independent estimates (the shared noise cancels). Each
 * is signed so that positive = the plan does better:
 *  - position: baseline position_i - plan position_i (places);
 *  - podium / points: [plan_i in the podium / points] - [baseline_i in them]
 *    (a share of the runs; x 100 = delta.podium / delta.points before rounding).
 *
 * @param {Array<number|null>} basePositions - the focus driver's position in each baseline run
 * @param {Array<number|null>} planPositions - the same runs under the plan
 * @returns {{position: {mean: number, sd: number, n: number}, podium: Object, points: Object}|null}
 *   mean of the differences, their sample standard deviation, the runs paired; null without a pair
 */
export function pairedDifferences(basePositions, planPositions) {
  const a = Array.isArray(basePositions) ? basePositions : [];
  const b = Array.isArray(planPositions) ? planPositions : [];
  const acc = { position: [0, 0], podium: [0, 0], points: [0, 0] }; // [sum, sum of squares]
  const add = (k, d) => { acc[k][0] += d; acc[k][1] += d * d; };
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    n += 1;
    add('position', a[i] - b[i]);
    add('podium', (b[i] <= PODIUM_LAST) - (a[i] <= PODIUM_LAST));
    add('points', (b[i] <= POINTS_LAST) - (a[i] <= POINTS_LAST));
  }
  if (!n) return null;
  const stats = ([sum, sumSq]) => {
    const mean = sum / n;
    const sd = n > 1 ? Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / (n - 1))) : 0;
    return { mean, sd, n };
  };
  return { position: stats(acc.position), podium: stats(acc.podium), points: stats(acc.points) };
}

/**
 * Run one job (worker and synchronous fallback alike).
 *
 * @param {'project'|'compare'} kind - 'project': simulateRaceFinish(params);
 *   'compare': the what-if (compareJob)
 * @param {Object} params - plain data (no functions: `running` as a list or boolean)
 * @returns {Object|null}
 */
export function runSimulationJob(kind, params) {
  if (kind === 'project') return simulateRaceFinish(params);
  if (kind === 'compare') return compareJob(params);
  throw new Error(`Unknown simulation job: ${kind}`);
}

// ─── Large inputs sent once to the worker ───

// Fields sent by reference once the worker holds them: the lap table is the
// largest input and is the same array for a whole replay, so it is cloned to
// the worker once, not on every recomputation.
const DATASET_FIELDS = ['lapTimes', 'trackStatus'];

/**
 * Worker side of the dataset references: the params with every
 * { $dataset: id, data? } field replaced by its array (data, when present, is
 * stored as the field's current array).
 *
 * @param {Object} params - message params
 * @param {Object} store - the worker's { field: { id, data } }
 * @returns {Object}
 */
export function unpackParams(params, store) {
  const out = { ...params };
  for (const f of DATASET_FIELDS) {
    const ref = params?.[f];
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || ref.$dataset == null) continue;
    if (ref.data) store[f] = { id: ref.$dataset, data: ref.data };
    if (store[f]?.id !== ref.$dataset) throw new Error(`Simulation worker: dataset ${f} ${ref.$dataset} missing`);
    out[f] = store[f].data;
  }
  return out;
}

// ─── Client ───

/**
 * @param {Object} [opts]
 * @param {function(): Worker} [opts.createWorker] - worker factory (null: synchronous only)
 * @returns {{request: function, cancel: function, mode: function, dispose: function}}
 */
export function createSimulationClient({ createWorker = null } = {}) {
  let worker = null;
  let broken = typeof createWorker !== 'function';
  let nextId = 1;
  const latest = new Map();   // channel -> id of its latest request (0 = cancelled)
  const inFlight = new Map(); // channel -> job in the worker
  const waiting = new Map();  // channel -> newest job waiting for the channel
  const byId = new Map();     // id -> job in the worker
  const datasetIds = new WeakMap();
  let nextDatasetId = 1;
  const workerHas = {};       // field -> dataset id the worker holds

  function deliver(job, result, error) {
    if (latest.get(job.channel) !== job.id) return; // superseded or cancelled
    if (typeof job.onResult === 'function') job.onResult(result, error || null);
  }

  function runSync(job) {
    let result = null;
    let error = null;
    try {
      result = runSimulationJob(job.kind, job.params);
    } catch (e) {
      error = e;
    }
    deliver(job, result, error);
  }

  /** Params with the large inputs as dataset references, and what the worker holds once sent. */
  function pack(params) {
    const out = { ...params };
    const held = {};
    for (const f of DATASET_FIELDS) {
      const arr = params?.[f];
      if (!Array.isArray(arr)) continue;
      let id = datasetIds.get(arr);
      if (id == null) { id = nextDatasetId++; datasetIds.set(arr, id); }
      out[f] = workerHas[f] === id ? { $dataset: id } : { $dataset: id, data: arr };
      held[f] = id;
    }
    return { out, held };
  }

  function fallBackToSync() {
    broken = true;
    if (worker) {
      try { worker.terminate(); } catch (_) { /* ignore */ }
    }
    worker = null;
    const jobs = [...byId.values(), ...waiting.values()];
    byId.clear();
    inFlight.clear();
    waiting.clear();
    for (const job of jobs) if (latest.get(job.channel) === job.id) runSync(job);
  }

  function send(job) {
    inFlight.set(job.channel, job);
    byId.set(job.id, job);
    try {
      const { out, held } = pack(job.params);
      worker.postMessage({ id: job.id, kind: job.kind, params: out });
      Object.assign(workerHas, held); // only once the message (and its data) is on its way
    } catch (e) {
      // e.g. a param that cannot be cloned: run this one here
      byId.delete(job.id);
      inFlight.delete(job.channel);
      runSync(job);
    }
  }

  function onMessage(event) {
    const { id, result, error } = event?.data || {};
    const job = byId.get(id);
    if (!job) return;
    byId.delete(id);
    if (inFlight.get(job.channel) === job) inFlight.delete(job.channel);
    deliver(job, result ?? null, error ? new Error(error) : null);
    const next = waiting.get(job.channel);
    if (next && worker) {
      waiting.delete(job.channel);
      send(next);
    }
  }

  function ensureWorker() {
    if (broken) return false;
    if (worker) return true;
    try {
      worker = createWorker();
      worker.onmessage = onMessage;
      worker.onerror = (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        console.warn('Simulation worker failed; running simulations on the main thread', e?.message || e);
        fallBackToSync();
      };
      worker.onmessageerror = () => fallBackToSync();
      return true;
    } catch (e) {
      console.warn('Simulation worker unavailable; running simulations on the main thread', e?.message || e);
      broken = true;
      worker = null;
      return false;
    }
  }

  return {
    /**
     * Queue a job on a channel; onResult(result, error) is called only if this
     * is still the channel's latest request when the result arrives
     * (synchronously, before request returns, without a worker).
     *
     * @param {string} channel
     * @param {'project'|'compare'} kind
     * @param {Object} params - plain data
     * @param {function(Object|null, Error|null)} onResult
     * @returns {number} request id
     */
    request(channel, kind, params, onResult) {
      const job = { id: nextId++, channel, kind, params, onResult };
      latest.set(channel, job.id);
      if (!ensureWorker()) {
        runSync(job);
        return job.id;
      }
      if (inFlight.has(channel)) {
        waiting.set(channel, job); // replaces an older waiting job, never run
        return job.id;
      }
      send(job);
      return job.id;
    },
    /** Drop the channel's pending results: nothing requested so far reaches a callback. */
    cancel(channel) {
      latest.set(channel, 0);
      waiting.delete(channel);
    },
    /** 'worker' once a worker is running, 'sync' without one. */
    mode() {
      return worker && !broken ? 'worker' : 'sync';
    },
    dispose() {
      if (worker) {
        try { worker.terminate(); } catch (_) { /* ignore */ }
      }
      worker = null;
      broken = true;
      byId.clear();
      inFlight.clear();
      waiting.clear();
    },
  };
}

// ─── Badges (RacePredictionPanel, Leaderboard, StrategyAnalysis, insights) ───

/**
 * Coverage of the badge interval, in percent, and its normal quantile (1.96 =
 * two-sided 95 %). A convention for "beyond the sampling error", not a value
 * read off data.
 */
export const BADGE_INTERVAL_PCT = 95;
export const BADGE_Z = MC_INTERVAL_Z;

/** Podium badge (gold): podium probability at least this many percent (the panel's threshold). */
export const PODIUM_BADGE_PCT = 50;

/** Battle colours: overtake probability at least 30 % (gold) / 60 % (green) (the panel's thresholds). */
export const BATTLE_BADGE_PCT = Object.freeze([30, 60]);

/**
 * Wilson score interval of a proportion p observed in n independent trials
 * (the n simulations of one projection).
 *
 * @param {number} p - observed share in [0, 1]
 * @param {number} n - trials
 * @param {number} [z=BADGE_Z]
 * @returns {[number, number]} [low, high] in [0, 1]; [0, 1] when n is not positive
 */
export function wilsonInterval(p, n, z = BADGE_Z) {
  if (!(n > 0) || !Number.isFinite(p)) return [0, 1];
  const q = Math.min(1, Math.max(0, p));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (q + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((q * (1 - q)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Badge state with hysteresis: on when the whole Wilson interval of the share
 * is at or above the threshold, off when it is entirely below; when the
 * threshold is inside the interval (the difference is within the Monte Carlo
 * error) the previous state is kept, and with no previous state the point
 * estimate decides. So a badge changes only when the evidence crosses the
 * threshold by more than the sampling error.
 *
 * @param {number} pct - probability in percent (a projection's rounded value)
 * @param {number} n - simulations behind it
 * @param {number} thresholdPct
 * @param {boolean} [prevOn] - the state in the previous projection
 * @param {number} [z=BADGE_Z] - normal quantile of the interval (familyZ for a mark drawn
 *   once per pair or per row, read together)
 * @returns {boolean}
 */
export function badgeOn(pct, n, thresholdPct, prevOn, z = BADGE_Z) {
  const [lo, hi] = wilsonInterval(pct / 100, n, z);
  const t = thresholdPct / 100;
  if (lo >= t) return true;
  if (hi < t) return false;
  return typeof prevOn === 'boolean' ? prevOn : pct >= thresholdPct;
}

/** Key of a battle: the chasing driver, then the one ahead. */
export function battleKey(b) {
  return `${b.behind}>${b.ahead}`;
}

/**
 * Rows of the battle list at most (RacePredictionPanel "Overtake
 * Probabilities"; the other views take theirs from it). A display choice: the
 * length of the list the panel has always shown.
 */
export const BATTLE_LIST_SIZE = 6;

/**
 * Race order of a battle (data, never a Monte Carlo statistic): the place of
 * the car ahead, then of the chasing car, then the key. The order a choice
 * among battles within the Monte Carlo error of each other falls back on.
 */
function raceOrder(a, b) {
  return ((a.aheadCurrentPos ?? Infinity) - (b.aheadCurrentPos ?? Infinity))
    || ((a.behindCurrentPos ?? Infinity) - (b.behindCurrentPos ?? Infinity))
    || (battleKey(a) < battleKey(b) ? -1 : battleKey(a) > battleKey(b) ? 1 : 0);
}

/**
 * Which battles are listed, as keys: the battles that are, beyond the Monte
 * Carlo error, among the BATTLE_LIST_SIZE most likely. With no previous list
 * (the first projection of a session): the BATTLE_LIST_SIZE most likely.
 * After that, with the Wilson intervals of every battle's probability:
 *  - a listed battle stays while fewer than BATTLE_LIST_SIZE other battles
 *    are surely more likely (their whole interval above its interval);
 *  - a battle not listed enters when fewer than BATTLE_LIST_SIZE other
 *    battles could be as likely (their interval reaches its interval): it is
 *    surely among the BATTLE_LIST_SIZE most likely;
 *  - a battle the engine no longer returns (no longer within 4 positions)
 *    leaves the list.
 * No slot is filled by a point estimate: while the battles are too close to
 * call, the list holds fewer than BATTLE_LIST_SIZE rows. In the rare case of
 * more than BATTLE_LIST_SIZE (a battle surely in, the listed ones still
 * possibly in) the listed ones not surely in leave from the back of the race
 * order (raceOrder). scripts/battle_list_rules.mjs compares this rule with a
 * cut at the BATTLE_LIST_SIZE-th battle plus a fill
 * (docs/evidence/battle_list_rules.txt).
 *
 * @param {Array<Object>} battles - simulateRaceFinish battles (every pair within 4 positions)
 * @param {number} n - simulations behind the probabilities
 * @param {string[]} [prevListed] - the previous projection's list (keys)
 * @returns {string[]} battle keys
 */
function battleList(battles, n, prevListed) {
  const sorted = [...(battles || [])].sort((a, b) => b.prob - a.prob
    || (battleKey(a) < battleKey(b) ? -1 : battleKey(a) > battleKey(b) ? 1 : 0));
  if (!Array.isArray(prevListed)) return sorted.slice(0, BATTLE_LIST_SIZE).map(battleKey);
  const iv = sorted.map((b) => wilsonInterval(b.prob / 100, n));
  const above = sorted.map(() => 0); // others surely more likely
  const reach = sorted.map(() => 0); // others that could be as likely
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < sorted.length; j++) {
      if (i === j) continue;
      if (iv[j][0] > iv[i][1]) above[i] += 1;
      if (iv[j][1] >= iv[i][0]) reach[i] += 1;
    }
  }
  const was = new Set(prevListed);
  const surely = (i) => reach[i] < BATTLE_LIST_SIZE;
  let listed = [];
  sorted.forEach((b, i) => {
    if (was.has(battleKey(b)) ? above[i] < BATTLE_LIST_SIZE : surely(i)) listed.push(i);
  });
  if (listed.length > BATTLE_LIST_SIZE) {
    const sure = listed.filter(surely);
    const rest = listed.filter((i) => !surely(i)).sort((x, y) => raceOrder(sorted[x], sorted[y]));
    listed = [...sure, ...rest].slice(0, BATTLE_LIST_SIZE);
  }
  return listed.map((i) => battleKey(sorted[i]));
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
function normalQuantile(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269,
    -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowTail = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lowTail) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Normal quantile of BADGE_INTERVAL_PCT intervals taken SIMULTANEOUSLY over
 * the m rows of the projection table (Bonferroni): z = Phi^-1(1 - alpha / (2 m)),
 * alpha = 1 - BADGE_INTERVAL_PCT / 100 (m = 20 drivers: z = 3.02). A
 * convention, like BADGE_Z: the projection table draws one mark per driver
 * (the finishing position shown, its gold, the gain / loss arrow), read
 * together, so the whole column, not each row alone, must change only beyond
 * the Monte Carlo error (a 95 % interval per row lets one of 20 rows move on
 * noise in about one recompute in five: scripts/mc_stability.mjs).
 *
 * @param {number} m - rows (drivers) of the table
 * @returns {number}
 */
export function familyZ(m) {
  const k = Math.max(1, Math.round(Number(m)) || 1);
  const alpha = 1 - BADGE_INTERVAL_PCT / 100;
  return normalQuantile(1 - alpha / (2 * k));
}

/** [position, simulations] of a projection row, ascending: posCount, else posDistribution (percent). */
function positionCounts(p) {
  const src = p?.posCount && Object.keys(p.posCount).length ? p.posCount : (p?.posDistribution || {});
  return Object.entries(src)
    .map(([pos, c]) => [Number(pos), Number(c)])
    .filter(([pos, c]) => Number.isFinite(pos) && c > 0)
    .sort((x, y) => x[0] - y[0]);
}

/**
 * The finishing position each projection row shows: the median simulated
 * position (the smallest k with at least half of the runs finishing P1..Pk),
 * judged beyond the Monte Carlo error of the whole column. For each k the
 * cumulative share F(k) gets its Wilson interval at familyZ(rows): "F(k) >=
 * 50 %" is true when the whole interval is at or above 50 %, false when it is
 * entirely below, and inside it the previous projection's statement is kept
 * (previous position <= k); with no previous position the point decides. The
 * position shown is the smallest k for which it holds (F is monotone, so the
 * statements are). So the label moves only when the median has moved beyond
 * the simultaneous error, and P1-P3 (gold) is exactly "a podium in at least
 * half of the runs", the podium badge (PODIUM_BADGE_PCT = 50). The median, not
 * the most frequent position: a flat distribution (a car that could finish
 * anywhere) has a most frequent position decided by noise, e.g. a gold P2 for
 * a car with an 18 % podium chance.
 *
 * @param {Object} result - simulateRaceFinish result (projections with posCount or posDistribution)
 * @param {Object} [prevShown] - { driver: position } of the previous projection
 * @param {number} [z=familyZ(rows)] - normal quantile of the intervals (a view that draws other
 *   marks with these rows passes the familyZ of all of them: whatIfMarks)
 * @returns {Object<string, number>}
 */
export function shownPositions(result, prevShown, z = familyZ((result?.projections || []).length)) {
  const n = result?.numSimulations;
  const rows = result?.projections || [];
  const out = {};
  for (const p of rows) {
    const counts = positionCounts(p);
    const total = counts.reduce((s, [, c]) => s + c, 0);
    if (!total) { out[p.driver] = p.modePos ?? p.currentPos; continue; }
    const was = prevShown?.[p.driver];
    let cum = 0;
    let shown = counts[counts.length - 1][0];
    for (const [pos, c] of counts) {
      cum += c;
      const share = cum / total;
      let atLeastHalf;
      if (n > 0) {
        const [lo, hi] = wilsonInterval(share, n, z);
        if (lo >= 0.5) atLeastHalf = true;
        else if (hi < 0.5) atLeastHalf = false;
        else atLeastHalf = Number.isFinite(was) ? pos >= was : share >= 0.5;
      } else {
        atLeastHalf = share >= 0.5;
      }
      if (atLeastHalf) { shown = pos; break; }
    }
    out[p.driver] = shown;
  }
  return out;
}

/**
 * The finishing positions one row's label may take within the Monte Carlo
 * error (the rule of shownPositions): [low, high], low = the smallest
 * position whose cumulative share F(k) could be at least half (its Wilson
 * interval at z reaches 50 %), high = the smallest one whose share surely is
 * (the whole interval at or above 50 %). shownPositions shows `high`, or the
 * previous label when it lies in between; any position in [low, high] states
 * nothing the runs contradict beyond the error.
 *
 * @param {Object} row - a projection row (posCount or posDistribution)
 * @param {number} n - simulations behind it
 * @param {number} z - normal quantile of the intervals
 * @returns {[number, number]|null} null without counts
 */
export function shownPositionRange(row, n, z) {
  const counts = positionCounts(row);
  const total = counts.reduce((s, [, c]) => s + c, 0);
  if (!total) return null;
  let low = null;
  let cum = 0;
  for (const [pos, c] of counts) {
    cum += c;
    const share = cum / total;
    const [lo, hi] = n > 0 ? wilsonInterval(share, n, z) : [share, share];
    if (low == null && hi >= 0.5) low = pos;
    if (lo >= 0.5) return [low ?? pos, pos];
  }
  const last = counts[counts.length - 1][0];
  return [low ?? last, last];
}

/**
 * Rows of a projection in the order the views list them: by the finishing
 * position shown (shownPositions), then by the current race position (data),
 * then by driver code. Never by a raw Monte Carlo statistic (the expected
 * position of two cars within the error of each other would swap rows on
 * noise alone).
 */
function stableOrder(projections, shown) {
  return [...(projections || [])].sort((a, b) => ((shown[a.driver] ?? Infinity) - (shown[b.driver] ?? Infinity))
    || ((a.currentPos ?? Infinity) - (b.currentPos ?? Infinity))
    || (a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0));
}

/**
 * Badge states of a projection: the finishing position shown per driver
 * (shownPositions, against the previous projection's) and the podium badge it
 * implies (shown position P1-P3 = a podium in at least PODIUM_BADGE_PCT of the
 * runs, beyond the simultaneous error), badgeOn on every battle against the
 * previous states, the battle list (battleList, against the previous list),
 * the row order (stableOrder) and, given the projection's inputs (ctx), the
 * risk rows (raceSimulation.js evaluateRisks against the previous levels).
 *
 * @param {Object} result - simulateRaceFinish result ({ projections, battles, numSimulations })
 * @param {Object} [prev] - the previous projection's badges (same session, earlier clock)
 * @param {Object} [ctx] - { driverFeatures, currentLap, maxLap } of the projection; without it
 *   no risk rows are judged (risks / riskLevels null)
 * @returns {{podium: Object<string, boolean>, battles: Object<string, {level: number}>,
 *   listed: string[], mode: Object<string, number>, order: string[], risks: Array<Object>|null,
 *   riskLevels: Object<string, number>|null, n: number, z: number, familyZ: number}}
 *   battle level 0 / 1 / 2 = below 30 % / 30 % / 60 %; mode = the finishing position shown
 */
export function projectionBadges(result, prev = null, ctx = null) {
  const n = result?.numSimulations;
  const mode = shownPositions(result, prev?.mode);
  const podium = {};
  for (const p of result?.projections || []) podium[p.driver] = mode[p.driver] <= 3;
  // Battle colours: one per pair, read together (the Leaderboard draws every
  // adjacent pair, the panel the listed ones): intervals simultaneous over the
  // pairs of the projection (familyZ)
  const battles = {};
  const zBattles = familyZ((result?.battles || []).length);
  for (const b of result?.battles || []) {
    const key = battleKey(b);
    const was = prev?.battles?.[key];
    const on = BATTLE_BADGE_PCT.map((t, i) => badgeOn(b.prob, n, t, was ? was.level > i : undefined, zBattles));
    battles[key] = { level: on[1] ? 2 : on[0] ? 1 : 0 };
  }
  const listed = battleList(result?.battles, n, prev?.listed);
  const order = stableOrder(result?.projections, mode).map((p) => p.driver);
  let risks = null;
  let riskLevels = null;
  if (ctx?.driverFeatures && result?.raceParams && Array.isArray(result?.projections)) {
    const judged = evaluateRisks(result.projections, ctx.driverFeatures, result.raceParams,
      ctx.currentLap, ctx.maxLap, { n, prev: prev?.riskLevels });
    risks = judged.rows.slice(0, RISK_LIST_SIZE);
    riskLevels = judged.levels;
  }
  return {
    podium, battles, listed, mode, order, risks, riskLevels, n, z: BADGE_Z,
    familyZ: familyZ((result?.projections || []).length),
  };
}

/**
 * A simulation result as the store holds it (store.raceProjection, without
 * the clock stamps): its badges (projectionBadges against the previous
 * projection's), the risk rows judged with them, and the rows in the order
 * the views list them (badges.order). Shared by the store and the stability
 * script (scripts/mc_stability.mjs), so both measure the same thing.
 *
 * @param {Object} result - simulateRaceFinish result
 * @param {Object} [prevBadges] - the badges of the projection held (earlier clock)
 * @param {Object} [ctx] - { driverFeatures, currentLap, maxLap } (projectionBadges)
 * @returns {Object}
 */
export function withBadges(result, prevBadges = null, ctx = null) {
  const badges = projectionBadges(result, prevBadges, ctx);
  const rank = new Map(badges.order.map((d, i) => [d, i]));
  return {
    ...result,
    projections: [...(result?.projections || [])].sort((a, b) => rank.get(a.driver) - rank.get(b.driver)),
    badges,
    // the risk rows every view reads (Risks tab, Strategy Analysis, assistant)
    risks: badges.risks ?? result?.risks,
  };
}

/**
 * The finishing position a view shows for a projection row (the P label of
 * the Race Prediction panel, Strategy Analysis, the assistant's context): the
 * store's (projection.badges.mode, chained over recomputes by shownPositions:
 * it changes only on evidence beyond the Monte Carlo error of the whole
 * column); for a projection without badges, the rule with no previous state
 * (the median simulated position).
 *
 * @param {Object} projection - store.raceProjection
 * @param {Object} row - one of projection.projections
 * @returns {number}
 */
export function modePosition(projection, row) {
  const shown = projection?.badges?.mode?.[row?.driver];
  if (Number.isFinite(shown)) return shown;
  const own = shownPositions({ numSimulations: projection?.numSimulations, projections: [row] })[row?.driver];
  return Number.isFinite(own) ? own : row?.modePos;
}

/** The finishing position shown (modePosition under the name the views read). */
export const shownPosition = modePosition;

/**
 * Places a driver is projected to gain (positive) or lose (negative): the
 * current position minus the finishing position shown (modePosition), so the
 * gain / loss arrow of a row changes only when its P label does.
 *
 * @param {Object} projection - store.raceProjection
 * @param {Object} row - one of projection.projections
 * @returns {number|null} null without a current position
 */
export function positionChange(projection, row) {
  const cur = row?.currentPos;
  const shown = modePosition(projection, row);
  return Number.isFinite(cur) && Number.isFinite(shown) ? cur - shown : null;
}

/**
 * Rows of a projection in the order the views list them: the store's
 * (withBadges: by the position shown, then the current race position); for a
 * projection without badges, the same rule with no previous state.
 *
 * @param {Object} projection - store.raceProjection
 * @returns {Array<Object>}
 */
export function orderedProjections(projection) {
  const rows = projection?.projections || [];
  const order = projection?.badges?.order;
  if (Array.isArray(order)) {
    const rank = new Map(order.map((d, i) => [d, i]));
    return [...rows].sort((a, b) => (rank.get(a.driver) ?? Infinity) - (rank.get(b.driver) ?? Infinity));
  }
  return stableOrder(rows, shownPositions(projection));
}

/**
 * The risk rows a view shows: the store's (projection.badges.risks, judged
 * against the previous projection's levels: a row changes only on evidence
 * beyond the Monte Carlo error); the engine's own rows (no previous state)
 * for a projection without them.
 *
 * @param {Object} projection - store.raceProjection
 * @returns {Array<Object>}
 */
export function projectionRisks(projection) {
  const shown = projection?.badges?.risks;
  return Array.isArray(shown) ? shown : (projection?.risks || []);
}

/**
 * Badge level of one battle of a projection: the store's state
 * (projection.badges, chained over recomputes); for a projection without
 * badges (built outside the store), the rule with no previous state.
 *
 * @param {Object} projection - store.raceProjection (or a simulateRaceFinish result)
 * @param {Object} battle - one of projection.battles
 * @returns {number} 0 / 1 / 2 = below 30 % / at least 30 % (gold) / at least 60 % (green)
 */
export function battleLevel(projection, battle) {
  const key = battleKey(battle);
  const stored = projection?.badges?.battles?.[key]?.level;
  if (typeof stored === 'number') return stored;
  const zBattles = familyZ((projection?.battles || []).length);
  const on = BATTLE_BADGE_PCT.map((t) => badgeOn(battle.prob, projection?.numSimulations, t, undefined, zBattles));
  return on[1] ? 2 : on[0] ? 1 : 0;
}

/**
 * The battles a view lists, each with its badge `level`: the store's list
 * (projection.badges.listed, chained over recomputes by battleList: it
 * changes only on evidence beyond the Monte Carlo error); for a projection
 * without badges, the BATTLE_LIST_SIZE most likely. Ordered by badge level
 * (green, gold, then the others), then in race order (raceOrder): never by
 * the point estimate, so a view that takes the first rows of the list (the
 * insight cards, the assistant's quick query) changes only when a level or
 * the list does.
 *
 * @param {Object} projection - store.raceProjection
 * @returns {Array<Object>} battles with `level` (0 / 1 / 2)
 */
export function listedBattles(projection) {
  const all = projection?.battles || [];
  const keys = Array.isArray(projection?.badges?.listed)
    ? projection.badges.listed
    : battleList(all, projection?.numSimulations, undefined);
  const byKey = new Map(all.map((b) => [battleKey(b), b]));
  const out = [];
  for (const key of keys) {
    const b = byKey.get(key);
    if (b) out.push({ ...b, level: battleLevel(projection, b) });
  }
  return out.sort((a, b) => (b.level - a.level) || raceOrder(a, b));
}

// ─── What-if marks (Strategy Simulator) ───

/**
 * Marks a what-if result draws together (Strategy Simulator: the P labels of
 * the plan's card and of the baseline's card, the verdict, the colours of the
 * podium and points differences): their intervals hold for the five at once
 * (familyZ(WHATIF_MARKS)), as the projection table's hold for all its rows. A
 * display fact, not a model value.
 */
export const WHATIF_MARKS = 5;

/**
 * Identity of a what-if: the focus driver, the plan's stops and the
 * baseline's (null = the stop model). A what-if's marks are chained only over
 * recomputes of the same one (whatIfMarks).
 *
 * @param {string} driver
 * @param {Array<{lap: number, compound: string}>} plan
 * @param {Array<{lap: number, compound: string}>|null} basePlan
 * @returns {string}
 */
export function whatIfKey(driver, plan, basePlan) {
  const stops = (list) => (Array.isArray(list) ? list.map((s) => `${s.lap}:${s.compound}`).join(',') : 'model');
  return `${driver}|${stops(plan)}|${stops(basePlan)}`;
}

/**
 * Interval of a what-if's mean paired difference (one of compareJob paired:
 * position, podium, points): mean -/+ z sd / sqrt(n), the normal
 * approximation of a mean over n paired runs.
 *
 * @param {{mean: number, sd: number, n: number}|null} stats
 * @param {number} [z=familyZ(WHATIF_MARKS)]
 * @returns {[number, number]|null} positive = the plan does better
 */
export function pairedInterval(stats, z = familyZ(WHATIF_MARKS)) {
  if (!stats || !(stats.n > 0) || !Number.isFinite(stats.mean)) return null;
  const half = (z * (Number.isFinite(stats.sd) ? stats.sd : 0)) / Math.sqrt(stats.n);
  return [stats.mean - half, stats.mean + half];
}

/**
 * Sign of a paired difference beyond the Monte Carlo error, with hysteresis:
 * 1 (the plan does better) when the whole interval (pairedInterval) is above
 * 0, -1 when it is entirely below; when 0 is inside it, the previous sign of
 * the same what-if (an earlier recompute) while the mean is still on its side
 * (> 0 for 1, < 0 for -1), otherwise 0. So a gain or a loss is shown only
 * beyond the error, and goes only when the mean changes side or the opposite
 * is beyond the error, never on a recompute that only drew other random
 * numbers.
 *
 * @param {{mean: number, sd: number, n: number}|null} stats
 * @param {number} [prevSign]
 * @param {number} [z=familyZ(WHATIF_MARKS)]
 * @returns {-1|0|1|null} null without paired runs
 */
export function pairedSign(stats, prevSign, z = familyZ(WHATIF_MARKS)) {
  const iv = pairedInterval(stats, z);
  if (!iv) return null;
  if (iv[0] > 0) return 1;
  if (iv[1] < 0) return -1;
  if (prevSign === 1 && stats.mean > 0) return 1;
  if (prevSign === -1 && stats.mean < 0) return -1;
  return 0;
}

/**
 * Verdict of a what-if (the Strategy Simulator's PLACES GAINED / PLACES LOST /
 * NO CLEAR CHANGE, its arrow and colour, the colour of a saved comparison):
 * 1 = the plan gains places, -1 = it loses places, 0 = no difference beyond
 * the Monte Carlo error: pairedSign of the run-by-run position difference
 * (paired.position). A result without paired runs falls back on the sign of
 * delta.position.
 *
 * @param {Object} result - compareJob result (paired, delta)
 * @param {number} [prevVerdict] - the previous verdict of the same what-if
 * @returns {-1|0|1}
 */
export function whatIfVerdict(result, prevVerdict) {
  const sign = pairedSign(result?.paired?.position, prevVerdict);
  if (sign != null) return sign;
  const d = result?.delta?.position;
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

/**
 * True when a verdict and the two cards' P labels say opposite things: places
 * gained (1) while the plan's card shows a worse position than the
 * baseline's, or places lost (-1) while it shows a better one.
 *
 * @param {-1|0|1} verdict
 * @param {number|null} custom - the plan card's P label
 * @param {number|null} baseline - the baseline card's P label
 * @returns {boolean}
 */
export function whatIfContradiction(verdict, custom, baseline) {
  if (!Number.isFinite(custom) || !Number.isFinite(baseline)) return false;
  return (verdict > 0 && custom > baseline) || (verdict < 0 && custom < baseline);
}

/**
 * The marks of a what-if result, as the Strategy Simulator draws them,
 * chained over the recomputes of the same what-if (the store keeps them in
 * simulatorResult.marks; scripts/whatif_stability.mjs measures them): the
 * verdict (whatIfVerdict), the finishing position of each result card
 * (shownPositions on that card's row: its median, judged beyond the error of
 * the five marks against the card's previous position; with none, the point
 * median) and the colour of the podium / points differences (pairedSign of
 * paired.podium / paired.points; without paired runs, the sign of delta).
 *
 * The stop-model baseline (opts.stopModel: no saved plan) is the race
 * projection's own row of the driver (compareJob runs the projection's job),
 * so its card shows the Race Prediction panel's P label of that row:
 * shownPositions on the whole stop-model run (result.baseline) against the
 * panel's chained labels (opts.panelMode = store.raceProjection.badges.mode),
 * the panel's rule and intervals; one driver never shows two finishing
 * positions.
 *
 * The verdict compares expected positions (the mean of the run-by-run
 * differences), the cards show medians: the marks are reconciled so that a
 * mark kept only within the Monte Carlo error never contradicts another
 * (whatIfContradiction). The plan's card, then a saved plan's card, takes the
 * position within its own error (shownPositionRange) nearest to the other
 * card's; a verdict still contradicted that is held only by hysteresis (its
 * interval contains 0) becomes 0 (NO CLEAR CHANGE). A contradiction left
 * after that has the verdict and the plan's card beyond their error (the mean
 * and the medians of the runs disagree) and a baseline card that is either
 * beyond its error too or the stop-model card, which stays the panel's label
 * (one finishing position per driver) even where the panel holds it within
 * its own error: the marks then say what the runs and the panel say
 * (scripts/whatif_stability.mjs counts them).
 *
 * @param {Object} result - compareJob result
 * @param {Object} [prev] - marks of the previous result of the same what-if (whatIfKey)
 * @param {{stopModel?: boolean, panelMode?: Object<string, number>|null}} [opts]
 * @returns {{verdict: -1|0|1, shown: {custom: number|null, baseline: number|null},
 *   podium: -1|0|1, points: -1|0|1, z: number}}
 */
export function whatIfMarks(result, prev = null, { stopModel = false, panelMode = null } = {}) {
  const z = familyZ(WHATIF_MARKS);
  const n = result?.numSimulations;
  const card = (row, was) => {
    if (!row?.driver) return null;
    const prevShown = Number.isFinite(was) ? { [row.driver]: was } : undefined;
    const shown = shownPositions({ numSimulations: n, projections: [row] }, prevShown, z)[row.driver];
    return Number.isFinite(shown) ? shown : null;
  };
  const sign = (k) => {
    const s = pairedSign(result?.paired?.[k], prev?.[k], z);
    if (s != null) return s;
    const d = result?.delta?.[k];
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  };
  const baseRow = result?.baselineProjection;
  // the panel's label of the stop-model row (its rule, its intervals)
  const panelShown = stopModel && Array.isArray(result?.baseline?.projections) && baseRow?.driver
    ? shownPositions(result.baseline, panelMode || undefined)[baseRow.driver]
    : undefined;
  const baselineFixed = Number.isFinite(panelShown);
  let verdict = whatIfVerdict(result, prev?.verdict);
  let custom = card(result?.simProjection, prev?.shown?.custom);
  let baseline = baselineFixed ? panelShown : card(baseRow, prev?.shown?.baseline);

  if (whatIfContradiction(verdict, custom, baseline)) {
    const customRange = shownPositionRange(result?.simProjection, n, z) || [custom, custom];
    const baseRange = baselineFixed ? [baseline, baseline] : (shownPositionRange(baseRow, n, z) || [baseline, baseline]);
    if (verdict > 0) {
      // the plan's card at most the baseline's
      custom = Math.max(customRange[0], baseline);
      if (custom > baseline) baseline = Math.min(baseRange[1], custom);
    } else {
      // the plan's card at least the baseline's
      custom = Math.min(customRange[1], baseline);
      if (custom < baseline) baseline = Math.max(baseRange[0], custom);
    }
    const iv = pairedInterval(result?.paired?.position, z);
    const heldOnly = !!iv && !(iv[0] > 0) && !(iv[1] < 0);
    if (whatIfContradiction(verdict, custom, baseline) && heldOnly) verdict = 0;
  }
  return {
    verdict,
    shown: { custom, baseline },
    podium: sign('podium'),
    points: sign('points'),
    z,
  };
}

/**
 * The marks a view draws for a what-if result: the store's (result.marks,
 * chained over recomputes); for a result without them, the rule with no
 * previous state.
 *
 * @param {Object} result - store.simulatorResult (or a saved comparison's result)
 * @returns {{verdict: -1|0|1, shown: {custom: number|null, baseline: number|null},
 *   podium: -1|0|1, points: -1|0|1}}
 */
export function whatIfMarksOf(result) {
  return result?.marks?.shown ? result.marks : whatIfMarks(result);
}
