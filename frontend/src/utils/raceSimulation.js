/**
 * Monte Carlo Race Simulation
 *
 * Forward-projects finish positions using probability distributions
 * derived from REAL session data: actual pit stop durations, actual
 * tyre degradation slopes, actual stint lengths, actual safety car
 * events — no hardcoded constants.
 *
 * Causal: parameters only use laps completed at `sessionNow` (session seconds,
 * utils/raceTime.js). Stints come from the FastF1 Stint column of lap_times
 * (utils/stints.js) and the pit loss from utils/pitLoss.js.
 */
import { completedLaps, resolveSessionNow } from './raceTime';
import { deriveStints } from './stints';
import { estimatePitLoss } from './pitLoss';

// ─── Fallback defaults (only used when session has zero observed data) ───
// The pit-loss fallback lives in utils/pitLoss.js (FALLBACK_PIT_LOSS, source 'fallback').
const FALLBACK_SC_RATE = 0.02; // ~1 SC per 50 laps, typical F1 average
const FALLBACK_SC_DURATION = 4; // laps
const FALLBACK_DEG = { mean: 0.04, stdDev: 0.02 };
const FALLBACK_STINT = { mean: 25, stdDev: 5 };
const FALLBACK_LAP_NOISE = 0.3; // seconds
const FALLBACK_FRESH_DELTA = -0.4; // seconds

// Pit-loss sampling guards (seconds). Not data: the sampler draws around
// pitLoss.median with pitLoss.stdDev, floored at PIT_LOSS_SAMPLING_MIN_SD so a
// race with one sample (stdDev 0) still varies between runs, and every draw is
// kept above PIT_LOSS_NUMERIC_FLOOR only to stop a far-tail normal draw from
// going negative. Neither value shifts the estimate itself.
const PIT_LOSS_SAMPLING_MIN_SD = 0.5;
const PIT_LOSS_NUMERIC_FLOOR = 5;

const COMPOUND_SEQUENCE = ['SOFT', 'MEDIUM', 'HARD'];
// 100 simulations balances runtime (~200-400ms on modern hardware) with stability.
// Median outcomes converge by ~80 runs; tails need ~500+ but are not actionable
// in a live strategy context. For post-race analysis, raise to 500.
const NUM_SIMULATIONS = 100;

// ─── PRNG helpers ───

/** Box-Muller transform: two uniform randoms → one normal random */
function randomNormal(mean, stdDev) {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stdDev;
}

/** Simple linear regression: returns { slope, intercept } */
function linReg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0 };
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sx2 += xs[i] * xs[i];
  }
  const denom = n * sx2 - sx * sx;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/** Mean and stdDev of an array */
function stats(arr) {
  if (!arr.length) return { mean: 0, stdDev: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (arr.length < 2) return { mean, stdDev: 0 };
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return { mean, stdDev: Math.sqrt(variance) };
}

// ══════════════════════════════════════════════════════════════
// STEP 1: Extract real race parameters from actual session data
// ══════════════════════════════════════════════════════════════

/**
 * The session-time "now" for the simulation: opts.sessionNow when it is a
 * number, otherwise the lap-indexed clock of currentLap (raceTime.js
 * resolveSessionNow: the race leader's start of currentLap, the last lap
 * included; pass sessionNow: Infinity for the race over). Older callers passed the unused frameData ({ frames, ... }) as
 * the 5th argument: such objects carry no clock and are ignored.
 */
function simulationNow(lapTimes, currentLap, opts) {
  const o = opts && typeof opts === 'object' && !('frames' in opts) ? opts : {};
  if (typeof o.sessionNow === 'number' && !Number.isNaN(o.sessionNow)) return o.sessionNow;
  return resolveSessionNow({ currentLap, lapTimes, sessionTimeOffset: o.sessionTimeOffset });
}

/**
 * Compute race parameters from real data observed up to sessionNow.
 *
 * @param {Array} lapTimes - sessionData.lap_times (full race; filtered causally here)
 * @param {Array} strategies - unused: stints are derived from lapTimes (utils/stints.js),
 *   kept so existing call sites keep working
 * @param {Array} trackStatus - [{status, start_time, end_time, message}]
 * @param {number} currentLap
 * @param {Object} [opts]
 * @param {number} [opts.sessionNow] - session seconds (raceTime.resolveSessionNow);
 *   when omitted, derived in lap mode from currentLap
 * @param {number} [opts.sessionTimeOffset] - session seconds of replay time 0
 * @param {string} [opts.sessionType] - 'R', 'S', 'Q', 'FP2', ...; omitted = race. Outside
 *   'R' / 'S' the pit loss is { source: 'not-applicable' } with no numbers (pitLoss.js)
 * @param {boolean|function(string): boolean} [opts.running] - deriveStints option: in live
 *   mode the stints still being run are not completed stint lengths (stints.js stintsRunning)
 * @returns {Object} raceParams; pitLoss is the utils/pitLoss.js estimatePitLoss object
 *   ({ median, mean, stdDev, p10, p90, n, source, samples }, seconds; median = point estimate)
 */
export function extractRaceParams(lapTimes, strategies, trackStatus, currentLap, opts = {}) {
  const sessionNow = simulationNow(lapTimes, currentLap, opts);
  const sessionType = opts && typeof opts === 'object' && !('frames' in opts) ? opts.sessionType : undefined;
  const params = {
    // ── 1. Pit stop time loss ──
    // FastF1 splits one stop over two rows (PitInTime on the in-lap n,
    // PitOutTime on the out-lap n + 1), so the loss is in-lap + out-lap - 2 x
    // the driver's green median, over green stops completed at sessionNow.
    // source 'fallback' (n = 0) when no stop qualifies yet; 'not-applicable'
    // outside race sessions.
    pitLoss: estimatePitLoss(lapTimes, { sessionNow, sessionType }),
    tyreDeg: {},       // { SOFT: {mean, stdDev}, MEDIUM: ... }
    stintLength: {},   // { SOFT: {mean, stdDev}, ... }
    freshDelta: FALLBACK_FRESH_DELTA,
    lapNoise: FALLBACK_LAP_NOISE,
    scRate: FALLBACK_SC_RATE,
    scDuration: FALLBACK_SC_DURATION,
  };

  if (!lapTimes?.length) return params;

  // Only laps completed at sessionNow (the unfinished current lap is unknown)
  const laps = completedLaps(lapTimes, sessionNow);

  // ── Identify clean laps (no pit activity, reasonable time) ──
  const cleanLaps = laps.filter(
    (lt) => lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 200 &&
            !lt.PitInTimeSeconds && !lt.PitOutTimeSeconds
  );

  // ── 1. Pit stop time loss: computed above (params.pitLoss) ──

  // ── 2. Tyre degradation per compound ──
  // Group clean laps by driver+stint, compute slope of lapTime vs tyreLife
  const compoundSlopes = {};
  const driverStints = {};

  // Group laps into stints (contiguous laps on same compound)
  for (const lt of cleanLaps) {
    const key = `${lt.Driver}_${lt.Compound}`;
    if (!driverStints[key]) driverStints[key] = [];
    driverStints[key].push({ tyreLife: lt.TyreLife || 0, time: lt.LapTimeSeconds });
  }

  for (const [key, stintLaps] of Object.entries(driverStints)) {
    if (stintLaps.length < 3) continue; // need enough laps for regression
    const compound = key.split('_').pop();
    const xs = stintLaps.map((l) => l.tyreLife);
    const ys = stintLaps.map((l) => l.time);
    const { slope } = linReg(xs, ys);
    // Only keep positive slopes (degradation should worsen times)
    if (slope > -0.5 && slope < 1.0) {
      if (!compoundSlopes[compound]) compoundSlopes[compound] = [];
      compoundSlopes[compound].push(Math.max(0, slope));
    }
  }

  for (const [compound, slopes] of Object.entries(compoundSlopes)) {
    if (slopes.length >= 1) {
      params.tyreDeg[compound] = stats(slopes);
      if (params.tyreDeg[compound].stdDev < 0.005) {
        params.tyreDeg[compound].stdDev = 0.005;
      }
    }
  }

  // ── 3. Average stint lengths per compound ──
  // Stints from the FastF1 Stint column of the laps completed at sessionNow
  // (tyre_strategy merges back-to-back stints on the same compound).
  const running = opts && typeof opts === 'object' ? opts.running || false : false;
  const stints = deriveStints(lapTimes, { sessionNow, running });
  if (stints.length) {
    const compoundStints = {};
    for (const s of stints) {
      if (s.ongoing) continue; // only completed stints
      const total = s.TotalLaps || (s.EndLap - s.StartLap + 1);
      if (total > 0 && total < 80) {
        if (!compoundStints[s.Compound]) compoundStints[s.Compound] = [];
        compoundStints[s.Compound].push(total);
      }
    }
    for (const [compound, lengths] of Object.entries(compoundStints)) {
      if (lengths.length >= 1) {
        params.stintLength[compound] = stats(lengths);
        if (params.stintLength[compound].stdDev < 2) {
          params.stintLength[compound].stdDev = 2;
        }
      }
    }
  }

  // ── 4. Fresh tyre delta ──
  // Compare laps with TyreLife <= 2 vs TyreLife 5-10 for same driver/compound
  const freshTimes = [];
  const warmedTimes = [];
  for (const lt of cleanLaps) {
    if (lt.TyreLife <= 2 && lt.LapTimeSeconds > 0) freshTimes.push(lt.LapTimeSeconds);
    if (lt.TyreLife >= 5 && lt.TyreLife <= 10 && lt.LapTimeSeconds > 0) warmedTimes.push(lt.LapTimeSeconds);
  }
  if (freshTimes.length >= 2 && warmedTimes.length >= 2) {
    const freshMean = freshTimes.reduce((a, b) => a + b, 0) / freshTimes.length;
    const warmedMean = warmedTimes.reduce((a, b) => a + b, 0) / warmedTimes.length;
    const delta = freshMean - warmedMean;
    // Fresh tyres could be faster (negative) or slower due to warm-up (positive)
    if (Math.abs(delta) < 5) params.freshDelta = delta;
  }

  // ── 5. Lap time noise (within-stint variance) ──
  const residuals = [];
  for (const [key, stintLaps] of Object.entries(driverStints)) {
    if (stintLaps.length < 4) continue;
    const xs = stintLaps.map((l) => l.tyreLife);
    const ys = stintLaps.map((l) => l.time);
    const { slope, intercept } = linReg(xs, ys);
    for (let i = 0; i < xs.length; i++) {
      const predicted = intercept + slope * xs[i];
      residuals.push(ys[i] - predicted);
    }
  }
  if (residuals.length >= 5) {
    const noiseStats = stats(residuals);
    params.lapNoise = Math.max(0.1, Math.min(1.5, noiseStats.stdDev));
  }

  // ── 6. Safety car rate and duration ──
  if (trackStatus?.length && currentLap > 0) {
    const scEvents = trackStatus.filter(
      (s) => (s.status === '4' || s.status === '6' || s.status === '7')
    );

    if (scEvents.length > 0) {
      // Estimate SC laps from duration
      // Average lap time ≈ median clean lap time across all drivers
      const allCleanTimes = cleanLaps.map((lt) => lt.LapTimeSeconds);
      allCleanTimes.sort((a, b) => a - b);
      const medianLapTime = allCleanTimes[Math.floor(allCleanTimes.length / 2)] || 90;

      const scDurations = [];
      for (const sc of scEvents) {
        if (sc.end_time && sc.start_time) {
          const durationSec = sc.end_time - sc.start_time;
          const durationLaps = Math.max(1, Math.round(durationSec / medianLapTime));
          if (durationLaps < 20) scDurations.push(durationLaps);
        }
      }

      // SC rate: events per lap (observed in this race)
      params.scRate = scEvents.length / currentLap;
      // Cap at reasonable level
      params.scRate = Math.min(0.1, params.scRate);

      if (scDurations.length > 0) {
        const scStats = stats(scDurations);
        params.scDuration = Math.max(2, Math.round(scStats.mean));
      }
    } else {
      // No SC observed in this race: lower the rate
      params.scRate = Math.max(0.005, FALLBACK_SC_RATE * (1 - currentLap / 60));
    }
  }

  return params;
}

// ══════════════════════════════════════════════════════════
// STEP 2: Monte Carlo simulation engine
// ══════════════════════════════════════════════════════════

/**
 * Pick next compound when pitting (deterministic — same logic for all sims).
 */
function nextCompound(currentCompound, stintNumber) {
  if (currentCompound === 'INTERMEDIATE' || currentCompound === 'WET') return currentCompound;
  const idx = COMPOUND_SEQUENCE.indexOf(currentCompound);
  if (idx >= 0 && idx < COMPOUND_SEQUENCE.length - 1) return COMPOUND_SEQUENCE[idx + 1];
  if (stintNumber >= 3) return 'HARD';
  return 'MEDIUM';
}

/**
 * Run a single Monte Carlo simulation for all drivers.
 * Returns finish positions as { driver: position }.
 */
function runOneSim(drivers, driverFeatures, raceParams, currentLap, maxLap) {
  const lapsRemaining = maxLap - currentLap;
  if (lapsRemaining <= 0) return null;

  // Initialize driver states
  const state = {};
  for (const drv of drivers) {
    const feat = driverFeatures[drv];
    const compound = feat.compoundName || 'MEDIUM';

    // Sample this driver's stint limit from real distribution
    const stintStats = raceParams.stintLength[compound] || FALLBACK_STINT;
    const stintLimit = Math.max(8, Math.round(randomNormal(stintStats.mean, stintStats.stdDev)));

    // Sample this driver's degradation rate from real distribution
    const degStats = raceParams.tyreDeg[compound] || FALLBACK_DEG;
    const degRate = Math.max(0, randomNormal(degStats.mean, degStats.stdDev));

    state[drv] = {
      cumTime: feat.gapToLeader || 0,
      tyreLife: feat.tyreLife || 0,
      compound,
      basePace: feat.recentPace || 90,
      paceTrend: feat.paceTrend || 0,
      stintNumber: feat.stintNumber || 1,
      stintLimit,
      degRate,
      pitStops: 0,
      freshLaps: 0, // laps since last pit (for fresh tyre effect)
    };
  }

  // Simulate each remaining lap
  let scLapsLeft = 0; // safety car countdown

  for (let lap = 1; lap <= lapsRemaining; lap++) {
    // ── Safety car roll ──
    if (scLapsLeft <= 0 && Math.random() < raceParams.scRate) {
      scLapsLeft = Math.max(2, Math.round(randomNormal(raceParams.scDuration, 1)));
    }
    const isSC = scLapsLeft > 0;
    if (isSC) scLapsLeft--;

    for (const drv of drivers) {
      const s = state[drv];
      s.tyreLife++;
      s.freshLaps++;

      // ── Pit stop check ──
      if (s.tyreLife >= s.stintLimit && lap < lapsRemaining - 2) {
        // Sample pit loss around the race median (utils/pitLoss.js), see PIT_LOSS_* guards
        const pitSd = Math.max(PIT_LOSS_SAMPLING_MIN_SD, raceParams.pitLoss.stdDev || 0);
        const pitLoss = Math.max(PIT_LOSS_NUMERIC_FLOOR, randomNormal(raceParams.pitLoss.median, pitSd));
        s.cumTime += pitLoss;
        s.pitStops++;
        s.compound = nextCompound(s.compound, s.stintNumber + s.pitStops);
        s.stintNumber++;
        s.tyreLife = 0;
        s.freshLaps = 0;

        // Re-sample stint limit and deg rate for new compound
        const newStintStats = raceParams.stintLength[s.compound] || FALLBACK_STINT;
        s.stintLimit = Math.max(8, Math.round(randomNormal(newStintStats.mean, newStintStats.stdDev)));
        const newDegStats = raceParams.tyreDeg[s.compound] || FALLBACK_DEG;
        s.degRate = Math.max(0, randomNormal(newDegStats.mean, newDegStats.stdDev));

        // Pace partially resets with fresh tyres
        s.paceTrend = Math.max(0, s.paceTrend * 0.3);
      }

      // ── Compute lap time ──
      if (isSC) {
        // Under safety car: fixed slow pace, gaps frozen
        s.cumTime += s.basePace + 15; // SC pace ~15s slower
      } else {
        const degradation = s.degRate * s.tyreLife;
        const trendEffect = s.paceTrend * lap;
        const freshBoost = s.freshLaps <= 3
          ? raceParams.freshDelta * (1 - s.freshLaps / 4)
          : 0;
        const noise = randomNormal(0, raceParams.lapNoise);

        const lapTime = s.basePace + trendEffect + degradation + freshBoost + noise;
        s.cumTime += Math.max(60, Math.min(200, lapTime));
      }
    }

    // ── Under SC: compress gaps (simulate bunching) ──
    if (isSC) {
      // Find the leader (lowest cumTime)
      let minTime = Infinity;
      for (const drv of drivers) {
        if (state[drv].cumTime < minTime) minTime = state[drv].cumTime;
      }
      // Compress all gaps toward leader by 60%
      for (const drv of drivers) {
        const gap = state[drv].cumTime - minTime;
        state[drv].cumTime = minTime + gap * 0.4;
      }
    }
  }

  // ── Sort by cumulative time → finish positions ──
  const results = drivers.map((drv) => ({
    driver: drv,
    cumTime: state[drv].cumTime,
    pitStops: state[drv].pitStops,
  }));
  results.sort((a, b) => a.cumTime - b.cumTime);

  const positions = {};
  results.forEach((r, idx) => {
    positions[r.driver] = { pos: idx + 1, pitStops: r.pitStops };
  });
  return positions;
}

// ══════════════════════════════════════════════════════════
// STEP 3: Aggregate results across simulations
// ══════════════════════════════════════════════════════════

function aggregateResults(allSims, driverFeatures, numSims) {
  const drivers = Object.keys(driverFeatures);
  const numDrivers = drivers.length;

  // ── Per-driver position distributions ──
  const projections = drivers.map((drv) => {
    const feat = driverFeatures[drv];
    const positions = [];
    const pitCounts = [];
    const posCount = {}; // position → count

    for (const sim of allSims) {
      if (!sim || !sim[drv]) continue;
      const p = sim[drv].pos;
      positions.push(p);
      pitCounts.push(sim[drv].pitStops);
      posCount[p] = (posCount[p] || 0) + 1;
    }

    if (positions.length === 0) {
      return {
        driver: drv,
        currentPos: feat.position,
        expectedPos: feat.position,
        modePos: feat.position,
        posRange: [feat.position, feat.position],
        posDistribution: { [feat.position]: 100 },
        podiumProb: feat.position <= 3 ? 100 : 0,
        pointsProb: feat.position <= 10 ? 100 : 0,
        pitStopsRemaining: { mean: 0, range: [0, 0] },
        delta: 0,
      };
    }

    positions.sort((a, b) => a - b);

    // Expected position (weighted average)
    const expectedPos = positions.reduce((a, b) => a + b, 0) / positions.length;

    // Mode position (most common)
    let modePos = feat.position;
    let maxCount = 0;
    for (const [pos, count] of Object.entries(posCount)) {
      if (count > maxCount) { maxCount = count; modePos = parseInt(pos); }
    }

    // Position range: 5th to 95th percentile
    const p5Idx = Math.max(0, Math.floor(positions.length * 0.05));
    const p95Idx = Math.min(positions.length - 1, Math.floor(positions.length * 0.95));
    const posRange = [positions[p5Idx], positions[p95Idx]];

    // Position distribution as percentages
    const posDistribution = {};
    for (const [pos, count] of Object.entries(posCount)) {
      const pct = Math.round((count / positions.length) * 100);
      if (pct > 0) posDistribution[parseInt(pos)] = pct;
    }

    // Podium and points probabilities
    const podiumCount = positions.filter((p) => p <= 3).length;
    const pointsCount = positions.filter((p) => p <= 10).length;

    // Pit stops
    pitCounts.sort((a, b) => a - b);
    const pitMean = pitCounts.reduce((a, b) => a + b, 0) / pitCounts.length;
    const pitMin = pitCounts[Math.floor(pitCounts.length * 0.05)] || 0;
    const pitMax = pitCounts[Math.min(pitCounts.length - 1, Math.floor(pitCounts.length * 0.95))] || 0;

    return {
      driver: drv,
      currentPos: feat.position,
      expectedPos: Math.round(expectedPos * 10) / 10,
      modePos,
      posRange,
      posDistribution,
      podiumProb: Math.round((podiumCount / positions.length) * 100),
      pointsProb: Math.round((pointsCount / positions.length) * 100),
      pitStopsRemaining: { mean: Math.round(pitMean * 10) / 10, range: [pitMin, pitMax] },
      delta: Math.round((feat.position - expectedPos) * 10) / 10,
    };
  });

  // Sort by expected position
  projections.sort((a, b) => a.expectedPos - b.expectedPos);

  // ── Battles: pairwise overtake probabilities ──
  const battles = [];
  for (let i = 0; i < drivers.length; i++) {
    for (let j = i + 1; j < drivers.length; j++) {
      const d1 = drivers[i];
      const d2 = drivers[j];
      const feat1 = driverFeatures[d1];
      const feat2 = driverFeatures[d2];

      // Only check drivers within 4 positions of each other
      if (Math.abs(feat1.position - feat2.position) > 4) continue;

      // Determine who's currently ahead
      const [ahead, behind] = feat1.position < feat2.position ? [d1, d2] : [d2, d1];

      // Count how often the behind driver finishes ahead
      let overtakeCount = 0;
      for (const sim of allSims) {
        if (!sim || !sim[ahead] || !sim[behind]) continue;
        if (sim[behind].pos < sim[ahead].pos) overtakeCount++;
      }

      const prob = Math.round((overtakeCount / allSims.length) * 100);
      if (prob < 5) continue; // Skip very unlikely overtakes

      battles.push({
        ahead,
        behind,
        aheadCurrentPos: driverFeatures[ahead].position,
        behindCurrentPos: driverFeatures[behind].position,
        prob,
        aheadCompound: driverFeatures[ahead].compoundName,
        behindCompound: driverFeatures[behind].compoundName,
      });
    }
  }

  battles.sort((a, b) => b.prob - a.prob);

  return { projections, battles: battles.slice(0, 6) };
}

// ══════════════════════════════════════════════════════════
// STEP 4: Risk identification from real data
// ══════════════════════════════════════════════════════════

function identifyRisks(projections, driverFeatures, raceParams, currentLap, maxLap) {
  const risks = [];
  const lapsRemaining = maxLap - currentLap;

  for (const proj of projections) {
    const drv = proj.driver;
    const feat = driverFeatures[drv];

    // Wide position range = high uncertainty
    const spread = proj.posRange[1] - proj.posRange[0];
    if (spread >= 5) {
      risks.push({
        driver: drv,
        type: 'HIGH VARIANCE',
        severity: spread >= 8 ? 'high' : 'medium',
        description: `${drv} could finish anywhere from P${proj.posRange[0]} to P${proj.posRange[1]} — highly unpredictable outcome`,
      });
    }

    // Extra pit stop risk (most sims show 2+ stops)
    if (proj.pitStopsRemaining.mean >= 1.8) {
      const pitLoss = raceParams.pitLoss.median;
      const pitLossNote = raceParams.pitLoss.source === 'fallback' ? ' (fallback pit loss, no measured stop yet)' : '';
      risks.push({
        driver: drv,
        type: 'EXTRA STOP',
        severity: 'high',
        description: `${drv} likely needs ${Math.round(proj.pitStopsRemaining.mean)} more stops — ~${Math.round(proj.pitStopsRemaining.mean * pitLoss)}s time loss${pitLossNote}`,
      });
    }

    // Heavy degradation from real data
    if (feat.paceTrend > 0.15) {
      const compoundDeg = raceParams.tyreDeg[feat.compoundName];
      const degStr = compoundDeg
        ? `(observed ${feat.compoundName} deg: ${compoundDeg.mean.toFixed(3)}s/lap)`
        : '';
      risks.push({
        driver: drv,
        type: 'DEGRADATION',
        severity: feat.paceTrend > 0.25 ? 'high' : 'medium',
        description: `${drv} losing ${feat.paceTrend.toFixed(2)}s/lap on ${feat.compoundName} ${degStr}`,
      });
    }

    // Tyre cliff: nearing stint limit based on real data
    const stintStats = raceParams.stintLength[feat.compoundName] || FALLBACK_STINT;
    const tyreRatio = feat.tyreLife / stintStats.mean;
    if (tyreRatio > 0.85 && proj.pitStopsRemaining.mean < 0.5 && lapsRemaining > 5) {
      risks.push({
        driver: drv,
        type: 'TYRE CLIFF',
        severity: tyreRatio > 0.95 ? 'high' : 'medium',
        description: `${drv} pushing ${feat.compoundName} to limit (${feat.tyreLife}/${Math.round(stintStats.mean)} avg stint) with no pit planned`,
      });
    }
  }

  const severityOrder = { high: 0, medium: 1, low: 2 };
  risks.sort((a, b) => (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2));
  return risks.slice(0, 5);
}

// ══════════════════════════════════════════════════════════
// MAIN EXPORT — same API name for backward compatibility
// ══════════════════════════════════════════════════════════

/**
 * Monte Carlo race finish simulation.
 *
 * @param {Object} params
 * @param {Object} params.driverFeatures - from raceSituationData.driverFeatures
 * @param {number} params.currentLap
 * @param {number} params.maxLap
 * @param {Array}  params.lapTimes - sessionData.lap_times (real data)
 * @param {Array}  params.strategies - sessionData.tyre_strategy (unused, see extractRaceParams)
 * @param {Array}  params.trackStatus - real safety car/VSC events
 * @param {number} [params.sessionNow] - session seconds; lap mode from currentLap when omitted
 * @param {number} [params.sessionTimeOffset] - session seconds of replay time 0
 * @param {string} [params.sessionType] - 'R', 'S', 'Q', ...; omitted = race. A race
 *   projection needs a race pit loss: null outside 'R' / 'S'
 * @param {boolean|function(string): boolean} [params.running] - live mode: drivers still on
 *   their current set (stints.js stintsRunning), see extractRaceParams
 * @returns {{ projections, battles, risks, raceParams }}
 */
export function simulateRaceFinish({
  driverFeatures, currentLap, maxLap, lapTimes, strategies, trackStatus,
  sessionNow, sessionTimeOffset, sessionType, running,
}) {
  if (!driverFeatures || currentLap < 5 || maxLap <= currentLap) return null;

  const drivers = Object.keys(driverFeatures);
  if (drivers.length < 2) return null;

  // ── Step 1: Extract real parameters ──
  const raceParams = extractRaceParams(lapTimes, strategies, trackStatus, currentLap,
    { sessionNow, sessionTimeOffset, sessionType, running });
  // No race pit loss outside race sessions ('not-applicable'): no projection
  if (raceParams.pitLoss?.source === 'not-applicable') return null;

  // ── Step 2: Run Monte Carlo simulations ──
  const allSims = [];
  for (let i = 0; i < NUM_SIMULATIONS; i++) {
    const simResult = runOneSim(drivers, driverFeatures, raceParams, currentLap, maxLap);
    if (simResult) allSims.push(simResult);
  }

  if (allSims.length < 10) return null; // not enough successful sims

  // ── Step 3: Aggregate ──
  const { projections, battles } = aggregateResults(allSims, driverFeatures, allSims.length);

  // ── Step 4: Risks ──
  const risks = identifyRisks(projections, driverFeatures, raceParams, currentLap, maxLap);

  return { projections, battles, risks, raceParams };
}
