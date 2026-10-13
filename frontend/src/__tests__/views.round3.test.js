// Round 3 of the Phase 3 fixes (R6, R8 and the D2 / D4 verdicts), on the
// cached sessions (skipped when absent):
//  - D4 problem 1: a driver classified on distance who stopped before the
//    flag (2024 R3 RUS, 2024 R17 PER / SAI / STR, ...) is retired in every
//    per-driver view once the final row has ended, never before, and leaves
//    the running order; qualifying and practice never infer a retirement;
//  - D4 problem 2: the TelemetryStrip reveal clip of a running lap follows the
//    lap's own samples recorded by now (revealPoint), not the car's position;
//  - D4 problem 3: the qualifying replay views (Leaderboard, DriverMFDCard,
//    FocusDriverWidget, LapTimeChart badges) show only laps completed by now,
//    never the final classification;
//  - D2 problem 3: track-status bands sit on the timeline's lap axis.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import TimingTower from '../components/visualizations/TimingTower.jsx';
import LapTimeChart from '../components/visualizations/LapTimeChart.jsx';
import Leaderboard from '../components/visualizations/Leaderboard.jsx';
import RaceControlPanel from '../components/visualizations/RaceControlPanel.jsx';
import DriverMFDCard from '../components/ui/DriverMFDCard.jsx';
import FocusDriverWidget from '../components/ui/FocusDriverWidget.jsx';
import { timingTowerEntries } from '../utils/views/timingTower.js';
import { lapTimingSheet, qualiSegmentBadges } from '../utils/views/lapTimeChart.js';
import { sectorsPanelData } from '../utils/views/sectorsPanel.js';
import { raceStandings, qualifyingStandings } from '../utils/views/leaderboard.js';
import { trackMapDriverStatus } from '../utils/views/trackMap.js';
import { paceGridData } from '../utils/views/racePaceGrid.js';
import { pitWallSectorData } from '../utils/views/pitWallSectorPanel.js';
import { qualifyingPositionAt } from '../utils/views/focusDriverWidget.js';
import { revealPoint, recordedExtent } from '../utils/views/telemetryStrip.js';
import { buildTrackStatusEvents, trackStatusBandLaps } from '../hooks/useReplayEngine.js';
import { useF1Store, qualiSegmentOffsets } from '../store/useF1Store.js';
import { computeSessionTimeOffset, isLapCompleted, mapTrackStatusToLaps } from '../utils/raceTime.js';
import { driverStateAt, nonFinisherMap, qualifyingOrder } from '../utils/driverState.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames, listCachedRaces, CACHE_DIR,
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

/** store.dnfMap as loadSession builds it (ClassifiedPosition R/D/E/W/N). */
function buildDnfMap(session) {
  const map = {};
  for (const r of session.race_results || []) {
    const cp = String(r.ClassifiedPosition || '');
    if (['R', 'D', 'E', 'W', 'N'].includes(cp)) {
      map[r.Abbreviation] = { status: r.Status || 'Retired', lastLap: r.Laps, classifiedPosition: cp };
    }
  }
  return map;
}

/**
 * Counterfactual rows: everything a row holds that is NOT known at `now` is
 * changed (R6). A completed row is known in full; a lap in progress keeps its
 * start, the sectors already run and the tyre set it runs on (the set's age
 * at the lap start); a lap not started yet is changed in full. Lap ends stay
 * after now, so no row changes from running to completed.
 */
function perturbUnknown(lapTimes, now) {
  return lapTimes.map((lt) => {
    if (isLapCompleted(lt, now)) return lt;
    const started = lt.LapStartTime != null && lt.LapStartTime <= now;
    // (qualifying rows carry no Position: none is invented)
    const out = {
      ...lt, LapTimeSeconds: (lt.LapTimeSeconds || 90) + 37, GapToLeader: 99,
      Position: lt.Position == null ? lt.Position : 20,
    };
    for (const k of [1, 2, 3]) {
      if (started && lt[`Sector${k}SessionTime`] != null && lt[`Sector${k}SessionTime`] <= now) continue;
      out[`Sector${k}TimeSeconds`] = (lt[`Sector${k}TimeSeconds`] || 30) + 5;
    }
    if (!started) Object.assign(out, { Compound: 'HARD', TyreLife: 77, Stint: 99 });
    return out;
  });
}

/** A driver's final lap row. */
function finalRow(lapTimes, drv) {
  return lapTimes.filter((r) => r.Driver === drv).reduce((a, b) => (b.LapNumber > a.LapNumber ? b : a));
}

/** The end of a driver's racing: final row end, or its pit entry for a retirement in the pits. */
function stopTime(row) {
  return row.PitInTimeSeconds ?? row.Time;
}

// ─────────────────────────────────────────────────────────────────────────
describe('D4 problem 1: classified drivers who stopped before the flag are retired (R6)', () => {
  it.skipIf(!hasCachedSession(2024, 3))('2024 R3 RUS (crash on lap 57, classified 17th): retired from 8227.786, behind the cars still racing', () => {
    const s = loadCachedSession(2024, 3);
    const lt = s.lap_times;
    const dnfMap = buildDnfMap(s);
    expect(dnfMap.RUS).toBeUndefined(); // classified: not a results DNF
    expect(nonFinisherMap(lt, dnfMap).RUS).toEqual({ status: 'Retired', inferred: true });
    const end = finalRow(lt, 'RUS').Time;
    expect(end).toBeCloseTo(8227.786, 3);
    const order = (rows) => rows.map((r) => r.abbr);
    const isOut = (rows) => rows.find((r) => r.abbr === 'RUS');

    // just before: on track in every view
    const before = end - 0.5;
    expect(isOut(timingTowerEntries(lt, before, { dnfMap, replayActive: true })).isDnf).toBe(false);
    expect(isOut(raceStandings(lt, before, { dnfMap })).isRetired).toBe(false);

    for (const now of [8232.8, 8257.8, 8336.8]) {
      const tower = timingTowerEntries(lt, now, { dnfMap, replayActive: true });
      const standings = raceStandings(lt, now, { dnfMap });
      expect(isOut(tower).isDnf, `${now}`).toBe(true);
      expect(isOut(tower).statusLabel).toBe('Retired');
      expect(isOut(standings).isRetired).toBe(true);
      expect(isOut(standings).retiredLap).toBe(57);
      // behind STR, TSU and HUL, who complete lap 57 only after 8309 s
      for (const list of [order(tower), order(standings)]) {
        for (const drv of ['STR', 'TSU', 'HUL']) {
          expect(list.indexOf(drv), `${now} ${drv}`).toBeLessThan(list.indexOf('RUS'));
        }
      }
      expect(trackMapDriverStatus(lt, now, dnfMap).RUS.retired).toBe(true);
      expect(paceGridData(lt, now, { dnfMap }).state.RUS.dnf).toEqual({ status: 'Retired', lastLap: 56 });
      expect(sectorsPanelData(lt, now, { dnfMap }).liveRows.some((r) => r.driver === 'RUS' || r.abbr === 'RUS'))
        .toBe(false);
      expect(lapTimingSheet(lt, now, { dnfMap }).rows.find((r) => r.driver === 'RUS').retiredStatus).toBe('Retired');
      expect(pitWallSectorData(lt, 'RUS', now, { dnfMap, replayActive: true }).inProgress).toBe(false);
    }
  });

  it('every cached race: the inferred non-finishers are retired from their stop, not before; finishers never', () => {
    const races = listCachedRaces();
    let inferred = 0;
    for (const { year, round } of races) {
      const s = loadCachedSession(year, round);
      const lt = s.lap_times;
      const dnfMap = buildDnfMap(s);
      const all = nonFinisherMap(lt, dnfMap);
      // every results DNF stays, every driver that took the flag is absent
      for (const d of Object.keys(dnfMap)) expect(all[d]).toBe(dnfMap[d]);
      for (const r of s.race_results || []) {
        if (/^(Finished|\+\d+ Laps?)$/.test(String(r.Status))) {
          expect(all[r.Abbreviation], `${year} R${round} ${r.Abbreviation}`).toBeUndefined();
        }
      }
      for (const [drv, info] of Object.entries(all)) {
        if (!info.inferred) continue;
        inferred++;
        const stop = stopTime(finalRow(lt, drv));
        const at = (now) => timingTowerEntries(lt, now, { dnfMap, replayActive: true }).find((e) => e.abbr === drv);
        expect(at(stop - 0.01)?.isDnf ?? false, `${year} R${round} ${drv} before`).toBe(false);
        expect(at(stop + 0.01).isDnf, `${year} R${round} ${drv} after`).toBe(true);
        expect(at(stop + 0.01).statusLabel).toBe('Retired');
        // retired, not shown in the pits forever
        expect(at(Infinity).statusLabel, `${year} R${round} ${drv} at the end`).toBe('Retired');
      }
    }
    if (races.some(({ year, round }) => year === 2024 && [3, 11, 17, 18, 24].includes(round))) {
      expect(inferred).toBeGreaterThan(0);
    }
  }, 120000);

  it.skipIf(!hasCachedSession(2024, 17))('2024 R17: PER and SAI retired 30 s after stopping, STR in the pits retired, not "Pit" forever', () => {
    const s = loadCachedSession(2024, 17);
    const lt = s.lap_times;
    const dnfMap = buildDnfMap(s);
    const tower = timingTowerEntries(lt, 8752, { dnfMap, replayActive: true });
    const byAbbr = Object.fromEntries(tower.map((e) => [e.abbr, e]));
    expect(byAbbr.PER.isDnf).toBe(true);
    expect(byAbbr.SAI.isDnf).toBe(true);
    const active = tower.filter((e) => !e.isDnf).length;
    expect(byAbbr.PER.pos).toBeGreaterThan(active);
    expect(byAbbr.SAI.pos).toBeGreaterThan(active);
    expect(byAbbr.STR.statusLabel).toBe('Retired');
    // RaceControlPanel lists them among the retirements
    useF1Store.setState({
      sessionData: s, trackStatus: s.track_status, dnfMap, isLiveMode: false, totalFrames: 0,
      currentLap: Math.max(...lt.map((r) => r.LapNumber)), lapModeRaceOver: true,
      sessionTimeOffset: computeSessionTimeOffset(lt), drivers: s.driver_info, raceControlMessages: [],
    });
    const html = renderToString(React.createElement(RaceControlPanel));
    for (const drv of ['PER', 'SAI', 'STR']) expect(html).toContain(`>${drv}<`);
  });

  it.skipIf(!hasCachedSession(2024, 8, 'Q'))('qualifying rows (no Position) never infer a retirement', () => {
    const q = loadCachedSession(2024, 8, 'Q');
    expect(nonFinisherMap(q.lap_times, {})).toEqual({});
    for (const drv of new Set(q.lap_times.map((r) => r.Driver))) {
      expect(driverStateAt(q.lap_times, drv, Infinity).retired).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
const PIA38 = path.join(CACHE_DIR, 'telemetry_2024_16_R_PIA_38.json');
const PIA39 = path.join(CACHE_DIR, 'telemetry_2024_16_R_PIA_39.json');
describe.skipIf(!(fs.existsSync(PIA38) && fs.existsSync(PIA39)))('D4 problem 2: the reveal clip follows the running lap\'s own samples', () => {
  const tel = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).telemetry;

  it('PIA lap 39 (out-lap, starts 6576.288): just after the line only the first metres are revealed', () => {
    const data = tel(PIA39);
    const start = data[0].SessionTime;
    expect(start).toBeCloseTo(6576.288, 3);
    for (const dt of [0.05, 0.4, 1, 1.9]) {
      const r = revealPoint(data, start + dt);
      expect(r.complete).toBe(false);
      // never past the first sample still to come
      const next = data.find((d) => d.SessionTime > start + dt);
      expect(r.x).toBeLessThanOrEqual(next.Distance);
      expect(r.x).toBeLessThan(100);
      expect(r.x).toBe(r.distance);
    }
    // before the lap: nothing; at its end or at Infinity: the whole lap
    expect(revealPoint(data, start - 1).x).toBe(-Infinity);
    expect(revealPoint(data, data[data.length - 1].SessionTime).complete).toBe(true);
    expect(revealPoint(data, Infinity).complete).toBe(true);
  });

  it('PIA lap 38 (in-lap, pit entry 6572.401): the pit-lane section is hidden until it is driven', () => {
    const data = tel(PIA38);
    const pitIn = 6572.401;
    const r = revealPoint(data, pitIn - 60);
    const pitSample = data.find((d) => d.SessionTime >= pitIn);
    expect(r.x).toBeLessThan(pitSample.Distance);
    // between the last sample recorded by now and the next one
    expect(r.x).toBeGreaterThanOrEqual(recordedExtent(data, pitIn - 60));
    expect(r.x).toBeLessThanOrEqual(data.find((d) => d.SessionTime > pitIn - 60).Distance);
  });

  it('causal: changing every sample after now leaves the reveal point unchanged; time mode is the lap time', () => {
    const data = tel(PIA39);
    const now = data[0].SessionTime + 30.25;
    const changed = data.map((d) => (d.SessionTime > now + 2 ? { ...d, Distance: d.Distance + 999, Speed: 1 } : d));
    expect(revealPoint(changed, now)).toEqual(revealPoint(data, now));
    const timeMode = data.map((d) => ({ ...d, Distance: d.Time, _origDistance: d.Distance }));
    const r = revealPoint(timeMode, now);
    expect(r.x).toBeCloseTo(30.25, 1);
    expect(r.distance).toBeCloseTo(revealPoint(data, now).x, 6);
  });

  it('samples without SessionTime: null (the caller keeps the old position fallback)', () => {
    expect(revealPoint([{ Distance: 1 }], 10)).toBeNull();
    expect(revealPoint([], 10)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
const HAVE_Q = hasCachedSession(2024, 8, 'Q') && hasCachedFrames(2024, 8, 'Q');
describe.skipIf(!HAVE_Q)('D4 problem 3: the qualifying replay shows only laps completed by now (2024 R8 Q)', () => {
  const q = HAVE_Q ? loadCachedSession(2024, 8, 'Q') : { lap_times: [], race_results: [] };
  const segments = HAVE_Q ? loadCachedFrames(2024, 8, 'Q').segments : {};
  const offsets = HAVE_Q ? qualiSegmentOffsets(q.lap_times, segments) : {};

  /** Store in the qualifying replay of `seg` at frame i, with these rows and results. */
  function qualiStore(seg, i, lapTimes = q.lap_times, raceResults = q.race_results) {
    const seg0 = segments[seg];
    useF1Store.setState({
      sessionData: { ...q, lap_times: lapTimes, race_results: raceResults },
      drivers: q.driver_info, dnfMap: {}, sessionType: 'Q', loadedSessionType: 'Q',
      isLiveMode: false, isQualifyingReplay: true, qualiSegments: segments, qualiSegment: seg,
      qualiSegmentOffsets: offsets, sessionTimeOffset: offsets[seg], frameData: seg0,
      totalFrames: seg0.frames.length, currentFrameIndex: i, currentTime: seg0.frames[i].t,
      currentLap: 1, maxLap: Math.max(...q.lap_times.map((r) => r.LapNumber)), maxTime: seg0.max_time,
      frameDt: seg0.frames[1].t - seg0.frames[0].t, lapModeRaceOver: false,
      focusDriver: 'VER', highlightedDriver: 'VER', selectedDrivers: [], brushLapRange: null,
      lstmPredictions: null, rivalContext: [],
    });
    return useF1Store.getState().getSessionNow();
  }
  const render = () => ({
    Leaderboard: renderToString(React.createElement(Leaderboard)),
    DriverMFDCard: renderToString(React.createElement(DriverMFDCard)),
    FocusDriverWidget: renderToString(React.createElement(FocusDriverWidget)),
    LapTimeChart: renderToString(React.createElement(LapTimeChart)),
    TimingTower: renderToString(React.createElement(TimingTower)),
  });
  const reversed = (results) => results.map((r) => ({
    ...r, Position: Number.isFinite(r.Position) ? 21 - r.Position : r.Position,
  }));

  it('Q1 frame 5 (1513.792): order and gaps of the best completed laps, as the timing tower', () => {
    const now = qualiStore('Q1', 5);
    expect(now).toBeCloseTo(1513.792, 3);
    const segDrivers = Object.keys(segments.Q1.driver_colors);
    const rows = qualifyingStandings(q.lap_times, now, { drivers: segDrivers });
    const tower = timingTowerEntries(q.lap_times, now, { qualifying: true, replayActive: true })
      .filter((e) => segDrivers.includes(e.abbr) && e._best !== Infinity);
    const timed = rows.filter((r) => r.bestLap != null);
    expect(timed.length).toBeGreaterThan(0);
    expect(timed.map((r) => r.abbr)).toEqual(qualifyingOrder(q.lap_times, now, { drivers: segDrivers })
      .filter((r) => r.best).map((r) => r.driver));
    // every time shown was completed by now
    for (const r of timed) {
      const row = q.lap_times.find((x) => x.Driver === r.abbr && x.LapTimeSeconds === r.bestLap);
      expect(row.Time).toBeLessThanOrEqual(now);
    }
    // not the final classification (LEC pole, PIA +0.154 from the Q3 laps)
    expect(rows[0].abbr).toBe(timingTowerEntries(q.lap_times, now, { qualifying: true, replayActive: true })[0].abbr);
    expect(rows[1]?.gapToLeader).not.toBe(0.154);
    expect(tower.length).toBeGreaterThanOrEqual(0);
  });

  it('counterfactual at Q1 frame 5, Q1 frame 600 and Q2 frame 300: future laps and the final classification change nothing on screen', () => {
    for (const [seg, i] of [['Q1', 5], ['Q1', 600], ['Q2', 300]]) {
      const now = qualiStore(seg, i);
      const real = render();
      // no lap that ends later is shown (VER's lap 27, 1:31.412, ends at 4309.8)
      expect(now).toBeLessThan(4309.8);
      expect(real.DriverMFDCard).not.toContain('1:31.412');
      const alt = (() => {
        qualiStore(seg, i, perturbUnknown(q.lap_times, now), reversed(q.race_results));
        return render();
      })();
      for (const name of Object.keys(real)) expect(alt[name], `${seg} ${i} ${name}`).toBe(real[name]);
    }
  });

  it('FocusDriverWidget: VER\'s rank by best completed lap, not the final P6', () => {
    const now = qualiStore('Q1', 600);
    const pos = qualifyingPositionAt(q.lap_times, 'VER', now);
    const order = qualifyingOrder(q.lap_times, now);
    expect(pos).toBe(order.find((r) => r.driver === 'VER').position);
    const html = renderToString(React.createElement(FocusDriverWidget));
    if (pos != null) expect(html).toMatch(new RegExp(`>P(<!-- -->)?${pos}<`));
    // nobody has a time before the session's first completed lap
    const first = Math.min(...q.lap_times.filter((r) => r.LapTimeSeconds > 0).map((r) => r.Time));
    expect(qualifyingPositionAt(q.lap_times, 'VER', first - 1)).toBeNull();
  });

  it('LapTimeChart segment badges: the furthest segment reached so far, the final result only at the end', () => {
    const final = qualiSegmentBadges({ raceResults: q.race_results, sessionNow: Infinity });
    const atQ1 = qualiSegmentBadges({ raceResults: q.race_results, segments, offsets, sessionNow: offsets.Q1 + 10 });
    expect(Object.keys(atQ1).length).toBe(Object.keys(segments.Q1.driver_colors).length);
    expect(new Set(Object.values(atQ1))).toEqual(new Set(['Q1']));
    // the final result is not read before the end: reversing it changes nothing
    expect(qualiSegmentBadges({ raceResults: reversed(q.race_results), segments, offsets, sessionNow: offsets.Q1 + 10 }))
      .toEqual(atQ1);
    const atQ2 = qualiSegmentBadges({ segments, offsets, sessionNow: offsets.Q2 + 10 });
    expect(Object.values(atQ2).filter((v) => v === 'Q2').length).toBe(Object.keys(segments.Q2.driver_colors).length);
    expect(Object.values(atQ2).includes('Q3')).toBe(false);
    const atQ3 = qualiSegmentBadges({ segments, offsets, sessionNow: offsets.Q3 + 10 });
    for (const drv of Object.keys(segments.Q3.driver_colors)) {
      expect(atQ3[drv]).toBe('Q3');
      expect(final[drv]).toBe('Q3');
    }
    // lap mode before the end (no segment clock): no badge
    expect(qualiSegmentBadges({ raceResults: q.race_results, sessionNow: 2000 })).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('D2 problem 3: track-status bands on the timeline\'s lap axis', () => {
  it('synthetic: start lap to end lap, half a lap at least, a running band ends on the leader lap', () => {
    expect(trackStatusBandLaps({ startLap: 22, endLap: 23 })).toEqual([22, 23]);
    expect(trackStatusBandLaps({ startLap: 1, endLap: 1 })).toEqual([1, 1.5]);
    expect(trackStatusBandLaps({ startLap: 22, endLap: 22, ongoing: true })).toEqual([22, 22]);
    expect(trackStatusBandLaps({ startLap: 57, endLap: 57 }, 57)).toEqual([57, 57]);
    // replay-time fractions never move a band
    expect(trackStatusBandLaps({ startLap: 1, endLap: 1, startTimeFraction: 0.01, endTimeFraction: 0.23 }))
      .toEqual([1, 1.5]);
  });

  it.skipIf(!(hasCachedFrames(2024, 8) && hasCachedSession(2024, 8)))('2024 R8: the red flag mapped to lap 1 is drawn on lap 1, not over laps 1.5-18.4', () => {
    const s = loadCachedSession(2024, 8);
    const frames = loadCachedFrames(2024, 8).frames;
    const maxLap = Math.max(...s.lap_times.map((r) => r.LapNumber));
    const ev = buildTrackStatusEvents({
      trackStatus: s.track_status, lapTimes: s.lap_times, frames, maxLap,
      sessionTimeOffset: computeSessionTimeOffset(s.lap_times),
    });
    const red = ev.filter((e) => e.type === 'RED_FLAG');
    expect(red.length).toBeGreaterThan(0);
    for (const e of red) {
      expect(e.endTimeFraction - e.startTimeFraction).toBeGreaterThan(0.02); // a long period
      const [from, to] = trackStatusBandLaps(e, maxLap);
      expect([from, to]).toEqual([e.startLap, Math.max(e.endLap, e.startLap + 0.5)]);
      expect(to).toBeLessThan(3);
    }
  });

  it.skipIf(!(hasCachedFrames(2024, 5) && hasCachedSession(2024, 5)))('2024 R5: the VSC band covers laps 22-23 (FIA: deployed lap 22), wherever its replay-time fraction falls', () => {
    const s = loadCachedSession(2024, 5);
    const frames = loadCachedFrames(2024, 5).frames;
    const maxLap = Math.max(...s.lap_times.map((r) => r.LapNumber));
    const offset = computeSessionTimeOffset(s.lap_times);
    const ev = buildTrackStatusEvents({ trackStatus: s.track_status, lapTimes: s.lap_times, frames, maxLap, sessionTimeOffset: offset });
    const vsc = ev.find((e) => e.type === 'VSC');
    expect(trackStatusBandLaps(vsc, maxLap)).toEqual([22, 23]);
    const mapped = mapTrackStatusToLaps(s.track_status, s.lap_times).filter((p) => ['6', '7'].includes(String(p.status)));
    expect([mapped[0].start_lap, mapped[0].end_lap]).toEqual([22, 23]);
    // while it runs (60 s after its start): from lap 22 to the leader's lap, where the progress fill ends
    const running = buildTrackStatusEvents({
      trackStatus: s.track_status, lapTimes: s.lap_times, frames, maxLap, sessionTimeOffset: offset,
      sessionNow: vsc.startTime + 60,
    }).find((e) => e.type === 'VSC');
    expect(running.ongoing).toBe(true);
    const [from, to] = trackStatusBandLaps(running, maxLap);
    expect(from).toBe(22);
    expect(to).toBe(running.endLap);
    expect(isLapCompleted({ Time: vsc.startTime }, vsc.startTime + 60)).toBe(true);
  });
});
