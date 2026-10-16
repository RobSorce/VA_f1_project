// The Lap Times timing-sheet header never clips
// silently. Each label (uppercase Formula1 Bold at the data size, 0.06 em
// letter-spacing) fits its default column width at every size of
// --font-size-data (11 px at 1536 x 750 up to the 12.5 px top of the clamp,
// 12.41 px at 1920 x 1080); a label still too wide (a column dragged narrow)
// ends in an ellipsis with its full name in the header cell's title.
//
// Before: "GAP TO FASTEST" 121.4 px in its 96 px column at 11 px
// (136.9 px at 12.41 px), "TEAM" 42.4-47.9 px in 38 and "LAPS" 41.4 px in 38
// at 12.41 px, cut without an ellipsis or a title.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { installMiniDom } from './helpers/miniDom.js';
import { haveFormula1, textWidth } from './helpers/fontWidths.js';

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
const { TIMING_COLUMNS } = await import('../utils/views/lapTimeChart.js');
const { default: LapTimeChart } = await import('../components/visualizations/LapTimeChart.jsx');

installResizeObserverMock();
const INITIAL = useF1Store.getState();
const SIZES = [11, 12.41, 12.5];

describe.skipIf(!haveFormula1)('every header label fits its default column (real font widths)', () => {
  for (const size of SIZES) {
    it(`data type ${size} px`, () => {
      const over = [];
      for (const col of TIMING_COLUMNS) {
        if (!col.label) continue;
        // the driver header has a 2 px left padding
        const w = textWidth(col.label, size, 700, { letterSpacingEm: 0.06, upper: true }) + (col.key === 'driver' ? 2 : 0);
        if (w > col.defaultW) over.push(`${col.label} ${w.toFixed(1)} px in ${col.defaultW}`);
      }
      expect(over).toEqual([]);
    });
  }

  it('the columns as a whole are no wider than before the repair (the gap column gave its room to Team and Laps)', () => {
    const total = TIMING_COLUMNS.reduce((a, c) => a + c.defaultW, 0);
    // 30 + 3 + 38 + 170 + 3 x 72 + 96 + 96 + 54 + 38 = 741 px before
    expect(total).toBeLessThanOrEqual(741 + 2);
    // the widest gap value (JetBrains Mono, 0.6 em): "+12.345" at 12.5 px
    expect(7 * 0.6 * 12.5).toBeLessThanOrEqual(TIMING_COLUMNS.find((c) => c.key === 'gap').defaultW);
  });
});

describe('the header cells: the full name in the title, an ellipsis when a column is dragged narrow', () => {
  afterAll(() => { useF1Store.setState({ ...INITIAL }); });

  it('mounted: every labelled header cell has a title and a label span with an ellipsis', async () => {
    const SESSION = syntheticSession(20);
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R',
      sessionData: SESSION, sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
      maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true, totalFrames: 0, currentTime: 0,
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 900, height: 500 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(LapTimeChart)); });
    const labels = host.querySelectorAll('.timing-sheet__col-label');
    expect(labels).toHaveLength(TIMING_COLUMNS.length);
    TIMING_COLUMNS.forEach((col, i) => {
      const span = labels[i];
      expect(span.textContent, col.key).toBe(col.label);
      expect(span.style.overflow).toBe('hidden');
      expect(span.style.textOverflow).toBe('ellipsis');
      expect(span.style.whiteSpace).toBe('nowrap');
      if (col.label) expect(span.parentNode.getAttribute('title')).toBe(col.title || col.label);
    });
    const gap = labels.find((s) => s.textContent === 'Gap');
    expect(gap.parentNode.getAttribute('title')).toBe('Gap to fastest');
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
