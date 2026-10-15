import React, {
  useMemo, useRef, useEffect, useCallback, useState,
} from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, getDriverDash, TYRE_COLORS, TYRE_LABELS, markColor, textColor,
  signedDelta, DIVERGING, TEXT_COLORS, GRID_COLORS, CHART_FONT, chartFontPx,
} from '../../utils/colors';
import Legend from '../ui/Legend';
import { useBoxSize } from '../../utils/views/chartBox';
import { compareSections, comparePages, COMPARE_GAP } from '../../utils/views/driverCompare';
import { drawStintStrips, lapTicks } from '../../utils/views/stintStripChart';

// Glyph next to the better of the two values of a metric row (with the
// diverging pair's "better" blue): the colour is never the only cue
const WINNER_GLYPH = '▲';
const FORECAST_DASH = '2,3';
// Pager text: the sections on the page
const SECTION_TITLES = {
  gap: 'Gap', laps: 'Lap times', sectors: 'Sectors', speeds: 'Top speeds', summary: 'Summary', tyres: 'Tyres',
};
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
      <span className="compare-panel__team-bar" style={{ backgroundColor: markColor(color) }} />
      <div className="compare-panel__driver-info">
        <span className="compare-panel__driver-abbr">{abbr}</span>
        {info && (
          <span className="compare-panel__driver-name" title={`${info.FullName} · ${info.TeamName}`}>
            {info.FullName}
            <span className="compare-panel__team-name"> · {info.TeamName}</span>
          </span>
        )}
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
            {r.winner === 'A' && <span className="timing-glyph" aria-label="better">{WINNER_GLYPH} </span>}
            {r.valueA}
          </span>
          <span className="compare-panel__metric-label">{r.label}</span>
          <span className={`compare-panel__metric-value compare-panel__metric-value--right${r.winner === 'B' ? ' compare-panel__metric-value--winner' : ''}`}>
            {r.valueB}
            {r.winner === 'B' && <span className="timing-glyph" aria-label="better"> {WINNER_GLYPH}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// stintsA / stintsB: deriveStints rows at sessionNow (causal: the ongoing
// stint already ends at the driver's last completed lap). Drawn as the D3
// stint strips of the other strategy views (utils/views/stintStripChart.js):
// one row per driver on one lap axis, each stint in its FIA compound colour
// with its letter and length, the lap in progress as a marker (V6 r2: this
// section was a div bar chart of percentage widths)
function StrategyComparison({ driverA, driverB, stintsA, stintsB, currentLap, maxLap }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const box = useBoxSize(boxRef);
  const totalLaps = maxLap || currentLap || 1;
  const hasStints = stintsA.length > 0 || stintsB.length > 0;

  useEffect(() => {
    if (!svgRef.current || !hasStints) return;
    const segments = (stints) => stints.map((s, i) => ({
      key: `${i}`,
      start: s.StartLap,
      // a stint just begun (pit exit passed, no lap completed) has 0 laps
      length: Math.max(0, s.EndLap - s.StartLap + 1),
      compound: s.Compound || 'UNKNOWN',
      title: `${s.Compound}: laps ${stintLapsText(s)}`,
    }));
    const fontPx = chartFontPx('data');
    drawStintStrips(svgRef.current, {
      rows: [
        { key: 'A', label: driverA, segments: segments(stintsA) },
        { key: 'B', label: driverB, segments: segments(stintsB) },
      ],
      domain: [1, totalLaps + 1],
      width: box.width > 0 ? box.width : 300,
      rowH: Math.max(18, Math.round(fontPx * 1.6)),
      labelW: Math.ceil(3 * 0.62 * fontPx) + 2,
      axis: { ticks: lapTicks(totalLaps), format: (v) => `L${v}` },
      marker: currentLap ? { value: currentLap + 0.5, title: `Lap ${currentLap}` } : null,
      font: CHART_FONT.data,
      fontPx,
    });
  });

  if (!hasStints) return null;
  return (
    <div className="compare-panel__metrics">
      <div className="compare-panel__metrics-title">Tyre Strategy</div>
      <div ref={boxRef} style={{ minWidth: 0, margin: '4px 10px 6px' }}>
        <svg ref={svgRef} className="compare-panel__stints-svg" style={{ display: 'block', maxWidth: '100%' }} />
      </div>
      {/* the stints as text for screen readers (the strips are drawn after mount) */}
      <p className="sr-only">
        {[[driverA, stintsA], [driverB, stintsB]]
          .map(([d, list]) => `${d}: ${list.map((st) => `${st.Compound}: laps ${stintLapsText(st)}`).join('; ')}`)
          .join('. ')}
      </p>
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
  // The body's box: its sections flow into columns and pages that fit it
  // (utils/views/driverCompare.js; V13: nothing cut, no scroll)
  const bodyRef = useRef(null);
  const bodyBox = useBoxSize(bodyRef);
  const [page, setPage] = useState(0);

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

  // Columns and pages of the sections in the body (charts >= 140 px tall)
  const hasStints = (stintsMap[driverA] || []).length > 0 || (stintsMap[driverB] || []).length > 0;
  const layout = useMemo(() => comparePages(bodyBox, compareSections({
    sectors: sectorComparison.length,
    speeds: speedComparison.length,
    summary: summaryStats.length,
    tyres: hasStints,
  }, chartFontPx('data'))), [bodyBox, sectorComparison, speedComparison, summaryStats, hasStints]);
  const pageIndex = Math.min(page, layout.pages.length - 1);
  const columns = layout.pages[pageIndex] || [];
  // Charts redraw when their box changes (page, column, panel size)
  const layoutKey = `${bodyBox.width}x${bodyBox.height}:${pageIndex}:${columns.map((c) => c.join('+')).join('|')}`;

  // ── D3: Gap evolution chart ──
  useEffect(() => {
    if (!gapChartRef.current || gapData.length < 2) return;
    const container = gapChartRef.current.parentElement;
    const { width: W, height: H } = container.getBoundingClientRect();
    // not laid out yet (or a pane too small to draw in): nothing to draw
    if (W < 80 || H < 70) return;
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
    ).selectAll('line').attr('stroke', GRID_COLORS.grid);

    // Zero line
    g.append('line').attr('x1', 0).attr('x2', w).attr('y1', y(0)).attr('y2', y(0))
      .attr('stroke', GRID_COLORS.rule).attr('stroke-dasharray', '4,3');

    // Area: positive (A ahead) in A's colour, negative (B ahead) in B's,
    // each side labelled with its driver ("A ahead" / "B ahead")
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
      .attr('fill', 'none').attr('stroke', TEXT_COLORS.primary).attr('stroke-width', 1.5);

    // Axes
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.min(gapData.length, 10)).tickFormat(d3.format('d')))
      .selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);
    g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${signedDelta(d, 1)}s`))
      .selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);

    // Driver labels on Y axis (the cue of each side's colour)
    g.append('text').attr('x', -8).attr('y', y(maxGap * 0.7))
      .attr('fill', textColor(colorA)).style('font-size', CHART_FONT.data).attr('font-weight', '700')
      .attr('text-anchor', 'end').text(`${driverA} ahead`);
    g.append('text').attr('x', -8).attr('y', y(-maxGap * 0.7))
      .attr('fill', textColor(colorB)).style('font-size', CHART_FONT.data).attr('font-weight', '700')
      .attr('text-anchor', 'end').text(`${driverB} ahead`);

    // Title
    g.append('text').attr('x', w / 2).attr('y', -6)
      .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.label)
      .attr('text-anchor', 'middle').attr('font-weight', '600').text('Gap Evolution');
    // Axis labels
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', w / 2).attr('y', h + 24)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Lap');
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', 'rotate(-90)').attr('x', -h / 2).attr('y', -40)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Gap (s)');

    // Clean up axis lines
    svg.selectAll('.domain').attr('stroke', GRID_COLORS.axis);
    svg.selectAll('.tick line').attr('stroke', GRID_COLORS.axis);
  }, [gapData, driverA, driverB, colorA, colorB, layoutKey]);

  // ── D3: Lap times overlay ──
  useEffect(() => {
    if (!lapChartRef.current || racingA.length < 2 || racingB.length < 2) return;
    const container = lapChartRef.current.parentElement;
    const { width: W, height: H } = container.getBoundingClientRect();
    if (W < 80 || H < 70) return;
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
    ).selectAll('line').attr('stroke', GRID_COLORS.grid);

    // Lines: each driver's colour (>= 3:1), the teammate's dashed (V3)
    const markA = markColor(colorA);
    const markB = markColor(colorB);
    const line = d3.line().x((d) => x(d.LapNumber)).y((d) => y(d.LapTimeSeconds)).curve(d3.curveMonotoneX);
    g.append('path').datum(racingA).attr('d', line)
      .attr('fill', 'none').attr('stroke', markA).attr('stroke-width', 2).attr('stroke-dasharray', getDriverDash(driverA));
    g.append('path').datum(racingB).attr('d', line)
      .attr('fill', 'none').attr('stroke', markB).attr('stroke-width', 2).attr('stroke-dasharray', getDriverDash(driverB));

    // Pit markers (in-laps of the pit stops visible at sessionNow)
    pitLapsA.forEach((l) => {
      g.append('circle').attr('cx', x(l.LapNumber)).attr('cy', y(l.LapTimeSeconds))
        .attr('r', 3).attr('fill', markA).attr('stroke', TEXT_COLORS.primary).attr('stroke-width', 1);
    });
    pitLapsB.forEach((l) => {
      g.append('circle').attr('cx', x(l.LapNumber)).attr('cy', y(l.LapTimeSeconds))
        .attr('r', 3).attr('fill', markB).attr('stroke', TEXT_COLORS.primary).attr('stroke-width', 1);
    });

    // Forecast overlay of a driver who has one (the focus driver's, asked by
    // a double-click): dashed line over its first 3 target laps, from the
    // forecast's origin lap (target_laps, never the last racing lap + i)
    [{ drv: driverA, color: markA, laps: racingA },
     { drv: driverB, color: markB, laps: racingB }].forEach(({ drv, color, laps }) => {
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
          .attr('stroke-linecap', 'round').attr('stroke-dasharray', FORECAST_DASH);
        predPoints.slice(1).forEach((pt) => {
          g.append('circle').attr('cx', x(pt.LapNumber)).attr('cy', y(pt.LapTimeSeconds))
            .attr('r', 2.5).attr('fill', 'none').attr('stroke', color).attr('stroke-width', 1.2);
        });
      }
    });

    // Axes
    g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x).ticks(Math.min(currentLap, 10)).tickFormat(d3.format('d')))
      .selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);
    g.append('g').call(d3.axisLeft(y).ticks(5).tickFormat((d) => formatTime(d)))
      .selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);

    // Title
    g.append('text').attr('x', w / 2).attr('y', -6)
      .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.label)
      .attr('text-anchor', 'middle').attr('font-weight', '600').text('Lap Times');
    // Axis labels
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', w / 2).attr('y', h + 24)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Lap');
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', 'rotate(-90)').attr('x', -h / 2).attr('y', -40)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Time (s)');

    svg.selectAll('.domain').attr('stroke', GRID_COLORS.axis);
    svg.selectAll('.tick line').attr('stroke', GRID_COLORS.axis);
  }, [racingA, racingB, pitLapsA, pitLapsB, driverA, driverB, colorA, colorB, currentLap, lstmPredictions, layoutKey]);

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
          <span style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.data }}>vs</span>
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
        <div style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.muted, marginTop: 4 }}>
          Tip: select drivers from the leaderboard, then open this panel
        </div>
      </div>
    );
  }

  // One section of the body; a chart takes what its column leaves (the
  // layout gives it >= COMPARE_CHART_MIN_H px wherever the pane allows)
  const sectionView = (key) => {
    switch (key) {
      case 'gap':
        return (
          <div key="gap" className="compare-panel__chart-container">
            <svg ref={gapChartRef} />
          </div>
        );
      case 'laps':
        // Lap Times Overlay, its legend: the two drivers' lines (teammate
        // dashed), pit in-laps, the dotted forecast
        return (
          <div key="laps" className="compare-panel__chart-block">
            <Legend items={[
              { label: driverA, color: markColor(colorA), shape: 'line', dash: getDriverDash(driverA) },
              { label: driverB, color: markColor(colorB), shape: 'line', dash: getDriverDash(driverB) },
              { label: 'Pit in-lap', color: TEXT_COLORS.primary, glyph: '\u25CF', shape: 'glyph' },
              { label: 'Forecast', color: TEXT_COLORS.secondary, shape: 'line', dash: FORECAST_DASH },
              { label: 'Better value', color: DIVERGING.better, glyph: WINNER_GLYPH, shape: 'glyph' },
            ]} />
            <div className="compare-panel__chart-container">
              <svg ref={lapChartRef} />
            </div>
          </div>
        );
      case 'sectors':
        return <MetricsTable key="sectors" title="Best Sector Times" rows={sectorComparison} driverA={driverA} driverB={driverB} />;
      case 'speeds':
        return <MetricsTable key="speeds" title="Top Speeds" rows={speedComparison} driverA={driverA} driverB={driverB} />;
      case 'summary':
        return <MetricsTable key="summary" title="Race Summary" rows={summaryStats} driverA={driverA} driverB={driverB} />;
      case 'tyres':
        return (
          <div key="tyres" className="compare-panel__tyres">
            <StrategyComparison
              driverA={driverA}
              driverB={driverB}
              stintsA={stintsMap[driverA] || []}
              stintsB={stintsMap[driverB] || []}
              currentLap={currentLap}
              maxLap={maxLap}
            />
            {/* Compound legend: FIA colour with its letter, as in the stint bars */}
            <div className="sectors-panel__legend" style={{ padding: '4px 0 0', justifyContent: 'center' }}>
              <Legend items={['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) => ({
                label: c[0] + c.slice(1).toLowerCase(), color: TYRE_COLORS[c], glyph: TYRE_LABELS[c], shape: 'badge',
              }))} />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

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
            color: TEXT_COLORS.muted, cursor: 'pointer',
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

      {/* Body: the sections in columns and pages that fit the pane (no scroll) */}
      <div ref={bodyRef} className="compare-panel__body">
        <div className="compare-panel__columns" style={{ gap: COMPARE_GAP }}>
          {columns.map((col) => (
            <div key={col.join('+')} className="compare-panel__column" style={{ gap: COMPARE_GAP }}>
              {col.map((key) => sectionView(key))}
            </div>
          ))}
        </div>
        {layout.pages.length > 1 && (
          <div className="compare-panel__pager">
            <button type="button" aria-label="Previous sections" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>{'\u25C0'}</button>
            <span>{pageIndex + 1} / {layout.pages.length}: {columns.flat().map((k) => SECTION_TITLES[k]).join(', ')}</span>
            <button type="button" aria-label="Next sections" disabled={pageIndex >= layout.pages.length - 1} onClick={() => setPage(pageIndex + 1)}>{'\u25B6'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
