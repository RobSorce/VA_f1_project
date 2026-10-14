// Circle of Doom, "pit in k laps" (Task 4) in the view: server renders with a
// real store state (cached Monza 2024): the header stepper and the "rivals
// stop" toggle, the ghost of the rejoin for k > 0 at the projected offset,
// the centre line "pits in k: P → P (± vs now)", the legend entry while the
// ghost is drawn, k = 0 drawing exactly the pit window, k capped by the laps
// left. The [ and ] keys: pitInLapsKeyStep (useKeyboardShortcuts.js) and the
// view's keydown listener, run with the effects executed during the render.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

vi.mock('zustand', async (importOriginal) => {
  const orig = await importOriginal();
  const bind = (createState) => {
    const api = orig.createStore(createState);
    api.getServerState = api.getState;
    const useBound = (selector, equalityFn) => orig.useStore(api, selector, equalityFn);
    Object.assign(useBound, api);
    return useBound;
  };
  return { ...orig, create: (createState) => (createState ? bind(createState) : bind) };
});

// While globalThis.__runEffects is set, useEffect runs its callback during the
// (server) render and every state setter call is recorded in __setterCalls:
// the keydown listener the view registers can then be driven from the test
vi.mock('react', async (importOriginal) => {
  const orig = await importOriginal();
  const real = orig.default || orig;
  const useEffect = (fn, deps) => {
    if (globalThis.__runEffects) fn();
    return real.useEffect(fn, deps);
  };
  const useState = (init) => {
    const [v, set] = real.useState(init);
    if (!globalThis.__runEffects) return [v, set];
    return [v, (u) => { globalThis.__setterCalls.push({ init, u }); set(u); }];
  };
  return { ...orig, default: { ...real, useEffect, useState }, useEffect, useState };
});

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const { useF1Store } = await import('../store/useF1Store.js');
const { default: CircleOfDoom } = await import('../components/visualizations/CircleOfDoom.jsx');
const { pitInLapsKeyStep, isTypingTarget } = await import('../hooks/useKeyboardShortcuts.js');
const { circleState, pitWindow } = await import('../utils/circleOfDoom.js');
const { pitInLaps, PIT_IN_LAPS_MAX } = await import('../utils/undercut.js');
const { extractRaceParams } = await import('../utils/raceSimulation.js');
const { estimatePitLoss } = await import('../utils/pitLoss.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const INITIAL = useF1Store.getState();
const SIZE = { width: 520, height: 360 };
const render = (props = {}) => renderToString(React.createElement(CircleOfDoom, { size: SIZE, ...props }));
const textOf = (markup) => markup
  .replace(/<!-- -->/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ');

const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const maxLapOf = (s) => Math.max(...s.lap_times.map((r) => r.LapNumber));

function replayAt(session, sessionTime, currentLap, extra = {}) {
  const offset = computeSessionTimeOffset(session.lap_times);
  const maxLap = maxLapOf(session);
  useF1Store.setState({
    ...INITIAL,
    sessionType: 'R',
    loadedSessionType: 'R',
    sessionData: session,
    drivers: session.driver_info,
    trackStatus: session.track_status || [],
    sessionTimeOffset: offset,
    maxLap,
    totalRaceLaps: maxLap,
    currentLap,
    totalFrames: 10000,
    currentTime: sessionTime - offset,
    ...extra,
  });
}

beforeEach(() => {
  useF1Store.setState({ ...INITIAL });
  globalThis.__runEffects = false;
  globalThis.__setterCalls = [];
});

/** Attributes of the first element whose opening tag matches `re`. */
function attrsOf(markup, re) {
  const m = markup.match(re);
  if (!m) return null;
  const out = {};
  for (const a of m[0].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[a[1]] = a[2];
  return out;
}
const translateOf = (attr) => attr.match(/translate\(([^,]+),([^)]+)\)/).slice(1).map(Number);
/** Clockwise angle from the top of a point around (cx, cy), in [0, 2 pi). */
function angleOf([x, y], cx, cy) {
  const a = Math.atan2(x - cx, cy - y);
  return a < 0 ? a + 2 * Math.PI : a;
}
const wrap = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** The projection the view draws: pitInLaps at the store's clock. */
function projection(session, now, focus, opts = {}) {
  const lt = session.lap_times;
  const st = circleState(lt, { sessionNow: now });
  const pitLoss = estimatePitLoss(lt, { sessionNow: now, sessionType: 'R' });
  const rp = extractRaceParams(lt, [], session.track_status || [], 1, { sessionNow: now, sessionType: 'R' });
  return { win: pitWindow(focus, st, pitLoss), pk: pitInLaps(focus, st, pitLoss, rp, opts) };
}

const NOW = 4300; // Monza 2024, lap 13 in progress for the leaders

describe.skipIf(!haveMonza)('the stepper and the ghost of the rejoin', () => {
  it('k = 0 (default): the stepper reads 0, no ghost, the pit window as before', () => {
    replayAt(monza, NOW, 13, { focusDriver: 'LEC' });
    const m = render();
    expect(attrsOf(m, /<span class="cod-pitin__k"[^>]*>/)['data-k']).toBe('0');
    expect(m).toMatch(/<button type="button" aria-label="Pit one lap earlier \(\[\)" disabled=""/);
    expect(attrsOf(m, /<button type="button" class="cod-pitin__rivals"[^>]*>/)['aria-pressed']).toBe('false');
    expect(m).not.toContain('cod-ghost');
    expect(textOf(m)).toContain('LEC pits now:');
    expect(m).not.toContain('rejoin: now · in k laps');
    expect(m).toContain('title="predicted rejoin"');
    expect(m).toMatch(/<text class="cod-rejoin-label"[^>]*data-of="rejoin"/);
    expect(render({ pitInK: 0 })).toBe(m);
  });

  it('k = 3: the ghost at the projected offset, its place and "± vs now" in the centre, the legend entry', () => {
    replayAt(monza, NOW, 13, { focusDriver: 'LEC' });
    const { win, pk } = projection(monza, NOW, 'LEC');
    const row = pk.rows[3];
    const m = render({ pitInK: 3 });
    expect(attrsOf(m, /<span class="cod-pitin__k"[^>]*>/)['data-k']).toBe('3');
    const ghost = attrsOf(m, /<g class="cod-ghost"[^>]*>/);
    expect(ghost['data-k']).toBe('3');
    expect(Number(ghost['data-position'])).toBe(row.predictedPosition);
    // drawn at focus angle - 2 pi x ghostOffset, the rejoin at focus angle - 2 pi x rejoinOffset
    const ring = attrsOf(m, /<circle class="cod-ring"[^>]*>/);
    const [cx, cy] = [Number(ring.cx), Number(ring.cy)];
    const focusAt = translateOf(attrsOf(m, /<g class="cod-car cod-car--focus[^"]*"[^>]*>/).transform);
    const aFocus = angleOf(focusAt, cx, cy);
    const aGhost = angleOf(translateOf(ghost.transform), cx, cy);
    const aRejoin = angleOf(translateOf(attrsOf(m, /<g class="cod-rejoin"[^>]*>/).transform), cx, cy);
    expect(wrap(aFocus - aGhost)).toBeCloseTo(wrap(2 * Math.PI * row.ghostOffset), 6);
    expect(wrap(aFocus - aRejoin)).toBeCloseTo(wrap(2 * Math.PI * win.rejoinOffset), 6);
    expect(row.ghostOffset).not.toBe(win.rejoinOffset);
    // centre (or legend line): "LEC pits in 3: P2 → P.. (...)" with the places vs pitting now
    const vs = row.positionsVsNow === 0 ? '= now'
      : `${row.positionsVsNow > 0 ? '+' : '−'}${Math.abs(row.positionsVsNow)} vs now`;
    const t = textOf(m);
    expect(t).toContain('LEC pits in 3:');
    expect(t).toContain(`P${win.currentPosition} → P${row.predictedPosition} (${vs})`);
    expect(t).not.toContain('LEC pits now:');
    // the legend's rejoin entry shows the ghost too while it is drawn (same number of entries)
    expect(m).toContain('title="rejoin: now · in k laps"');
    expect(m).not.toContain('title="predicted rejoin"');
    expect((m.match(/class="legend-item cod-legend__item"/g) || []).length).toBe(9);
    // the ring's label is the ghost's: "pit in 3: P.. (...)"
    const label = m.match(/<text class="cod-rejoin-label"[^>]*data-of="ghost"[^>]*>[\s\S]*?<\/text>/);
    expect(label).toBeTruthy();
    expect(textOf(label[0])).toMatch(new RegExp(`(pit )?in 3: P${row.predictedPosition}`));
    console.log(`Monza ${NOW} s, LEC pits in 3: ghost P${row.predictedPosition} at L${row.targetLap}, offset ${row.ghostOffset.toFixed(4)} `
      + `(rejoin now ${win.rejoinOffset.toFixed(4)}), pit now P${row.positionIfPitNow}; centre: "${t.match(/LEC pits in 3:[^)]*\)/)[0]}"`);
  });

  it('every k from 1 to 10 draws the row of pitInLaps', () => {
    replayAt(monza, NOW, 13, { focusDriver: 'PIA' });
    const { pk } = projection(monza, NOW, 'PIA');
    for (let k = 1; k <= 10; k++) {
      const ghost = attrsOf(render({ pitInK: k }), /<g class="cod-ghost"[^>]*>/);
      expect(Number(ghost['data-k'])).toBe(k);
      expect(Number(ghost['data-position'])).toBe(pk.rows[k].predictedPosition);
    }
  });

  it('k is capped by the laps the focus car has left', () => {
    // LEC has completed lap 48: the window's target is lap 50 of 53
    const now = monza.lap_times.find((r) => r.Driver === 'LEC' && r.LapNumber === 48).Time + 1;
    replayAt(monza, now, 49, { focusDriver: 'LEC' });
    const { pk } = projection(monza, now, 'LEC');
    expect(pk.kMax).toBe(3);
    const m = render({ pitInK: 10 });
    expect(attrsOf(m, /<span class="cod-pitin__k"[^>]*>/)['data-k']).toBe('3');
    expect(attrsOf(m, /<g class="cod-ghost"[^>]*>/)['data-k']).toBe('3');
    expect(m).toMatch(/<button type="button" aria-label="Pit one lap later \(\]\)" disabled=""/);
  });

  it('no focus: the stepper is there, nothing is projected', () => {
    replayAt(monza, NOW, 13, {});
    const m = render({ pitInK: 4 });
    expect(attrsOf(m, /<span class="cod-pitin__k"[^>]*>/)['data-k']).toBe('4');
    expect(m).not.toContain('cod-ghost');
    expect(textOf(m)).not.toContain('pits in');
  });
});

describe('the [ and ] keys', () => {
  it('pitInLapsKeyStep: ] one lap more, [ one fewer; nothing while typing, with a Ctrl / Cmd chord or a modal open', () => {
    expect(pitInLapsKeyStep({ key: ']' })).toBe(1);
    expect(pitInLapsKeyStep({ key: '[' })).toBe(-1);
    expect(pitInLapsKeyStep({ key: 'a' })).toBe(0);
    expect(pitInLapsKeyStep({ key: ']', ctrlKey: true })).toBe(0);
    expect(pitInLapsKeyStep({ key: '[', metaKey: true })).toBe(0);
    expect(pitInLapsKeyStep({ key: '[', metaKey: true, altKey: true })).toBe(0);
    // Italian layout (it-IT): '[' = AltGr+è, ']' = AltGr++. Windows browsers report
    // AltGr as Ctrl + Alt (getModifierState('AltGraph') true); Linux as AltGraph only
    const winAltGr = (key) => ({ key, ctrlKey: true, altKey: true, metaKey: false, getModifierState: (m) => m === 'AltGraph' });
    expect(pitInLapsKeyStep(winAltGr(']'))).toBe(1);
    expect(pitInLapsKeyStep(winAltGr('['))).toBe(-1);
    expect(pitInLapsKeyStep({ key: ']', ctrlKey: true, altKey: true })).toBe(1); // no getModifierState
    expect(pitInLapsKeyStep({ key: '[', getModifierState: (m) => m === 'AltGraph' })).toBe(-1);
    // Mac Italian layout: '[' = Option+è (altKey)
    expect(pitInLapsKeyStep({ key: '[', altKey: true })).toBe(-1);
    expect(pitInLapsKeyStep({ key: ']', altKey: true })).toBe(1);
    // a Ctrl chord is a shortcut, never the key (Ctrl without Alt / AltGraph)
    expect(pitInLapsKeyStep({ key: ']', ctrlKey: true, getModifierState: () => false })).toBe(0);
    // with AltGr held, typing in a field or a modal still wins
    expect(pitInLapsKeyStep(winAltGr(']'), {}, { tagName: 'INPUT' })).toBe(0);
    expect(pitInLapsKeyStep(winAltGr(']'), { commandPaletteOpen: true })).toBe(0);
    expect(pitInLapsKeyStep({ key: ']' }, { commandPaletteOpen: true })).toBe(0);
    expect(pitInLapsKeyStep({ key: ']' }, { cheatsheetOpen: true })).toBe(0);
    for (const el of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      expect(isTypingTarget(el)).toBe(true);
      expect(pitInLapsKeyStep({ key: ']' }, {}, el)).toBe(0);
    }
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(pitInLapsKeyStep({ key: ']' }, {}, { tagName: 'BUTTON' })).toBe(1);
  });

  it('the global shortcuts leave [ and ] to the view (no binding in useKeyboardShortcuts)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks/useKeyboardShortcuts.js');
    const src = fs.readFileSync(file, 'utf8');
    const handler = src.slice(src.indexOf('export function useKeyboardShortcuts'));
    expect(handler).not.toMatch(/key === '\['|key === '\]'/);
  });

  it.skipIf(!haveMonza)('the view listens on window: ] steps k up, [ down (never below 0), not while typing', () => {
    replayAt(monza, NOW, 13, { focusDriver: 'LEC' });
    const listeners = [];
    globalThis.window = {
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      removeEventListener: () => {},
    };
    globalThis.document = { activeElement: null };
    try {
      globalThis.__runEffects = true;
      render();
      globalThis.__runEffects = false;
      const keydown = listeners.filter((l) => l.type === 'keydown');
      expect(keydown).toHaveLength(1);
      const press = (key, mods = {}) => {
        globalThis.__setterCalls = [];
        let prevented = false;
        keydown[0].fn({ key, ...mods, preventDefault: () => { prevented = true; } });
        const steps = globalThis.__setterCalls.filter((c) => typeof c.u === 'function');
        return { prevented, steps };
      };
      const up = press(']');
      expect(up.prevented).toBe(true);
      expect(up.steps).toHaveLength(1);
      expect(up.steps[0].u(0)).toBe(1);
      expect(up.steps[0].u(9)).toBe(10);
      expect(up.steps[0].u(10)).toBe(10); // kMax 10 at this clock
      const down = press('[');
      expect(down.steps[0].u(3)).toBe(2);
      expect(down.steps[0].u(0)).toBe(0);
      expect(press('x').steps).toHaveLength(0);
      // the Italian layout on Windows: AltGr+è / AltGr++ arrive as '[' / ']' with Ctrl + Alt
      const altGr = { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' };
      const upIt = press(']', altGr);
      expect(upIt.prevented).toBe(true);
      expect(upIt.steps[0].u(4)).toBe(5);
      expect(press('[', altGr).steps[0].u(4)).toBe(3);
      // a Ctrl chord is not the key
      expect(press(']', { ctrlKey: true, getModifierState: () => false }).steps).toHaveLength(0);
      globalThis.document.activeElement = { tagName: 'INPUT' };
      const typing = press(']');
      expect(typing.steps).toHaveLength(0);
      expect(typing.prevented).toBe(false);
    } finally {
      globalThis.__runEffects = false;
      delete globalThis.window;
      delete globalThis.document;
    }
  });
});

describe('help texts of this round (chartHelp.js, App.jsx)', () => {
  it('circle and undercut entries state the model and its assumptions; the Monte Carlo entries quote the run count of the code', async () => {
    const { CHART_HELP } = await import('../utils/chartHelp.js');
    const { DEFAULT_NUM_SIMULATIONS, OPTIONAL_STOP_MIN_LAPS_LEFT, PRIORS } = await import('../utils/raceSimulation.js');
    const { FUEL_EFFECT_S_PER_LAP } = await import('../utils/degradation.js');
    const all = (e) => [e.summary, ...e.howToRead, ...e.limitations].join(' ');
    const circle = all(CHART_HELP.circle);
    expect(circle).toMatch(/Pit in k laps/);
    expect(circle).toMatch(/\[ and \] keys/);
    expect(circle).toContain(`k = 0 to ${PIT_IN_LAPS_MAX}`);
    expect(circle).toMatch(/no traffic/);
    expect(circle).toMatch(/no stops by the other cars unless "rivals stop" is on/);
    expect(circle).toMatch(/fresh-tyre delta/);
    const undercut = all(CHART_HELP.undercut);
    // every row read at one lap, the first by which both cars have stopped in every row
    expect(undercut).toMatch(/the first lap by which both cars have stopped in every row/);
    expect(undercut).toMatch(/pace difference the same in every row/);
    expect(undercut).toContain(`${PRIORS.degradation.MEDIUM.minFitLaps} MEDIUM`);
    expect(undercut).toMatch(/The rival stops in every row, before or after the focus/);
    expect(undercut).toMatch(/No traffic/);
    expect(undercut).toContain(`${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap`);
    const mc = `${all(CHART_HELP.prediction)} ${all(CHART_HELP.simulator)}`;
    expect(mc).not.toMatch(/100 iterations|N=100/);
    expect(mc).toContain(`${DEFAULT_NUM_SIMULATIONS.toLocaleString('en-US')} race-to-flag runs`);
    expect(mc).toContain(`fewer than ${OPTIONAL_STOP_MIN_LAPS_LEFT} laps left`);
    expect(mc).toContain(`(${PRIORS.safetyCar.episodesPerRace} episode per ${PRIORS.safetyCar.lapsPerRace} laps)`);
    expect(mc).toMatch(/exactly 0/);
    const tyres = `${all(CHART_HELP.tiredeg)} ${all(CHART_HELP.consistency)}`;
    expect(tyres).not.toMatch(/30 ms\/lap|~1 s to ~9 s|Population σ/);
    expect(tyres).toMatch(/residual sigma/);
  });

  it('App.jsx overlay help: no "100 iterations", no "+30 ms/lap", the circle names the stepper', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const app = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.jsx'), 'utf8');
    expect(app).not.toMatch(/100 iterations|\+30 ms\/lap|Population σ/);
    const line = app.split('\n').find((l) => /^\s*circle:\s*\{/.test(l));
    expect(line).toMatch(/Pit in k laps \(\[ and \] or the header stepper\)/);
  });
});
