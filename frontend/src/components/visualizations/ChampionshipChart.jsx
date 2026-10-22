import React, { useRef, useEffect, useMemo, useState } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  countryFlag, CHART_FONT, TEXT_COLORS, GRID_COLORS, STATUS_COLORS, FLAG_COLORS, SURFACES, tintedChip, withAlpha,
  textColor, contextColor, contextText, CONTEXT_MIX_LINES,
} from '../../utils/colors';
import { championshipStyles, championshipLegend, usedDashes, PREDICTION_DASH } from '../../utils/views/championshipChart';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

// Header toggle: active = white on a grey chip, inactive = muted (>= 4.5:1)
const toggleBtn = (active, activeColor = TEXT_COLORS.primary) => ({
  padding: '2px 8px', borderRadius: 4, border: '1px solid transparent',
  fontSize: CHART_FONT.label, fontWeight: 700, cursor: 'pointer',
  background: active ? 'rgba(255,255,255,0.15)' : 'transparent',
  borderColor: active ? activeColor : 'transparent',
  color: active ? activeColor : TEXT_COLORS.muted,
});

export default function ChampionshipChart() {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  // The box the chart fills: it lays out again at each new size (D4)
  const box = useChartBox(svgRef);

  const championshipData = useF1Store((s) => s.championshipData);
  const championshipLoading = useF1Store((s) => s.championshipLoading);
  const championshipError = useF1Store((s) => s.championshipError);
  const championshipView = useF1Store((s) => s.championshipView);
  const setChampionshipView = useF1Store((s) => s.setChampionshipView);
  const showPredictions = useF1Store((s) => s.showChampionshipPredictions);
  const togglePredictions = useF1Store((s) => s.toggleChampionshipPredictions);
  const fetchChampionship = useF1Store((s) => s.fetchChampionship);
  const year = useF1Store((s) => s.year);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const round = useF1Store((s) => s.round);

  // Track whether we already attempted a fetch for this year
  const [fetchedYear, setFetchedYear] = useState(null);

  // Fetch championship data on mount (only once per year)
  useEffect(() => {
    if (!championshipData && !championshipLoading && fetchedYear !== year) {
      setFetchedYear(year);
      fetchChampionship(year);
    }
  }, [year, championshipData, championshipLoading, fetchChampionship, fetchedYear]);

  const isDriverView = championshipView === 'drivers';

  // Get data based on view mode, filtered to current session round
  const chartEntries = useMemo(() => {
    if (!championshipData) return [];
    const entries = isDriverView ? championshipData.drivers : championshipData.constructors;
    if (!round) return entries; // no session loaded → show all

    // Filter progression to only show rounds up to the loaded session
    const filtered = entries.map((e) => {
      const prog = (e.progression || []).filter((p) => p.round <= round);
      const totalPoints = prog.length > 0 ? prog[prog.length - 1].cumulative : 0;
      return { ...e, progression: prog, totalPoints };
    }).filter((e) => e.progression.length > 0);

    // Re-sort by filtered totalPoints and reassign positions
    filtered.sort((a, b) => b.totalPoints - a.totalPoints);
    filtered.forEach((e, i) => { e.position = i + 1; });
    return filtered;
  }, [championshipData, isDriverView, round]);

  // The teammate dashes drawn (the legend names the third-driver dash-dot
  // only when a third driver is drawn)
  const legendDashes = useMemo(() => usedDashes(championshipStyles(chartEntries, isDriverView)), [chartEntries, isDriverView]);

  // D3 render
  useEffect(() => {
    if (!svgRef.current || !chartEntries || chartEntries.length === 0) return;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width: W, height: H } = chartSize(svgRef.current, box);
    if (W < 50 || H < 50) return;

    const margin = { top: 30, right: 100, bottom: 36, left: 50 };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    // Gather all rounds and max points
    const allRounds = [];
    const roundSet = new Set();
    chartEntries.forEach((e) => {
      (e.progression || []).forEach((p) => roundSet.add(p.round));
    });
    allRounds.push(...Array.from(roundSet).sort((a, b) => a - b));

    if (allRounds.length === 0) return;

    const totalRounds = championshipData.total_rounds || allRounds[allRounds.length - 1];
    const completedRounds = championshipData.completed_rounds || allRounds.length;

    let maxPts = d3.max(chartEntries, (e) =>
      d3.max(e.progression, (p) => p.cumulative)
    ) || 100;

    // If predictions are shown, extend maxPts
    if (showPredictions) {
      chartEntries.forEach((e) => {
        if (e.prediction) {
          maxPts = Math.max(maxPts, e.prediction.predicted_total);
        }
      });
    }

    // X scale: round numbers
    const xDomain = showPredictions && totalRounds > allRounds[allRounds.length - 1]
      ? [1, totalRounds]
      : [1, allRounds[allRounds.length - 1]];
    const x = d3.scaleLinear().domain(xDomain).range([0, innerW]);

    // Y scale: points
    const y = d3.scaleLinear().domain([0, maxPts * 1.08]).range([innerH, 0]);

    // Grid lines
    g.append('g')
      .attr('class', 'grid-y')
      .call(d3.axisLeft(y).ticks(6).tickSize(-innerW).tickFormat(''))
      .selectAll('line')
      .attr('stroke', GRID_COLORS.grid);
    g.select('.grid-y .domain').remove();

    // X axis
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(Math.min(allRounds.length, 24)).tickFormat(d3.format('d')))
      .attr('color', GRID_COLORS.rule)
      .selectAll('text')
      .style('font-size', CHART_FONT.data)
      .attr('fill', TEXT_COLORS.muted);

    // X axis label
    g.append('text')
      .attr('x', innerW / 2)
      .attr('y', innerH + 30)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label)
      .text('Round');

    // Y axis
    g.append('g')
      .call(d3.axisLeft(y).ticks(6))
      .attr('color', GRID_COLORS.rule)
      .selectAll('text')
      .style('font-size', CHART_FONT.data)
      .attr('fill', TEXT_COLORS.muted);

    // Y axis label
    g.append('text')
      .attr('transform', 'rotate(-90)')
      .attr('x', -innerH / 2)
      .attr('y', -38)
      .attr('text-anchor', 'middle')
      .attr('fill', TEXT_COLORS.muted)
      .style('font-size', CHART_FONT.label)
      .text('Points');

    // Completed rounds region boundary
    if (showPredictions && completedRounds < totalRounds) {
      const lastRound = allRounds[allRounds.length - 1] || completedRounds;
      g.append('line')
        .attr('x1', x(lastRound))
        .attr('x2', x(lastRound))
        .attr('y1', 0)
        .attr('y2', innerH)
        .attr('stroke', GRID_COLORS.rule)
        .attr('stroke-dasharray', '4 3');

      g.append('text')
        .attr('x', x(lastRound) + 4)
        .attr('y', 12)
        .attr('fill', TEXT_COLORS.muted)
        .style('font-size', CHART_FONT.label)
        .text('Prediction');
    }

    // Line generator
    const line = d3.line()
      .x((d) => x(d.round))
      .y((d) => y(d.cumulative))
      .curve(d3.curveMonotoneX);

    // Sort entries so higher-ranked are drawn on top
    const sortedEntries = [...chartEntries].sort((a, b) => b.position - a.position);
    // Colour, mark colour (>= 3:1), text colour and dash of every line (V3:
    // the second driver of a team tinted and dashed)
    const styles = championshipStyles(chartEntries, isDriverView);

    // Draw lines for each entry
    const linesGroup = g.append('g').attr('class', 'lines');

    sortedEntries.forEach((entry) => {
      if (!entry.progression || entry.progression.length === 0) return;
      const key = isDriverView ? entry.abbr : entry.team;
      const st = styles[key];
      const color = st.mark;
      const isHigh = isDriverView
        ? highlightedDriver === entry.abbr
        : false;
      const isSelected = isDriverView
        ? selectedDrivers.includes(entry.abbr)
        : false;
      const isDimmed = (selectedDrivers.length > 0 || highlightedDriver) && !isHigh && !isSelected;
      // focus + context (D7): full colour unless another line is highlighted or
      // selected; a context line, its dots and its label are mixed toward the
      // panel (contextColor: marks >= 2:1, the label >= 3:1), never faded by
      // opacity (stroke-opacity 0.15 read 1.08:1, the label at 0.3 1.48-2.22:1)
      const lineColor = isDimmed ? contextColor(color, SURFACES.panel, { mix: CONTEXT_MIX_LINES }) : color;
      const labelColor = isDimmed ? contextText(st.text, SURFACES.panel, CONTEXT_MIX_LINES) : st.text;
      const strokeW = isHigh ? 3 : isSelected ? 2.5 : 1.5;

      const entryG = linesGroup.append('g');

      // Main progression line
      entryG.append('path')
        .datum(entry.progression)
        .attr('fill', 'none')
        .attr('stroke', lineColor)
        .attr('stroke-width', strokeW)
        .attr('stroke-dasharray', st.dash)
        .attr('d', line);

      // Prediction dashed line
      if (showPredictions && entry.prediction && entry.progression.length > 0) {
        const lastPt = entry.progression[entry.progression.length - 1];
        const predLine = [
          { round: lastPt.round, cumulative: lastPt.cumulative },
          { round: totalRounds, cumulative: entry.prediction.predicted_total },
        ];
        entryG.append('path')
          .datum(predLine)
          .attr('fill', 'none')
          .attr('stroke', lineColor)
          .attr('stroke-width', strokeW)
          .attr('stroke-opacity', isDimmed ? 1 : 0.8)
          .attr('stroke-linecap', 'round')
          .attr('stroke-dasharray', PREDICTION_DASH)
          .attr('d', line);
      }

      // Dots at each round
      entryG.selectAll('.dot')
        .data(entry.progression)
        .join('circle')
        .attr('cx', (d) => x(d.round))
        .attr('cy', (d) => y(d.cumulative))
        .attr('r', isHigh ? 4 : 2.5)
        .attr('fill', lineColor)
        .attr('stroke', isHigh ? TEXT_COLORS.primary : 'none')
        .attr('stroke-width', isHigh ? 1 : 0);

      // End label (right side)
      const lastPt = entry.progression[entry.progression.length - 1];
      if (lastPt) {
        const labelX = showPredictions && entry.prediction
          ? x(totalRounds) + 6
          : x(lastPt.round) + 6;
        const labelY = showPredictions && entry.prediction
          ? y(entry.prediction.predicted_total)
          : y(lastPt.cumulative);

        entryG.append('text')
          .attr('x', labelX)
          .attr('y', labelY)
          .attr('dy', '0.35em')
          .attr('fill', labelColor)
          .style('font-size', CHART_FONT.data)
          .style('font-weight', 700)
          .style('font-family', 'var(--font-primary)')
          .text(isDriverView ? entry.abbr : entry.team.slice(0, 10));
      }

      // Invisible wider hit area for interaction
      entryG.append('path')
        .datum(entry.progression)
        .attr('fill', 'none')
        .attr('stroke', 'transparent')
        .attr('stroke-width', 12)
        .attr('d', line)
        .style('cursor', 'pointer')
        .on('mouseenter', () => {
          if (isDriverView) setHighlightedDriver(entry.abbr);
        })
        .on('mouseleave', () => {
          if (isDriverView) setHighlightedDriver(null);
        })
        .on('click', () => {
          if (isDriverView) toggleDriver(entry.abbr);
        });
    });

    // Tooltip on hover
    const tooltipG = g.append('g').style('display', 'none');
    const tooltipLine = tooltipG.append('line')
      .attr('y1', 0).attr('y2', innerH)
      .attr('stroke', GRID_COLORS.rule)
      .attr('stroke-dasharray', '3 2');

    // Invisible overlay for tooltip tracking
    g.append('rect')
      .attr('width', innerW)
      .attr('height', innerH)
      .attr('fill', 'transparent')
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event);
        const roundNum = Math.round(x.invert(mx));
        if (roundNum < 1 || roundNum > xDomain[1]) {
          tooltipG.style('display', 'none');
          return;
        }
        tooltipG.style('display', null);
        tooltipLine.attr('x1', x(roundNum)).attr('x2', x(roundNum));

        // Update the external tooltip div
        if (tooltipRef.current) {
          const entries = chartEntries
            .map((e) => {
              const pt = e.progression.find((p) => p.round === roundNum);
              if (!pt) return null;
              return {
                key: isDriverView ? e.abbr : e.team,
                color: styles[isDriverView ? e.abbr : e.team]?.mark || TEXT_COLORS.muted,
                points: pt.cumulative,
                roundPts: pt.points,
                position: pt.position,
                flag: isDriverView ? countryFlag(e.countryCode) : '',
              };
            })
            .filter(Boolean)
            .sort((a, b) => a.position - b.position);

          tooltipRef.current.style.display = entries.length ? 'block' : 'none';
          tooltipRef.current.innerHTML = `
            <div style="font-weight:700;margin-bottom:4px;color:${TEXT_COLORS.secondary};font-size:${CHART_FONT.label};">Round ${roundNum}</div>
            ${entries.slice(0, 10).map((e) => `
              <div style="display:flex;align-items:center;gap:4px;margin-bottom:1px;font-size:${CHART_FONT.data};">
                <span style="color:${TEXT_COLORS.muted};width:16px;text-align:right;">${e.position}.</span>
                <span style="width:8px;height:8px;border-radius:50%;background:${e.color};flex-shrink:0;"></span>
                ${e.flag ? `<span>${e.flag}</span>` : ''}
                <span style="color:${TEXT_COLORS.primary};font-weight:600;">${e.key}</span>
                <span style="color:${TEXT_COLORS.secondary};margin-left:auto;">${e.points} pts</span>
                <span style="color:${TEXT_COLORS.muted};">(+${e.roundPts})</span>
              </div>
            `).join('')}
          `;
        }
      })
      .on('mouseleave', () => {
        tooltipG.style('display', 'none');
        if (tooltipRef.current) tooltipRef.current.style.display = 'none';
      });

  }, [chartEntries, championshipData, isDriverView, showPredictions, highlightedDriver, selectedDrivers, setHighlightedDriver, toggleDriver, box.width, box.height]);

  // Controls
  const controls = (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <button
        onClick={() => setChampionshipView('drivers')}
        style={toggleBtn(isDriverView)}
      >
        DRIVERS
      </button>
      <button
        onClick={() => setChampionshipView('constructors')}
        style={toggleBtn(!isDriverView)}
      >
        CONSTRUCTORS
      </button>
      <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.12)' }} />
      <button
        onClick={togglePredictions}
        style={toggleBtn(showPredictions, STATUS_COLORS.predicted)}
      >
        Predictions
      </button>
      <button
        onClick={() => { setFetchedYear(null); fetchChampionship(year); }}
        style={{
          padding: '2px 6px',
          borderRadius: 4,
          border: 'none',
          fontSize: CHART_FONT.label,
          cursor: 'pointer',
          background: 'transparent',
          color: TEXT_COLORS.muted,
        }}
        title="Refresh championship data"
      >
        ↻
      </button>
    </div>
  );

  return (
    <Panel
      title={`Championship ${championshipData?.year || year}`}
      controls={controls}
    >
      <div style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Marks of the chart (lines are labelled at their end) */}
        {chartEntries.length > 0 && <Legend items={championshipLegend({ isDriverView, showPredictions, dashes: legendDashes })} />}
        {championshipLoading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(15,15,25,0.8)', zIndex: 10,
            color: TEXT_COLORS.secondary, fontSize: '12px',
          }}>
            Loading championship data...
          </div>
        )}
        {!championshipData && !championshipLoading && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 8,
            color: TEXT_COLORS.muted, fontSize: '12px',
          }}>
            {championshipError && (
              <span style={{ color: textColor(FLAG_COLORS.red, SURFACES.panel), fontSize: CHART_FONT.data, maxWidth: 300, textAlign: 'center' }}>
                {championshipError}
              </span>
            )}
            <button
              onClick={() => { setFetchedYear(null); fetchChampionship(year); }}
              style={{
                padding: '8px 16px', borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.06)',
                color: TEXT_COLORS.primary, cursor: 'pointer', fontSize: '12px',
              }}
            >
              {championshipError ? 'Retry' : `Load ${year} Championship`}
            </button>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <svg ref={svgRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
        {/* Missing rounds banner */}
        {championshipData?.missing_rounds?.length > 0 && (
          <div style={{
            position: 'absolute', bottom: 4, left: 8, right: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: tintedChip(STATUS_COLORS.predicted, 0.12).background, borderRadius: 4, padding: '3px 8px',
            fontSize: CHART_FONT.label, color: tintedChip(STATUS_COLORS.predicted, 0.12).color,
          }}>
            <span>
              {championshipData.completed_rounds}/{championshipData.total_rounds} rounds loaded
              (missing: {championshipData.missing_rounds.join(', ')})
            </span>
            <button
              onClick={() => { setFetchedYear(null); fetchChampionship(year, true); }}
              style={{
                padding: '1px 6px', borderRadius: 3,
                border: `1px solid ${STATUS_COLORS.predicted}`,
                background: withAlpha(STATUS_COLORS.predicted, 0.15),
                color: tintedChip(STATUS_COLORS.predicted, 0.15).color, cursor: 'pointer', fontSize: CHART_FONT.label, fontWeight: 600,
              }}
            >
              Load All (slow)
            </button>
          </div>
        )}
        <div
          ref={tooltipRef}
          style={{
            display: 'none',
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'rgba(15,15,25,0.92)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
            padding: '8px 10px',
            backdropFilter: 'blur(12px)',
            minWidth: 160,
            pointerEvents: 'none',
            zIndex: 20,
          }}
        />
      </div>
    </Panel>
  );
}
