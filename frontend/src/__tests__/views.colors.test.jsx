// The colour helpers of the views: the legends hold every
// colour the views draw (with the glyph or dash drawn next to it), the
// teammate rule reaches every team-coloured view, the diverging pair carries
// its sign, and the Legend swatches are drawn like the marks.
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  STATUS_COLORS, STATUS_GLYPHS, DIVERGING, TEAM_COLORS, TYRE_COLORS, TEXT_COLORS, SURFACES,
  setSessionDriverColors, getDriverColor, getDriverDash, markColor, teammateTint, contrastText, contrastRatio,
  TIMING_BANDS, timingBandColor,
} from '../utils/colors.js';
import { deltaHatchCss } from '../utils/views/deltaHatch.js';
import { timingSheetLegend, TIME_COLORS } from '../utils/views/lapTimeChart.js';
import { timingTowerLegend } from '../utils/views/timingTower.js';
import { sectorsLegend } from '../utils/views/sectorsPanel.js';
import { paceLegend, PACE_CELL_STYLES, PACE_CELL_GLYPHS } from '../utils/views/racePaceGrid.js';
import {
  pitWallLegend, pitWallTimingCue, pitWallDeltaColor, PITWALL_BANDS,
} from '../utils/views/pitWallSectorPanel.js';
import { lapDeltaLegend } from '../utils/views/lapDeltaChart.js';
import {
  championshipStyles, championshipLegend, championshipStandingsLegend, usedDashes, PREDICTION_DASH,
} from '../utils/views/championshipChart.js';
import { teamPairLegend } from '../utils/views/teamLegend.js';
import Legend from '../components/ui/Legend.jsx';

const LINEUP = [
  { Abbreviation: 'NOR', TeamName: 'McLaren', DriverNumber: '4' },
  { Abbreviation: 'PIA', TeamName: 'McLaren', DriverNumber: '81' },
  { Abbreviation: 'HAM', TeamName: 'Mercedes', DriverNumber: '44' },
  { Abbreviation: 'RUS', TeamName: 'Mercedes', DriverNumber: '63' },
];
beforeEach(() => setSessionDriverColors(LINEUP));

describe('one status map, every status colour in the legend with its glyph', () => {
  it('timing sheet: the colours of TIME_COLORS that carry a meaning are legend rows with ◆ ● PIT', () => {
    const legend = timingSheetLegend({ forecast: true });
    const colors = legend.map((i) => i.color);
    for (const c of [TIME_COLORS.overall_best, TIME_COLORS.personal_best, TIME_COLORS.pit]) expect(colors).toContain(c);
    expect(legend.find((i) => i.color === STATUS_COLORS.overallBest).glyph).toBe(STATUS_GLYPHS.overallBest);
    expect(legend.find((i) => i.color === STATUS_COLORS.personalBest).glyph).toBe(STATUS_GLYPHS.personalBest);
    // the forecast rows: the diverging pair with its sign
    expect(legend.find((i) => i.color === DIVERGING.better).glyph).toBe('−');
    expect(legend.find((i) => i.color === DIVERGING.worse).glyph).toBe('+');
  });

  it('timing tower, sectors, pit wall: legends name each status colour once, glyph on bests and pit', () => {
    for (const legend of [timingTowerLegend(), sectorsLegend('live'), pitWallLegend()]) {
      const ob = legend.find((i) => i.color === STATUS_COLORS.overallBest);
      expect(ob.glyph).toBe(STATUS_GLYPHS.overallBest);
      expect(legend.find((i) => i.color === STATUS_COLORS.personalBest).glyph).toBe(STATUS_GLYPHS.personalBest);
    }
    expect(timingTowerLegend().find((i) => i.color === STATUS_COLORS.pit).glyph).toContain(STATUS_GLYPHS.pit);
  });

  it('pace grid: every cell colour that means something is a legend row; bests and pit cells carry a glyph', () => {
    const legendColors = new Set(paceLegend().map((i) => i.color));
    for (const key of ['session-best', 'personal-best', 'good', 'slower', 'very-slow', 'pit-in', 'pit-out', 'live-chrono']) {
      const cell = PACE_CELL_STYLES[key];
      const meant = [STATUS_COLORS.overallBest, STATUS_COLORS.personalBest, STATUS_COLORS.fast, STATUS_COLORS.slower,
        STATUS_COLORS.muchSlower, STATUS_COLORS.pit, STATUS_COLORS.running];
      // the cell text is the status colour or its lift on its own tint
      expect(meant.some((c) => legendColors.has(c)), key).toBe(true);
      expect(cell.color, key).toBeTruthy();
    }
    expect(PACE_CELL_GLYPHS['session-best']).toBe(STATUS_GLYPHS.overallBest);
    expect(PACE_CELL_GLYPHS['pit-in']).toBe(STATUS_GLYPHS.pit);
    expect(PACE_CELL_GLYPHS['pit-out']).toBe(STATUS_GLYPHS.pitOut);
    // the text of a tinted cell keeps 4.5:1 on its tint over the panel
    for (const key of ['session-best', 'personal-best', 'pit-in', 'pit-out']) {
      const { background, color } = PACE_CELL_STYLES[key];
      expect(contrastRatio(color, background), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('pit wall: the timing cue and the delta colour (blue at or under the PB, orange beyond the band)', () => {
    expect(pitWallTimingCue(30.0, 30.0, 29.0)).toEqual({ color: STATUS_COLORS.personalBest, glyph: STATUS_GLYPHS.personalBest });
    expect(pitWallTimingCue(29.0, 30.0, 29.0)).toEqual({ color: STATUS_COLORS.overallBest, glyph: STATUS_GLYPHS.overallBest });
    expect(pitWallTimingCue(31.5, 30.0, 29.0).color).toBe(STATUS_COLORS.muchSlower);
    expect(pitWallDeltaColor(-0.1)).toBe(DIVERGING.better);
    // orange only beyond the much-slower band, the threshold of the timing scale's orange
    expect(pitWallDeltaColor(PITWALL_BANDS.sector.slower + 0.1)).toBe(TEXT_COLORS.muted);
    expect(pitWallDeltaColor(PITWALL_BANDS.sector.muchSlower + 0.1)).toBe(DIVERGING.worse);
    expect(pitWallDeltaColor(0.1)).toBe(TEXT_COLORS.muted);
  });

  it('one set of timing bands, one ordered scale (normal, yellow, orange) in the tower, the pit wall and the pace grid', () => {
    const order = [STATUS_COLORS.normal, STATUS_COLORS.slower, STATUS_COLORS.muchSlower];
    for (const kind of ['sector', 'lap']) {
      const seq = [0, 0.1, 0.3, 0.31, 0.5, 0.51, 0.99, 1.01, 1.99, 2.01, 5].map((d) => order.indexOf(timingBandColor(d, kind)));
      expect(seq.every((v) => v >= 0)).toBe(true);
      // never back to a lower colour as the delta grows
      for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
      // the pit wall panel uses the same bands
      for (const d of [0.2, 0.6, 1.5, 2.5]) {
        expect(pitWallTimingCue(30 + d, 30, 29, kind).color).toBe(timingBandColor(d, kind));
      }
    }
    expect(PITWALL_BANDS).toBe(TIMING_BANDS);
    expect(timingBandColor(TIMING_BANDS.sector.slower + 0.01, 'sector')).toBe(STATUS_COLORS.slower);
    expect(timingBandColor(TIMING_BANDS.lap.muchSlower + 0.01, 'lap')).toBe(STATUS_COLORS.muchSlower);
    // the legends say the same thresholds
    const towerRows = timingTowerLegend().filter((i) => [STATUS_COLORS.slower, STATUS_COLORS.muchSlower].includes(i.color));
    expect(towerRows.map((i) => i.label)).toEqual([
      `+${TIMING_BANDS.sector.slower}/${TIMING_BANDS.lap.slower} s off PB`,
      `+${TIMING_BANDS.sector.muchSlower}/${TIMING_BANDS.lap.muchSlower} s off`,
    ]);
    expect(paceLegend().find((i) => i.color === STATUS_COLORS.slower).label).toContain(`+${TIMING_BANDS.lap.slower} s`);
    expect(paceLegend().find((i) => i.color === STATUS_COLORS.muchSlower).label).toContain(`+${TIMING_BANDS.lap.muchSlower} s`);
  });

  it('the delta areas are hatched in the diverging pair, rising for behind, falling for ahead', () => {
    expect(deltaHatchCss('worse')).toContain(DIVERGING.worse);
    expect(deltaHatchCss('better')).toContain(DIVERGING.better);
    expect(deltaHatchCss('worse')).toMatch(/^repeating-linear-gradient\(-45deg/);
    expect(deltaHatchCss('better')).toMatch(/^repeating-linear-gradient\(45deg/);
    const legend = lapDeltaLegend('NOR', ['PIA']);
    expect(legend.find((i) => i.color === DIVERGING.worse).fill).toBe(deltaHatchCss('worse'));
    expect(legend.find((i) => i.color === DIVERGING.better).fill).toBe(deltaHatchCss('better'));
  });
});

describe('the teammate rule in every team-coloured view', () => {
  it('session line-up: the second driver tinted and dashed (lines of lap delta, telemetry, compare)', () => {
    expect(getDriverColor('PIA')).toBe(teammateTint(TEAM_COLORS.McLaren));
    expect(getDriverDash('NOR')).toBeNull();
    expect(getDriverDash('PIA')).toBe('6,3');
    const legend = lapDeltaLegend('NOR', ['PIA', 'HAM', 'RUS']);
    const pia = legend.find((i) => i.label === 'PIA');
    const rus = legend.find((i) => i.label === 'RUS');
    expect(pia.dash).toBe('6,3');
    expect(pia.color).toBe(markColor(teammateTint(TEAM_COLORS.McLaren)));
    expect(rus.dash).toBe('6,3');
    expect(legend.find((i) => i.label === 'HAM').dash).toBeNull();
    // the shaded areas: the diverging pair, each with its sign in the label
    expect(legend.find((i) => i.color === DIVERGING.worse).label).toMatch(/^\+/);
    expect(legend.find((i) => i.color === DIVERGING.better).label).toMatch(/^−/);
  });

  it('championship: teammates never share a style; constructors are solid team colours', () => {
    const entries = [
      { abbr: 'NOR', team: 'McLaren', position: 2 }, { abbr: 'PIA', team: 'McLaren', position: 3 },
      { abbr: 'HAM', team: 'Mercedes', position: 6 }, { abbr: 'RUS', team: 'Mercedes', position: 4 },
    ];
    const s = championshipStyles(entries, true);
    expect(s.NOR.color).toBe(TEAM_COLORS.McLaren);
    expect(s.NOR.dash).toBeNull();
    expect(s.PIA.color).toBe(teammateTint(TEAM_COLORS.McLaren));
    expect(s.PIA.dash).toBe('6,3');
    // ordered as the session's teammate index (HAM 44 before RUS 63), not by points
    expect(s.HAM.dash).toBeNull();
    expect(s.RUS.dash).toBe('6,3');
    for (const st of Object.values(s)) {
      expect(contrastRatio(st.mark, SURFACES.raised)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(st.text, SURFACES.raised)).toBeGreaterThanOrEqual(4.5);
    }
    const c = championshipStyles([{ team: 'McLaren' }, { team: 'Mercedes' }], false);
    expect(c.McLaren.dash).toBeNull();
    // the dotted prediction never reads as the teammate dash
    expect(PREDICTION_DASH).not.toBe('6,3');
    expect(championshipLegend({ isDriverView: true, showPredictions: true }).map((i) => i.dash))
      .toEqual(expect.arrayContaining(['6,3', PREDICTION_DASH]));
  });

  // A reserve (BEA, Haas) sorted ahead of the session's second driver
  // (HUL) and took his style in the Championship tab; the championship now
  // gives every driver of the loaded session exactly his session style
  it('championship: a driver of the loaded session keeps his session style; reserves take the free places', () => {
    setSessionDriverColors([
      { Abbreviation: 'MAG', TeamName: 'Haas F1 Team', DriverNumber: '20' },
      { Abbreviation: 'HUL', TeamName: 'Haas F1 Team', DriverNumber: '27' },
      { Abbreviation: 'GAS', TeamName: 'Alpine', DriverNumber: '10' },
      { Abbreviation: 'OCO', TeamName: 'Alpine', DriverNumber: '31' },
    ]);
    const entries = [
      { abbr: 'HUL', team: 'Haas F1 Team', position: 11 }, { abbr: 'MAG', team: 'Haas F1 Team', position: 15 },
      { abbr: 'BEA', team: 'Haas F1 Team', position: 18 }, { abbr: 'GAS', team: 'Alpine', position: 10 },
      { abbr: 'OCO', team: 'Alpine', position: 14 }, { abbr: 'DOO', team: 'Alpine', position: 24 },
    ];
    const s = championshipStyles(entries, true);
    for (const abbr of ['MAG', 'HUL', 'GAS', 'OCO']) {
      expect(s[abbr].color, abbr).toBe(getDriverColor(abbr));
      expect(s[abbr].dash, abbr).toBe(getDriverDash(abbr));
    }
    expect(s.BEA.dash).toBe('8,3,2,3');
    expect(s.DOO.dash).toBe('8,3,2,3');
    expect(new Set(Object.values(s).map((x) => `${x.color}|${x.dash}`)).size).toBe(entries.length);
    // the dash-dot of a third driver has its legend row, and is not the dotted projection
    expect(championshipLegend({ isDriverView: true, showPredictions: true, dashes: usedDashes(s) }).map((i) => i.dash))
      .toEqual(expect.arrayContaining(['6,3', '8,3,2,3', PREDICTION_DASH]));
    expect(PREDICTION_DASH).not.toBe('8,3,2,3');
  });

  // The standings bars had no legend
  it('championship standings: one legend row per team (bar colours as drawn) and the teammate patterns', () => {
    const entries = [
      { abbr: 'NOR', team: 'McLaren', position: 1 }, { abbr: 'PIA', team: 'McLaren', position: 2 },
      { abbr: 'HAM', team: 'Mercedes', position: 3 }, { abbr: 'RUS', team: 'Mercedes', position: 4 },
    ];
    const s = championshipStyles(entries, true);
    const items = championshipStandingsLegend(entries, s, true, SURFACES.panel);
    expect(items.filter((i) => i.shape === 'pair').map((i) => i.label)).toEqual(['McLaren', 'Mercedes']);
    const mcl = items.find((i) => i.label === 'McLaren');
    expect(mcl.color).toBe(markColor(s.NOR.color, SURFACES.panel));
    expect(mcl.color2).toBe(markColor(s.PIA.color, SURFACES.panel));
    expect(items.find((i) => i.dash === '6,3')).toBeTruthy();
    const ctor = [{ team: 'McLaren' }, { team: 'Mercedes' }];
    const cons = championshipStandingsLegend(ctor, championshipStyles(ctor, false), false);
    expect(cons.map((i) => i.shape)).toEqual(['square', 'square']);
  });

  it('team legends show both drivers\' colours (race situation map)', () => {
    const items = teamPairLegend(LINEUP);
    expect(items.map((i) => i.label)).toEqual(['McLaren', 'Mercedes']);
    expect(items[0].color).toBe(markColor(TEAM_COLORS.McLaren));
    expect(items[0].color2).toBe(markColor(teammateTint(TEAM_COLORS.McLaren)));
  });
});

describe('Legend swatches are drawn like the marks', () => {
  it('badge: the glyph in contrastText; line: the dash; pair: both colours', () => {
    const html = renderToString(React.createElement(Legend, {
      items: [
        { label: 'Soft', color: TYRE_COLORS.SOFT, glyph: 'S', shape: 'badge' },
        { label: 'PIA', color: '#123456', shape: 'line', dash: '6,3' },
        { label: 'McLaren', color: '#FF8000', color2: '#FFB973', shape: 'pair' },
        { label: 'Session best', color: STATUS_COLORS.overallBest, glyph: '◆', shape: 'glyph' },
      ],
    }));
    const text = contrastText(TYRE_COLORS.SOFT);
    expect(html).toMatch(new RegExp(`background:${TYRE_COLORS.SOFT};color:${text}`, 'i'));
    expect(html).toContain('stroke-dasharray="6,3"');
    expect(html).toMatch(/#FF8000[\s\S]*#FFB973/i);
    expect(html).toContain('◆');
    // the legend text is the CSS token size, never under its floor
    expect(html).toMatch(/font-size:max\(10px, var\(--font-size-label, 10px\)\)/);
  });
});
