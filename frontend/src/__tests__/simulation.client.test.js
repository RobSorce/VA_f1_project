// The simulation client and its worker (S4): jobs run off the main thread in
// a module worker, a synchronous fallback where Worker does not exist, stale
// jobs never reach a callback, the lap table is cloned to the worker once.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createSimulationClient, runSimulationJob, planFromStints, unpackParams,
} from '../utils/simulationClient.js';
import { handleJobMessage } from '../workers/raceSimulation.worker.js';
import { extractRaceSituationFeatures } from '../utils/raceSituationFeatures.js';
import { computeSessionTimeOffset, resolveSessionNow } from '../utils/raceTime.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

/**
 * A Worker stand-in: messages are structured-cloned both ways and handled by
 * the real worker module (handleJobMessage) on a later macrotask, as a worker
 * thread would. `posted` records what the main thread sent.
 */
class FakeWorker {
  constructor() {
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  postMessage(data) {
    const msg = structuredClone(data);
    this.posted.push(msg);
    setTimeout(() => {
      if (this.terminated) return;
      if (FakeWorker.failNext) {
        FakeWorker.failNext = false;
        this.onerror?.({ message: 'boom', preventDefault() {} });
        return;
      }
      handleJobMessage(msg, (reply) => {
        const back = structuredClone(reply);
        setTimeout(() => { if (!this.terminated) this.onmessage?.({ data: back }); }, 0);
      });
    }, 0);
  }

  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];
FakeWorker.failNext = false;

// A job whose result names its own input, so a test can tell results apart
const echoParams = (tag) => ({ driverFeatures: null, currentLap: 1, maxLap: 2, tag });

afterEach(() => {
  vi.useRealTimers();
  FakeWorker.instances = [];
  FakeWorker.failNext = false;
});

describe('planFromStints: a Strategy Simulator plan as planned stops', () => {
  it('stint i + 1 starting on lap L is a stop at the end of lap L - 1 onto its compound', () => {
    expect(planFromStints([
      { compound: 'MEDIUM', lapStart: 1, length: 20 },
      { compound: 'hard', lapStart: 21, length: 15 },
      { compound: 'SOFT', lapStart: 36, length: 17 },
    ])).toEqual([{ lap: 20, compound: 'HARD' }, { lap: 35, compound: 'SOFT' }]);
    // order of the rows does not matter; one stint = no stop
    expect(planFromStints([{ compound: 'SOFT', lapStart: 30, length: 5 }, { compound: 'HARD', lapStart: 1, length: 29 }]))
      .toEqual([{ lap: 29, compound: 'SOFT' }]);
    expect(planFromStints([{ compound: 'HARD', lapStart: 1, length: 53 }])).toEqual([]);
    expect(planFromStints(null)).toEqual([]);
  });
});

describe('client without Worker: synchronous fallback', () => {
  it('runs the job before request() returns, with the same result as runSimulationJob', () => {
    const client = createSimulationClient({ createWorker: null });
    let got;
    client.request('projection', 'project', echoParams('a'), (r, e) => { got = { r, e }; });
    expect(got).toEqual({ r: null, e: null }); // simulateRaceFinish: null without drivers
    expect(client.mode()).toBe('sync');
  });

  it('a job that throws reaches the callback as an error', () => {
    const client = createSimulationClient();
    let err;
    client.request('x', 'nope', {}, (r, e) => { err = e; });
    expect(String(err)).toMatch(/Unknown simulation job/);
  });

  it('a factory that throws (no module workers) falls back to synchronous', () => {
    const client = createSimulationClient({ createWorker: () => { throw new Error('no module worker'); } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let called = false;
    client.request('projection', 'project', echoParams('a'), () => { called = true; });
    expect(called).toBe(true);
    expect(client.mode()).toBe('sync');
    warn.mockRestore();
  });
});

describe('client with a worker: off the main thread, latest request wins', () => {
  it('the result arrives later, not inside request()', async () => {
    vi.useFakeTimers();
    const client = createSimulationClient({ createWorker: () => new FakeWorker() });
    const cb = vi.fn();
    client.request('projection', 'project', echoParams('a'), cb);
    expect(cb).not.toHaveBeenCalled();
    expect(client.mode()).toBe('worker');
    await vi.runAllTimersAsync();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('while a job runs, newer requests wait; only the newest waiting one is sent; stale results are dropped', async () => {
    vi.useFakeTimers();
    const client = createSimulationClient({ createWorker: () => new FakeWorker() });
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const other = vi.fn();
    client.request('projection', 'project', echoParams('a'), a);
    client.request('projection', 'project', echoParams('b'), b); // waits
    client.request('projection', 'project', echoParams('c'), c); // replaces b
    client.request('whatif', 'project', echoParams('w'), other); // its own channel: sent at once
    await vi.runAllTimersAsync();
    const w = FakeWorker.instances[0];
    expect(w.posted.map((m) => m.params.tag)).toEqual(['a', 'w', 'c']); // b never sent
    expect(a).not.toHaveBeenCalled(); // superseded while in the worker
    expect(b).not.toHaveBeenCalled();
    expect(c).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('cancel(channel): nothing requested so far reaches a callback', async () => {
    vi.useFakeTimers();
    const client = createSimulationClient({ createWorker: () => new FakeWorker() });
    const a = vi.fn();
    const b = vi.fn();
    client.request('projection', 'project', echoParams('a'), a);
    client.request('projection', 'project', echoParams('b'), b);
    client.cancel('projection');
    await vi.runAllTimersAsync();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(FakeWorker.instances[0].posted).toHaveLength(1); // b was never sent
  });

  it('a worker that fails runs the pending jobs synchronously from then on', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createSimulationClient({ createWorker: () => new FakeWorker() });
    FakeWorker.failNext = true;
    const a = vi.fn();
    client.request('projection', 'project', echoParams('a'), a);
    await vi.runAllTimersAsync();
    expect(a).toHaveBeenCalledTimes(1); // re-run on the main thread
    expect(client.mode()).toBe('sync');
    expect(FakeWorker.instances[0].terminated).toBe(true);
    const b = vi.fn();
    client.request('projection', 'project', echoParams('b'), b);
    expect(b).toHaveBeenCalledTimes(1); // synchronous now
    warn.mockRestore();
  });

  it('a job that cannot be cloned runs here; the lap table it carried is sent again with the next job', async () => {
    vi.useFakeTimers();
    const client = createSimulationClient({ createWorker: () => new FakeWorker() });
    const lapTimes = [{ Driver: 'AAA', LapNumber: 1 }];
    const a = vi.fn();
    client.request('projection', 'project', { ...echoParams('a'), lapTimes, running: () => true }, a);
    expect(a).toHaveBeenCalledTimes(1); // DataCloneError: run on this thread at once
    client.request('projection', 'project', { ...echoParams('b'), lapTimes }, () => {});
    await vi.runAllTimersAsync();
    const sent = FakeWorker.instances[0].posted;
    expect(sent).toHaveLength(1);
    expect(sent[0].params.lapTimes.data).toEqual(lapTimes); // not a bare reference
  });

  it('the lap table is cloned to the worker once per array, then sent by reference', async () => {
    vi.useFakeTimers();
    const client = createSimulationClient({ createWorker: () => new FakeWorker() });
    const lapTimes = [{ Driver: 'AAA', LapNumber: 1 }];
    const trackStatus = [];
    for (const tag of ['a', 'b']) {
      client.request('projection', 'project', { ...echoParams(tag), lapTimes, trackStatus }, () => {});
      await vi.runAllTimersAsync();
    }
    const other = [{ Driver: 'BBB', LapNumber: 1 }];
    client.request('projection', 'project', { ...echoParams('c'), lapTimes: other, trackStatus }, () => {});
    await vi.runAllTimersAsync();
    const sent = FakeWorker.instances[0].posted.map((m) => m.params.lapTimes);
    expect(sent[0].data).toEqual(lapTimes);
    expect(sent[1]).toEqual({ $dataset: sent[0].$dataset }); // no data: the worker has it
    expect(sent[2].data).toEqual(other);
    expect(sent[2].$dataset).not.toBe(sent[0].$dataset);
    // the worker side resolves a reference to the array it holds, and refuses an unknown one
    const store = {};
    expect(unpackParams({ lapTimes: { $dataset: 7, data: [1] } }, store).lapTimes).toEqual([1]);
    expect(unpackParams({ lapTimes: { $dataset: 7 } }, store).lapTimes).toEqual([1]);
    expect(() => unpackParams({ lapTimes: { $dataset: 8 } }, store)).toThrow(/missing/);
  });
});

const haveMonza = hasCachedSession(2024, 16);

describe.skipIf(!haveMonza)('the worker computes what the main thread computes (Monza 2024, lap 30)', () => {
  it('same params and seed: the worker reply equals runSimulationJob on the main thread', async () => {
    const monza = loadCachedSession(2024, 16);
    const lapTimes = monza.lap_times;
    const sessionNow = resolveSessionNow({ currentLap: 30, lapTimes });
    const offset = computeSessionTimeOffset(lapTimes);
    const rsd = extractRaceSituationFeatures({ lapTimes, currentLap: 30, dnfMap: {}, sessionNow, sessionTimeOffset: offset });
    const params = {
      driverFeatures: rsd.driverFeatures, currentLap: 30, maxLap: 53, lapTimes, trackStatus: monza.track_status,
      sessionNow, sessionTimeOffset: offset, sessionType: 'R', running: false, dnfMap: {}, seed: 12345,
      numSimulations: 200,
    };
    const direct = runSimulationJob('project', params);
    let reply;
    handleJobMessage(structuredClone({ id: 1, kind: 'project', params }), (r) => { reply = structuredClone(r); });
    expect(reply.id).toBe(1);
    expect(reply.error).toBeUndefined();
    expect(reply.result.projections).toEqual(direct.projections);
    expect(reply.result.battles).toEqual(direct.battles);
    expect(reply.result.seed).toBe(12345);
    // a job error comes back as { id, error }, never as a throw in the worker
    handleJobMessage({ id: 2, kind: 'nope', params: {} }, (r) => { reply = r; });
    expect(reply).toEqual({ id: 2, error: 'Unknown simulation job: nope' });
  });
});
