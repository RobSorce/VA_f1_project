// P3g, second request site: the Pit Wall "AI Strategist" box
// (components/ui/GeminiQuickQuery.jsx, rendered for every session type by
// PitWallHome and PitWallLayout) posts to the same /gemini/strategy endpoint as
// the store's sendGeminiQuery. Its body must carry the type of the session on
// screen (viewSessionType, R7), so the backend quotes no pit loss outside race
// sessions, and the fields GeminiRequest reads (year, round, drivers).
// No DOM here: the buttons' onClick handlers are captured from the JSX runtime
// while the component is server-rendered, then called.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

const { buttons, wrap, bodies } = vi.hoisted(() => {
  const buttons = [];
  const bodies = [];
  const wrap = (orig) => (type, props, ...rest) => {
    if (type === 'button' && typeof props?.onClick === 'function' && typeof props.children === 'string') {
      buttons.push({ text: props.children, onClick: props.onClick });
    }
    return orig(type, props, ...rest);
  };
  return { buttons, wrap, bodies };
});
vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, jsxDEV: wrap(m.jsxDEV) };
});
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const m = await importOriginal();
  return { ...m, jsx: wrap(m.jsx), jsxs: wrap(m.jsxs) };
});
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.queryGemini = vi.fn(async (body) => { bodies.push(body); return { response: 'ok' }; });
  return mocked;
});
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

const { useF1Store } = await import('../store/useF1Store.js');
const { geminiQuickQueryBody, isRaceSession } = await import('../utils/strategyViews.js');
const { default: GeminiQuickQuery } = await import('../components/ui/GeminiQuickQuery.jsx');

const QUICK = ['Pit window?', 'Strategy?', 'Tyre deg?'];

async function clickQuickQueries(state) {
  useF1Store.setState({
    year: 2024, round: 8, sessionType: 'R', loadedSessionType: null, isLiveMode: false,
    isQualifyingReplay: false, liveSessionInfo: null, sessionData: { lap_times: [] },
    currentLap: 5, focusDriver: 'NOR', selectedDrivers: ['NOR', 'PIA'],
    ...state,
  });
  buttons.length = 0;
  bodies.length = 0;
  renderToString(<GeminiQuickQuery />);
  const quick = buttons.filter((b) => QUICK.includes(b.text));
  expect(quick.map((b) => b.text)).toEqual(QUICK);
  for (const b of quick) await b.onClick();
  expect(bodies.map((b) => b.query)).toEqual(QUICK);
  return bodies.slice();
}

describe('P3g: the AI Strategist quick queries carry the session type (R7)', () => {
  for (const [label, state, type] of [
    ['qualifying replay (2024 R8 Q)', { loadedSessionType: 'Q', sessionType: 'Q', isQualifyingReplay: true }, 'Q'],
    ['practice (FP2)', { year: 2026, round: 1, loadedSessionType: 'FP2', sessionType: 'FP2' }, 'FP2'],
    ['sprint qualifying (SQ)', { loadedSessionType: 'SQ', sessionType: 'SQ' }, 'SQ'],
    ['race (R)', { loadedSessionType: 'R' }, 'R'],
    ['sprint (S)', { loadedSessionType: 'S', sessionType: 'S' }, 'S'],
    ['live practice', { isLiveMode: true, liveSessionInfo: { session_type: 'Practice', session_name: 'Practice 2' } }, 'FP'],
  ]) {
    it(`${label}: session_type '${type}' on all three buttons`, async () => {
      const sent = await clickQuickQueries(state);
      const s = useF1Store.getState();
      for (const body of sent) {
        expect(body.session_type).toBe(type);
        expect(isRaceSession(body.session_type)).toBe(['R', 'S'].includes(type));
        expect(body.year).toBe(s.year);
        expect(body.round).toBe(s.round);
        expect(body.drivers).toEqual(['NOR']);
        expect(body.current_lap).toBe(5);
        expect(body).not.toHaveProperty('driver');
      }
    });
  }

  it('the body is the same helper the store state feeds (no focus: first selected driver)', () => {
    const body = geminiQuickQueryBody({
      year: 2024, round: 16, loadedSessionType: 'Q', focusDriver: null, selectedDrivers: ['LEC'], currentLap: 3,
    }, '  Pit window?  ');
    expect(body).toEqual({
      query: 'Pit window?', year: 2024, round: 16, session_type: 'Q', drivers: ['LEC'], current_lap: 3,
    });
    expect(geminiQuickQueryBody({}, 'x').drivers).toEqual([]);
  });
});
