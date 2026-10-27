import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, getDriverDash, markColor, textColor, signedDelta, TEXT_COLORS,
  GRID_COLORS, SURFACES, CHART_FONT, chartFontPx, contextColor, CONTEXT_MIX_LINES,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey } from '../../utils/strategyViews';
import {
  lapDeltaSeries, lapDeltaLegend, BASE_LINE, BASE_LABEL_COLOR, baseLineLabel,
} from '../../utils/views/lapDeltaChart';
import { defineDeltaHatches } from '../../utils/views/deltaHatch';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

// Ids of the hatch patterns of each mounted chart (unique in the document)
let hatchSeq = 0;

export default function LapDeltaChart() {
  const svgRef = useRef(null);
  // The box the chart fills: it lays out again at each new size (D4)
  const box = useChartBox(svgRef);
  const [hatchId] = useState(() => {
    hatchSeq += 1;
    return `lap-delta-hatch-${hatchSeq}`;
  });
  const sessionData = useF1Store((s) => s.sessionData);
  const lapDeltaBaseDriver = useF1Store((s) => s.lapDeltaBaseDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const trackStatus = useF1Store((s) => s.trackStatus);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  // Causal "now" (session seconds) and a key that changes only when a lap, a
  // pit event or a track-status period completes, so the chart is not rebuilt
  // on every replay frame
  const sessionNow = useSessionNow();
  const causal = useMemo(() => causalKey(lapTimes, sessionNow, trackStatus), [lapTimes, sessionNow, trackStatus]);
  const baseDriver = lapDeltaBaseDriver || focusDriver;

  // Each driver's delta to the base on the laps both completed at sessionNow:
  // the race trace on the focus reference (utils/raceTrace.js), from the lap
  // rows' Time (never `LapNumber <= currentLap`: the leader's lap is ahead of
  // the others; never a sum of lap times)
  const driverDeltas = useMemo(
    () => lapDeltaSeries(lapTimes, { base: baseDriver, sessionNow, trackStatus }),
    // sessionNow enters through the causal key, which changes whenever the result does
    [lapTimes, causal, baseDriver, trackStatus],
  );

  // Drivers to compare
  const displayDrivers = useMemo(() => {
    const base = lapDeltaBaseDriver || focusDriver;
    if (!base) return [];

    let compare = selectedDrivers.filter((d) => d !== base);
    if (compare.length === 0) {
      // Show the first five drivers of the race order if none selected
      const allDrivers = Object.keys(driverDeltas);
      compare = allDrivers.filter((d) => d !== base).slice(0, 5);
    }
    return compare;
  }, [lapDeltaBaseDriver, focusDriver, selectedDrivers, driverDeltas]);

  useEffect(() => {
    if (!svgRef.current || !baseDriver || !driverDeltas[baseDriver]) return;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width, height } = chartSize(svgRef.current, box, { width: 500, height: 250 });

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    // the shaded areas: a tint and full-strength hatch lines, rising for
    // behind, falling for ahead (utils/views/deltaHatch.js, V1)
    const hatch = defineDeltaHatches(svg.append('defs'), hatchId);

    const baseLaps = driverDeltas[baseDriver];
    if (!baseLaps?.length) return;

    // Deltas of each display driver (positive = driver behind base), on the
    // laps both completed at sessionNow
    const deltaData = [];
    let minDelta = 0, maxDelta = 0;
    const maxVisibleLap = baseLaps[baseLaps.length - 1].lap;

    displayDrivers.forEach((driver) => {
      const deltas = driverDeltas[driver];
      if (!deltas?.length) return;
      for (const { delta } of deltas) {
        if (delta < minDelta) minDelta = delta;
        if (delta > maxDelta) maxDelta = delta;
      }
      // mark >= 3:1 on the panel (markColor), teammate tint and dash (V3)
      deltaData.push({
        driver, deltas, color: markColor(getDriverColor(driver)), dash: getDriverDash(driver),
      });
    });

    if (deltaData.length === 0) {
      svg.append('text')
        .attr('x', width / 2).attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data)
        .text('No delta data available');
      return;
    }

    // Measure actual label widths using a hidden SVG text element
    const labelTexts = [baseLineLabel(baseDriver)];
    deltaData.forEach(({ driver, deltas }) => {
      const last = deltas[deltas.length - 1];
      if (last) labelTexts.push(`${driver} ${signedDelta(last.delta, 1)}s`);
    });
    const probe = svg.append('text')
      .style('font-size', CHART_FONT.data).attr('font-weight', '800')
      .attr('font-family', 'var(--font-display)')
      .style('visibility', 'hidden');
    let maxLabelPx = 0;
    labelTexts.forEach((t) => {
      probe.text(t);
      const w = probe.node().getComputedTextLength();
      if (w > maxLabelPx) maxLabelPx = w;
    });
    probe.remove();
    const dynamicRight = Math.max(60, Math.ceil(maxLabelPx) + 14);

    const margin = { top: 18, right: dynamicRight, bottom: 28, left: 54 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

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
      .attr('stroke', GRID_COLORS.grid)
      .attr('stroke-dasharray', '2,4');

    // Zero line (the base driver): a double line, two neutral rails, a style
    // no driver line has (a driver line is one 2 px stroke, D6); named at its end
    const baseLine = g.append('g')
      .attr('class', 'delta-base-line')
      .attr('stroke', BASE_LINE.stroke)
      .attr('stroke-width', BASE_LINE.width);
    for (const dy of [-BASE_LINE.offset, BASE_LINE.offset]) {
      baseLine.append('line')
        .attr('class', 'delta-base-rail')
        .attr('x1', 0).attr('x2', innerW)
        .attr('y1', y(0) + dy).attr('y2', y(0) + dy);
    }

    // Collect all end-labels for collision resolution
    const labelEntries = [
      { driver: baseDriver, yPos: y(0), text: baseLineLabel(baseDriver), fill: BASE_LABEL_COLOR },
    ];

    // Axes
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(12, maxVisibleLap)).tickFormat(d3.format('d')))
      .selectAll('text').style('font-size', CHART_FONT.data);
    g.append('g').attr('class', 'axis')
      .call(d3.axisLeft(y).ticks(6).tickFormat((d) => `${signedDelta(d, 1)}s`))
      .selectAll('text').style('font-size', CHART_FONT.data);

    // Axis labels
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', innerW / 2).attr('y', innerH + margin.bottom - 4)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Lap');
    g.append('text').attr('text-anchor', 'middle')
      .attr('transform', `rotate(-90)`)
      .attr('x', -innerH / 2).attr('y', -margin.left + 12)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Delta (s), + behind');

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

    deltaData.forEach(({ driver, deltas, color, dash }) => {
      // Orange hatch where behind the base (delta > 0, the + side)
      g.append('path')
        .datum(deltas)
        .attr('class', 'delta-area')
        .attr('data-driver', driver)
        .attr('d', areaAbove)
        .attr('fill', hatch.worse);

      // Blue hatch where ahead (delta < 0, the − side)
      g.append('path')
        .datum(deltas)
        .attr('class', 'delta-area')
        .attr('data-driver', driver)
        .attr('d', areaBelow)
        .attr('fill', hatch.better);

      // Line: team colour, teammate dashed (V3)
      g.append('path')
        .datum(deltas)
        .attr('class', 'delta-line')
        .attr('data-driver', driver)
        .attr('data-color', color)
        .attr('d', lineGen)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', dash);

      // Collect end label
      const last = deltas[deltas.length - 1];
      if (last) {
        labelEntries.push({
          driver, yPos: y(last.delta),
          text: `${driver} ${signedDelta(last.delta, 1)}s`,
          color,
        });
      }
    });

    // Resolve label overlaps: iterative relaxation
    const minGap = Math.ceil(chartFontPx('data') * 1.2);
    labelEntries.sort((a, b) => a.yPos - b.yPos);
    for (let pass = 0; pass < 10; pass++) {
      let moved = false;
      for (let i = 1; i < labelEntries.length; i++) {
        const diff = labelEntries[i].yPos - labelEntries[i - 1].yPos;
        if (diff < minGap) {
          const shift = (minGap - diff) / 2 + 0.5;
          labelEntries[i - 1].yPos -= shift;
          labelEntries[i].yPos += shift;
          moved = true;
        }
      }
      // Clamp within chart area after each pass
      labelEntries.forEach((l) => {
        l.yPos = Math.max(6, Math.min(innerH - 2, l.yPos));
      });
      if (!moved) break;
    }

    // Render all end labels (margin sized to fit)
    labelEntries.forEach((l) => {
      g.append('text')
        .attr('x', innerW + 4)
        .attr('y', l.yPos)
        .attr('fill', l.fill || textColor(l.color))
        .style('font-size', CHART_FONT.data)
        .attr('font-weight', '800')
        .attr('dominant-baseline', 'middle')
        .attr('font-family', 'var(--font-display)')
        .text(l.text);
    });

    // Tooltip overlay
    const tooltipLine = g.append('line')
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', GRID_COLORS.rule)
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
            html += `<div style="display:flex;gap:6px;align-items:center"><span style="width:6px;height:6px;border-radius:50%;background:${color}"></span><span style="color:${textColor(color, SURFACES.elevated)};font-weight:700">${driver}</span><span>${signedDelta(d.delta)}s</span></div>`;
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

    return () => { d3.selectAll('.delta-tooltip').remove(); };
  }, [baseDriver, displayDrivers, driverDeltas, hatchId, box.width, box.height]);

  // Lightweight highlight effect — updates colour/stroke without full redraw:
  // the other lines are context, their colour mixed toward the panel
  // (contextColor, >= 2:1; opacity 0.25 read 1.19:1, D7)
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('.delta-line').each(function () {
      const el = d3.select(this);
      const driver = el.attr('data-driver');
      const color = el.attr('data-color');
      const isHl = highlightedDriver && driver === highlightedDriver;
      const isDimmed = highlightedDriver && driver !== highlightedDriver;
      el.attr('stroke', isDimmed ? contextColor(color, SURFACES.panel, { mix: CONTEXT_MIX_LINES }) : color)
        .attr('stroke-width', isHl ? 3 : 2);
    });
    // the hatched areas repeat the sign of a line: a context driver's are
    // left out while another line is hovered (no area drawn under its floor)
    svg.selectAll('.delta-area').each(function () {
      const el = d3.select(this);
      const driver = el.attr('data-driver');
      const isDimmed = highlightedDriver && driver !== highlightedDriver;
      el.style('display', isDimmed ? 'none' : null);
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {/* Every mark of the chart: zero line, driver lines (teammate dashed), ± areas */}
        <Legend items={lapDeltaLegend(baseDriver, displayDrivers.filter((d) => driverDeltas[d]))} />
        <div className="viz-container" style={{ flex: 1, minHeight: 0 }}>
          <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </Panel>
  );
}
