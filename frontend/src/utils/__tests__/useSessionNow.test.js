import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

// Stand-in store: the hook's selectors read this plain state object.
vi.mock('../../store/useF1Store', () => ({
  useF1Store: (selector) => selector(globalThis.__useSessionNowState),
}));

const { useSessionNow } = await import('../../hooks/useSessionNow.js');
const { default: useSessionNowDefault } = await import('../../hooks/useSessionNow.js');

/** Render a probe component once and return what the hook returned. */
function renderHook(state) {
  globalThis.__useSessionNowState = state;
  let value;
  function Probe() {
    value = useSessionNow();
    return null;
  }
  renderToString(createElement(Probe));
  return value;
}

const lapTimes = [
  { Driver: 'AAA', LapNumber: 1, LapStartTime: 500, Time: 590 },
  { Driver: 'AAA', LapNumber: 2, LapStartTime: 590, Time: 680 },
  { Driver: 'AAA', LapNumber: 3, LapStartTime: 680, Time: 770 },
];
const base = {
  currentTime: 0, sessionTimeOffset: 500, totalFrames: 0, currentLap: 1, maxLap: 3,
  sessionData: { lap_times: lapTimes }, isLiveMode: false, maxTime: 0, frameDt: 0.4,
};

describe('useSessionNow', () => {
  it('is exported as named and default', () => {
    expect(useSessionNowDefault).toBe(useSessionNow);
  });

  it('lap mode (no frames): race start at lap 1, leader lap start after, the last lap too', () => {
    expect(renderHook(base)).toBe(500);
    expect(renderHook({ ...base, currentLap: 2 })).toBe(590);
    expect(renderHook({ ...base, currentLap: 3 })).toBe(680);
  });

  it('lap mode race-over state (store.lapModeRaceOver): Infinity; ignored once frames load', () => {
    expect(renderHook({ ...base, currentLap: 3, lapModeRaceOver: true })).toBe(Infinity);
    expect(renderHook({ ...base, totalFrames: 10, currentTime: 42.5, lapModeRaceOver: true })).toBe(542.5);
  });

  it('replay mode when totalFrames > 0: currentTime + sessionTimeOffset', () => {
    expect(renderHook({ ...base, totalFrames: 10, currentTime: 42.5 })).toBe(542.5);
  });

  it('last replay frame and live mode: Infinity', () => {
    expect(renderHook({ ...base, totalFrames: 10, currentTime: 299.9, maxTime: 300 })).toBe(Infinity);
    expect(renderHook({ ...base, totalFrames: 10, currentTime: 42.5, isLiveMode: true })).toBe(Infinity);
  });

  it('works before any session is loaded', () => {
    expect(renderHook({ ...base, sessionData: null, currentLap: 1, maxLap: 1, sessionTimeOffset: 0 })).toBe(Infinity);
  });
});
