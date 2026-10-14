import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { stintsByDriver } from '../../utils/stints';
import { causalKey } from '../../utils/strategyViews';
import { isLapCompleted } from '../../utils/raceTime';
import {
  telemetryReferenceLap, telemetryTargets, traceSamplesAt, revealPoint, inDomain, telemetryCards,
} from '../../utils/views/telemetryStrip';

const LAP_COLORS = ['#a855f7', '#22c55e', '#ff8000', '#e10600'];

function formatLapTime(seconds) {
  if (!seconds || seconds <= 0) return '--:--.---';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${mins}:${secs}`;
}

// Axis tick formatter — seconds in time mode, kilometers in distance mode.
function xTickFormat(mode) {
  if (mode === 'time') return (d) => `${d.toFixed(0)}s`;
  return (d) => `${(d / 1000).toFixed(1)}k`;
}

/**
 * Width of the reveal clip on screen for a reveal x in axis units: null = no
 * clip (draw everything), -Infinity = nothing recorded yet (the axis start).
 */
function revealClipX(xScale, x) {
  if (x == null) return null;
  if (x === -Infinity) return xScale.range()[0];
  return xScale(x);
}

export default function TelemetryStrip({ embedded = false }) {
  const speedRef = useRef(null);
  const deltaRef = useRef(null);
  const throttleRef = useRef(null);
  // brakeRef removed — throttle+brake combined into throttleRef
  const gearRef = useRef(null);
  const rpmRef = useRef(null);
  const containerRef = useRef(null);
  const fetchTimerRef = useRef(null);
  const xScaleRef = useRef(null);
  const crosshairRef = useRef(null); // crosshair distance value
  const brushSvgRef = useRef(null);
  const brushRef = useRef(null);
  const clipRectsRef = useRef([]);       // clipPath rects for progressive reveal
  const currentDistRef = useRef(null);   // current driver distance (no re-render)
  const revealXRef = useRef(null);       // reveal clip x in axis units (null = no clip)
  const revealTraceRef = useRef(null);   // the running lap revealed by the clip
  const playheadRef = useRef(null);      // live playhead DOM handles on speed chart

  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const sessionData = useF1Store((s) => s.sessionData);
  const circuitInfo = useF1Store((s) => s.circuitInfo);
  const telemetryCache = useF1Store((s) => s.telemetryCache);
  const telemetryCompareMode = useF1Store((s) => s.telemetryCompareMode);
  const telemetryCompareLaps = useF1Store((s) => s.telemetryCompareLaps);
  const isQualifyingReplay = useF1Store((s) => s.isQualifyingReplay);
  const telemetryLoading = useF1Store((s) => s.telemetryLoading);
  const fetchDriverTelemetry = useF1Store((s) => s.fetchDriverTelemetry);
  const setTelemetryCompareMode = useF1Store((s) => s.setTelemetryCompareMode);
  const setTelemetryCompareLaps = useF1Store((s) => s.setTelemetryCompareLaps);
  const maxLap = useF1Store((s) => s.maxLap);
  const drivers = useF1Store((s) => s.drivers);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const frameData = useF1Store((s) => s.frameData);
  const isPlaying = useF1Store((s) => s.isPlaying);
  const telemetryChannels = useF1Store((s) => s.telemetryChannels);

  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [lapInput, setLapInput] = useState('');
  const [crosshairInfo, setCrosshairInfo] = useState(null); // { x, distance, values }

  // ── Brush zoom state ──────────────────────────────────────────
  const [zoomDomain, setZoomDomain] = useState(null); // null = full view, or [minDist, maxDist]
  // ── X-axis mode: 'distance' (meters) or 'time' (seconds from lap start) ──
  const [xAxisMode, setXAxisMode] = useState('distance');
  // ── Reference-lap ghost overlay (Pi Toolbox style): dims other cached laps of focus driver ──
  const [showGhosts, setShowGhosts] = useState(false);

  // ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Available drivers for the selector — fall back through multiple sources so
  // the dropdown is never empty when a session is loaded.
  const driverList = useMemo(() => {
    if (drivers && drivers.length > 0) {
      return drivers.map((d) => ({
        abbr: d.Abbreviation,
        name: d.FullName || d.Abbreviation,
        color: getDriverColor(d.Abbreviation),
      }));
    }
    const infoFromSession = sessionData?.driver_info;
    if (infoFromSession && infoFromSession.length > 0) {
      return infoFromSession.map((d) => ({
        abbr: d.Abbreviation,
        name: d.FullName || d.Abbreviation,
        color: getDriverColor(d.Abbreviation),
      }));
    }
    const results = sessionData?.race_results;
    if (results && results.length > 0) {
      const seen = new Set();
      const out = [];
      for (const r of results) {
        const abbr = r.Abbreviation || r.Driver;
        if (!abbr || seen.has(abbr)) continue;
        seen.add(abbr);
        out.push({ abbr, name: r.FullName || r.BroadcastName || abbr, color: getDriverColor(abbr) });
      }
      if (out.length > 0) return out;
    }
    const laps = sessionData?.lap_times;
    if (laps && laps.length > 0) {
      const seen = new Set();
      const out = [];
      for (const lt of laps) {
        const abbr = lt.Driver;
        if (!abbr || seen.has(abbr)) continue;
        seen.add(abbr);
        out.push({ abbr, name: abbr, color: getDriverColor(abbr) });
      }
      return out;
    }
    return [];
  }, [drivers, sessionData]);

  // Causal "now" in session seconds (utils/raceTime.js). Lap choices below
  // change only when a lap completes or a pit event happens (stintKey), not
  // on every replay tick.
  const sessionNow = useSessionNow();
  const replayActive = totalFrames > 0;
  const stintLapTimes = sessionData?.lap_times;
  const stintKey = useMemo(() => causalKey(stintLapTimes, sessionNow), [stintLapTimes, sessionNow]);
  const presetDriver = focusDriver || selectedDrivers[0] || null;

  // Racing laps the focused driver has completed at sessionNow (for presets)
  const driverRacingLaps = useMemo(() => {
    if (!stintLapTimes || !presetDriver) return [];
    return stintLapTimes
      .filter((lt) => lt.Driver === presetDriver && lt.LapTimeSeconds > 0 && lt.LapTimeSeconds < 300
        && isLapCompleted(lt, sessionNow))
      .sort((a, b) => a.LapNumber - b.LapNumber);
    // sessionNow enters through stintKey, which changes whenever the result does
  }, [stintLapTimes, stintKey, presetDriver]);

  // Best lap for focused driver
  const bestLapNumber = useMemo(() => {
    if (driverRacingLaps.length === 0) return null;
    let best = driverRacingLaps[0];
    for (const lt of driverRacingLaps) {
      if (lt.LapTimeSeconds < best.LapTimeSeconds) best = lt;
    }
    return best.LapNumber;
  }, [driverRacingLaps]);

  // First stint laps (before first pit stop): stints from the FastF1 Stint
  // column of the laps completed at sessionNow (utils/stints.js), so the
  // preset only appears once the first stint is over in the replay
  const firstStintLastLap = useMemo(() => {
    if (!stintLapTimes || !presetDriver) return null;
    const stints = stintsByDriver(stintLapTimes, { sessionNow })[presetDriver] || [];
    if (stints.length < 2) return null;
    return stints[0].EndLap;
  }, [stintLapTimes, stintKey, presetDriver]);

  // The focus driver's reference lap (laps mode): the lap in progress with
  // replay frames, else the last completed lap (telemetryReferenceLap)
  const focusRef = useMemo(
    () => (presetDriver && stintLapTimes
      ? telemetryReferenceLap(stintLapTimes, presetDriver, sessionNow, { replayActive })
      : { lap: null, inProgress: false, lapsCompleted: 0 }),
    [stintLapTimes, presetDriver, sessionNow, replayActive],
  );
  const focusRefLap = focusRef.lap;
  // Comparison presets: completed laps other than the reference lap
  const priorLaps = useMemo(
    () => driverRacingLaps.filter((l) => l.LapNumber !== focusRefLap),
    [driverRacingLaps, focusRefLap],
  );

  // Which driver+lap combos to fetch and draw (telemetryTargets, utils/views). The
  // list keeps its identity while its content is unchanged, so the debounced
  // fetch below is not restarted on every replay tick.
  const targetList = useMemo(
    () => telemetryTargets(stintLapTimes, sessionNow, {
      mode: telemetryCompareMode, focusDriver, selectedDrivers,
      compareLaps: telemetryCompareLaps, replayActive,
    }),
    [stintLapTimes, sessionNow, telemetryCompareMode, focusDriver, selectedDrivers,
      telemetryCompareLaps, replayActive],
  );
  const targetSignature = targetList.map((t) => `${t.driver}-${t.lap}-${t.inProgress ? 1 : 0}`).join(',');
  // targetList enters through targetSignature, which changes whenever its content does
  const fetchTargets = useMemo(() => targetList, [targetSignature]);

  // Cache key suffix matches store's fetchDriverTelemetry key format
  const cacheKeySuffix = isQualifyingReplay ? '-Q' : '-R';

  // Debounced telemetry fetching
  useEffect(() => {
    if (fetchTargets.length === 0) return;
    clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      fetchTargets.forEach(({ driver, lap }) => {
        const key = `${driver}-${lap}${cacheKeySuffix}`;
        if (!telemetryCache[key]) {
          fetchDriverTelemetry(driver, lap);
        }
      });
    }, 300);
    return () => clearTimeout(fetchTimerRef.current);
  }, [fetchTargets, telemetryCache, fetchDriverTelemetry, cacheKeySuffix]);

  // Bridge selectedLapRange → telemetryCompareLaps (auto-populate in laps mode).
  // The picks keep the user's range; telemetryTargets fetches and draws only
  // those the driver has completed at sessionNow.
  useEffect(() => {
    if (!selectedLapRange || telemetryCompareMode !== 'laps') return;
    const [start, end] = selectedLapRange;
    if (!start || !end || start >= end) return;
    // Pick up to 4 evenly-spaced laps from the brushed range
    const rangeLen = end - start + 1;
    const step = Math.max(1, Math.floor(rangeLen / 4));
    const laps = [];
    for (let l = start; l <= end && laps.length < 4; l += step) {
      laps.push(l);
    }
    // Only update if different from current
    const current = telemetryCompareLaps;
    if (laps.length > 0 && JSON.stringify(laps) !== JSON.stringify(current)) {
      setTelemetryCompareLaps(laps);
    }
  }, [selectedLapRange, telemetryCompareMode]);

  // A lap still in progress holds only its samples recorded by sessionNow
  // (traceSamplesAt, R6), every trace alike, the focus trace included: the
  // charts never carry a sample from after now, not even under a clip. Cut on
  // a half-second grid so the charts are not redrawn on every replay tick.
  const cutNow = Number.isFinite(sessionNow) ? Math.floor(sessionNow * 2) / 2 : Infinity;
  const cutKey = fetchTargets.some((t) => t.inProgress) ? `${cutNow}` : '';

  // Build resolved trace data
  const traces = useMemo(() => {
    const totalLaps = fetchTargets.length;
    // When xAxisMode is 'time', Distance ← Time so all render code (which keys
    // off d.Distance) transparently plots against lap-time seconds.
    const samples = traceSamplesAt(fetchTargets, telemetryCache, { cacheKeySuffix, cutNow, xAxisMode });
    const resolved = fetchTargets
      .map(({ driver, lap, inProgress }, i) => {
        if (!samples[i]) return null;
        const { key, data, extent, domainLimit } = samples[i];
        const color = telemetryCompareMode === 'drivers'
          ? getDriverColor(driver)
          : (LAP_COLORS[i] || '#888');
        const isFocus = telemetryCompareMode === 'drivers'
          ? driver === focusDriver
          : i === 0;
        // Determine if this trace should be dimmed (external hover highlighting)
        const isDimmed = telemetryCompareMode === 'drivers'
          && highlightedDriver
          && highlightedDriver !== driver;
        // In laps mode: reference lap (i=0) is solid, others are faded + dashed
        const isReference = telemetryCompareMode === 'laps' && i === 0;
        const lapOpacity = telemetryCompareMode === 'laps' && totalLaps > 1
          ? (i === 0 ? 1 : Math.max(0.35, 1 - i * 0.25))
          : 1;
        const lapDashed = telemetryCompareMode === 'laps' && i > 0;
        // The focus driver's running lap: the playhead follows its newest
        // sample (the RAF loop below)
        const followsNow = !!inProgress
          && (telemetryCompareMode === 'drivers' ? driver === presetDriver : i === 0);
        return {
          driver, lap, data, extent, domainLimit, color, isFocus, isDimmed, isReference, lapOpacity,
          lapDashed, key, followsNow,
        };
      })
      .filter(Boolean);
    const mainTraces = resolved;
    if (!showGhosts || !focusDriver) return mainTraces;

    // Inject dim ghost traces: other cached laps of focus driver not already
    // displayed, among the laps that driver has completed at sessionNow
    const activeKeys = new Set(mainTraces.map((t) => t.key));
    const prefix = `${focusDriver}-`;
    const ghosts = [];
    for (const key of Object.keys(telemetryCache)) {
      if (!key.startsWith(prefix)) continue;
      if (activeKeys.has(key)) continue;
      if (!key.endsWith(cacheKeySuffix)) continue;
      const data = telemetryCache[key];
      if (!data || data.length === 0) continue;
      const lapMatch = key.slice(prefix.length).split('-')[0];
      const lapNum = Number(lapMatch);
      if (!Number.isFinite(lapNum)) continue;
      if (lapNum > focusRef.lapsCompleted) continue;
      const ghostData = xAxisMode === 'time'
        ? data.map((d) => ({ ...d, Distance: d.Time != null ? d.Time : d.Distance, _origDistance: d.Distance }))
        : data;
      ghosts.push({
        driver: focusDriver,
        lap: lapNum,
        data: ghostData,
        color: '#888',
        isFocus: false,
        isDimmed: true,
        isReference: false,
        lapOpacity: 0.18,
        lapDashed: true,
        isGhost: true,
        key: `ghost-${key}`,
      });
      if (ghosts.length >= 5) break;
    }
    // Ghosts first, so they render underneath the main traces
    return [...ghosts, ...mainTraces];
    // cutNow enters through cutKey, which changes only while a lap is running
  }, [fetchTargets, telemetryCache, focusDriver, presetDriver, telemetryCompareMode, highlightedDriver,
    xAxisMode, showGhosts, cacheKeySuffix, cutKey, focusRef.lapsCompleted]);

  // Position the speed-chart playhead at the focus driver's current distance
  // and stamp its bubble with the instant speed. Reads refs directly so it
  // doesn't trigger a React re-render when called from the RAF loop.
  const updatePlayhead = useCallback(() => {
    const ph = playheadRef.current;
    if (!ph) return;
    const dist = currentDistRef.current;
    const xScale = ph.xScale;
    if (!ph.focusTrace || dist == null || dist <= 0 || !xScale) {
      ph.group.style('display', 'none');
      return;
    }
    const data = ph.focusTrace.data;
    if (!data?.length) {
      ph.group.style('display', 'none');
      return;
    }
    // In time mode, samples carry Distance = Time and _origDistance = real meters.
    // Locate the sample by real distance, then read its Distance (time) for the scale.
    const isTimeMode = data[0]?._origDistance != null;
    let dPoint;
    if (isTimeMode) {
      const idx = d3.bisector((d) => d._origDistance).left(data, dist);
      dPoint = data[Math.min(idx, data.length - 1)];
    } else {
      const idx = d3.bisector((d) => d.Distance).left(data, dist);
      dPoint = data[Math.min(idx, data.length - 1)];
    }
    if (!dPoint || dPoint.Speed == null) {
      ph.group.style('display', 'none');
      return;
    }
    const domainX = dPoint.Distance;
    const [d0, d1] = xScale.domain();
    if (domainX < d0 || domainX > d1) {
      ph.group.style('display', 'none');
      return;
    }
    const x = xScale(domainX);
    const y = ph.yScale(dPoint.Speed);
    ph.line.attr('x1', x).attr('x2', x);
    ph.circle.attr('cx', x).attr('cy', y);
    const bw = 46;
    const [xMin, xMax] = xScale.range();
    const cx = Math.max(xMin + bw / 2, Math.min(xMax - bw / 2, x));
    ph.bubbleBg.attr('x', cx - bw / 2).attr('width', bw);
    ph.bubbleText.attr('x', cx).text(`${Math.round(dPoint.Speed)} kph`);
    ph.group.style('display', null);
  }, []);

  // ── Playhead and reveal clip (RAF-driven) ─────────
  // The focus driver's running lap holds only its samples recorded by now
  // (traceSamplesAt): the playhead sits on its newest sample, and the clip is
  // only a guard (a backward seek before the traces are re-cut). Samples
  // without SessionTime cannot be cut by time: for those the RAF loop
  // interpolates the focus driver's x/y between replay frames and the clip
  // and playhead follow the car's track position. No React re-renders — all
  // DOM writes go through refs.
  useEffect(() => {
    let rafId;
    const nearestDistance = (coords, x, y) => {
      let minDistSq = Infinity;
      let nearest = 0;
      for (const coord of coords) {
        const ddx = coord.X - x;
        const ddy = coord.Y - y;
        const distSq = ddx * ddx + ddy * ddy;
        if (distSq < minDistSq) {
          minDistSq = distSq;
          nearest = coord.Distance;
        }
      }
      return nearest;
    };

    const loop = () => {
      const state = useF1Store.getState();
      const frames = state.frameData?.frames;
      const idx = state.currentFrameIndex;
      const focus = state.focusDriver || state.selectedDrivers?.[0];
      const coords = state.circuitInfo?.track_coordinates;
      // The running lap's own samples recorded by the replay's now (causal)
      const revealData = revealTraceRef.current?.data;
      const reveal = frames?.length && idx > 0 && revealData?.length
        ? revealPoint(revealData, state.getSessionNow())
        : null;

      if (reveal) {
        // The trace ends at now: the playhead on its newest sample (or where
        // now falls between two samples after a backward seek)
        currentDistRef.current = reveal.distance;
        revealXRef.current = reveal.complete ? null : reveal.x;
      } else if (!revealTraceRef.current || !frames?.length || idx <= 0 || !focus || !coords?.length) {
        // No running lap to reveal (or no clock to reveal it by): no clip
        currentDistRef.current = null;
        revealXRef.current = null;
      } else {
        const f0 = frames[Math.min(idx, frames.length - 1)];
        const f1 = frames[Math.min(idx + 1, frames.length - 1)];
        const d0 = f0?.drivers?.[focus];
        const d1 = f1?.drivers?.[focus];
        if (!d0) {
          currentDistRef.current = null;
        } else {
          // Interpolate x/y with alpha = (currentTime - f0.t) / (f1.t - f0.t).
          // Falls back to d0's raw position when no next frame or no
          // useful delta; finds nearest track coord after interpolation so
          // start/finish wrap behaves correctly.
          let x = d0.x;
          let y = d0.y;
          if (d1 && f1 && f1.t > f0.t) {
            const alpha = Math.max(0, Math.min(1, (state.currentTime - f0.t) / (f1.t - f0.t)));
            x = d0.x + (d1.x - d0.x) * alpha;
            y = d0.y + (d1.y - d0.y) * alpha;
          }
          currentDistRef.current = nearestDistance(coords, x, y);
        }
        // Samples without SessionTime: the car's track position. In time mode,
        // xScale's domain is seconds — convert real distance to the
        // corresponding time via the focus trace before scaling.
        const dist = currentDistRef.current;
        let domainX = dist;
        const data = playheadRef.current?.focusTrace?.data;
        if (data?.length && data[0]?._origDistance != null && dist != null) {
          const bi = d3.bisector((d) => d._origDistance).left(data, dist);
          domainX = data[Math.min(bi, data.length - 1)]?.Distance;
        }
        revealXRef.current = domainX != null && domainX > 0 ? domainX : null;
      }

      const xScale = xScaleRef.current;
      if (xScale && clipRectsRef.current.length > 0) {
        const clipX = revealClipX(xScale, revealXRef.current);
        clipRectsRef.current.forEach((rect) => {
          if (rect) rect.attr('width', clipX != null ? Math.max(0, clipX) : 9999);
        });
      }
      updatePlayhead();

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [updatePlayhead]);

  // Sector boundaries from circuit info
  const sectorBoundaries = useMemo(() => {
    if (!circuitInfo?.track_coordinates?.length) return [];
    const coords = circuitInfo.track_coordinates;
    const distBoundaries = [];
    for (let i = 1; i < coords.length; i++) {
      if (coords[i].Sector !== coords[i - 1].Sector && coords[i].Distance) {
        distBoundaries.push({ sector: coords[i].Sector, distance: coords[i].Distance });
      }
    }
    // In time mode, remap each distance boundary to the Time at that distance on the
    // first reference trace (fallback: proportional mapping from track length).
    if (xAxisMode === 'time' && traces.length > 0) {
      const ref = traces[0].data; // remapped data: Distance = Time, _origDistance = real distance
      if (ref.length === 0) return distBoundaries;
      return distBoundaries.map((b) => {
        // Find sample with _origDistance closest to b.distance
        let best = ref[0], bestDiff = Infinity;
        for (const d of ref) {
          if (d._origDistance == null) continue;
          const diff = Math.abs(d._origDistance - b.distance);
          if (diff < bestDiff) { bestDiff = diff; best = d; }
        }
        return { sector: b.sector, distance: best.Distance };
      });
    }
    return distBoundaries;
  }, [circuitInfo, xAxisMode, traces]);

  // Track length — mode-aware: meters in distance mode, seconds in time mode.
  // The circuit fallback is meters only, so skip it in time mode to avoid
  // crushing the domain (e.g. 5700m) against a ~85s trace. A running lap
  // counts with the extent recorded by now (its full length and lap time are
  // not known yet); in distance mode the track's length comes from the circuit.
  const trackLength = useMemo(() => {
    let max = 0;
    for (const t of traces) {
      const last = t.data[t.data.length - 1];
      const extent = t.extent ?? last?.Distance;
      if (extent > max) max = extent;
    }
    if (xAxisMode === 'distance' && circuitInfo?.track_coordinates?.length) {
      const last = circuitInfo.track_coordinates[circuitInfo.track_coordinates.length - 1];
      if (last?.Distance > max) max = last.Distance;
    }
    if (max > 0) return max;
    return xAxisMode === 'time' ? 90 : 5000;
  }, [traces, circuitInfo, xAxisMode]);

  // Reset zoom when track data or x-axis mode changes
  useEffect(() => {
    setZoomDomain(null);
  }, [trackLength, xAxisMode]);

  // Driver info for comparison cards (enriched with tyre + weather), causal
  // at sessionNow (telemetryCards, utils/views)
  const driverCards = useMemo(() => {
    if (!sessionData?.lap_times) return [];
    return telemetryCards(sessionData.lap_times, sessionData.weather_data, fetchTargets, sessionNow)
      .map((card, i) => ({
        ...card,
        color: telemetryCompareMode === 'drivers'
          ? getDriverColor(card.driver)
          : (LAP_COLORS[i] || '#888'),
      }));
  }, [fetchTargets, sessionData, telemetryCompareMode, sessionNow]);

  // Effective domain for xScale
  const effectiveDomain = useMemo(() => {
    return zoomDomain || [0, trackLength];
  }, [zoomDomain, trackLength]);

  // ── Crosshair mouse handling ───────────────────────────────────
  const handleMouseMove = useCallback((e) => {
    const xScale = xScaleRef.current;
    if (!xScale || traces.length === 0) return;

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const distance = xScale.invert(mouseX);

    if (distance < effectiveDomain[0] || distance > effectiveDomain[1]) {
      setCrosshairInfo(null);
      return;
    }

    // Progressive-clip threshold, in axis units (revealXRef: the running lap's
    // samples recorded by now): nothing beyond it is reported
    const clipDist = revealXRef.current;

    // Find values at this distance for each trace (exclude ghost overlays)
    const values = traces.filter((t) => !t.isGhost).map((t) => {
      // If beyond the progressive clip point, show no value
      if (clipDist != null && distance > clipDist) {
        return {
          driver: t.driver, lap: t.lap, color: t.color,
          speed: null, throttle: null, brake: null, gear: null, rpm: null,
        };
      }
      if (t.data.length === 0 || distance > t.data[t.data.length - 1].Distance) {
        return {
          driver: t.driver, lap: t.lap, color: t.color,
          speed: null, throttle: null, brake: null, gear: null, rpm: null,
        };
      }
      const idx = d3.bisector((d) => d.Distance).left(t.data, distance);
      const d = t.data[Math.min(idx, t.data.length - 1)];
      return {
        driver: t.driver,
        lap: t.lap,
        color: t.color,
        speed: d?.Speed,
        throttle: d?.Throttle,
        brake: d?.Brake,
        gear: d?.nGear,
        rpm: d?.RPM,
      };
    });

    setCrosshairInfo({ x: mouseX, distance, values });
  }, [traces, effectiveDomain, xAxisMode]);

  const handleMouseLeave = useCallback(() => {
    setCrosshairInfo(null);
  }, []);

  // ── Brush overlay management (always active) ──────────────────
  useEffect(() => {
    const svg = brushSvgRef.current;
    if (!svg || !dims.width || !dims.height) return;

    const d3svg = d3.select(svg);
    d3svg.selectAll('*').remove();

    const margin = { left: 36, right: 8 };
    const brush = d3.brushX()
      .extent([[margin.left, 0], [dims.width - margin.right, dims.height]])
      .on('end', (event) => {
        if (!event.selection) return;
        const xScale = xScaleRef.current;
        if (!xScale) return;

        const [x0, x1] = event.selection;
        const d0 = xScale.invert(x0);
        const d1 = xScale.invert(x1);

        // Minimum 100m selection
        if (d1 - d0 < 100) {
          // Clear brush selection
          d3svg.select('.brush').call(brush.move, null);
          return;
        }

        setZoomDomain([d0, d1]);
        // Clear brush selection after zooming
        d3svg.select('.brush').call(brush.move, null);
      });

    brushRef.current = brush;
    d3svg.append('g').attr('class', 'brush').call(brush);

    // Style the brush selection
    d3svg.select('.selection')
      .attr('fill', 'rgba(59, 130, 246, 0.2)')
      .attr('stroke', 'rgba(59, 130, 246, 0.6)')
      .attr('stroke-width', 1);
  }, [dims]);

  // ── D3 Rendering (uses full traces — clipPath handles progressive reveal) ──
  useEffect(() => {
    if (traces.length === 0 || dims.width === 0) {
      [speedRef, deltaRef, throttleRef, gearRef, rpmRef].forEach((ref) => {
        if (ref.current) d3.select(ref.current).selectAll('*').remove();
      });
      clipRectsRef.current = [];
      revealTraceRef.current = null;
      revealXRef.current = null;
      return;
    }

    const margin = { top: 2, right: 8, bottom: 2, left: 36 };
    const xScale = d3.scaleLinear()
      .domain(effectiveDomain)
      .range([margin.left, dims.width - margin.right]);

    // Store xScale for crosshair use
    xScaleRef.current = xScale;

    // Sort traces: dimmed first, then non-focus, then focus on top
    const sorted = [...traces].sort((a, b) => {
      if (a.isDimmed !== b.isDimmed) return a.isDimmed ? -1 : 1;
      return (a.isFocus ? 1 : 0) - (b.isFocus ? 1 : 0);
    });

    renderSpeedChart(speedRef.current, sorted, xScale, margin, sectorBoundaries, trackLength, playheadRef, xAxisMode);
    renderDeltaChart(deltaRef.current, sorted, xScale, margin, sectorBoundaries, xAxisMode);
    renderThrottleBrakeChart(throttleRef.current, sorted, xScale, margin, sectorBoundaries, xAxisMode);
    renderGearChart(gearRef.current, sorted, xScale, margin, sectorBoundaries, xAxisMode);
    renderRPMChart(rpmRef.current, sorted, xScale, margin, sectorBoundaries, xAxisMode);

    // Add clipPaths (only clips trace <path> elements): a guard at now for the
    // running lap the playhead follows (the RAF loop then follows the clock)
    const svgRefs = [speedRef, deltaRef, throttleRef, gearRef, rpmRef];
    revealTraceRef.current = traces.find((t) => t.followsNow && !t.isGhost) || null;
    const st = useF1Store.getState();
    const reveal = revealTraceRef.current && st.totalFrames > 0 && st.currentFrameIndex > 0
      ? revealPoint(revealTraceRef.current.data, st.getSessionNow())
      : null;
    if (reveal) revealXRef.current = reveal.complete ? null : reveal.x;
    else if (!revealTraceRef.current) revealXRef.current = null;
    const clipX = revealClipX(xScale, revealXRef.current);

    clipRectsRef.current = svgRefs.map((ref, i) => {
      if (!ref.current) return null;
      const svg = d3.select(ref.current);
      const bbox = ref.current.getBoundingClientRect();

      let defs = svg.select('defs');
      if (defs.empty()) defs = svg.insert('defs', ':first-child');

      const clipId = `telem-progress-${i}`;
      const clipPath = defs.append('clipPath').attr('id', clipId);
      const clipRect = clipPath.append('rect')
        .attr('x', 0).attr('y', 0)
        .attr('width', clipX != null ? Math.max(0, clipX) : bbox.width)
        .attr('height', bbox.height);

      // Apply clip to trace paths and annotation groups (not axes/grid/labels)
      svg.selectAll('path, .telem-clippable').attr('clip-path', `url(#${clipId})`);

      return clipRect;
    });

    // Position the playhead immediately so it's visible without waiting for
    // the next frame tick (important when focusDriver / zoom changes).
    updatePlayhead();
  }, [traces, dims, effectiveDomain, trackLength, sectorBoundaries, updatePlayhead, xAxisMode]);

  // ── Toolbar handlers ──────────────────────────────────────────

  const handleZoomIn = useCallback(() => {
    const [d0, d1] = effectiveDomain;
    const range = d1 - d0;
    const center = (d0 + d1) / 2;
    const newRange = range * 0.5;
    setZoomDomain([
      Math.max(0, center - newRange / 2),
      Math.min(trackLength, center + newRange / 2),
    ]);
  }, [effectiveDomain, trackLength]);

  const handleZoomOut = useCallback(() => {
    if (!zoomDomain) return;
    const [d0, d1] = zoomDomain;
    const range = d1 - d0;
    const center = (d0 + d1) / 2;
    const newRange = range * 2;
    if (newRange >= trackLength) {
      setZoomDomain(null);
    } else {
      setZoomDomain([
        Math.max(0, center - newRange / 2),
        Math.min(trackLength, center + newRange / 2),
      ]);
    }
  }, [zoomDomain, trackLength]);

  const handleReset = useCallback(() => {
    setZoomDomain(null);
    setCrosshairInfo(null);
  }, []);

  // Toggle a lap in/out of comparison
  const handleToggleLap = useCallback((lap) => {
    if (lap === focusRefLap) return; // the reference lap is always shown
    if (telemetryCompareLaps.includes(lap)) {
      setTelemetryCompareLaps(telemetryCompareLaps.filter((l) => l !== lap));
    } else {
      setTelemetryCompareLaps([...telemetryCompareLaps, lap].slice(0, 3)); // max 3 comparison laps + current
    }
  }, [focusRefLap, telemetryCompareLaps, setTelemetryCompareLaps]);

  // Handle adding laps via number input
  const addLapFromInput = useCallback(() => {
    const lap = parseInt(lapInput, 10);
    if (lap > 0 && lap <= maxLap && lap !== focusRefLap && !telemetryCompareLaps.includes(lap)) {
      setTelemetryCompareLaps([...telemetryCompareLaps, lap].slice(0, 3));
    }
    setLapInput('');
  }, [lapInput, maxLap, focusRefLap, telemetryCompareLaps, setTelemetryCompareLaps]);

  const handleAddLap = useCallback((e) => {
    if (e.key === 'Enter') addLapFromInput();
  }, [addLapFromInput]);

  const handleRemoveLap = useCallback((lap) => {
    setTelemetryCompareLaps(telemetryCompareLaps.filter((l) => l !== lap));
  }, [telemetryCompareLaps, setTelemetryCompareLaps]);

  // Handle adding a driver comparison
  const handleAddDriver = useCallback((abbr) => {
    if (abbr && !selectedDrivers.includes(abbr)) {
      toggleDriver(abbr);
    }
  }, [selectedDrivers, toggleDriver]);

  // Handle removing a driver from comparison
  const handleRemoveDriver = useCallback((abbr) => {
    if (selectedDrivers.includes(abbr)) {
      toggleDriver(abbr);
    }
  }, [selectedDrivers, toggleDriver]);

  const hasData = traces.length > 0;
  const showEmpty = fetchTargets.length === 0 && !telemetryLoading;

  return (
    <div className="telemetry-strip">
      <div className="telemetry-strip__header">
        <div className="telemetry-strip__header-left">
          {/* Focus driver selector */}
          <div className="telem-driver-selector">
            <select
              className="telem-driver-select"
              value={focusDriver || ''}
              onChange={(e) => {
                const drv = e.target.value;
                setFocusDriver(drv || null);
                // Auto-select if not already selected
                if (drv && !selectedDrivers.includes(drv)) {
                  toggleDriver(drv);
                }
              }}
            >
              <option value="">Focus Driver</option>
              {driverList.map((d) => (
                <option key={d.abbr} value={d.abbr}>{d.abbr} — {d.name}</option>
              ))}
            </select>
          </div>

          {/* Add comparison driver */}
          {telemetryCompareMode === 'drivers' && (
            <select
              className="telem-driver-select telem-driver-select--add"
              value=""
              onChange={(e) => handleAddDriver(e.target.value)}
            >
              <option value="">+ Compare</option>
              {driverList
                .filter((d) => !selectedDrivers.includes(d.abbr))
                .map((d) => (
                  <option key={d.abbr} value={d.abbr}>{d.abbr}</option>
                ))
              }
            </select>
          )}

          {/* Driver comparison cards — F1 TV MFD style */}
          {driverCards.map((card, cardIdx) => {
            const tyreColor = TYRE_COLORS[card.compound] || TYRE_COLORS.UNKNOWN;
            const isDarkTyre = card.compound === 'HARD' || card.compound === 'MEDIUM';
            // Sector color: personal best = green, else default
            const sectorColor = (val, best) => {
              if (!val || val <= 0) return 'rgba(255,255,255,0.3)';
              if (best && Math.abs(val - best) < 0.002) return '#a855f7';
              return 'rgba(255,255,255,0.85)';
            };
            const isHighlighted = highlightedDriver === card.driver;
            const isLapsMode = telemetryCompareMode === 'laps';
            const isRef = isLapsMode && cardIdx === 0;
            return (
              <div
                className="telem-mfd-card"
                key={`${card.driver}-${card.lap}`}
                onMouseEnter={() => !isLapsMode && setHighlightedDriver(card.driver)}
                onMouseLeave={() => !isLapsMode && setHighlightedDriver(null)}
                onClick={() => !isLapsMode && setFocusDriver(card.driver)}
                style={{
                  cursor: isLapsMode ? 'default' : 'pointer',
                  outline: isHighlighted ? `1px solid ${card.color}` : undefined,
                  boxShadow: isHighlighted ? `0 0 8px ${card.color}40` : undefined,
                  borderLeft: `3px solid ${card.color}`,
                }}
              >
                {/* Close/remove button — drivers mode: remove driver; laps mode: remove lap */}
                {isLapsMode ? (
                  !isRef && (
                    <button
                      className="telem-mfd-card__close"
                      onClick={(e) => { e.stopPropagation(); handleRemoveLap(card.lap); }}
                      title={`Remove lap ${card.lap}`}
                    >
                      &times;
                    </button>
                  )
                ) : (
                  <button
                    className="telem-mfd-card__close"
                    onClick={(e) => { e.stopPropagation(); handleRemoveDriver(card.driver); }}
                    title={`Remove ${card.driver}`}
                  >
                    &times;
                  </button>
                )}
                {/* Row 1: driver/lap label + tyre */}
                <div className="telem-mfd-card__top">
                  {isLapsMode ? (
                    <div className="telem-mfd-card__driver">
                      <span className="telem-mfd-card__bar" style={{ background: card.color }} />
                      <span className="telem-mfd-card__abbr">{card.driver}</span>
                      <span style={{ fontSize: 9, color: card.color, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>L{card.lap}</span>
                      {isRef && <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.35)', marginLeft: 2 }}>REF</span>}
                    </div>
                  ) : (
                    <div className="telem-mfd-card__driver">
                      <span className="telem-mfd-card__bar" style={{ background: card.color }} />
                      <span className="telem-mfd-card__abbr">{card.driver}</span>
                    </div>
                  )}
                  <span className="telem-mfd-card__tyre" style={{ background: tyreColor, color: isDarkTyre ? '#000' : '#fff' }}>
                    {card.compound?.[0] || '?'}
                  </span>
                  {!isLapsMode && (
                    <span className="telem-mfd-card__lap-badge" style={{ borderColor: card.color }}>
                      Lap {card.lap}
                    </span>
                  )}
                </div>
                {/* Row 2: lap time + tyre life */}
                <div className="telem-mfd-card__mid">
                  <span className="telem-mfd-card__laptime">{formatLapTime(card.lapTime)}</span>
                  {card.tyreLife != null && (
                    <span className="telem-mfd-card__tyre-life">{card.tyreLife}L</span>
                  )}
                </div>
                {/* Row 3: sectors */}
                {card.s1 > 0 && (
                  <div className="telem-mfd-card__sectors">
                    <span className="telem-mfd-card__sector">
                      <span className="telem-mfd-card__sector-label">S1</span>
                      <span className="telem-mfd-card__sector-val" style={{ color: sectorColor(card.s1, card.bestS1) }}>
                        {card.s1.toFixed(3)}
                      </span>
                    </span>
                    <span className="telem-mfd-card__sector">
                      <span className="telem-mfd-card__sector-label">S2</span>
                      <span className="telem-mfd-card__sector-val" style={{ color: sectorColor(card.s2, card.bestS2) }}>
                        {card.s2?.toFixed(3) || '—'}
                      </span>
                    </span>
                    <span className="telem-mfd-card__sector">
                      <span className="telem-mfd-card__sector-label">S3</span>
                      <span className="telem-mfd-card__sector-val" style={{ color: sectorColor(card.s3, card.bestS3) }}>
                        {card.s3?.toFixed(3) || '—'}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="telemetry-strip__header-right">
          {telemetryCompareMode === 'laps' && (
            <div className="telem-lap-presets">
              {/* Quick preset buttons */}
              <button
                className={`telem-preset-btn${telemetryCompareLaps.length === 0 ? '' : ''}`}
                onClick={() => {
                  const laps = priorLaps.slice(-3).map((l) => l.LapNumber);
                  setTelemetryCompareLaps(laps);
                }}
                disabled={priorLaps.length < 1}
                title="Compare current lap vs the last 3 laps"
              >
                Last 3
              </button>
              <button
                className="telem-preset-btn"
                onClick={() => {
                  const laps = priorLaps.slice(-5);
                  const pick = laps.length <= 3 ? laps : [laps[0], laps[Math.floor(laps.length / 2)], laps[laps.length - 1]];
                  setTelemetryCompareLaps(pick.map((l) => l.LapNumber));
                }}
                disabled={priorLaps.length < 2}
                title="Compare current lap vs 3 evenly-spaced from the last 5"
              >
                Last 5
              </button>
              {bestLapNumber && bestLapNumber !== focusRefLap && (
                <button
                  className="telem-preset-btn telem-preset-btn--best"
                  onClick={() => setTelemetryCompareLaps([bestLapNumber])}
                  title={`Compare current lap vs personal best (L${bestLapNumber})`}
                >
                  vs Best
                </button>
              )}
              {firstStintLastLap && firstStintLastLap !== focusRefLap && (
                <button
                  className="telem-preset-btn"
                  onClick={() => setTelemetryCompareLaps([firstStintLastLap])}
                  title={`Compare current lap vs end of first stint (L${firstStintLastLap})`}
                >
                  vs Stint 1
                </button>
              )}
              <span className="telem-preset-divider" />
              {/* Selected comparison laps */}
              {telemetryCompareLaps.map((lap, i) => (
                <span
                  key={lap}
                  className="telem-lap-chip telem-lap-chip--active"
                  style={{ borderColor: LAP_COLORS[i + 1] || '#888', color: LAP_COLORS[i + 1] || '#888' }}
                  onClick={() => handleRemoveLap(lap)}
                  title={`Remove lap ${lap}`}
                >
                  L{lap} ×
                </span>
              ))}
              {/* Manual lap input */}
              <input
                className="telem-lap-picker"
                type="number"
                min={1}
                max={maxLap}
                placeholder="Lap #"
                value={lapInput}
                onChange={(e) => setLapInput(e.target.value)}
                onKeyDown={handleAddLap}
                style={{ width: 48 }}
              />
              <button
                className="telem-lap-add-btn"
                onClick={addLapFromInput}
                disabled={!lapInput}
                title="Add lap to comparison"
              >
                + ADD
              </button>
            </div>
          )}

          <div className="telem-mode-toggle">
            <button
              className={`telem-mode-btn ${telemetryCompareMode === 'drivers' ? 'telem-mode-btn--active' : ''}`}
              onClick={() => setTelemetryCompareMode('drivers')}
            >
              Drivers
            </button>
            <button
              className={`telem-mode-btn ${telemetryCompareMode === 'laps' ? 'telem-mode-btn--active' : ''}`}
              onClick={() => setTelemetryCompareMode('laps')}
            >
              Laps
            </button>
          </div>

          {/* Export PNG — moved here from the now-removed SpeedPanel wrapper. */}
          <button
            onClick={() => {
              const root = document.querySelector('.telemetry-strip');
              if (root) import('../../utils/exportChart').then((m) => m.exportAsPng(root, 'telemetry.png'));
            }}
            title="Export telemetry as PNG"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 4,
              border: '1px solid rgba(255,255,255,0.10)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.55)', cursor: 'pointer',
              fontSize: '12px', padding: 0, flexShrink: 0,
              marginLeft: 6,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Channel legend */}
      <div style={{
        display: 'flex', gap: 10, padding: '4px 8px', flexShrink: 0,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        fontSize: 8, color: 'rgba(255,255,255,0.5)', alignItems: 'center',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{
            width: 12, height: 2,
            background: 'linear-gradient(90deg, #e10600 0%, #00d2be 50%, #0600ef 100%)',
            display: 'inline-block',
          }} /> Lines colored by team
        </span>
        <span style={{ opacity: 0.4 }}>|</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 12, height: 2, background: '#00e676', display: 'inline-block' }} /> Focus throttle
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 12, height: 2, background: '#e10600', display: 'inline-block' }} /> Focus brake
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 7, opacity: 0.5 }}>
          Shift+drag to brush distance
        </span>
      </div>

      {/* Charts container with crosshair overlay */}
      <div
        className="telemetry-strip__charts"
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: 'crosshair' }}
      >
        {showEmpty ? (
          <div className="telemetry-strip__empty">Select a focus driver or click drivers in the leaderboard</div>
        ) : telemetryLoading && !hasData ? (
          <div className="telemetry-strip__loading">Loading telemetry...</div>
        ) : (
          <>
            {telemetryChannels.speed && (
              <div className="telemetry-strip__chart telemetry-strip__chart--speed">
                <svg ref={speedRef} />
              </div>
            )}
            {telemetryChannels.delta && (
              <div className="telemetry-strip__chart telemetry-strip__chart--delta">
                <svg ref={deltaRef} />
              </div>
            )}
            {(telemetryChannels.throttle || telemetryChannels.brake) && (
              <div className="telemetry-strip__chart telemetry-strip__chart--throttle-brake">
                <svg ref={throttleRef} />
              </div>
            )}
            {telemetryChannels.gear && (
              <div className="telemetry-strip__chart telemetry-strip__chart--gear">
                <svg ref={gearRef} />
              </div>
            )}
            {telemetryChannels.rpm && (
              <div className="telemetry-strip__chart telemetry-strip__chart--rpm">
                <svg ref={rpmRef} />
              </div>
            )}

            {/* Toolbar */}
            {hasData && (
              <div className="telem-toolbar">
                <div className="telem-axis-toggle" style={{ display: 'flex', gap: 2, marginRight: 4, background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: 2 }}>
                  <button
                    className="telem-toolbar__btn"
                    onClick={() => setXAxisMode('distance')}
                    title="X axis: track distance (m)"
                    style={{
                      padding: '2px 7px',
                      fontSize: 9,
                      fontWeight: 700,
                      color: xAxisMode === 'distance' ? '#fff' : 'rgba(255,255,255,0.45)',
                      background: xAxisMode === 'distance' ? 'rgba(59,130,246,0.35)' : 'transparent',
                      border: 'none',
                      borderRadius: 3,
                    }}
                  >DIST</button>
                  <button
                    className="telem-toolbar__btn"
                    onClick={() => setXAxisMode('time')}
                    title="X axis: lap time (s)"
                    style={{
                      padding: '2px 7px',
                      fontSize: 9,
                      fontWeight: 700,
                      color: xAxisMode === 'time' ? '#fff' : 'rgba(255,255,255,0.45)',
                      background: xAxisMode === 'time' ? 'rgba(59,130,246,0.35)' : 'transparent',
                      border: 'none',
                      borderRadius: 3,
                    }}
                  >TIME</button>
                </div>
                <button
                  className="telem-toolbar__btn"
                  onClick={() => setShowGhosts((g) => !g)}
                  title={`${showGhosts ? 'Hide' : 'Show'} ghost reference laps (dimmed traces from focus driver's other cached laps)`}
                  style={{
                    padding: '2px 7px',
                    fontSize: 9,
                    fontWeight: 700,
                    color: showGhosts ? '#fff' : 'rgba(255,255,255,0.45)',
                    background: showGhosts ? 'rgba(168,85,247,0.35)' : 'rgba(255,255,255,0.04)',
                    borderRadius: 3,
                    marginRight: 4,
                  }}
                >GHOSTS</button>
                <button
                  className="telem-toolbar__btn"
                  onClick={handleZoomIn}
                  title="Zoom in"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  className="telem-toolbar__btn"
                  onClick={handleZoomOut}
                  disabled={!zoomDomain}
                  title="Zoom out"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  className="telem-toolbar__btn"
                  onClick={handleReset}
                  disabled={!zoomDomain}
                  title="Reset zoom"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                </button>
              </div>
            )}

            {/* Zoom range indicator */}
            {zoomDomain && (
              <div className="telem-zoom-indicator">
                {xAxisMode === 'time'
                  ? `${zoomDomain[0].toFixed(1)}s — ${zoomDomain[1].toFixed(1)}s`
                  : `${Math.round(zoomDomain[0])}m — ${Math.round(zoomDomain[1])}m`}
              </div>
            )}

            {/* Brush overlay SVG (always active — drag to zoom) */}
            <svg
              ref={brushSvgRef}
              className="telem-brush-overlay"
            />

            {/* Crosshair line (absolute positioned over all charts) */}
            {crosshairInfo && (
              <div
                className="telem-crosshair-line"
                style={{ left: crosshairInfo.x }}
              />
            )}

            {/* Crosshair tooltip */}
            {crosshairInfo && (
              <div
                className="telem-crosshair-tooltip"
                style={{
                  left: crosshairInfo.x + 12,
                  top: 8,
                }}
              >
                <div className="telem-crosshair-tooltip__dist">
                  {xAxisMode === 'time'
                    ? `${crosshairInfo.distance.toFixed(2)}s`
                    : `${Math.round(crosshairInfo.distance)}m`}
                </div>
                {crosshairInfo.values.map((v) => (
                  <div className="telem-crosshair-tooltip__row" key={`${v.driver}-${v.lap}`}>
                    <span className="telem-crosshair-tooltip__dot" style={{ background: v.color }} />
                    <span className="telem-crosshair-tooltip__driver">
                      {telemetryCompareMode === 'laps' ? `L${v.lap}` : v.driver}
                    </span>
                    <span className="telem-crosshair-tooltip__val">
                      {v.speed != null ? `${Math.round(v.speed)} kph` : '—'}
                    </span>
                    <span className="telem-crosshair-tooltip__val telem-crosshair-tooltip__val--dim" style={{ color: '#00e676' }}>
                      {v.throttle != null ? `${Math.round(v.throttle)}%T` : ''}
                    </span>
                    <span className="telem-crosshair-tooltip__val telem-crosshair-tooltip__val--dim" style={{ color: '#e10600' }}>
                      {v.brake != null ? `${Math.round(typeof v.brake === 'boolean' ? (v.brake ? 100 : 0) : v.brake)}%B` : ''}
                    </span>
                    <span className="telem-crosshair-tooltip__val telem-crosshair-tooltip__val--dim">
                      G{v.gear != null ? v.gear : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Shared helpers ────────────────────────────────────────────

function drawSectorLines(g, sectorBoundaries, xScale, top, bottom) {
  sectorBoundaries.forEach((sb) => {
    const x = xScale(sb.distance);
    g.append('line')
      .attr('class', 'telem-sector-line')
      .attr('x1', x).attr('x2', x)
      .attr('y1', top).attr('y2', bottom);
  });
}

function drawSectorLabels(g, sectorBoundaries, xScale, y, trackLength) {
  const sectorStarts = [0, ...sectorBoundaries.map((sb) => sb.distance)];
  const sectorEnds = [...sectorBoundaries.map((sb) => sb.distance), trackLength];
  for (let i = 0; i < sectorStarts.length; i++) {
    const mid = (sectorStarts[i] + sectorEnds[i]) / 2;
    g.append('text')
      .attr('class', 'telem-sector-label')
      .attr('x', xScale(mid))
      .attr('y', y)
      .attr('text-anchor', 'middle')
      .text(`SECTOR ${i + 1}`);
  }
}

function prepSvg(svgEl) {
  if (!svgEl) return null;
  const svg = d3.select(svgEl);
  const { width, height } = svgEl.getBoundingClientRect();
  if (width === 0 || height === 0) return null;
  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  return { svg, width, height, g: svg.append('g') };
}

// ── Find local min/max speed points for annotations ────────────
function findSpeedAnnotations(traces, xScale, yScale, width, margin) {
  if (traces.length === 0) return [];
  const annotations = [];
  const minSpacing = 80;

  for (const t of traces) {
    const data = t.data.filter((d) => d.Distance != null && d.Speed != null);
    if (data.length < 10) continue;

    const step = Math.max(1, Math.floor(data.length / 20));
    const peaks = [];

    for (let i = step; i < data.length - step; i += Math.floor(step / 2)) {
      const prev = data[Math.max(0, i - step)];
      const curr = data[i];
      const next = data[Math.min(data.length - 1, i + step)];

      const isLocalMax = curr.Speed >= prev.Speed && curr.Speed >= next.Speed
        && (curr.Speed - prev.Speed > 15 || curr.Speed - next.Speed > 15);
      const isLocalMin = curr.Speed <= prev.Speed && curr.Speed <= next.Speed
        && (prev.Speed - curr.Speed > 15 || next.Speed - curr.Speed > 15);

      if (isLocalMax || isLocalMin) {
        const px = xScale(curr.Distance);
        if (peaks.every((p) => Math.abs(p.px - px) > minSpacing)) {
          peaks.push({
            px,
            py: yScale(curr.Speed),
            speed: Math.round(curr.Speed),
            driver: t.driver,
            color: t.color,
            isMax: isLocalMax,
          });
        }
      }
    }
    annotations.push(...peaks);
  }
  return annotations;
}

// ── Compute cumulative delta between first trace (reference) and others ──
function computeDelta(referenceData, comparisonData) {
  if (!referenceData?.length || !comparisonData?.length) return [];

  const refMap = new Map();
  referenceData.forEach((d) => {
    if (d.Distance != null && d.Speed != null && d.Speed > 0)
      refMap.set(Math.round(d.Distance), d.Speed);
  });

  const compMap = new Map();
  comparisonData.forEach((d) => {
    if (d.Distance != null && d.Speed != null && d.Speed > 0)
      compMap.set(Math.round(d.Distance), d.Speed);
  });

  const result = [];
  let cumulativeDelta = 0;
  const distances = [...new Set([...refMap.keys(), ...compMap.keys()])].sort((a, b) => a - b);

  let prevDist = distances[0] || 0;
  for (const dist of distances) {
    const refSpeed = refMap.get(dist);
    const compSpeed = compMap.get(dist);
    if (refSpeed && compSpeed) {
      const dDist = dist - prevDist;
      if (dDist > 0) {
        const refTime = dDist / (refSpeed / 3.6);
        const compTime = dDist / (compSpeed / 3.6);
        cumulativeDelta += (compTime - refTime);
      }
      result.push({ distance: dist, delta: cumulativeDelta });
      prevDist = dist;
    }
  }
  return result;
}

// ── Chart Renderers ────────────

function renderSpeedChart(svgEl, traces, xScale, margin, sectorBoundaries, trackLength, playheadRef, xAxisMode) {
  const ctx = prepSvg(svgEl);
  if (!ctx) {
    if (playheadRef) playheadRef.current = null;
    return;
  }
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  let yMin = Infinity, yMax = -Infinity;
  for (const t of traces) {
    for (const d of t.data) {
      if (!inDomain(t, d)) continue;
      if (d.Speed != null) {
        if (d.Speed < yMin) yMin = d.Speed;
        if (d.Speed > yMax) yMax = d.Speed;
      }
    }
  }
  if (yMin === Infinity) return;
  const pad = (yMax - yMin) * 0.08 || 10;
  const yScale = d3.scaleLinear()
    .domain([yMin - pad, yMax + pad])
    .range([height - m.bottom, m.top]);

  // Grid
  yScale.ticks(4).forEach((tick) => {
    g.append('line').attr('class', 'telem-grid-line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', yScale(tick)).attr('y2', yScale(tick));
  });

  // Sector lines + centered labels
  drawSectorLines(g, sectorBoundaries, xScale, m.top, height - m.bottom);
  drawSectorLabels(g, sectorBoundaries, xScale, m.top + 10, trackLength);

  // Y axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(yScale).ticks(4).tickSize(-3).tickFormat(d3.format('.0f')))
    .call((el) => el.select('.domain').remove());

  // X axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - m.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat(xTickFormat(xAxisMode)))
    .call((el) => el.select('.domain').remove());

  // Label
  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', m.top + 10)
    .text('SPEED (kph)');

  // Lines
  const line = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => yScale(d.Speed))
    .defined((d) => d.Distance != null && d.Speed != null)
    .curve(d3.curveMonotoneX);

  traces.forEach((t) => {
    const opacity = t.isDimmed ? 0.15 : (t.lapOpacity || 1);
    if (t.isFocus && !t.isDimmed && !t.lapDashed) {
      const area = d3.area()
        .x((d) => xScale(d.Distance))
        .y0(height - m.bottom)
        .y1((d) => yScale(d.Speed))
        .defined((d) => d.Distance != null && d.Speed != null)
        .curve(d3.curveMonotoneX);
      g.append('path').datum(t.data)
        .attr('class', 'telem-speed-area--focus')
        .attr('d', area).attr('fill', t.color);
    }
    const path = g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-speed-line telem-speed-line--focus' : 'telem-speed-line')
      .attr('d', line).attr('stroke', t.color)
      .attr('opacity', opacity)
      .attr('stroke-width', t.lapDashed ? 1.2 : null);
    if (t.lapDashed) path.attr('stroke-dasharray', '6,3');

    // Lap label at end of trace in laps mode
    if (t.lapDashed != null && traces.length > 1) {
      const lastPt = t.data[t.data.length - 1];
      if (lastPt?.Distance != null && lastPt?.Speed != null) {
        g.append('text')
          .attr('x', xScale(lastPt.Distance) + 3)
          .attr('y', yScale(lastPt.Speed))
          .attr('fill', t.color)
          .attr('font-size', '8px')
          .attr('font-weight', 600)
          .attr('dominant-baseline', 'middle')
          .attr('opacity', opacity)
          .text(`L${t.lap}`);
      }
    }
  });

  // Speed annotations at local min/max (wrapped in clippable group)
  const annotsG = g.append('g').attr('class', 'telem-clippable');
  const annots = findSpeedAnnotations(traces, xScale, yScale, width, m);
  annots.forEach((a) => {
    const yOff = a.isMax ? -8 : 12;
    annotsG.append('rect')
      .attr('class', 'telem-annot-bg')
      .attr('x', a.px - 14)
      .attr('y', a.py + yOff - 9)
      .attr('width', 28)
      .attr('height', 12)
      .attr('rx', 2);
    annotsG.append('text')
      .attr('class', 'telem-annot-text')
      .attr('x', a.px)
      .attr('y', a.py + yOff)
      .attr('text-anchor', 'middle')
      .attr('fill', a.color)
      .text(a.speed);
  });

  // ── Live playhead (positioned by updatePlayhead on every frame tick) ──
  // Kept outside clippable groups so it's always visible, and drawn last so
  // it renders above the trace lines.
  if (playheadRef) {
    // The focus driver's running lap first: the playhead reads its speed
    const focusTrace = traces.find((t) => t.followsNow && !t.isGhost)
      || traces.find((t) => t.isFocus) || traces[0] || null;
    const phGroup = g.append('g')
      .attr('class', 'telem-playhead')
      .style('display', 'none')
      .style('pointer-events', 'none');
    const phLine = phGroup.append('line')
      .attr('y1', m.top)
      .attr('y2', height - m.bottom)
      .attr('stroke', '#fbbf24')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '3,2')
      .attr('opacity', 0.85);
    const phCircle = phGroup.append('circle')
      .attr('r', 3.5)
      .attr('fill', '#fbbf24')
      .attr('stroke', '#0a0a0a')
      .attr('stroke-width', 1);
    const phBubbleBg = phGroup.append('rect')
      .attr('y', m.top + 1)
      .attr('height', 13)
      .attr('rx', 3)
      .attr('fill', '#fbbf24');
    const phBubbleText = phGroup.append('text')
      .attr('y', m.top + 10)
      .attr('text-anchor', 'middle')
      .attr('fill', '#0a0a0a')
      .attr('font-size', '9px')
      .attr('font-weight', 700)
      .style('pointer-events', 'none');

    playheadRef.current = {
      group: phGroup,
      line: phLine,
      circle: phCircle,
      bubbleBg: phBubbleBg,
      bubbleText: phBubbleText,
      xScale,
      yScale,
      focusTrace,
    };
  }
}

function renderDeltaChart(svgEl, traces, xScale, margin, sectorBoundaries, xAxisMode) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  if (traces.length < 2) {
    g.append('text').attr('class', 'telem-chart-label')
      .attr('x', m.left + 4).attr('y', height / 2 + 3)
      .text('GAP — select 2+ traces to compare');
    return;
  }

  const refTrace = traces[0];
  const deltaTraces = [];
  for (let i = 1; i < traces.length; i++) {
    const delta = computeDelta(refTrace.data, traces[i].data);
    if (delta.length > 0) {
      // the gap is known up to where both laps are recorded by now
      const domainLimit = Math.min(refTrace.domainLimit ?? Infinity, traces[i].domainLimit ?? Infinity);
      deltaTraces.push({ data: delta, color: traces[i].color, driver: traces[i].driver, domainLimit });
    }
  }

  if (deltaTraces.length === 0) {
    g.append('text').attr('class', 'telem-chart-label')
      .attr('x', m.left + 4).attr('y', height / 2 + 3)
      .text('GAP — no comparable data');
    return;
  }

  let yMin = 0, yMax = 0;
  for (const dt of deltaTraces) {
    for (const d of dt.data) {
      if (d.distance > dt.domainLimit) continue; // not recorded yet at now
      if (d.delta < yMin) yMin = d.delta;
      if (d.delta > yMax) yMax = d.delta;
    }
  }
  const pad = Math.max(Math.abs(yMax), Math.abs(yMin), 0.1) * 0.2;
  const yScale = d3.scaleLinear()
    .domain([yMin - pad, yMax + pad])
    .range([height - m.bottom, m.top]);

  // Zero line
  g.append('line')
    .attr('class', 'telem-delta-zero')
    .attr('x1', m.left).attr('x2', width - m.right)
    .attr('y1', yScale(0)).attr('y2', yScale(0));

  drawSectorLines(g, sectorBoundaries, xScale, m.top, height - m.bottom);

  // Label
  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', m.top + 9)
    .text('GAP (s)');

  // Y axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(yScale).ticks(3).tickSize(-3).tickFormat((d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}s`))
    .call((el) => el.select('.domain').remove());

  // X axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - m.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat(xTickFormat(xAxisMode)))
    .call((el) => el.select('.domain').remove());

  deltaTraces.forEach((dt) => {
    const areaPos = d3.area()
      .x((d) => xScale(d.distance))
      .y0(yScale(0))
      .y1((d) => yScale(Math.max(0, d.delta)))
      .curve(d3.curveMonotoneX);

    g.append('path').datum(dt.data)
      .attr('class', 'telem-delta-area telem-delta-area--positive')
      .attr('d', areaPos);

    const areaNeg = d3.area()
      .x((d) => xScale(d.distance))
      .y0(yScale(0))
      .y1((d) => yScale(Math.min(0, d.delta)))
      .curve(d3.curveMonotoneX);

    g.append('path').datum(dt.data)
      .attr('class', 'telem-delta-area telem-delta-area--negative')
      .attr('d', areaNeg);

    const line = d3.line()
      .x((d) => xScale(d.distance))
      .y((d) => yScale(d.delta))
      .curve(d3.curveMonotoneX);

    g.append('path').datum(dt.data)
      .attr('class', 'telem-delta-line')
      .attr('d', line)
      .attr('stroke', dt.color);
  });
}

function renderThrottleBrakeChart(svgEl, traces, xScale, margin, sectorBoundaries, xAxisMode) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  // Split chart: throttle goes up from center, brake goes down
  const midY = (m.top + (height - m.bottom)) / 2;

  // Throttle Y: 0 at midY → 100 at top
  const yThrottle = d3.scaleLinear().domain([0, 100]).range([midY, m.top]);
  // Brake Y: 0 at midY → 100 at bottom (inverted)
  const yBrake = d3.scaleLinear().domain([0, 100]).range([midY, height - m.bottom]);

  drawSectorLines(g, sectorBoundaries, xScale, m.top, height - m.bottom);

  // Center dividing line (0%)
  g.append('line')
    .attr('x1', m.left).attr('x2', width - m.right)
    .attr('y1', midY).attr('y2', midY)
    .attr('stroke', 'rgba(255,255,255,0.2)').attr('stroke-width', 0.5);

  // Y axis — throttle side (upward: 0 → 100%)
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(yThrottle).tickValues([0, 50, 100]).tickSize(-3).tickFormat((d) => `${d}%`))
    .call((el) => el.select('.domain').remove());

  // Y axis — brake side (downward: 0 → 100%)
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(yBrake).tickValues([50, 100]).tickSize(-3).tickFormat((d) => `${d}%`))
    .call((el) => el.select('.domain').remove());

  // Labels
  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', m.top + 9)
    .text('THROTTLE');

  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', height - m.bottom - 3)
    .text('BRAKE');

  // X axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - m.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat(xTickFormat(xAxisMode)))
    .call((el) => el.select('.domain').remove());

  // ── Throttle area (transparent fill) + line (solid border) ──
  const throttleArea = d3.area()
    .x((d) => xScale(d.Distance))
    .y0(midY)
    .y1((d) => yThrottle(d.Throttle != null ? d.Throttle : 0))
    .defined((d) => d.Distance != null)
    .curve(d3.curveMonotoneX);

  const throttleLine = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => yThrottle(d.Throttle != null ? d.Throttle : 0))
    .defined((d) => d.Distance != null)
    .curve(d3.curveMonotoneX);

  // ── Brake area (transparent fill, inverted) + line (solid border) ──
  const brakeArea = d3.area()
    .x((d) => xScale(d.Distance))
    .y0(midY)
    .y1((d) => {
      const v = d.Brake != null ? (typeof d.Brake === 'boolean' ? (d.Brake ? 100 : 0) : d.Brake) : 0;
      return yBrake(v);
    })
    .defined((d) => d.Distance != null)
    .curve(d3.curveMonotoneX);

  const brakeLine = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => {
      const v = d.Brake != null ? (typeof d.Brake === 'boolean' ? (d.Brake ? 100 : 0) : d.Brake) : 0;
      return yBrake(v);
    })
    .defined((d) => d.Distance != null)
    .curve(d3.curveMonotoneX);

  traces.forEach((t) => {
    const opacity = t.isDimmed ? 0.15 : (t.lapOpacity || 1);
    const throttleColor = t.isFocus && !t.lapDashed ? '#00e676' : t.color;
    const brakeColor = t.isFocus && !t.lapDashed ? '#e10600' : t.color;

    // Area fill only for focus/reference (not dashed comparison laps)
    if (!t.lapDashed) {
      g.append('path').datum(t.data)
        .attr('class', t.isFocus ? 'telem-throttle-area telem-throttle-area--focus' : 'telem-throttle-area')
        .attr('d', throttleArea)
        .attr('fill', throttleColor)
        .attr('opacity', t.isDimmed ? 0.08 : null);

      g.append('path').datum(t.data)
        .attr('class', t.isFocus ? 'telem-brake-area telem-brake-area--focus' : 'telem-brake-area')
        .attr('d', brakeArea)
        .attr('fill', brakeColor)
        .attr('opacity', t.isDimmed ? 0.08 : null);
    }

    // Lines
    const tLine = g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-throttle-line telem-throttle-line--focus' : 'telem-throttle-line')
      .attr('d', throttleLine)
      .attr('stroke', throttleColor)
      .attr('opacity', opacity);
    if (t.lapDashed) tLine.attr('stroke-dasharray', '6,3').attr('stroke-width', 1.2);

    const bLine = g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-brake-line telem-brake-line--focus' : 'telem-brake-line')
      .attr('d', brakeLine)
      .attr('stroke', brakeColor)
      .attr('opacity', opacity);
    if (t.lapDashed) bLine.attr('stroke-dasharray', '6,3').attr('stroke-width', 1.2);
  });
}

function renderGearChart(svgEl, traces, xScale, margin, sectorBoundaries, xAxisMode) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  const yScale = d3.scaleLinear().domain([0, 8]).range([height - m.bottom, m.top]);

  drawSectorLines(g, sectorBoundaries, xScale, m.top, height - m.bottom);

  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', m.top + 9)
    .text('GEAR');

  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(yScale).tickValues([1, 2, 3, 4, 5, 6, 7, 8]).tickSize(-3).tickFormat(d3.format('d')))
    .call((el) => el.select('.domain').remove());

  // X axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - m.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat(xTickFormat(xAxisMode)))
    .call((el) => el.select('.domain').remove());

  const line = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => yScale(d.nGear != null ? d.nGear : 0))
    .defined((d) => d.Distance != null && d.nGear != null)
    .curve(d3.curveStepAfter);

  traces.forEach((t) => {
    const opacity = t.isDimmed ? 0.15 : (t.lapOpacity || 1);
    const path = g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-gear-line telem-gear-line--focus' : 'telem-gear-line')
      .attr('d', line).attr('stroke', t.color)
      .attr('opacity', opacity);
    if (t.lapDashed) path.attr('stroke-dasharray', '6,3').attr('stroke-width', 1.2);
  });
}

function renderRPMChart(svgEl, traces, xScale, margin, sectorBoundaries, xAxisMode) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;

  const rpmMargin = { ...margin, bottom: 14 };

  let yMin = Infinity, yMax = -Infinity;
  for (const t of traces) {
    for (const d of t.data) {
      if (!inDomain(t, d)) continue;
      if (d.RPM != null && d.RPM > 0) {
        if (d.RPM < yMin) yMin = d.RPM;
        if (d.RPM > yMax) yMax = d.RPM;
      }
    }
  }

  if (yMin === Infinity) {
    g.append('text').attr('class', 'telem-chart-label')
      .attr('x', margin.left + 4).attr('y', height / 2 + 3)
      .text('RPM — no data available');

    g.append('g').attr('class', 'telem-axis')
      .attr('transform', `translate(0,${height - rpmMargin.bottom})`)
      .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat(xTickFormat(xAxisMode)))
      .call((el) => el.select('.domain').remove());
    return;
  }

  const pad = (yMax - yMin) * 0.05 || 500;
  const yScale = d3.scaleLinear()
    .domain([yMin - pad, yMax + pad])
    .range([height - rpmMargin.bottom, rpmMargin.top]);

  yScale.ticks(3).forEach((tick) => {
    g.append('line').attr('class', 'telem-grid-line')
      .attr('x1', margin.left).attr('x2', width - margin.right)
      .attr('y1', yScale(tick)).attr('y2', yScale(tick));
  });

  drawSectorLines(g, sectorBoundaries, xScale, rpmMargin.top, height - rpmMargin.bottom);

  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', margin.left + 4).attr('y', rpmMargin.top + 9)
    .text('RPM');

  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(${margin.left},0)`)
    .call(d3.axisLeft(yScale).ticks(3).tickSize(-3).tickFormat(d3.format('.0f')))
    .call((el) => el.select('.domain').remove());

  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - rpmMargin.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat(xTickFormat(xAxisMode)))
    .call((el) => el.select('.domain').remove());

  g.append('text').attr('class', 'telem-chart-label telem-chart-label--right')
    .attr('x', width - margin.right - 4).attr('y', height - rpmMargin.bottom - 4)
    .attr('text-anchor', 'end')
    .text(xAxisMode === 'time' ? 'Lap time (s)' : 'Distance (m)');

  const line = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => yScale(d.RPM))
    .defined((d) => d.Distance != null && d.RPM != null && d.RPM > 0)
    .curve(d3.curveMonotoneX);

  traces.forEach((t) => {
    const opacity = t.isDimmed ? 0.15 : (t.lapOpacity || 1);
    const path = g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-rpm-line telem-rpm-line--focus' : 'telem-rpm-line')
      .attr('d', line).attr('stroke', t.color)
      .attr('opacity', opacity);
    if (t.lapDashed) path.attr('stroke-dasharray', '6,3').attr('stroke-width', 1.2);
  });
}
