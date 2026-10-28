// Race Trace ('racetrace') and Race Pace ('teampace') are registered where
// every dock view is: the dock's view list (slotOptions.js), the view map of
// App.jsx, the docked tab picker (DockedLayout.jsx), the command palette and
// the help registry. No keyboard key and no bottom-bar default are added, and
// no view is retired. Each help entry opens with the view's question and
// quotes the constants of the modules that compute what it describes.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const { SLOT_OPTIONS, SLOT_IDS, PRESETS } = await import('../utils/slotOptions.js');
const { CHART_HELP } = await import('../utils/chartHelp.js');
const { createCommandRegistry } = await import('../components/CommandPalette/commandRegistry.js');
const { DOCK_DEFAULTS } = await import('../store/useF1Store.js');
const { WINDOW_PRESETS } = await import('../utils/windowPresets.js');
const { viewKeyHint } = await import('../hooks/useKeyboardShortcuts.js');
const { FOCUS_WINDOW, TOP_WINDOW_CARS } = await import('../utils/raceTrace.js');
const { PACE_BOOTSTRAP_RUNS, PACE_BLOCK_LAPS, PACE_LOW_DATA_LAPS, PACE_MIN_LAP_FIELD } = await import('../utils/fieldPace.js');
const { RACE_TRACE_FIT } = await import('../utils/views/raceTraceChart.js');

const all = (e) => [e.summary, ...(e.howToRead || []), ...(e.limitations || [])].join(' ');

describe('registration', () => {
  it('the ids collide with no view id or preset key', () => {
    const ids = SLOT_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['racetrace', 'teampace']) {
      expect(SLOT_IDS.has(id)).toBe(true);
      expect(Object.keys(PRESETS)).not.toContain(id);
      expect(Object.keys(WINDOW_PRESETS)).not.toContain(id);
    }
    expect(SLOT_OPTIONS.find((o) => o.id === 'racetrace')).toMatchObject({ label: 'Race Trace' });
    expect(viewKeyHint('racetrace')).toBeNull();
    expect(SLOT_OPTIONS.find((o) => o.id === 'teampace')).toMatchObject({ label: 'Race Pace' });
    expect(viewKeyHint('teampace')).toBeNull();
  });

  it('App.jsx view map, the docked tab picker and the command palette', () => {
    const app = read('App.jsx');
    expect(app).toMatch(/racetrace: +\{ title: 'Race Trace', +Component: RaceTrace,/);
    expect(app).toMatch(/teampace: +\{ title: 'Race Pace', +Component: FieldPace,/);
    const docked = read('components/layout/DockedLayout.jsx');
    expect(docked).toContain("{ id: 'racetrace', label: 'Race Trace' }");
    expect(docked).toContain("{ id: 'teampace', label: 'Race Pace' }");
    const commands = createCommandRegistry();
    for (const [id, label] of [['open-race-trace', 'Race Trace'], ['open-race-pace', 'Race Pace']]) {
      const c = commands.find((x) => x.id === id);
      expect(c).toMatchObject({ label, shortcut: null });
    }
  });

  it('no keyboard key, no bottom-bar default, no view retired', () => {
    const keys = read('hooks/useKeyboardShortcuts.js');
    expect(keys).not.toMatch(/racetrace|teampace/);
    expect(DOCK_DEFAULTS).not.toContain('racetrace');
    expect(DOCK_DEFAULTS).not.toContain('teampace');
    for (const id of ['analytics', 'racesituation', 'lapdelta', 'racepace', 'circle']) expect(SLOT_IDS.has(id)).toBe(true);
    expect(Object.keys(PRESETS)).toEqual(['strategy', 'tyres', 'pace', 'predict', 'overview', 'simulator']);
  });
});

describe('help', () => {
  it('each entry opens with the view\'s question', () => {
    expect(CHART_HELP.racetrace.summary).toBe('Who gained time on whom over the race so far, and what changed it (stops, SC / VSC / red flags, passes)?');
    expect(CHART_HELP.teampace.summary).toBe('Who had the race pace here, how sure is that, and who beat his team-mate?');
    for (const k of ['racetrace', 'teampace']) expect(CHART_HELP[k].summary.length).toBeLessThanOrEqual(140);
  });

  it('the numbers are the modules\' constants', () => {
    const trace = all(CHART_HELP.racetrace);
    expect(trace).toContain(`the top ${TOP_WINDOW_CARS} cars of the lead lap`);
    expect(trace).toContain(`the larger of ${FOCUS_WINDOW.minS} seconds and one stop plus ${FOCUS_WINDOW.pitMarginS} seconds`);
    expect(trace).toContain(`From ${RACE_TRACE_FIT.full.width} x ${RACE_TRACE_FIT.full.height} px`);
    expect(trace).toContain('never a sum of lap times');
    const pace = all(CHART_HELP.teampace);
    expect(pace).toContain(`${PACE_BOOTSTRAP_RUNS.toLocaleString('en-US')} resamples`);
    expect(pace).toContain(`blocks of ${PACE_BLOCK_LAPS} consecutive laps`);
    expect(pace).toContain(`under ${PACE_LOW_DATA_LAPS} laps`);
    expect(pace).toContain(`at least ${PACE_MIN_LAP_FIELD} of them`);
    expect(pace).toMatch(/"decisive" only when the interval excludes 0/);
  });
});
