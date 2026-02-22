import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';

const LAP_COLORS = ['#a855f7', '#22c55e', '#ff8000', '#e10600'];

function formatLapTime(seconds) {
  if (!seconds || seconds <= 0) return '--:--.---';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${mins}:${secs}`;
}

export default function TelemetryStrip({ embedded = false }) {
  const speedRef = useRef(null);
  const deltaRef = useRef(null);
  const throttleRef = useRef(null);
  const brakeRef = useRef(null);
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

  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const sessionData = useF1Store((s) => s.sessionData);
  const circuitInfo = useF1Store((s) => s.circuitInfo);
  const telemetryCache = useF1Store((s) => s.telemetryCache);
  const telemetryCompareMode = useF1Store((s) => s.telemetryCompareMode);
  const telemetryCompareLaps = useF1Store((s) => s.telemetryCompareLaps);
  const telemetryLoading = useF1Store((s) => s.telemetryLoading);
  const fetchDriverTelemetry = useF1Store((s) => s.fetchDriverTelemetry);
  const setTelemetryCompareMode = useF1Store((s) => s.setTelemetryCompareMode);
  const setTelemetryCompareLaps = useF1Store((s) => s.setTelemetryCompareLaps);
  const maxLap = useF1Store((s) => s.maxLap);
  const drivers = useF1Store((s) => s.drivers);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const frameData = useF1Store((s) => s.frameData);
  const isPlaying = useF1Store((s) => s.isPlaying);
  const telemetryChannels = useF1Store((s) => s.telemetryChannels);

  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [lapInput, setLapInput] = useState('');
  const [crosshairInfo, setCrosshairInfo] = useState(null); // { x, distance, values }

  // ── Brush zoom state ──────────────────────────────────────────
  const [zoomDomain, setZoomDomain] = useState(null); // null = full view, or [minDist, maxDist]

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

  // Available drivers for the selector
  const driverList = useMemo(() => {
    return (drivers || []).map((d) => ({
      abbr: d.Abbreviation,
      name: d.FullName || d.Abbreviation,
      color: getDriverColor(d.Abbreviation),
    }));
  }, [drivers]);

  // Determine which driver+lap combos to fetch
  const fetchTargets = useMemo(() => {
    if (!sessionData || currentLap < 1) return [];
    if (telemetryCompareMode === 'drivers') {
      const drvs = selectedDrivers.length > 0
        ? selectedDrivers.slice(0, 4)
        : (focusDriver ? [focusDriver] : []);
      return drvs.map((d) => ({ driver: d, lap: currentLap }));
    } else {
      const driver = focusDriver || selectedDrivers[0];
      if (!driver) return [];
      const laps = telemetryCompareLaps.length > 0
        ? telemetryCompareLaps.slice(0, 4)
        : [currentLap];
      return laps.map((l) => ({ driver, lap: l }));
    }
  }, [selectedDrivers, focusDriver, currentLap, sessionData, telemetryCompareMode, telemetryCompareLaps]);

  // Debounced telemetry fetching
  useEffect(() => {
    if (fetchTargets.length === 0) return;
    clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => {
      fetchTargets.forEach(({ driver, lap }) => {
        const key = `${driver}-${lap}`;
        if (!telemetryCache[key]) {
          fetchDriverTelemetry(driver, lap);
        }
      });
    }, 300);
    return () => clearTimeout(fetchTimerRef.current);
  }, [fetchTargets, telemetryCache, fetchDriverTelemetry]);

  // Build resolved trace data
  const traces = useMemo(() => {
    return fetchTargets
      .map(({ driver, lap }, i) => {
        const key = `${driver}-${lap}`;
        const data = telemetryCache[key];
        if (!data || data.length === 0) return null;
        const color = telemetryCompareMode === 'drivers'
          ? getDriverColor(driver)
          : (LAP_COLORS[i] || '#888');
        const isFocus = telemetryCompareMode === 'drivers'
          ? driver === focusDriver
          : i === 0;
        return { driver, lap, data, color, isFocus, key };
      })
      .filter(Boolean);
  }, [fetchTargets, telemetryCache, focusDriver, telemetryCompareMode]);

  // ── Incremental telemetry: update clip rects via ref (no React re-render) ──
  useEffect(() => {
    if (!frameData?.frames?.length || currentFrameIndex <= 0) {
      currentDistRef.current = null;
      return;
    }
    if (!circuitInfo?.track_coordinates?.length) return;

    const frame = frameData.frames[Math.min(currentFrameIndex, frameData.frames.length - 1)];
    if (!frame?.drivers) { currentDistRef.current = null; return; }

    const driver = focusDriver || selectedDrivers[0];
    if (!driver) { currentDistRef.current = null; return; }

    const driverData = frame.drivers[driver];
    if (!driverData) { currentDistRef.current = null; return; }

    // Only clip if driver is on the current lap being displayed
    if (driverData.lap !== currentLap) { currentDistRef.current = null; return; }

    const dx = driverData.x;
    const dy = driverData.y;
    const trackCoords = circuitInfo.track_coordinates;

    // Find nearest track coordinate by Euclidean distance
    let minDistSq = Infinity;
    let nearestDistance = 0;
    for (const coord of trackCoords) {
      const ddx = coord.X - dx;
      const ddy = coord.Y - dy;
      const distSq = ddx * ddx + ddy * ddy;
      if (distSq < minDistSq) {
        minDistSq = distSq;
        nearestDistance = coord.Distance;
      }
    }
    currentDistRef.current = nearestDistance;

    // Update clip rects directly (lightweight — no re-render)
    const xScale = xScaleRef.current;
    if (!xScale || clipRectsRef.current.length === 0) return;
    const clipX = nearestDistance > 0 ? xScale(nearestDistance) : null;
    clipRectsRef.current.forEach((rect) => {
      if (rect) rect.attr('width', clipX != null ? Math.max(0, clipX) : 9999);
    });
  }, [frameData, currentFrameIndex, circuitInfo, focusDriver, selectedDrivers, currentLap]);

  // Sector boundaries from circuit info
  const sectorBoundaries = useMemo(() => {
    if (!circuitInfo?.track_coordinates?.length) return [];
    const coords = circuitInfo.track_coordinates;
    const boundaries = [];
    for (let i = 1; i < coords.length; i++) {
      if (coords[i].Sector !== coords[i - 1].Sector && coords[i].Distance) {
        boundaries.push({ sector: coords[i].Sector, distance: coords[i].Distance });
      }
    }
    return boundaries;
  }, [circuitInfo]);

  // Track length
  const trackLength = useMemo(() => {
    let max = 0;
    for (const t of traces) {
      const last = t.data[t.data.length - 1];
      if (last?.Distance > max) max = last.Distance;
    }
    if (circuitInfo?.track_coordinates?.length) {
      const last = circuitInfo.track_coordinates[circuitInfo.track_coordinates.length - 1];
      if (last?.Distance > max) max = last.Distance;
    }
    return max || 5000;
  }, [traces, circuitInfo]);

  // Reset zoom when track data changes
  useEffect(() => {
    setZoomDomain(null);
  }, [trackLength]);

  // Driver info for comparison cards
  const driverCards = useMemo(() => {
    if (!sessionData?.lap_times) return [];
    return fetchTargets.map(({ driver, lap }, i) => {
      const lapData = sessionData.lap_times.find(
        (lt) => lt.Driver === driver && lt.LapNumber === lap
      );
      const color = telemetryCompareMode === 'drivers'
        ? getDriverColor(driver)
        : (LAP_COLORS[i] || '#888');
      return {
        driver, lap, color,
        lapTime: lapData?.LapTimeSeconds,
        s1: lapData?.Sector1TimeSeconds,
        s2: lapData?.Sector2TimeSeconds,
        s3: lapData?.Sector3TimeSeconds,
      };
    });
  }, [fetchTargets, sessionData, telemetryCompareMode]);

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

    const clipDist = currentDistRef.current;

    // Find values at this distance for each trace
    const values = traces.map((t) => {
      // If beyond the progressive clip point, show no value
      if (clipDist != null && clipDist > 0 && t.lap === currentLap && distance > clipDist) {
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

    setCrosshairInfo({ x: mouseX, distance: Math.round(distance), values });
  }, [traces, effectiveDomain, currentLap]);

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
      [speedRef, deltaRef, throttleRef, brakeRef, gearRef, rpmRef].forEach((ref) => {
        if (ref.current) d3.select(ref.current).selectAll('*').remove();
      });
      clipRectsRef.current = [];
      return;
    }

    const margin = { top: 2, right: 8, bottom: 2, left: 36 };
    const xScale = d3.scaleLinear()
      .domain(effectiveDomain)
      .range([margin.left, dims.width - margin.right]);

    // Store xScale for crosshair use
    xScaleRef.current = xScale;

    // Sort traces: non-focus first, focus on top
    const sorted = [...traces].sort((a, b) => (a.isFocus ? 1 : 0) - (b.isFocus ? 1 : 0));

    renderSpeedChart(speedRef.current, sorted, xScale, margin, sectorBoundaries, trackLength);
    renderDeltaChart(deltaRef.current, sorted, xScale, margin, sectorBoundaries);
    renderThrottleChart(throttleRef.current, sorted, xScale, margin, sectorBoundaries);
    renderBrakeChart(brakeRef.current, sorted, xScale, margin, sectorBoundaries);
    renderGearChart(gearRef.current, sorted, xScale, margin, sectorBoundaries);
    renderRPMChart(rpmRef.current, sorted, xScale, margin, sectorBoundaries);

    // Add clipPaths for progressive reveal (only clips trace <path> elements)
    const svgRefs = [speedRef, deltaRef, throttleRef, brakeRef, gearRef, rpmRef];
    const clipDist = currentDistRef.current;
    const clipX = (clipDist != null && clipDist > 0) ? xScale(clipDist) : null;

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

      // Apply clip to all <path> elements (trace lines/areas — not axes/grid/labels)
      svg.selectAll('path').attr('clip-path', `url(#${clipId})`);

      return clipRect;
    });
  }, [traces, dims, effectiveDomain, trackLength, sectorBoundaries]);

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

  // Handle adding laps in laps mode
  const handleAddLap = useCallback((e) => {
    if (e.key === 'Enter') {
      const lap = parseInt(lapInput, 10);
      if (lap > 0 && lap <= maxLap && !telemetryCompareLaps.includes(lap)) {
        setTelemetryCompareLaps([...telemetryCompareLaps, lap].slice(0, 4));
      }
      setLapInput('');
    }
  }, [lapInput, maxLap, telemetryCompareLaps, setTelemetryCompareLaps]);

  const handleRemoveLap = useCallback((lap) => {
    setTelemetryCompareLaps(telemetryCompareLaps.filter((l) => l !== lap));
  }, [telemetryCompareLaps, setTelemetryCompareLaps]);

  // Handle adding a driver comparison
  const handleAddDriver = useCallback((abbr) => {
    if (abbr && !selectedDrivers.includes(abbr)) {
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

          {/* Driver comparison cards */}
          {driverCards.map((card) => (
            <div className="telem-driver-card" key={`${card.driver}-${card.lap}`}>
              <div className="telem-driver-card__bar" style={{ background: card.color }} />
              <span className="telem-driver-card__abbr">{card.driver}</span>
              <span className="telem-driver-card__lap">L{card.lap}</span>
              <span className="telem-driver-card__time">{formatLapTime(card.lapTime)}</span>
              {card.s1 != null && (
                <div className="telem-driver-card__sectors">
                  <span className="telem-sector-badge" style={{ background: 'rgba(168,85,247,0.25)', color: '#a855f7' }}>
                    {card.s1?.toFixed(1)}
                  </span>
                  <span className="telem-sector-badge" style={{ background: 'rgba(34,197,94,0.25)', color: '#22c55e' }}>
                    {card.s2?.toFixed(1)}
                  </span>
                  <span className="telem-sector-badge" style={{ background: 'rgba(251,191,36,0.25)', color: '#fbbf24' }}>
                    {card.s3?.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="telemetry-strip__header-right">
          {telemetryCompareMode === 'laps' && (
            <>
              {telemetryCompareLaps.map((lap, i) => (
                <span
                  key={lap}
                  className="telem-sector-badge"
                  style={{
                    background: `${LAP_COLORS[i]}30`,
                    color: LAP_COLORS[i],
                    cursor: 'pointer',
                    fontSize: '9px',
                    padding: '1px 5px',
                  }}
                  onClick={() => handleRemoveLap(lap)}
                >
                  L{lap} x
                </span>
              ))}
              <input
                className="telem-lap-picker"
                type="number"
                min={1}
                max={maxLap}
                placeholder="Lap"
                value={lapInput}
                onChange={(e) => setLapInput(e.target.value)}
                onKeyDown={handleAddLap}
              />
            </>
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
        </div>
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
            {telemetryChannels.throttle && (
              <div className="telemetry-strip__chart telemetry-strip__chart--throttle">
                <svg ref={throttleRef} />
              </div>
            )}
            {telemetryChannels.brake && (
              <div className="telemetry-strip__chart telemetry-strip__chart--brake">
                <svg ref={brakeRef} />
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
                {Math.round(zoomDomain[0])}m — {Math.round(zoomDomain[1])}m
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
                  {crosshairInfo.distance}m
                </div>
                {crosshairInfo.values.map((v) => (
                  <div className="telem-crosshair-tooltip__row" key={`${v.driver}-${v.lap}`}>
                    <span className="telem-crosshair-tooltip__dot" style={{ background: v.color }} />
                    <span className="telem-crosshair-tooltip__driver">{v.driver}</span>
                    <span className="telem-crosshair-tooltip__val">
                      {v.speed != null ? `${Math.round(v.speed)} kph` : '—'}
                    </span>
                    <span className="telem-crosshair-tooltip__val telem-crosshair-tooltip__val--dim">
                      {v.throttle != null ? `${Math.round(v.throttle)}%T` : ''}
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

function renderSpeedChart(svgEl, traces, xScale, margin, sectorBoundaries, trackLength) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  let yMin = Infinity, yMax = -Infinity;
  for (const t of traces) {
    for (const d of t.data) {
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
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
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
    if (t.isFocus) {
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
    g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-speed-line telem-speed-line--focus' : 'telem-speed-line')
      .attr('d', line).attr('stroke', t.color);
  });

  // Speed annotations at local min/max
  const annots = findSpeedAnnotations(traces, xScale, yScale, width, m);
  annots.forEach((a) => {
    const yOff = a.isMax ? -8 : 12;
    g.append('rect')
      .attr('class', 'telem-annot-bg')
      .attr('x', a.px - 14)
      .attr('y', a.py + yOff - 9)
      .attr('width', 28)
      .attr('height', 12)
      .attr('rx', 2);
    g.append('text')
      .attr('class', 'telem-annot-text')
      .attr('x', a.px)
      .attr('y', a.py + yOff)
      .attr('text-anchor', 'middle')
      .attr('fill', a.color)
      .text(a.speed);
  });
}

function renderDeltaChart(svgEl, traces, xScale, margin, sectorBoundaries) {
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
      deltaTraces.push({ data: delta, color: traces[i].color, driver: traces[i].driver });
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
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
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

function renderThrottleChart(svgEl, traces, xScale, margin, sectorBoundaries) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  const yScale = d3.scaleLinear().domain([0, 100]).range([height - m.bottom, m.top]);

  drawSectorLines(g, sectorBoundaries, xScale, m.top, height - m.bottom);

  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', m.top + 9)
    .text('THROTTLE (%)');

  // X axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - m.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
    .call((el) => el.select('.domain').remove());

  const area = d3.area()
    .x((d) => xScale(d.Distance))
    .y0(height - m.bottom)
    .y1((d) => yScale(d.Throttle != null ? d.Throttle : 0))
    .defined((d) => d.Distance != null)
    .curve(d3.curveMonotoneX);

  traces.forEach((t) => {
    g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-throttle-area telem-throttle-area--focus' : 'telem-throttle-area')
      .attr('d', area)
      .attr('fill', t.isFocus ? '#00e676' : t.color);
  });
}

function renderBrakeChart(svgEl, traces, xScale, margin, sectorBoundaries) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;
  const m = { ...margin, bottom: 14 };

  const yScale = d3.scaleLinear().domain([0, 100]).range([height - m.bottom, m.top]);

  drawSectorLines(g, sectorBoundaries, xScale, m.top, height - m.bottom);

  g.append('text').attr('class', 'telem-chart-label')
    .attr('x', m.left + 4).attr('y', m.top + 9)
    .text('BRAKE');

  // X axis
  g.append('g').attr('class', 'telem-axis')
    .attr('transform', `translate(0,${height - m.bottom})`)
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
    .call((el) => el.select('.domain').remove());

  const area = d3.area()
    .x((d) => xScale(d.Distance))
    .y0(height - m.bottom)
    .y1((d) => {
      const v = d.Brake != null ? (typeof d.Brake === 'boolean' ? (d.Brake ? 100 : 0) : d.Brake) : 0;
      return yScale(v);
    })
    .defined((d) => d.Distance != null)
    .curve(d3.curveMonotoneX);

  traces.forEach((t) => {
    g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-brake-area telem-brake-area--focus' : 'telem-brake-area')
      .attr('d', area)
      .attr('fill', t.isFocus ? '#e10600' : t.color);
  });
}

function renderGearChart(svgEl, traces, xScale, margin, sectorBoundaries) {
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
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
    .call((el) => el.select('.domain').remove());

  const line = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => yScale(d.nGear != null ? d.nGear : 0))
    .defined((d) => d.Distance != null && d.nGear != null)
    .curve(d3.curveStepAfter);

  traces.forEach((t) => {
    g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-gear-line telem-gear-line--focus' : 'telem-gear-line')
      .attr('d', line).attr('stroke', t.color);
  });
}

function renderRPMChart(svgEl, traces, xScale, margin, sectorBoundaries) {
  const ctx = prepSvg(svgEl);
  if (!ctx) return;
  const { g, width, height } = ctx;

  const rpmMargin = { ...margin, bottom: 14 };

  let yMin = Infinity, yMax = -Infinity;
  for (const t of traces) {
    for (const d of t.data) {
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
      .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
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
    .call(d3.axisBottom(xScale).ticks(8).tickSize(-3).tickFormat((d) => `${(d / 1000).toFixed(1)}k`))
    .call((el) => el.select('.domain').remove());

  g.append('text').attr('class', 'telem-chart-label telem-chart-label--right')
    .attr('x', width - margin.right - 4).attr('y', height - rpmMargin.bottom - 4)
    .attr('text-anchor', 'end')
    .text('Distance (m)');

  const line = d3.line()
    .x((d) => xScale(d.Distance))
    .y((d) => yScale(d.RPM))
    .defined((d) => d.Distance != null && d.RPM != null && d.RPM > 0)
    .curve(d3.curveMonotoneX);

  traces.forEach((t) => {
    g.append('path').datum(t.data)
      .attr('class', t.isFocus ? 'telem-rpm-line telem-rpm-line--focus' : 'telem-rpm-line')
      .attr('d', line).attr('stroke', t.color);
  });
}
