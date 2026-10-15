// F8 / D7, focus + context: a de-emphasised (context) item keeps its text at
// >= 3:1 and its marks at >= 2:1 against its background, and is de-emphasised
// by mixing its colour toward that background (contextColor / contextText of
// utils/colors.js), never by an opacity on its text.
//  - the helpers: floors, opaque colours, a real de-emphasis;
//  - Race Pace Grid (mounted, a selection on): context headers and cells read
//    >= 3:1 (they read 1.9-2.6:1 at opacity 0.35 before V13), no opacity;
//  - Championship standings (mounted, a selection on): context bars and the
//    teammate dash >= 2:1 (1.1-1.6:1 at fill-opacity 0.2), names >= 3:1, no
//    opacity anywhere;
//  - Lap Times forecast rows: team bar and tyre badge >= 2:1, the badge letter
//    >= 4.5:1 on its badge (1.8-2.7:1 at opacity 0.5);
//  - the sources of the lane's views: every opacity left is listed with why.
// The Circle of Doom's context leaders and labels: fade.circle.test.jsx.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const C = await import('../utils/colors.js');
const {
  contextColor, contextText, contrastRatio, compositeOver, CONTEXT_FLOOR, SURFACES, TEXT_COLORS, TEAM_COLORS,
  TYRE_COLORS, STATUS_COLORS, markColor, withAlpha, setSessionDriverColors, getDriverColor,
} = C;
const { forecastRowMarks } = await import('../utils/views/lapTimeChart.js');
const { championshipStyles } = await import('../utils/views/championshipChart.js');
const { default: RacePaceGrid } = await import('../components/visualizations/RacePaceGrid.jsx');
const { default: ChampionshipStandings } = await import('../components/visualizations/ChampionshipStandings.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const INITIAL = useF1Store.getState();
const HEX = /^#[0-9A-F]{6}$/;

async function mount(Component, width, height) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(Component)); });
  return {
    host,
    async rerender() { await act(async () => { root.render(React.createElement(Component)); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}
const all = (el, sel) => [...el.querySelectorAll(sel)];
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

// ── A synthetic race: 6 drivers of 3 teams, 12 laps ──────────────────────
const LINEUP = [
  ['NOR', 'McLaren', 4], ['PIA', 'McLaren', 81], ['VER', 'Red Bull Racing', 1],
  ['PER', 'Red Bull Racing', 11], ['LEC', 'Ferrari', 16], ['SAI', 'Ferrari', 55],
];
function syntheticRace(laps = 12) {
  const lap_times = [];
  LINEUP.forEach(([d], i) => {
    for (let n = 1; n <= laps; n++) {
      const start = 1000 + 90 * (n - 1) + i * 0.8;
      const t = 90 + 0.05 * n + 0.15 * i + (n === 7 ? 1.2 : 0);
      lap_times.push({
        Driver: d, LapNumber: n, LapStartTime: start, Time: start + t, LapTimeSeconds: t,
        Sector1Time: t * 0.3, Sector2Time: t * 0.4, Sector3Time: t * 0.3,
        Position: i + 1, Compound: 'MEDIUM', TyreLife: n, Stint: 1, TrackStatus: '1',
      });
    }
  });
  return {
    lap_times, race_results: [], track_status: [], weather_data: [],
    driver_info: LINEUP.map(([a, team, num]) => ({ Abbreviation: a, TeamName: team, DriverNumber: String(num) })),
  };
}

describe('contextColor / contextText (utils/colors.js)', () => {
  const surfaces = Object.entries(SURFACES);
  const marks = [...Object.values(TEAM_COLORS).map((c) => markColor(c)), ...Object.values(TYRE_COLORS),
    ...Object.values(STATUS_COLORS), 'rgba(255,255,255,0.28)'];
  const texts = [...Object.values(TEXT_COLORS), ...Object.values(TEAM_COLORS), ...Object.values(STATUS_COLORS)];

  it('marks: >= 2:1 on every dark surface, opaque, and fainter than the colour itself', () => {
    for (const [name, s] of surfaces) {
      for (const c of marks) {
        const ctx = contextColor(c, s);
        expect(ctx, `${c} on ${name}`).toMatch(HEX);
        const r = contrastRatio(ctx, s);
        expect(r, `${c} on ${name}`).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
        const own = contrastRatio(c, s);
        if (own > CONTEXT_FLOOR.mark + 0.1) expect(r, `${c} on ${name} is de-emphasised`).toBeLessThan(own);
      }
    }
  });

  it('text: >= 3:1 on every dark surface, opaque, and fainter than the colour itself', () => {
    for (const [name, s] of surfaces) {
      for (const c of texts) {
        const ctx = contextText(c, s);
        expect(ctx, `${c} on ${name}`).toMatch(HEX);
        const r = contrastRatio(ctx, s);
        expect(r, `${c} on ${name}`).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
        const own = contrastRatio(c, s);
        if (own > CONTEXT_FLOOR.text + 0.1) expect(r, `${c} on ${name} is de-emphasised`).toBeLessThan(own);
      }
    }
  });

  it('a colour already under the floor is lifted to it, and the floors are the decision\'s', () => {
    expect(CONTEXT_FLOOR).toEqual({ text: 3, mark: 2 });
    // the leader grey at the former opacity 0.3: 1.25:1, lifted to 2:1
    const faint = withAlpha('#FFFFFF', 0.084);
    expect(contrastRatio(faint, SURFACES.panel)).toBeLessThan(1.5);
    expect(contrastRatio(contextColor(faint, SURFACES.panel), SURFACES.panel)).toBeGreaterThanOrEqual(2);
    // opacity is what the rule replaces: the same colour at opacity 0.35 fails it
    expect(contrastRatio(withAlpha(TEXT_COLORS.muted, 0.35), SURFACES.panel)).toBeLessThan(3);
  });
});

describe('Race Pace Grid: context headers and cells (mounted, VER selected)', () => {
  it('every context header and cell reads >= 3:1 and none is drawn at an opacity below 1', async () => {
    const race = syntheticRace();
    setSessionDriverColors(race.driver_info);
    useF1Store.setState({
      ...INITIAL, sessionData: race, drivers: race.driver_info, sessionType: 'R', loadedSessionType: 'R',
      maxLap: 12, totalRaceLaps: 12, currentLap: 12, totalFrames: 0, selectedDrivers: ['VER'],
    });
    const v = await mount(RacePaceGrid, 900, 500);
    const heads = all(v.host, 'th').filter((th) => LINEUP.some(([a]) => text(th).startsWith(a)));
    expect(heads.length).toBe(LINEUP.length);
    let context = 0;
    for (const th of heads) {
      const abbr = text(th).slice(0, 3);
      expect(th.style.opacity ?? '', abbr).toBe('');
      const r = contrastRatio(th.style.color, compositeOver(th.style.background, SURFACES.panel));
      expect(r, abbr).toBeGreaterThanOrEqual(abbr === 'VER' ? 4.5 : CONTEXT_FLOOR.text);
      if (abbr !== 'VER') context += 1;
    }
    expect(context).toBe(LINEUP.length - 1);
    const cells = all(v.host, 'td').filter((td) => text(td) && td.style.color && td.style.color !== 'transparent');
    expect(cells.length).toBeGreaterThan(20);
    for (const td of cells) {
      expect(td.style.opacity ?? '').toBe('');
      const bg = td.style.background && td.style.background !== 'transparent'
        ? compositeOver(td.style.background, SURFACES.panel) : SURFACES.panel;
      expect(contrastRatio(td.style.color, bg), text(td)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
    }
    await v.unmount();
    useF1Store.setState({ ...INITIAL });
  });
});

describe('Championship standings: context bars, dashes and names (mounted, NOR selected)', () => {
  const champ = {
    year: 2024,
    drivers: LINEUP.map(([abbr, team], i) => ({
      abbr, name: abbr, team, teamColor: '', countryCode: '', position: i + 1, totalPoints: 100 - 12 * i,
      progression: [{ round: 1, points: 25 - i, cumulative: 50 - 6 * i }, { round: 2, points: 25 - i, cumulative: 100 - 12 * i }],
    })),
    constructors: [],
  };

  it('no opacity, bars >= 2:1 on the panel, the teammate dash >= 2:1 on its bar, names >= 3:1', async () => {
    setSessionDriverColors(syntheticRace().driver_info);
    useF1Store.setState({
      ...INITIAL, championshipData: champ, championshipView: 'drivers', round: 2, selectedDrivers: ['NOR'],
    });
    const v = await mount(ChampionshipStandings, 700, 360);
    // the chart (the Panel's export icon and the legend swatches are svgs too)
    const svg = all(v.host, 'svg').find((s) => s.querySelector('line.standings-teammate-dash'));
    expect(svg).toBeTruthy();
    for (const el of all(svg, '*')) {
      for (const a of ['opacity', 'fill-opacity', 'stroke-opacity']) {
        const val = el.getAttribute(a);
        expect(val == null || Number(val) === 1, `${el.localName} ${a}=${val}`).toBe(true);
      }
    }
    // the bars: the rects in a team colour (not the transparent hit area or the 2 % track)
    const bars = all(svg, 'rect').filter((r) => /^#[0-9A-F]{6}$/i.test(r.getAttribute('fill') || ''));
    expect(bars.length).toBe(LINEUP.length);
    const fills = bars.map((b) => b.getAttribute('fill'));
    for (const f of fills) expect(contrastRatio(f, SURFACES.panel), f).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
    // NOR's bar keeps its full colour, the others are mixed toward the panel
    // (bars drawn in standings order, the LINEUP order here)
    const styles = championshipStyles(champ.drivers, true);
    LINEUP.forEach(([abbr], i) => {
      const full = markColor(styles[abbr].color, SURFACES.panel);
      expect(fills[i], abbr).toBe(abbr === 'NOR' ? full : contextColor(full, SURFACES.panel));
      if (abbr !== 'NOR') expect(contrastRatio(fills[i], SURFACES.panel), abbr).toBeLessThan(contrastRatio(full, SURFACES.panel));
    });
    expect(styles.NOR.color).toBe(getDriverColor('NOR'));
    const dashes = all(svg, 'line.standings-teammate-dash');
    expect(dashes.length).toBe(3); // PIA, PER, SAI
    for (const d of dashes) {
      const bar = bars.find((b) => Math.abs(Number(b.getAttribute('y')) + Number(b.getAttribute('height')) / 2 - Number(d.getAttribute('y1'))) < 0.01);
      expect(bar).toBeTruthy();
      expect(contrastRatio(d.getAttribute('stroke'), bar.getAttribute('fill'))).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
    }
    for (const t of all(svg, 'text').filter((x) => /\d+\. /.test(text(x)))) {
      expect(contrastRatio(t.getAttribute('fill'), SURFACES.panel), text(t)).toBeGreaterThanOrEqual(CONTEXT_FLOOR.text);
    }
    await v.unmount();
    useF1Store.setState({ ...INITIAL });
  });
});

describe('Lap Times forecast rows (forecastRowMarks)', () => {
  it('team bar and tyre badge >= 2:1 on the row, the letter >= 4.5:1 on its badge, for every compound', () => {
    const row = compositeOver(withAlpha(STATUS_COLORS.predicted, 0.03), SURFACES.panel);
    for (const team of Object.values(TEAM_COLORS)) {
      for (const compound of Object.keys(TYRE_COLORS)) {
        const m = forecastRowMarks(team, compound);
        expect(contrastRatio(m.bar, row), team).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
        expect(contrastRatio(m.badge, row), compound).toBeGreaterThanOrEqual(CONTEXT_FLOOR.mark);
        expect(contrastRatio(m.badgeText, m.badge), compound).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the sheet draws them without the former opacity 0.5', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/visualizations/LapTimeChart.jsx'), 'utf8');
    expect(src).toMatch(/forecastRowMarks\(focusRow\.color, focusRow\.compound\)/);
    expect(src).not.toMatch(/background: markColor\(focusRow\.color\), opacity: 0\.5/);
    expect(src).not.toMatch(/justifyContent: 'center', gap: 3, opacity: 0\.5/);
  });
});

describe('every opacity left in the views of focus + context has a reason', () => {
  // [file, pattern of the line, why it is not a faded context text or mark]
  const ALLOWED = [
    ['CircleOfDoom.jsx', /\.style\('opacity', [01]\)/, 'tooltip shown / hidden'],
    ['CircleOfDoom.jsx', /kind === 'lapped'.*fillOpacity="0\.45"/, 'legend swatch of the lapped-car encoding'],
    ['CircleOfDoom.jsx', /fillOpacity=\{c\.lappedByLeader \? 0\.45 : 1\}/, 'lapped by the leader: an encoding with its legend row, not context'],
    ['LapTimeChart.jsx', /teamLogo\} alt="" style=.*opacity: 0\.5/, 'decorative logo image (alt="") of a forecast row'],
    ['LapTimeChart.jsx', /\.attr\('opacity', 0\.18\)/, 'forecast uncertainty band (an area, not context)'],
    ['LapTimeChart.jsx', /tooltip\.style\.opacity = '[01]'/, 'tooltip shown / hidden'],
    ['LapTimeChart.jsx', /pointerEvents: 'none', opacity: 0,/, 'tooltip hidden until hovered'],
    // Phase 9c repair (verifier r1, F8): the views below drew context text and
    // marks at an opacity; they now mix the colour (contextColor / contextText)
    ['ChampionshipChart.jsx', /\.attr\('stroke-opacity', isDimmed \? 1 : 0\.8\)/, 'the dashed projection of a focus line (a context one is mixed, at 1)'],
    ['PositionByLap.jsx', /\.attr\('opacity', op\)/, 'op: 0.8 / 0.85 for lines that are not context (>= 3:1); a context line is mixed, op 1'],
    ['StrategyTimeline.jsx', /\.style\('opacity', [01]\)/, 'tooltip shown / hidden'],
    ['LapDeltaChart.jsx', /\.style\('opacity', [01]\)/, 'tooltip shown / hidden'],
    ['TelemetryStrip.jsx', /lapOpacity/, 'laps mode: a comparison lap\'s order (dashed, labelled L<n>), not context; its label is mixed (traceLabelColor)'],
    ['TelemetryStrip.jsx', /const opacity = traceOpacity\(t\);|\.attr\('opacity', opacity\)|^function traceOpacity|return t\.isDimmed \? 1 :/, 'traceOpacity: 1 for a context trace (its colour mixed), lapOpacity otherwise'],
    ['TrackMap.jsx', /SECTOR_OPACITY/, 'a sector the user toggled off (a control state, not context)'],
    ['TrackMap.jsx', /\{ radius: \d, opacity: 0\.\d+ \}|opacity: TRAIL_CONFIG|\.attr\('opacity', \(d\) => d\.opacity\)/, 'the motion trail of a car (older positions fainter: an encoding of time)'],
    ['TrackMap.jsx', /\.attr\('opacity', (visible|showCorners) \? 1 : 0\)/, 'a layer shown / hidden'],
    ['TrackMap.jsx', /sectorLayer\.attr\('opacity', (null|0\.2)\)/, 'the sector colours under the channel overlay that replaces them'],
    ['TrackMap.jsx', /\.attr\('opacity', 0\.95\)/, 'the channel overlay ramp'],
    ['TrackMap.jsx', /\.attr\('opacity', isNeutral \? 0\.6 : 1\)/, 'the track border under a green flag (the chrome of the track, not a data item)'],
    ['TrackMap.jsx', /attr\('class', 'car-glow'\).*\.attr\('opacity', 0\)|merged\.select\('\.car-glow'\)|\.attr\('opacity', \(d\) => \{/, 'the glow of a focused / hovered / selected car (an emphasis halo; 0 for the others)'],
    ['TrackMap.jsx', /\.attr\('opacity', null\);/, 'the car dot at full opacity (a context dot is mixed: carDotFill)'],
    ['TrackMap.jsx', /\.style\('opacity', 1\);|tooltip\.classed\('visible', false\)\.style\('opacity', 0\)/, 'tooltip shown / hidden'],
    ['TrackMap.jsx', /\.attr\('opacity', 0\.15\);/, 'the glow around the focus driver\'s progress marker (a halo, the dot itself opaque)'],
    ['PCABiplot.jsx', /\.style\('opacity', [01]\)/, 'tooltip shown / hidden'],
    // Phase 9c repair r2 (verifier r2, F8): the Race Situation map faded its
    // context codes, dots, tyre badges and letters by opacity (1.16-2.81:1)
    ['RaceSituationMap.jsx', /let opacity, strokeW;|opacity = 0\.(2|06) \+ progress|\.attr\('stroke-opacity', opacity\)|const dotOpacity = |\.attr\('opacity', dotOpacity\)|\.attr\('opacity', showFull \? 0\.6 : 0\.25\)/,
      'the trail of a driver who is not context: older positions fainter (an encoding of time); a context driver has no trail'],
    ['RaceSituationMap.jsx', /\.attr\('opacity', 1\)/, 'full opacity (a context mark is mixed: contextDot / contextBadge)'],
    ['RaceSituationMap.jsx', /\.style\('opacity', [01]\);?$/, 'tooltip shown / hidden'],
    ['RaceSituationMap.jsx', /\.attr\('opacity', 0\)$|exit\.transition\(t\)\.attr\('opacity', 0\)\.remove\(\)/, 'a label entering (faded in to 1) or leaving the map'],
  ];
  const FILES = ['RacePaceGrid.jsx', 'CircleOfDoom.jsx', 'LapTimeChart.jsx', 'StrategyAnalysis.jsx',
    'PCAAnalysisPanel.jsx', 'ChampionshipStandings.jsx',
    'ChampionshipChart.jsx', 'PositionByLap.jsx', 'StrategyTimeline.jsx', 'LapDeltaChart.jsx', 'TelemetryStrip.jsx',
    'TrackMap.jsx', 'SectorsPanel.jsx', 'SectorsBestChart.jsx', 'ConsistencyPanel.jsx', 'PCABiplot.jsx',
    'RaceSituationMap.jsx'];

  it('the CSS of these views fades no context item by opacity', () => {
    const viz = fs.readFileSync(path.join(SRC, 'styles/visualizations.css'), 'utf8');
    // a selection on the PCA biplot: the points outside it are mixed in PCABiplot.jsx
    expect(viz).not.toMatch(/\n\.pca-point\.dimmed \{[^}]*opacity/);
    expect(fs.readFileSync(path.join(SRC, 'components/visualizations/PCABiplot.jsx'), 'utf8')).toMatch(/isContextPoint\(d\) \? contextColor\(f, SURFACES\.panel\) : f/);
  });
  it.each(FILES)('%s', (file) => {
    const lines = fs.readFileSync(path.join(SRC, 'components/visualizations', file), 'utf8').split(/\r?\n/);
    const offenders = [];
    lines.forEach((raw, i) => {
      const line = raw.replace(/\/\/.*$/, '').replace(/transition: '[^']*'/g, '');
      if (!/opacity/i.test(line)) return;
      if (!ALLOWED.some(([f, re]) => f === file && re.test(line))) offenders.push(`${file}:${i + 1}: ${raw.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
