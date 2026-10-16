// Phase 9 cleanup: dead code gone, t-SNE leftovers reduced to commented
// aliases, help texts that match the code (V9, V10, V11 and the minor
// backlog: DRS for 2026, the Shift+P label, the MOCK chip, stale App.jsx
// summaries, the Race Situation wording).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_HELP } from '../utils/chartHelp.js';
import { FIRST_SEASON_WITHOUT_DRS } from '../utils/seasons.js';
import { UNDERCUT_SWEEP_LAPS, STINT_FEASIBLE_QUANTILE } from '../utils/undercut.js';
import { STATUS_GLYPHS } from '../utils/colors.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const all = (entry) => [entry.summary, ...(entry.howToRead || []), ...(entry.limitations || [])].join(' ');

/** Every .js / .jsx file under src except the tests. */
function sources(dir = SRC) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') out.push(...sources(p)); } else if (/\.jsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('V10 and the dead view helper: deleted, nothing imports them', () => {
  it('StrategyBriefing.jsx and utils/views/consistencyPanel.js are gone and not imported', () => {
    expect(fs.existsSync(path.join(SRC, 'components/visualizations/StrategyBriefing.jsx'))).toBe(false);
    expect(fs.existsSync(path.join(SRC, 'utils/views/consistencyPanel.js'))).toBe(false);
    const offenders = sources().filter((f) => /StrategyBriefing|views\/consistencyPanel|consistencyStats/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('V9: t-SNE leftovers', () => {
  it('the files of this lane name no t-SNE; elsewhere only the commented alias and two comments (requested to other lanes)', () => {
    for (const f of ['App.jsx', 'utils/chartHelp.js', 'components/ui/SessionMenu.jsx',
      'components/ShortcutCheatsheet/ShortcutCheatsheet.jsx', 'hooks/useKeyboardShortcuts.js']) {
      expect(read(f), f).not.toMatch(/t-sne|tsne/i);
    }
    const hits = [];
    for (const f of sources()) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/t-sne|tsne/i.test(line)) hits.push(`${path.relative(SRC, f).split(path.sep).join('/')}:${i + 1}: ${line.trim()}`);
      });
    }
    console.log(`t-SNE mentions left in src:\n  ${hits.join('\n  ')}`);
    for (const h of hits) {
      const alias = /^utils\/apiClient\.js:/.test(h) && /alias|Former name|analyzeTSNESelection = analyzePCASelection/.test(h);
      // comments citing the deleted backend module (PCAAnalysisPanel / insightsGenerator: other lanes)
      const pendingComment = /^(components\/visualizations\/PCAAnalysisPanel\.jsx|utils\/insightsGenerator\.js):/.test(h)
        && /tsne_compute\.py/.test(h);
      expect(alias || pendingComment, h).toBe(true);
    }
  });
});

describe('help texts that match the code', () => {
  it('DRS: the help and the cheatsheet say there is no DRS from 2026', () => {
    expect(FIRST_SEASON_WITHOUT_DRS).toBe(2026);
    const track = all(CHART_HELP.trackmap);
    expect(track).toContain(`seasons before ${FIRST_SEASON_WITHOUT_DRS}`);
    expect(CHART_HELP.trackmap.summary.length).toBeLessThanOrEqual(140);
    const sheet = read('components/ShortcutCheatsheet/ShortcutCheatsheet.jsx');
    expect(sheet).toContain('Toggle DRS Zones (seasons before ${FIRST_SEASON_WITHOUT_DRS})');
  });

  it('Shift+P is the forecast of the focus driver, not "Run LSTM Prediction"', () => {
    const sheet = read('components/ShortcutCheatsheet/ShortcutCheatsheet.jsx');
    expect(sheet).not.toMatch(/Run LSTM Prediction/);
    // the label of lead decision D9 (phase 9c)
    expect(sheet).toMatch(/keys: \['\\u21E7', 'P'\], desc: 'Run lap-time forecast'/);
  });

  it('the MOCK chip is the labelled heuristic fallback, not hand-written examples', () => {
    const ai = all(CHART_HELP.ai);
    expect(ai).toMatch(/heuristic fallback, not Gemini/);
    expect(ai).not.toMatch(/hand-written/);
    expect(read('App.jsx')).not.toMatch(/hand-written/);
  });

  it('the LSTM calibration limit names the LSTM', () => {
    expect(all(CHART_HELP.prediction)).toMatch(/The LSTM's pit probabilities above 50 %/);
  });

  it('Race Situation: the claim of identical pictures is limited to lap-level navigation (P10)', () => {
    const live = all(CHART_HELP.racesituation);
    expect(live).not.toMatch(/the same moment of the race looks the same/);
    expect(live).toMatch(/a lap reached by playing, a lap seek or a step back is drawn on the same axes/);
    expect(live).not.toMatch(/exponential|half-life/i);
  });

  it('App.jsx summaries carry none of the removed claims', () => {
    const app = read('App.jsx');
    expect(app).not.toMatch(/MAE 0\.4|2\.5s wet|HEURISTIC|Cohen\\'s d analysis|Points are races|exponential-smoothed|at one lap for every row/);
    // the comment no longer claims the field drives the (?) button
    expect(app).not.toMatch(/helpText` drives the \(\?\) info button/);
  });

  it('the Lap Times help describes the timing sheet the panel draws', () => {
    const lt = all(CHART_HELP.laptimes);
    expect(lt).not.toMatch(/Each line is a driver|dots are individual laps/);
    const panel = read('components/visualizations/LapTimeChart.jsx');
    // the columns: TIMING_COLUMNS of utils/views/lapTimeChart.js (the gap
    // column is labelled "Gap", its full name in the header's title)
    const columns = read('utils/views/lapTimeChart.js');
    expect(panel).toMatch(/TIMING_COLUMNS as COLUMN_DEFS/);
    for (const col of ['S1', 'S2', 'S3', 'Lap Time', 'Gap', 'Tyre']) expect(columns).toContain(`label: '${col}'`);
    expect(columns).toMatch(/title: 'Gap to fastest'/);
    expect(lt).toMatch(/sector times/);
    expect(panel).toMatch(/function LapRangeBrush/);
  });

  it('V7: the Lap Times bar and the Position Tracker brush are one range, and both helps say so', () => {
    const lt = all(CHART_HELP.laptimes);
    expect(lt).toMatch(/same brushed range as the Position Tracker's, so a range set in either view is drawn in both/);
    expect(all(CHART_HELP.positionlaps)).toMatch(/same range as the Lap Times bar's \(either view sets it, both draw it\)/);
    expect(all(CHART_HELP.tiredeg)).toMatch(/brushed on the Position Tracker or dragged on the Lap Times bar/);
    const panel = read('components/visualizations/LapTimeChart.jsx');
    expect(panel).toMatch(/setBrushLapRange\(next\.brushLapRange\)/);
    expect(read('components/visualizations/PositionByLap.jsx')).toMatch(/brush\.move, \[xScale\(brushLapRange\[0\]\), xScale\(brushLapRange\[1\]\)\]/);
  });

  it('the timing colours are named with the glyph the sheet draws next to them', () => {
    const lt = all(CHART_HELP.laptimes);
    expect(lt).toContain(`Purple with ${STATUS_GLYPHS.overallBest} = session best, green with ${STATUS_GLYPHS.personalBest} = personal best`);
    expect(read('utils/views/lapTimeChart.js')).toMatch(/glyph: STATUS_GLYPHS\.overallBest/);
  });

  it('P3: "above random" for on-screen rows only is a baseline within the race on screen', () => {
    expect(all(CHART_HELP.crossrace)).toMatch(/a baseline within the race on screen/);
  });

  it('Race Situation: a lasso selects drivers, it does not filter the other panels', () => {
    expect(CHART_HELP.racesituation.summary).not.toMatch(/filter/);
    expect(CHART_HELP.racesituation.summary).toMatch(/select those drivers in the other panels/);
  });
});

describe('V11: the undercut help matches utils/undercut.js and UndercutCalculator.jsx', () => {
  const help = all(CHART_HELP.undercut);
  const panel = read('components/visualizations/UndercutCalculator.jsx');

  it('every panel label the help names is drawn by the panel', () => {
    const labels = [...new Set(help.match(/\b[A-Z][A-Z-]{2,}(?: [A-Z][A-Z-]{2,})*\b/g))]
      // compounds, flags and units are not panel labels
      .filter((w) => !['VSC', 'DRS', 'SOFT', 'MEDIUM', 'HARD'].includes(w));
    console.log(`labels named by the undercut help: ${labels.join(', ')}`);
    expect(labels.sort()).toEqual(['AHEAD AFTER BOTH STOPS', 'BEHIND AFTER BOTH STOPS', 'GAP NOW', 'LAPS LEFT', 'NEW-TYRE GAIN', 'NOW', 'PIT LOSS', 'RIVAL STOPS']);
    for (const l of labels) expect(panel, l).toContain(l);
    expect(panel).toMatch(/` \+\$\{r\.extraStops\.length\}`/); // "+n next to the row's lap"
  });

  it('the sweep is described as the panel draws it: one column per in-lap, signed axis, the sign named by glyph', () => {
    const chart = read('utils/views/undercutSweepChart.js');
    expect(panel).toMatch(/drawUndercutSweep\(svgRef\.current/);
    expect(chart).toMatch(/One column per candidate in-lap/);
    expect(help).toMatch(/one column per candidate in-lap/);
    expect(help).not.toMatch(/\brows?\b/); // the sweep has no rows any more
    // up = ahead, down = behind, ▲ / ▼ in the legend; no colour name carries the sign
    expect(help).toMatch(/up \(\+, ▲\) = focus ahead, down \(−, ▼\) = behind/);
    expect(chart).toContain('▲ ${focus} ahead (+)');
    expect(chart).toContain('▼ ${focus} behind (−)');
    expect(help).not.toMatch(/\b(green|red)\b(?!-flag)/i);
    expect(help).toMatch(/marked with a diamond/);
    expect(chart).toMatch(/shape: 'diamond'/);
  });

  it('the numbers are the module constants, and no input the panel lacks is described', () => {
    expect(help).toContain(`the next ${UNDERCUT_SWEEP_LAPS}`);
    expect(help).toContain(`${Math.round(STINT_FEASIBLE_QUANTILE * 100)} % of the sets`);
    expect(help).not.toMatch(/slider|input field|type in|enter the/i);
    // the gap is read at the flag, as the panel's sweep header says
    expect(help).toMatch(/at the flag/);
    expect(panel).toMatch(/gap at \{horizonText\}, both plans to the finish/);
  });
});
