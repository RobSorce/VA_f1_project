// Test helper (Phase 9c, D4 / D5 / D6): what the chart tests mount the D3
// views with, so they run without the git-ignored race cache:
//  - installResizeObserverMock(): a ResizeObserver the test drives (notify an
//    element of its new content box) and a requestAnimationFrame queue the
//    test flushes, as utils/views/chartBox.js useChartBox throttles to one
//    measure per frame. Install it AFTER d3 is imported: d3-timer picks its
//    frame source at import, and d3 transitions must keep their own timer;
//  - syntheticSession(): a deterministic 20-lap race of 8 drivers (lap and
//    sector times, positions, one pit stop each, MEDIUM then HARD), a round
//    circuit (sectors, corners, a DRS zone) and the championship standings.
//
// Pure data and test doubles; no React, no store.

/**
 * A ResizeObserver whose notifications the test sends, and a frame queue.
 *
 * @returns {{
 *   notify: (el: Element, width: number, height: number) => number,
 *   watched: (el: Element) => boolean,
 *   observerCount: () => number,
 *   pendingFrames: () => number,
 *   flushFrames: () => number,
 *   uninstall: () => void,
 * }}
 */
export function installResizeObserverMock() {
  const observers = new Set();
  const prev = {
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const entryOf = (el, width, height) => ({
    target: el,
    contentRect: { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height },
  });
  // As a browser does, observe() reports the element's size once, at the
  // next rendering step (here: the next flushFrames), when it is not 0 x 0
  let initial = [];
  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.els = new Set();
      observers.add(this);
    }

    observe(el) {
      this.els.add(el);
      initial.push([this, el]);
    }

    unobserve(el) { this.els.delete(el); }

    disconnect() {
      this.els.clear();
      observers.delete(this);
    }
  }
  const deliverInitial = () => {
    const batch = initial;
    initial = [];
    for (const [o, el] of batch) {
      if (!observers.has(o) || !o.els.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) o.cb([entryOf(el, r.width, r.height)], o);
    }
    return batch.length;
  };
  let frames = new Map();
  let nextId = 1;
  globalThis.ResizeObserver = MockResizeObserver;
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextId++;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
  return {
    /** Send `el`'s new content box to every observer of it; returns how many observers got it. */
    notify(el, width, height) {
      let n = 0;
      for (const o of [...observers]) {
        if (!o.els.has(el)) continue;
        n += 1;
        o.cb([entryOf(el, width, height)], o);
      }
      return n;
    },
    watched: (el) => [...observers].some((o) => o.els.has(el)),
    observerCount: () => observers.size,
    pendingFrames: () => frames.size,
    /** Deliver the first observations and run the queued frames (and those they queue); returns the frames run. */
    flushFrames() {
      let ran = 0;
      for (let guard = 0; guard < 20 && (frames.size > 0 || initial.length > 0); guard++) {
        deliverInitial();
        const batch = [...frames.values()];
        frames = new Map();
        for (const fn of batch) {
          ran += 1;
          fn(Date.now());
        }
      }
      return ran;
    },
    uninstall() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
    },
  };
}

// ── A synthetic race ──────────────────────────────────────────────────

export const SYNTH_DRIVERS = [
  { abbr: 'VER', number: '1', name: 'Max Verstappen', team: 'Red Bull Racing', color: '#3671C6', pace: 0.0 },
  { abbr: 'PER', number: '11', name: 'Sergio Perez', team: 'Red Bull Racing', color: '#3671C6', pace: 0.55 },
  { abbr: 'NOR', number: '4', name: 'Lando Norris', team: 'McLaren', color: '#FF8000', pace: 0.1 },
  { abbr: 'PIA', number: '81', name: 'Oscar Piastri', team: 'McLaren', color: '#FF8000', pace: 0.2 },
  { abbr: 'LEC', number: '16', name: 'Charles Leclerc', team: 'Ferrari', color: '#E80020', pace: 0.15 },
  { abbr: 'SAI', number: '55', name: 'Carlos Sainz', team: 'Ferrari', color: '#E80020', pace: 0.3 },
  { abbr: 'HAM', number: '44', name: 'Lewis Hamilton', team: 'Mercedes', color: '#27F4D2', pace: 0.35 },
  { abbr: 'RUS', number: '63', name: 'George Russell', team: 'Mercedes', color: '#27F4D2', pace: 0.45 },
];

const r3 = (v) => Math.round(v * 1000) / 1000;

/** A round circuit of `n` points (X / Y in metres, Sector 1-3 by thirds). */
export function syntheticCircuit(n = 120) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({
      X: r3(1200 * Math.cos(a)), Y: r3(800 * Math.sin(a)), Distance: r3((5000 * i) / n), Sector: 1 + Math.floor((3 * i) / n),
    });
  }
  const corners = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85].map((f, i) => {
    const p = pts[Math.floor(f * n)];
    return { X: p.X * 1.05, Y: p.Y * 1.05, Number: i + 1, Letter: '', Angle: 0, Distance: p.Distance };
  });
  return {
    name: 'Synthetic Grand Prix', country: 'Nowhere', location: 'Test', circuit_name: 'Synthetic Ring',
    event_name: 'Synthetic Grand Prix',
    track_coordinates: pts,
    drs_zones: [{ start_idx: Math.floor(n * 0.05), end_idx: Math.floor(n * 0.2), detection_idx: Math.floor(n * 0.02) }],
    corners,
    marshal_lights: [],
    rotation: 0,
  };
}

/**
 * A deterministic race: `laps` laps of SYNTH_DRIVERS, each driver pitting
 * once (MEDIUM then HARD), positions from the race time.
 *
 * @param {number} [laps=20]
 * @returns {Object} the GET /api/session payload shape
 */
export function syntheticSession(laps = 20) {
  const START = 3000;
  const rows = [];
  const clock = Object.fromEntries(SYNTH_DRIVERS.map((d, i) => [d.abbr, START + i * 0.3]));
  for (let lap = 1; lap <= laps; lap++) {
    const lapRows = [];
    SYNTH_DRIVERS.forEach((d, i) => {
      const pitLap = 8 + (i % 4);
      const stint = lap <= pitLap ? 1 : 2;
      const compound = stint === 1 ? 'MEDIUM' : 'HARD';
      const tyreLife = stint === 1 ? lap : lap - pitLap;
      const wobble = ((i * 7 + lap * 13) % 10) / 20;
      let lapTime = 82 + d.pace + wobble + 0.06 * tyreLife + (lap === 1 ? 4 : 0);
      if (lap === pitLap) lapTime += 4;
      if (lap === pitLap + 1) lapTime += 18;
      lapTime = r3(lapTime);
      const start = r3(clock[d.abbr]);
      const s1 = r3(lapTime * 0.33);
      const s2 = r3(lapTime * 0.36);
      const s3 = r3(lapTime - s1 - s2);
      const end = r3(start + lapTime);
      clock[d.abbr] = end;
      lapRows.push({
        Time: end, Driver: d.abbr, DriverNumber: d.number, LapTime: lapTime, LapNumber: lap, Stint: stint,
        PitOutTime: null, PitInTime: null,
        PitInTimeSeconds: lap === pitLap ? r3(end - 2) : null,
        PitOutTimeSeconds: lap === pitLap + 1 ? r3(start + 20) : null,
        Sector1Time: s1, Sector2Time: s2, Sector3Time: s3,
        Sector1SessionTime: r3(start + s1), Sector2SessionTime: r3(start + s1 + s2), Sector3SessionTime: end,
        SpeedI1: 300 - i, SpeedI2: 290 - i, SpeedFL: 280 - i, SpeedST: 320 - i,
        IsPersonalBest: false, Compound: compound, TyreLife: tyreLife, FreshTyre: tyreLife === 1, Team: d.team,
        LapStartTime: start, TrackStatus: '1', Position: null, Deleted: false, DeletedReason: '',
        FastF1Generated: false, IsAccurate: true,
        LapTimeSeconds: lapTime, Sector1TimeSeconds: s1, Sector2TimeSeconds: s2, Sector3TimeSeconds: s3,
      });
    });
    lapRows.sort((a, b) => a.Time - b.Time).forEach((row, k) => {
      row.Position = k + 1;
      row.GapToLeader = r3(row.Time - lapRows[0].Time);
      row.IntervalToAhead = k === 0 ? 0 : r3(row.Time - lapRows[k - 1].Time);
    });
    rows.push(...lapRows);
  }
  const finalRows = rows.filter((r) => r.LapNumber === laps).sort((a, b) => a.Position - b.Position);
  const driverInfo = SYNTH_DRIVERS.map((d) => ({
    DriverNumber: d.number, Abbreviation: d.abbr, FullName: d.name, TeamName: d.team, TeamColor: d.color,
  }));
  const raceResults = SYNTH_DRIVERS.map((d, i) => ({
    DriverNumber: d.number, Abbreviation: d.abbr, FullName: d.name, TeamName: d.team, TeamColor: d.color.slice(1),
    GridPosition: i + 1, Position: finalRows.findIndex((r) => r.Driver === d.abbr) + 1, Status: 'Finished', Points: 0,
  }));
  const tyreStrategy = SYNTH_DRIVERS.flatMap((d, i) => {
    const pitLap = 8 + (i % 4);
    return [
      { Driver: d.abbr, StintNumber: 1, Compound: 'MEDIUM', StartLap: 1, EndLap: pitLap, TotalLaps: pitLap },
      { Driver: d.abbr, StintNumber: 2, Compound: 'HARD', StartLap: pitLap + 1, EndLap: laps, TotalLaps: laps - pitLap },
    ];
  });
  return {
    lap_times: rows,
    circuit_info: syntheticCircuit(),
    driver_info: driverInfo,
    race_results: raceResults,
    weather_data: [],
    tyre_strategy: tyreStrategy,
    track_status: [{ Time: START, Status: '1', Message: 'AllClear' }],
  };
}

/** Championship standings after `rounds` rounds (GET /api/championship shape). */
export function syntheticChampionship(rounds = 6) {
  const pts = [25, 18, 15, 12, 10, 8, 6, 4];
  const drivers = SYNTH_DRIVERS.map((d, i) => {
    let cum = 0;
    const progression = [];
    for (let r = 1; r <= rounds; r++) {
      const place = (i + r) % SYNTH_DRIVERS.length;
      const points = pts[place];
      cum += points;
      progression.push({ round: r, points, sprint_points: 0, cumulative: cum, position: 0 });
    }
    return {
      abbr: d.abbr, name: d.name, team: d.team, teamColor: d.color, countryCode: 'GBR', totalPoints: cum, progression,
    };
  }).sort((a, b) => b.totalPoints - a.totalPoints);
  drivers.forEach((d, i) => { d.position = i + 1; });
  const teams = [...new Set(SYNTH_DRIVERS.map((d) => d.team))];
  const constructors = teams.map((team) => {
    const mine = drivers.filter((d) => d.team === team);
    const progression = [];
    for (let r = 1; r <= rounds; r++) {
      const cumulative = mine.reduce((s, d) => s + d.progression[r - 1].cumulative, 0);
      const points = mine.reduce((s, d) => s + d.progression[r - 1].points, 0);
      progression.push({ round: r, points, cumulative, position: 0 });
    }
    return { team, teamColor: SYNTH_DRIVERS.find((d) => d.team === team).color, totalPoints: progression.at(-1).cumulative, progression };
  }).sort((a, b) => b.totalPoints - a.totalPoints);
  constructors.forEach((c, i) => { c.position = i + 1; });
  return {
    year: 2024, cache_version: 1, total_rounds: rounds + 4, completed_rounds: rounds,
    missing_rounds: [], missing_sprint_rounds: [], drivers, constructors,
  };
}
