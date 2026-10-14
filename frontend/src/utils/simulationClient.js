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
 *  - the badge rule of the projection views (projectionBadges, battleLevel,
 *    listedBattles, modePosition, projectionRisks): Wilson interval plus
 *    hysteresis, so a badge, the most likely position shown, the list of
 *    battles shown and its order, and the risk rows never change on Monte
 *    Carlo noise alone: only on evidence beyond the sampling error, or on
 *    new data.
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
 *   simProjection, delta: { position, podium, points }, baseline, custom }
 *   delta.position = baseline expected position - plan expected position
 *   (positive = the plan gains places); podium / points in percentage points
 */
function compareJob(params) {
  const { focusDriver, plan, basePlan, ...common } = params || {};
  const baseline = simulateRaceFinish({
    ...common, plans: basePlan ? { [focusDriver]: basePlan } : undefined,
  });
  const custom = simulateRaceFinish({
    ...common, raceParams: baseline?.raceParams, plans: { [focusDriver]: plan || [] },
  });
  if (!baseline || !custom) return null;
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
    baseline,
    custom,
  };
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
 * @returns {boolean}
 */
export function badgeOn(pct, n, thresholdPct, prevOn) {
  const [lo, hi] = wilsonInterval(pct / 100, n);
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
 * (notes/experiments/battle_list_rules.txt).
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

/**
 * The most likely finishing position shown for each driver, with hysteresis:
 * the previous projection's position stays while its share is within the
 * Monte Carlo error of the most frequent one's (the Wilson intervals of the
 * two shares overlap); the most frequent position replaces it once its share
 * is beyond that error. No previous position: the most frequent (modePos).
 *
 * @param {Object} result - simulateRaceFinish result
 * @param {Object} [prevMode] - { driver: position } of the previous projection
 * @returns {Object<string, number>}
 */
function modePositions(result, prevMode) {
  const n = result?.numSimulations;
  const out = {};
  for (const p of result?.projections || []) {
    const point = p.modePos;
    const was = prevMode?.[p.driver];
    if (was == null || was === point || !(n > 0)) { out[p.driver] = point; continue; }
    const dist = p.posDistribution || {};
    const [, wasHi] = wilsonInterval((dist[was] || 0) / 100, n);
    const [pointLo] = wilsonInterval((dist[point] || 0) / 100, n);
    out[p.driver] = wasHi >= pointLo ? was : point;
  }
  return out;
}

/**
 * Badge states of a projection (badgeOn on every podium probability and on
 * every battle, against the previous projection's states), the battle list
 * (battleList, against the previous list), the most likely position shown
 * (modePositions) and, given the projection's inputs (ctx), the risk rows
 * (raceSimulation.js evaluateRisks against the previous levels).
 *
 * @param {Object} result - simulateRaceFinish result ({ projections, battles, numSimulations })
 * @param {Object} [prev] - the previous projection's badges (same session, earlier clock)
 * @param {Object} [ctx] - { driverFeatures, currentLap, maxLap } of the projection; without it
 *   no risk rows are judged (risks / riskLevels null)
 * @returns {{podium: Object<string, boolean>, battles: Object<string, {level: number}>,
 *   listed: string[], mode: Object<string, number>, risks: Array<Object>|null,
 *   riskLevels: Object<string, number>|null, n: number, z: number}}
 *   battle level 0 / 1 / 2 = below 30 % / 30 % / 60 %
 */
export function projectionBadges(result, prev = null, ctx = null) {
  const n = result?.numSimulations;
  const podium = {};
  for (const p of result?.projections || []) {
    podium[p.driver] = badgeOn(p.podiumProb, n, PODIUM_BADGE_PCT, prev?.podium?.[p.driver]);
  }
  const battles = {};
  for (const b of result?.battles || []) {
    const key = battleKey(b);
    const was = prev?.battles?.[key];
    const on = BATTLE_BADGE_PCT.map((t, i) => badgeOn(b.prob, n, t, was ? was.level > i : undefined));
    battles[key] = { level: on[1] ? 2 : on[0] ? 1 : 0 };
  }
  const listed = battleList(result?.battles, n, prev?.listed);
  const mode = modePositions(result, prev?.mode);
  let risks = null;
  let riskLevels = null;
  if (ctx?.driverFeatures && result?.raceParams && Array.isArray(result?.projections)) {
    const judged = evaluateRisks(result.projections, ctx.driverFeatures, result.raceParams,
      ctx.currentLap, ctx.maxLap, { n, prev: prev?.riskLevels });
    risks = judged.rows.slice(0, RISK_LIST_SIZE);
    riskLevels = judged.levels;
  }
  return { podium, battles, listed, mode, risks, riskLevels, n, z: BADGE_Z };
}

/**
 * The most likely finishing position a view shows for a projection row: the
 * store's (projection.badges.mode, chained over recomputes by modePositions:
 * it changes only on evidence beyond the Monte Carlo error); modePos for a
 * projection without badges.
 *
 * @param {Object} projection - store.raceProjection
 * @param {Object} row - one of projection.projections
 * @returns {number}
 */
export function modePosition(projection, row) {
  const shown = projection?.badges?.mode?.[row?.driver];
  return Number.isFinite(shown) ? shown : row?.modePos;
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
  const on = BATTLE_BADGE_PCT.map((t) => badgeOn(battle.prob, projection?.numSimulations, t));
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
