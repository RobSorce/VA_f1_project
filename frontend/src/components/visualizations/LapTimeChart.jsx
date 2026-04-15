import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, countryFlag } from '../../utils/colors';
import Panel from '../ui/Panel';

/* ── Color codes for sector/lap timing (F1 TV convention) ───────── */
const TIME_COLORS = {
  overall_best: '#A020F0', // Purple — overall best in the session
  personal_best: '#00FF00', // Green — personal best
  normal: 'rgba(255,255,255,0.75)', // White/grey — normal
  slow: '#FFD700', // Yellow — significantly slower
  pit: '#e040fb', // Magenta — pit lap
};

/* ── Team name → logo file mapping (handles FastF1 name variations) */
const TEAM_LOGO_MAP = {
  'McLaren': '/team-logos/mclaren.png',
  'Ferrari': '/team-logos/ferrari.png',
  'Red Bull Racing': '/team-logos/red-bull.png',
  'Red Bull': '/team-logos/red-bull.png',
  'Mercedes': '/team-logos/mercedes.png',
  'Aston Martin': '/team-logos/aston-martin.jpg',
  'Alpine': '/team-logos/alpine.png',
  'Alpine F1 Team': '/team-logos/alpine.png',
  'Williams': '/team-logos/williams.png',
  'Haas F1 Team': '/team-logos/haas.png',
  'Haas': '/team-logos/haas.png',
  'RB': '/team-logos/rb.png',
  'Racing Bulls': '/team-logos/rb.png',
  'AlphaTauri': '/team-logos/rb.png',
  'Kick Sauber': '/team-logos/kick-sauber.png',
  'Stake F1 Team Kick Sauber': '/team-logos/kick-sauber.png',
  'Alfa Romeo': '/team-logos/kick-sauber.png',
  'Sauber': '/team-logos/kick-sauber.png',
};

/* ── Column definitions for resizable grid ──────────────────────── */
const COLUMN_DEFS = [
  { key: 'pos',     label: 'P',              defaultW: 30,  minW: 24,  resizable: false, align: 'center' },
  { key: 'bar',     label: '',               defaultW: 3,   minW: 3,   resizable: false, align: 'center' },
  { key: 'team',    label: 'Team',           defaultW: 38,  minW: 22,  resizable: true,  align: 'center' },
  { key: 'driver',  label: 'Driver',         defaultW: 170, minW: 70,  resizable: true,  align: 'flex-start' },
  { key: 's1',      label: 'S1',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 's2',      label: 'S2',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 's3',      label: 'S3',             defaultW: 72,  minW: 48,  resizable: true,  align: 'flex-end' },
  { key: 'lapTime', label: 'Lap Time',       defaultW: 96,  minW: 56,  resizable: true,  align: 'flex-end' },
  { key: 'gap',     label: 'Gap to fastest', defaultW: 96,  minW: 56,  resizable: true,  align: 'flex-end' },
  { key: 'tyre',    label: 'Tyre',           defaultW: 54,  minW: 36,  resizable: true,  align: 'center' },
  { key: 'laps',    label: 'Laps',           defaultW: 38,  minW: 28,  resizable: true,  align: 'center' },
];

/* ── Format seconds to M:SS.sss ─────────────────────────────────── */
function fmtTime(s) {
  if (!s || s <= 0 || s > 600) return '—';
  const min = Math.floor(s / 60);
  const sec = (s % 60).toFixed(3);
  return min > 0 ? `${min}:${sec.padStart(6, '0')}` : sec;
}

function fmtSector(s) {
  if (!s || s <= 0 || s > 120) return '—';
  return s.toFixed(3);
}

function fmtGap(gap) {
  if (gap == null || gap === 0) return '';
  if (typeof gap === 'string') return gap;
  if (!isFinite(gap)) return '—';
  return gap > 0 ? `+${gap.toFixed(3)}` : gap.toFixed(3);
}

export default function LapTimeChart() {
  const timingContainerRef = useRef(null);
  const speedSvgRef = useRef(null);
  const speedDataRef = useRef(null);

  const [chartMode, setChartMode] = useState('laptimes'); // 'laptimes' | 'speed'
  const [speedData, setSpeedData] = useState(null);       // { driver, distance[], speed[] }[]
  const [speedLoading, setSpeedLoading] = useState(false);
  const [playheadX, setPlayheadX] = useState(null);       // pixel X position

  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const currentLap = useF1Store((s) => s.currentLap);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const triggerPrediction = useF1Store((s) => s.triggerPrediction);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const currentTime = useF1Store((s) => s.currentTime);
  const drivers = useF1Store((s) => s.drivers);
  const maxLap = useF1Store((s) => s.maxLap);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const fetchDriverTelemetry = useF1Store((s) => s.fetchDriverTelemetry);
  const setTrackProgress = useF1Store((s) => s.setTrackProgress);
  const brushLapRange = useF1Store((s) => s.brushLapRange);

  const sessionType = useF1Store((s) => s.sessionType);
  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const raceTarget = totalRaceLaps || maxLap;
  const raceFinished = isLiveMode
    ? (currentLap >= raceTarget && raceTarget > 1 && currentLap > 2)
    : (currentLap >= maxLap && maxLap > 1);
  const isQualifying = sessionType === 'Q';

  // Qualifying segment filter
  const [qualiFilter, setQualiFilter] = useState('ALL');

  // Compute qualifying segments from race_results positions
  const qualiSegmentMap = useMemo(() => {
    if (!isQualifying) return {};
    const map = {};
    (sessionData?.race_results || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      const pos = r.Position || r.ClassifiedPosition || 99;
      if (!abbr) return;
      if (pos > 15) map[abbr] = 'Q1';
      else if (pos > 10) map[abbr] = 'Q2';
      else map[abbr] = 'Q3';
    });
    return map;
  }, [isQualifying, sessionData]);

  /* ── Country code map from race_results ──────────────────────── */
  const countryCodeMap = useMemo(() => {
    const map = {};
    (sessionData?.race_results || []).forEach((r) => {
      const abbr = r.Abbreviation || r.Driver;
      if (abbr && r.CountryCode) map[abbr] = r.CountryCode;
    });
    return map;
  }, [sessionData]);

  /* ── Driver info lookup: abbreviation → { fullName, firstName, surname, teamName, teamLogo } */
  const driverInfoMap = useMemo(() => {
    const map = {};
    (drivers || []).forEach((d) => {
      const full = d.FullName || d.Abbreviation;
      const parts = full.trim().split(/\s+/);
      const surname = parts.length > 1 ? parts.slice(-1)[0] : full;
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
      map[d.Abbreviation] = {
        fullName: full,
        firstName,
        surname,
        teamName: d.TeamName || '',
        teamLogo: TEAM_LOGO_MAP[d.TeamName] || null,
      };
    });
    return map;
  }, [drivers]);

  // Replay mode: data shown incrementally while frames are loaded.
  // Only fall back to "review mode" (show everything) when no frames exist at all.
  const replayActive = totalFrames > 0;

  // Compute time offset: session times (e.g. Sector1SessionTime ~3500s) vs frame times (0-based)
  const sessionTimeOffset = useMemo(() => {
    if (lapTimes.length === 0) return 0;
    for (const d of lapTimes) {
      if (d.LapStartTime > 0 && (d.Time > 0 || d.LapTimeSeconds > 0) && d.LapNumber >= 1) {
        return d.LapStartTime;
      }
    }
    return 0;
  }, [lapTimes]);
  const hasTimeOffset = sessionTimeOffset > 0;

  /* ── Compute session-wide bests for color coding (incremental) ── */
  const sessionBests = useMemo(() => {
    let bestS1 = Infinity, bestS2 = Infinity, bestS3 = Infinity, bestLap = Infinity;
    let fastestLapDriver = null;
    const personalBests = {}; // { driver: { s1, s2, s3, lap } }

    // When replay is active, filter progressively; otherwise show all data (review mode)
    const effectiveLap = replayActive ? currentLap : Infinity;
    lapTimes.filter((d) => d.LapNumber <= effectiveLap).forEach((d) => {
      // During replay: skip laps the driver hasn't started yet
      if (replayActive && hasTimeOffset && d.LapStartTime > 0 && currentTime < d.LapStartTime - sessionTimeOffset) return;
      const drv = d.Driver;
      if (!personalBests[drv]) personalBests[drv] = { s1: Infinity, s2: Infinity, s3: Infinity, lap: Infinity };

      // Only include sector times that have actually been completed (during replay)
      const s1ok = !replayActive || !d.Sector1SessionTime || currentTime >= d.Sector1SessionTime - sessionTimeOffset;
      const s2ok = !replayActive || !d.Sector2SessionTime || currentTime >= d.Sector2SessionTime - sessionTimeOffset;
      const s3ok = !replayActive || !d.Sector3SessionTime || currentTime >= d.Sector3SessionTime - sessionTimeOffset;

      const s1 = s1ok ? d.Sector1TimeSeconds : 0;
      const s2 = s2ok ? d.Sector2TimeSeconds : 0;
      const s3 = s3ok ? d.Sector3TimeSeconds : 0;
      const lap = s3ok ? d.LapTimeSeconds : 0;

      if (s1 > 0 && s1 < 120) {
        if (s1 < bestS1) bestS1 = s1;
        if (s1 < personalBests[drv].s1) personalBests[drv].s1 = s1;
      }
      if (s2 > 0 && s2 < 120) {
        if (s2 < bestS2) bestS2 = s2;
        if (s2 < personalBests[drv].s2) personalBests[drv].s2 = s2;
      }
      if (s3 > 0 && s3 < 120) {
        if (s3 < bestS3) bestS3 = s3;
        if (s3 < personalBests[drv].s3) personalBests[drv].s3 = s3;
      }
      if (lap > 0 && lap < 300) {
        if (lap < bestLap) { bestLap = lap; fastestLapDriver = drv; }
        if (lap < personalBests[drv].lap) personalBests[drv].lap = lap;
      }
    });

    return { bestS1, bestS2, bestS3, bestLap, fastestLapDriver, personalBests };
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, replayActive, hasTimeOffset]);

  /* ── Get time color (purple / green / yellow / white) ───────── */
  const getTimeColor = useCallback((value, sessionBest, personalBest, isPit) => {
    if (isPit) return TIME_COLORS.pit;
    if (!value || value <= 0 || value > 300) return TIME_COLORS.normal;
    const tolerance = 0.001;
    if (Math.abs(value - sessionBest) < tolerance) return TIME_COLORS.overall_best;
    if (Math.abs(value - personalBest) < tolerance) return TIME_COLORS.personal_best;
    return TIME_COLORS.normal;
  }, []);

  /* ── Speed Trace: fetch telemetry when mode is 'speed' ─────── */
  useEffect(() => {
    if (chartMode !== 'speed' || !focusDriver || !sessionData) return;

    const driverLaps = lapTimes.filter(d =>
      d.Driver === focusDriver && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300 && d.LapNumber <= currentLap
    );
    if (!driverLaps.length) return;
    const latestLap = Math.max(...driverLaps.map(d => d.LapNumber));

    const driversToFetch = [focusDriver, ...selectedDrivers.filter(d => d !== focusDriver).slice(0, 2)];

    setSpeedLoading(true);
    Promise.all(
      driversToFetch.map(driver =>
        fetchDriverTelemetry(driver, latestLap)
          .then(telemetry => {
            if (!telemetry?.length) return null;
            return {
              driver,
              distance: telemetry.map(t => t.Distance),
              speed: telemetry.map(t => t.Speed),
            };
          })
          .catch(() => null)
      )
    ).then(results => {
      const valid = results.filter(Boolean);
      setSpeedData(valid);
      speedDataRef.current = valid;
      setSpeedLoading(false);
    });
  }, [chartMode, focusDriver, selectedDrivers, sessionData, lapTimes, currentLap, fetchDriverTelemetry]);

  /* ── Speed Trace: D3 render ────────────────────────────────── */
  useEffect(() => {
    if (chartMode !== 'speed' || !speedData?.length || !speedSvgRef.current) return;

    const container = speedSvgRef.current.parentElement;
    const { width: W, height: H } = container.getBoundingClientRect();
    if (W < 80 || H < 60) return;

    const margin = { top: 20, right: 16, bottom: 30, left: 48 };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;

    const svg = d3.select(speedSvgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const maxDistance = d3.max(speedData, d => d3.max(d.distance)) || 5000;
    const maxSpeed = d3.max(speedData, d => d3.max(d.speed)) || 350;

    const xScale = d3.scaleLinear().domain([0, maxDistance]).range([0, innerW]);
    const yScale = d3.scaleLinear().domain([0, maxSpeed * 1.08]).range([innerH, 0]);

    // Grid lines
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6).tickSize(-innerW).tickFormat(''))
      .attr('color', 'rgba(255,255,255,0.04)')
      .select('.domain').remove();

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(xScale).ticks(8).tickFormat(d => `${Math.round(d)}m`))
      .attr('color', 'rgba(255,255,255,0.4)')
      .selectAll('text')
      .style('font-size', '8px')
      .attr('fill', 'rgba(255,255,255,0.4)');

    // X axis label
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', innerW / 2).attr('y', innerH + margin.bottom - 4)
      .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px')
      .attr('font-weight', 600).text('Distance (m)');

    // Y axis
    g.append('g')
      .call(d3.axisLeft(yScale).ticks(6).tickFormat(d => `${Math.round(d)}`))
      .attr('color', 'rgba(255,255,255,0.4)')
      .selectAll('text')
      .style('font-size', '8px')
      .attr('fill', 'rgba(255,255,255,0.4)');

    // Y axis label
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', `rotate(-90)`)
      .attr('x', -innerH / 2).attr('y', -margin.left + 12)
      .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px')
      .attr('font-weight', 600).text('Speed (km/h)');

    // Speed lines
    const line = d3.line().defined(d => d[1] > 0).curve(d3.curveMonotoneX);

    speedData.forEach((driverData) => {
      const isFocus = driverData.driver === focusDriver;
      const color = getDriverColor(driverData.driver);
      const points = driverData.distance.map((dist, i) => [xScale(dist), yScale(driverData.speed[i])]);

      g.append('path')
        .datum(points)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', isFocus ? 2.5 : 1.5)
        .attr('opacity', isFocus ? 1 : 0.4);

      // Driver label at end of line
      if (points.length > 0) {
        const lastPt = points[points.length - 1];
        g.append('text')
          .attr('x', lastPt[0] - 4)
          .attr('y', lastPt[1] - 6)
          .attr('fill', color)
          .attr('font-size', '8px')
          .attr('font-weight', 700)
          .attr('text-anchor', 'end')
          .attr('opacity', isFocus ? 1 : 0.5)
          .text(driverData.driver);
      }
    });

    // Peak speed line for focus driver
    const focusData = speedData.find(d => d.driver === focusDriver);
    if (focusData) {
      const peakSpeed = d3.max(focusData.speed);
      if (peakSpeed) {
        const peakY = yScale(peakSpeed);
        g.append('line')
          .attr('x1', 0).attr('x2', innerW)
          .attr('y1', peakY).attr('y2', peakY)
          .attr('stroke', 'rgba(255,255,255,0.25)')
          .attr('stroke-dasharray', '4 3')
          .attr('stroke-width', 1);
        g.append('text')
          .attr('x', innerW - 2).attr('y', peakY - 4)
          .attr('text-anchor', 'end')
          .attr('fill', 'rgba(255,255,255,0.6)')
          .attr('font-size', '9px')
          .attr('font-weight', 700)
          .attr('font-family', "var(--font-mono, monospace)")
          .text(`\u25B2 ${Math.round(peakSpeed)} km/h`);
      }
    }

    // Playhead group
    const playheadG = g.append('g').attr('class', 'speed-playhead').style('display', 'none');
    playheadG.append('line')
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', '#fff').attr('stroke-width', 1)
      .attr('stroke-dasharray', '3 2').attr('opacity', 0.8);
    playheadG.append('rect')
      .attr('y', -16).attr('rx', 3).attr('ry', 3)
      .attr('height', 14).attr('fill', 'rgba(10,10,30,0.9)')
      .attr('stroke', 'rgba(255,255,255,0.2)').attr('stroke-width', 0.5);
    playheadG.append('text')
      .attr('y', -6).attr('fill', '#fff')
      .attr('font-size', '9px').attr('font-weight', 700)
      .attr('font-family', "var(--font-mono, monospace)")
      .attr('text-anchor', 'middle');

    // Store refs for mouse handler
    svg._scales = { xScale, yScale, margin, innerW, innerH, maxDistance };
    svg._playheadG = playheadG;

    // Mouse interaction
    const hitArea = g.append('rect')
      .attr('width', innerW).attr('height', innerH)
      .attr('fill', 'transparent').attr('cursor', 'crosshair');

    hitArea
      .on('mousemove', function (event) {
        const [mx] = d3.pointer(event);
        const dist = xScale.invert(mx);
        const fraction = Math.max(0, Math.min(1, dist / maxDistance));
        setTrackProgress(fraction);

        // Find nearest speed for focus driver
        const fd = speedDataRef.current?.find(d => d.driver === focusDriver);
        if (!fd) return;
        let nearIdx = 0;
        let minDiff = Infinity;
        for (let i = 0; i < fd.distance.length; i++) {
          const diff = Math.abs(fd.distance[i] - dist);
          if (diff < minDiff) { minDiff = diff; nearIdx = i; }
        }
        const spd = fd.speed[nearIdx];
        const px = xScale(fd.distance[nearIdx]);

        playheadG.style('display', null);
        playheadG.attr('transform', `translate(${px},0)`);
        playheadG.select('line').attr('y2', innerH);
        const label = `${Math.round(spd)} km/h`;
        const txt = playheadG.select('text').text(label);
        const txtLen = txt.node().getComputedTextLength();
        playheadG.select('rect')
          .attr('x', -txtLen / 2 - 5)
          .attr('width', txtLen + 10);
        txt.attr('x', 0);
      })
      .on('mouseleave', function () {
        playheadG.style('display', 'none');
        setTrackProgress(null);
      });

  }, [chartMode, speedData, focusDriver, setTrackProgress]);

  /* ── Speed Trace: replay sync ──────────────────────────────── */
  useEffect(() => {
    if (chartMode !== 'speed' || !replayActive) return;
    if (!speedData?.length || !speedSvgRef.current) return;
    const svg = d3.select(speedSvgRef.current);
    const scales = svg._scales;
    const playheadG = svg._playheadG;
    if (!scales || !playheadG) return;

    // Estimate fraction from currentFrameIndex / totalFrames
    const fraction = totalFrames > 0 ? currentFrameIndex / totalFrames : 0;
    setTrackProgress(fraction);

    const dist = fraction * scales.maxDistance;
    const px = scales.xScale(dist);

    const fd = speedDataRef.current?.find(d => d.driver === focusDriver);
    if (!fd) return;
    let nearIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < fd.distance.length; i++) {
      const diff = Math.abs(fd.distance[i] - dist);
      if (diff < minDiff) { minDiff = diff; nearIdx = i; }
    }
    const spd = fd.speed[nearIdx];

    playheadG.style('display', null);
    playheadG.attr('transform', `translate(${px},0)`);
    const label = `${Math.round(spd)} km/h`;
    const txt = playheadG.select('text').text(label);
    const txtLen = txt.node().getComputedTextLength();
    playheadG.select('rect')
      .attr('x', -txtLen / 2 - 5)
      .attr('width', txtLen + 10);
  }, [chartMode, replayActive, currentFrameIndex, totalFrames, speedData, focusDriver, setTrackProgress]);

  /* ── Build timing rows for current lap ──────────────────────── */
  const timingRows = useMemo(() => {
    if (lapTimes.length === 0) return [];

    const effectiveLap = replayActive ? currentLap : Infinity;
    // When brushLapRange is set from PositionByLap, restrict to that window
    const brushMin = brushLapRange ? brushLapRange[0] : 0;
    const brushMax = brushLapRange ? brushLapRange[1] : Infinity;
    const drivers = new Map();
    lapTimes
      .filter((d) => d.LapNumber <= effectiveLap && d.LapNumber >= brushMin && d.LapNumber <= brushMax)
      .forEach((d) => {
        // During replay: skip laps the driver hasn't started yet
        if (replayActive && hasTimeOffset && d.LapStartTime > 0 && currentTime < d.LapStartTime - sessionTimeOffset) return;
        const existing = drivers.get(d.Driver);
        if (!existing || d.LapNumber > existing.LapNumber) {
          drivers.set(d.Driver, d);
        }
      });

    return Array.from(drivers.values())
      .map((d) => {
        const pb = sessionBests.personalBests[d.Driver] || {};
        // Pit status: verify pit entry/exit have actually happened in the timeline
        const pitInAdj = d.PitInTime > 0 ? d.PitInTime - sessionTimeOffset : null;
        const pitOutAdj = d.PitOutTime > 0 ? d.PitOutTime - sessionTimeOffset : null;
        const isPit = (pitInAdj != null && currentTime >= pitInAdj) ||
                      (pitOutAdj != null && currentTime >= pitOutAdj);
        const dnf = dnfMap[d.Driver];
        const isRetired = !!(dnf && dnf.lastLap <= currentLap);
        const info = driverInfoMap[d.Driver] || {};

        // Sector-by-sector progressive reveal for the current lap (only during replay)
        // In review mode (replay not active), show everything
        const isCurrentLap = replayActive && d.LapNumber === currentLap;
        // Convert session times to frame-relative times by subtracting offset
        const s1Time = d.Sector1SessionTime > 0 ? d.Sector1SessionTime - sessionTimeOffset : null;
        const s2Time = d.Sector2SessionTime > 0 ? d.Sector2SessionTime - sessionTimeOffset : null;
        const s3Time = d.Sector3SessionTime > 0 ? d.Sector3SessionTime - sessionTimeOffset : null;

        // For current lap: use session time comparison if available, otherwise
        // fall back to showing sector if its data exists (> 0) — prevents blank sectors
        // when Sector*SessionTime is null in the data
        const showS1 = !isCurrentLap || (s1Time != null ? currentTime >= s1Time : d.Sector1TimeSeconds > 0);
        const showS2 = !isCurrentLap || (s2Time != null ? currentTime >= s2Time : d.Sector2TimeSeconds > 0);
        const showS3 = !isCurrentLap || (s3Time != null ? currentTime >= s3Time : d.Sector3TimeSeconds > 0);
        const showLapTime = !isCurrentLap || showS3; // lap time available when S3 completes

        const s1 = showS1 ? d.Sector1TimeSeconds : null;
        const s2 = showS2 ? d.Sector2TimeSeconds : null;
        const s3 = showS3 ? d.Sector3TimeSeconds : null;
        const lapTime = showLapTime ? d.LapTimeSeconds : null;

        // Live chronometer: compute running sector time for the current lap
        let chrono = null; // { sector: 1|2|3, elapsed: seconds }
        if (isCurrentLap && hasTimeOffset) {
          const lapStart = d.LapStartTime > 0 ? d.LapStartTime - sessionTimeOffset : null;
          if (!showS1 && lapStart != null) {
            // In S1 — counting from lap start
            chrono = { sector: 1, elapsed: Math.max(0, currentTime - lapStart) };
          } else if (showS1 && !showS2 && s1Time != null) {
            // S1 done, in S2 — counting from S1 completion
            chrono = { sector: 2, elapsed: Math.max(0, currentTime - s1Time) };
          } else if (showS2 && !showS3 && s2Time != null) {
            // S2 done, in S3 — counting from S2 completion
            chrono = { sector: 3, elapsed: Math.max(0, currentTime - s2Time) };
          }
        }

        return {
          pos: d.Position || 99,
          driver: d.Driver,
          firstName: info.firstName || '',
          surname: info.surname || d.Driver,
          teamLogo: info.teamLogo || null,
          color: getDriverColor(d.Driver),
          lap: d.LapNumber,
          s1,
          s2,
          s3,
          lapTime,
          chrono,
          gap: showLapTime ? (d.GapToLeader || null) : null,
          interval: showLapTime ? (d.IntervalToAhead || null) : null,
          compound: d.Compound || '',
          tyreLife: d.TyreLife || 0,
          isPit,
          isRetired,
          isCurrentLap,
          retiredStatus: dnf?.status || '',
          s1Color: isRetired ? TIME_COLORS.normal : (showS1 ? getTimeColor(d.Sector1TimeSeconds, sessionBests.bestS1, pb.s1, isPit) : TIME_COLORS.normal),
          s2Color: isRetired ? TIME_COLORS.normal : (showS2 ? getTimeColor(d.Sector2TimeSeconds, sessionBests.bestS2, pb.s2, isPit) : TIME_COLORS.normal),
          s3Color: isRetired ? TIME_COLORS.normal : (showS3 ? getTimeColor(d.Sector3TimeSeconds, sessionBests.bestS3, pb.s3, isPit) : TIME_COLORS.normal),
          lapColor: isRetired ? TIME_COLORS.normal : (showLapTime ? getTimeColor(d.LapTimeSeconds, sessionBests.bestLap, pb.lap, isPit) : TIME_COLORS.normal),
          qualiSegment: qualiSegmentMap[d.Driver] || null,
        };
      })
      .sort((a, b) => {
        // Active drivers first (by position), retired drivers at bottom
        if (a.isRetired && !b.isRetired) return 1;
        if (!a.isRetired && b.isRetired) return -1;
        return (a.pos || 99) - (b.pos || 99);
      });
  }, [lapTimes, currentLap, currentTime, sessionTimeOffset, sessionBests, getTimeColor, dnfMap, replayActive, hasTimeOffset, driverInfoMap, qualiSegmentMap, brushLapRange]);

  /* ── All drivers shown; qualifying filter applied if active ── */
  const displayRows = useMemo(() => {
    if (!isQualifying || qualiFilter === 'ALL') return timingRows;
    return timingRows.filter((r) => r.qualiSegment === qualiFilter);
  }, [timingRows, isQualifying, qualiFilter]);

  /* ── Resizable column widths ────────────────────────────────── */
  const [colWidths, setColWidths] = useState(() => COLUMN_DEFS.map((c) => c.defaultW));
  const colWidthsRef = useRef(colWidths);
  colWidthsRef.current = colWidths;

  const gridColumns = colWidths.map((w) => `${w}px`).join(' ');

  const onResizeStart = useCallback((colIdx, e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidthsRef.current[colIdx];

    const onMouseMove = (ev) => {
      const delta = ev.clientX - startX;
      const newW = Math.max(COLUMN_DEFS[colIdx].minW, startW + delta);
      setColWidths((prev) => {
        const next = [...prev];
        next[colIdx] = newW;
        return next;
      });
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  /* ── Dynamic row sizing based on available height ──────────── */
  const [timingHeight, setTimingHeight] = useState(500);
  useEffect(() => {
    if (!timingContainerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const h = entries[0].contentRect.height;
      if (h > 0) setTimingHeight(h);
    });
    obs.observe(timingContainerRef.current);
    return () => obs.disconnect();
  }, []);

  const rowCount = displayRows.length || 20;
  const rowBudget = rowCount > 0 ? timingHeight / rowCount : 28;
  // Row padding: shrink from 2px to 0px as space gets tight
  const rowPadV = Math.max(0, Math.min(2, Math.floor((rowBudget - 18) / 2)));
  // Font sizes: shrink when rows are very tight
  const compactTiming = rowBudget < 22;
  const rowFontSize = compactTiming ? '9px' : '10px';
  const rowLapFontSize = compactTiming ? '9px' : '11px';

  /* ── Render ─────────────────────────────────────────────────── */
  const headerStyle = {
    display: 'grid',
    gridTemplateColumns: gridColumns,
    gap: '2px',
    padding: '4px 6px',
    background: 'rgba(26, 31, 51, 0.6)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    fontSize: '9px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    userSelect: 'none',
    flexShrink: 0,
  };

  const cellStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    fontSize: rowFontSize,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };

  const controls = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '9px' }}>
      <button
        className={`lap-chart-mode-toggle${chartMode === 'speed' ? ' lap-chart-mode-toggle--active' : ''}`}
        onClick={() => setChartMode(m => m === 'laptimes' ? 'speed' : 'laptimes')}
        title={chartMode === 'laptimes' ? 'Switch to Speed Trace' : 'Switch to Lap Times'}
      >
        {chartMode === 'laptimes' ? '\u26A1 SPEED' : '\u23F1 TIMES'}
      </button>
      {isQualifying && (
        <>
          {['ALL', 'Q1', 'Q2', 'Q3'].map((seg) => (
            <button
              key={seg}
              onClick={() => setQualiFilter(seg)}
              style={{
                padding: '2px 6px', borderRadius: 4, border: 'none',
                fontSize: '9px', fontWeight: 700, cursor: 'pointer',
                background: qualiFilter === seg ? 'rgba(255,255,255,0.15)' : 'transparent',
                color: qualiFilter === seg ? '#fff' : 'rgba(255,255,255,0.4)',
              }}
            >{seg}</button>
          ))}
          <span style={{ width: 1, height: 12, background: 'rgba(255,255,255,0.1)' }} />
        </>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.overall_best }} />
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>Best</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.personal_best }} />
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>PB</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: TIME_COLORS.pit }} />
        <span style={{ color: 'rgba(255,255,255,0.5)' }}>Pit</span>
      </span>
    </div>
  );

  const brushTitle = brushLapRange
    ? `Timing Sheet  (LAP ${brushLapRange[0]}–${brushLapRange[1]})`
    : 'Timing Sheet';

  return (
    <Panel title={brushTitle} controls={controls} focused={focusedView === 'laptimes'} shortcutKey="2" style={brushLapRange ? { borderColor: 'rgba(225,6,0,0.35)' } : undefined}>
      {chartMode === 'speed' ? (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
          {speedLoading && !speedData?.length && (
            <div className="speed-trace-loading">Loading telemetry\u2026</div>
          )}
          {!focusDriver && !speedLoading && (
            <div className="speed-trace-loading">Double-click a driver to see speed trace</div>
          )}
          <svg
            ref={speedSvgRef}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </div>
      ) : (
      <>
      {/* Column headers with drag-to-resize handles */}
      <div style={headerStyle}>
        {COLUMN_DEFS.map((col, i) => (
          <div
            key={col.key}
            style={{
              position: 'relative',
              display: 'flex',
              justifyContent: col.align,
              alignItems: 'center',
              ...(col.key === 'gap' ? { fontSize: '8px' } : {}),
              ...(col.key === 'driver' ? { paddingLeft: 2 } : {}),
            }}
          >
            {col.label}
            {col.resizable && (
              <div
                onMouseDown={(e) => onResizeStart(i, e)}
                style={{
                  position: 'absolute',
                  right: -2,
                  top: 0,
                  bottom: 0,
                  width: 5,
                  cursor: 'col-resize',
                  zIndex: 2,
                  background: 'transparent',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              />
            )}
          </div>
        ))}
      </div>

      {/* Timing rows */}
      <div ref={timingContainerRef} style={{
        flex: 1,
        overflow: 'hidden',
        minHeight: 0,
      }}>
        {displayRows.length === 0 && (
          <div className="loading-placeholder">
            <span>Load a session to see timing data</span>
          </div>
        )}

        {displayRows.map((row) => {
          const isHighlighted = row.driver === highlightedDriver;
          const isFocused = row.driver === focusDriver;
          const isSelected = selectedDrivers.includes(row.driver);
          const isOdd = row.pos % 2 === 1;
          const retiredOpacity = row.isRetired ? 0.4 : 1;

          return (
            <div
              key={row.driver}
              style={{
                display: 'grid',
                gridTemplateColumns: gridColumns,
                gap: '2px',
                padding: `${rowPadV}px 6px`,
                cursor: 'pointer',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                opacity: retiredOpacity,
                background: row.isRetired
                  ? 'rgba(255,255,255,0.02)'
                  : isFocused
                    ? 'rgba(255,255,255,0.12)'
                    : isHighlighted
                      ? 'rgba(255,255,255,0.08)'
                      : isSelected
                        ? 'rgba(255,255,255,0.06)'
                        : isOdd
                          ? 'rgba(255,255,255,0.015)'
                          : 'transparent',
                transition: 'background 0.1s ease, opacity 0.3s ease',
                ...(isFocused && !row.isRetired ? {
                  borderLeft: `3px solid ${row.color}`,
                  boxShadow: `inset 4px 0 10px -2px ${row.color}44`,
                } : {}),
              }}
              onClick={() => toggleDriver(row.driver)}
              onDoubleClick={() => { setFocusDriver(row.driver); triggerPrediction(row.driver, currentLap); }}
              onMouseEnter={(e) => setHighlightedDriver(row.driver, { x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHighlightedDriver(null)}
            >
              {/* Position */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: row.isRetired ? '8px' : rowLapFontSize,
                color: row.isRetired ? '#e10600' : '#fff',
                letterSpacing: row.isRetired ? '0.02em' : undefined,
              }}>
                {row.isRetired ? 'RET' : row.pos}
              </span>

              {/* Team color bar */}
              <span style={{
                width: 3,
                alignSelf: 'stretch',
                borderRadius: 1.5,
                background: row.color,
              }} />

              {/* Team logo */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
              }}>
                {row.teamLogo && (
                  <img
                    src={row.teamLogo}
                    alt=""
                    style={{
                      width: compactTiming ? 16 : 20,
                      height: compactTiming ? 16 : 20,
                      objectFit: 'contain',
                      filter: 'brightness(1.1)',
                    }}
                  />
                )}
              </span>

              {/* Driver name: flag (race end) + firstName (light) + SURNAME (bold) */}
              <span style={{
                ...cellStyle,
                justifyContent: 'flex-start',
                fontSize: compactTiming ? '9px' : '10px',
                color: '#fff',
                fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                gap: 3,
              }}>
                {raceFinished && countryCodeMap[row.driver] && (
                  <span style={{ fontSize: '11px', lineHeight: 1 }}>
                    {countryFlag(countryCodeMap[row.driver])}
                  </span>
                )}
                {row.firstName && (
                  <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.55)', fontSize: '9px' }}>
                    {row.firstName}
                  </span>
                )}
                <span style={{ fontWeight: 800, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
                  {row.surname}
                </span>
                {sessionBests.fastestLapDriver === row.driver && (
                  <span style={{
                    fontSize: '7px', marginLeft: 3, padding: '1px 3px',
                    borderRadius: 3, background: 'rgba(160,32,240,0.25)',
                    color: '#A020F0', fontWeight: 800, letterSpacing: '0.04em',
                  }}>FL</span>
                )}
                {isQualifying && row.qualiSegment && (
                  <span style={{
                    fontSize: '7px', marginLeft: 3, padding: '1px 3px',
                    borderRadius: 3, fontWeight: 700, letterSpacing: '0.04em',
                    background: row.qualiSegment === 'Q3' ? 'rgba(160,32,240,0.2)' : row.qualiSegment === 'Q2' ? 'rgba(0,255,0,0.2)' : 'rgba(255,255,255,0.08)',
                    color: row.qualiSegment === 'Q3' ? '#A020F0' : row.qualiSegment === 'Q2' ? '#00FF00' : 'rgba(255,255,255,0.4)',
                  }}>{row.qualiSegment}</span>
                )}
              </span>

              {/* Sector 1 */}
              <span style={{ ...cellStyle, color: row.s1Color, fontWeight: row.s1Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s1 ? fmtSector(row.s1) : row.chrono?.sector === 1 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Sector 2 */}
              <span style={{ ...cellStyle, color: row.s2Color, fontWeight: row.s2Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s2 ? fmtSector(row.s2) : row.chrono?.sector === 2 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Sector 3 */}
              <span style={{ ...cellStyle, color: row.s3Color, fontWeight: row.s3Color !== TIME_COLORS.normal ? 700 : 500 }}>
                {row.s3 ? fmtSector(row.s3) : row.chrono?.sector === 3 ? (
                  <span style={{ color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>{row.chrono.elapsed.toFixed(1)}</span>
                ) : '—'}
              </span>

              {/* Lap Time */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? 'rgba(255,255,255,0.35)' : row.isPit ? TIME_COLORS.pit : row.lapColor,
                fontWeight: 700,
                fontSize: row.isRetired ? '9px' : rowLapFontSize,
              }}>
                {row.isRetired ? row.retiredStatus : row.isPit ? 'PIT' : fmtTime(row.lapTime)}
              </span>

              {/* Gap to fastest */}
              <span style={{
                ...cellStyle,
                color: row.isRetired ? '#e10600' : row.pos === 1 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.55)',
                fontSize: '9px',
                fontWeight: row.isRetired ? 800 : undefined,
              }}>
                {row.isRetired ? 'DNF' : row.pos === 1 ? 'LEADER' : fmtGap(row.gap)}
              </span>

              {/* Tyre compound */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                gap: 3,
              }}>
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: TYRE_COLORS[row.compound] || '#888',
                  flexShrink: 0,
                }} />
                <span style={{
                  fontSize: '8px',
                  fontWeight: 600,
                  color: TYRE_COLORS[row.compound] || '#888',
                }}>
                  {row.compound ? row.compound[0] : '?'}
                </span>
              </span>

              {/* Tyre life */}
              <span style={{
                ...cellStyle,
                justifyContent: 'center',
                color: 'rgba(255,255,255,0.35)',
                fontSize: '9px',
              }}>
                {row.tyreLife}
              </span>
            </div>
          );
        })}

        {/* LSTM predicted rows — show predicted times as table rows */}
        {focusDriver && lstmPredictions && (() => {
          const pred = lstmPredictions[focusDriver] || lstmPredictions?.driver_predictions?.[focusDriver];
          const predTimes = pred?.predicted_times?.filter((t) => t > 0 && t < 300) || [];
          if (predTimes.length === 0) return null;

          const focusRow = displayRows.find((r) => r.driver === focusDriver);
          if (!focusRow) return null;

          const pitProb = pred?.pit_probability;

          return (
            <>
              {/* Prediction header separator */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 8px',
                background: 'rgba(245, 166, 35, 0.06)',
                borderTop: '1px solid rgba(245, 166, 35, 0.15)',
                borderBottom: '1px solid rgba(245, 166, 35, 0.08)',
              }}>
                <span style={{
                  fontSize: '8px', fontWeight: 800, color: '#f5a623',
                  letterSpacing: '0.08em', textTransform: 'uppercase',
                }}>LSTM Forecast</span>
                <span style={{
                  fontSize: '8px', color: 'rgba(255,255,255,0.35)',
                }}>{focusDriver} — next {predTimes.length} laps</span>
                {pitProb != null && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '8px', fontWeight: 700,
                    padding: '1px 5px', borderRadius: 3,
                    background: pitProb > 0.6 ? 'rgba(225,6,0,0.15)' : pitProb > 0.3 ? 'rgba(245,166,35,0.15)' : 'rgba(34,197,94,0.1)',
                    color: pitProb > 0.6 ? '#e10600' : pitProb > 0.3 ? '#f5a623' : '#22c55e',
                  }}>
                    PIT {(pitProb * 100).toFixed(0)}%
                  </span>
                )}
              </div>

              {/* Predicted lap rows */}
              {predTimes.map((time, i) => {
                const predLap = currentLap + i + 1;
                // Compute delta vs last actual lap
                const lastActualTime = focusRow.lapTime;
                const delta = lastActualTime && lastActualTime > 0 ? time - lastActualTime : null;

                return (
                  <div
                    key={`pred-${predLap}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: gridColumns,
                      gap: '2px',
                      padding: '3px 6px',
                      borderBottom: '1px solid rgba(245, 166, 35, 0.06)',
                      background: i % 2 === 0 ? 'rgba(245, 166, 35, 0.03)' : 'rgba(245, 166, 35, 0.015)',
                    }}
                  >
                    {/* Position — show predicted lap number */}
                    <span style={{
                      ...cellStyle, justifyContent: 'center',
                      fontWeight: 700, fontSize: '9px',
                      color: '#f5a623', fontStyle: 'italic',
                    }}>
                      L{predLap}
                    </span>

                    {/* Team color bar */}
                    <span style={{
                      width: 3, alignSelf: 'stretch', borderRadius: 1.5,
                      background: focusRow.color, opacity: 0.5,
                    }} />

                    {/* Team logo */}
                    <span style={{ ...cellStyle, justifyContent: 'center' }}>
                      {focusRow.teamLogo && (
                        <img src={focusRow.teamLogo} alt="" style={{ width: 16, height: 16, objectFit: 'contain', opacity: 0.5 }} />
                      )}
                    </span>

                    {/* Driver name */}
                    <span style={{
                      ...cellStyle, justifyContent: 'flex-start',
                      fontSize: '9px', fontStyle: 'italic',
                      color: 'rgba(245, 166, 35, 0.6)',
                      fontFamily: "'Formula1', 'Titillium Web', sans-serif",
                    }}>
                      <span style={{ fontWeight: 700 }}>{focusRow.surname}</span>
                      <span style={{ fontSize: '7px', marginLeft: 4, color: 'rgba(245,166,35,0.35)' }}>predicted</span>
                    </span>

                    {/* S1 — empty for predicted */}
                    <span style={{ ...cellStyle, color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>—</span>
                    {/* S2 */}
                    <span style={{ ...cellStyle, color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>—</span>
                    {/* S3 */}
                    <span style={{ ...cellStyle, color: 'rgba(255,255,255,0.15)', fontSize: '9px' }}>—</span>

                    {/* Predicted Lap Time */}
                    <span style={{
                      ...cellStyle, fontWeight: 700, fontSize: '11px',
                      color: '#f5a623', fontStyle: 'italic',
                    }}>
                      {fmtTime(time)}
                    </span>

                    {/* Delta vs last actual */}
                    <span style={{
                      ...cellStyle, fontSize: '9px',
                      color: delta != null ? (delta > 0 ? '#e10600' : '#22c55e') : 'rgba(255,255,255,0.2)',
                    }}>
                      {delta != null ? (delta > 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3)) : ''}
                    </span>

                    {/* Tyre — inherit from current */}
                    <span style={{ ...cellStyle, justifyContent: 'center', gap: 3, opacity: 0.5 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: TYRE_COLORS[focusRow.compound] || '#888',
                      }} />
                    </span>

                    {/* Tyre life — estimate */}
                    <span style={{
                      ...cellStyle, justifyContent: 'center',
                      color: 'rgba(255,255,255,0.25)', fontSize: '9px', fontStyle: 'italic',
                    }}>
                      {focusRow.tyreLife + i + 1}
                    </span>
                  </div>
                );
              })}
            </>
          );
        })()}

        {/* LSTM forecast mini-chart for focused driver */}
        {focusDriver && (
          <LSTMForecastChart
            focusDriver={focusDriver}
            lstmPredictions={lstmPredictions}
            lapTimes={lapTimes}
            currentLap={currentLap}
          />
        )}
      </div>

      {/* Lap range brush bar */}
      {!isQualifying && maxLap > 1 && (
        <LapRangeBrush
          maxLap={maxLap}
          currentLap={currentLap}
          selectedRange={selectedLapRange}
          onRangeChange={setSelectedLapRange}
        />
      )}
      </>
      )}
    </Panel>
  );
}

/* ── Lap Range Brush: compact bar for selecting a lap window ──── */
function LapRangeBrush({ maxLap, currentLap, selectedRange, onRangeChange }) {
  const barRef = useRef(null);

  const lapToX = useCallback((lap) => {
    const el = barRef.current;
    if (!el) return 0;
    return ((lap - 1) / Math.max(1, maxLap - 1)) * el.clientWidth;
  }, [maxLap]);

  const xToLap = useCallback((x) => {
    const el = barRef.current;
    if (!el) return 1;
    const ratio = Math.max(0, Math.min(1, x / el.clientWidth));
    return Math.max(1, Math.min(maxLap, Math.round(ratio * (maxLap - 1) + 1)));
  }, [maxLap]);

  const handleMouseDown = useCallback((e) => {
    const el = barRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const startLap = xToLap(e.clientX - rect.left);

    const onMove = (ev) => {
      const endLap = xToLap(ev.clientX - rect.left);
      const lo = Math.min(startLap, endLap);
      const hi = Math.max(startLap, endLap);
      if (hi - lo >= 1) onRangeChange([lo, hi]);
    };

    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const endLap = xToLap(ev.clientX - rect.left);
      const lo = Math.min(startLap, endLap);
      const hi = Math.max(startLap, endLap);
      if (hi - lo < 1) onRangeChange(null); // click = clear
    };

    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [xToLap, onRangeChange]);

  // Lap tick marks
  const ticks = [];
  const step = maxLap <= 30 ? 5 : maxLap <= 50 ? 10 : 15;
  for (let l = step; l <= maxLap; l += step) ticks.push(l);

  const selLeft = selectedRange ? lapToX(selectedRange[0]) : 0;
  const selWidth = selectedRange ? lapToX(selectedRange[1]) - selLeft : 0;
  const currentX = lapToX(currentLap);

  return (
    <div style={{
      flexShrink: 0, padding: '4px 6px 6px',
      borderTop: '1px solid rgba(255,255,255,0.06)',
      background: 'rgba(15,15,35,0.6)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
          Lap Range
        </span>
        {selectedRange && (
          <button
            onClick={() => onRangeChange(null)}
            style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 3, padding: '1px 6px', fontSize: '8px', color: 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
            }}
          >
            L{selectedRange[0]}–L{selectedRange[1]} ✕
          </button>
        )}
      </div>
      <div
        ref={barRef}
        onMouseDown={handleMouseDown}
        style={{
          position: 'relative', height: 16, borderRadius: 3,
          background: 'rgba(255,255,255,0.04)', cursor: 'crosshair',
          overflow: 'hidden',
        }}
      >
        {/* Selected range highlight */}
        {selectedRange && (
          <div style={{
            position: 'absolute', top: 0, bottom: 0,
            left: selLeft, width: selWidth,
            background: 'rgba(100,180,255,0.2)',
            borderLeft: '2px solid rgba(100,180,255,0.6)',
            borderRight: '2px solid rgba(100,180,255,0.6)',
          }} />
        )}
        {/* Current lap marker */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, width: 2,
          left: currentX - 1,
          background: 'rgba(255,255,255,0.4)',
        }} />
        {/* Tick labels */}
        {ticks.map((l) => (
          <span key={l} style={{
            position: 'absolute', top: 2, fontSize: '7px',
            color: 'rgba(255,255,255,0.2)', fontWeight: 600,
            left: lapToX(l), transform: 'translateX(-50%)',
          }}>{l}</span>
        ))}
      </div>
    </div>
  );
}

/* ── LSTM Forecast Mini-Chart: D3 pace trend + prediction overlay ── */
function LSTMForecastChart({ focusDriver, lstmPredictions, lapTimes, currentLap }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);

  const pred = lstmPredictions?.[focusDriver] || lstmPredictions?.driver_predictions?.[focusDriver];
  const predTimes = useMemo(() => {
    if (!pred?.predicted_times?.length) return [];
    return pred.predicted_times.slice(0, 5).filter((t) => t > 0 && t < 300);
  }, [pred]);

  // Recent racing laps for the focused driver (last 15 laps, no pit laps)
  const recentLaps = useMemo(() => {
    return lapTimes
      .filter((d) => d.Driver === focusDriver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300 && !d.PitInTime && !d.PitOutTime)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .slice(-15);
  }, [lapTimes, focusDriver, currentLap]);

  useEffect(() => {
    if (!svgRef.current || recentLaps.length < 2) return;
    const container = svgRef.current.parentElement;
    const { width: W } = container.getBoundingClientRect();
    const H = 90;
    const margin = { top: 14, right: 12, bottom: 18, left: 42 };
    const w = W - margin.left - margin.right;
    const h = H - margin.top - margin.bottom;
    if (w < 40 || h < 20) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const driverColor = getDriverColor(focusDriver);

    // Build data points
    const actualPoints = recentLaps.map((d) => ({ lap: d.LapNumber, time: d.LapTimeSeconds, type: 'actual' }));
    const lastActual = actualPoints[actualPoints.length - 1];

    const predPoints = predTimes.map((t, i) => ({ lap: lastActual.lap + i + 1, time: t, type: 'predicted' }));
    // Connection point for seamless join
    const connectionPoint = { lap: lastActual.lap, time: lastActual.time, type: 'predicted' };
    const fullPredLine = [connectionPoint, ...predPoints];

    const allPoints = [...actualPoints, ...predPoints];
    const allTimes = allPoints.map((d) => d.time);
    const yMin = d3.min(allTimes);
    const yMax = d3.max(allTimes);
    const yPad = (yMax - yMin) * 0.15 || 0.5;

    const xScale = d3.scaleLinear()
      .domain([actualPoints[0].lap, predPoints.length > 0 ? predPoints[predPoints.length - 1].lap : lastActual.lap])
      .range([0, w]);
    const yScale = d3.scaleLinear()
      .domain([yMin - yPad, yMax + yPad])
      .range([h, 0]);

    // Grid lines
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(xScale).ticks(Math.min(allPoints.length, 8)).tickSize(-h).tickFormat('')
    ).selectAll('line').attr('stroke', 'rgba(255,255,255,0.04)');
    g.selectAll('.domain').remove();

    // Uncertainty band (±0.3s) around predictions
    if (predPoints.length > 0) {
      const uncertainty = d3.area()
        .x((d) => xScale(d.lap))
        .y0((d) => yScale(d.time + 0.3))
        .y1((d) => yScale(d.time - 0.3))
        .curve(d3.curveMonotoneX);
      g.append('path')
        .datum(predPoints)
        .attr('d', uncertainty)
        .attr('fill', driverColor)
        .attr('opacity', 0.06);
    }

    // Vertical separator at forecast boundary
    if (predPoints.length > 0) {
      g.append('line')
        .attr('x1', xScale(lastActual.lap)).attr('x2', xScale(lastActual.lap))
        .attr('y1', 0).attr('y2', h)
        .attr('stroke', 'rgba(255,255,255,0.12)').attr('stroke-dasharray', '2,2');
    }

    // Actual pace line (solid)
    const line = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.time)).curve(d3.curveMonotoneX);
    g.append('path').datum(actualPoints).attr('d', line)
      .attr('fill', 'none').attr('stroke', driverColor).attr('stroke-width', 1.8).attr('opacity', 0.9);

    // Predicted pace line (dashed)
    if (fullPredLine.length > 1) {
      const predLine = d3.line().x((d) => xScale(d.lap)).y((d) => yScale(d.time)).curve(d3.curveMonotoneX);
      g.append('path').datum(fullPredLine).attr('d', predLine)
        .attr('fill', 'none').attr('stroke', driverColor).attr('stroke-width', 1.8)
        .attr('stroke-dasharray', '6,4').attr('opacity', 0.7);
    }

    // Actual lap dots
    g.selectAll('.actual-dot')
      .data(actualPoints)
      .join('circle')
      .attr('cx', (d) => xScale(d.lap)).attr('cy', (d) => yScale(d.time))
      .attr('r', 2).attr('fill', driverColor).attr('opacity', 0.6);

    // Predicted lap dots (larger, with white stroke)
    g.selectAll('.pred-dot')
      .data(predPoints)
      .join('circle')
      .attr('cx', (d) => xScale(d.lap)).attr('cy', (d) => yScale(d.time))
      .attr('r', 3.5).attr('fill', driverColor).attr('stroke', '#fff').attr('stroke-width', 1)
      .attr('opacity', 0.8).style('cursor', 'pointer');

    // Tooltip interaction on predicted dots
    const tooltip = tooltipRef.current;
    g.selectAll('.pred-dot')
      .on('mouseenter', function (event, d) {
        if (!tooltip) return;
        const mins = Math.floor(d.time / 60);
        const secs = (d.time % 60).toFixed(3);
        const timeStr = mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
        tooltip.textContent = `L${d.lap}: ${timeStr}`;
        tooltip.style.opacity = '1';
        tooltip.style.left = `${event.offsetX + 8}px`;
        tooltip.style.top = `${event.offsetY - 18}px`;
      })
      .on('mouseleave', function () {
        if (tooltip) tooltip.style.opacity = '0';
      });

    // "LSTM Forecast" label
    if (predPoints.length > 0) {
      g.append('text')
        .attr('x', xScale(predPoints[0].lap))
        .attr('y', -4)
        .attr('fill', driverColor)
        .attr('font-size', '7px')
        .attr('font-weight', 700)
        .attr('opacity', 0.6)
        .text('LSTM Forecast');
    }

    // Driver label + pit probability
    g.append('text')
      .attr('x', 0).attr('y', -4)
      .attr('fill', driverColor)
      .attr('font-size', '8px')
      .attr('font-weight', 800)
      .text(focusDriver);

    if (pred?.pit_probability != null) {
      const pitProb = pred.pit_probability;
      g.append('text')
        .attr('x', w).attr('y', -4)
        .attr('text-anchor', 'end')
        .attr('fill', pitProb > 0.5 ? '#f5a623' : 'rgba(255,255,255,0.35)')
        .attr('font-size', '7px')
        .attr('font-weight', 700)
        .text(`PIT ${(pitProb * 100).toFixed(0)}%`);
    }

    // X-axis
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(xScale).ticks(Math.min(allPoints.length, 8)).tickFormat(d3.format('d'))
    ).selectAll('text').attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px');
    g.selectAll('.domain').attr('stroke', 'rgba(255,255,255,0.06)');
    g.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.06)');

    // Y-axis (time)
    g.append('g').call(
      d3.axisLeft(yScale).ticks(3).tickFormat((d) => {
        const m = Math.floor(d / 60);
        const s = (d % 60).toFixed(1);
        return m > 0 ? `${m}:${s.padStart(4, '0')}` : s;
      })
    ).selectAll('text').attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px');
  }, [recentLaps, predTimes, focusDriver, pred, currentLap]);

  if (recentLaps.length < 2 && predTimes.length === 0) return null;

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid rgba(255,255,255,0.08)',
      background: 'rgba(15,15,35,0.5)',
      position: 'relative',
      height: 90,
      overflow: 'hidden',
    }}>
      <div ref={tooltipRef} style={{
        position: 'absolute', pointerEvents: 'none', opacity: 0,
        background: 'rgba(10,10,25,0.9)', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 4, padding: '2px 6px', fontSize: '9px', color: '#f5a623',
        fontWeight: 700, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
        zIndex: 5, transition: 'opacity 0.1s',
      }} />
      <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}
