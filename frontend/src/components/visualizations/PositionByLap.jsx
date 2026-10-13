import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor, TYRE_COLORS } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { completedLaps, isLapCompleted } from '../../utils/raceTime';
import { causalKey } from '../../utils/strategyViews';
import { positionPitMarkers } from '../../utils/views/positionByLap';
import Panel from '../ui/Panel';

const MARGIN = { top: 28, right: 90, bottom: 32, left: 36 };

/* ── Stint builder ─────────────────────────────────────────────── */
function buildStints(driverLaps) {
  const stints = [];
  let current = null;
  for (const lap of driverLaps) {
    const c = lap.Compound || 'UNKNOWN';
    if (!current || c !== current.compound) {
      // Bridge: duplicate last point of previous stint so segments connect
      if (current && current.laps.length) {
        current = { compound: c, laps: [current.laps[current.laps.length - 1]] };
      } else {
        current = { compound: c, laps: [] };
      }
      stints.push(current);
    }
    current.laps.push(lap);
  }
  return stints;
}

/* ── Undercut window computation ───────────────────────────────── */
function computeUndercutWindow(focus, driverLapMap, lap, maxLap) {
  const focusLaps = driverLapMap[focus];
  if (!focusLaps?.length) return null;
  const currentFocusLap = focusLaps.find(l => l.LapNumber === lap);
  if (!currentFocusLap?.Position) return null;

  const targetPos = currentFocusLap.Position - 1;
  if (targetPos < 1) return null;

  let targetDriver = null;
  for (const [drv, laps] of Object.entries(driverLapMap)) {
    const l = laps.find(l => l.LapNumber === lap);
    if (l && l.Position === targetPos) { targetDriver = drv; break; }
  }
  if (!targetDriver) return null;

  const targetCurrentLap = driverLapMap[targetDriver]?.find(l => l.LapNumber === lap);
  const targetTyreAge = targetCurrentLap?.TyreLife || 0;
  const focusTyreAge = currentFocusLap.TyreLife || 0;
  const tyreAgeDiff = targetTyreAge - focusTyreAge;
  if (tyreAgeDiff < 3) return null;

  const windowEnd = Math.min(lap + Math.min(tyreAgeDiff, 8), maxLap - 5);
  if (windowEnd <= lap) return null;

  return {
    targetDriver,
    lapStart: lap,
    lapEnd: windowEnd,
    targetTyreAge,
    focusTyreAge,
    focusPos: currentFocusLap.Position,
  };
}

export default function PositionByLap() {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const tooltipRef = useRef(null);
  const brushSyncRef = useRef(false);   // true while we programmatically move the brush
  const [dims, setDims] = useState({ width: 600, height: 400 });
  const [showProjection, setShowProjection] = useState(true);
  const [showUndercut, setShowUndercut] = useState(true);

  const lapTimes        = useF1Store(s => s.sessionData?.lap_times ?? []);
  const focusDriver     = useF1Store(s => s.focusDriver);
  const setFocusDriver  = useF1Store(s => s.setFocusDriver);
  const selectedDrivers = useF1Store(s => s.selectedDrivers);
  const currentLap      = useF1Store(s => s.currentLap);
  const maxLap          = useF1Store(s => s.maxLap);
  const lstmPredictions = useF1Store(s => s.lstmPredictions);
  const replayActive    = useF1Store(s => s.totalFrames > 0);
  const brushLapRange   = useF1Store(s => s.brushLapRange);
  const setBrushLapRange = useF1Store(s => s.setBrushLapRange);
  // Causal "now" in session seconds (utils/raceTime.js): positions, stints and
  // pit markers are drawn only for laps completed at that time
  const sessionNow      = useSessionNow();

  /* ── Resize observer ─────────────────────────────────────────── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── Data preparation ────────────────────────────────────────── */
  // Rows completed at sessionNow: the count changes once per finished lap, so
  // the chart is redrawn per completed lap, not on every replay tick
  const completedCount = useMemo(() => {
    let n = 0;
    for (const row of lapTimes) if (isLapCompleted(row, sessionNow)) n++;
    return n;
  }, [lapTimes, sessionNow]);

  const { driverLapMap, allDrivers, compoundsUsed } = useMemo(() => {
    const map = {};
    const compounds = new Set();
    completedLaps(lapTimes, sessionNow).forEach(row => {
      if (!row.Driver || !row.Position) return;
      if (!map[row.Driver]) map[row.Driver] = [];
      map[row.Driver].push(row);
      if (row.Compound) compounds.add(row.Compound);
    });
    Object.values(map).forEach(arr => arr.sort((a, b) => a.LapNumber - b.LapNumber));
    return { driverLapMap: map, allDrivers: Object.keys(map), compoundsUsed: [...compounds] };
    // sessionNow enters through completedCount, which changes whenever the result does
  }, [lapTimes, completedCount]);

  // Pit stops (tyre changes) visible at sessionNow: rebuilt when a lap
  // completes or a pit event happens (causalKey), not on every replay tick
  const pitKey = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);
  const pitMarkers = useMemo(
    () => positionPitMarkers(lapTimes, sessionNow),
    // sessionNow enters through pitKey, which changes whenever the result does
    [lapTimes, pitKey],
  );

  const numDrivers = allDrivers.length || 20;
  const effectiveMaxLap = Math.max(maxLap || 1, d3.max(lapTimes, d => d.LapNumber) || 70);

  /* ── D3 rendering ────────────────────────────────────────────── */
  useEffect(() => {
    if (!svgRef.current || !lapTimes.length) return;
    const { width, height } = dims;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    /* Clip path */
    svg.append('defs').append('clipPath').attr('id', 'posChart-clip')
      .append('rect')
      .attr('x', MARGIN.left).attr('y', MARGIN.top)
      .attr('width', width - MARGIN.left - MARGIN.right)
      .attr('height', height - MARGIN.top - MARGIN.bottom);

    /* Scales */
    const xScale = d3.scaleLinear()
      .domain([1, effectiveMaxLap])
      .range([MARGIN.left, width - MARGIN.right]);

    const yScale = d3.scaleLinear()
      .domain([1, Math.min(numDrivers, 20)])
      .range([MARGIN.top, height - MARGIN.bottom]);

    /* Layer groups */
    const gridG      = svg.append('g').attr('class', 'pos-chart__grid');
    const axesG      = svg.append('g').attr('class', 'pos-chart__axes');
    const undercutG  = svg.append('g').attr('class', 'pos-chart__undercut-bands').attr('clip-path', 'url(#posChart-clip)');
    const linesG     = svg.append('g').attr('class', 'pos-chart__lines').attr('clip-path', 'url(#posChart-clip)');
    const pitG       = svg.append('g').attr('class', 'pos-chart__pit-markers').attr('clip-path', 'url(#posChart-clip)');
    const projG      = svg.append('g').attr('class', 'pos-chart__projection').attr('clip-path', 'url(#posChart-clip)');
    const curLapG    = svg.append('g').attr('class', 'pos-chart__current-lap').attr('clip-path', 'url(#posChart-clip)');
    const brushG     = svg.append('g').attr('class', 'pos-chart__brush');
    const labelsG    = svg.append('g').attr('class', 'pos-chart__driver-labels');

    const lineGen = d3.line()
      .x(d => xScale(d.LapNumber))
      .y(d => yScale(d.Position))
      .curve(d3.curveMonotoneX);

    /* ── Layer 1: Grid ─────────────────────────────────────────── */
    const positions = d3.range(1, Math.min(numDrivers, 20) + 1);
    gridG.selectAll('line')
      .data(positions)
      .join('line')
      .attr('x1', MARGIN.left).attr('x2', width - MARGIN.right)
      .attr('y1', d => yScale(d)).attr('y2', d => yScale(d))
      .attr('stroke', d => d === 1 ? 'rgba(255,215,0,0.12)' : 'rgba(255,255,255,0.04)')
      .attr('stroke-dasharray', '2 4');

    /* ── Layer 2: Compound-colored lines ───────────────────────── */
    const allDriverPaths = [];

    allDrivers.forEach(driver => {
      const laps = driverLapMap[driver];
      if (!laps?.length) return;

      const stints = buildStints(laps);
      const isFocus = driver === focusDriver;
      const isSelected = selectedDrivers.includes(driver);
      const isDimmed = focusDriver && !isFocus && !isSelected;

      let sw, op;
      if (isFocus) { sw = 3; op = 1; }
      else if (isSelected) { sw = 2; op = 0.75; }
      else if (isDimmed) { sw = 1.5; op = 0.12; }
      else { sw = 1.5; op = 0.25; }

      stints.forEach(stint => {
        if (stint.laps.length < 2) return;
        const color = TYRE_COLORS[stint.compound] || TYRE_COLORS.UNKNOWN;
        linesG.append('path')
          .datum(stint.laps)
          .attr('d', lineGen)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', sw)
          .attr('opacity', op)
          .style('filter', isFocus ? `drop-shadow(0 0 3px ${color})` : null);
      });

      // Collect full path points for hit area
      allDriverPaths.push({ driver, points: laps });
    });

    /* ── Hit areas for click interaction ───────────────────────── */
    linesG.selectAll('.pos-line-hit')
      .data(allDriverPaths)
      .join('path')
      .attr('class', 'pos-line-hit')
      .attr('d', d => lineGen(d.points))
      .attr('stroke', 'transparent')
      .attr('stroke-width', 12)
      .attr('fill', 'none')
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        setFocusDriver(d.driver === focusDriver ? null : d.driver);
      })
      .on('mouseenter', (event, d) => {
        const tip = tooltipRef.current;
        if (!tip) return;
        const lastLap = d.points[d.points.length - 1];
        const color = getDriverColor(d.driver);
        tip.style.display = 'block';
        tip.innerHTML = `
          <div class="pos-chart-tooltip__driver" style="color:${color}">${d.driver}</div>
          <div class="pos-chart-tooltip__row"><span>Position</span><span>P${lastLap.Position}</span></div>
          <div class="pos-chart-tooltip__row"><span>Lap</span><span>${lastLap.LapNumber}</span></div>
          <div class="pos-chart-tooltip__row"><span>Tyre</span><span>${lastLap.Compound || '—'}</span></div>
          <div class="pos-chart-tooltip__row"><span>Tyre age</span><span>${lastLap.TyreLife || '—'} laps</span></div>
        `;
      })
      .on('mousemove', (event) => {
        const tip = tooltipRef.current;
        if (!tip) return;
        tip.style.left = `${event.clientX + 12}px`;
        tip.style.top = `${event.clientY - 10}px`;
      })
      .on('mouseleave', () => {
        const tip = tooltipRef.current;
        if (tip) tip.style.display = 'none';
      });

    /* ── Layer 3: Pit stop markers ─────────────────────────────── */
    // One per tyre change visible at sessionNow (positionPitMarkers, utils/views)
    pitMarkers.forEach(({ driver, lap, position, fromCompound, toCompound, tyreAge }) => {
      const color = getDriverColor(driver);
      const isDimmed = focusDriver && driver !== focusDriver && !selectedDrivers.includes(driver);
      const cx = xScale(lap);
      const cy = yScale(position);

      const g = pitG.append('g').attr('opacity', isDimmed ? 0.12 : 0.9);

      // Vertical tick
      g.append('line')
        .attr('x1', cx).attr('x2', cx)
        .attr('y1', cy - yScale(0.7) + yScale(1))
        .attr('y2', cy + yScale(0.7) - yScale(1))
        .attr('stroke', color).attr('stroke-width', 2);

      // Circle
      g.append('circle')
        .attr('cx', cx).attr('cy', cy).attr('r', 4)
        .attr('fill', color).attr('stroke', 'rgba(0,0,0,0.5)').attr('stroke-width', 1);

      // Pit tooltip on hover
      g.style('cursor', 'default')
        .on('mouseenter', (event) => {
          const tip = tooltipRef.current;
          if (!tip) return;
          tip.style.display = 'block';
          tip.innerHTML = `
            <div class="pos-chart-tooltip__driver" style="color:${color}">${driver} — LAP ${lap}</div>
            <div class="pos-chart-tooltip__row"><span>Strategy</span><span>${fromCompound || '?'} → ${toCompound || '?'}</span></div>
            <div class="pos-chart-tooltip__row"><span>Tyre age</span><span>${tyreAge ?? '?'} laps</span></div>
          `;
          tip.style.left = `${event.clientX + 12}px`;
          tip.style.top = `${event.clientY - 10}px`;
        })
        .on('mouseleave', () => {
          const tip = tooltipRef.current;
          if (tip) tip.style.display = 'none';
        });
    });

    /* ── Layer 4: Undercut band ────────────────────────────────── */
    if (showUndercut && focusDriver) {
      // Positions and tyre ages at the focus driver's last completed lap
      const focusDone = driverLapMap[focusDriver];
      const ucLap = focusDone?.length ? focusDone[focusDone.length - 1].LapNumber : currentLap;
      const uc = computeUndercutWindow(focusDriver, driverLapMap, ucLap, effectiveMaxLap);
      if (uc) {
        const x0 = xScale(uc.lapStart);
        const x1 = xScale(uc.lapEnd);
        const y0 = yScale(uc.focusPos - 0.5);
        const y1 = yScale(uc.focusPos + 1.5);

        undercutG.append('rect')
          .attr('class', 'pos-undercut-band')
          .attr('x', x0).attr('y', y0)
          .attr('width', x1 - x0).attr('height', y1 - y0)
          .attr('fill', 'rgba(34,197,94,0.08)')
          .attr('stroke', 'rgba(34,197,94,0.3)')
          .attr('stroke-width', 1)
          .attr('stroke-dasharray', '4 3');

        undercutG.append('text')
          .attr('class', 'pos-undercut-label')
          .attr('x', x0 + 4).attr('y', y0 + 10)
          .text(`⬇ PIT WINDOW (vs ${uc.targetDriver})`);
      }
    }

    /* ── Layer 5: LSTM projected position ──────────────────────── */
    if (showProjection && focusDriver && currentLap > 5) {
      const focusLaps = driverLapMap[focusDriver];
      if (focusLaps?.length) {
        // Anchor: the focus driver's last completed lap (focusLaps holds
        // completed laps only)
        const focusCurrent = focusLaps[focusLaps.length - 1];
        const anchorLap = focusCurrent.LapNumber;
        const focusCurrentPos = focusCurrent.Position;
        const color = getDriverColor(focusDriver);

        // Compute trend from the last 5 completed laps
        const last5 = focusLaps
          .filter(l => l.LapNumber >= anchorLap - 5)
          .slice(-5);

        let positionTrend = 0;
        if (last5.length >= 2) {
          positionTrend = (last5[last5.length - 1].Position - last5[0].Position) / last5.length;
        }

        const projectionLaps = 5;
        const projectedPoints = [{ LapNumber: anchorLap, Position: focusCurrentPos }];
        let lastProj = focusCurrentPos;
        for (let i = 1; i <= projectionLaps; i++) {
          if (anchorLap + i > effectiveMaxLap) break;
          lastProj = Math.max(1, Math.min(numDrivers, focusCurrentPos + positionTrend * i));
          projectedPoints.push({ LapNumber: anchorLap + i, Position: lastProj });
        }

        if (projectedPoints.length >= 2) {
          projG.append('path')
            .datum(projectedPoints)
            .attr('d', lineGen)
            .attr('fill', 'none')
            .attr('stroke', color)
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '6 4')
            .attr('opacity', 0.65);

          const lastPt = projectedPoints[projectedPoints.length - 1];
          projG.append('circle')
            .attr('cx', xScale(lastPt.LapNumber))
            .attr('cy', yScale(lastPt.Position))
            .attr('r', 3)
            .attr('fill', color).attr('opacity', 0.7);

          projG.append('text')
            .attr('class', 'pos-projection-label')
            .attr('x', xScale(lastPt.LapNumber) + 6)
            .attr('y', yScale(lastPt.Position) + 3)
            .attr('fill', color).attr('opacity', 0.7)
            .text(`P${Math.round(lastPt.Position)}?`);
        }
      }
    }

    /* ── Layer 6: Current lap vertical line ────────────────────── */
    if (replayActive || currentLap > 1) {
      curLapG.append('line')
        .attr('x1', xScale(currentLap)).attr('x2', xScale(currentLap))
        .attr('y1', MARGIN.top).attr('y2', height - MARGIN.bottom)
        .attr('stroke', 'rgba(255,255,255,0.2)')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '2 3');

      curLapG.append('text')
        .attr('x', xScale(currentLap))
        .attr('y', MARGIN.top - 6)
        .attr('text-anchor', 'middle')
        .attr('fill', 'rgba(255,255,255,0.4)')
        .attr('font-size', '8px')
        .text(`LAP ${currentLap}`);
    }

    /* ── Layer 7: Driver end-labels ────────────────────────────── */
    const driverFinals = allDrivers.map(driver => {
      const laps = driverLapMap[driver];
      const last = laps[laps.length - 1];
      return { driver, lap: last.LapNumber, pos: last.Position };
    }).sort((a, b) => a.pos - b.pos);

    driverFinals.forEach(({ driver, lap, pos }) => {
      const isFocus = driver === focusDriver;
      const isDimmed = focusDriver && !isFocus && !selectedDrivers.includes(driver);
      const color = getDriverColor(driver);

      labelsG.append('text')
        .attr('class', 'pos-driver-label')
        .attr('x', xScale(lap) + 6)
        .attr('y', yScale(pos) + 3)
        .attr('fill', color)
        .attr('opacity', isDimmed ? 0.3 : 1)
        .attr('font-size', isFocus ? '10px' : '9px')
        .attr('font-weight', isFocus ? 800 : 700)
        .style('filter', isFocus ? `drop-shadow(0 0 2px ${color})` : null)
        .text(driver);
    });

    /* ── Axes ──────────────────────────────────────────────────── */
    // Y axis
    const yTicks = positions;
    axesG.append('g')
      .attr('transform', `translate(${MARGIN.left},0)`)
      .call(d3.axisLeft(yScale)
        .tickValues(yTicks)
        .tickFormat(d => `P${d}`)
        .tickSize(0))
      .call(g => g.select('.domain').remove())
      .call(g => g.selectAll('text')
        .attr('fill', 'rgba(255,255,255,0.4)')
        .attr('font-size', '9px'));

    // X axis
    axesG.append('g')
      .attr('transform', `translate(0,${height - MARGIN.bottom})`)
      .call(d3.axisBottom(xScale)
        .ticks(Math.min(effectiveMaxLap / 5, 14))
        .tickFormat(d3.format('d'))
        .tickSize(0))
      .call(g => g.select('.domain').remove())
      .call(g => g.selectAll('text')
        .attr('fill', 'rgba(255,255,255,0.4)')
        .attr('font-size', '9px'));

    /* ── Layer 8: D3 Brush ─────────────────────────────────────── */
    const brush = d3.brushX()
      .extent([[MARGIN.left, MARGIN.top], [width - MARGIN.right, height - MARGIN.bottom]])
      .on('end', (event) => {
        // Skip events triggered by our own programmatic brush.move
        if (brushSyncRef.current) return;
        if (!event.selection) {
          setBrushLapRange(null);
          return;
        }
        const [x0, x1] = event.selection;
        const lapStart = Math.round(xScale.invert(x0));
        const lapEnd = Math.round(xScale.invert(x1));
        setBrushLapRange([lapStart, lapEnd]);
      });

    brushG.call(brush);

    // If brushLapRange is already set, programmatically restore the visual
    if (brushLapRange) {
      brushSyncRef.current = true;
      brushG.call(brush.move, [xScale(brushLapRange[0]), xScale(brushLapRange[1])]);
      brushSyncRef.current = false;
    }

  }, [lapTimes, dims, focusDriver, selectedDrivers, currentLap, maxLap, effectiveMaxLap,
      numDrivers, showProjection, showUndercut, replayActive, lstmPredictions, driverLapMap,
      allDrivers, brushLapRange, setBrushLapRange, setFocusDriver, pitMarkers]);

  /* ── Legend items ─────────────────────────────────────────────── */
  const legendItems = useMemo(() => {
    const items = compoundsUsed
      .filter(c => TYRE_COLORS[c])
      .map(c => ({ type: 'dot', color: TYRE_COLORS[c], label: c }));
    if (showProjection) items.push({ type: 'dash', color: getDriverColor(focusDriver) || '#888', label: 'PROJECTED' });
    if (showUndercut) items.push({ type: 'band', color: '#22c55e', label: 'PIT WINDOW' });
    return items;
  }, [compoundsUsed, showProjection, showUndercut, focusDriver]);

  /* ── Header controls ─────────────────────────────────────────── */
  const controls = (
    <>
      <div className="pos-chart-legend">
        {legendItems.map((item, i) => (
          <div key={i} className="pos-chart-legend__item">
            {item.type === 'dot' && <span className="pos-chart-legend__dot" style={{ background: item.color }} />}
            {item.type === 'dash' && <span className="pos-chart-legend__dash" style={{ borderColor: item.color }} />}
            {item.type === 'band' && <span style={{ width: 14, height: 8, background: 'rgba(34,197,94,0.15)', border: `1px solid ${item.color}`, borderRadius: 2, flexShrink: 0 }} />}
            {item.label}
          </div>
        ))}
      </div>
      <button
        className={`pos-chart-toggle${showProjection ? ' pos-chart-toggle--active' : ''}`}
        onClick={() => setShowProjection(p => !p)}
        title="Toggle position projection"
      >
        PROJECTION
      </button>
      <button
        className={`pos-chart-toggle${showUndercut ? ' pos-chart-toggle--active' : ''}`}
        onClick={() => setShowUndercut(u => !u)}
        title="Toggle undercut opportunity band"
      >
        UNDERCUT
      </button>
      {brushLapRange && (
        <button
          className="pos-chart-clear-brush"
          onClick={() => setBrushLapRange(null)}
          title="Clear lap range selection"
        >
          ✕ LAP {brushLapRange[0]}–{brushLapRange[1]}
        </button>
      )}
    </>
  );

  return (
    <Panel title="POSITION TRACKER" controls={controls}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
        <svg
          ref={svgRef}
          width={dims.width}
          height={dims.height}
          style={{ display: 'block' }}
        />
        <div ref={tooltipRef} className="pos-chart-tooltip" style={{ display: 'none' }} />
      </div>
    </Panel>
  );
}
