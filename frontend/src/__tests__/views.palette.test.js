// The views of the colours lane, read
// as source: no semantic colour literal (the palette module is the single
// source), no red / green pair, no literal font size under the floors, no CSS
// function in an SVG presentation attribute (dropped by the browser), a
// legend in every view, contrastText on every team / compound badge.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = [
  'LapTimeChart', 'TimingTower', 'RacePaceGrid', 'SectorsPanel', 'Leaderboard', 'LapDeltaChart',
  'ChampionshipChart', 'TrackMap', 'StrategyTimeline', 'PositionByLap', 'TireDegradation',
  'ConsistencyPanel', 'DriverComparePanel', 'CircleOfDoom', 'TelemetryStrip', 'TyreManagement',
  'TyreHealth', 'RaceSituationMap', 'PCABiplot',
].map((n) => `components/visualizations/${n}.jsx`);
const UI = ['PitWallSectorPanel', 'DriverMFDCard', 'FocusDriverWidget', 'RaceControlFeed', 'Legend']
  .map((n) => `components/ui/${n}.jsx`);
const HELPERS = [
  'lapTimeChart', 'timingTower', 'racePaceGrid', 'sectorsPanel', 'leaderboard', 'lapDeltaChart', 'trackMap',
  'positionByLap', 'telemetryStrip', 'raceSituationMap', 'pcaBiplot', 'pitWallSectorPanel', 'driverMFDCard',
  'focusDriverWidget', 'championshipChart', 'teamLegend',
].map((n) => `utils/views/${n}.js`);
const FILES = [...VIEWS, ...UI, ...HELPERS];
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
// code without comments and HTML entities
const code = (rel) => read(rel).split(/\r?\n/)
  .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
  .map((l) => l.replace(/\/\/.*$/, '').replace(/&#\d+;/g, ''))
  .join('\n');

function rgbOf(lit) {
  let m = lit.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = lit.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  return m ? [+m[1], +m[2], +m[3]] : null;
}
// a colour that carries a meaning: not a grey (any alpha), not a dark surface
function semantic(rgb) {
  const mx = Math.max(...rgb);
  const mn = Math.min(...rgb);
  return mx - mn > 12 && (mx + mn) / 510 >= 0.2;
}

describe('no semantic colour literal and no red / green pair in the views (V1, V2, target 5)', () => {
  it.each(FILES)('%s', (rel) => {
    const lits = [...code(rel).matchAll(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)/g)]
      .map((m) => m[0]).filter((l) => { const rgb = rgbOf(l); return rgb && semantic(rgb); });
    expect(lits, rel).toEqual([]);
  });
});

describe('type floors in the views (V13 target 3)', () => {
  // CircleOfDoom keeps its ring-label layout (7 px when crowded): the floors
  // break it (circleOfDoom.view / .viewport tests fail with them)
  it.each(FILES)('%s: no literal font size under 11 px', (rel) => {
    const src = code(rel);
    const small = [];
    const pats = [
      /fontSize\s*:\s*['"`]?([\d.]+)(?:px)?['"`]?\s*[,}\n]/g,
      /fontSize\s*=\s*\{\s*([\d.]+)\s*\}/g,
      /fontSize\s*=\s*["']([\d.]+)(?:px)?["']/g,
      /\.(?:attr|style)\(\s*['"]font-size['"]\s*,\s*['"`]?([\d.]+)(?:px)?['"`]?\s*\)/g,
      /font-size\s*:\s*([\d.]+)px/g,
    ];
    for (const re of pats) for (const m of src.matchAll(re)) if (Number(m[1]) < 11) small.push(m[0]);
    expect(small, rel).toEqual([]);
  });

  it.each(FILES)('%s: no CSS function in an SVG presentation attribute', (rel) => {
    const bad = [...code(rel).matchAll(/\.attr\(\s*['"](font-size|fill|stroke)['"]\s*,\s*(CHART_FONT\.\w+|['"`][^'"`]*(var\(|max\(|clamp\()[^'"`]*['"`])/g)]
      .map((m) => m[0]);
    expect(bad, rel).toEqual([]);
  });
});

describe('every view has a legend of its encodings (V4)', () => {
  // view -> how its legend is drawn
  const LEGENDS = {
    LapTimeChart: /timingSheetLegend\(|forecastChartLegend\(/,
    TimingTower: /timingTowerLegend\(/,
    RacePaceGrid: /paceLegend\(/,
    SectorsPanel: /sectorsLegend\(/,
    Leaderboard: /TOWER_LEGEND/,
    LapDeltaChart: /lapDeltaLegend\(/,
    ChampionshipChart: /championshipLegend\(/,
    ChampionshipStandings: /championshipStandingsLegend\(/,
    TrackMap: /channelLegend\(|SECTOR_COLORS\[s\]/,
    StrategyTimeline: /legendItems/,
    PositionByLap: /legendItems/,
    TireDegradation: /legendItems/,
    ConsistencyPanel: /CONSISTENCY_LEGEND/,
    DriverComparePanel: /<Legend/,
    CircleOfDoom: /cod-legend/,
    TelemetryStrip: /<Legend/,
    TyreManagement: /legendItems/,
    TyreHealth: /legendItems/,
    RaceSituationMap: /teamPairLegend\(/,
    PCABiplot: /colorLegend|shapeLegend/,
  };
  it.each(Object.entries(LEGENDS))('%s', (view, re) => {
    const src = read(`components/visualizations/${view}.jsx`);
    expect(src, view).toMatch(re);
    expect(src, view).toMatch(/<Legend\b|cod-legend|drawLegend\(/);
  });
});

describe('team / compound badges choose their text by contrast (findings 2026-10-14)', () => {
  const BADGES = [
    'components/visualizations/TimingTower.jsx', 'components/visualizations/LapTimeChart.jsx',
    'components/visualizations/RacePaceGrid.jsx', 'components/visualizations/Leaderboard.jsx',
    'components/visualizations/TrackMap.jsx', 'components/visualizations/PositionByLap.jsx',
    'components/visualizations/TyreHealth.jsx', 'components/visualizations/TyreManagement.jsx',
    'components/visualizations/RaceSituationMap.jsx', 'components/visualizations/ConsistencyPanel.jsx',
    'components/visualizations/TelemetryStrip.jsx', 'components/ui/FocusDriverWidget.jsx',
    'components/ui/DriverMFDCard.jsx', 'components/ui/PitWallSectorPanel.jsx', 'components/ui/Legend.jsx',
  ];
  it.each(BADGES)('%s uses contrastText, never a fixed white / black on a team or compound colour', (rel) => {
    const src = code(rel);
    expect(src).toMatch(/contrastText\(/);
    // the old rule: white unless MEDIUM / HARD
    expect(src).not.toMatch(/=== 'HARD' \|\| [^?]*\? '#000' : '#fff'|=== 'MEDIUM' \|\| [^?]*\? '#000' : '#fff'/);
  });
});

describe('every view that colours a driver by his team draws the teammate rule', () => {
  // driver colour through getDriverColor (team colour, teammate tint) or the
  // championship / team-legend helpers built on the same rule
  const TEAM_COLOURED = [
    'LapTimeChart', 'RacePaceGrid', 'SectorsPanel', 'Leaderboard', 'LapDeltaChart', 'TrackMap', 'StrategyTimeline',
    'PositionByLap', 'TireDegradation', 'ConsistencyPanel', 'DriverComparePanel', 'CircleOfDoom', 'TelemetryStrip',
    'TyreManagement', 'TyreHealth', 'RaceSituationMap',
  ].map((n) => `components/visualizations/${n}.jsx`)
    .concat(['components/ui/PitWallSectorPanel.jsx', 'components/ui/DriverMFDCard.jsx', 'components/ui/FocusDriverWidget.jsx',
      'utils/views/timingTower.js']);
  it.each(TEAM_COLOURED)('%s draws drivers with getDriverColor', (rel) => {
    const src = code(rel);
    expect(src).toMatch(/getDriverColor\(/);
    // never the bare team colour for a driver's mark
    expect(src).not.toMatch(/getTeamColor\(\s*(d|entry|driver|abbr|row)\.(team|TeamName)/);
  });
  // views that draw a driver as a line: the teammate's line is dashed
  const LINES = ['LapDeltaChart', 'DriverComparePanel', 'TelemetryStrip', 'ChampionshipChart']
    .map((n) => `components/visualizations/${n}.jsx`).concat(['components/ui/DriverMFDCard.jsx']);
  it.each(LINES)('%s dashes the teammate line', (rel) => {
    expect(code(rel)).toMatch(/getDriverDash\(|championshipStyles\(|\.dash\b/);
  });
  // the standings bars use the championship chart's rule (same tab): never
  // the backend's raw TeamColor, which teammates share
  it('ChampionshipStandings colours its bars with championshipStyles, never entry.teamColor', () => {
    const src = code('components/visualizations/ChampionshipStandings.jsx');
    expect(src).toMatch(/championshipStyles\(/);
    expect(src).not.toMatch(/(markColor|textColor)\(\s*entry\.teamColor/);
    expect(src).not.toMatch(/fill-opacity', opacity \* 0\.7/);
  });
  it('the command bar / palette team dots come from the palette (getDriverColor), not FastF1 TeamColor', () => {
    expect(code('components/CommandPalette/commandRegistry.js')).toMatch(/teamColor: driverDot\(d\.Abbreviation\)/);
    for (const rel of ['components/CommandPalette/CommandBar.jsx', 'components/CommandPalette/CommandPalette.jsx']) {
      expect(code(rel)).not.toMatch(/`#\$\{cmd\.teamColor\}`/);
    }
  });
});

// A CSS fill / stroke beats an SVG presentation attribute, so a
// CSS rule on a class D3 colours decides the colour drawn: the Track Map
// sectors were drawn in CSS colours unlike their legend, and the Position
// Tracker's pit-window label in the "better" blue instead of the pit purple
describe('no CSS colour overrides the semantic colour D3 sets on these marks', () => {
  const cssRules = async () => {
    const { parseCss } = await import('./helpers/layoutCss.js');
    return ['styles/dashboard.css', 'styles/visualizations.css', 'styles/components.css', 'styles/base.css']
      .flatMap((f) => parseCss(read(f)).map((r) => ({ ...r, f })));
  };
  it('no CSS rule sets fill or stroke on the Track Map sector paths (.sector-1/2/3)', async () => {
    const hits = (await cssRules()).filter((r) => /\.sector-[123]\b/.test(r.selector)
      && r.decls.some((d) => d.prop === 'fill' || d.prop === 'stroke'));
    expect(hits.map((r) => `${r.f} ${r.selector}`)).toEqual([]);
    const tm = code('components/visualizations/TrackMap.jsx');
    expect(tm).toMatch(/\.attr\('stroke', SECTOR_COLORS\[sector\] \|\| TRACK_COLORS\.surface\)/);
    expect(tm).toMatch(/const SECTOR_OPACITY = \{ on: 1, off: 0\.1 \};/);
  });
  it('the pit-window label is filled with the pit-window text colour (CSS and JS agree)', async () => {
    const rule = (await cssRules()).filter((r) => r.selector === '.pos-undercut-label').pop();
    expect(rule.decls.find((d) => d.prop === 'fill').value).toBe('var(--color-pit-window-text)');
    expect(code('components/visualizations/PositionByLap.jsx')).toMatch(/\.attr\('fill', UI_COLORS\.pitWindowText\)/);
    const tokens = read('styles/tokens.css');
    expect(tokens).toMatch(/--color-pit-window-text: #B56FF8;/);
  });
});

// The Driver Comparison drew the two tyre strategies as a div bar
// chart of percentage widths; it now draws the D3 stint strips of the other
// strategy views. The standings bars carry the teammate dash where it
// shows (a line inside the bar in its contrast text colour).
describe('the remaining div chart is D3, the standings dash reads on its bar', () => {
  it('DriverComparePanel tyre strategy: drawStintStrips with a lap axis, no div segments', () => {
    const src = code('components/visualizations/DriverComparePanel.jsx');
    expect(src).toMatch(/drawStintStrips\(svgRef\.current, \{/);
    expect(src).toMatch(/axis: \{ ticks: lapTicks\(totalLaps\)/);
    expect(src).not.toMatch(/compare-panel__stint-segment|width: `\$\{Math\.max\(width, 2\)\}%`/);
  });
  it('ChampionshipStandings: the teammate dash is a line in contrastText inside the bar, with a legend', () => {
    const src = code('components/visualizations/ChampionshipStandings.jsx');
    expect(src).toMatch(/\.attr\('class', 'standings-teammate-dash'\)/);
    expect(src).toMatch(/\.attr\('stroke', contrastText\(color\)\)/);
    expect(src).toMatch(/\.attr\('stroke-dasharray', style\.dash\)/);
    expect(src).toMatch(/<Legend items=\{legendItems\} \/>/);
  });
});
