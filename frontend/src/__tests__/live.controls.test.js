// The live-timing controls change the backend's state, so they are POSTs with
// a JSON body (an empty object when they take no parameter): the backend
// answers 405 to a GET and 415 to a POST without JSON (backend/api/commands.py,
// backend/tests/test_live_controls.py). Reads stay GET. axios is a mock that
// records what each apiClient call sends.
import { describe, it, expect, vi } from 'vitest';

const sent = [];
vi.mock('axios', () => {
  const record = (method) => vi.fn(async (url, a) => {
    sent.push({ method, url, body: method === 'POST' ? a : undefined, params: method === 'GET' ? a?.params : undefined });
    return { data: { status: 'ok' } };
  });
  const instance = {
    get: record('GET'),
    post: record('POST'),
    interceptors: { response: { use: vi.fn() } },
  };
  return { default: { create: vi.fn(() => instance) } };
});

const api = await import('../utils/apiClient.js');

async function sends(fn) {
  sent.length = 0;
  await fn();
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe('live controls are JSON POSTs', () => {
  it('each control posts a JSON object to its route', async () => {
    expect(await sends(() => api.connectSignalR())).toEqual({ method: 'POST', url: '/live/connect-signalr', body: { reset: false } });
    expect(await sends(() => api.connectSignalR(true))).toEqual({ method: 'POST', url: '/live/connect-signalr', body: { reset: true } });
    expect(await sends(() => api.disconnectSignalR())).toEqual({ method: 'POST', url: '/live/disconnect-signalr', body: {} });
    expect(await sends(() => api.startMockReplay(2024, 16, 20)))
      .toEqual({ method: 'POST', url: '/live/mock/start', body: { year: 2024, round: 16, speed: 20 } });
    expect(await sends(() => api.startMockReplay(2024, 7)))
      .toEqual({ method: 'POST', url: '/live/mock/start', body: { year: 2024, round: 7, speed: 10 } });
    expect(await sends(() => api.stopMockReplay())).toEqual({ method: 'POST', url: '/live/mock/stop', body: {} });
    expect(await sends(() => api.startOpenF1Telemetry(9158)))
      .toEqual({ method: 'POST', url: '/live/openf1/start', body: { session_key: 9158 } });
    expect(await sends(() => api.startOpenF1Telemetry()))
      .toEqual({ method: 'POST', url: '/live/openf1/start', body: { session_key: null } });
    expect(await sends(() => api.stopOpenF1Telemetry())).toEqual({ method: 'POST', url: '/live/openf1/stop', body: {} });
  });

  it('the reads stay GET', async () => {
    for (const fn of [api.getLiveStatus, api.getLiveSnapshot, api.getLiveFrames, api.getMockSessions,
      api.getOpenF1Status, api.loadLiveFullSession]) {
      expect((await sends(() => fn())).method).toBe('GET');
    }
  });

  it('no live control is sent as a GET', async () => {
    const CONTROLS = ['connect-signalr', 'disconnect-signalr', 'mock/start', 'mock/stop', 'openf1/start', 'openf1/stop', 'reset', 'load-team-radios'];
    sent.length = 0;
    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn !== 'function' || name === 'setHealthReporter') continue;
      if (!/SignalR|MockReplay|OpenF1Telemetry/.test(name)) continue;
      await fn(2024, 16, 10);
    }
    const gets = sent.filter((s) => s.method === 'GET' && CONTROLS.some((c) => s.url === `/live/${c}`));
    expect(gets).toEqual([]);
    expect(sent.filter((s) => s.method === 'POST')).toHaveLength(6);
  });
});
