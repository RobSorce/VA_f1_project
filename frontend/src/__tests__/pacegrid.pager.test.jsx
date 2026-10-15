// D1 / D3 (Phase 9c, F3 repair): the Race Pace Grid fits its laps to the
// measured grid, and the lap pager's arrival no longer changes that grid.
//
// The browser pass (2026-10-16, Pit Wall at 1536 x 750) found the grid's div
// clipping 9 px: 12 rows (30 + 12 x 18 = 246 px) fitted to the grid measured
// without the pager, then the "◀ L.. of 53 ▶" pager joined the legend bar,
// wrapped it from 2 to 3 lines (about 62 -> 79 px) and left the grid 237 px.
// The lap pager's slot is now always in the bar (hidden while every lap
// fits), so the bar is the same with and without paging and the grid the
// rows are fitted to is the final one, even if a ResizeObserver report is late.
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
const { computeSessionTimeOffset } = await import('../utils/raceTime.js');
const { syntheticSession, installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const { PACE_HEADER_H, PACE_ROW_MIN } = await import('../utils/views/racePaceGrid.js');
const { default: RacePaceGrid } = await import('../components/visualizations/RacePaceGrid.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SESSION = syntheticSession(20);
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/** The bar under the grid: its children's classes, the structure the fit must not depend on. */
const barShape = (host) => {
  const pager = host.querySelector('.pace-grid__pager');
  return pager ? [...pager.children].map((c) => `${c.tagName}.${c.getAttribute('class') || ''}`).join('|') : null;
};

describe('Race Pace Grid: the lap pager keeps its slot, the rows fit the final grid', () => {
  afterAll(() => { useF1Store.setState({ ...INITIAL }); });

  it('every lap fits: the slot is there, hidden; laps paged: the same slot, shown; the rows inside the grid', async () => {
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R',
      sessionData: SESSION, drivers: SESSION.driver_info,
      sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
      maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true, totalFrames: 0, currentTime: 0,
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 1055, height: 700 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(RacePaceGrid)); });
    await act(async () => { ro.flushFrames(); });

    // 700 px: the 20 laps fit, the lap pager's slot is in the bar, hidden
    const slot = host.querySelector('.pace-grid__lap-pager');
    expect(slot, 'lap pager slot').toBeTruthy();
    expect(slot.style.visibility).toBe('hidden');
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    for (const b of slot.querySelectorAll('button')) expect(b.getAttribute('disabled')).not.toBeNull();
    expect(host.querySelectorAll('tbody tr')).toHaveLength(20);
    const shapeFit = barShape(host);

    // the grid measured 200 px: 9 laps of 18 px a page, the pager shown in the same slot
    const grid = host.querySelector('table').parentNode;
    dom.setRect(grid, { left: 0, top: 0, width: 1055, height: 200 });
    await act(async () => { ro.notify(grid, 1055, 200); });
    const shown = host.querySelector('.pace-grid__lap-pager');
    expect(shown.style.visibility).toBe('visible');
    expect(shown.getAttribute('aria-hidden')).toBeNull();
    expect(text(shown)).toContain('L12–20 of 20');
    expect(barShape(host)).toBe(shapeFit);
    const rows = host.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(Math.floor((200 - PACE_HEADER_H) / PACE_ROW_MIN));
    expect(PACE_HEADER_H + rows.length * PACE_ROW_MIN).toBeLessThanOrEqual(200);
    for (const td of rows[0].querySelectorAll('td')) expect(td.style.height).toBe(`${PACE_ROW_MIN}px`);
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
