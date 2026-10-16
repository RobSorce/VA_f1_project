// Edge cases, view side (decisions R5, R6):
//  - TimelinePlayer flag bands use one axis, the lap axis;
//  - a classified driver who stopped before the flag is shown retired
//    by the Leaderboard from his stop (driverStateAt at the clock), never
//    before and never from the final classification;
//  - TelemetryStrip: a running lap's trace holds only the samples
//    recorded by now, the focus trace included (not a clip over the whole lap);
//  - qualifying replay Leaderboard ordered by the best lap completed at
//    the clock, never by the final results.
// Blocks on cached sessions skip when the cache is absent.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Leaderboard from '../components/visualizations/Leaderboard.jsx';
import { useF1Store, qualiSegmentOffsets } from '../store/useF1Store.js';
import { buildTrackStatusEvents, trackStatusBandLaps } from '../hooks/useReplayEngine.js';
import {
  computeSessionTimeOffset, lapWindows, leaderLapAt, leaderLapEndTime,
} from '../utils/raceTime.js';
import { nonFinisherMap, qualifyingOrder } from '../utils/driverState.js';
import { raceStandings, qualifyingStandings } from '../utils/views/leaderboard.js';
import { traceSamplesAt, telemetryTargets, revealPoint } from '../utils/views/telemetryStrip.js';
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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

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

/** The Leaderboard row of a driver in server-rendered HTML: its class list and markup. */
function leaderboardRow(html, abbr) {
  const starts = [...html.matchAll(/class="(tower-row(?: [^"]*)?)"/g)];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const chunk = html.slice(starts[i].index, end);
    if (chunk.includes(`>${abbr}<`)) return { classes: starts[i][1].split(' '), chunk };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
describe('TimelinePlayer flag bands on one axis (the lap axis)', () => {
  it('the band x comes from the period\'s leader laps (trackStatusBandLaps), never a replay-time fraction', () => {
    const src = source('components/ui/TimelinePlayer.jsx');
    const band = src.slice(src.indexOf('const bandX'), src.indexOf('const g = svg.append'));
    expect(band).toContain('trackStatusBandLaps(evt, maxLap)');
    expect(band).toContain('xScale(from)');
    expect(band).not.toMatch(/TimeFraction|innerWidth \*/);
    // the race timeline's x scale is the lap axis, and the bands are drawn with bandX
    expect(src).toMatch(/const xScale = d3\.scaleLinear\(\)\.domain\(\[1, maxLap\]\)/);
    const draw = src.slice(src.indexOf('for (const evt of segmentEvents)'), src.indexOf('// Lap tick marks'));
    expect(draw).toContain('bandX(evt)');
    expect(draw).not.toMatch(/TimeFraction/);
  });

  const withFrames = listCachedRaces().filter(({ year, round }) => hasCachedFrames(year, round));
  it.skipIf(withFrames.length === 0)(`every cached race with frames (${withFrames.length}): bands span the leader laps of the period`, () => {
    let bands = 0;
    for (const { year, round } of withFrames) {
      const s = loadCachedSession(year, round);
      const lt = s.lap_times;
      const maxLap = Math.max(...lt.map((r) => Number(r.LapNumber) || 0));
      const windows = lapWindows(lt);
      const raceStart = Math.min(...windows.map((w) => w[1]));
      const events = buildTrackStatusEvents({
        trackStatus: s.track_status, lapTimes: lt, frames: loadCachedFrames(year, round).frames, maxLap,
        sessionTimeOffset: computeSessionTimeOffset(lt), sessionNow: Infinity,
      });
      for (const e of events.filter((x) => ['SAFETY_CAR', 'VSC', 'RED_FLAG', 'YELLOW_FLAG'].includes(x.type))) {
        const [from, to] = trackStatusBandLaps(e, maxLap);
        const tag = `${year} R${round} ${e.type} ${e.startLap}-${e.endLap}`;
        expect([from, to], tag).toEqual([e.startLap, Math.min(maxLap, Math.max(e.endLap, e.startLap + 0.5))]);
        if (e.startTime > raceStart) expect(from, tag).toBe(leaderLapAt(windows, e.startTime));
        bands++;
      }
    }
    expect(bands).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('classified drivers who stopped before the flag are retired in the Leaderboard from their stop', () => {
  /** The store in replay at session time `now` on these frames. */
  function replayAt(session, frames, now) {
    const lt = session.lap_times;
    const offset = computeSessionTimeOffset(lt);
    let idx = frames.findIndex((f) => f.t + offset >= now);
    if (idx < 0) idx = frames.length - 1;
    useF1Store.setState({
      sessionData: session, drivers: session.driver_info, dnfMap: buildDnfMap(session), trackStatus: session.track_status,
      sessionType: 'R', loadedSessionType: 'R', isLiveMode: false, isQualifyingReplay: false,
      sessionTimeOffset: offset, frameData: { frames }, totalFrames: frames.length, currentFrameIndex: idx,
      currentTime: frames[idx].t, maxTime: frames[frames.length - 1].t, frameDt: 0.4,
      currentLap: Math.max(1, ...Object.values(frames[idx].drivers || {}).map((d) => d.lap || 0)),
      maxLap: Math.max(...lt.map((r) => Number(r.LapNumber) || 0)), lapModeRaceOver: false,
    });
    return useF1Store.getState().getSessionNow();
  }

  const races = listCachedRaces().filter(({ year, round }) => hasCachedFrames(year, round));
  it.skipIf(races.length === 0)('every cached race with frames: on track just before the stop, RET just after (Leaderboard render)', () => {
    let checked = 0;
    for (const { year, round } of races) {
      const s = loadCachedSession(year, round);
      const frames = loadCachedFrames(year, round).frames;
      const lt = s.lap_times;
      const dnfMap = buildDnfMap(s);
      const chequered = leaderLapEndTime(lt, Math.max(...lt.map((r) => Number(r.LapNumber) || 0)));
      for (const [drv, info] of Object.entries(nonFinisherMap(lt, dnfMap))) {
        if (!info.inferred) continue; // classified on distance, stopped before the flag
        const rows = lt.filter((r) => r.Driver === drv).sort((a, b) => a.LapNumber - b.LapNumber);
        const last = rows[rows.length - 1];
        const stop = last.PitInTimeSeconds ?? last.Time;
        expect(stop, `${year} R${round} ${drv}`).toBeLessThan(chequered);
        const offset = computeSessionTimeOffset(lt);
        if (stop - 2 < frames[1].t + offset || stop + 2 > frames[frames.length - 2].t + offset) continue;
        const nowBefore = replayAt(s, frames, stop - 2);
        expect(nowBefore).toBeLessThan(stop);
        const before = leaderboardRow(renderToString(React.createElement(Leaderboard)), drv);
        expect(before.classes, `${year} R${round} ${drv} before ${nowBefore}`).not.toContain('tower-row--retired');
        const nowAfter = replayAt(s, frames, stop + 2);
        expect(nowAfter).toBeGreaterThanOrEqual(stop);
        const after = leaderboardRow(renderToString(React.createElement(Leaderboard)), drv);
        expect(after.classes, `${year} R${round} ${drv} after ${nowAfter}`).toContain('tower-row--retired');
        expect(after.chunk).toContain('OUT');
        checked++;
      }
    }
    if (races.some(({ year, round }) => year === 2024 && round === 3)) expect(checked).toBeGreaterThan(0);
  }, 120000);

  it.skipIf(!hasCachedSession(2024, 3))('2024 R3 RUS: the retirement follows the clock, not the final classification', () => {
    const s = loadCachedSession(2024, 3);
    const lt = s.lap_times;
    const dnfMap = buildDnfMap(s);
    expect(dnfMap.RUS).toBeUndefined(); // classified 17th: not a results DNF
    const end = lt.filter((r) => r.Driver === 'RUS').reduce((a, b) => (b.LapNumber > a.LapNumber ? b : a)).Time;
    const at = (now, results) => raceStandings(lt, now, { dnfMap: buildDnfMap({ race_results: results }) })
      .find((r) => r.abbr === 'RUS');
    expect(at(end - 1, s.race_results).isRetired).toBe(false);
    expect(at(end + 1, s.race_results).isRetired).toBe(true);
    // a final classification that calls him a finisher, or a DNF, changes nothing before the stop
    const asDnf = s.race_results.map((r) => (r.Abbreviation === 'RUS' ? { ...r, ClassifiedPosition: 'R', Status: 'Accident' } : r));
    expect(at(end - 1, asDnf).isRetired).toBe(false);
    expect(at(end + 1, asDnf).isRetired).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe('live: a car still racing is never shown retired (feed rows, live now = Infinity)', () => {
  // The live feed delivers each completed lap row as it ends (session Time,
  // Position: backend/live/data_normalizer.py _complete_lap): after k
  // deliveries the store holds the k rows that ended first.
  for (const [year, round] of [[2024, 16], [2024, 3]]) {
    it.skipIf(!hasCachedSession(year, round))(`${year} R${round}: the feed so far, every 10th delivery (Leaderboard render and raceStandings)`, () => {
      const s = loadCachedSession(year, round);
      const all = s.lap_times.filter((r) => Number.isFinite(r.Time) && r.Driver)
        .sort((a, b) => a.Time - b.Time);
      let states = 0;
      let inferredWithoutFlag = 0;
      for (let k = 40; k <= all.length; k += 10) {
        const rows = all.slice(0, k);
        // the defect's mechanism: read as a final classification, the feed's
        // latest lap is taken for the chequered flag
        if (Object.keys(nonFinisherMap(rows, {})).length > 0) inferredWithoutFlag++;
        expect(nonFinisherMap(rows, {}, { live: true })).toEqual({});
        const st = raceStandings(rows, Infinity, { dnfMap: {}, isLiveMode: true });
        expect(st.filter((r) => r.isRetired).map((r) => r.abbr), `${year} R${round} k=${k}`).toEqual([]);
        states++;
      }
      expect(states).toBeGreaterThan(50);
      expect(inferredWithoutFlag).toBeGreaterThan(0);

      // the Leaderboard of a live store after 160 deliveries: no RET row
      const rows = all.slice(0, 160);
      const lastLap = Math.max(...rows.map((r) => r.LapNumber));
      useF1Store.setState({
        sessionData: { lap_times: rows, driver_info: s.driver_info, race_results: [] }, drivers: s.driver_info,
        dnfMap: {}, trackStatus: [], sessionType: 'R', loadedSessionType: 'R', isLiveMode: true,
        isQualifyingReplay: false, totalFrames: 0, frameData: null, currentFrameIndex: 0,
        currentLap: lastLap, maxLap: lastLap,
        totalRaceLaps: Math.max(...s.lap_times.map((r) => Number(r.LapNumber) || 0)), lapModeRaceOver: false,
      });
      const html = renderToString(React.createElement(Leaderboard));
      expect((html.match(/tower-row--retired/g) || []).length).toBe(0);
      expect((html.match(/class="tower-row(?: [^"]*)?"/g) || []).length).toBe(new Set(rows.map((r) => r.Driver)).size);
      // a retirement the feed reports is shown
      const out = rows[0].Driver;
      useF1Store.setState({ dnfMap: { [out]: { status: 'Retired' } } });
      const html2 = renderToString(React.createElement(Leaderboard));
      expect(leaderboardRow(html2, out).classes).toContain('tower-row--retired');
      expect((html2.match(/tower-row--retired/g) || []).length).toBe(1);
      useF1Store.setState({ isLiveMode: false, dnfMap: {} });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
describe('a running lap\'s telemetry trace holds only the samples recorded by now', () => {
  /** Synthetic lap: 100 samples, 1 s apart from session time 500, 10 m apart. */
  const LAP = Array.from({ length: 100 }, (_, i) => ({
    SessionTime: 500 + i, Time: i, Distance: i * 10, Speed: 200 + i,
  }));
  const cache = { 'AAA-7-R': LAP, 'AAA-6-R': LAP.map((d) => ({ ...d, SessionTime: d.SessionTime - 100 })) };

  it('synthetic: the running lap (focus trace included) is cut at now, a completed lap is whole; both axis modes', () => {
    for (const xAxisMode of ['distance', 'time']) {
      const [running, done] = traceSamplesAt(
        [{ driver: 'AAA', lap: 7, inProgress: true }, { driver: 'AAA', lap: 6, inProgress: false }],
        cache, { cacheKeySuffix: '-R', cutNow: 530.5, xAxisMode },
      );
      expect(running.data.every((d) => d.SessionTime <= 530.5)).toBe(true);
      expect(running.data).toHaveLength(31);
      expect(running.extent).toBe(xAxisMode === 'time' ? 30 : 300);
      expect(running.domainLimit).toBe(running.extent);
      expect(done.data).toHaveLength(100);
      expect(done.domainLimit).toBeNull();
      // the playhead's reveal point on the cut trace: its newest sample
      const r = revealPoint(running.data, 530.9);
      expect(r).toMatchObject({ complete: true, distance: 300 });
    }
    // nothing recorded yet: no trace; at Infinity: the whole lap
    expect(traceSamplesAt([{ driver: 'AAA', lap: 7, inProgress: true }], cache, { cacheKeySuffix: '-R', cutNow: 499 }))
      .toEqual([null]);
    expect(traceSamplesAt([{ driver: 'AAA', lap: 7, inProgress: true }], cache, { cacheKeySuffix: '-R', cutNow: Infinity })[0].data)
      .toHaveLength(100);
  });

  it('counterfactual: changing every sample after now leaves the trace unchanged', () => {
    const changed = { ...cache, 'AAA-7-R': LAP.map((d) => (d.SessionTime > 530.5 ? { ...d, Distance: 9e4, Speed: 1 } : d)) };
    const t = [{ driver: 'AAA', lap: 7, inProgress: true }];
    for (const xAxisMode of ['distance', 'time']) {
      expect(traceSamplesAt(t, changed, { cacheKeySuffix: '-R', cutNow: 530.5, xAxisMode }))
        .toEqual(traceSamplesAt(t, cache, { cacheKeySuffix: '-R', cutNow: 530.5, xAxisMode }));
    }
  });

  const PIA39 = path.join(CACHE_DIR, 'telemetry_2024_16_R_PIA_39.json');
  it.skipIf(!(fs.existsSync(PIA39) && hasCachedSession(2024, 16)))('2024 R16 PIA lap 39, 30 s in: 0 samples after now in the focus trace (was 558 of 790)', () => {
    const tel = JSON.parse(fs.readFileSync(PIA39, 'utf8')).telemetry;
    const lt = loadCachedSession(2024, 16).lap_times;
    const now = 6576.288 + 30.25;
    const cutNow = Math.floor(now * 2) / 2; // the component's half-second grid
    for (const mode of ['drivers', 'laps']) {
      const targets = telemetryTargets(lt, now, { mode, focusDriver: 'PIA', selectedDrivers: ['PIA'], replayActive: true });
      expect(targets[0]).toEqual({ driver: 'PIA', lap: 39, inProgress: true });
      const [focus] = traceSamplesAt(targets, { 'PIA-39-R': tel }, { cacheKeySuffix: '-R', cutNow });
      expect(focus.data.filter((d) => d.SessionTime > now)).toEqual([]);
      expect(focus.data.length).toBe(tel.filter((d) => d.SessionTime <= cutNow).length);
      expect(focus.data.length).toBeLessThan(tel.length);
    }
  });

  it('TelemetryStrip builds every trace through traceSamplesAt: no trace is exempt from the cut', () => {
    const src = source('components/visualizations/TelemetryStrip.jsx');
    expect(src).toContain('traceSamplesAt(fetchTargets, telemetryCache, { cacheKeySuffix, cutNow, xAxisMode })');
    expect(src).not.toMatch(/truncateToNow\(|clipReveal|clipActive/);
    expect(src).toMatch(/const cutKey = fetchTargets\.some\(\(t\) => t\.inProgress\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
const HAVE_Q = hasCachedSession(2024, 8, 'Q') && hasCachedFrames(2024, 8, 'Q');
describe.skipIf(!HAVE_Q)('qualifying replay Leaderboard ordered by the best lap completed at the clock (2024 R8 Q)', () => {
  const q = HAVE_Q ? loadCachedSession(2024, 8, 'Q') : { lap_times: [], race_results: [] };
  const segments = HAVE_Q ? loadCachedFrames(2024, 8, 'Q').segments : {};
  const offsets = HAVE_Q ? qualiSegmentOffsets(q.lap_times, segments) : {};

  function qualiAt(seg, i, raceResults = q.race_results) {
    const s0 = segments[seg];
    useF1Store.setState({
      sessionData: { ...q, race_results: raceResults }, drivers: q.driver_info, dnfMap: {}, sessionType: 'Q',
      loadedSessionType: 'Q', isLiveMode: false, isQualifyingReplay: true, qualiSegments: segments, qualiSegment: seg,
      qualiSegmentOffsets: offsets, sessionTimeOffset: offsets[seg], frameData: s0, totalFrames: s0.frames.length,
      currentFrameIndex: i, currentTime: s0.frames[i].t, currentLap: 1, maxLap: 30, maxTime: s0.max_time,
      frameDt: 0.4, lapModeRaceOver: false,
    });
    return useF1Store.getState().getSessionNow();
  }
  const reversed = (results) => results.map((r) => ({
    ...r, Position: Number.isFinite(r.Position) ? 21 - r.Position : r.Position,
  }));
  /** Driver codes of the Leaderboard rows, top to bottom. */
  const rowOrder = (html) => [...html.matchAll(/class="tower-row(?: [^"]*)?"[\s\S]*?class="tower-row__driver-name"[^>]*>([A-Z]{3})</g)]
    .map((m) => m[1]);

  for (const [seg, i] of [['Q1', 5], ['Q1', 600], ['Q2', 300]]) {
    it(`${seg} frame ${i}: rows in the order of the best completed laps; the final results change nothing`, () => {
      const now = qualiAt(seg, i);
      const segDrivers = Object.keys(segments[seg].driver_colors);
      const expected = qualifyingOrder(q.lap_times, now, { drivers: segDrivers }).map((r) => r.driver);
      expect(qualifyingStandings(q.lap_times, now, { drivers: segDrivers }).map((r) => r.abbr)).toEqual(expected);
      const html = renderToString(React.createElement(Leaderboard));
      const shown = rowOrder(html);
      expect(shown.length).toBeGreaterThan(0);
      expect(shown).toEqual(expected.slice(0, shown.length));
      // not the final classification (LEC on pole)
      const final = [...q.race_results].sort((a, b) => a.Position - b.Position).map((r) => r.Abbreviation);
      if (seg === 'Q1' && i === 5) expect(shown[0]).not.toBe(final[0]);
      qualiAt(seg, i, reversed(q.race_results));
      expect(renderToString(React.createElement(Leaderboard))).toBe(html);
    });
  }
});
