import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  countryFlag, CHART_FONT, TEXT_COLORS, GRID_COLORS, textColor, markColor, contrastText, contextColor, SURFACES,
} from '../../utils/colors';
import {
  championshipStyles, championshipStandingsLegend, championshipTooltip,
} from '../../utils/views/championshipChart';
import Panel from '../ui/Panel';
import Legend from '../ui/Legend';
import { useChartBox, chartSize } from '../../utils/views/chartBox';

export default function ChampionshipStandings() {
  const svgRef = useRef(null);
  // The box the chart fills: it lays out again at each new size (D4)
  const box = useChartBox(svgRef);

  const championshipData = useF1Store((s) => s.championshipData);
  const championshipView = useF1Store((s) => s.championshipView);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const round = useF1Store((s) => s.round);
  // The session on screen (its line-up and round): the earlier team of a
  // driver who changed team, in his tooltip (D11)
  const sessionDrivers = useF1Store((s) => s.drivers);
  const loadedYear = useF1Store((s) => s.loadedYear);
  const loadedRound = useF1Store((s) => s.loadedRound);

  const isDriverView = championshipView === 'drivers';

  const entries = useMemo(() => {
    if (!championshipData) return [];
    const list = isDriverView ? championshipData.drivers : championshipData.constructors;

    if (!round) {
      // No session loaded → show all, sorted by position
      return [...list].sort((a, b) => a.position - b.position);
    }

    // Filter progression to current round, recompute totalPoints and positions
    const filtered = list.map((e) => {
      const prog = (e.progression || []).filter((p) => p.round <= round);
      const totalPoints = prog.length > 0 ? prog[prog.length - 1].cumulative : 0;
      // seasonProgression: the team of the entry is the latest round's (D11)
      return { ...e, progression: prog, seasonProgression: e.progression, totalPoints };
    }).filter((e) => e.progression.length > 0);

    filtered.sort((a, b) => b.totalPoints - a.totalPoints);
    filtered.forEach((e, i) => { e.position = i + 1; });
    return filtered;
  }, [championshipData, isDriverView, round]);

  // Colour and dash of every bar (V3): the championship chart's rule, so a
  // driver has the same colour in both views of the tab and two (or three)
  // drivers of a team never share a bar colour (palette team colour, then the
  // teammate tints; never the backend's raw TeamColor)
  const styles = useMemo(() => championshipStyles(entries, isDriverView), [entries, isDriverView]);
  // Legend (V4 r2): every team's bar colour (first driver and teammate tint)
  // and the teammate patterns drawn inside the bars
  const legendItems = useMemo(
    () => championshipStandingsLegend(entries, styles, isDriverView, SURFACES.panel),
    [entries, styles, isDriverView],
  );

  // Driver → {round, team} in the session on screen, for the tooltips (same season only)
  const sessionTeams = useMemo(() => {
    const out = {};
    if (!championshipData || Number(loadedYear) !== Number(championshipData.year) || !loadedRound) return out;
    for (const d of sessionDrivers || []) {
      if (d?.Abbreviation && d?.TeamName) out[d.Abbreviation] = { round: Number(loadedRound), team: d.TeamName };
    }
    return out;
  }, [championshipData, loadedYear, loadedRound, sessionDrivers]);

  useEffect(() => {
    if (!svgRef.current || entries.length === 0) return;

    // the box the chart fills, kept up to date (utils/views/chartBox.js useChartBox, D4)
    const { width: W, height: H } = chartSize(svgRef.current, box);
    if (W < 50 || H < 50) return;

    const margin = { top: 8, right: 54, bottom: 20, left: isDriverView ? 80 : 120 };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio', 'xMidYMid meet');

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const maxPts = d3.max(entries, (e) => e.totalPoints) || 100;
    const leaderPts = entries[0]?.totalPoints || 0;

    // Scales
    const x = d3.scaleLinear().domain([0, maxPts * 1.05]).range([0, innerW]);

    const barHeight = Math.min(24, Math.max(10, (innerH - (entries.length - 1) * 2) / entries.length));
    const barGap = 2;
    const totalBarHeight = entries.length * (barHeight + barGap) - barGap;
    const yOffset = Math.max(0, (innerH - totalBarHeight) / 2);

    // X axis (bottom)
    g.append('g')
      .attr('transform', `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat(d3.format('d')))
      .attr('color', GRID_COLORS.axis)
      .selectAll('text')
      .style('font-size', CHART_FONT.data)
      .attr('fill', TEXT_COLORS.secondary);

    // X axis label
    g.append('text').attr('text-anchor', 'middle')
      .attr('x', innerW / 2).attr('y', innerH + margin.bottom - 2)
      .attr('fill', TEXT_COLORS.muted).style('font-size', CHART_FONT.label)
      .attr('font-weight', 600).text('Points');

    // Grid lines
    g.append('g')
      .call(d3.axisBottom(x).ticks(6).tickSize(innerH).tickFormat(''))
      .attr('color', GRID_COLORS.grid)
      .select('.domain').remove();

    // Bars
    entries.forEach((entry, i) => {
      const key = isDriverView ? entry.abbr : entry.team;
      const style = styles[key] || { color: TEXT_COLORS.muted, dash: null };
      // Bars >= 3:1 on the panel (markColor, drawn opaque), names >= 4.5:1 (textColor)
      const color = markColor(style.color, SURFACES.panel);
      const nameColor = textColor(style.color, SURFACES.panel);
      const isHigh = isDriverView ? highlightedDriver === entry.abbr : false;
      const isSelected = isDriverView ? selectedDrivers.includes(entry.abbr) : false;
      // Focus + context (D7): a context bar is mixed toward the panel
      // (contextColor, >= 2:1, never an opacity); its text turns to the muted
      // text colour (>= 4.5:1, COLOR_ENCODING.md)
      const isDimmed = (selectedDrivers.length > 0 || highlightedDriver) && !isHigh && !isSelected;
      const barFill = isDimmed ? contextColor(color, SURFACES.panel) : color;
      const yPos = yOffset + i * (barHeight + barGap);

      const barG = g.append('g').style('cursor', 'pointer');

      // Bar background (full width, subtle)
      barG.append('rect')
        .attr('x', 0)
        .attr('y', yPos)
        .attr('width', innerW)
        .attr('height', barHeight)
        .attr('fill', 'rgba(255,255,255,0.02)')
        .attr('rx', 3);

      // Bar
      const barW = Math.max(2, x(entry.totalPoints));
      barG.append('rect')
        .attr('x', 0)
        .attr('y', yPos)
        .attr('width', barW)
        .attr('height', barHeight)
        .attr('fill', barFill)
        .attr('rx', 3)
        // the hovered bar: a white outline
        .attr('stroke', isHigh ? TEXT_COLORS.primary : 'none')
        .attr('stroke-width', isHigh ? 1 : 0);

      // The teammate's bar carries the chart's teammate dash as a line along
      // its middle, in the text colour of the bar (contrastText, >= 4.5:1 on
      // it): the pattern reads on the bar (V3 r2: a dashed outline in the
      // bar's own colour was invisible); on a context bar, mixed toward the
      // bar (>= 2:1 on it, D7)
      if (style.dash && barW > 8) {
        const dash = barG.append('line')
          .attr('class', 'standings-teammate-dash')
          .attr('x1', 3).attr('x2', barW - 3)
          .attr('y1', yPos + barHeight / 2).attr('y2', yPos + barHeight / 2)
          .attr('stroke', contrastText(color))
          .attr('stroke-width', 2)
          .attr('stroke-dasharray', style.dash);
        if (isDimmed) dash.attr('stroke', contextColor(contrastText(barFill), barFill));
      }

      // Points label at end of bar
      barG.append('text')
        .attr('x', barW + 5)
        .attr('y', yPos + barHeight / 2)
        .attr('dy', '0.35em')
        .attr('fill', isDimmed ? TEXT_COLORS.muted : TEXT_COLORS.secondary)
        .style('font-size', CHART_FONT.data)
        .style('font-weight', 600)
        .style('font-family', "'Formula1', 'Titillium Web', sans-serif")
        .text(entry.totalPoints);

      // Left label: position + flag + name
      const flag = isDriverView ? countryFlag(entry.countryCode) : '';
      const label = isDriverView ? entry.abbr : entry.team.length > 14 ? entry.team.slice(0, 12) + '..' : entry.team;
      const gap = leaderPts - entry.totalPoints;
      const gapStr = i > 0 && gap > 0 ? ` (-${gap})` : '';

      barG.append('text')
        .attr('x', -6)
        .attr('y', yPos + barHeight / 2)
        .attr('dy', '0.35em')
        .attr('text-anchor', 'end')
        .attr('fill', isDimmed ? TEXT_COLORS.muted : nameColor)
        .style('font-size', CHART_FONT.data)
        .style('font-weight', 700)
        .style('font-family', "'Formula1', 'Titillium Web', sans-serif")
        .text(`${entry.position}. ${flag} ${label}${gapStr}`);

      // Invisible hit area
      barG.append('rect')
        .attr('x', -margin.left)
        .attr('y', yPos)
        .attr('width', margin.left + innerW + margin.right)
        .attr('height', barHeight)
        .attr('fill', 'transparent')
        // tooltip: points, team and, for a driver who changed team, his
        // earlier team and why the bar has the latest team's colour (D11)
        .call((hit) => hit.append('title')
          .text(championshipTooltip(entry, isDriverView, isDriverView ? sessionTeams[entry.abbr] : null)))
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

  }, [entries, styles, isDriverView, highlightedDriver, selectedDrivers, setHighlightedDriver, toggleDriver, sessionTeams, box.width, box.height]);

  if (!championshipData) {
    return (
      <Panel title="Standings">
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: TEXT_COLORS.muted, fontSize: CHART_FONT.data,
        }}>
          No championship data loaded
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={`Standings ${championshipData.year || ''}`}>
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Marks of the bars: team colours, teammate patterns */}
        {legendItems.length > 0 && <Legend items={legendItems} />}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </Panel>
  );
}
