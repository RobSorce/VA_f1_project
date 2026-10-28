/**
 * Ring check of the Circle of Doom (src/utils/circleOfDoom.js and the pit-lane
 * and sector modules circlePitLane.js / circleSectors.js) on every cached race:
 * how the line anchor and the pit-exit anchor of an out-lap (phases
 * outLapAnchor 'line' / 'pitExit') draw a pit stop, the race's pit-lane time,
 * the sector marks, and how far the drawn phase is from the timing points.
 *
 * Run from frontend/ (vite-node resolves the extensionless imports of src/),
 * where backend/data/processed_cache holds the cached races (git-ignored):
 *     npx vite-node scripts/cod_ring_check.mjs [--out <file>]
 * Writes docs/evidence/cod_ring_check.txt (or the --out file, relative to
 * frontend/) and prints the same text.
 *
 * Drawn phase. What the view draws at a session time t: circleState memoised
 * on circleStateKey (one state per key, built at the first time of the key)
 * and the car moved with phaseAt(car, t, refLap), clamped at 0.999. Between
 * two keys the anchor and the reference lap do not change, so the seconds a
 * car is held at 0.999 inside an interval are exact: max(0, end - max(start,
 * anchorTime + 0.999 x refLap)) over each stretch between two events (a lap
 * Time, a PitInTime, a PitOutTime, a lap-1 sector time).
 *
 * Stops: the green stops of cod_backtest.mjs (pitLoss.estimatePitLoss over the
 * whole race: in-lap n with a pit entry, out-lap n + 1 with a pit exit, laps
 * n - 1 to n + 1 green, loss in (10, 60) s; Time set on laps n - 1 and n + 1).
 * For each anchor:
 *  - seconds held at 0.999 before the pit entry (Time(n - 1) to PitInTime), in
 *    the lane (PitInTime to PitOutTime) and on the out-lap after the exit
 *    (PitOutTime to Time(n + 1));
 *  - the arrival phase: the drawn phase 1 ms before Time(n + 1); 1 - phase
 *    in seconds (x refLap) is how far the car jumps when it crosses the line;
 *  - the rejoin marker of the stop under way (pitWindow rejoinPhase with the
 *    stopping car as focus) 1 s after the pit entry, 1 s after the pit exit and
 *    halfway between the exit and the end of the out-lap: the cars drawn
 *    nearest ahead of and behind it on the ring (every car on the ring, then
 *    only the cars on the focus's lap) against the rank's neighbours (the last
 *    rival across the target lap before predictedCrossing, and the first one
 *    after it; pitWindow rivalCrossings). The ring moves every car at the
 *    reference lap, the rank projects each one at its own pace with its
 *    pending loss (circleOfDoom.js header), so the two can differ.
 * Lane: circlePitLane.laneStats at the end of each race (median, n).
 * Sector fractions: circleSectors.sectorFractions after the leader's lap 5,
 * after its lap 20 and at the end, with the interquartile range of the
 * per-lap shares (sectorShares).
 * Accuracy: at every real timing point of every lap after lap 1 (the end of
 * sector 1 at Sector1SessionTime, of sector 2 at Sector2SessionTime, and the
 * line 1 ms before the lap's Time), the drawn phase against the race's causal
 * sector fraction at that time (f1, f12, 1 for the line), in seconds (x
 * refLap), by lap type: out-lap (PitOutTime on the lap), in-lap (PitInTime),
 * SC/VSC/red (TrackStatus with a 4, 5, 6 or 7), normal (the rest); a pit lap
 * under a neutralised track counts as a pit lap, and the pit laps are also
 * shown on a green track only (TrackStatus '1'). Timing points before the race
 * has sector fractions (fewer than REF_MIN_SAMPLES laps) are left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  circleState, circleStateKey, phaseAt, pitWindow, lapOffset, wrapPhase, PHASE_MAX,
} from '../src/utils/circleOfDoom.js';
import { laneStats } from '../src/utils/circlePitLane.js';
import { sectorFractions, sectorShares } from '../src/utils/circleSectors.js';
import { estimatePitLoss } from '../src/utils/pitLoss.js';
import {
  hasPitIn, hasPitOut, pitInSeconds, pitOutSeconds, leaderLapEndTime,
} from '../src/utils/raceTime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../../backend/data/processed_cache');
const OUT_ARG = process.argv.indexOf('--out');
const OUT_FILE = OUT_ARG > 0
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.resolve(HERE, '../../docs/evidence/cod_ring_check.txt');
const ANCHORS = ['line', 'pitExit'];
const NEUTRALISED = /[4567]/;
const EPS = 1e-3;

/** Empirical percentile with linear interpolation (numpy's default), or null. */
function percentile(values, p) {
  const a = [...values].sort((x, y) => x - y);
  if (!a.length) return null;
  const h = (a.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return a[lo] + (h - lo) * (a[hi] - a[lo]);
}
const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(d));
const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}%` : 'n/a');

function loadRace(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = JSON.parse(raw.replace(/\bNaN\b/g, 'null'));
  }
  return data.lap_times;
}

function index(lapTimes) {
  const by = new Map();
  for (const r of lapTimes) {
    if (!by.has(r.Driver)) by.set(r.Driver, new Map());
    by.get(r.Driver).set(Number(r.LapNumber), r);
  }
  return by;
}

/** Sorted times at which circleStateKey can change. */
function eventTimes(lapTimes) {
  const out = new Set();
  for (const r of lapTimes) {
    for (const v of [r.Time, pitInSeconds(r), pitOutSeconds(r)]) if (Number.isFinite(v)) out.add(v);
    if (Number(r.LapNumber) === 1) {
      for (const k of [1, 2]) if (Number.isFinite(r[`Sector${k}SessionTime`])) out.add(r[`Sector${k}SessionTime`]);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Index of the first value of a sorted array greater than x. */
function upper(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The view's memo: one circleState per circleStateKey and anchor, and its sector fractions. */
function memoOf(lapTimes) {
  const states = new Map();
  return (anchor, t) => {
    const key = `${anchor}|${circleStateKey(lapTimes, t)}`;
    if (!states.has(key)) {
      const st = circleState(lapTimes, { sessionNow: t, outLapAnchor: anchor });
      states.set(key, { st, fr: sectorFractions(lapTimes, st.refLap, t) });
    }
    return states.get(key);
  };
}

/** Seconds a driver is drawn at 0.999 inside [a, b). */
function heldSeconds(memo, events, anchor, driver, a, b) {
  let held = 0;
  const cuts = [a, ...events.slice(upper(events, a), upper(events, b - 1e-9)), b];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [s, e] = [cuts[i], cuts[i + 1]];
    if (!(e > s)) continue;
    const { st } = memo(anchor, s);
    const car = st.cars.find((c) => c.driver === driver);
    const ref = st.refLap.seconds;
    if (!car || car.finished || !(ref > 0)) continue;
    held += Math.max(0, e - Math.max(s, car.anchorTime + PHASE_MAX * ref));
  }
  return held;
}

/** Nearest ring cars ahead of / behind a phase (cars on the ring, as the band reads them). */
function ringNeighbours(st, focus, phase, sameLap) {
  const ring = st.cars
    .filter((c) => c.driver !== focus && !c.inPitLane && !c.finished && c.phase != null)
    .filter((c) => !sameLap || lapOffset(focus, c.driver, st) === 0)
    .map((c) => ({ driver: c.driver, ahead: wrapPhase(c.phase - phase) }))
    .sort((x, y) => x.ahead - y.ahead || x.driver.localeCompare(y.driver));
  return ring.length ? { ahead: ring[0].driver, behind: ring[ring.length - 1].driver } : null;
}

/** The rank's neighbours of a window: last rival across the target lap before the focus, first after. */
function rankNeighbours(w) {
  const finite = w.rivalCrossings.filter((r) => Number.isFinite(r.time));
  const before = finite.filter((r) => r.time < w.predictedCrossing);
  const after = finite.filter((r) => r.time >= w.predictedCrossing);
  return { ahead: before.length ? before[before.length - 1].driver : null, behind: after[0]?.driver ?? null };
}

function lapType(row) {
  if (hasPitOut(row)) return 'out-lap';
  if (hasPitIn(row)) return 'in-lap';
  if (NEUTRALISED.test(String(row.TrackStatus ?? ''))) return 'SC/VSC/red';
  return 'normal';
}

const races = (fs.existsSync(CACHE_DIR) ? fs.readdirSync(CACHE_DIR) : [])
  .map((file) => /^session_(\d{4})_(\d+)_R\.json$/.exec(file))
  .filter(Boolean)
  .map((m) => ({ name: `${m[1]}_${m[2]}`, file: path.join(CACHE_DIR, m[0]) }))
  .sort((a, b) => (a.name < b.name ? -1 : 1));
if (!races.length) throw new Error(`no cached race sessions in ${CACHE_DIR}`);

const PHASES = ['before the pit entry', 'in the lane', 'out-lap after the exit'];
const MOMENTS = ['1 s after the pit entry', '1 s after the pit exit', 'halfway from the exit to the line'];
const TYPES = ['normal', 'in-lap', 'out-lap', 'SC/VSC/red'];
// Pit laps on a green track only (TrackStatus '1'), in the summary
const GREEN_PIT = ['in-lap', 'out-lap'];
const POINTS = ['S1', 'S2', 'line'];
const blank = () => Object.fromEntries(ANCHORS.map((a) => [a, {
  held: Object.fromEntries(PHASES.map((p) => [p, []])),
  arrival: [],
  neighbours: Object.fromEntries(MOMENTS.map((m) => [m, {
    n: 0, both: 0, ahead: 0, behind: 0, sameN: 0, sameBoth: 0,
  }])),
  error: Object.fromEntries(TYPES.map((t) => [t, Object.fromEntries(POINTS.map((p) => [p, []]))])),
  greenPit: Object.fromEntries(GREEN_PIT.map((t) => [t, []])),
}]));
const totals = blank();
const laneRows = [];
const sectorRows = [];
let nStops = 0;
let skippedMoments = 0;
let skippedPoints = 0;

for (const race of races) {
  const lapTimes = loadRace(race.file);
  const by = index(lapTimes);
  const events = eventTimes(lapTimes);
  const memo = memoOf(lapTimes);
  const stops = estimatePitLoss(lapTimes).samples.filter((s) => {
    const laps = by.get(s.driver);
    return laps.get(s.inLap - 1)?.Time && laps.get(s.inLap + 1)?.Time
      && Number.isFinite(pitInSeconds(laps.get(s.inLap))) && Number.isFinite(pitOutSeconds(laps.get(s.inLap + 1)));
  });
  nStops += stops.length;

  for (const s of stops) {
    const laps = by.get(s.driver);
    const tPrev = laps.get(s.inLap - 1).Time;
    const pin = pitInSeconds(laps.get(s.inLap));
    const pout = pitOutSeconds(laps.get(s.inLap + 1));
    const tEnd = laps.get(s.inLap + 1).Time;
    for (const anchor of ANCHORS) {
      const T = totals[anchor];
      T.held[PHASES[0]].push(heldSeconds(memo, events, anchor, s.driver, tPrev, pin));
      T.held[PHASES[1]].push(heldSeconds(memo, events, anchor, s.driver, pin, pout));
      T.held[PHASES[2]].push(heldSeconds(memo, events, anchor, s.driver, pout, tEnd));
      const { st } = memo(anchor, tEnd - EPS);
      const car = st.cars.find((c) => c.driver === s.driver);
      if (car) {
        const p = phaseAt(car, tEnd - EPS, st.refLap);
        T.arrival.push({ phase: p.phase, jump: (1 - p.phase) * st.refLap.seconds, held: p.saturated });
      }
      const times = [pin + 1, pout + 1, (pout + tEnd) / 2];
      times.forEach((t, i) => {
        const fresh = circleState(lapTimes, { sessionNow: t, outLapAnchor: anchor });
        const w = pitWindow(s.driver, fresh, estimatePitLoss(lapTimes, { sessionNow: t }));
        if (!w.available || !w.ongoingStop) {
          skippedMoments += 1;
          return;
        }
        const rank = rankNeighbours(w);
        const all = ringNeighbours(fresh, s.driver, w.rejoinPhase, false);
        const same = ringNeighbours(fresh, s.driver, w.rejoinPhase, true);
        const c = T.neighbours[MOMENTS[i]];
        c.n += 1;
        if (all?.ahead === rank.ahead) c.ahead += 1;
        if (all?.behind === rank.behind) c.behind += 1;
        if (all?.ahead === rank.ahead && all?.behind === rank.behind) c.both += 1;
        c.sameN += 1;
        if (same?.ahead === rank.ahead && same?.behind === rank.behind) c.sameBoth += 1;
      });
    }
  }

  // Accuracy at the timing points
  for (const [driver, laps] of by) {
    for (const [n, row] of laps) {
      if (n < 2) continue;
      const type = lapType(row);
      const points = [
        ['S1', row.Sector1SessionTime], ['S2', row.Sector2SessionTime], ['line', Number.isFinite(row.Time) ? row.Time - EPS : null],
      ];
      for (const [point, t] of points) {
        if (!Number.isFinite(t)) continue;
        for (const anchor of ANCHORS) {
          const { st, fr } = memo(anchor, t);
          const car = st.cars.find((c) => c.driver === driver);
          const ref = st.refLap.seconds;
          if (!fr || !car || car.finished || car.lapsCompleted !== n - 1 || !(ref > 0)) {
            skippedPoints += 1;
            continue;
          }
          const want = point === 'S1' ? fr.f1 : point === 'S2' ? fr.f12 : 1;
          const err = (phaseAt(car, t, st.refLap).phase - want) * ref;
          totals[anchor].error[type][point].push(err);
          if (GREEN_PIT.includes(type) && String(row.TrackStatus) === '1') totals[anchor].greenPit[type].push(err);
        }
      }
    }
  }

  const lane = laneStats(lapTimes, Infinity);
  laneRows.push(`${race.name.padEnd(9)} ${String(lane.n).padStart(4)}  ${f(lane.median).padStart(7)}`);
  const last = Math.max(...lapTimes.map((r) => Number(r.LapNumber)));
  for (const [label, now] of [['lap 5', leaderLapEndTime(lapTimes, 5) + 1], ['lap 20', leaderLapEndTime(lapTimes, 20) + 1], ['end', Infinity]]) {
    if (!Number.isFinite(now) && label !== 'end') continue;
    if (label === 'lap 20' && last < 20) continue;
    const { st } = memo('line', now);
    const fr = sectorFractions(lapTimes, st.refLap, now);
    const sh = sectorShares(lapTimes, st.refLap, now);
    const iqr = (v) => `[${f(percentile(v, 0.25), 3)}, ${f(percentile(v, 0.75), 3)}]`;
    sectorRows.push(`${race.name.padEnd(9)} ${label.padEnd(7)} `
      + (fr ? `${f(fr.f1, 3)} ${iqr(sh.s1)}  ${f(fr.f12, 3)} ${iqr(sh.s12)}  ${String(fr.n).padStart(3)}  laps ${fr.laps.join('-')}`
        : `none (${sh.s1.length} laps)`));
  }
}

const report = [];
const r = (line = '') => report.push(line);
const dist = (v) => `median ${f(percentile(v, 0.5))}  p90 ${f(percentile(v, 0.9))}  max ${f(v.length ? Math.max(...v) : null)}`;
r('Circle of Doom ring check (frontend/scripts/cod_ring_check.mjs)');
r(`cache: backend/data/processed_cache, ${races.length} race sessions, ${nStops} green stops`);
r('');
r('Seconds a stopping car is drawn held at 0.999 (all stops; share = stops held at all):');
for (const p of PHASES) {
  for (const a of ANCHORS) {
    const v = totals[a].held[p];
    r(`  ${p.padEnd(24)} ${a.padEnd(8)} share ${pct(v.filter((x) => x > 0).length, v.length).padStart(6)}  ${dist(v)}`);
  }
}
r('');
r('Arrival on the line (drawn phase 1 ms before the out-lap ends; jump = (1 - phase) x refLap, s):');
for (const a of ANCHORS) {
  const v = totals[a].arrival;
  const ph = v.map((x) => x.phase);
  r(`  ${a.padEnd(8)} phase p10 ${f(percentile(ph, 0.1), 3)}  median ${f(percentile(ph, 0.5), 3)}  p90 ${f(percentile(ph, 0.9), 3)}  `
    + `held at 0.999 ${pct(v.filter((x) => x.held).length, v.length)}  jump ${dist(v.map((x) => x.jump))}`);
}
r('');
r('Rejoin marker of the stop under way: nearest drawn cars ahead / behind it = the rank\'s neighbours');
r('(the last rival across the target lap before predictedCrossing / the first after it):');
for (const m of MOMENTS) {
  for (const a of ANCHORS) {
    const c = totals[a].neighbours[m];
    r(`  ${m.padEnd(34)} ${a.padEnd(8)} n ${String(c.n).padStart(4)}  both ${pct(c.both, c.n).padStart(6)}  `
      + `ahead ${pct(c.ahead, c.n).padStart(6)}  behind ${pct(c.behind, c.n).padStart(6)}  both, cars on the focus's lap only ${pct(c.sameBoth, c.sameN).padStart(6)}`);
  }
}
r(`  moments without a stop-under-way window (not available, or the stop not under way): ${skippedMoments}`);
r('');
r('Pit-lane time at the end of each race (laneStats: PitOutTime - PitInTime, s):');
r('race         n   median');
for (const line of laneRows) r(line);
r('');
r('Sector fractions (share of the lap time; [IQR] of the per-lap shares; n laps; the reference lap window):');
r('race      at      f1    [IQR]           f12   [IQR]           n');
for (const line of sectorRows) r(line);
r('');
r('Accuracy: drawn phase - causal sector fraction at each timing point, seconds (x refLap):');
r('type           point  anchor        n   median |err|  p90 |err|  median signed');
for (const t of TYPES) {
  for (const p of POINTS) {
    for (const a of ANCHORS) {
      const v = totals[a].error[t][p];
      const abs = v.map(Math.abs);
      r(`${t.padEnd(14)} ${p.padEnd(6)} ${a.padEnd(8)} ${String(v.length).padStart(6)}  ${f(percentile(abs, 0.5)).padStart(12)}  `
        + `${f(percentile(abs, 0.9)).padStart(9)}  ${f(percentile(v, 0.5)).padStart(13)}`);
    }
  }
}
for (const t of TYPES) {
  for (const a of ANCHORS) {
    const v = POINTS.flatMap((p) => totals[a].error[t][p]);
    r(`${t.padEnd(14)} all    ${a.padEnd(8)} ${String(v.length).padStart(6)}  ${f(percentile(v.map(Math.abs), 0.5)).padStart(12)}  `
      + `${f(percentile(v.map(Math.abs), 0.9)).padStart(9)}  ${f(percentile(v, 0.5)).padStart(13)}`);
  }
}
for (const t of GREEN_PIT) {
  for (const a of ANCHORS) {
    const v = totals[a].greenPit[t];
    r(`${`${t}, green`.padEnd(14)} all    ${a.padEnd(8)} ${String(v.length).padStart(6)}  ${f(percentile(v.map(Math.abs), 0.5)).padStart(12)}  `
      + `${f(percentile(v.map(Math.abs), 0.9)).padStart(9)}  ${f(percentile(v, 0.5)).padStart(13)}`);
  }
}
r(`  timing points left out (no sector fractions yet, car not on the circle or finished, lap count off): ${skippedPoints}`);

const text = report.join('\n');
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, `${text}\n`);
console.log(text);
