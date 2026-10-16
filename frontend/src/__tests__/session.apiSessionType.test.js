// Session type, the HTTP side: every analytics / prediction call of
// utils/apiClient.js names the session type: a session_type query parameter
// for GET, a body field for POST, 'R' when the caller names none; the
// degradation body also carries session_now (D6), null when not given.
import { describe, it, expect, vi } from 'vitest';

const calls = [];
vi.mock('axios', () => {
  const instance = {
    get: vi.fn(async (url, config) => { calls.push(['GET', url, config?.params]); return { data: {} }; }),
    post: vi.fn(async (url, body) => { calls.push(['POST', url, body]); return { data: {} }; }),
    interceptors: { response: { use: vi.fn() } },
  };
  return { default: { create: vi.fn(() => instance) } };
});

const api = await import('../utils/apiClient.js');

describe('session_type on every analytics / prediction request', () => {
  it('GET analytics: the type as a query parameter, R by default', async () => {
    calls.length = 0;
    await api.getSectors(2024, 8, 'Q');
    await api.getConsistency(2024, 5, 'S');
    await api.getSpeedRankings(2026, 1, 'FP2');
    await api.getStrategy(2024, 5, 'S');
    await api.getSectors(2024, 16);
    expect(calls).toEqual([
      ['GET', '/analytics/sectors/2024/8', { session_type: 'Q' }],
      ['GET', '/analytics/consistency/2024/5', { session_type: 'S' }],
      ['GET', '/analytics/speed-rankings/2026/1', { session_type: 'FP2' }],
      ['GET', '/strategy/2024/5', { session_type: 'S' }],
      ['GET', '/analytics/sectors/2024/16', { session_type: 'R' }],
    ]);
  });

  it('POST predictions: session_type in the body (R by default), degradation also session_now', async () => {
    calls.length = 0;
    await api.predictDegradation({ year: 2024, round: 16, drivers: ['PIA'], lap_start: 10, lap_end: 25 });
    await api.predictDegradation({ year: 2024, round: 5, drivers: ['NOR'], lap_start: 3, lap_end: 9, session_type: 'S', session_now: 4321.5 });
    await api.predictLSTM({ year: 2024, round: 16, driver: 'PIA', lap: 20 });
    await api.predictLSTM({ year: 2024, round: 16, driver: 'PIA', lap: 20, session_type: 'FP2' });
    expect(calls.map(([m, u, b]) => [m, u, b.session_type, b.session_now])).toEqual([
      ['POST', '/predict/degradation', 'R', null],
      ['POST', '/predict/degradation', 'S', 4321.5],
      ['POST', '/predict/lstm', 'R', undefined],
      ['POST', '/predict/lstm', 'FP2', undefined],
    ]);
  });
});
