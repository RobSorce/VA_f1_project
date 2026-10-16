// qualifyingOrder (utils/driverState.js) ranked
// laps deleted by the stewards (Deleted true, track limits) as valid times.
// A deleted lap now never ranks. The rule before this change is the same
// function on rows with the flag cleared ({...row, Deleted: false}).
// Synthetic rows, then the cached 2024 R8 qualifying (skipped when absent).
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

const { qualifyingOrder } = await import('../utils/driverState.js');
const { qualiSegmentWindows } = await import('../store/useF1Store.js');
const { hasCachedSession, hasCachedFrames, loadCachedSession, loadCachedFrames } = await import('./helpers/cachedSession.js');

const lap = (Driver, LapNumber, LapTimeSeconds, Time, extra = {}) => ({
  Driver, LapNumber, LapTimeSeconds, Time, LapStartTime: Time - LapTimeSeconds, ...extra,
});
const headRule = (rows, now, opts) => qualifyingOrder(rows.map((r) => ({ ...r, Deleted: false })), now, opts);
const order = (res) => res.map((r) => `${r.driver}${r.position ?? '-'}`);

describe('qualifyingOrder ignores deleted laps', () => {
  it('synthetic: a deleted faster lap does not rank; a driver with only a deleted lap has no time', () => {
    const rows = [
      lap('AAA', 2, 80.0, 1000, { Deleted: true, DeletedReason: 'TRACK LIMITS AT TURN 10 LAP 2' }),
      lap('AAA', 4, 81.0, 1200),
      lap('BBB', 2, 80.5, 1010),
      lap('CCC', 2, 79.9, 1020, { Deleted: true }),
    ];
    const now = qualifyingOrder(rows, Infinity);
    expect(order(now)).toEqual(['BBB1', 'AAA2', 'CCC-']);
    expect(now.find((r) => r.driver === 'AAA').best.LapNumber).toBe(4);
    expect(order(headRule(rows, Infinity))).toEqual(['CCC1', 'AAA2', 'BBB3']);
    // before AAA's valid lap is completed it has no time either
    expect(order(qualifyingOrder(rows, 1100))).toEqual(['BBB1', 'AAA-', 'CCC-']);
  });
});

const HAVE_Q = hasCachedSession(2024, 8, 'Q') && hasCachedFrames(2024, 8, 'Q');
describe.skipIf(!HAVE_Q)('cached 2024 R8 qualifying: deleted laps never rank', () => {
  const q = HAVE_Q ? loadCachedSession(2024, 8, 'Q') : { lap_times: [] };
  const segments = HAVE_Q ? loadCachedFrames(2024, 8, 'Q').segments : {};
  const windows = HAVE_Q ? qualiSegmentWindows(q.lap_times, segments) : {};

  it('at every lap completion of every segment: no best is a deleted lap; count of orders that changed', () => {
    const deleted = q.lap_times.filter((r) => r.Deleted === true);
    expect(deleted.length).toBeGreaterThan(0);
    const lines = [`deleted laps in the session: ${deleted.length}`];
    for (const seg of ['Q1', 'Q2', 'Q3']) {
      const w = windows[seg];
      expect(w).toBeTruthy();
      const drivers = Object.keys(segments[seg].driver_colors);
      const instants = [...new Set(q.lap_times
        .filter((r) => Number.isFinite(r.Time) && r.Time > w.start && r.Time <= w.end + 1e-6)
        .map((r) => r.Time))].sort((a, b) => a - b);
      let changed = 0;
      for (const now of instants) {
        const res = qualifyingOrder(q.lap_times, now, { drivers, after: w.start });
        for (const r of res) expect(r.best?.Deleted === true).toBe(false);
        if (order(res).join() !== order(headRule(q.lap_times, now, { drivers, after: w.start })).join()) changed += 1;
      }
      lines.push(`${seg}: ${changed} of ${instants.length} lap-completion instants order differently once deleted laps are left out`);
    }
    console.log(lines.join('\n'));
  });

  it('the backlog example: Q3 at session time 3846.252, SAI\'s deleted 81.953 (lap 22) no longer ranks', () => {
    const w = windows.Q3;
    const drivers = Object.keys(segments.Q3.driver_colors);
    const now = 3846.252;
    const before = headRule(q.lap_times, now, { drivers, after: w.start });
    const after = qualifyingOrder(q.lap_times, now, { drivers, after: w.start });
    const saiBefore = before.find((r) => r.driver === 'SAI');
    const saiAfter = after.find((r) => r.driver === 'SAI');
    console.log(`Q3 at ${now}: rule before ${order(before).join(' ')} | now ${order(after).join(' ')}`);
    expect(saiBefore.best?.LapNumber).toBe(22);
    expect(saiBefore.position).toBe(2);
    const row = q.lap_times.find((r) => r.Driver === 'SAI' && r.LapNumber === 22);
    expect([row.LapTimeSeconds, row.Deleted]).toEqual([81.953, true]);
    expect(saiAfter.best?.LapNumber).not.toBe(22);
  });
});
