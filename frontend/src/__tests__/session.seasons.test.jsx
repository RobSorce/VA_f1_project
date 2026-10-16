// The year pickers list the seasons of GET /api/seasons (store
// fetchSeasons, newest first) with the previous hard-coded list as the
// offline fallback, and every DRS layer, toggle and readout is hidden for a
// session of 2026 or later through one helper, seasonHasDrs(year). The
// season is the one of the session on screen (loadedYear / the live feed),
// never the year pill. Mocked API, server rendering.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';

vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal();
  const { createStore } = await import('zustand/vanilla');
  return {
    ...actual,
    create: (createState) => {
      const api = createStore(createState);
      api.getServerState = api.getState;
      return actual.create(api);
    },
  };
});
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  mocked.getSeasons = vi.fn(async () => globalThis.__seasonsFx.seasons());
  return mocked;
});
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

const fx = { seasons: async () => ({ seasons: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }) };
globalThis.__seasonsFx = fx;
const { useF1Store } = await import('../store/useF1Store.js');
const {
  FALLBACK_SEASONS, FIRST_SEASON_WITHOUT_DRS, seasonsFromResponse, yearOptions, seasonHasDrs, sessionSeasonOf,
} = await import('../utils/seasons.js');
const { createCommandRegistry } = await import('../components/CommandPalette/commandRegistry.js');
const { default: SessionSelectorScreen } = await import('../components/ui/SessionSelectorScreen.jsx');
const { default: SessionSelector } = await import('../components/ui/SessionSelector.jsx');
const { default: SessionMenu } = await import('../components/ui/SessionMenu.jsx');
const { default: SettingsTabContent } = await import('../components/tabs/SettingsTabContent.jsx');
const { default: TrackMap } = await import('../components/visualizations/TrackMap.jsx');

const store = () => useF1Store.getState();
const yearsIn = (html) => [...html.matchAll(/<option value="(\d{4})"/g)].map((m) => Number(m[1]));
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

beforeEach(() => {
  store().resetSession();
  useF1Store.setState({ isLiveMode: false, year: 2024, round: null, seasons: [...FALLBACK_SEASONS], liveSessionInfo: null });
});

describe('season list from /api/seasons, built-in list offline', () => {
  it('helpers: newest first, unique; fallback when empty; the selected year is always an option', () => {
    expect(seasonsFromResponse({ seasons: [2018, 2026, 2025, 2025] })).toEqual([2026, 2025, 2018]);
    expect(seasonsFromResponse({})).toEqual([...FALLBACK_SEASONS]);
    expect(FALLBACK_SEASONS).toEqual([2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]);
    expect(yearOptions([2025, 2024], 2026)).toEqual([2026, 2025, 2024]);
    expect(yearOptions([], 2024)).toEqual([...FALLBACK_SEASONS]);
  });

  it('every year picker lists the store\'s seasons (2026 once the backend lists it), newest first', async () => {
    const pickers = {
      SessionSelectorScreen: () => renderToString(<SessionSelectorScreen />),
      SessionSelector: () => renderToString(<SessionSelector />),
      SessionMenu: () => renderToString(<SessionMenu isOpen onClose={() => {}} />),
    };
    // SettingsTabContent's Dataset section is collapsed until clicked (no
    // option is rendered on the server): it renders, and builds its options
    // with the same yearOptions(seasons, year) (source check below)
    expect(renderToString(<SettingsTabContent />)).toContain('Dataset');
    // before the backend answers (or offline): the built-in list
    for (const [name, render] of Object.entries(pickers)) {
      expect(yearsIn(render()), name).toEqual([...FALLBACK_SEASONS]);
    }
    await store().fetchSeasons();
    for (const [name, render] of Object.entries(pickers)) {
      expect(yearsIn(render()), name).toEqual([2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018]);
    }
    // offline afterwards: the list stays
    fx.seasons = async () => { throw new Error('offline'); };
    await store().fetchSeasons();
    expect(yearsIn(pickers.SessionSelectorScreen())[0]).toBe(2026);
    // each picker asks the backend when it mounts
    for (const f of ['ui/SessionSelectorScreen.jsx', 'ui/SessionSelector.jsx', 'ui/SessionMenu.jsx', 'tabs/SettingsTabContent.jsx']) {
      const src = fs.readFileSync(path.join(SRC, 'components', f), 'utf8');
      expect(src, f).toContain('useEffect(() => { fetchSeasons(); }, [fetchSeasons]);');
      expect(src, f).toContain('yearOptions(seasons, year).map(');
      expect(src, f).not.toMatch(/\[20\d\d, 20\d\d, 20\d\d/);
    }
  });
});

describe('no DRS from 2026 (seasonHasDrs)', () => {
  it('helper and the season of the session on screen', () => {
    expect(FIRST_SEASON_WITHOUT_DRS).toBe(2026);
    expect([2018, 2025, 2026, 2027, null, undefined].map(seasonHasDrs)).toEqual([true, true, false, false, true, true]);
    expect(sessionSeasonOf({ loadedYear: 2026, year: 2024 })).toBe(2026);
    expect(sessionSeasonOf({ loadedYear: null, year: 2026 })).toBeNull(); // the pill alone is no session
    expect(sessionSeasonOf({ isLiveMode: true, liveSessionInfo: { start_date: '2026-03-08T04:00:00' } })).toBe(2026);
    expect(sessionSeasonOf({ isLiveMode: true, liveMockSession: { year: 2024, round: 16 } })).toBe(2024);
  });

  it('TrackMap toggle and the DRS command follow the loaded season, not the pill', () => {
    // the DRS toggle sits in the Layers popover (closed in a
    // server render; opened in __tests__/trackmap.toolbar.test.jsx, where a
    // 2026 session has no DRS toggle) and the map's key shows the DRS zone
    // in its place; either one follows the season
    const drsButton = (html) => />DRS<\/button>|>DRS zone</.test(html);
    const drsCommand = () => createCommandRegistry().find((c) => c.id === 'toggle-drs');
    useF1Store.setState({ loadedYear: 2024, loadedRound: 1, loadedSessionType: 'Q', year: 2026 });
    expect(drsButton(renderToString(<TrackMap />))).toBe(true);
    expect(drsCommand().available()).toBe(true);
    useF1Store.setState({ loadedYear: 2026, loadedRound: 1, loadedSessionType: 'Q', year: 2024 });
    expect(drsButton(renderToString(<TrackMap />))).toBe(false);
    expect(drsCommand().available()).toBe(false);
    // Shift+D toggles nothing then (hooks/useKeyboardShortcuts.js)
    const keys = fs.readFileSync(path.join(SRC, 'hooks', 'useKeyboardShortcuts.js'), 'utf8');
    expect(keys).toMatch(/if \(seasonHasDrs\(sessionSeasonOf\(state\)\)\) state\.toggleTrackDRS\(\);/);
    useF1Store.setState({ loadedYear: null, loadedRound: null, loadedSessionType: null });
  });
});
