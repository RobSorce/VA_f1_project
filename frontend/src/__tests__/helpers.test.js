import { describe, it, expect } from 'vitest';
import { hasCachedSession, loadCachedSession, listCachedRaces } from './helpers/cachedSession.js';

describe.skipIf(!hasCachedSession(2024, 16))('cached session helper', () => {
  it('loads Monza 2024 lap times', () => {
    const s = loadCachedSession(2024, 16);
    expect(s.lap_times.length).toBe(1008);
    expect(listCachedRaces().length).toBeGreaterThanOrEqual(28);
  });
});
