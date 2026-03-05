import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS, TYRE_LABELS } from '../../utils/colors';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';

export default function TireDegradation() {
  const svgRef = useRef(null);
  const focusedView = useF1Store((s) => s.focusedView);
  const sessionData = useF1Store((s) => s.sessionData);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const maxLap = useF1Store((s) => s.maxLap);
  const degradationRegression = useF1Store((s) => s.degradationRegression);
  const lstmPredictions = useF1Store((s) => s.lstmPredictions);
  const dnfMap = useF1Store((s) => s.dnfMap);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);

  // Pick driver: focusDriver → first selectedDriver → null
  const driver = focusDriver || selectedDrivers[0] || null;
  const driverColor = driver ? getDriverColor(driver) : '#888';

  // Check if the focused driver has retired
  const driverDnf = driver ? dnfMap[driver] : null;
  const isDriverRetired = driverDnf && driverDnf.lastLap <= currentLap;

  // Build stint-based degradation data using the correct formula:
  // degradation_delta(i) = (laptime(i) - laptime(i-1)) / laptime(i)
  const chartData = useMemo(() => {
    if (!driver || lapTimes.length === 0) return { stints: [], maxTyreLap: 1 };

    const driverLaps = lapTimes
      .filter((d) => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber);

    if (driverLaps.length === 0) return { stints: [], maxTyreLap: 1 };

    // Group into stints by compound change or tyre life reset
    const stints = [];
    let current = { compound: driverLaps[0].Compound || 'UNKNOWN', laps: [] };

    driverLaps.forEach((lap) => {
      const compound = lap.Compound || 'UNKNOWN';
      const isPitOut = !!lap.PitOutTime;
      const compoundChanged = compound !== current.compound;
      // Only treat TyreLife reset as new stint if compound also changed or it's a pit out
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

    // Compute degradation delta per stint
    let maxTyreLap = 1;
    stints.forEach((stint) => {
      // Filter outliers: > 1.3x median (pit in/out, safety cars)
      const times = stint.laps.map((l) => l.lapTime);
      const median = d3.median(times);
      const threshold = median * 1.3;

      // Mark outliers: pit in/out laps, SC laps (abnormally slow)
      stint.laps.forEach((lap) => {
        lap.isOutlier = lap.lapTime > threshold || lap.isPitIn || lap.isPitOut;
      });

      // Compute degradation_delta(i) = (laptime(i) - laptime(i-1)) / laptime(i)
      // Only for valid (non-outlier) consecutive laps
      stint.deltas = [];
      for (let i = 1; i < stint.laps.length; i++) {
        const prev = stint.laps[i - 1];
        const curr = stint.laps[i];

        if (prev.isOutlier || curr.isOutlier) continue;

        if (curr.lapTime <= 0) continue;
        const delta = (curr.lapTime - prev.lapTime) / curr.lapTime;
        if (!isFinite(delta)) continue;
        stint.deltas.push({
          tyreLap: i + 1, // laps on this tyre set (1-indexed, delta starts from lap 2)
          lapNumber: curr.lapNumber,
          delta,
          lapTime: curr.lapTime,
          tyreLife: curr.tyreLife,
        });
      }

      // Apply rolling average smoothing (window=3)
      stint.smoothed = stint.deltas.map((d, i, arr) => {
        const start = Math.max(0, i - 1);
        const end = Math.min(arr.length, i + 2);
        const window = arr.slice(start, end);
        const avgDelta = d3.mean(window, (w) => w.delta);
        return { ...d, smoothedDelta: avgDelta };
      });

      stint.startLap = stint.laps[0]?.lapNumber;
      stint.endLap = stint.laps[stint.laps.length - 1]?.lapNumber;

      if (stint.smoothed.length > 0) {
        const maxTL = d3.max(stint.smoothed, (d) => d.tyreLap);
        if (maxTL > maxTyreLap) maxTyreLap = maxTL;
      }
    });

    return { stints, maxTyreLap };
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

  // D3 rendering
  useEffect(() => {
    if (!svgRef.current) return;

    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = rect.width || 600;
    const height = rect.height || 250;
    const margin = { top: 12, right: 16, bottom: 30, left: 50 };
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

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Collect all smoothed delta values for Y domain
    const allDeltas = chartData.stints.flatMap((s) => s.smoothed.map((d) => d.smoothedDelta)).filter(isFinite);
    if (allDeltas.length === 0) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.35)').attr('font-size', 12)
        .attr('font-family', "'Titillium Web', sans-serif")
        .text('Not enough lap data for degradation analysis');
      return;
    }

    const yMin = Math.min(d3.min(allDeltas), -0.002);
    const yMax = Math.max(d3.max(allDeltas), 0.002);
    const yPad = (yMax - yMin) * 0.15;

    // X scale: laps on tyre set
    const x = d3.scaleLinear()
      .domain([1, chartData.maxTyreLap + 1])
      .range([0, innerW]);

    // Y scale: degradation delta
    const y = d3.scaleLinear()
      .domain([yMin - yPad, yMax + yPad])
      .range([innerH, 0]);

    // Subtle vertical grid lines
    const xTicks = x.ticks(Math.min(12, chartData.maxTyreLap));
    g.selectAll('.grid-v')
      .data(xTicks)
      .enter()
      .append('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d))
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', 'rgba(255,255,255,0.04)')
      .attr('stroke-width', 1);

    // Reference line at y=0
    g.append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', y(0)).attr('y2', y(0))
      .attr('stroke', 'rgba(255,255,255,0.2)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '4,4');

    // X-axis
    const xAxisG = g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, chartData.maxTyreLap)).tickFormat(d3.format('d')).tickSize(3));

    xAxisG.selectAll('text')
      .attr('fill', 'rgba(255,255,255,0.35)')
      .attr('font-size', '9px')
      .attr('font-family', "var(--font-mono)");
    xAxisG.selectAll('line').attr('stroke', 'rgba(255,255,255,0.15)');
    xAxisG.select('.domain').attr('stroke', 'rgba(255,255,255,0.1)');

    // X-axis label
    g.append('text')
      .attr('x', innerW / 2).attr('y', innerH + 24)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-weight', 700)
      .attr('font-family', "'Titillium Web', sans-serif")
      .text('Laps on tyre set');

    // Y-axis
    const yAxisG = g.append('g')
      .call(d3.axisLeft(y).ticks(5).tickFormat((d) => `${(d * 100).toFixed(1)}%`).tickSize(3));

    yAxisG.selectAll('text')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-family', "var(--font-mono)");
    yAxisG.selectAll('line').attr('stroke', 'rgba(255,255,255,0.1)');
    yAxisG.select('.domain').attr('stroke', 'rgba(255,255,255,0.08)');

    // Y-axis label (rotated)
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2).attr('y', -38)
      .attr('text-anchor', 'middle')
      .attr('fill', 'rgba(255,255,255,0.3)')
      .attr('font-size', '8px')
      .attr('font-weight', 700)
      .attr('font-family', "'Titillium Web', sans-serif")
      .text('Degradation \u0394 (s/lap)');

    // Draw degradation curves per stint
    chartData.stints.forEach((stint, i) => {
      if (stint.smoothed.length < 2) return;

      const compoundColor = TYRE_COLORS[stint.compound] || '#888';

      // Line
      const line = d3.line()
        .x((d) => x(d.tyreLap))
        .y((d) => y(d.smoothedDelta))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(stint.smoothed)
        .attr('d', line)
        .attr('fill', 'none')
        .attr('stroke', compoundColor)
        .attr('stroke-width', 2)
        .attr('opacity', 0.85);

      // Data point dots
      g.selectAll(`.dot-stint-${i}`)
        .data(stint.smoothed)
        .enter()
        .append('circle')
        .attr('cx', (d) => x(d.tyreLap))
        .attr('cy', (d) => y(d.smoothedDelta))
        .attr('r', 2.5)
        .attr('fill', compoundColor)
        .attr('opacity', 0.6);

      // Stint label at start
      if (stint.smoothed.length > 0) {
        const first = stint.smoothed[0];
        g.append('text')
          .attr('x', x(first.tyreLap) + 4)
          .attr('y', y(first.smoothedDelta) - 6)
          .attr('fill', compoundColor)
          .attr('font-size', '8px')
          .attr('font-weight', 700)
          .attr('font-family', "var(--font-mono)")
          .attr('opacity', 0.7)
          .text(`S${i + 1}`);
      }
    });

    // Tooltip on hover
    g.append('rect')
      .attr('width', innerW).attr('height', innerH)
      .attr('fill', 'transparent')
      .attr('cursor', 'crosshair')
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event);
        const hoveredTyreLap = x.invert(mx);

        // Find closest data point across all stints
        let closest = null;
        let closestStint = null;
        let minDist = Infinity;
        chartData.stints.forEach((stint) => {
          stint.smoothed.forEach((d) => {
            const dist = Math.abs(d.tyreLap - hoveredTyreLap);
            if (dist < minDist) { minDist = dist; closest = d; closestStint = stint; }
          });
        });

        // Remove old crosshair
        g.selectAll('.hover-line, .hover-dot').remove();
        d3.select('.deg-tooltip').classed('visible', false).style('opacity', 0);

        if (!closest || minDist > 1.5) return;

        const compColor = TYRE_COLORS[closestStint.compound] || '#888';

        // Vertical hover line
        g.append('line')
          .attr('class', 'hover-line')
          .attr('x1', x(closest.tyreLap)).attr('x2', x(closest.tyreLap))
          .attr('y1', 0).attr('y2', innerH)
          .attr('stroke', 'rgba(255,255,255,0.15)')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '3,3');

        // Dot on curve
        g.append('circle')
          .attr('class', 'hover-dot')
          .attr('cx', x(closest.tyreLap))
          .attr('cy', y(closest.smoothedDelta))
          .attr('r', 4)
          .attr('fill', compColor)
          .attr('stroke', '#fff')
          .attr('stroke-width', 1.5);

        // Format delta as seconds
        const deltaSign = closest.smoothedDelta >= 0 ? '+' : '';
        const deltaSec = (closest.smoothedDelta * closest.lapTime).toFixed(3);
        const deltaPercent = (closest.smoothedDelta * 100).toFixed(2);

        // Tooltip
        const tooltipHtml = `
          <div style="color:${driverColor};font-weight:700;font-size:11px">${driver}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.5)">Lap ${closest.lapNumber} (tyre lap ${closest.tyreLap})</div>
          <div style="font-size:11px;font-weight:700">${deltaSign}${deltaSec}s (${deltaSign}${deltaPercent}%)</div>
          <div style="font-size:9px;color:${compColor}">${closestStint.compound} &mdash; L${closest.tyreLife}</div>
          <div style="font-size:9px;color:rgba(255,255,255,0.4)">${Math.floor(closest.lapTime / 60)}:${(closest.lapTime % 60).toFixed(3).padStart(6, '0')}</div>
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
        g.selectAll('.hover-line, .hover-dot').remove();
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
