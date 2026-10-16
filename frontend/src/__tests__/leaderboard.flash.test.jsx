// The race tower's position-change flash restarted and was cut. The
// effect that put the flash class on a row ran on every replay frame (the
// standings are a new array each frame) and added the class again after the
// 1.2 s CSS animation had ended and removed it, while the change stayed
// displayed for 1.5 s: a second flash started at about 1.2 s and was cut at
// 1.5 s. Now a change flashes once: the class is set when the change appears
// and dropped when its animation ends (or when the change is no longer
// displayed), whatever the frames in between. Mounted in the mini DOM; the
// test advances the timers across the change, one replay frame every 100 ms,
// and ends the CSS animation at 1.2 s as a browser does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: Leaderboard } = await import('../components/visualizations/Leaderboard.jsx');

const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
const DRIVERS = ['D01', 'D02', 'D03'];

/** Ten laps; D01 leads D02 until lap 5, D02 crosses the line first from lap 6. */
function race() {
  const lap_times = [];
  const driver_info = DRIVERS.map((d) => ({ Abbreviation: d, FullName: `Driver ${d}` }));
  DRIVERS.forEach((d, i) => {
    for (let k = 1; k <= 10; k++) {
      const start = 1000 + 90 * (k - 1) + i * 0.5;
      const time = d === 'D02' && k >= 6 ? start + 89 : start + 90;
      lap_times.push({
        Driver: d, LapNumber: k, LapStartTime: start, Time: time, LapTimeSeconds: time - start,
        Position: i + 1, Compound: 'MEDIUM', TyreLife: k, Stint: 1, TrackStatus: '1',
      });
    }
  });
  return { lap_times, driver_info, race_results: [], track_status: [], weather_data: [] };
}

/** What a browser dispatches when a CSS animation of `el` ends. */
function animationEnd(el, animationName) {
  el.dispatchEvent({
    type: 'animationend', bubbles: true, cancelable: false, animationName, elapsedTime: 1.2, pseudoElement: '',
    timeStamp: Date.now(), defaultPrevented: false, _stop: false, _stopImmediate: false,
    preventDefault() {}, stopPropagation() { this._stop = true; }, stopImmediatePropagation() { this._stop = true; },
  });
}

beforeEach(() => {
  const data = race();
  useF1Store.setState({
    ...INITIAL, sessionData: data, drivers: data.driver_info, maxLap: 10, totalRaceLaps: 10, currentLap: 6,
    currentFrameIndex: 0, loadedSessionType: 'R', sessionType: 'R', focusDriver: null, selectedDrivers: [],
    computeRaceProjection: () => {}, computeRaceSituation: () => {},
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  useF1Store.setState({ ...INITIAL });
});

describe('One flash per position change', () => {
  it('the flash class stays through its animation, goes at animationend and does not come back on later frames', async () => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 288, height: 600 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(Leaderboard, { collapsed: false })); });
    const row = (d) => [...host.querySelectorAll('.tower-row')].find((r) => text(r.querySelector('.tower-row__driver-name')) === d);
    const flash = (d) => (/tower-row--(gained|lost)/.exec(row(d).getAttribute('class') || '') || [null, null])[1];

    try {
      expect(DRIVERS.map(flash)).toEqual([null, null, null]);
      // flash starts per driver: absent -> present between two samples
      const starts = { D01: 0, D02: 0, D03: 0 };
      const was = { D01: null, D02: null, D03: null };
      const sample = () => {
        for (const d of DRIVERS) {
          const now = flash(d);
          if (now && !was[d]) starts[d] += 1;
          was[d] = now;
        }
      };

      // lap 6 -> 7: lap 6 is completed, D02 passed D01
      await act(async () => { useF1Store.setState({ currentLap: 7 }); });
      sample();
      expect(flash('D02')).toBe('gained');
      expect(flash('D01')).toBe('lost');
      expect(flash('D03')).toBeNull();

      // replay frames every 100 ms for 2.5 s (each one a new standings array);
      // the CSS animation (1.2 s) ends at 1200 ms
      for (let t = 100, f = 1; t <= 2500; t += 100, f += 1) {
        await act(async () => {
          vi.advanceTimersByTime(100);
          useF1Store.setState({ currentFrameIndex: f });
        });
        if (t === 600) {
          // another animation of the row (its ▲ arrow) ending bubbles up: not the flash's end
          const arrow = row('D02').querySelector('.tower-row__arrow--active');
          expect(arrow).toBeTruthy();
          await act(async () => { animationEnd(arrow, 'arrow-pop'); });
        }
        if (t === 1200) {
          await act(async () => {
            animationEnd(row('D02'), 'position-gained-flash');
            animationEnd(row('D01'), 'position-lost-flash');
          });
        }
        sample();
        // not cut before its animation ends
        if (t < 1200) expect([flash('D01'), flash('D02')], `${t} ms`).toEqual(['lost', 'gained']);
        // and not started again after it
        if (t >= 1200) expect([flash('D01'), flash('D02')], `${t} ms`).toEqual([null, null]);
      }
      expect(starts).toEqual({ D01: 1, D02: 1, D03: 0 });
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });

  it('without an animationend (no animation run), the flash still ends with the displayed change (1.5 s)', async () => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 288, height: 600 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(Leaderboard, { collapsed: false })); });
    const row = (d) => [...host.querySelectorAll('.tower-row')].find((r) => text(r.querySelector('.tower-row__driver-name')) === d);
    try {
      await act(async () => { useF1Store.setState({ currentLap: 7 }); });
      expect(row('D02').getAttribute('class')).toContain('tower-row--gained');
      await act(async () => { vi.advanceTimersByTime(1400); useF1Store.setState({ currentFrameIndex: 1 }); });
      expect(row('D02').getAttribute('class')).toContain('tower-row--gained');
      await act(async () => { vi.advanceTimersByTime(200); useF1Store.setState({ currentFrameIndex: 2 }); });
      expect(row('D02').getAttribute('class')).not.toMatch(/tower-row--(gained|lost|animating)/);
      expect(row('D01').getAttribute('class')).not.toMatch(/tower-row--(gained|lost|animating)/);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
    }
  });
});
