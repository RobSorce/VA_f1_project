// Tyre Degradation draws at the size of the svg on
// screen. The chart's svg shares .deg-manager (a flex column) with the fit
// note and, with a projected pit window, the pit-window row. It used to
// measure .deg-manager, so its viewBox was taller than the svg drawn and
// preserveAspectRatio "meet" scaled the whole chart down: at the Tyres preset
// at 1536 x 750 (box 548 x 480, a two-line note) every label read at 0.938 of
// its size, 10.31 px data text and 9.38 px labels, under the floors.
// The svg now fills .deg-plot, the row the note leaves, and that row is the
// box it measures.
//
// The mini DOM gives an element without a rect its parent's rect, so here the
// rows are laid out as a browser does: .deg-manager 548 x 480, .deg-plot the
// 548 x 450 above a 30 px note, the svg (absolute, inset 0) over .deg-plot.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMiniDom } from './helpers/miniDom.js';
import { parseCss } from './helpers/layoutCss.js';

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
const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
await import('d3');
const { useF1Store } = await import('../store/useF1Store.js');
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { installResizeObserverMock, syntheticSession } = await import('./helpers/chartFixtures.js');
const { screenTexts, underFloor } = await import('./helpers/screenFont.js');
const { default: TireDegradation } = await import('../components/visualizations/TireDegradation.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const VP = { W: 1536, H: 750 };

const settle = () => act(async () => {
  ro.flushFrames();
  await new Promise((r) => setTimeout(r, 0));
  ro.flushFrames();
});

describe('Tyre Degradation: the viewBox is the box the svg is drawn in', () => {
  it('Tyres preset at 1536 x 750: box 548 x 480, a 30 px fit note under the chart: drawn at scale 1, no label under its floor', async () => {
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R',
      sessionData: SESSION, circuitInfo: SESSION.circuit_info, trackStatus: SESSION.track_status,
      sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
      maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true,
      totalFrames: 0, currentTime: 0, focusDriver: 'NOR', selectedDrivers: ['NOR'],
    });
    const BOX = { width: 548, height: 480 };
    const NOTE_H = 30;
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, ...BOX });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(TireDegradation)); });
    await settle();
    try {
      const manager = host.querySelector('.deg-manager');
      const plot = manager.querySelector('.deg-plot');
      const svg = plot.querySelector('svg');
      expect(svg.parentElement).toBe(plot);
      // the note and the svg are not in the same box any more
      expect(plot.querySelector('.deg-fit-note')).toBeNull();
      expect(manager.querySelector(':scope > .deg-fit-note')).toBeTruthy();

      // the browser's layout: the note's 30 px under the plot row
      dom.setRect(manager, { left: 0, top: 0, ...BOX });
      dom.setRect(plot, { left: 0, top: 0, width: BOX.width, height: BOX.height - NOTE_H });
      dom.setRect(svg, { left: 0, top: 0, width: BOX.width, height: BOX.height - NOTE_H });
      await act(async () => { ro.notify(plot, BOX.width, BOX.height - NOTE_H); });
      await settle();

      expect(svg.getAttribute('viewBox')).toBe(`0 0 ${BOX.width} ${BOX.height - NOTE_H}`);
      const texts = screenTexts(svg, VP);
      expect(texts.length).toBeGreaterThan(0);
      expect(underFloor(svg, VP)).toEqual([]);
      for (const t of texts) expect(t.screenPx).toBeGreaterThanOrEqual(10);
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      useF1Store.setState({ ...INITIAL });
    }
    // the file's first mount (the view's modules warmed up): about 2 s alone,
    // past the 5 s default when the machine is busy
  }, 20000);

  it('CSS: the plot row takes what the note and the pit window leave, the svg is laid over it', () => {
    const rules = parseCss(fs.readFileSync(path.join(SRC, 'styles/visualizations.css'), 'utf8'));
    const decl = (sel, prop) => rules.find((r) => r.selector === sel)?.decls.find((d) => d.prop === prop)?.value;
    expect(decl('.deg-manager .deg-plot', 'flex')).toBe('1');
    expect(decl('.deg-manager .deg-plot', 'min-height')).toBe('0');
    expect(decl('.deg-manager .deg-plot', 'position')).toBe('relative');
    expect(decl('.deg-manager .deg-plot svg', 'position')).toBe('absolute');
    expect(decl('.deg-manager .deg-plot svg', 'inset')).toBe('0');
    // no rule sizes the svg as a flex item of .deg-manager any more
    expect(rules.find((r) => r.selector === '.deg-manager svg')).toBeUndefined();
  });
});
