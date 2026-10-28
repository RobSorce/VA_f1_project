/**
 * Race Trace: who gained time on whom over the race so far, and what changed
 * it (stops, SC / VSC / red flag, passes).
 *
 * One line per driver through its lap-end vertices, y = the reference's race
 * time minus the car's (utils/raceTrace.js, up = ahead): against the
 * field-median car (default), the first car across each lap, or the focus
 * car. Team colour, the second car of a team dashed; 3 px focus, 2 px selected
 * or hovered, 1 px the others (context while a car is emphasised). Stop chips
 * on the out-lap vertex (new compound and its letter; a hollow P for a pit
 * visit with the same tyres), SC hatched / VSC dotted / RED tinted bands with
 * their names, the newest provisional laps hollow (their end labels read
 * '~'), a "now" rule, the brushed lap range as a tint, and at the right
 * margin a bracket one pit loss long under the focus car's gap: the cars
 * inside it are within one stop.
 *
 * Causal: everything is read at the dashboard's clock (useSessionNow).
 *
 * Fit (utils/views/raceTraceChart.js RACE_TRACE_FIT): from 420 x 200 the end
 * labels and the full legend; under it labels on hover and the legend's short
 * labels; under 300 x 150 the answer line only. The legend wraps onto the
 * rows it needs, the chart takes the rest. Nothing scrolls.
 */
import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, textColor, contextText, CONTEXT_MIX_LINES, TEXT_COLORS, GRID_COLORS, SURFACES,
  CHART_FONT, chartFontPx, tyreColor, tyreLetter, contrastText, contextColor, UI_COLORS, withAlpha,
  BRUSH_TINT_ALPHA,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey, viewSessionType } from '../../utils/strategyViews';
import {
  buildRaceTrace, traceBands, traceStops, wetRace, traceWindow, traceAnswer, referenceText, latestPoint,
} from '../../utils/raceTrace';
import { estimatePitLoss, isRaceSession } from '../../utils/pitLoss';
import {
  raceTraceMode, defineBandPatterns, BAND_STYLE, pitLossLabel, provenanceLine, raceTraceLegend,
  placeEndLabels, gapText, traceLineStyle,
} from '../../utils/views/raceTraceChart';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

// Ids of the band patterns and clip path of each mounted chart (unique in the document)
let traceSeq = 0;
// Size drawn at before the box is measured (no layout: tests, server render)
const DEFAULT_DIMS = { width: 640, height: 300 };
// px of a drag along x that makes a lap-range brush (less is a click)
const DRAG_PX = 4;

// The two settings, each a button that steps through its options (a header
// of a quarter pane has no room for six)
const REFERENCE_OPTIONS = ['field', 'leader', 'focus'];
const WINDOW_OPTIONS = ['top', 'focus', 'all'];
const WINDOW_NAMES = { top: 'TOP 10', focus: '± 1 STOP', all: 'ALL' };

/** The next option of a list, skipping the unavailable ones. */
function nextOption(list, current, available) {
  const i = list.indexOf(current);
  for (let k = 1; k <= list.length; k++) {
    const o = list[(i + k) % list.length];
    if (available(o)) return o;
  }
  return current;
}

/** End label of a car: its gap on the reference ('~' while provisional), or the laps it is down. */
function endLabel(d, p) {
  return d.lapsDown > 0 ? `${d.driver} −${d.lapsDown}L` : `${d.driver} ${p.provisional ? '~' : ''}${gapText(p.y)}`;
}

export default function RaceTrace() {
  const rootRef = useRef(null);
  const svgRef = useRef(null);
  const tipRef = useRef(null);
  // The lap-range drag in progress: its start (px) and whether it moved
  const dragRef = useRef({ start: null, moved: false });
  // The hovered driver, read by a redraw (the hover itself restyles without one)
  const hoverRef = useRef(null);
  // The view's whole box decides the fit mode; the chart's box sizes the svg (D4)
  const outer = useChartBox(rootRef, { parent: false });
  const box = useChartBox(svgRef);
  const [ids] = useState(() => {
    traceSeq += 1;
    return `race-trace-${traceSeq}`;
  });

  const sessionData = useF1Store((s) => s.sessionData);
  const trackStatus = useF1Store((s) => s.trackStatus);
  // The loaded session's type, not the menu's pill (the menus change the pill without loading)
  const sessionType = useF1Store(viewSessionType);
  const isLiveMode = useF1Store((s) => s.isLiveMode);
  const totalRaceLaps = useF1Store((s) => s.totalRaceLaps);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const lapDeltaBaseDriver = useF1Store((s) => s.lapDeltaBaseDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const selectedLapRange = useF1Store((s) => s.selectedLapRange);
  const reference = useF1Store((s) => s.raceTraceReference);
  const windowSetting = useF1Store((s) => s.raceTraceWindow);
  const setReference = useF1Store((s) => s.setRaceTraceReference);
  const setWindow = useF1Store((s) => s.setRaceTraceWindow);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const setBrushLapRange = useF1Store((s) => s.setBrushLapRange);
  const setCurrentLap = useF1Store((s) => s.setCurrentLap);

  hoverRef.current = highlightedDriver;
  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const status = useMemo(() => trackStatus || sessionData?.track_status || [], [trackStatus, sessionData]);
  // Causal "now" (session seconds) and a key that changes only when a lap, a
  // pit event or a track-status period starts or ends: the trace is not
  // rebuilt on every replay frame
  const sessionNow = useSessionNow();
  const causal = useMemo(() => causalKey(lapTimes, sessionNow, status), [lapTimes, sessionNow, status]);
  const refCar = lapDeltaBaseDriver || focusDriver;
  const race = isRaceSession(sessionType);

  // sessionNow enters each memo through the causal key, which changes whenever the result does
  /* eslint-disable react-hooks/exhaustive-deps */
  const trace = useMemo(
    () => buildRaceTrace(lapTimes, {
      trackStatus: status, sessionNow, reference, focusDriver: refCar,
    }),
    [lapTimes, status, causal, reference, refCar],
  );
  const bands = useMemo(() => traceBands(status, lapTimes, sessionNow), [lapTimes, status, causal]);
  const stops = useMemo(() => traceStops(lapTimes, sessionNow), [lapTimes, causal]);
  const wet = useMemo(() => wetRace(lapTimes, sessionNow).wet, [lapTimes, causal]);
  const pitLoss = useMemo(
    () => pitLossLabel(estimatePitLoss(lapTimes, { sessionNow, sessionType })),
    [lapTimes, causal, sessionType],
  );
  /* eslint-enable react-hooks/exhaustive-deps */
  const win = useMemo(
    () => traceWindow(trace, { window: windowSetting, focusDriver, pitLoss: pitLoss?.loss }),
    [trace, windowSetting, focusDriver, pitLoss],
  );

  const mode = raceTraceMode(outer);
  const raceOver = (sessionNow === Infinity && !isLiveMode)
    || (Number.isFinite(totalRaceLaps) && totalRaceLaps > 0 && trace.lastLap >= totalRaceLaps);
  const answer = traceAnswer(trace, highlightedDriver || focusDriver || null);
  const provenance = provenanceLine({
    trace, reference: referenceText(trace), window: win, pitLoss, wet,
  });
  const legendItems = raceTraceLegend({
    bands: [...new Set(bands.map((b) => b.kind))],
    compact: mode !== 'full',
    bracket: !!pitLoss,
    focus: !!focusDriver && trace.drivers.some((d) => d.driver === focusDriver),
    stop: stops.some((c) => c.kind === 'stop'),
    visit: stops.some((c) => c.kind === 'visit'),
    provisional: trace.drivers.some((d) => d.points.some((p) => p.provisional)),
  });
  const hasTrace = race && trace.lastLap > 0;

  /* ── The chart ─────────────────────────────────────────────────── */
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || !hasTrace || mode === 'answer') return undefined;
    const { width, height } = chartSize(svgEl, box, DEFAULT_DIMS);
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    const defs = svg.append('defs');
    const fills = defineBandPatterns(defs, ids);
    const dataPx = chartFontPx('data');
    const labelPx = chartFontPx('label');

    const state = { focus: focusDriver, selected: selectedDrivers, highlighted: hoverRef.current };
    const drag = dragRef.current;
    const drivers = trace.drivers;
    const inWindow = (y) => y >= win.lo && y <= win.hi;

    // Right column: the end labels (their widest text) after the bracket
    const probe = svg.append('text').style('font-size', CHART_FONT.data).attr('font-weight', 700)
      .attr('font-family', 'var(--font-display)').style('visibility', 'hidden');
    let labelW = 0;
    for (const d of drivers) {
      const p = latestPoint(d);
      if (!p) continue;
      probe.text(endLabel(d, p));
      labelW = Math.max(labelW, probe.node().getComputedTextLength());
    }
    probe.text(`▼ ${drivers.length}`);
    labelW = Math.max(labelW, probe.node().getComputedTextLength());
    probe.remove();
    const bracketCol = pitLoss ? 10 : 2;
    const margin = {
      top: Math.ceil(labelPx * 1.5), right: bracketCol + Math.ceil(labelW) + 6, bottom: Math.ceil(dataPx * 1.7),
    };
    const innerH = Math.max(10, height - margin.top - margin.bottom);
    const y = d3.scaleLinear().domain([win.lo, win.hi]).range([innerH, 0]);
    const yTicks = y.ticks(Math.max(2, Math.floor(innerH / (dataPx * 2.6))));
    const yTickText = (v) => `${gapText(v)}s`;
    // Left column: the widest y tick label in the axis font (an .axis text:
    // the mono face at the data size), right-aligned by axisLeft at x = -9
    // (6 px tick, 3 px padding); 0.6 em a character where nothing is laid out
    const tickProbe = svg.append('g').attr('class', 'axis').append('text')
      .style('font-size', CHART_FONT.data).style('visibility', 'hidden');
    let tickW = 0;
    for (const v of yTicks) {
      const t = yTickText(v);
      tickProbe.text(t);
      tickW = Math.max(tickW, tickProbe.node().getComputedTextLength() || 0.6 * dataPx * t.length);
    }
    tickProbe.node().parentNode.remove();
    margin.left = Math.max(44, Math.ceil(tickW) + 12);
    const innerW = Math.max(10, width - margin.left - margin.right);
    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    defs.append('clipPath').attr('id', `${ids}-clip`)
      .append('rect').attr('width', innerW).attr('height', innerH);

    const xMax = Math.max(1, trace.lastLap + (raceOver ? 0 : 0.5));
    const x = d3.scaleLinear().domain([0, xMax]).range([0, innerW]);
    const lapX = (lap) => x(Math.max(0, Math.min(xMax, lap)));

    // Grid, zero line and axes
    g.append('g').attr('class', 'rt-grid').selectAll('line').data(yTicks).enter().append('line')
      .attr('x1', 0).attr('x2', innerW).attr('y1', (v) => y(v)).attr('y2', (v) => y(v))
      .attr('stroke', (v) => (v === 0 ? GRID_COLORS.axis : GRID_COLORS.grid))
      .attr('stroke-dasharray', (v) => (v === 0 ? null : '2,4'));
    const xAxis = g.append('g').attr('class', 'axis rt-axis-x').attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.min(trace.lastLap, Math.floor(innerW / 48)))).tickFormat(d3.format('d')).tickSizeOuter(0));
    const yAxis = g.append('g').attr('class', 'axis rt-axis-y')
      .call(d3.axisLeft(y).tickValues(yTicks).tickFormat(yTickText).tickSizeOuter(0));
    for (const a of [xAxis, yAxis]) {
      a.select('.domain').attr('stroke', GRID_COLORS.axis);
      a.selectAll('text').attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data);
    }
    g.append('text').attr('class', 'rt-axis-title')
      .attr('x', -margin.left + 2).attr('y', -Math.ceil(labelPx * 0.5))
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label).attr('font-weight', 600)
      .text('+ ahead (s)');
    const lapTitle = g.append('text').attr('class', 'rt-axis-title')
      .attr('x', innerW).attr('y', innerH + margin.bottom - 2).attr('text-anchor', 'end')
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label).attr('font-weight', 600)
      .text('lap');
    // The title shares the tick labels' line: a tick label that would reach
    // into it is dropped (its tick stays)
    const titleW = lapTitle.node().getComputedTextLength() || 0.6 * labelPx * 3;
    xAxis.selectAll('.tick').each(function dropUnderTitle(v) {
      const t = this.querySelector('text');
      if (!t) return;
      const w = t.getComputedTextLength() || 0.6 * dataPx * t.textContent.length;
      if (x(v) + w / 2 > innerW - titleW - 4) t.remove();
    });

    const plot = g.append('g').attr('clip-path', `url(#${ids}-clip)`);

    // Brushed lap range (the one lap range of every view): a tint with edges
    if (selectedLapRange) {
      const [a, b] = selectedLapRange;
      const x0 = lapX(a - 1);
      const x1 = lapX(b);
      plot.append('rect').attr('class', 'rt-lap-range')
        .attr('x', x0).attr('y', 0).attr('width', Math.max(1, x1 - x0)).attr('height', innerH)
        .attr('fill', withAlpha(UI_COLORS.brush, BRUSH_TINT_ALPHA * 3))
        .attr('stroke', UI_COLORS.brush).attr('stroke-width', 1).attr('stroke-dasharray', '3,3');
    }

    // Bands: SC hatched, VSC dotted, RED tinted, each named at its top; a click selects its laps.
    // A name that would run into the one before it goes a row lower, else it
    // is left out (the band keeps its hatch, its tooltip and its legend row)
    const bandG = plot.append('g').attr('class', 'rt-bands');
    const bandNameRows = [];
    for (const b of bands) {
      const x0 = lapX(b.startLap - 1);
      const x1 = lapX(b.endLap);
      const st = BAND_STYLE[b.kind];
      bandG.append('rect').attr('class', `rt-band rt-band--${b.kind.toLowerCase()}`)
        .attr('data-laps', `${b.startLap}-${b.endLap}`)
        .attr('x', x0).attr('y', 0).attr('width', Math.max(2, x1 - x0)).attr('height', innerH)
        .attr('fill', fills[b.kind])
        .style('cursor', 'pointer')
        .on('click', (event) => {
          event.stopPropagation();
          if (drag.moved) return;
          setBrushLapRange([b.startLap, b.endLap]);
        })
        .append('title').text(`${st.label} L${b.startLap}–${b.endLap}${b.ongoing ? ' (running)' : ''}: click to select these laps`);
      const name = bandG.append('text').attr('class', 'rt-band-label')
        .attr('x', x0 + 2)
        .attr('fill', textColor(st.color)).style('font-size', CHART_FONT.label).attr('font-weight', 800)
        .style('pointer-events', 'none')
        .text(st.label);
      const nameW = name.node().getComputedTextLength() || 0.6 * labelPx * st.label.length;
      const row = [0, 1].find((r) => bandNameRows[r] == null || x0 + 2 >= bandNameRows[r] + 4);
      if (row == null) {
        name.remove();
        continue;
      }
      bandNameRows[row] = x0 + 2 + nameW;
      name.attr('y', labelPx * (1 + 1.2 * row));
    }

    // Lines, context first and the focus last
    const line = d3.line().x((p) => lapX(p.lap)).y((p) => y(p.y));
    const ordered = [...drivers].sort((a, b) => traceLineStyle(a.driver, state).rank - traceLineStyle(b.driver, state).rank);
    const linesG = plot.append('g').attr('class', 'rt-lines');
    for (const d of ordered) {
      const st = traceLineStyle(d.driver, state);
      linesG.append('path').attr('class', 'rt-line')
        .attr('data-driver', d.driver)
        .attr('d', line(d.points))
        .attr('fill', 'none')
        .attr('stroke', st.stroke).attr('stroke-width', st.width).attr('stroke-dasharray', st.dash)
        .attr('stroke-linejoin', 'round');
    }

    // Vertices: provisional laps hollow, every car's newest vertex marked
    const dotsG = plot.append('g').attr('class', 'rt-dots');
    for (const d of drivers) {
      const st = traceLineStyle(d.driver, state);
      const last = latestPoint(d);
      for (const p of d.points) {
        if (p.start || !(p.provisional || p === last) || !inWindow(p.y)) continue;
        dotsG.append('circle')
          .attr('class', p.provisional ? 'rt-dot rt-dot--provisional' : 'rt-dot')
          .attr('data-driver', d.driver).attr('data-lap', p.lap)
          .attr('cx', lapX(p.lap)).attr('cy', y(p.y)).attr('r', st.width >= 2 ? 3 : 2.2)
          .attr('fill', p.provisional ? SURFACES.panel : st.stroke)
          .attr('stroke', st.stroke).attr('stroke-width', 1.2);
      }
    }

    // Stop chips on the out-lap vertex (else the newest one): the new compound
    // and its letter; a hollow P for a pit visit with the same tyres. A click
    // (replay) rewinds to the lap before the in-lap: the decision
    const chipR = Math.ceil(labelPx * 0.62);
    const chipsG = plot.append('g').attr('class', 'rt-chips');
    const byDriver = new Map(drivers.map((d) => [d.driver, d]));
    for (const c of stops) {
      const d = byDriver.get(c.driver);
      if (!d) continue;
      const p = d.points.find((q) => q.lap === c.lap && !q.start)
        || (c.inLap <= (latestPoint(d)?.lap ?? -1) && c.lap > (latestPoint(d)?.lap ?? 0) ? latestPoint(d) : null);
      if (!p || !inWindow(p.y)) continue;
      const st = traceLineStyle(d.driver, state);
      const chip = chipsG.append('g').attr('class', `rt-chip rt-chip--${c.kind}`)
        .attr('data-driver', c.driver).attr('data-lap', c.lap)
        .attr('transform', `translate(${lapX(p.lap)},${y(p.y)})`)
        .style('cursor', isLiveMode ? 'default' : 'pointer');
      if (c.kind === 'stop') {
        const fill = st.context ? contextColor(tyreColor(c.compound), SURFACES.panel) : tyreColor(c.compound);
        chip.append('circle').attr('r', chipR).attr('fill', fill).attr('stroke', SURFACES.page).attr('stroke-width', 1);
        chip.append('text').attr('dy', '0.35em').attr('text-anchor', 'middle')
          .attr('fill', contrastText(fill)).style('font-size', CHART_FONT.label).attr('font-weight', 800)
          .style('pointer-events', 'none').text(tyreLetter(c.compound));
      } else {
        chip.append('circle').attr('r', chipR).attr('fill', SURFACES.panel)
          .attr('stroke', TEXT_COLORS.secondary).attr('stroke-width', 1.2);
        chip.append('text').attr('dy', '0.35em').attr('text-anchor', 'middle')
          .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.label).attr('font-weight', 800)
          .style('pointer-events', 'none').text('P');
      }
      const what = c.kind === 'stop'
        ? `${c.driver} stop, L${c.inLap}: ${c.fromCompound || '?'} → ${c.compound || '?'}`
        : `${c.driver} pit lane, L${c.inLap}: same tyres`;
      chip.append('title').text(isLiveMode ? what : `${what} · click: rewind to L${Math.max(1, c.inLap - 1)}, the decision`);
      chip.on('click', (event) => {
        event.stopPropagation();
        if (isLiveMode || drag.moved) return;
        setCurrentLap(Math.max(1, c.inLap - 1));
      });
    }

    // Line hit areas: hover highlights, click selects, double-click focuses
    const hitsG = plot.append('g').attr('class', 'rt-hits');
    const tip = tipRef.current;
    for (const d of drivers) {
      hitsG.append('path').attr('class', 'rt-hit').attr('data-driver', d.driver)
        .attr('d', line(d.points)).attr('fill', 'none')
        .attr('stroke', 'transparent').attr('stroke-width', 9)
        .style('cursor', 'pointer')
        .on('mouseenter', (event) => {
          setHighlightedDriver(d.driver);
          if (!tip) return;
          const p = latestPoint(d);
          tip.style.display = 'block';
          tip.innerHTML = `<div style="font-weight:800;color:${textColor(getDriverColor(d.driver), SURFACES.elevated)}">${d.driver} · P${d.position}</div>`
            + (p ? `<div>L${p.lap}: ${d.lapsDown > 0 ? `−${d.lapsDown}L` : `${gapText(p.y)} s`}${p.provisional ? ' (provisional)' : ''}</div>` : '');
          tip.style.left = `${event.clientX + 12}px`;
          tip.style.top = `${event.clientY - 10}px`;
        })
        .on('mousemove', (event) => {
          if (!tip) return;
          tip.style.left = `${event.clientX + 12}px`;
          tip.style.top = `${event.clientY - 10}px`;
        })
        .on('mouseleave', () => {
          setHighlightedDriver(null);
          if (tip) tip.style.display = 'none';
        })
        .on('click', (event) => {
          event.stopPropagation();
          if (drag.moved) return;
          toggleDriver(d.driver);
        })
        .on('dblclick', (event) => {
          event.stopPropagation();
          setFocusDriver(d.driver);
        });
    }

    // Now rule (the leader's newest lap end): "now · L36", or "final" after the flag
    g.append('line').attr('class', 'rt-now')
      .attr('x1', lapX(trace.lastLap)).attr('x2', lapX(trace.lastLap)).attr('y1', 0).attr('y2', innerH)
      .attr('stroke', GRID_COLORS.rule).attr('stroke-dasharray', '3,3');
    g.append('text').attr('class', 'rt-now-label')
      .attr('x', lapX(trace.lastLap)).attr('y', -Math.ceil(labelPx * 0.5))
      .attr('text-anchor', 'end')
      .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.label).attr('font-weight', 700)
      .text(raceOver ? `final · L${trace.lastLap}` : `now · L${trace.lastLap + 1}`);

    // Pit-loss bracket at the right margin, anchored at the focus car's gap
    // (else the leader's): one pit loss long, the cars inside are within one stop
    const anchor = drivers.find((d) => d.driver === focusDriver) || drivers[0];
    const anchorPoint = latestPoint(anchor);
    if (pitLoss && anchorPoint) {
      const yTop = Math.max(0, Math.min(innerH, y(anchorPoint.y)));
      const yBot = Math.max(0, Math.min(innerH, y(anchorPoint.y - pitLoss.loss)));
      const bx = innerW + 5;
      const br = g.append('g').attr('class', 'rt-pit-bracket').attr('data-loss', pitLoss.loss.toFixed(3))
        .attr('stroke', TEXT_COLORS.secondary).attr('stroke-width', 1.5).attr('fill', 'none');
      br.append('path').attr('d', `M${bx - 4},${yTop}H${bx}V${yBot}H${bx - 4}`);
      br.append('title').text(`One pit stop below ${anchor.driver}'s gap: ${pitLoss.text}. A car inside would `
        + `be ahead of ${anchor.driver} if ${anchor.driver} pitted now.`);
    }

    // End labels: placed by priority where they keep a line of room (full);
    // on hover only (compact). Cars outside the window: an arrow and a count
    const labelsG = g.append('g').attr('class', 'rt-labels');
    const wanted = [];
    for (const d of drivers) {
      const p = latestPoint(d);
      if (!p || !inWindow(p.y)) continue;
      const priority = d.driver === focusDriver ? 0 : selectedDrivers.includes(d.driver) ? 1 : 2 + d.position / 100;
      wanted.push({ key: d.driver, y: y(p.y), priority, text: endLabel(d, p), d });
    }
    const gap = Math.ceil(dataPx * 1.15);
    // A count drawn at an edge keeps its row: the labels stay one gap off it
    const countTop = dataPx * 0.5;
    const countBottom = innerH - dataPx * 0.5;
    const labelTop = countTop + (win.above.length ? gap : 0);
    const labelBottom = countBottom - (win.below.length ? gap : 0);
    const placed = mode === 'full'
      ? placeEndLabels(wanted, { gap, top: labelTop, bottom: labelBottom })
      : new Map(wanted.map((w) => [w.key, Math.max(labelTop, Math.min(labelBottom, w.y))]));
    const lx = innerW + bracketCol + 4;
    for (const w of wanted) {
      if (!placed.has(w.key)) continue;
      const color = getDriverColor(w.key);
      const st = traceLineStyle(w.key, state);
      labelsG.append('text').attr('class', 'rt-end-label').attr('data-driver', w.key)
        .attr('x', lx).attr('y', placed.get(w.key)).attr('dominant-baseline', 'middle')
        .attr('fill', st.context ? contextText(textColor(color), SURFACES.panel, CONTEXT_MIX_LINES) : textColor(color))
        .style('font-size', CHART_FONT.data).attr('font-weight', 700).attr('font-family', 'var(--font-display)')
        .style('display', mode === 'full' || w.key === state.highlighted ? null : 'none')
        .text(w.text);
    }
    const edge = (list, yy, glyph) => {
      if (!list.length) return;
      labelsG.append('text').attr('class', 'rt-outside')
        .attr('x', lx).attr('y', yy).attr('dominant-baseline', 'middle')
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.data).attr('font-weight', 700)
        .text(`${glyph} ${list.length}`)
        .append('title').text(`${list.length} car${list.length === 1 ? '' : 's'} ${glyph === '▲' ? 'above' : 'below'} the window: ${list.join(', ')}`);
    };
    edge(win.above, countTop, '▲');
    edge(win.below, countBottom, '▼');

    // Drag along x: a lap range; a click on the background clears one
    const sel = g.append('rect').attr('class', 'rt-drag').attr('y', 0).attr('height', innerH)
      .attr('fill', withAlpha(UI_COLORS.brush, 0.16)).attr('stroke', UI_COLORS.brush).style('display', 'none')
      .style('pointer-events', 'none');
    const toLaps = (a, b) => {
      const lo = Math.max(1, Math.floor(x.invert(Math.min(a, b))) + 1);
      const hi = Math.min(trace.lastLap, Math.max(lo, Math.ceil(x.invert(Math.max(a, b)))));
      return [Math.min(lo, hi), hi];
    };
    svg.on('mousedown.rt', (event) => {
      const [px] = d3.pointer(event, g.node());
      drag.start = Math.max(0, Math.min(innerW, px));
      drag.moved = false;
    });
    svg.on('mousemove.rt', (event) => {
      if (drag.start == null) return;
      const [px] = d3.pointer(event, g.node());
      const cur = Math.max(0, Math.min(innerW, px));
      if (Math.abs(cur - drag.start) < DRAG_PX && !drag.moved) return;
      drag.moved = true;
      sel.style('display', null).attr('x', Math.min(cur, drag.start)).attr('width', Math.abs(cur - drag.start));
    });
    svg.on('mouseup.rt', (event) => {
      if (drag.start == null) return;
      const [px] = d3.pointer(event, g.node());
      const cur = Math.max(0, Math.min(innerW, px));
      if (drag.moved) setBrushLapRange(toLaps(drag.start, cur));
      drag.start = null;
      sel.style('display', 'none');
      // the click that follows a drag selects nothing; the next one does
      setTimeout(() => { drag.moved = false; }, 0);
    });
    svg.on('click.rt', () => {
      if (!drag.moved && selectedLapRange) setBrushLapRange(null);
    });

    return () => {
      svg.on('.rt', null);
      if (tip) tip.style.display = 'none';
    };
  }, [trace, bands, stops, win, pitLoss, mode, box.width, box.height, ids, hasTrace, raceOver, isLiveMode,
    focusDriver, selectedDrivers, selectedLapRange, setHighlightedDriver, toggleDriver, setFocusDriver,
    setBrushLapRange, setCurrentLap]);

  // Hover without a redraw: the hovered line in its colour at 2 px, the others
  // context; its end label shown in the compact mode
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    const state = { focus: focusDriver, selected: selectedDrivers, highlighted: highlightedDriver };
    svg.selectAll('.rt-line').each(function restyle() {
      const el = d3.select(this);
      const st = traceLineStyle(el.attr('data-driver'), state);
      el.attr('stroke', st.stroke).attr('stroke-width', st.width);
      if (el.attr('data-driver') === highlightedDriver) el.raise();
    });
    if (mode !== 'full') {
      svg.selectAll('.rt-end-label').style('display', function show() {
        return this.getAttribute('data-driver') === highlightedDriver ? null : 'none';
      });
    }
  }, [highlightedDriver, focusDriver, selectedDrivers, mode, trace, box.width, box.height]);

  const refName = trace.reference === 'focus' ? trace.focusDriver : trace.reference.toUpperCase();
  const controls = mode === 'answer' ? null : (
    <>
      <button
        type="button"
        className="pos-chart-toggle rt-reference"
        onClick={() => setReference(nextOption(REFERENCE_OPTIONS, trace.reference, (o) => o !== 'focus' || !!refCar))}
        aria-label={`Race Trace reference: ${trace.reference}`}
        title="Reference (click for the next): the field-median car, the first car across each lap, or the focus car"
      >
        VS {refName}
      </button>
      <button
        type="button"
        className="pos-chart-toggle rt-window"
        onClick={() => setWindow(nextOption(WINDOW_OPTIONS, win.mode, (o) => o !== 'focus' || !!focusDriver))}
        aria-label={`Race Trace window: ${win.mode}`}
        title="y window (click for the next): the top 10 of the lead lap, the focus car within one pit stop, or every car"
      >
        {WINDOW_NAMES[win.mode]}
      </button>
    </>
  );

  const lineStyle = {
    flex: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  };
  let body;
  if (!race) {
    body = <div className="loading-placeholder"><span>Race and sprint sessions only</span></div>;
  } else if (!hasTrace) {
    body = <div className="loading-placeholder"><span>No lap completed yet</span></div>;
  } else if (mode === 'answer') {
    body = (
      <div className="rt-answer" style={{ color: TEXT_COLORS.primary, fontSize: CHART_FONT.data, fontWeight: 700, margin: 'auto 0' }}>
        {answer}
      </div>
    );
  } else {
    body = (
      <>
        <div className="rt-answer" style={{ ...lineStyle, color: TEXT_COLORS.primary, fontSize: CHART_FONT.data, fontWeight: 700 }} title={answer}>
          {answer}
        </div>
        <div className="viz-container" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        {/* the rows the legend needs: the chart (flex 1) gives up the height and redraws */}
        <div className="rt-legend" style={{ flex: 'none' }}>
          <Legend items={legendItems} />
        </div>
        <div className="rt-provenance" style={{ ...lineStyle, color: TEXT_COLORS.muted, fontSize: CHART_FONT.label }} title={provenance}>
          {provenance}
        </div>
      </>
    );
  }

  return (
    <Panel title="Race Trace" controls={controls} className="panel--dense">
      <div ref={rootRef} className="race-trace" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {body}
        <div ref={tipRef} className="pos-chart-tooltip" style={{ display: 'none' }} />
      </div>
    </Panel>
  );
}
