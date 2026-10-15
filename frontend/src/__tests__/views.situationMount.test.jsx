// Minor backlog P13 (Race Situation Map): opened mid-race (the race situation
// already in the store when the map mounts), the first lap after the mount
// draws a trail segment. The session-reset effect is declared before the
// effect that advances the drawn state, so on mount it no longer wipes the
// first advance. Also: the dots and labels of the map are drawn in the
// palette module's colours (driver mark >= 3:1, compound badge letter).
import { describe, it, expect, vi, afterAll } from 'vitest';
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
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: RaceSituationMap } = await import('../components/visualizations/RaceSituationMap.jsx');
const { tyreLetter } = await import('../utils/colors.js');

const INITIAL = useF1Store.getState();
const ABBRS = ['AAA', 'BBB', 'CCC'];
const FEAT = (compoundName) => ({
  position: 1, recentPace: 90, paceTrend: 0, compoundName, tyreLife: 5, stintNumber: 1, pitStops: 0,
  estLapsToPit: 10, estLapsToPitSource: 'race', predictedPace5: 90,
});
const rsd = (lap, dx) => ({
  driverAbbrs: ABBRS,
  scores: [{ x: dx, y: 0 }, { x: 1, y: 1 }, { x: -1, y: 0.5 }],
  loadings: [],
  explainedVariance: [0.5, 0.3],
  driverFeatures: { AAA: FEAT('SOFT'), BBB: FEAT('MEDIUM'), CCC: FEAT('HARD') },
  computedAtLap: lap,
  computedAtNow: 1000 + lap * 90,
  paceInPca: true,
});

afterAll(() => useF1Store.setState(INITIAL));

describe('backlog P13: mounted mid-race, the first new lap draws a trail segment', () => {
  it('mount with lap 10 in the store, then lap 11: one segment per driver; badges carry the compound letter', async () => {
    useF1Store.setState({
      ...INITIAL,
      sessionData: { session_info: { year: 2024, round: 16 }, lap_times: [] },
      drivers: [],
      currentLap: 10,
      raceSituationData: rsd(10, 0),
      computeRaceSituation: () => {},
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 600, height: 420 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(RaceSituationMap)); });
    await act(async () => { useF1Store.setState({ raceSituationData: rsd(11, 3), currentLap: 11 }); });
    const segments = host.querySelectorAll('.trails-layer line').length;
    console.log(`trail segments after the first lap since the mount: ${segments}`);
    expect(segments).toBe(ABBRS.length);
    const letters = [...host.querySelectorAll('.tyre-letter')].map((t) => t.textContent);
    expect(letters).toEqual(['SOFT', 'MEDIUM', 'HARD'].map(tyreLetter));
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
