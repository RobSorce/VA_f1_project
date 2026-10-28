// The Lap Delta chart reads the race trace on the focus reference
// (utils/raceTrace.js): on the five tracked demo races (frontend/public/data)
// each driver's delta to the base is the difference of the two lap rows'
// Time, lap by lap, and the chart draws that value.
//
// It summed LapTimeSeconds and skipped the laps without one (0 < t < 300):
// against the winner that was off by up to 475.063 s in 2024 R5 (SAR, lap 44),
// 162.980 s in 2024 R7 (ALB, lap 37) and 193.779 s in 2025 R1 (PIA, lap 54);
// 0.000 s in 2024 R16 and 2025 R16, where every row has a lap time.
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
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
const { computeSessionTimeOffset, resolveSessionNow } = await import('../utils/raceTime.js');
const { lapDeltaSeries } = await import('../utils/views/lapDeltaChart.js');
const { buildRaceTrace, isTruncatedRow } = await import('../utils/raceTrace.js');
const { perturbFuture } = await import('../utils/__tests__/futureRows.js');
const { setSessionDriverColors, signedDelta } = await import('../utils/colors.js');
const { default: LapDeltaChart } = await import('../components/visualizations/LapDeltaChart.jsx');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../public/data');
const demo = (year, round) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, `${year}_${round}_R/session.json.gz`))));
const RACES = [[2024, 16], [2024, 5], [2024, 7], [2025, 16], [2025, 1]];
const INITIAL = useF1Store.getState();

const winnerOf = (s) => s.race_results.find((r) => String(r.ClassifiedPosition) === '1').Abbreviation;
function timeIndex(lt) {
  const t = {};
  for (const r of lt) if (!isTruncatedRow(r)) (t[r.Driver] ??= {})[r.LapNumber] = r.Time;
  return t;
}

describe('Lap Delta = the Time differences (demo races)', () => {
  for (const [year, round] of RACES) {
    it(`${year} R${round}: every driver, every lap both completed, against the winner and a midfield base`, () => {
      const s = demo(year, round);
      const lt = s.lap_times;
      const T = timeIndex(lt);
      const midfield = buildRaceTrace(lt).drivers[9].driver;
      for (const base of [winnerOf(s), midfield]) {
        const series = lapDeltaSeries(lt, { base, trackStatus: s.track_status });
        const trace = buildRaceTrace(lt, { trackStatus: s.track_status, reference: 'focus', focusDriver: base });
        let n = 0;
        for (const [d, points] of Object.entries(series)) {
          for (const p of points) {
            expect(Math.abs(p.delta - (T[d][p.lap] - T[base][p.lap]))).toBeLessThan(1e-9);
            // the same value as the Race Trace on the focus reference, sign turned
            const q = trace.drivers.find((x) => x.driver === d).points.find((x) => x.lap === p.lap && !x.start);
            expect(p.delta).toBe(-q.y);
            n += 1;
          }
        }
        // every pair of rows with a Time on a lap the base completed
        let expected = 0;
        for (const d of Object.keys(T)) for (const lap of Object.keys(T[d])) if (T[base][lap] != null) expected += 1;
        expect(n).toBe(expected);
        expect(series[base].every((p) => p.delta === 0)).toBe(true);
      }
    });
  }

  it('causal: the rows after the clock change nothing (2024 R5, three clocks)', () => {
    const s = demo(2024, 5);
    const lt = s.lap_times;
    for (const lap of [10, 25, 40]) {
      const now = resolveSessionNow({ currentLap: lap, lapTimes: lt }) + 41;
      const opts = { base: 'VER', sessionNow: now, trackStatus: s.track_status };
      expect(lapDeltaSeries(perturbFuture(lt, now), opts)).toEqual(lapDeltaSeries(lt, opts));
    }
  });
});

describe('the chart draws those values (2024 R5, race over)', () => {
  let view = null;
  afterAll(async () => {
    if (view) await view.unmount();
    useF1Store.setState({ ...INITIAL });
  });

  it('end labels read the Time difference on the last lap both completed', async () => {
    const s = demo(2024, 5);
    const lt = s.lap_times;
    setSessionDriverColors(s.driver_info);
    const maxLap = Math.max(...lt.map((r) => r.LapNumber));
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 5, sessionType: 'R',
      sessionData: s, trackStatus: s.track_status,
      sessionTimeOffset: computeSessionTimeOffset(lt),
      maxLap, totalRaceLaps: maxLap, currentLap: maxLap, lapModeRaceOver: true,
      totalFrames: 0, currentTime: 0,
      focusDriver: 'VER', lapDeltaBaseDriver: 'VER', selectedDrivers: ['NOR', 'SAR'],
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 900, height: 420 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(LapDeltaChart)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    view = { async unmount() { await act(async () => { root.unmount(); }); host.remove(); } };

    const T = timeIndex(lt);
    const labels = host.querySelectorAll('text').map((t) => t.textContent);
    for (const d of ['NOR', 'SAR']) {
      const laps = Object.keys(T[d]).map(Number).filter((k) => T.VER[k] != null);
      const last = Math.max(...laps);
      expect(labels).toContain(`${d} ${signedDelta(T[d][last] - T.VER[last], 1)}s`);
    }
  });
});
