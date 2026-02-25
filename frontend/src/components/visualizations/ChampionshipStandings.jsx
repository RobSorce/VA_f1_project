import React, { useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import { countryFlag } from '../../utils/colors';
import Panel from '../ui/Panel';

export default function ChampionshipStandings() {
  const svgRef = useRef(null);

  const championshipData = useF1Store((s) => s.championshipData);
  const championshipView = useF1Store((s) => s.championshipView);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const toggleDriver = useF1Store((s) => s.toggleDriver);
  const round = useF1Store((s) => s.round);

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
      return { ...e, progression: prog, totalPoints };
    }).filter((e) => e.progression.length > 0);

    filtered.sort((a, b) => b.totalPoints - a.totalPoints);
    filtered.forEach((e, i) => { e.position = i + 1; });
    return filtered;
  }, [championshipData, isDriverView, round]);

  useEffect(() => {
    if (!svgRef.current || entries.length === 0) return;

    const container = svgRef.current.parentElement;
    const { width: W, height: H } = container.getBoundingClientRect();
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
      .attr('color', 'rgba(255,255,255,0.4)')
      .selectAll('text')
      .style('font-size', '8px')
      .attr('fill', 'rgba(255,255,255,0.5)');

    // Grid lines
    g.append('g')
      .call(d3.axisBottom(x).ticks(6).tickSize(innerH).tickFormat(''))
      .attr('color', 'rgba(255,255,255,0.04)')
      .select('.domain').remove();

    // Bars
    entries.forEach((entry, i) => {
      const key = isDriverView ? entry.abbr : entry.team;
      const color = entry.teamColor || '#888';
      const isHigh = isDriverView ? highlightedDriver === entry.abbr : false;
      const isSelected = isDriverView ? selectedDrivers.includes(entry.abbr) : false;
      const isDimmed = (selectedDrivers.length > 0 || highlightedDriver) && !isHigh && !isSelected;
      const opacity = isDimmed ? 0.15 : isHigh ? 1 : 0.85;
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
        .attr('fill', color)
        .attr('fill-opacity', opacity * 0.7)
        .attr('rx', 3)
        .attr('stroke', isHigh ? '#fff' : 'none')
        .attr('stroke-width', isHigh ? 1 : 0);

      // Points label at end of bar
      barG.append('text')
        .attr('x', barW + 5)
        .attr('y', yPos + barHeight / 2)
        .attr('dy', '0.35em')
        .attr('fill', 'rgba(255,255,255,0.7)')
        .attr('fill-opacity', isDimmed ? 0.3 : 1)
        .style('font-size', '9px')
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
        .attr('fill', color)
        .attr('fill-opacity', isDimmed ? 0.3 : 0.9)
        .style('font-size', '9px')
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

  }, [entries, isDriverView, highlightedDriver, selectedDrivers, setHighlightedDriver, toggleDriver]);

  if (!championshipData) {
    return (
      <Panel title="Standings">
        <div style={{
          width: '100%', height: '100%', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: 'rgba(255,255,255,0.4)', fontSize: '11px',
        }}>
          No championship data loaded
        </div>
      </Panel>
    );
  }

  return (
    <Panel title={`Standings ${championshipData.year || ''}`}>
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </Panel>
  );
}
