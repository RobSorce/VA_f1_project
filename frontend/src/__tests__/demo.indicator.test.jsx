// V12: the static demo is never silent. A run-time demo (the backend did not
// answer) raises a toast that says the static demo answers and what needs the
// backend, dismissed when the backend answers again; the weather bar shows a
// DEMO chip whenever the demo answers (a demo build or a run-time demo).
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

// Server rendering reads getServerState: point it at the live state
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

const { useF1Store, DEMO_FALLBACK_TOAST_ID } = await import('../store/useF1Store.js');
const { activateDemo, deactivateDemo, useDemoMode, DEMO_NOTE } = await import('../utils/demoMode.js');
const { default: WeatherBar } = await import('../components/ui/WeatherBar.jsx');

describe('V12: the user learns that the static demo answers', () => {
  it('a run-time demo raises one toast naming the demo and the backend-only features; it goes when the backend answers', () => {
    expect(useDemoMode.getState().active).toBe(false);
    activateDemo('Network Error; GET /api/health did not answer');
    const toasts = useF1Store.getState().toasts.filter((t) => t.id === DEMO_FALLBACK_TOAST_ID);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].timeout).toBe(0);
    expect(toasts[0].message).toMatch(/^Backend unreachable: switched to the static demo\./);
    expect(toasts[0].message).toContain('LSTM forecast');
    // a second activation does not stack another toast
    activateDemo('again');
    expect(useF1Store.getState().toasts.filter((t) => t.id === DEMO_FALLBACK_TOAST_ID)).toHaveLength(1);
    deactivateDemo();
    expect(useF1Store.getState().toasts.some((t) => t.id === DEMO_FALLBACK_TOAST_ID)).toBe(false);
  });

  it('the weather bar shows the DEMO chip, with the demo note as its tooltip, only while the demo answers', () => {
    const off = renderToString(<WeatherBar />);
    expect(off).not.toContain('weather-bar__demo');
    activateDemo('Network Error');
    const on = renderToString(<WeatherBar />);
    expect(on).toMatch(/class="weather-bar__demo" title="[^"]*Static demo: a few bundled races/);
    expect(on).toContain('>Demo</span>');
    expect(DEMO_NOTE).toMatch(/^Static demo:/);
    deactivateDemo();
  });
});
