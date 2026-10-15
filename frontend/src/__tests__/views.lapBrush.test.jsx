// V7: Position by Lap <-> Timing Sheet through brushLapRange, both ways, in
// the mounted Timing Sheet (components/visualizations/LapTimeChart.jsx):
//  - a drag on its lap-range bar writes the shared brushed range
//    (brushLapRange, which Position by Lap draws and brushes) and the selected
//    range of the other readers (selectedLapRange); a click clears both;
//  - a range brushed in Position by Lap (setBrushLapRange) is drawn on the bar.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: LapTimeChart } = await import('../components/visualizations/LapTimeChart.jsx');
const { UI_COLORS } = await import('../utils/colors.js');

const INITIAL = useF1Store.getState();
const LAPS = 20;
// Two drivers, LAPS laps of 90 s, all completed (lap mode, no replay frames)
function lapTable() {
  const rows = [];
  for (const [i, d] of ['VER', 'LEC'].entries()) {
    for (let lap = 1; lap <= LAPS; lap++) {
      rows.push({
        Driver: d, LapNumber: lap, LapTimeSeconds: 90 + i * 0.3, Position: i + 1,
        LapStartTime: 3600 + (lap - 1) * 90, Time: 3600 + lap * 90 + i * 0.3,
        Sector1TimeSeconds: 30, Sector2TimeSeconds: 30, Sector3TimeSeconds: 30 + i * 0.3,
        Compound: 'MEDIUM', TyreLife: lap, Stint: 1, TrackStatus: '1',
      });
    }
  }
  return rows;
}

let host;
let root;
beforeAll(async () => {
  useF1Store.setState({
    ...INITIAL,
    sessionData: { lap_times: lapTable(), drivers: [], race_results: [] },
    sessionType: 'R',
    loadedSessionType: 'R',
    maxLap: LAPS,
    totalRaceLaps: LAPS,
    currentLap: LAPS,
    totalFrames: 0,
    brushLapRange: null,
    selectedLapRange: null,
  });
  host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 600, height: 500 });
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(LapTimeChart)); });
});
afterAll(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  useF1Store.setState(INITIAL);
});

const bar = () => host.querySelector('.lap-range-brush__bar');
const selection = () => host.querySelector('.lap-range-brush__selection');
// x of a lap on the bar (lapToX: (lap - 1) / (maxLap - 1) * width)
const xOf = (lap, width) => ((lap - 1) / (LAPS - 1)) * width;

describe('V7: the Timing Sheet lap-range bar and brushLapRange', () => {
  it('a drag writes brushLapRange and selectedLapRange; the bar shows it', async () => {
    const el = bar();
    expect(el, 'lap-range bar').toBeTruthy();
    dom.setRect(el, { left: 10, top: 400, width: 380, height: 16 });
    await act(async () => {
      dom.mouse(el, 'mousedown', { clientX: 10 + xOf(5, 380), clientY: 408, button: 0 });
      dom.mouse(dom.window, 'mousemove', { clientX: 10 + xOf(12, 380), clientY: 408 });
      dom.mouse(dom.window, 'mouseup', { clientX: 10 + xOf(12, 380), clientY: 408 });
    });
    const s = useF1Store.getState();
    console.log('after the drag: brushLapRange', s.brushLapRange, 'selectedLapRange', s.selectedLapRange);
    expect(s.brushLapRange).toEqual([5, 12]);
    expect(s.selectedLapRange).toEqual([5, 12]);
    expect(selection()?.getAttribute('data-range')).toBe('5-12');
  });

  it('a range brushed in Position by Lap (setBrushLapRange) is drawn on the bar, in the brush colour', async () => {
    await act(async () => { useF1Store.getState().setBrushLapRange([3, 9]); });
    const sel = selection();
    expect(sel?.getAttribute('data-range')).toBe('3-9');
    expect(UI_COLORS.brush).toBe('#8AB4F8');
    expect(`${sel.style.borderLeft}${sel.style.borderLeftColor || ''}`.toLowerCase()).toMatch(/8ab4f8|138, ?180, ?248/);
  });

  it('a click on the bar clears both ranges', async () => {
    const el = bar();
    await act(async () => {
      dom.mouse(el, 'mousedown', { clientX: 10 + xOf(7, 380), clientY: 408, button: 0 });
      dom.mouse(dom.window, 'mouseup', { clientX: 10 + xOf(7, 380), clientY: 408 });
    });
    const s = useF1Store.getState();
    expect(s.brushLapRange).toBeNull();
    expect(s.selectedLapRange).toBeNull();
    expect(selection()).toBeNull();
  });
});

describe('backlog L3: a second double-click on the focus driver asks the forecast again', () => {
  it('the focus stays on the driver and the forecast is asked on every double-click', async () => {
    const asked = [];
    useF1Store.setState({ focusDriver: null, triggerPrediction: (d, lap) => { asked.push([d, lap, useF1Store.getState().focusDriver]); } });
    await act(async () => { root.render(React.createElement(LapTimeChart)); });
    const row = () => host.querySelector('[data-driver="LEC"]');
    expect(row(), 'LEC row').toBeTruthy();
    await act(async () => { dom.mouse(row(), 'dblclick', { clientX: 50, clientY: 50, button: 0 }); });
    await act(async () => { dom.mouse(row(), 'dblclick', { clientX: 50, clientY: 50, button: 0 }); });
    console.log('forecast asked:', JSON.stringify(asked));
    expect(useF1Store.getState().focusDriver).toBe('LEC');
    expect(asked).toEqual([['LEC', LAPS, 'LEC'], ['LEC', LAPS, 'LEC']]);
  });
});
