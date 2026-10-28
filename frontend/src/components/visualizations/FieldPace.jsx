/**
 * Race Pace: who had the race pace here, how sure is that, and who beat his
 * team-mate.
 *
 * One row per team on a shared % axis ("faster ◀ 0 = field median, same
 * lap"; utils/fieldPace.js): each comparable lap against the median of the
 * same lap. Per row two marks in the team colour, a circle for the first
 * driver and a diamond for the second (the shape tells team-mates apart),
 * each at the driver's median with its 80 % interval (moving-block
 * bootstrap), the driver code and the laps counted (shortened to the code
 * where the axis column has no room: a label never covers the team name or
 * the gap); hollow and "LOW DATA" under 10 laps. Rows sorted by the team
 * median. On the right the team-mate gap with its interval: "decisive" only
 * when the interval excludes 0.
 *
 * Reads the brushed lap range (a chip "laps 20–35 ×" clears it), causal at
 * the dashboard's clock. 21 px rows, up to 10 a page, a pager in the header
 * for the rest (utils/views/fieldPaceChart.js FIELD_PACE_MIN: 220 px hold
 * ten rows); under 560 px of width the answer line only. Nothing scrolls.
 */
import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, markColor, textColor, TEXT_COLORS, GRID_COLORS, SURFACES, CHART_FONT, chartFontPx,
  UI_COLORS, withAlpha, BRUSH_TINT_ALPHA,
} from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey } from '../../utils/strategyViews';
import { fieldPace, pctText, gapLine, PACE_LOW_DATA_LAPS } from '../../utils/fieldPace';
import {
  FIELD_PACE_ROW_PX, paceRowsFit, pacePage, paceDomain, markShape, diamondPath, paceAnswer,
  markLabelLayout, paceAnswerOnly,
} from '../../utils/views/fieldPaceChart';
import Panel from '../ui/Panel';
import { useChartBox } from '../../utils/views/chartBox';

// Radius of a driver's mark (px)
const MARK_R = 4.5;

export default function FieldPace() {
  const rootRef = useRef(null);
  const svgRef = useRef(null);
  const tipRef = useRef(null);
  const box = useChartBox(rootRef, { parent: false });
  const [page, setPage] = useState(0);
  const [hoverTeam, setHoverTeam] = useState(null);

  const sessionData = useF1Store((s) => s.sessionData);
  const trackStatus = useF1Store((s) => s.trackStatus);
  const brushLapRange = useF1Store((s) => s.brushLapRange);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const setBrushLapRange = useF1Store((s) => s.setBrushLapRange);

  const lapTimes = useMemo(() => sessionData?.lap_times || [], [sessionData]);
  const status = useMemo(() => trackStatus || sessionData?.track_status || [], [trackStatus, sessionData]);
  // Causal "now" and a key that changes only when a lap, a pit event or a
  // track-status period completes: the pace is not recomputed every frame
  const sessionNow = useSessionNow();
  const causal = useMemo(() => causalKey(lapTimes, sessionNow, status), [lapTimes, sessionNow, status]);
  const rangeKey = brushLapRange ? `${brushLapRange[0]}-${brushLapRange[1]}` : '';
  const pace = useMemo(
    () => fieldPace(lapTimes, {
      sessionNow, trackStatus: status, lapRange: brushLapRange, driverInfo: sessionData?.driver_info,
    }),
    // sessionNow enters through the causal key, which changes whenever the result does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lapTimes, status, causal, rangeKey, sessionData],
  );

  const width = box.width || 640;
  const height = box.height || 260;
  // the axis line: one line of label text
  const axisH = Math.ceil(chartFontPx('label'));
  const answerOnly = paceAnswerOnly(box, axisH);
  const fit = paceRowsFit(height - axisH, pace.teams.length);
  // the same rows object while the page holds the same teams: the draw effect
  // (and the tooltip it would hide) does not run again on every replay frame
  const pg = useMemo(() => pacePage(pace.teams, page, fit.perPage), [pace.teams, page, fit.perPage]);
  useEffect(() => { if (pg.page !== page) setPage(pg.page); }, [pg.page, page]);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || answerOnly) return undefined;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    const dataPx = chartFontPx('data');
    const labelPx = chartFontPx('label');

    // Columns: team name | the % axis | the team-mate gap (their widest texts)
    const probe = svg.append('text').style('font-size', CHART_FONT.data).attr('font-weight', 700).style('visibility', 'hidden');
    const widest = (texts) => texts.reduce((w, t) => { probe.text(t); return Math.max(w, probe.node().getComputedTextLength()); }, 0);
    const teamW = Math.min(width * 0.2, Math.ceil(widest(pg.rows.map((t) => t.team))) + 8);
    const gapW = Math.ceil(widest(pg.rows.map((t) => gapLine(t.gap)).concat(['team-mate gap, 80 %']))) + 8;
    const textW = (t) => widest([t]);
    const x0 = teamW;
    const x1 = Math.max(x0 + 60, width - gapW);
    const x = d3.scaleLinear().domain(paceDomain(pace)).range([x0 + 8, x1 - 8]);

    // Axis line: ticks, the caption at 0, the gap column's head
    const axis = svg.append('g').attr('class', 'fp-axis');
    const zero = x(0);
    const caption = axis.append('text').attr('class', 'fp-caption')
      .attr('x', zero).attr('y', Math.round(labelPx * 0.85)).attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.label).attr('font-weight', 700)
      .text('faster ◀ 0 = field median, same lap');
    const capW = caption.node().getComputedTextLength();
    // keep the caption inside the axis column
    const capX = Math.max(x0 + capW / 2, Math.min(x1 - capW / 2, zero));
    caption.attr('x', capX);
    for (const v of x.ticks(5)) {
      if (v === 0) continue;
      const tx = x(v);
      if (Math.abs(tx - capX) < capW / 2 + 18 || tx < x0 + 10 || tx > x1 - 10) continue;
      axis.append('text').attr('class', 'fp-tick').attr('x', tx).attr('y', Math.round(labelPx * 0.85)).attr('text-anchor', 'middle')
        .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label).text(pctText(v));
    }
    axis.append('text').attr('class', 'fp-gap-head')
      .attr('x', width - 2).attr('y', Math.round(labelPx * 0.85)).attr('text-anchor', 'end')
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label).attr('font-weight', 600)
      .text('team-mate gap, 80 %');

    const rowsTop = axisH;
    const rowsH = pg.rows.length * FIELD_PACE_ROW_PX;
    // Grid of the ticks and the zero line, under the rows
    const grid = svg.append('g').attr('class', 'fp-grid');
    for (const v of x.ticks(5)) {
      grid.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', rowsTop).attr('y2', rowsTop + rowsH)
        .attr('stroke', v === 0 ? GRID_COLORS.axis : GRID_COLORS.grid)
        .attr('stroke-dasharray', v === 0 ? null : '2,4');
    }

    const tip = tipRef.current;
    const showTip = (event, html) => {
      if (!tip) return;
      tip.innerHTML = html;
      tip.style.display = 'block';
      tip.style.left = `${event.clientX + 12}px`;
      tip.style.top = `${event.clientY - 10}px`;
    };

    pg.rows.forEach((team, i) => {
      const y0 = rowsTop + i * FIELD_PACE_ROW_PX;
      const cy = y0 + FIELD_PACE_ROW_PX / 2;
      const row = svg.append('g').attr('class', 'fp-row').attr('data-team', team.team).style('cursor', 'pointer');
      const selected = team.drivers.length > 0 && team.drivers.every((d) => selectedDrivers.includes(d));
      row.append('rect').attr('class', 'fp-row-bg')
        .attr('x', 0).attr('y', y0).attr('width', width).attr('height', FIELD_PACE_ROW_PX)
        .attr('fill', selected ? withAlpha(UI_COLORS.brush, BRUSH_TINT_ALPHA * 3) : 'transparent');
      row.append('text').attr('class', 'fp-team')
        .attr('x', 2).attr('y', cy).attr('dominant-baseline', 'middle')
        .attr('fill', TEXT_COLORS.secondary).style('font-size', CHART_FONT.data).attr('font-weight', 700)
        .text(team.team);

      // The marks: median, 80 % interval, code and laps; the labels beside
      // them, inside the axis column, shortened when the room asks for it
      // (markLabelLayout: 'TSU n4 LOW DATA', 'TSU n4', 'TSU')
      const racing = team.drivers.filter((d) => pace.drivers[d]?.n > 0)
        .sort((a, b) => pace.drivers[a].median - pace.drivers[b].median);
      const labelsOf = (d) => {
        const p = pace.drivers[d];
        const texts = p.lowData ? [`${d} n${p.n} LOW DATA`, `${d} n${p.n}`, d] : [`${d} n${p.n}`, d];
        return texts.map((text) => ({ text, w: textW(text) }));
      };
      const layout = markLabelLayout(racing.map((d) => {
        const p = pace.drivers[d];
        const ext = [p.median, p.lo, p.hi].filter(Number.isFinite).map((v) => x(v));
        return { key: d, left: Math.min(...ext) - MARK_R, right: Math.max(...ext) + MARK_R, labels: labelsOf(d) };
      }), { x0: x0 + 2, x1: x1 - 2 });
      racing.forEach((d) => {
        const p = pace.drivers[d];
        const color = markColor(getDriverColor(d));
        const shape = markShape(d);
        const dy = shape === 'diamond' ? 3 : -3;
        const mark = row.append('g').attr('class', `fp-mark fp-mark--${shape}`).attr('data-driver', d);
        if (p.lo != null && p.hi != null) {
          mark.append('path').attr('class', 'fp-interval')
            .attr('d', `M${x(p.lo)},${cy + dy - 3}V${cy + dy + 3}M${x(p.lo)},${cy + dy}H${x(p.hi)}M${x(p.hi)},${cy + dy - 3}V${cy + dy + 3}`)
            .attr('stroke', color).attr('stroke-width', 1.5).attr('fill', 'none');
        }
        const mx = x(p.median);
        const fill = p.lowData ? SURFACES.panel : color;
        const r = d === focusDriver ? MARK_R + 1.5 : MARK_R;
        if (shape === 'diamond') {
          mark.append('path').attr('class', 'fp-dot').attr('d', diamondPath(r + 1)).attr('transform', `translate(${mx},${cy + dy})`)
            .attr('fill', fill).attr('stroke', color).attr('stroke-width', 1.5);
        } else {
          mark.append('circle').attr('class', 'fp-dot').attr('cx', mx).attr('cy', cy + dy).attr('r', r)
            .attr('fill', fill).attr('stroke', color).attr('stroke-width', 1.5);
        }
        const at = layout.get(d);
        if (at) {
          mark.append('text').attr('class', 'fp-label')
            .attr('x', at.x).attr('y', cy).attr('dominant-baseline', 'middle').attr('text-anchor', at.anchor)
            .attr('fill', textColor(getDriverColor(d))).style('font-size', CHART_FONT.data).attr('font-weight', 700)
            .text(at.text);
        }
        mark.on('mousemove', (event) => showTip(event,
          `<div style="font-weight:800;color:${textColor(getDriverColor(d), SURFACES.elevated)}">${d} · ${team.team}</div>`
          + `<div>median ${pctText(p.median)} [${pctText(p.lo)}, ${pctText(p.hi)}], 80 %</div>`
          + `<div>${p.n} comparable laps${p.n ? ` (L${p.firstLap}–L${p.lastLap})` : ''}${p.lowData ? `: under ${PACE_LOW_DATA_LAPS}, LOW DATA` : ''}</div>`))
          .on('dblclick', (event) => { event.stopPropagation(); setFocusDriver(d); });
      });

      // The team-mate gap: bold when decisive
      if (team.gap) {
        row.append('text').attr('class', 'fp-gap')
          .attr('x', width - 2).attr('y', cy).attr('dominant-baseline', 'middle').attr('text-anchor', 'end')
          .attr('fill', team.gap.verdict === 'decisive' ? TEXT_COLORS.primary : TEXT_COLORS.muted)
          .style('font-size', CHART_FONT.data).attr('font-weight', team.gap.verdict === 'decisive' ? 700 : 400)
          .text(gapLine(team.gap));
      }

      // Hover: the mark under the pointer, else the row's faster driver (the
      // store holds one highlighted driver); both marks of the row ringed here
      row.on('mousemove', (event) => {
        const el = event.target?.closest?.('[data-driver]');
        const d = el ? el.getAttribute('data-driver') : (team.gap?.faster || racing[0] || null);
        if (useF1Store.getState().highlightedDriver !== d) setHighlightedDriver(d);
        setHoverTeam(team.team);
        if (!el && tip) tip.style.display = 'none';
      })
        .on('mouseleave', () => {
          setHighlightedDriver(null);
          setHoverTeam(null);
          if (tip) tip.style.display = 'none';
        })
        .on('click', () => setSelectedDrivers([...team.drivers]));
    });

    probe.remove();
    return () => { if (tip) tip.style.display = 'none'; };
  }, [pace, pg.rows, width, height, axisH, answerOnly, selectedDrivers, focusDriver,
    setHighlightedDriver, setSelectedDrivers, setFocusDriver]);

  // Rings without a redraw: both marks of the hovered row, and the mark of
  // the driver highlighted in any view
  useEffect(() => {
    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll('.fp-row').each(function ring() {
      const rowOn = this.getAttribute('data-team') === hoverTeam;
      d3.select(this).selectAll('.fp-dot').attr('stroke', function stroke() {
        const driver = this.parentNode.getAttribute('data-driver');
        return rowOn || driver === highlightedDriver ? TEXT_COLORS.primary : markColor(getDriverColor(driver));
      });
    });
  }, [hoverTeam, highlightedDriver, pace, pg.rows, width, height]);

  const controls = answerOnly ? null : (
    <>
      {brushLapRange && (
        <button type="button" className="pos-chart-clear-brush fp-range" onClick={() => setBrushLapRange(null)} title="Clear the lap range (every view)">
          laps {brushLapRange[0]}–{brushLapRange[1]} ×
        </button>
      )}
      {fit.paged && (
        <>
          <button type="button" className="pos-chart-toggle fp-prev" onClick={() => setPage(Math.max(0, pg.page - 1))} disabled={pg.page === 0} aria-label="Previous teams">◀</button>
          <span className="fp-page" style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary }}>{pg.page + 1}/{pg.pages}</span>
          <button type="button" className="pos-chart-toggle fp-next" onClick={() => setPage(Math.min(pg.pages - 1, pg.page + 1))} disabled={pg.page >= pg.pages - 1} aria-label="Next teams">▶</button>
        </>
      )}
    </>
  );

  return (
    <Panel title="Race Pace" controls={controls} className="panel--dense">
      <div ref={rootRef} className="field-pace" style={{ position: 'relative', height: '100%', minHeight: 0 }}>
        {pace.comparable === 0 ? (
          <div className="loading-placeholder"><span>No comparable lap yet</span></div>
        ) : answerOnly ? (
          <div className="fp-answer" style={{ color: TEXT_COLORS.primary, fontSize: CHART_FONT.data, fontWeight: 700 }}>
            {paceAnswer(pace, pctText)}
          </div>
        ) : (
          <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        )}
        <div ref={tipRef} className="pos-chart-tooltip" style={{ display: 'none' }} />
      </div>
    </Panel>
  );
}
