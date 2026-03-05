import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import Panel from '../ui/Panel';

export default function LapDeltaChart() {
  const svgRef = useRef(null);
  const sessionData = useF1Store((s) => s.sessionData);
  const lapDeltaBaseDriver = useF1Store((s) => s.lapDeltaBaseDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const currentLap = useF1Store((s) => s.currentLap);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const drivers = useF1Store((s) => s.drivers);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);

  // Build per-driver cumulative time arrays
  const driverCumTimes = useMemo(() => {
    if (!lapTimes.length) return {};
    const map = {};
    lapTimes.forEach((d) => {
      if (!map[d.Driver]) map[d.Driver] = {};
      if (d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300) {
        map[d.Driver][d.LapNumber] = d.LapTimeSeconds;
      }
    });

    // Build cumulative sums
    const cumMap = {};
    for (const [driver, laps] of Object.entries(map)) {
      const sortedLaps = Object.keys(laps).map(Number).sort((a, b) => a - b);
      const cumArr = [];
      let sum = 0;
      for (const lap of sortedLaps) {
        sum += laps[lap];
        cumArr.push({ lap, cumTime: sum, lapTime: laps[lap] });
      }
      cumMap[driver] = cumArr;
    }
    return cumMap;
  }, [lapTimes]);

  // Drivers to compare
  const displayDrivers = useMemo(() => {
    const base = lapDeltaBaseDriver || focusDriver;
    if (!base) return [];

    let compare = selectedDrivers.filter((d) => d !== base);
    if (compare.length === 0) {
      // Show top 5 drivers if none selected
      const allDrivers = Object.keys(driverCumTimes);
      compare = allDrivers.filter((d) => d !== base).slice(0, 5);
    }
    return compare;
  }, [lapDeltaBaseDriver, focusDriver, selectedDrivers, driverCumTimes]);

  const baseDriver = lapDeltaBaseDriver || focusDriver;

  useEffect(() => {
    if (!svgRef.current || !baseDriver || !driverCumTimes[baseDriver]) return;

    // Always read fresh container dimensions so the chart fits its space
    const container = svgRef.current.parentElement;
    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width) || 500;
    const height = Math.round(rect.height) || 250;
    const margin = { top: 18, right: 70, bottom: 32, left: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const baseCum = driverCumTimes[baseDriver];
    if (!baseCum?.length) return;

    // Build base lookup
    const baseLookup = {};
    baseCum.forEach((d) => { baseLookup[d.lap] = d.cumTime; });

    // Compute deltas for each display driver
    const deltaData = [];
    let minDelta = 0, maxDelta = 0;
    const maxVisibleLap = Math.min(currentLap, baseCum[baseCum.length - 1].lap);

    displayDrivers.forEach((driver) => {
      const cum = driverCumTimes[driver];
      if (!cum) return;
      const driverDeltas = [];
      let driverCumLookup = {};
      cum.forEach((d) => { driverCumLookup[d.lap] = d.cumTime; });

      for (let lap = 1; lap <= maxVisibleLap; lap++) {
        const baseTime = baseLookup[lap];
        const driverTime = driverCumLookup[lap];
        if (baseTime != null && driverTime != null) {
          const delta = driverTime - baseTime; // positive = driver behind base
          driverDeltas.push({ lap, delta });
          if (delta < minDelta) minDelta = delta;
          if (delta > maxDelta) maxDelta = delta;
        }
      }
      if (driverDeltas.length > 0) {
        deltaData.push({ driver, deltas: driverDeltas, color: getDriverColor(driver) });
      }
    });

    if (deltaData.length === 0) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', 'var(--color-text-muted)').attr('font-size', 12)
        .text('No delta data available');
      return;
    }

    // Pad
    const yPad = Math.max(0.5, (maxDelta - minDelta) * 0.1);
    const x = d3.scaleLinear().domain([1, maxVisibleLap]).range([0, innerW]);
    const y = d3.scaleLinear().domain([minDelta - yPad, maxDelta + yPad]).range([innerH, 0]);

    // Grid
    g.append('g').attr('class', 'grid')
      .selectAll('line').data(y.ticks(6)).enter()
      .append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', (d) => y(d)).attr('y2', (d) => y(d))
      .attr('stroke', 'rgba(255,255,255,0.06)')
      .attr('stroke-dasharray', '2,4');

    // Zero line (base driver)
    g.append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', y(0)).attr('y2', y(0))
      .attr('stroke', getDriverColor(baseDriver))
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '6,3')
      .attr('opacity', 0.6);

    // Base driver label
    g.append('text')
      .attr('x', innerW + 4).attr('y', y(0))
      .attr('fill', getDriverColor(baseDriver))
      .attr('font-size', '11px').attr('font-weight', '800')
      .attr('dominant-baseline', 'middle')
      .attr('font-family', 'var(--font-display)')
      .text(baseDriver);

    // Axes
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, maxVisibleLap)).tickFormat(d3.format('d')));
    g.append('g').attr('class', 'axis')
      .call(d3.axisLeft(y).ticks(6).tickFormat((d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}s`));

    // Area + Line per driver
    const areaAbove = d3.area()
      .x((d) => x(d.lap))
      .y0(y(0))
      .y1((d) => d.delta > 0 ? y(d.delta) : y(0))
      .curve(d3.curveMonotoneX);

    const areaBelow = d3.area()
      .x((d) => x(d.lap))
      .y0(y(0))
      .y1((d) => d.delta < 0 ? y(d.delta) : y(0))
      .curve(d3.curveMonotoneX);

    const lineGen = d3.line()
      .x((d) => x(d.lap))
      .y((d) => y(d.delta))
      .curve(d3.curveMonotoneX);

    deltaData.forEach(({ driver, deltas, color }) => {
      // Red fill where behind (delta > 0)
      g.append('path')
        .datum(deltas)
        .attr('class', 'delta-area')
        .attr('data-driver', driver)
        .attr('d', areaAbove)
        .attr('fill', 'rgba(239, 68, 68, 0.18)')
        .attr('opacity', 0.8);

      // Green fill where ahead (delta < 0)
      g.append('path')
        .datum(deltas)
        .attr('class', 'delta-area')
        .attr('data-driver', driver)
        .attr('d', areaBelow)
        .attr('fill', 'rgba(34, 197, 94, 0.18)')
        .attr('opacity', 0.8);

      // Line
      g.append('path')
        .datum(deltas)
        .attr('class', 'delta-line')
        .attr('data-driver', driver)
        .attr('d', lineGen)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('opacity', 0.85);

      // End label
      const last = deltas[deltas.length - 1];
      if (last) {
        g.append('text')
          .attr('x', innerW + 4)
          .attr('y', y(last.delta))
          .attr('fill', color)
          .attr('font-size', '11px')
          .attr('font-weight', '800')
          .attr('dominant-baseline', 'middle')
          .attr('font-family', 'var(--font-display)')
          .text(`${driver} ${last.delta > 0 ? '+' : ''}${last.delta.toFixed(1)}s`);
      }
    });

    // Tooltip overlay
    const tooltipLine = g.append('line')
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', 'rgba(255,255,255,0.3)')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '3,3')
      .style('display', 'none');

    let tooltip = d3.select('.delta-tooltip');
    if (!tooltip.size()) tooltip = d3.select('body').append('div').attr('class', 'tooltip delta-tooltip');

    svg.append('rect')
      .attr('x', margin.left).attr('y', margin.top)
      .attr('width', innerW).attr('height', innerH)
      .attr('fill', 'transparent')
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event, g.node());
        const lap = Math.round(x.invert(mx));
        if (lap < 1 || lap > maxVisibleLap) return;
        tooltipLine.attr('x1', x(lap)).attr('x2', x(lap)).style('display', null);

        let html = `<div style="font-weight:700;margin-bottom:2px">Lap ${lap}</div>`;
        deltaData.forEach(({ driver, deltas, color }) => {
          const d = deltas.find((p) => p.lap === lap);
          if (d) {
            html += `<div style="display:flex;gap:6px;align-items:center"><span style="width:6px;height:6px;border-radius:50%;background:${color}"></span><span style="color:${color};font-weight:700">${driver}</span><span>${d.delta > 0 ? '+' : ''}${d.delta.toFixed(3)}s</span></div>`;
          }
        });

        tooltip.html(html)
          .style('left', event.pageX + 12 + 'px')
          .style('top', event.pageY - 12 + 'px')
          .classed('visible', true).style('opacity', 1);
      })
      .on('mouseleave', () => {
        tooltipLine.style('display', 'none');
        tooltip.classed('visible', false).style('opacity', 0);
      });

    // Axis labels
    svg.append('text').attr('text-anchor', 'middle')
      .attr('x', margin.left + innerW / 2).attr('y', height - 2)
      .attr('fill', 'rgba(255,255,255,0.5)').attr('font-size', 11)
      .attr('font-weight', '600')
      .text('Lap');

    return () => { d3.selectAll('.delta-tooltip').remove(); };
  }, [baseDriver, displayDrivers, driverCumTimes, currentLap]);

  // Lightweight highlight effect — updates opacity/stroke without full redraw
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('.delta-line').each(function () {
      const el = d3.select(this);
      const driver = el.attr('data-driver');
      const isHl = highlightedDriver && driver === highlightedDriver;
      const isDimmed = highlightedDriver && driver !== highlightedDriver;
      el.attr('opacity', isDimmed ? 0.25 : isHl ? 1 : 0.85)
        .attr('stroke-width', isHl ? 3 : 2);
    });
    svg.selectAll('.delta-area').each(function () {
      const el = d3.select(this);
      const driver = el.attr('data-driver');
      const isDimmed = highlightedDriver && driver !== highlightedDriver;
      el.attr('opacity', isDimmed ? 0.1 : 0.8);
    });
  }, [highlightedDriver]);

  if (!baseDriver) {
    return (
      <Panel title="Lap Delta">
        <div className="loading-placeholder">
          <span>Double-click a driver to set focus and see lap deltas</span>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={`Lap Delta vs ${baseDriver}`}>
      <div className="viz-container">
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </Panel>
  );
}
