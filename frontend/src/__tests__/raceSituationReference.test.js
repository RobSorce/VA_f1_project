// P10 (round 3): the Race Situation Map no longer jumps on backward
// navigation. During a replay the store turns lap L's refit onto lap L - 1's
// axes as a replay from the first lap draws them
// (utils/raceSituationReference.js), not onto whatever was computed last
// (a rewind used to drop that and refit with no reference: the map turned or
// mirrored). So a lap is drawn the same however it is reached: playing, a
// rewind, a one-lap step back, a seek forward. Live mode still follows the
// previous computation. Cached races (skipped where none is cached).
import { describe, it, expect, vi } from 'vitest';

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

const { useF1Store, laterClockReset } = await import('../store/useF1Store.js');
const { computePCA, LIVE_PCA_ALIGN } = await import('../utils/livePCA.js');
const { extractRaceSituationFeatures, FEATURE_NAMES } = await import('../utils/raceSituationFeatures.js');
const { resolveSessionNow, computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { replayChainAt, replayReferenceAt, FIRST_SITUATION_LAP } = await import('../utils/raceSituationReference.js');
const { hasCachedSession, loadCachedSession } = await import('./helpers/cachedSession.js');

const maxDiff = (A, B) => Math.max(...A.map((row, j) => Math.max(Math.abs(row[0] - B[j][0]), Math.abs(row[1] - B[j][1]))));

/** The store on a lap-mode replay of a cached race; seek(lap) = setCurrentLap's clock change + the map's recompute. */
function replay(year, round) {
  const lapTimes = loadCachedSession(year, round).lap_times;
  const maxLap = Math.max(...lapTimes.map((r) => r.LapNumber || 0));
  useF1Store.setState({
    sessionData: { lap_times: lapTimes }, loadedYear: year, loadedRound: round, loadedSessionType: 'R',
    isQualifyingReplay: false, maxLap, sessionTimeOffset: computeSessionTimeOffset(lapTimes),
    isLiveMode: false, totalFrames: 0, frameData: null, dnfMap: {}, lapModeRaceOver: false,
    raceSituationData: null, raceSituationLap: null, _prevPcaResult: null, currentLap: 1,
    // (the Monte Carlo projection each new situation triggers is not under test)
    computeRaceProjection: () => {},
  });
  const seek = (lap) => {
    const s = useF1Store.getState();
    const now = resolveSessionNow({ currentLap: lap, lapTimes });
    useF1Store.setState({ currentLap: lap, ...laterClockReset(s, now) });
    useF1Store.getState().computeRaceSituation();
    const st = useF1Store.getState();
    return { basis: st._prevPcaResult.basis, rsd: st.raceSituationData };
  };
  return { lapTimes, maxLap, seek };
}

describe.skipIf(!hasCachedSession(2024, 16))('the replay reference (Monza 2024, R16)', () => {
  const lapTimes = hasCachedSession(2024, 16) ? loadCachedSession(2024, 16).lap_times : [];

  it('replayChainAt is the forward chain of the lap clocks, lap by lap', () => {
    let prev = null;
    for (let lap = FIRST_SITUATION_LAP; lap <= 53; lap++) {
      const now = resolveSessionNow({ currentLap: lap, lapTimes });
      const res = extractRaceSituationFeatures({ lapTimes, currentLap: lap, dnfMap: {}, sessionNow: now });
      const p = res ? computePCA(res.matrix, FEATURE_NAMES, prev, { align: LIVE_PCA_ALIGN }) : null;
      if (p) prev = p;
      const at = replayChainAt(lapTimes, lap);
      if (!prev) { expect(at).toBeNull(); continue; } // no fit yet
      expect(maxDiff(at.result.basis, prev.basis)).toBe(0);
      expect(at.now).toBeLessThanOrEqual(now);
    }
  });

  it('causal: the reference is never fitted after the clock on screen', () => {
    const lap20 = resolveSessionNow({ currentLap: 20, lapTimes });
    const lap19 = resolveSessionNow({ currentLap: 19, lapTimes });
    // at lap 21 the reference is lap 20's axes, fitted at the start of lap 20
    expect(replayReferenceAt(lapTimes, 21, { sessionNow: lap20 + 1 })).toBe(replayChainAt(lapTimes, 20).result);
    // a clock before that start: lap 19's
    expect(replayReferenceAt(lapTimes, 21, { sessionNow: (lap19 + lap20) / 2 })).toBe(replayChainAt(lapTimes, 19).result);
    expect(replayReferenceAt(lapTimes, FIRST_SITUATION_LAP)).toBeNull();
  });

  it('the store: a rewind 40 -> 20 and every lap after it are drawn as playing drew them', () => {
    const { seek } = replay(2024, 16);
    const fwd = new Map();
    for (let lap = 4; lap <= 40; lap++) fwd.set(lap, seek(lap));
    for (let lap = 20; lap <= 40; lap++) {
      const again = seek(lap);
      expect(maxDiff(again.basis, fwd.get(lap).basis), `lap ${lap}`).toBeLessThan(1e-12);
      again.rsd.scores.forEach((p, i) => {
        expect(Math.hypot(p.x - fwd.get(lap).rsd.scores[i].x, p.y - fwd.get(lap).rsd.scores[i].y)).toBeLessThan(1e-9);
      });
    }
  });

  it('the store: one step back from every lap draws the lap before as playing drew it', () => {
    const { seek, maxLap } = replay(2024, 16);
    const fwd = new Map();
    for (let lap = 4; lap <= maxLap; lap++) fwd.set(lap, seek(lap));
    for (let lap = maxLap; lap > 4; lap--) {
      seek(lap);
      const back = seek(lap - 1);
      expect(maxDiff(back.basis, fwd.get(lap - 1).basis), `step back ${lap} -> ${lap - 1}`).toBeLessThan(1e-12);
    }
  });

  it('a seek straight to a late lap draws it as playing to it does', () => {
    const { seek } = replay(2024, 16);
    const direct = seek(45);
    const played = replay(2024, 16);
    let last = null;
    for (let lap = 4; lap <= 45; lap++) last = played.seek(lap);
    expect(maxDiff(direct.basis, last.basis)).toBeLessThan(1e-12);
  });

  it('live mode keeps following the previous computation (_prevPcaResult)', () => {
    replay(2024, 16);
    const turned = replayChainAt(lapTimes, 29).result;
    // a reference turned by 90 degrees in its plane: the live refit follows it
    const ref = { ...turned, basis: turned.basis.map(([a, b]) => [-b, a]) };
    useF1Store.setState({ isLiveMode: true, currentLap: 30, raceSituationLap: null, _prevPcaResult: ref });
    useF1Store.getState().computeRaceSituation();
    const live = useF1Store.getState()._prevPcaResult;
    const replayed = computePCA(
      extractRaceSituationFeatures({
        lapTimes, currentLap: 30, dnfMap: {}, sessionNow: Infinity, isLiveMode: true,
      }).matrix, FEATURE_NAMES, ref, { align: LIVE_PCA_ALIGN },
    );
    expect(maxDiff(live.basis, replayed.basis)).toBeLessThan(1e-12);
    useF1Store.setState({ isLiveMode: false });
  });
});
