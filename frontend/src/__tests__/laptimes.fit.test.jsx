// The Lap Times timing sheet fits its pane. The
// header and the rows are one grid of px columns in a panel that clips
// (.panel-content overflow hidden, the rows' body overflow-x hidden): at the
// 775 px of the default widths the columns past the pane's right edge were
// cut with their values, no ellipsis and no scroll, in 7 of the 16 preset x
// viewport cases (1536 x 750 Pace, 578.8 px: Lap Time cut by 6 px, Gap, Tyre
// and Laps hidden). Now the columns shrink to the rows' box down to
// floors that keep every value whole (utils/views/timingSheetFit.js); a pane
// too narrow for the floors gives up whole columns, named in a "+N" header
// cell, never cut.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { installMiniDom } from './helpers/miniDom.js';
import { haveWebFont, textWidth } from './helpers/fontWidths.js';

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
const {
  TIMING_COLUMNS, timingColumnFloors, fitTimingColumns, TIMING_GAP, TIMING_PAD_X, TIMING_DROP_ORDER,
} = await import('../utils/views/lapTimeChart.js');
const { default: LapTimeChart } = await import('../components/visualizations/LapTimeChart.jsx');

const ro = installResizeObserverMock();
const INITIAL = useF1Store.getState();
const DEFAULTS = TIMING_COLUMNS.map((c) => c.defaultW);
const rowsWidth = (ws, shown) => {
  const idx = ws.map((w, i) => (shown[i] ? i : -1)).filter((i) => i >= 0);
  return idx.reduce((a, i) => a + ws[i], 0) + 2 * TIMING_PAD_X + TIMING_GAP * (idx.length - 1);
};
// panel content widths of the Lap Times panes (pane - 2 px of border - 2 x
// --spacing-md), the data type size there (a static measure of the panes)
const PANES = [
  ['1536x750 pace', 578.8, 11], ['1536x750 tyres / prediction', 640.1, 11], ['1536x750 strategy', 1194.7, 11],
  ['1366x768 pace', 512.1, 11.08], ['1366x768 tyres / prediction', 566.6, 11.08],
  ['1920x1080 pace', 759.5, 12.41], ['1920x1080 tyres', 839.3, 12.41], ['2048x1100 pace', 823.5, 12.5],
];

describe('floors and fit (pure)', () => {
  it('floors: every value whole at the data size (JetBrains Mono 0.6 em, the surname in Inter Bold)', () => {
    for (const d of [11, 12.5]) {
      const f = Object.fromEntries(TIMING_COLUMNS.map((c, i) => [c.key, timingColumnFloors(d)[i]]));
      const mono = (n) => n * 0.6 * d;
      expect(f.s1).toBeGreaterThanOrEqual(mono(7) + 2); // "◆28.123"
      expect(f.lapTime).toBeGreaterThanOrEqual(mono(9) + 2); // "◆1:21.123"
      expect(f.gap).toBeGreaterThanOrEqual(mono(7)); // "+12.345"
      expect(f.pos).toBeGreaterThanOrEqual(mono(3) + 0.06 * d); // "RET"
      // HULKENBERG in Inter Bold (700), uppercase, 0.03 em letter-spacing
      if (haveWebFont) expect(f.driver).toBeGreaterThanOrEqual(textWidth('HULKENBERG', d, 700, { letterSpacingEm: 0.03 }));
      expect(f.tyre).toBeGreaterThanOrEqual(14); // the compound badge
    }
  });

  it.each(PANES)('%s (%f px of panel content): every column, each at or above its floor, the sheet inside the pane', (name, width, d) => {
    const floors = timingColumnFloors(d);
    const fit = fitTimingColumns(DEFAULTS, width, floors);
    expect(fit.hidden, name).toEqual([]);
    expect(fit.total).toBeLessThanOrEqual(width);
    expect(rowsWidth(fit.widths, fit.shown)).toBe(fit.total);
    fit.widths.forEach((w, i) => expect(w, TIMING_COLUMNS[i].key).toBeGreaterThanOrEqual(floors[i]));
    // a pane that holds the defaults keeps them
    if (rowsWidth(DEFAULTS, fit.shown) <= width) expect(fit.widths).toEqual(DEFAULTS);
  });

  it('a floating window near its 420 px minimum (content ~390 px): whole columns given up in order, named, the rest at or above their floors', () => {
    const floors = timingColumnFloors(11);
    const fit = fitTimingColumns(DEFAULTS, 390, floors, { hiddenW: 29 });
    expect(fit.hidden.length).toBeGreaterThan(0);
    // the first ones of TIMING_DROP_ORDER (listed in column order)
    expect([...fit.hidden].sort()).toEqual(TIMING_DROP_ORDER.slice(0, fit.hidden.length).sort());
    // the rows and the "+N" cell (with its gap) inside the pane
    expect(fit.total + fit.hiddenW + TIMING_GAP).toBeLessThanOrEqual(390);
    fit.widths.forEach((w, i) => { if (fit.shown[i]) expect(w).toBeGreaterThanOrEqual(floors[i]); });
    // never the position, the team bar, the driver or the lap time
    for (const key of ['pos', 'bar', 'driver', 'lapTime']) expect(fit.hidden).not.toContain(key);
  });

  it('an unknown width (not measured) keeps the widths; a dragged width under a floor is raised to it', () => {
    const floors = timingColumnFloors(11);
    expect(fitTimingColumns(DEFAULTS, 0, floors).widths).toEqual(DEFAULTS);
    const narrow = DEFAULTS.map((w, i) => (TIMING_COLUMNS[i].key === 'lapTime' ? 40 : w));
    const fit = fitTimingColumns(narrow, 2000, floors);
    expect(fit.widths[TIMING_COLUMNS.findIndex((c) => c.key === 'lapTime')]).toBe(floors[TIMING_COLUMNS.findIndex((c) => c.key === 'lapTime')]);
  });
});

describe('mounted: the grid follows the rows\' box', () => {
  afterAll(() => { useF1Store.setState({ ...INITIAL }); });

  async function mountAt(width) {
    const SESSION = syntheticSession(20);
    useF1Store.setState({
      ...INITIAL,
      year: 2024, round: 16, sessionType: 'R',
      sessionData: SESSION, sessionTimeOffset: computeSessionTimeOffset(SESSION.lap_times),
      maxLap: 20, totalRaceLaps: 20, currentLap: 20, lapModeRaceOver: true, totalFrames: 0, currentTime: 0,
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    dom.setRect(host, { left: 0, top: 0, width: 1200, height: 500 });
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(LapTimeChart)); });
    const body = host.querySelector('.timing-sheet__body');
    dom.setRect(body, { left: 0, top: 0, width, height: 400 });
    await act(async () => { ro.notify(body, width, 400); ro.flushFrames(); });
    return {
      host,
      body,
      header: () => host.querySelector('.timing-sheet__col-label').parentNode.parentNode,
      rows: () => body.querySelectorAll('[data-driver]'),
      async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
    };
  }
  const sum = (tpl) => tpl.split(' ').filter(Boolean).reduce((a, t) => a + parseFloat(t), 0);
  const cols = (tpl) => tpl.split(' ').filter(Boolean).length;

  it('1366 x 768 Pace (512 px): every column on screen, the rows inside the box, every row with all its cells', async () => {
    const v = await mountAt(512);
    try {
      const rows = v.rows();
      expect(rows.length).toBe(8);
      const tpl = rows[0].style.gridTemplateColumns;
      expect(cols(tpl)).toBe(TIMING_COLUMNS.length);
      expect(sum(tpl) + 2 * TIMING_PAD_X + TIMING_GAP * (cols(tpl) - 1)).toBeLessThanOrEqual(512);
      for (const r of rows) expect(r.children.length).toBe(TIMING_COLUMNS.length);
      // the header has the same columns, and no "+N" cell
      expect(v.header().style.gridTemplateColumns).toBe(tpl);
      expect(v.host.querySelector('.timing-sheet__hidden-cols')).toBeNull();
      // the driver cell carries the full name and the team, its surname in Bold (700)
      const name = rows[0].children[TIMING_COLUMNS.findIndex((c) => c.key === 'driver')];
      expect(name.getAttribute('title')).toBeTruthy();
      const surname = [...name.children].find((c) => c.style.textTransform === 'uppercase');
      expect(surname.style.fontWeight).toBe('700');
      expect(surname.style.textOverflow).toBe('ellipsis');
    } finally {
      await v.unmount();
    }
  });

  it('a wide pane keeps the default widths', async () => {
    const v = await mountAt(1194);
    try {
      expect(v.rows()[0].style.gridTemplateColumns).toBe(DEFAULTS.map((w) => `${w}px`).join(' '));
    } finally {
      await v.unmount();
    }
  });

  it('a floating window at its minimum (390 px): the "+N" header cell names the columns given up; rows have no cell for them', async () => {
    const v = await mountAt(390);
    try {
      const cell = v.host.querySelector('.timing-sheet__hidden-cols');
      expect(cell).toBeTruthy();
      const n = Number(cell.textContent.replace('+', ''));
      expect(n).toBeGreaterThan(0);
      expect(cell.getAttribute('title')).toMatch(/^Hidden for the pane's width: .+\. Widen the pane to show them\.$/);
      const tpl = v.rows()[0].style.gridTemplateColumns;
      expect(cols(tpl)).toBe(TIMING_COLUMNS.length - n);
      for (const r of v.rows()) expect(r.children.length).toBe(TIMING_COLUMNS.length - n);
      expect(sum(tpl) + 2 * TIMING_PAD_X + TIMING_GAP * (cols(tpl) - 1)).toBeLessThanOrEqual(390);
      // the header: the same columns and the "+N" cell
      expect(cols(v.header().style.gridTemplateColumns)).toBe(TIMING_COLUMNS.length - n + 1);
    } finally {
      await v.unmount();
    }
  });
});
