// The help texts describe what is drawn and what is done.
//  - Tyre Health: the real encoding (one driver, one curve per stint, the
//    zones, the stint bar) and the model's constants as the view's source has
//    them; no "bars" that are not drawn;
//  - Strategy Analysis: the docked view (StrategyAnalysis.jsx) draws no
//    pit-window lap ranges and selects none, so its help claims no click on a
//    pit window; the Cross-Race Analysis panel does (PCAAnalysisPanel.jsx),
//    so the Analytics help says it, with the views that really follow the
//    range;
//  - the pit-window tooltip of that panel says what the click does;
//  - Shift+P: "Run lap-time forecast" (it runs the forecast of the focus
//    driver, useKeyboardShortcuts).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_HELP, LAP_RANGE_EFFECTS, lapRangeTooltip } from '../utils/chartHelp.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const all = (e) => [e.summary, ...(e.howToRead || []), ...(e.limitations || [])].join(' ');

describe('Tyre Health help (D9: the real encoding)', () => {
  const help = CHART_HELP.tyrehealth;
  const text = all(help);
  const view = read('components/visualizations/TyreHealth.jsx');

  it('no bars, no garage sets, no calibration the code does not have', () => {
    expect(text).not.toMatch(/\bbars?\b(?! under)/i);
    expect(text).not.toMatch(/garage|Four|briefing|24 dry|2022-24/i);
    expect(help.summary.length).toBeLessThanOrEqual(140);
  });

  it('what is drawn: one driver, a curve per stint in the compound colour, the zones, the stint bar, PIT and the current lap', () => {
    expect(view).toMatch(/const driver = focusDriver \|\| selectedDrivers\[0\]/);
    expect(text).toMatch(/the focus driver, else the first selected/);
    expect(view).toMatch(/\.attr\('stroke', compoundColor\)/);
    expect(text).toMatch(/One line per stint \(tyre set\) in the compound colour/);
    expect(view).toMatch(/label: 'CRITICAL'/);
    expect(view).toMatch(/label: 'WORN'/);
    expect(text).toMatch(/CRITICAL \(< 30 %\) and WORN \(< 60 %\)/);
    expect(view).toMatch(/\{ y0: 0, y1: 30,[^}]*label: 'CRITICAL' \}/);
    expect(view).toMatch(/\{ y0: 30, y1: 60,[^}]*label: 'WORN' \}/);
    expect(view).toMatch(/\.text\('PIT'\)/);
    expect(text).toMatch(/dashed PIT lines/);
  });

  it('the model: every constant the help quotes is the one in TyreHealth.jsx', () => {
    const lives = view.match(/COMPOUND_MAX_LIFE = \{([\s\S]*?)\}/)[1];
    for (const [k, v] of [['SOFT', 22], ['MEDIUM', 32], ['HARD', 45], ['INTERMEDIATE', 30], ['WET', 25]]) {
      expect(lives).toMatch(new RegExp(`${k}: ${v}\\b`));
      expect(text).toContain(`${k} ${v}`);
    }
    expect(view).toMatch(/Math\.pow\(ageRatio, 1\.6\)/);
    expect(view).toMatch(/deviation \* 80/);
    expect(text).toMatch(/\(tyre age \/ max life\)\^1\.6\) − 80 ×/);
    expect(view).toMatch(/actualLength \* 1\.1/);
    expect(text).toMatch(/1\.1 × the stint's length/);
    expect(view).toMatch(/median \* 1\.4/);
    expect(text).toMatch(/1\.4 × the stint's median lap/);
    expect(view).toMatch(/runningMinHealth = Math\.min\(runningMinHealth, raw\)/);
    expect(text).toMatch(/running minimum/);
  });
});

describe('Strategy Analysis / Cross-Race Analysis: the pit-window click (D9)', () => {
  const docked = read('components/visualizations/StrategyAnalysis.jsx');
  const panel = read('components/visualizations/PCAAnalysisPanel.jsx');

  it('the docked Strategy Analysis selects no lap range, and its help claims no pit-window click', () => {
    expect(docked).not.toMatch(/setSelectedLapRange|setBrushLapRange/);
    expect(all(CHART_HELP.analysis)).not.toMatch(/click (on )?(a|one) pit window|select its laps|selects its laps/i);
  });

  it('the docked Strategy Analysis help describes that view (StrategyAnalysis.jsx), not the Cross-Race panel', () => {
    // App.jsx and slotOptions.js render StrategyAnalysis.jsx for 'analysis'
    expect(read('App.jsx')).toMatch(/analysis: +\{ title: 'Strategy Analysis', +Component: StrategyAnalysis,/);
    const text = all(CHART_HELP.analysis);
    // its tabs, sections and marks, each one drawn by the view
    for (const [phrase, inView] of [
      [/Insights/, /id: 'insights'/], [/Battles/, /label: `Battles \(/], [/Overtakes/, /Projected Overtakes \(Monte Carlo\)/],
      [/Pit Window Open/, />Pit Window Open</], [/Losing Pace/, />Losing Pace</], [/On The Move/, />On The Move</],
      [/What makes this cluster different/, />What makes this cluster different</], [/Cohen's d/, /Cohen&apos;s d effect size/],
      [/tyre mix/, /Field Tyre Distribution/],
    ]) {
      expect(text, String(phrase)).toMatch(phrase);
      expect(docked, String(inView)).toMatch(inView);
    }
    // the Cross-Race panel's marks are in its own entry (crossrace), not here
    expect(text).not.toMatch(/Hedges|random (selection|baseline)|Method|Patterns and Details|g axis/);
    expect(docked).not.toMatch(/Hedges|Patterns|randomBaseline/);
    expect(all(CHART_HELP.crossrace)).toMatch(/Hedges' g/);
    expect(CHART_HELP.crossrace.openTabId).toBe('analytics');
    expect(CHART_HELP.analytics.seeAlso.map((s) => s.tabId)).toContain('crossrace');
  });

  it('the Cross-Race Analysis panel does it, and the Analytics help (its tab) says so', () => {
    expect(panel).toMatch(/onClick=\{\(\) => setSelectedLapRange\(\[pw\.lap_start, pw\.lap_end\]\)\}/);
    expect(all(CHART_HELP.analytics)).toMatch(/a click on one selects its laps in the race on screen/);
    expect(all(CHART_HELP.analytics)).toContain(LAP_RANGE_EFFECTS);
  });

  it('the panel\'s tooltip says what the click does, not "across all views"', () => {
    expect(panel).not.toMatch(/highlight this lap range across all views/);
    expect(panel).toMatch(/title=\{lapRangeTooltip\(pw\.lap_start, pw\.lap_end\)\}/);
    expect(lapRangeTooltip(20, 24)).toBe(`Click to select laps 20–24 of the race on screen: ${LAP_RANGE_EFFECTS}.`);
  });

  it('every view the text names reads the lap range, as the text says', () => {
    const reads = (rel) => /selectedLapRange|brushLapRange/.test(read(rel));
    expect(LAP_RANGE_EFFECTS).toMatch(/Lap Times/);
    expect(reads('components/visualizations/LapTimeChart.jsx')).toBe(true);
    expect(LAP_RANGE_EFFECTS).toMatch(/Position Tracker brush/);
    expect(read('components/visualizations/PositionByLap.jsx')).toMatch(/brush\.move, \[xScale\(brushLapRange\[0\]\), xScale\(brushLapRange\[1\]\)\]/);
    expect(LAP_RANGE_EFFECTS).toMatch(/Strategy Timeline band/);
    expect(read('components/visualizations/StrategyTimeline.jsx')).toMatch(/if \(selectedLapRange\) \{/);
    // Tyre Degradation fits the focus driver's laps of a range of five laps or more
    const deg = read('components/visualizations/TireDegradation.jsx');
    expect(deg).toMatch(/const activeRange = brushLapRange \|\| selectedLapRange;/);
    expect(deg).toMatch(/hi - lo < 4\) return;/);
    expect(LAP_RANGE_EFFECTS).toMatch(/Tyre Degradation fits them for the focus driver \(a range of five laps or more\)/);
    // Telemetry in laps mode: up to four laps of the range
    const tel = read('components/visualizations/TelemetryStrip.jsx');
    expect(tel).toMatch(/telemetryCompareMode !== 'laps'/);
    expect(tel).toMatch(/laps\.length < 4/);
    expect(LAP_RANGE_EFFECTS).toMatch(/Telemetry in laps mode compares up to four of them/);
    // no digit in the shared phrase (the PCA help has no number of its own)
    expect(LAP_RANGE_EFFECTS).not.toMatch(/\d/);
  });
});

describe('Shift+P (D9)', () => {
  it('the cheatsheet says "Run lap-time forecast", and Shift+P does run it', () => {
    const sheet = read('components/ShortcutCheatsheet/ShortcutCheatsheet.jsx');
    expect(sheet).toMatch(/keys: \['\\u21E7', 'P'\], desc: 'Run lap-time forecast' \}/);
    expect(sheet).not.toMatch(/Lap-Time Forecast of the Focus Driver/);
    const keys = read('hooks/useKeyboardShortcuts.js');
    const block = keys.slice(keys.indexOf("if (e.key === 'P' && e.shiftKey)"));
    expect(block.slice(0, 600)).toMatch(/triggerPrediction\(driver, state\.currentLap\)/);
  });

  it('the command bar entry of the same shortcut has the same label', () => {
    const reg = read('components/CommandPalette/commandRegistry.js');
    const entry = reg.slice(reg.indexOf("id: 'predict-pit'"), reg.indexOf("id: 'predict-pit'") + 200);
    expect(entry).toMatch(/label: 'Run lap-time forecast',/);
    expect(entry).toMatch(/shortcut: '⇧P'/);
    expect(reg).not.toMatch(/Lap-Time Forecast of the Focus Driver/);
  });
});

describe('the one-line helpText of App.jsx and COLOR_ENCODING.md agree with the help (D9)', () => {
  it('Tyre Health: curves per stint, no bars, no calibration the code does not have', () => {
    const line = read('App.jsx').split('\n').find((l) => /^\s*tyrehealth:/.test(l));
    expect(line).toMatch(/one curve per stint/);
    expect(line).not.toMatch(/\bbars?\b|Pirelli|24-session|calibration/i);
    const doc = fs.readFileSync(path.join(SRC, '../../docs/COLOR_ENCODING.md'), 'utf8');
    expect(doc).not.toMatch(/TyreHealth bars/);
  });
});
