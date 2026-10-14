import React, { useMemo, useRef, useEffect, useCallback } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, TYRE_LABELS, getTyreTextColor } from '../../utils/colors';
import { exportAsPng } from '../../utils/exportChart';
import { useSessionNow, useStintsRunning } from '../../hooks/useSessionNow';
import { stintsByDriver, pitStops } from '../../utils/stints';
import { consistencySigma } from '../../utils/degradation';
import { focusForecast, forecastPoints } from '../../utils/forecast';
import {
  causalKey, pitCountsByDriver, driverCompletedLaps, stintLapsText,
} from '../../utils/strategyViews';

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

/* ── Small sub-components ── */

function DriverCard({ abbr, info, color }) {
  return (
    <div className="compare-panel__driver-card">
      <span className="compare-panel__team-bar" style={{ backgroundColor: color }} />
      <div className="compare-panel__driver-info">
        <span className="compare-panel__driver-abbr">{abbr}</span>
        {info && <span className="compare-panel__driver-name">{info.FullName}</span>}
        {info && <span className="compare-panel__team-name">{info.TeamName}</span>}
      </div>
    </div>
  );
}

function MetricsTable({ title, rows, driverA, driverB }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="compare-panel__metrics">
      <div className="compare-panel__metrics-title">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="compare-panel__metric-row">
          <span className={`compare-panel__metric-value compare-panel__metric-value--left${r.winner === 'A' ? ' compare-panel__metric-value--winner' : ''}`}>
            {r.valueA}
          </span>
          <span className="compare-panel__metric-label">{r.label}</span>
          <span className={`compare-panel__metric-value compare-panel__metric-value--right${r.winner === 'B' ? ' compare-panel__metric-value--winner' : ''}`}>
            {r.valueB}
          </span>
        </div>
      ))}
    </div>
  );
}

// stintsA / stintsB: deriveStints rows at sessionNow (causal: the ongoing
// stint already ends at the driver's last completed lap)
function StrategyComparison({ driverA, driverB, stintsA, stintsB, currentLap, maxLap }) {
  const totalLaps = maxLap || currentLap || 1;
  if (stintsA.length === 0 && stintsB.length === 0) return null;

  const renderBar = (stints, driver) => (
    <div className="compare-panel__stint-row">
      <span className="compare-panel__stint-driver">{driver}</span>
      <div className="compare-panel__stint-bar">
        {stints.map((s, i) => {
          const start = s.StartLap;
          const end = s.EndLap;
          // A stint just begun (pit exit passed, no lap completed) has 0 laps
          const width = (Math.max(0, end - start + 1) / totalLaps) * 100;
          const bg = TYRE_COLORS[s.Compound] || TYRE_COLORS.UNKNOWN;
          const textColor = getTyreTextColor(s.Compound);
          return (
            <span
              key={i}
              className="compare-panel__stint-segment"
              style={{ width: `${Math.max(width, 2)}%`, backgroundColor: bg, color: textColor }}
              title={`${s.Compound}: laps ${stintLapsText(s)}`}
            >
              {width > 8 ? `${TYRE_LABELS[s.Compound] || '?'} ${end - start + 1}L` : TYRE_LABELS[s.Compound] || '?'}
            </span>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="compare-panel__metrics">
      <div className="compare-panel__metrics-title">Tyre Strategy</div>
      {renderBar(stintsA, driverA)}
      {renderBar(stintsB, driverB)}
    </div>
  );
}

/* ── Main Component ── */

export default function DriverComparePanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const compareDrivers = useF1Store((s) => s.compareDrivers);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const addCompareDriver = useF1Store((s) => s.addCompareDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const currentFrameIndex = useF1Store((s) => s.currentFrameIndex);
  const driversList = useF1Store((s) => s.drivers);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);

  const panelRef = useRef(null);
  const gapChartRef = useRef(null);
  const lapChartRef = useRef(null);

  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, 'driver_comparison.png');
  }, []);

  // Auto-populate compareDrivers from selectedDrivers when panel opens empty
  const hasAutoPopulated = useRef(false);
  useEffect(() => {
    if (compareDrivers.length === 0 && selectedDrivers.length >= 2 && !hasAutoPopulated.current) {
      hasAutoPopulated.current = true;
      addCompareDriver(selectedDrivers[0]);
      addCompareDriver(selectedDrivers[1]);
    }
    // Reset flag when compareDrivers is manually cleared
    if (compareDrivers.length > 0) {
      hasAutoPopulated.current = false;
    }
  }, [compareDrivers, selectedDrivers, addCompareDriver]);

  const [driverA, driverB] = compareDrivers.length === 2 ? compareDrivers : [null, null];
  const colorA = getDriverColor(driverA);
  const colorB = getDriverColor(driverB);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  // Causal "now" (session seconds) and a key that changes only when a lap or
  // a pit event completes, so the memos and D3 charts do not redo every frame
  const sessionNow = useSessionNow();
  const causal = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  // Stints from the FastF1 Stint column of the completed laps (utils/stints.js)
  // (live mode: the current stint of a driver still racing stays ongoing)
  const running = useStintsRunning();
  const stintsMap = useMemo(
    () => stintsByDriver(lapTimes, { sessionNow, running }),
    [lapTimes, causal, running],
  );
  // Pit stops (tyre changes) visible at sessionNow: from the pit exit, with
  // the new stint, so each driver's count = stints - 1 (same as the Strategy
  // Timeline STOPS badge)
  const stops = useMemo(() => pitStops(lapTimes, { sessionNow }), [lapTimes, causal]);
  const pitCounts = useMemo(() => pitCountsByDriver(stops), [stops]);

  const infoA = useMemo(() => driversList?.find((d) => d.Abbreviation === driverA), [driversList, driverA]);
  const infoB = useMemo(() => driversList?.find((d) => d.Abbreviation === driverB), [driversList, driverB]);

  // Laps per driver completed at sessionNow (never the lap in progress), valid only
  const { lapsA, lapsB } = useMemo(() => {
    if (!driverA || !driverB) return { lapsA: [], lapsB: [] };
    return {
      lapsA: driverCompletedLaps(lapTimes, driverA, sessionNow),
      lapsB: driverCompletedLaps(lapTimes, driverB, sessionNow),
    };
  }, [lapTimes, driverA, driverB, causal]);

  // In-laps of the driver's pit stops visible at sessionNow (pit markers)
  const pitLapsOf = (laps, driver) => {
    const inLaps = new Set(stops.filter((s) => s.Driver === driver).map((s) => s.inLap));
    return laps.filter((l) => inLaps.has(l.LapNumber));
  };
  const pitLapsA = useMemo(() => pitLapsOf(lapsA, driverA), [lapsA, stops, driverA]);
  const pitLapsB = useMemo(() => pitLapsOf(lapsB, driverB), [lapsB, stops, driverB]);

  // Racing laps (exclude pit laps) for stats
  const racingA = useMemo(() => lapsA.filter((l) => !l.PitInTime && !l.PitOutTime), [lapsA]);
  const racingB = useMemo(() => lapsB.filter((l) => !l.PitInTime && !l.PitOutTime), [lapsB]);

  // Consistency on the shared degradation definition (utils/degradation.js
  // consistencySigma): pooled residual sigma of each driver's per-stint fits
  // at sessionNow, so lap 1, pit laps, non-green laps, tyre wear, fuel burn
  // and stops do not count as inconsistency; null before a stint is fitted
  const { sigmaA, sigmaB } = useMemo(() => {
    if (!driverA || !driverB) return { sigmaA: null, sigmaB: null };
    return {
      sigmaA: consistencySigma(lapTimes, driverA, { sessionNow }).sigma,
      sigmaB: consistencySigma(lapTimes, driverB, { sessionNow }).sigma,
    };
  }, [lapTimes, driverA, driverB, causal]);

  // Gap evolution: cumulative time difference
  const gapData = useMemo(() => {
    if (lapsA.length === 0 || lapsB.length === 0) return [];
    const cumA = {};
    const cumB = {};
    let sumA = 0, sumB = 0;
    for (const l of lapsA) { sumA += l.LapTimeSeconds; cumA[l.LapNumber] = sumA; }
    for (const l of lapsB) { sumB += l.LapTimeSeconds; cumB[l.LapNumber] = sumB; }

    const gaps = [];
    const allLaps = new Set([...Object.keys(cumA), ...Object.keys(cumB)].map(Number));
    let lastA = 0, lastB = 0;
    for (const lap of [...allLaps].sort((a, b) => a - b)) {
      if (cumA[lap] != null) lastA = cumA[lap];
      if (cumB[lap] != null) lastB = cumB[lap];
      if (lastA > 0 && lastB > 0) {
        gaps.push({ lap, gap: lastB - lastA }); // positive = A ahead
      }
    }
    return gaps;
  }, [lapsA, lapsB]);

  // Sector comparison
  const sectorComparison = useMemo(() => {
    const rows = [];
    for (const s of [1, 2, 3]) {
      const key = `Sector${s}TimeSeconds`;
      const bestA = racingA.reduce((best, l) => {
        const v = l[key];
        return v > 0 && v < 300 && (best === null || v < best) ? v : best;
      }, null);
      const bestB = racingB.reduce((best, l) => {
        const v = l[key];
        return v > 0 && v < 300 && (best === null || v < best) ? v : best;
      }, null);
      const winner = bestA != null && bestB != null ? (bestA < bestB ? 'A' : bestA > bestB ? 'B' : null) : null;
      rows.push({
        label: `Sector ${s}`,
        valueA: formatTime(bestA),
        valueB: formatTime(bestB),
        winner,
      });
    }
    return rows;
  }, [racingA, racingB]);

  // Speed comparison
  const toSpeed = (kmh) => speedUnit === 'mph' ? Math.round(kmh * 0.6214 * 10) / 10 : kmh;
  const speedLabel = speedUnit === 'mph' ? 'mph' : 'km/h';

  const speedComparison = useMemo(() => {
    const traps = [
      { key: 'SpeedI1', label: 'Sector 1' },
      { key: 'SpeedI2', label: 'Sector 2' },
      { key: 'SpeedFL', label: 'Finish Line' },
      { key: 'SpeedST', label: 'Speed Trap' },
    ];
    return traps.map(({ key, label }) => {
      const maxA = lapsA.reduce((best, l) => {
        const v = l[key];
        return v > 0 && (best === null || v > best) ? v : best;
      }, null);
      const maxB = lapsB.reduce((best, l) => {
        const v = l[key];
        return v > 0 && (best === null || v > best) ? v : best;
      }, null);
      const winner = maxA != null && maxB != null ? (maxA > maxB ? 'A' : maxA < maxB ? 'B' : null) : null;
      return {
        label,
        valueA: maxA != null ? `${toSpeed(maxA)} ${speedLabel}` : '—',
        valueB: maxB != null ? `${toSpeed(maxB)} ${speedLabel}` : '—',
        winner,
      };
    });
  }, [lapsA, lapsB, speedUnit]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const compute = (racing, sigma) => {
      if (racing.length === 0) return {};
      const times = racing.map((l) => l.LapTimeSeconds);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const fastest = Math.min(...times);
      return { avg, fastest, stdDev: sigma, laps: times.length };
    };
    const statsA = compute(racingA, sigmaA);
    const statsB = compute(racingB, sigmaB);
    const pitsA = pitCounts[driverA] || 0;
    const pitsB = pitCounts[driverB] || 0;

    const rows = [];
    if (statsA.avg && statsB.avg) {
      rows.push({
        label: 'Avg Lap',
        valueA: formatTime(statsA.avg),
        valueB: formatTime(statsB.avg),
        winner: statsA.avg < statsB.avg ? 'A' : statsA.avg > statsB.avg ? 'B' : null,
      });
    }
    if (statsA.fastest && statsB.fastest) {
      rows.push({
        label: 'Fastest Lap',
        valueA: formatTime(statsA.fastest),
        valueB: formatTime(statsB.fastest),
        winner: statsA.fastest < statsB.fastest ? 'A' : statsA.fastest > statsB.fastest ? 'B' : null,
      });
    }
    if (statsA.stdDev != null && statsB.stdDev != null) {
      rows.push({
        label: 'Consistency',
        valueA: `\u00B1${statsA.stdDev.toFixed(3)}s`,
        valueB: `\u00B1${statsB.stdDev.toFixed(3)}s`,
        winner: statsA.stdDev < statsB.stdDev ? 'A' : statsA.stdDev > statsB.stdDev ? 'B' : null,
      });
    }
    rows.push({
      label: 'Pit Stops',
      valueA: String(pitsA),
      valueB: String(pitsB),
      winner: null,
    });
    if (statsA.laps != null && statsB.laps != null) {
      rows.push({
        label: 'Racing Laps',
        valueA: String(statsA.laps),
        valueB: String(statsB.laps),
        winner: null,
      });
    }
    return rows;
  }, [racingA, racingB, sigmaA, sigmaB, pitCounts, driverA, driverB]);

  // Score: count wins across all metric rows
  const score = useMemo(() => {
    let winsA = 0, winsB = 0;
    [...sectorComparison, ...speedComparison, ...summaryStats].forEach((r) => {
      if (r.winner === 'A') winsA++;
      if (r.winner === 'B') winsB++;
    });
    return { winsA, winsB };
  }, [sectorComparison, speedComparison, summaryStats]);

  // ── D3: Gap evolution chart ──
  useEffect(() => {
    if (!gapChartRef.current || gapData.length < 2) return;
    const container = gapChartRef.current.parentElement;
    const { width: W, height: H } = container.getBoundingClientRect();
    const margin = { top: 20, right: 16, bottom: 28, left: 50 };
    const w = W - margin.left - margin.right;
    const h = H - margin.top - margin.bottom;

    const svg = d3.select(gapChartRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([gapData[0].lap, gapData[gapData.length - 1].lap]).range([0, w]);
    const maxGap = d3.max(gapData, (d) => Math.abs(d.gap)) || 1;
    const y = d3.scaleLinear().domain([-maxGap * 1.1, maxGap * 1.1]).range([h, 0]);

    // Grid
    g.append('g').attr('class', 'grid').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(x).ticks(Math.min(gapData.length, 10)).tickSize(-h).tickFormat('')
    ).selectAll('line').attr('stroke', 'rgba(255,255,255,0.05)');

    // Zero line
    g.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(0)).attr('y2', y(0))
      .attr('stroke', 'rgba(255,255,255,0.3)').attr('stroke-dasharray', '4,3');

    // Area: positive (A ahead) = green, negative (B ahead) = red
    const areaAbove = d3.area()
      .x((d) => x(d.lap))
      .y0(y(0))
      .y1((d) => d.gap >= 0 ? y(d.gap) : y(0))
      .curve(d3.curveMonotoneX);
    const areaBelow = d3.area()
      .x((d) => x(d.lap))
      .y0(y(0))
      .y1((d) => d.gap < 0 ? y(d.gap) : y(0))
      .curve(d3.curveMonotoneX);

    g.append('path').datum(gapData).attr('d', areaAbove)
      .attr('fill', colorA).attr('opacity', 0.15);
    g.append('path').datum(gapData).attr('d', areaBelow)
      .attr('fill', colorB).attr('opacity', 0.15);

    // Line
    const line = d3.line().x((d) => x(d.lap)).y((d) => y(d.gap)).curve(d3.curveMonotoneX);
    g.append('path').datum(gapData).attr('d', line)
      .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.8)').attr('stroke-width', 1.5);

    // Axes
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.min(gapData.length, 10)).tickFormat(d3.format('d')))
      .selectAll('text').attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', '9px');
    g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}s`))
      .selectAll('text').attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', '9px');

    // Driver labels on Y axis
    g.append('text').attr('x', -8).attr('y', y(maxGap * 0.7))
      .attr('fill', colorA).attr('font-size', '9px').attr('font-weight', '700')
      .attr('text-anchor', 'end').text(`${driverA} ahead`);
    g.append('text').attr('x', -8).attr('y', y(-maxGap * 0.7))
      .attr('fill', colorB).attr('font-size', '9px').attr('font-weight', '700')
      .attr('text-anchor', 'end').text(`${driverB} ahead`);

    // Title
    g.append('text').attr('x', w / 2).attr('y', -6)
      .attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', '10px')
      .attr('text-anchor', 'middle').attr('font-weight', '600').text('Gap Evolution');
    // Axis labels
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', w / 2).attr('y', h + 24)
      .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px')
      .attr('font-weight', 600).text('Lap');
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', 'rotate(-90)').attr('x', -h / 2).attr('y', -40)
      .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px')
      .attr('font-weight', 600).text('Gap (s)');

    // Clean up axis lines
    svg.selectAll('.domain').attr('stroke', 'rgba(255,255,255,0.1)');
    svg.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.08)');
  }, [gapData, driverA, driverB, colorA, colorB]);

  // ── D3: Lap times overlay ──
  useEffect(() => {
    if (!lapChartRef.current || racingA.length < 2 || racingB.length < 2) return;
    const container = lapChartRef.current.parentElement;
    const { width: W, height: H } = container.getBoundingClientRect();
    const margin = { top: 20, right: 16, bottom: 28, left: 50 };
    const w = W - margin.left - margin.right;
    const h = H - margin.top - margin.bottom;

    const svg = d3.select(lapChartRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const allLaps = [...racingA, ...racingB];
    const xDomain = d3.extent(allLaps, (d) => d.LapNumber);
    const yTimes = allLaps.map((d) => d.LapTimeSeconds);
    const yMin = d3.min(yTimes);
    const yMax = d3.max(yTimes);
    const yPad = (yMax - yMin) * 0.1 || 1;

    const x = d3.scaleLinear().domain(xDomain).range([0, w]);
    const y = d3.scaleLinear().domain([yMin - yPad, yMax + yPad]).range([h, 0]);

    // Grid
    g.append('g').attr('transform', `translate(0,${h})`).call(
      d3.axisBottom(x).ticks(Math.min(currentLap, 10)).tickSize(-h).tickFormat('')
    ).selectAll('line').attr('stroke', 'rgba(255,255,255,0.05)');

    // Lines
    const line = d3.line().x((d) => x(d.LapNumber)).y((d) => y(d.LapTimeSeconds)).curve(d3.curveMonotoneX);
    g.append('path').datum(racingA).attr('d', line)
      .attr('fill', 'none').attr('stroke', colorA).attr('stroke-width', 2).attr('opacity', 0.9);
    g.append('path').datum(racingB).attr('d', line)
      .attr('fill', 'none').attr('stroke', colorB).attr('stroke-width', 2).attr('opacity', 0.9);

    // Pit markers (in-laps of the pit stops visible at sessionNow)
    pitLapsA.forEach((l) => {
      g.append('circle').attr('cx', x(l.LapNumber)).attr('cy', y(l.LapTimeSeconds))
        .attr('r', 3).attr('fill', colorA).attr('stroke', '#fff').attr('stroke-width', 1);
    });
    pitLapsB.forEach((l) => {
      g.append('circle').attr('cx', x(l.LapNumber)).attr('cy', y(l.LapTimeSeconds))
        .attr('r', 3).attr('fill', colorB).attr('stroke', '#fff').attr('stroke-width', 1);
    });

    // Forecast overlay of a driver who has one (the focus driver's, asked by
    // a double-click): dashed line over its first 3 target laps, from the
    // forecast's origin lap (target_laps, never the last racing lap + i)
    [{ drv: driverA, color: colorA, laps: racingA },
     { drv: driverB, color: colorB, laps: racingB }].forEach(({ drv, color, laps }) => {
      const pred = focusForecast(lstmPredictions, drv);
      const points = forecastPoints(pred).slice(0, 3);
      if (!points.length || laps.length === 0) return;
      const origin = laps.find((l) => l.LapNumber === pred.lap);
      const predPoints = origin ? [{ LapNumber: origin.LapNumber, LapTimeSeconds: origin.LapTimeSeconds }] : [];
      points.forEach((p) => predPoints.push({ LapNumber: p.lap, LapTimeSeconds: p.time }));
      if (predPoints.length > 1) {
        const predLine = d3.line().x((d) => x(d.LapNumber)).y((d) => y(d.LapTimeSeconds)).curve(d3.curveMonotoneX);
        g.append('path').datum(predPoints).attr('d', predLine)
          .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.5)
          .attr('stroke-dasharray', '4,3').attr('opacity', 0.6);
        predPoints.slice(1).forEach((pt) => {
          g.append('circle').attr('cx', x(pt.LapNumber)).attr('cy', y(pt.LapTimeSeconds))
            .attr('r', 2).attr('fill', color).attr('opacity', 0.5).attr('stroke', 'none');
        });
      }
    });

    // Axes
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.min(currentLap, 10)).tickFormat(d3.format('d')))
      .selectAll('text').attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', '9px');
    g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat((d) => formatTime(d)))
      .selectAll('text').attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', '9px');

    // Legend
    const legend = g.append('g').attr('transform', `translate(${w - 120}, -6)`);
    [{ abbr: driverA, color: colorA }, { abbr: driverB, color: colorB }].forEach((d, i) => {
      const lg = legend.append('g').attr('transform', `translate(${i * 60}, 0)`);
      lg.append('line').attr('x1', 0).attr('x2', 14).attr('y1', 0).attr('y2', 0)
        .attr('stroke', d.color).attr('stroke-width', 2);
      lg.append('text').attr('x', 18).attr('y', 3)
        .attr('fill', d.color).attr('font-size', '9px').attr('font-weight', '700').text(d.abbr);
    });

    // Title
    g.append('text').attr('x', w / 2).attr('y', -6)
      .attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', '10px')
      .attr('text-anchor', 'middle').attr('font-weight', '600').text('Lap Times');
    // Axis labels
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', w / 2).attr('y', h + 24)
      .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px')
      .attr('font-weight', 600).text('Lap');
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', 'rotate(-90)').attr('x', -h / 2).attr('y', -40)
      .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', '8px')
      .attr('font-weight', 600).text('Time (s)');

    svg.selectAll('.domain').attr('stroke', 'rgba(255,255,255,0.1)');
    svg.selectAll('.tick line').attr('stroke', 'rgba(255,255,255,0.08)');
  }, [racingA, racingB, pitLapsA, pitLapsB, driverA, driverB, colorA, colorB, currentLap, lstmPredictions]);

  // ── Empty state ──
  if (!driverA || !driverB) {
    return (
      <div className="compare-panel__empty">
        <div>Select 2 drivers to compare</div>
        <div className="compare-panel__empty-selectors">
          <select
            className="compare-panel__driver-select"
            value={compareDrivers[0] || ''}
            onChange={(e) => {
              if (e.target.value) addCompareDriver(e.target.value);
            }}
          >
            <option value="">Driver A</option>
            {(driversList || []).map((d) => (
              <option key={d.Abbreviation} value={d.Abbreviation}>{d.Abbreviation} — {d.FullName}</option>
            ))}
          </select>
          <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '11px' }}>vs</span>
          <select
            className="compare-panel__driver-select"
            value={compareDrivers[1] || ''}
            onChange={(e) => {
              if (e.target.value) addCompareDriver(e.target.value);
            }}
          >
            <option value="">Driver B</option>
            {(driversList || []).map((d) => (
              <option key={d.Abbreviation} value={d.Abbreviation}>{d.Abbreviation} — {d.FullName}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.25)', marginTop: 4 }}>
          Tip: select drivers from the leaderboard, then open this panel
        </div>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="compare-panel">
      {/* Header */}
      <div className="compare-panel__header">
        <DriverCard abbr={driverA} info={infoA} color={colorA} />
        <div className="compare-panel__vs-block">
          <div className="compare-panel__vs">VS</div>
          <div className="compare-panel__score">{score.winsA} — {score.winsB}</div>
        </div>
        <DriverCard abbr={driverB} info={infoB} color={colorB} />
        <button
          onClick={handleExport}
          title="Export as PNG"
          style={{
            position: 'absolute', top: 6, right: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, borderRadius: 4,
            border: 'none', background: 'transparent',
            color: 'rgba(255,255,255,0.3)', cursor: 'pointer',
            fontSize: '12px', padding: 0, flexShrink: 0,
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="compare-panel__body">
        {/* Gap Evolution */}
        <div className="compare-panel__chart-container">
          <svg ref={gapChartRef} />
        </div>

        {/* Lap Times Overlay */}
        <div className="compare-panel__chart-container compare-panel__chart-container--small">
          <svg ref={lapChartRef} />
        </div>

        {/* Sector Times */}
        <MetricsTable title="Best Sector Times" rows={sectorComparison} driverA={driverA} driverB={driverB} />

        {/* Top Speeds */}
        <MetricsTable title="Top Speeds" rows={speedComparison} driverA={driverA} driverB={driverB} />

        {/* Summary */}
        <MetricsTable title="Race Summary" rows={summaryStats} driverA={driverA} driverB={driverB} />

        {/* Tyre Strategy */}
        <StrategyComparison
          driverA={driverA}
          driverB={driverB}
          stintsA={stintsMap[driverA] || []}
          stintsB={stintsMap[driverB] || []}
          currentLap={currentLap}
          maxLap={maxLap}
        />

        {/* Compound Legend */}
        <div className="sectors-panel__legend" style={{ padding: '6px 0 4px', justifyContent: 'center' }}>
          {['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) => (
            <span key={c} className="sectors-panel__legend-item">
              <span className="sectors-panel__legend-dot" style={{ background: TYRE_COLORS[c] }} />
              {TYRE_LABELS[c]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
