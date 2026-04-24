import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

/* Simple least-squares linear regression: y = intercept + slope * x */
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const xMean = d3.mean(points, (p) => p.x);
  const yMean = d3.mean(points, (p) => p.y);
  let num = 0, den = 0;
  points.forEach((p) => {
    num += (p.x - xMean) * (p.y - yMean);
    den += (p.x - xMean) * (p.x - xMean);
  });
  if (den === 0) return null;
  const slope = num / den;
  const intercept = yMean - slope * xMean;
  return { slope, intercept };
}

export default function TireDegradation() {
  const svgRef = useRef(null);
  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const degradationRegression = useF1Store((s) => s.degradationRegression);
  const fetchDegradationRegression = useF1Store((s) => s.fetchDegradationRegression);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const dnfMap = useF1Store((s) => s.dnfMap);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const brushLapRange = useF1Store((s) => s.brushLapRange);
  const year = useF1Store((s) => s.year);
  const round = useF1Store((s) => s.round);

  // Auto-trigger degradation regression when a lap range is selected via visual interaction
  const activeRange = brushLapRange || selectedLapRange;
  useEffect(() => {
    const driver = focusDriver || selectedDrivers[0];
    if (!activeRange || !driver || !year || !round) return;
    fetchDegradationRegression({
      year, round, drivers: [driver],
      lap_start: activeRange[0],
      lap_end: activeRange[1],
    });
  }, [activeRange, focusDriver, selectedDrivers, year, round, fetchDegradationRegression]);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);

  // Pick driver: focusDriver → first selectedDriver → null
  const driver = focusDriver || selectedDrivers[0] || null;
  const driverColor = driver ? getDriverColor(driver) : '#888';

  // Check if the focused driver has retired
  const driverDnf = driver ? dnfMap[driver] : null;
  const isDriverRetired = driverDnf && driverDnf.lastLap <= currentLap;

  // Build stint data with linear regression per stint
  const chartData = useMemo(() => {
    if (!driver || lapTimes.length === 0) return { stints: [], yExtent: [80, 100] };

    const driverLaps = lapTimes
      .filter((d) => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber);

    if (driverLaps.length === 0) return { stints: [], yExtent: [80, 100] };

    // Group into stints by compound change or tyre life reset at pit stop
    const stints = [];
    let current = { compound: driverLaps[0].Compound || 'UNKNOWN', laps: [] };

    driverLaps.forEach((lap) => {
      const compound = lap.Compound || 'UNKNOWN';
      const isPitOut = !!lap.PitOutTime;
      const compoundChanged = compound !== current.compound;
      const tyreLifeReset = lap.TyreLife != null && lap.TyreLife <= 1 && current.laps.length > 2;
      if ((compoundChanged || (tyreLifeReset && isPitOut)) && current.laps.length > 0) {
        stints.push(current);
        current = { compound, laps: [] };
      }
      current.laps.push({
        lapNumber: lap.LapNumber,
        lapTime: lap.LapTimeSeconds,
        tyreLife: lap.TyreLife || current.laps.length + 1,
        compound,
        isPitIn: lap.PitInTime != null,
        isPitOut: lap.PitOutTime != null,
      });
    });
    if (current.laps.length > 0) stints.push(current);

    // Filter outliers and compute linear regression per stint
    const allCleanTimes = [];
    stints.forEach((stint, idx) => {
      const times = stint.laps.map((l) => l.lapTime);
      const median = d3.median(times);
      const threshold = median * 1.3;

      // Mark outliers: pit in/out, abnormally slow (SC, VSC, red flag)
      stint.laps.forEach((lap) => {
        lap.isOutlier = lap.lapTime > threshold || lap.isPitIn || lap.isPitOut;
      });

      // Clean laps for regression and rendering
      stint.cleanLaps = stint.laps.filter((l) => !l.isOutlier);
      stint.cleanLaps.forEach((l) => allCleanTimes.push(l.lapTime));

      // Linear regression: lapTime = intercept + slope * tyreLife
      const regressionPoints = stint.cleanLaps.map((l) => ({ x: l.tyreLife, y: l.lapTime }));
      stint.regression = linearRegression(regressionPoints);

      stint.stintIndex = idx;
      stint.startLap = stint.laps[0]?.lapNumber;
      stint.endLap = stint.laps[stint.laps.length - 1]?.lapNumber;
    });

    // Y-axis extent from clean lap times
    const yExtent = allCleanTimes.length > 0
      ? [d3.min(allCleanTimes), d3.max(allCleanTimes)]
      : [80, 100];

    return { stints, yExtent };
  }, [driver, lapTimes, maxLap, currentLap]);

  // Pit window info
  const pitWindow = useMemo(() => {
    if (degradationRegression?.undercut_window) {
      return degradationRegression.undercut_window;
    }
    if (lstmPredictions?.optimal_pit_lap) {
      const pit = lstmPredictions.optimal_pit_lap;
      return [Math.max(1, pit - 3), pit + 3];
    }
    return null;
  }, [degradationRegression, lstmPredictions]);

  // Driver badge for panel header
  const driverBadge = driver ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 11, fontWeight: 800, fontFamily: "'Titillium Web', sans-serif",
      textTransform: 'uppercase', letterSpacing: '0.06em',
    }}>
      <span style={{
        width: 3, height: 14, borderRadius: 1.5,
        background: driverColor, flexShrink: 0,
      }} />
      <span style={{ color: driverColor }}>{driver}</span>
    </div>
  ) : null;

  // Legend items from active stints
  const legendItems = useMemo(() => {
    const compounds = new Set();
    chartData.stints.forEach((s) => compounds.add(s.compound));
    return [...compounds].map((c) => ({
      label: c,
      color: TYRE_COLORS[c] || '#888',
      shape: 'circle',
    }));
  }, [chartData]);

  // D3 rendering — scatter plot with regression lines
  useEffect(() => {
    if (!svgRef.current) return;

    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 600;
    const height = rect.height || 250;
    const margin = { top: 12, right: 16, bottom: 30, left: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    // No driver state
    if (!driver || chartData.stints.length === 0) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', 12)
        .attr('font-family', "'Titillium Web', sans-serif")
        .text('Focus a driver to view tyre degradation');
      return;
    }

    // Check we have data
    const hasData = chartData.stints.some((s) => s.cleanLaps.length >= 2);
    if (!hasData) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', 12)
        .attr('font-family', "'Titillium Web', sans-serif")
        .text('Not enough lap data for degradation analysis');
      return;
    }

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Compute global max tyre life across stints
    let maxTyreLife = 1;
    chartData.stints.forEach((s) => {
      s.cleanLaps.forEach((l) => {
        if (l.tyreLife > maxTyreLife) maxTyreLife = l.tyreLife;
      });
    });

    // Scales
    const x = d3.scaleLinear()
      .domain([0, maxTyreLife + 1])
      .range([0, innerW]);

    const yPad = (chartData.yExtent[1] - chartData.yExtent[0]) * 0.12 || 1;
    const y = d3.scaleLinear()
      .domain([chartData.yExtent[0] - yPad, chartData.yExtent[1] + yPad])
      .range([innerH, 0]);

    // Grid lines
    const xTicks = x.ticks(Math.min(12, maxTyreLife));
    g.selectAll('.grid-v')
      .data(xTicks)
      .enter()
      .append('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d))
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', 'rgba(255,255,255,0.04)')
      .attr('stroke-width', 1);

    const yTicks = y.ticks(5);
    g.selectAll('.grid-h')
      .data(yTicks)
      .enter()
      .append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', (d) => y(d)).attr('y2', (d) => y(d))
      .attr('stroke', 'rgba(255,255,255,0.04)')
      .attr('stroke-width', 1);

    // X-axis
    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, maxTyreLife)).tickFormat(d3.format('d')).tickSize(3));

    xAxisG.selectAll('text')
      .attr('fill', 'rgba(255,255,255,0.35)')
      .attr('font-size', '9px')
      .attr('font-family', 'var(--font-mono)');
    xAxisG.selectAll('line').attr('stroke', 'rgba(255,255,255,0.15)');
    xAxisG.select('.domain').attr('stroke', 'rgba(255,255,255,0.1)');

    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 24)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-weight', 700)
      .attr('font-family', "'Titillium Web', sans-serif")
      .text('Tyre life (laps)');

    // Y-axis — format as m:ss.sss
    const formatLapTime = (sec) => {
      const m = Math.floor(sec / 60);
      const s = (sec % 60).toFixed(1).padStart(4, '0');
      return `${m}:${s}`;
    };
    const yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat(formatLapTime).tickSize(3));

    yAxisG.selectAll('text')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-family', 'var(--font-mono)');
    yAxisG.selectAll('line').attr('stroke', 'rgba(255,255,255,0.1)');
    yAxisG.select('.domain').attr('stroke', 'rgba(255,255,255,0.08)');

    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2).attr('y', -42)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-weight', 700)
      .attr('font-family', "'Titillium Web', sans-serif")
      .text('Lap time');

    // Draw each stint: scatter points + regression line + slope annotation
    chartData.stints.forEach((stint) => {
      if (stint.cleanLaps.length < 2) return;
      const compoundColor = TYRE_COLORS[stint.compound] || '#888';

      // Scatter points (clean laps)
      g.selectAll(`.dot-stint-${stint.stintIndex}`)
        .data(stint.cleanLaps)
        .enter()
        .append('circle')
        .attr('cx', (d) => x(d.tyreLife))
        .attr('cy', (d) => y(d.lapTime))
        .attr('r', 3)
        .attr('fill', compoundColor)
        .attr('opacity', 0.55)
        .attr('stroke', compoundColor)
        .attr('stroke-width', 0.5)
        .attr('stroke-opacity', 0.3);

      // Outlier laps — small hollow circles
      const outliers = stint.laps.filter((l) => l.isOutlier && l.lapTime <= chartData.yExtent[1] + yPad);
      g.selectAll(`.outlier-stint-${stint.stintIndex}`)
        .data(outliers)
        .enter()
        .append('circle')
        .attr('cx', (d) => x(d.tyreLife))
        .attr('cy', (d) => y(d.lapTime))
        .attr('r', 2)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(255,255,255,0.15)')
        .attr('stroke-width', 0.8);

      // Regression fit line
      if (stint.regression) {
        const { slope, intercept } = stint.regression;
        const tyreMin = d3.min(stint.cleanLaps, (l) => l.tyreLife);
        const tyreMax = d3.max(stint.cleanLaps, (l) => l.tyreLife);

        g.append('line')
          .attr('x1', x(tyreMin))
          .attr('y1', y(intercept + slope * tyreMin))
          .attr('x2', x(tyreMax))
          .attr('y2', y(intercept + slope * tyreMax))
          .attr('stroke', compoundColor)
          .attr('stroke-width', 1.8)
          .attr('opacity', 0.9)
          .attr('stroke-dasharray', '6,3');

        // Slope annotation near end of fit line. Show both the raw slope and
        // the fuel-corrected slope (raw + 30 ms/lap): at Monza every Hard stint
        // returns a negative raw slope because fuel burn dominates (H2/V2.2).
        const FUEL_CORRECTION = 0.030;
        const slopeCorr = slope + FUEL_CORRECTION;
        const slopeSign = slope >= 0 ? '+' : '';
        const corrSign = slopeCorr >= 0 ? '+' : '';
        const slopeLabel = `${slopeSign}${slope.toFixed(3)} s/lap (raw)`;
        const corrLabel = `${corrSign}${slopeCorr.toFixed(3)} s/lap (tyre only)`;
        const annotX = tyreMax;
        const annotY = intercept + slope * tyreMax;

        g.append('text')
          .attr('x', x(annotX) + 4)
          .attr('y', y(annotY) - 5)
          .attr('fill', compoundColor)
          .attr('font-size', '9px')
          .attr('font-weight', 700)
          .attr('font-family', 'var(--font-mono)')
          .attr('opacity', 0.9)
          .text(slopeLabel);

        g.append('text')
          .attr('x', x(annotX) + 4)
          .attr('y', y(annotY) + 6)
          .attr('fill', compoundColor)
          .attr('font-size', '8px')
          .attr('font-weight', 600)
          .attr('font-family', 'var(--font-mono)')
          .attr('opacity', 0.62)
          .text(corrLabel);
      }

      // Stint label at first point
      const first = stint.cleanLaps[0];
      g.append('text')
        .attr('x', x(first.tyreLife) - 2)
        .attr('y', y(first.lapTime) - 8)
        .attr('fill', compoundColor)
        .attr('font-size', '8px')
        .attr('font-weight', 700)
        .attr('font-family', 'var(--font-mono)')
        .attr('opacity', 0.65)
        .text(`S${stint.stintIndex + 1}`);
    });

    // Tooltip on hover
    g.append('rect')
      .attr('width', innerW).attr('height', innerH)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mousemove', (event) => {
        const [mx, my] = d3.pointer(event);
        const hoveredTyreLife = x.invert(mx);
        const hoveredLapTime = y.invert(my);

        // Find closest clean data point across all stints
        let closest = null;
        let closestStint = null;
        let minDist = Infinity;
        chartData.stints.forEach((stint) => {
          stint.cleanLaps.forEach((d) => {
            // Normalize distance across both axes
            const dx = (d.tyreLife - hoveredTyreLife) / (maxTyreLife || 1);
            const dy = (d.lapTime - hoveredLapTime) / ((chartData.yExtent[1] - chartData.yExtent[0]) || 1);
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) { minDist = dist; closest = d; closestStint = stint; }
          });
        });

        g.selectAll('.hover-line-v, .hover-line-h, .hover-dot').remove();
        d3.select('.deg-tooltip').classed('visible', false).style('opacity', 0);

        if (!closest || minDist > 0.15) return;

        const compColor = TYRE_COLORS[closestStint.compound] || '#888';

        // Crosshair
        g.append('line')
          .attr('class', 'hover-line-v')
          .attr('x1', x(closest.tyreLife)).attr('x2', x(closest.tyreLife))
          .attr('y1', 0).attr('y2', innerH)
          .attr('stroke', 'rgba(255,255,255,0.12)')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3');
        g.append('line')
          .attr('class', 'hover-line-h')
          .attr('x1', 0).attr('x2', innerW)
          .attr('y1', y(closest.lapTime)).attr('y2', y(closest.lapTime))
          .attr('stroke', 'rgba(255,255,255,0.08)')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3');

        g.append('circle')
          .attr('class', 'hover-dot')
          .attr('cx', x(closest.tyreLife))
          .attr('cy', y(closest.lapTime))
          .attr('r', 4.5)
          .attr('fill', compColor)
          .attr('stroke', '#fff')
          .attr('stroke-width', 1.5);

        // Tooltip content
        const slopeText = closestStint.regression
          ? `${closestStint.regression.slope >= 0 ? '+' : ''}${closestStint.regression.slope.toFixed(3)} s/lap`
          : '—';
        const tooltipHtml = `
          <div style="color:${driverColor};font-weight:700;font-size:11px">${driver}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.5)">Lap ${closest.lapNumber} · tyre lap ${closest.tyreLife}</div>
          <div style="font-size:12px;font-weight:700">${Math.floor(closest.lapTime / 60)}:${(closest.lapTime % 60).toFixed(3).padStart(6, '0')}</div>
          <div style="font-size:9px;color:${compColor}">${closestStint.compound} — S${closestStint.stintIndex + 1}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.5)">Deg: ${slopeText}</div>
        `;
        let tooltip = d3.select('.deg-tooltip');
        if (!tooltip.size()) {
          tooltip = d3.select('body').append('div').attr('class', 'tooltip deg-tooltip');
        }
        tooltip
          .html(tooltipHtml)
          .style('left', event.pageX + 14 + 'px')
          .style('top', event.pageY - 14 + 'px')
          .classed('visible', true)
          .style('opacity', 1);
      })
      .on('mouseleave', () => {
        g.selectAll('.hover-line-v, .hover-line-h, .hover-dot').remove();
        d3.select('.deg-tooltip').classed('visible', false).style('opacity', 0);
      });

    return () => {
      d3.select('body').select('.deg-tooltip').remove();
    };
  }, [chartData, driver, driverColor, currentLap, isDriverRetired, driverDnf]);

  return (
    <Panel
      title="Tyre Degradation"
      className="panel-degradation"
      controls={<>{driverBadge}<Legend items={legendItems} shape="circle" /></>}
      focused={focusedView === 'tires'}
      shortcutKey="4"
    >
      <div className="viz-container deg-manager">
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        {pitWindow && (
          <div className="deg-pit-window">
            <span className="deg-pit-window__label">&#9668; NEXT PIT WINDOW</span>
            <span className="deg-pit-window__range">LAP {pitWindow[0]} &ndash; {pitWindow[1]}</span>
          </div>
        )}
      </div>
    </Panel>
  );
}
