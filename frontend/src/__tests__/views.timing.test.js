// Per-driver timing views, decision R6 (and R2/R3 where a view counts stops or
// shows a tyre): every view helper picks each driver's rows with
// utils/driverState.js, so at a session time it shows only what had happened.
//
// Two kinds of proof on the cached Monza 2024 (R16), skipped when absent:
//  - counterfactual: everything a lap row holds that is NOT known at `now`
//    (perturbUnknown below) is changed; every helper must give the same output;
//  - named instants of the D4 verdict: replay frames 3194 (LEC 0.68 s before his
//    pit entry at 4628.772) and 3398 (PIA, entry 4710.16), lap mode at lap 16,
//    and TSU's retirement in the pits (pit entry 3983.674).
// The components themselves are also server-rendered from the store at those
// instants (zustand's server snapshot made the live state), so the wiring of
// each view to its helper is checked too.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import TimingTower from '../components/visualizations/TimingTower.jsx';
import LapTimeChart from '../components/visualizations/LapTimeChart.jsx';
import SectorsPanel from '../components/visualizations/SectorsPanel.jsx';
import SectorDeltaWaterfall from '../components/visualizations/SectorDeltaWaterfall.jsx';
import ConsistencyPanel from '../components/visualizations/ConsistencyPanel.jsx';
import Leaderboard from '../components/visualizations/Leaderboard.jsx';
import TrackMap from '../components/visualizations/TrackMap.jsx';
import RacePaceGrid from '../components/visualizations/RacePaceGrid.jsx';
import PositionByLap from '../components/visualizations/PositionByLap.jsx';
import RaceControlPanel from '../components/visualizations/RaceControlPanel.jsx';
import TelemetryStrip from '../components/visualizations/TelemetryStrip.jsx';
import PitWallSectorPanel from '../components/ui/PitWallSectorPanel.jsx';
import FocusDriverWidget from '../components/ui/FocusDriverWidget.jsx';
import { timingTowerEntries } from '../utils/views/timingTower.js';
import { lapTimingSheet } from '../utils/views/lapTimeChart.js';
import { sectorsPanelData } from '../utils/views/sectorsPanel.js';
import { sectorDeltaRows, runningOrderAt } from '../utils/views/sectorDeltaWaterfall.js';
import { consistencyStats } from '../utils/views/consistencyPanel.js';
import { raceStandings } from '../utils/views/leaderboard.js';
import { trackMapDriverStatus } from '../utils/views/trackMap.js';
import { paceGridData, paceCell } from '../utils/views/racePaceGrid.js';
import { positionPitMarkers } from '../utils/views/positionByLap.js';
import {
  telemetryReferenceLap, telemetryTargets, telemetryCards, truncateToNow, recordedExtent, inDomain,
} from '../utils/views/telemetryStrip.js';
import { cumulativeLapTimes } from '../utils/views/lapDeltaChart.js';
import { pitWallSectorData } from '../utils/views/pitWallSectorPanel.js';
import { mfdTyreInfo } from '../utils/views/driverMFDCard.js';
import { focusDriverStatus } from '../utils/views/focusDriverWidget.js';
import { useF1Store, weatherAtSessionTime } from '../store/useF1Store.js';
import {
  computeSessionTimeOffset, resolveSessionNow, isLapCompleted, lapStartTime,
  hasPitOut, pitInSeconds, pitOutSeconds,
} from '../utils/raceTime.js';
import { pitStops } from '../utils/stints.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames, CACHE_DIR,
} from './helpers/cachedSession.js';

// Server rendering reads zustand's server snapshot, which is the INITIAL state;
// make it the live state so renderToString sees the store as the app does.
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal();
  const { createStore } = await import('zustand/vanilla');
  return {
    ...actual,
    create: (createState) => {
      const api = createStore(createState);
      api.getServerState = api.getState;
      return actual.create(api);
    },
  };
});

const SPEEDS = ['SpeedI1', 'SpeedI2', 'SpeedFL', 'SpeedST'];

/**
 * Counterfactual rows: every field NOT known at session time `now` is changed
 * (R3, R6). Known at now: a completed row in full; on a lap in progress its
 * start, its sectors already run (SectorNSessionTime <= now), a pit entry or
 * exit already passed, and its tyre fields unless it is an out-lap whose pit
 * exit has not passed (the new set is not known before the exit). Lap end
 * times stay after now, so no row changes from running to completed.
 */
function perturbUnknown(lapTimes, now) {
  const firstLap = new Map();
  for (const lt of lapTimes) {
    const n = Number(lt.LapNumber);
    if (!firstLap.has(lt.Driver) || n < firstLap.get(lt.Driver)) firstLap.set(lt.Driver, n);
  }
  return lapTimes.map((lt) => {
    if (isLapCompleted(lt, now)) return lt;
    const start = lapStartTime(lt);
    const started = start != null && start <= now;
    const later = Math.max(now + 1, Number(lt.Time) || 0);
    const out = {
      ...lt,
      Time: later + 5,
      LapTimeSeconds: (lt.LapTimeSeconds || 90) + 37,
      Position: 20,
      GapToLeader: 99,
      IntervalToAhead: 99,
      TrackStatus: '4',
    };
    for (const k of [1, 2, 3]) {
      const at = lt[`Sector${k}SessionTime`];
      if (!(started && at != null && at <= now)) {
        out[`Sector${k}TimeSeconds`] = (lt[`Sector${k}TimeSeconds`] || 30) + 11;
        out[`Sector${k}SessionTime`] = later + k;
      }
    }
    for (const key of SPEEDS) out[key] = 123;
    const pitIn = pitInSeconds(lt);
    if (!(started && pitIn != null && pitIn <= now)) {
      const fake = pitIn != null ? null : later + 2;
      out.PitInTimeSeconds = fake;
      out.PitInTime = fake;
    }
    const pitOut = pitOutSeconds(lt);
    const exited = started && pitOut != null && pitOut <= now;
    if (!exited) {
      // A lap begun in the pit lane (its in-lap's pit entry is known) still
      // has an exit to come: only its time is unknown. A lap begun on track
      // cannot gain one. A lap not started yet may or may not have one.
      let fake;
      if (started) fake = pitOut != null ? later + 3 : null;
      else fake = pitOut != null ? null : later + 3;
      out.PitOutTimeSeconds = fake;
      out.PitOutTime = fake;
    }
    const tyresKnown = started && (!hasPitOut(lt) || exited || Number(lt.LapNumber) === firstLap.get(lt.Driver));
    if (!tyresKnown) {
      out.Compound = 'SOFT';
      out.Stint = 99;
      out.TyreLife = 77;
    }
    return out;
  });
}

/** dnfMap exactly as the store builds it from race_results (final result). */
function buildDnfMap(session) {
  let maxLap = 1;
  for (const lt of session.lap_times) if (lt.LapNumber > maxLap) maxLap = lt.LapNumber;
  const map = {};
  for (const r of session.race_results || []) {
    const cp = String(r.ClassifiedPosition || '');
    if (['R', 'D', 'E', 'W', 'N'].includes(cp)) {
      map[r.Abbreviation] = { status: r.Status || 'Retired', lastLap: r.Laps || maxLap, classifiedPosition: cp };
    }
  }
  return map;
}

function gridOf(session) {
  const grid = {};
  for (const r of session.race_results || []) if (r.GridPosition > 0) grid[r.Abbreviation] = r.GridPosition;
  return grid;
}

/** Every per-driver view helper at `now`, as plain data. */
function allViews(lapTimes, now, { dnfMap, grid, weather, replayActive, maxLap }) {
  const drivers = [...new Set(lapTimes.map((r) => r.Driver))].sort();
  const pace = paceGridData(lapTimes, now, { dnfMap });
  const cells = {};
  for (const d of drivers) {
    for (let lap = 1; lap <= maxLap; lap++) {
      cells[`${d}_${lap}`] = paceCell(pace, d, lap, { currentLap: maxLap, replayActive, sessionNow: now });
    }
  }
  const perDriver = {};
  for (const d of drivers) {
    perDriver[d] = {
      pitWall: pitWallSectorData(lapTimes, d, now, { replayActive, dnfMap }),
      mfd: mfdTyreInfo(lapTimes, d, now),
      focus: focusDriverStatus(lapTimes, d, now),
      ref: telemetryReferenceLap(lapTimes, d, now, { replayActive }),
    };
  }
  const targets = telemetryTargets(lapTimes, now, {
    mode: 'laps', focusDriver: 'LEC', compareLaps: [5, 10, 14, 15, 16, 22], replayActive,
  });
  const driverTargets = telemetryTargets(lapTimes, now, {
    mode: 'drivers', selectedDrivers: ['LEC', 'PIA', 'HAM', 'TSU'], replayActive,
  });
  return {
    tower: timingTowerEntries(lapTimes, now, { dnfMap, replayActive, gridPositions: grid }),
    sheet: lapTimingSheet(lapTimes, now, { dnfMap, replayActive }),
    sheetBrushed: lapTimingSheet(lapTimes, now, { dnfMap, replayActive, brushLapRange: [10, 15] }),
    sectors: sectorsPanelData(lapTimes, now, { dnfMap, replayActive }),
    waterfall: [sectorDeltaRows(lapTimes, 'LEC', 'PIA', now), sectorDeltaRows(lapTimes, 'HAM', 'NOR', now)],
    order: runningOrderAt(lapTimes, now),
    consistency: consistencyStats(lapTimes, now),
    standings: raceStandings(lapTimes, now, { dnfMap, gridPositions: grid }),
    trackMap: trackMapDriverStatus(lapTimes, now, dnfMap),
    paceCells: cells,
    pacePitCounts: pace.pitCounts,
    pitMarkers: positionPitMarkers(lapTimes, now),
    perDriver,
    telemetry: {
      targets, driverTargets,
      cards: telemetryCards(lapTimes, weather, targets, now),
      driverCards: telemetryCards(lapTimes, weather, driverTargets, now),
    },
  };
}

const ROW = (rows, key, driver) => rows.find((r) => r[key] === driver);

/** Path and values of the first difference between two plain values, or null. */
function firstDiff(a, b, path = '') {
  if (Object.is(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

describe('perturbUnknown (test helper)', () => {
  it('keeps completed rows and the sectors already run, changes the rest', () => {
    const rows = [
      { Driver: 'AAA', LapNumber: 1, LapStartTime: 0, Time: 90, LapTimeSeconds: 90, Stint: 1, Compound: 'M', TyreLife: 1,
        Sector1SessionTime: 30, Sector2SessionTime: 60, Sector3SessionTime: 90, Sector1TimeSeconds: 30, Sector2TimeSeconds: 30, Sector3TimeSeconds: 30 },
      { Driver: 'AAA', LapNumber: 2, LapStartTime: 90, Time: 180, LapTimeSeconds: 90, Stint: 1, Compound: 'M', TyreLife: 2,
        Sector1SessionTime: 120, Sector2SessionTime: 150, Sector3SessionTime: 180, Sector1TimeSeconds: 30, Sector2TimeSeconds: 30, Sector3TimeSeconds: 30 },
    ];
    const p = perturbUnknown(rows, 130);
    expect(p[0]).toBe(rows[0]);
    expect([p[1].Sector1TimeSeconds, p[1].Sector2TimeSeconds, p[1].Sector3TimeSeconds]).toEqual([30, 41, 41]);
    expect([p[1].Compound, p[1].TyreLife, p[1].Position]).toEqual(['M', 2, 20]);
    expect(p[1].Time).toBeGreaterThan(130);
    expect(p[1].LapTimeSeconds).toBe(127);
  });
});

describe('truncateToNow (synthetic)', () => {
  it('keeps the samples recorded by now, everything at Infinity', () => {
    const s = [{ SessionTime: 10, Speed: 1 }, { SessionTime: 11, Speed: 2 }, { SessionTime: 12, Speed: 3 }];
    expect(truncateToNow(s, 11).map((d) => d.Speed)).toEqual([1, 2]);
    expect(truncateToNow(s, Infinity)).toBe(s);
    expect(truncateToNow(s, 9)).toEqual([]);
  });
});

const HAVE = hasCachedSession(2024, 16) && hasCachedFrames(2024, 16);

describe.skipIf(!HAVE)('per-driver timing views on cached Monza 2024 (R16)', () => {
  const session = HAVE ? loadCachedSession(2024, 16) : { lap_times: [] };
  const frames = HAVE ? loadCachedFrames(2024, 16).frames : [];
  const lapTimes = session.lap_times;
  const offset = computeSessionTimeOffset(lapTimes);
  const dnfMap = HAVE ? buildDnfMap(session) : {};
  const grid = HAVE ? gridOf(session) : {};
  const weather = session.weather_data;
  const maxLap = Math.max(1, ...lapTimes.map((r) => r.LapNumber));
  const frameNow = (i) => frames[i].t + offset;
  const views = (now, replayActive = true, rows = lapTimes) => allViews(rows, now, {
    dnfMap, grid, weather, replayActive, maxLap,
  });
  const json = (v) => JSON.stringify(v);

  it('the frames of the D4 verdict sit just before the pit entries', () => {
    expect(offset).toBeCloseTo(3350.494, 3);
    expect(frameNow(3194)).toBeCloseTo(4628.094, 3);
    expect(frameNow(3194)).toBeLessThan(4628.772); // LEC PitInTime
    expect(frameNow(3398)).toBeCloseTo(4709.694, 3);
    expect(frameNow(3398)).toBeLessThan(4710.16); // PIA PitInTime
  });

  it('counterfactual: no helper changes when the unknown future is changed (replay frames)', () => {
    const start = Math.min(...lapTimes.map((r) => r.LapStartTime));
    const end = Math.max(...lapTimes.map((r) => r.Time));
    const instants = [frameNow(3194), frameNow(3398), 3470.494, 3983.674 - 0.1, 3983.674, 4653.191 - 0.01, 4653.191];
    for (let k = 0; k <= 24; k++) instants.push(start + ((end - start) * k) / 24);
    for (const now of instants) {
      const real = views(now);
      const other = views(now, true, perturbUnknown(lapTimes, now));
      expect(firstDiff(JSON.parse(json(real)), JSON.parse(json(other))), `at ${now}`).toBeNull();
    }
  });

  it('counterfactual: no helper changes in lap mode (no frames, leader-lap clock)', () => {
    for (const lap of [2, 7, 8, 15, 16, 17, 30, 52]) {
      const now = resolveSessionNow({ currentLap: lap, maxLap, lapTimes, replayActive: false });
      const real = views(now, false);
      const other = views(now, false, perturbUnknown(lapTimes, now));
      expect(firstDiff(JSON.parse(json(real)), JSON.parse(json(other))), `lap ${lap}`).toBeNull();
    }
  });

  it('sensitivity: the same helpers do show LEC\'s new HARD set from his pit exit (4653.191)', () => {
    const v = views(4653.191);
    expect(ROW(v.tower, 'abbr', 'LEC').compound).toBe('HARD');
    expect(ROW(v.standings, 'abbr', 'LEC')).toMatchObject({ compound: 'HARD', pitStops: 1 });
    expect(v.trackMap.LEC.tyre).toBe(3);
    expect(v.perDriver.LEC.mfd).toEqual({ compound: 'HARD', tyreLife: 1 });
    expect(v.pitMarkers.some((m) => m.driver === 'LEC' && m.lap === 15)).toBe(true);
    // In the pit lane, after the entry and before the exit: still MEDIUM, "Pit"
    const pit = views(4640);
    expect(ROW(pit.tower, 'abbr', 'LEC')).toMatchObject({ compound: 'MEDIUM', statusLabel: 'Pit' });
    expect(ROW(pit.standings, 'abbr', 'LEC')).toMatchObject({ compound: 'MEDIUM', isPitting: true, pitStops: 0 });
  });

  it('frame 3194 (LEC 0.68 s before his pit entry): no view shows the HARD set or the slowed in-lap time', () => {
    const now = frameNow(3194);
    const v = views(now);
    const lecLines = [];
    const tower = ROW(v.tower, 'abbr', 'LEC');
    expect(tower).toMatchObject({ compound: 'MEDIUM', tyreLife: 15, lapNumber: 15, statusLabel: 'On Track', s3: null });
    expect(tower.lapTime).toBeCloseTo(85.606, 3); // lap 14, the last completed one
    const sheet = ROW(v.sheet.rows, 'driver', 'LEC');
    expect(sheet).toMatchObject({ compound: 'MEDIUM', tyreLife: 15, lap: 15, lapTime: null, s3: null, isPit: false });
    expect(ROW(v.sectors.liveRows, 'driver', 'LEC')).toMatchObject({ lap: 15, lapTime: null });
    expect(ROW(v.standings, 'abbr', 'LEC')).toMatchObject({ compound: 'MEDIUM', tyreLife: 15, isPitting: false, pitStops: 0 });
    expect(ROW(v.standings, 'abbr', 'LEC').lapTime).toBeCloseTo(85.606, 3);
    expect(v.trackMap.LEC).toMatchObject({ tyre: 2, tyreLife: 15, retired: false });
    expect(v.perDriver.LEC.mfd).toEqual({ compound: 'MEDIUM', tyreLife: 15 });
    expect(v.perDriver.LEC.focus).toEqual({ position: 2, compound: 'MEDIUM', tyreLife: 15 });
    expect(v.perDriver.LEC.pitWall).toMatchObject({ compound: 'MEDIUM', inProgress: true, lapNumber: 15, liveS3: null });
    expect(v.perDriver.LEC.pitWall.latest.LapNumber).toBe(14);
    expect(paceCell(paceGridData(lapTimes, now, { dnfMap }), 'LEC', 15, { currentLap: 16, replayActive: true, sessionNow: now }).style)
      .toBe('live-chrono');
    expect(v.telemetry.cards[0]).toMatchObject({ driver: 'LEC', lap: 15, compound: 'MEDIUM', tyreLife: 15, lapTime: null, s3: null });
    expect(v.pitMarkers.some((m) => m.driver === 'LEC')).toBe(false);
    // Nowhere: the in-lap's 90.192 s, its pit-lane S3 of 32.797 s, LEC on HARD
    const all = json(v);
    expect(all).not.toContain('90.192');
    expect(all).not.toContain('32.797');
    for (const part of [v.tower, v.sheet.rows, v.standings]) {
      for (const r of part) if ((r.abbr || r.driver) === 'LEC') lecLines.push(r.compound);
    }
    expect(lecLines).toEqual(['MEDIUM', 'MEDIUM', 'MEDIUM']);
  });

  it('frame 3398 (PIA 0.47 s before his pit entry): no in-lap time, no pit-lane S3, no HARD', () => {
    const now = frameNow(3398);
    const v = views(now);
    const tower = ROW(v.tower, 'abbr', 'PIA');
    expect(tower).toMatchObject({ compound: 'MEDIUM', tyreLife: 16, lapNumber: 16, s3: null, statusLabel: 'On Track' });
    expect(tower.lapTime).toBeCloseTo(85.166, 3); // lap 15
    expect(ROW(v.sheet.rows, 'driver', 'PIA')).toMatchObject({ compound: 'MEDIUM', lapTime: null, s3: null });
    expect(ROW(v.standings, 'abbr', 'PIA')).toMatchObject({ compound: 'MEDIUM', pitStops: 0, isPitting: false });
    expect(v.trackMap.PIA.tyre).toBe(2);
    // Waterfall: lap 16 is not over for PIA, so it is not compared
    expect(v.waterfall[0].map((r) => r.lap)).not.toContain(16);
    const all = json(v);
    expect(all).not.toContain('89.939'); // PIA in-lap time
    expect(all).not.toContain('32.769'); // PIA in-lap S3 (pit lane), ends at 4714.002
  });

  it('TSU (retired in the pits on lap 7) is not retired anywhere before 3983.674, and is after', () => {
    const retiredIn = (v) => ({
      tower: ROW(v.tower, 'abbr', 'TSU')?.isDnf,
      sheet: ROW(v.sheet.rows, 'driver', 'TSU')?.isRetired,
      sectorsLive: !ROW(v.sectors.liveRows, 'driver', 'TSU'),
      standings: ROW(v.standings, 'abbr', 'TSU')?.isRetired,
      trackMap: v.trackMap.TSU?.retired,
      paceRet: Object.entries(v.paceCells).some(([k, c]) => k.startsWith('TSU_') && c.style === 'dnf'),
    });
    const none = { tower: false, sheet: false, sectorsLive: false, standings: false, trackMap: false, paceRet: false };
    const all = { tower: true, sheet: true, sectorsLive: true, standings: true, trackMap: true, paceRet: true };
    for (const now of [3470.494, 3862.7, 3950, 3983.674 - 0.01]) {
      expect(retiredIn(views(now)), `at ${now}`).toEqual(none);
      expect(retiredIn(views(now, false)), `lap mode at ${now}`).toEqual(none);
    }
    for (const now of [3983.674, 3990, Infinity]) {
      expect(retiredIn(views(now)), `at ${now}`).toEqual(all);
    }
    // Lap mode: the leader starts lap 8 before TSU's pit entry; lap 9 after it
    const lap8 = resolveSessionNow({ currentLap: 8, maxLap, lapTimes, replayActive: false });
    const lap9 = resolveSessionNow({ currentLap: 9, maxLap, lapTimes, replayActive: false });
    expect(lap8).toBeLessThan(3983.674);
    expect(retiredIn(views(lap8, false))).toEqual(none);
    expect(lap9).toBeGreaterThan(3983.674);
    expect(retiredIn(views(lap9, false))).toEqual(all);
  });

  it('lap mode at lap 16 (now 4624.029): last completed laps in full, no running lap, old sets', () => {
    const now = resolveSessionNow({ currentLap: 16, maxLap, lapTimes, replayActive: false });
    expect(now).toBeCloseTo(4624.029, 3);
    const v = views(now, false);
    // PIA has just started his in-lap 16: the tower shows his lap 15
    expect(ROW(v.tower, 'abbr', 'PIA')).toMatchObject({ lapNumber: 15, compound: 'MEDIUM', lapChrono: null });
    expect(ROW(v.tower, 'abbr', 'PIA').lapTime).toBeCloseTo(85.166, 3);
    // LEC (stop on lap 15, HARD from 4653.191) is on his MEDIUM set
    expect(ROW(v.sheet.rows, 'driver', 'LEC')).toMatchObject({ lap: 14, compound: 'MEDIUM' });
    expect(ROW(v.sheet.rows, 'driver', 'LEC').lapTime).toBeCloseTo(85.606, 3);
    expect(ROW(v.sheet.rows, 'driver', 'HAM')).toMatchObject({ compound: 'MEDIUM' });
    const all = json(v);
    expect(all).not.toContain('89.939');
    expect(all).not.toContain('90.192');
    expect(all).not.toContain('90.365'); // HAM in-lap 15
  });

  it('order, pit counts and bests: race order from the last line crossing, stops = pitStops (R2)', () => {
    for (const now of [3500, frameNow(3194), 5000, 6000, Infinity]) {
      const v = views(now);
      const counts = {};
      for (const s of pitStops(lapTimes, { sessionNow: now })) counts[s.Driver] = (counts[s.Driver] || 0) + 1;
      for (const r of v.standings) expect(r.pitStops, `${r.abbr} at ${now}`).toBe(counts[r.abbr] || 0);
      expect(v.pacePitCounts).toEqual(counts);
      expect(v.pitMarkers.length).toBe(Object.values(counts).reduce((a, b) => a + b, 0));
      // The active drivers of the tower and of the standings are in the same order
      const active = (rows, key, flag) => rows.filter((r) => !r[flag]).map((r) => r[key]);
      expect(active(v.tower, 'abbr', 'isDnf')).toEqual(active(v.standings, 'abbr', 'isRetired'));
      // Bests from completed laps only: the fastest-lap holder has a completed lap of that time
      const fl = v.sheet.bests.fastestLapDriver;
      if (fl) {
        expect(lapTimes.some((r) => r.Driver === fl && isLapCompleted(r, now)
          && Math.abs(r.LapTimeSeconds - v.sheet.bests.bestLap) < 1e-9)).toBe(true);
      }
    }
    // At the end of the race the order is the finishing order of the classified drivers
    const end = views(Infinity).standings.filter((r) => !r.isRetired).map((r) => r.abbr);
    const classified = (session.race_results || [])
      .filter((r) => /^\d+$/.test(String(r.ClassifiedPosition)))
      .sort((a, b) => Number(a.ClassifiedPosition) - Number(b.ClassifiedPosition))
      .map((r) => r.Abbreviation);
    expect(end.slice(0, 3)).toEqual(classified.slice(0, 3));
  });

  it('LapDeltaChart: cumulative times from completed laps only (frame 3194; round 2)', () => {
    const now = 4628.094; // LEC 0.68 s before his pit entry; his lap 15 ends at 4632.468
    const real = cumulativeLapTimes(lapTimes, now);
    const changed = cumulativeLapTimes(perturbUnknown(lapTimes, now), now);
    expect(changed).toEqual(real);
    expect(real.LEC.map((d) => d.lap)).not.toContain(15);
    expect(Math.max(...real.LEC.map((d) => d.lap))).toBe(14);
    for (const [drv, arr] of Object.entries(real)) {
      for (const d of arr) {
        const row = lapTimes.find((r) => r.Driver === drv && r.LapNumber === d.lap);
        expect(isLapCompleted(row, now)).toBe(true);
      }
    }
  });

  it.skipIf(!fs.existsSync(path.join(CACHE_DIR, 'telemetry_2024_16_R_PIA_16.json')))('TelemetryStrip: a running lap never sets an axis with samples after now (round 2)', () => {
    const tel = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'telemetry_2024_16_R_PIA_16.json'), 'utf8')).telemetry;
    const now = 4654; // PIA's lap 16 runs 4624.029 - 4713.968
    const limit = recordedExtent(tel, now);
    const recorded = tel.filter((d) => d.SessionTime <= now);
    expect(limit).toBe(recorded[recorded.length - 1].Distance);
    expect(limit).toBeLessThan(tel[tel.length - 1].Distance);
    const trace = { domainLimit: limit };
    const used = tel.filter((d) => inDomain(trace, d));
    expect(used.every((d) => d.SessionTime <= now)).toBe(true);
    expect(used.length).toBe(recorded.length);
    // time axis: the time run so far, not the lap time still to come
    expect(recordedExtent(tel, now, 'time')).toBeCloseTo(recorded[recorded.length - 1].Time, 6);
    expect(recordedExtent(tel, 4000)).toBe(-Infinity); // before the lap: nothing recorded
    expect(inDomain({ domainLimit: null }, tel[tel.length - 1])).toBe(true); // completed lap: all
  });

  it('TelemetryStrip: comparison laps clamped to completed laps, weather in force at each lap', () => {
    const lap18 = resolveSessionNow({ currentLap: 18, maxLap, lapTimes, replayActive: false });
    // Lap mode, lap 18 (4801.893): PIA, P4 after his lap-16 stop, has completed 16
    // laps (his lap 17 ends at 4818.218). The brushed 10-25 picks are [10, 14, 18, 22]
    // (the verdict's case): 18 and 22 are neither fetched nor drawn.
    expect(lap18).toBeCloseTo(4801.893, 3);
    const t = telemetryTargets(lapTimes, lap18, { mode: 'laps', focusDriver: 'PIA', compareLaps: [10, 14, 18, 22] });
    expect(t).toEqual([
      { driver: 'PIA', lap: 16, inProgress: false },
      { driver: 'PIA', lap: 10, inProgress: false },
      { driver: 'PIA', lap: 14, inProgress: false },
    ]);
    // Replay frames: the lap in progress (17) is the reference, 18 and 22 are not fetched
    const r = telemetryTargets(lapTimes, lap18, { mode: 'laps', focusDriver: 'PIA', compareLaps: [10, 14, 18, 22], replayActive: true });
    expect(r.map((x) => x.lap)).toEqual([17, 10, 14]);
    expect(r[0].inProgress).toBe(true);
    // Drivers mode: each driver's own lap, never the leader's lap number for a lapped car
    const d = telemetryTargets(lapTimes, frameNow(3194), { mode: 'drivers', selectedDrivers: ['PIA', 'LEC'], replayActive: true });
    expect(d).toEqual([{ driver: 'PIA', lap: 16, inProgress: true }, { driver: 'LEC', lap: 15, inProgress: true }]);
    // Weather: the reading in force at each lap's start, not the pre-race reading
    const cards = telemetryCards(lapTimes, weather, [{ driver: 'PIA', lap: 30 }, { driver: 'PIA', lap: 5 }], Infinity);
    for (const [i, lap] of [[0, 30], [1, 5]]) {
      const row = lapTimes.find((x) => x.Driver === 'PIA' && x.LapNumber === lap);
      const w = weatherAtSessionTime(weather, row.LapStartTime);
      expect(w.Time).toBeLessThanOrEqual(row.LapStartTime);
      expect(w.Time).toBeGreaterThan(weather[0].Time);
      expect([cards[i].airTemp, cards[i].trackTemp]).toEqual([w.AirTemp, w.TrackTemp]);
    }
    // Best sectors from completed laps only: at frame 3194 LEC's bests ignore his laps 15+
    const [card] = telemetryCards(lapTimes, weather, [{ driver: 'LEC', lap: 14 }], frameNow(3194));
    const done = lapTimes.filter((x) => x.Driver === 'LEC' && x.LapNumber <= 14);
    expect(card.bestS3).toBeCloseTo(Math.min(...done.map((x) => x.Sector3TimeSeconds).filter((x) => x > 0)), 6);
  });

  it('ConsistencyPanel: pit laps leave the sample causally, averages from completed laps', () => {
    const before = consistencyStats(lapTimes, frameNow(3194));
    const lecBefore = before.drivers.find((x) => x.driver === 'LEC');
    // LEC laps 1-14 completed, no pit lap among them: at most 14 laps, lap 1 included
    expect(lecBefore.lap_count).toBeLessThanOrEqual(14);
    const after = consistencyStats(lapTimes, 4740); // LEC in-lap 15 and out-lap 16 completed
    const lecAfter = after.drivers.find((x) => x.driver === 'LEC');
    // The in-lap and the out-lap are completed but left out: same sample as before
    expect(lecAfter.sample_size + lecAfter.outliers).toBe(lecBefore.sample_size + lecBefore.outliers);
    expect(after.minLapsThreshold).toBe(Math.max(3, Math.floor(16 * 0.75)));
  });
});

describe.skipIf(!HAVE)('the timing components render only what is known (Monza 2024, server render)', () => {
  const session = HAVE ? loadCachedSession(2024, 16) : { lap_times: [] };
  const framesPayload = HAVE ? loadCachedFrames(2024, 16) : { frames: [] };
  const offset = computeSessionTimeOffset(session.lap_times);
  const dnfMap = HAVE ? buildDnfMap(session) : {};
  const maxLap = Math.max(1, ...session.lap_times.map((r) => r.LapNumber));
  const COMPONENTS = {
    TimingTower, LapTimeChart, SectorsPanel, SectorDeltaWaterfall, ConsistencyPanel, Leaderboard,
    RacePaceGrid, PitWallSectorPanel, FocusDriverWidget, TelemetryStrip, TrackMap, PositionByLap,
  };

  /** Store at replay frame i (or lap mode at `lap`) with these lap rows; every component rendered. */
  function renderAll(lapTimes, { frame = null, lap = null } = {}) {
    const frames = framesPayload.frames;
    const base = {
      sessionData: { ...session, lap_times: lapTimes },
      drivers: session.driver_info,
      dnfMap,
      sessionType: 'R',
      isLiveMode: false,
      isQualifyingReplay: false,
      sessionTimeOffset: offset,
      maxLap,
      focusDriver: 'LEC',
      selectedDrivers: ['LEC', 'PIA'],
      highlightedDriver: null,
      comparisonDriver: 'PIA',
      telemetryCompareMode: 'drivers',
      telemetryCompareLaps: [],
      telemetryCache: {},
      brushLapRange: null,
      selectedLapRange: null,
      lstmPredictions: null,
      raceProjection: null,
      rivalContext: [],
    };
    if (frame != null) {
      const fr = frames[frame];
      const leaderLap = Math.max(...Object.values(fr.drivers).map((d) => d.lap || 0));
      useF1Store.setState({
        ...base,
        frameData: framesPayload,
        totalFrames: frames.length,
        currentFrameIndex: frame,
        currentTime: fr.t,
        currentLap: leaderLap,
        maxTime: framesPayload.max_time,
        frameDt: frames[1].t - frames[0].t,
      });
    } else {
      useF1Store.setState({
        ...base, frameData: null, totalFrames: 0, currentFrameIndex: 0, currentTime: 0, currentLap: lap,
      });
    }
    const out = {};
    for (const [name, C] of Object.entries(COMPONENTS)) out[name] = renderToString(React.createElement(C));
    return out;
  }

  const sessionNowOfStore = () => useF1Store.getState().getSessionNow();
  // Title of a driver's tyre dot in the rendered tower ('COMPOUND - Lap age')
  const towerTyre = (html, drv) => (/title="([^"]*)"/.exec(html.slice(html.indexOf(`>${drv}<`))) || [])[1];

  it('frame 3194 / 3398: identical HTML when the unknown future is changed; no HARD for LEC, no in-lap times', () => {
    for (const frame of [3194, 3398]) {
      const real = renderAll(session.lap_times, { frame });
      const now = sessionNowOfStore();
      expect(now).toBeCloseTo(framesPayload.frames[frame].t + offset, 6);
      const other = renderAll(perturbUnknown(session.lap_times, now), { frame });
      for (const name of Object.keys(COMPONENTS)) {
        expect(other[name], `${name} at frame ${frame}`).toBe(real[name]);
      }
      // Not vacuous: every view but the D3-only position chart renders driver data
      for (const name of Object.keys(COMPONENTS)) {
        if (name !== 'PositionByLap') expect(real[name], name).toMatch(/LEC|LECLERC|Leclerc/);
      }
      const html = Object.values(real).join('');
      // PIA's in-lap 16 (time and pit-lane S3) is still running at both frames
      expect(html).not.toContain('1:29.939');
      expect(html).not.toContain('32.769');
      if (frame === 3194) {
        // LEC's in-lap 15 ends at 4632.468, after frame 3194
        expect(html).not.toContain('1:30.192');
        expect(html).not.toContain('90.192');
        // LEC's tyre dot in the tower: the MEDIUM set, 15 laps old
        expect(towerTyre(real.TimingTower, 'LEC')).toBe('MEDIUM - Lap 15');
      }
    }
  });

  it('lap mode at lap 16: identical HTML when the unknown future is changed, PIA in-lap time not shown', () => {
    const real = renderAll(session.lap_times, { lap: 16 });
    const now = sessionNowOfStore();
    expect(now).toBeCloseTo(4624.029, 3);
    const other = renderAll(perturbUnknown(session.lap_times, now), { lap: 16 });
    for (const name of Object.keys(COMPONENTS)) expect(other[name], name).toBe(real[name]);
    const html = Object.values(real).join('');
    expect(html).not.toContain('1:29.939');
    // LEC shows his lap 14 in full; his set is in its 15th lap (lap 15 has started)
    expect(towerTyre(real.TimingTower, 'LEC')).toBe('MEDIUM - Lap 15');
  });

  it('the winner appears once the leader has taken the chequered flag, not when he starts the last lap', () => {
    const frames = framesPayload.frames;
    const chequered = Math.min(...session.lap_times.filter((r) => r.LapNumber === maxLap).map((r) => r.Time));
    const lastLapFrame = frames.findIndex((f) => Object.values(f.drivers).some((d) => d.lap === maxLap));
    const flagFrame = frames.findIndex((f) => f.t + offset >= chequered);
    expect(frames[lastLapFrame].t + offset).toBeLessThan(chequered);
    const onLastLap = renderAll(session.lap_times, { frame: lastLapFrame + 10 });
    expect(useF1Store.getState().currentLap).toBe(maxLap);
    expect(onLastLap.Leaderboard).not.toContain('CHEQUERED FLAG');
    expect(onLastLap.Leaderboard).not.toContain(' WINS');
    const finished = renderAll(session.lap_times, { frame: flagFrame + 1 });
    expect(finished.Leaderboard).toContain('CHEQUERED FLAG');
  });

  it('TSU: not shown retired in the tower before his pit entry (3983.674), shown after', () => {
    const frames = framesPayload.frames;
    const frameAt = (t) => frames.findIndex((f) => f.t + offset >= t);
    const before = renderAll(session.lap_times, { frame: 300 }); // lap 2, 3470.494
    expect(sessionNowOfStore()).toBeCloseTo(3470.494, 3);
    const lastBefore = renderAll(session.lap_times, { frame: frameAt(3983.674) - 1 });
    const after = renderAll(session.lap_times, { frame: frameAt(3983.674) + 1 });
    const towerStatus = (html) => (/title="([^"]*)"[^>]*><\/span><\/td><\/tr>/.exec(
      html.slice(html.indexOf('>TSU<')),
    ) || [])[1];
    expect(towerStatus(before.TimingTower)).not.toBe('Retired');
    expect(towerStatus(lastBefore.TimingTower)).not.toBe('Retired');
    expect(towerStatus(after.TimingTower)).toBe('Retired');
  });

  it('after the winner takes the flag, before the last car finishes: winner from the rows, no final points (round 2)', () => {
    const frames = framesPayload.frames;
    const chequered = session.lap_times.find((r) => r.LapNumber === maxLap && r.Position === 1).Time;
    const raceEnd = Math.max(...session.lap_times.map((r) => r.Time).filter(Number.isFinite));
    const frame = frames.findIndex((f) => f.t + offset >= (chequered + raceEnd) / 2);
    expect(frame).toBeGreaterThan(0);
    const real = renderAll(session.lap_times, { frame });
    expect(real.Leaderboard).toContain('CHEQUERED FLAG');
    expect(real.TrackMap).toContain('CHARLES LECLERC');
    expect(real.Leaderboard).not.toContain('tower-row__points-badge');
    // the final classification (race_results Position / Points) is not known
    // yet: changing it changes nothing on screen
    const saved = session.race_results;
    let alt;
    try {
      session.race_results = saved.map((r) => ({
        ...r,
        Position: Number.isFinite(r.Position) ? 21 - r.Position : r.Position,
        Points: Number.isFinite(r.Points) ? r.Points + 1 : r.Points,
      }));
      alt = renderAll(session.lap_times, { frame });
    } finally {
      session.race_results = saved;
    }
    expect(alt.Leaderboard).toBe(real.Leaderboard);
    expect(alt.TrackMap).toBe(real.TrackMap);
    // race over (the replay's end): the official points
    expect(renderAll(session.lap_times, { frame: frames.length - 1 }).Leaderboard).toContain('tower-row__points-badge');
  });

  it('TSU 1 s after his pit entry: the retirement lap comes from the rows, not race_results Laps (round 2)', () => {
    const frames = framesPayload.frames;
    const frame = frames.findIndex((f) => f.t + offset >= 3983.674 + 1);
    const render = () => ({
      ...renderAll(session.lap_times, { frame }),
      RaceControlPanel: renderToString(React.createElement(RaceControlPanel)),
    });
    const real = render();
    // race_results Laps (dnfMap lastLap) is a final result, known only once
    // TSU's final row (the in-lap, still running) has ended: change it
    const saved = dnfMap.TSU.lastLap;
    let alt;
    try {
      dnfMap.TSU.lastLap = saved + 1;
      alt = render();
    } finally {
      dnfMap.TSU.lastLap = saved;
    }
    for (const name of ['Leaderboard', 'RacePaceGrid', 'RaceControlPanel']) {
      expect(alt[name], name).toBe(real[name]);
    }
    // retired on lap 7 (the in-lap into the pits), known at the pit entry
    expect(real.Leaderboard).toMatch(/Retired<span[^>]*>L(<!-- -->)?7</);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2024 R17 (Baku): PER and SAI stopped on lap 50 after their collision. Their
// lap-50 rows end at 8718.092 / 8721.891 s with no Position and no lap time
// (the truncated lap of a car that stopped). Ranking on those rows put PER at
// the head of the tower from 8718 s while PIA, the leader, was still on lap
// 50 (it ends at 8800.013). Round 2.
describe.skipIf(!hasCachedSession(2024, 17))('a car that stopped on track does not lead (2024 R17, round 2)', () => {
  const baku = hasCachedSession(2024, 17) ? loadCachedSession(2024, 17) : { lap_times: [] };
  const lt = baku.lap_times;
  const dnfMap = hasCachedSession(2024, 17) ? buildDnfMap(baku) : {};
  const order = (rows) => rows.map((r) => r.abbr);

  it('the truncated rows are what the data says', () => {
    for (const drv of ['PER', 'SAI']) {
      const r = lt.find((x) => x.Driver === drv && x.LapNumber === 50);
      expect(r.Position ?? null).toBeNull();
      expect(r.LapTimeSeconds ?? null).toBeNull();
      expect(r.Time).toBeLessThan(8725);
    }
  });

  it('tower and standings at 8725 / 8805 s: PER and SAI behind the cars still racing', () => {
    for (const now of [8725, 8805]) {
      for (const list of [
        order(raceStandings(lt, now, { dnfMap })),
        order(timingTowerEntries(lt, now, { dnfMap, replayActive: true })),
      ]) {
        expect(list.indexOf('PIA'), `${now}`).toBeLessThan(list.indexOf('PER'));
        expect(list.indexOf('LEC'), `${now}`).toBeLessThan(list.indexOf('PER'));
        expect(list.indexOf('PIA'), `${now}`).toBeLessThan(list.indexOf('SAI'));
        expect(list[0], `${now}`).not.toBe('PER');
      }
    }
    // the race over: PIA wins, as the classification says
    expect(order(raceStandings(lt, Infinity, { dnfMap }))[0]).toBe('PIA');
  });
});
