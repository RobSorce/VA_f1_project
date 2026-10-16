// V13: the layout lane's components render with a real session (cached Monza
// 2024): the Pit Wall shell with its focus-card toggle, the session bar's
// track-status chip with its label and lifted text colour, the docked layout's
// class-based panes, the timeline's live bar label, the dock and the weather
// mini panel; no hex literal for a semantic colour is left in these views.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

// Server rendering reads getServerState: point it at the live state so a
// setState before renderToString is what the component sees
vi.mock('zustand', async (importOriginal) => {
  const orig = await importOriginal();
  const bind = (createState) => {
    const api = orig.createStore(createState);
    api.getServerState = api.getState;
    const useBound = (selector, equalityFn) => orig.useStore(api, selector, equalityFn);
    Object.assign(useBound, api);
    return useBound;
  };
  return { ...orig, create: (createState) => (createState ? bind(createState) : bind) };
});

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: SessionInfoBar } = await import('../components/ui/SessionInfoBar.jsx');
const { default: WeatherMini } = await import('../components/ui/WeatherMini.jsx');
const { default: DockedLayout } = await import('../components/layout/DockedLayout.jsx');
const { default: BottomTabBar } = await import('../components/ui/BottomTabBar.jsx');
const { default: PitWallLayout } = await import('../components/layout/PitWallLayout.jsx');
const { default: TimelinePlayer } = await import('../components/ui/TimelinePlayer.jsx');
const { default: SidebarFocusCards } = await import('../components/layout/SidebarFocusCards.jsx');
const { default: Leaderboard } = await import('../components/visualizations/Leaderboard.jsx');
const { WINDOW_PRESETS } = await import('../utils/windowPresets.js');
const { TRACK_STATUS_STYLES, contrastRatio, compositeOver, SURFACES } = await import('../utils/colors.js');

const INITIAL = useF1Store.getState();
const haveMonza = hasCachedSession(2024, 16);
const monza = haveMonza ? loadCachedSession(2024, 16) : null;
const textOf = (markup) => markup.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => { useF1Store.setState({ ...INITIAL }); });

describe('SessionInfoBar (Pit Wall session bar)', () => {
  it('the track status chip always carries its label, its text >= 4.5:1 on its tint', () => {
    for (const code of ['1', '2', '4', '5', '6']) {
      useF1Store.setState({ currentFlagStatus: code, currentLap: 12, maxLap: 53, totalRaceLaps: 53 });
      const html = renderToString(<SessionInfoBar />);
      const label = code === '1' ? 'Track clear' : TRACK_STATUS_STYLES[code].short;
      expect(textOf(html)).toContain(label);
      expect(textOf(html)).toMatch(/Lap 12 \/ 53/);
      const style = html.match(/class="session-info-bar__flag" style="([^"]+)"/)[1];
      const bg = style.match(/background:([^;]+)/)[1].trim();
      const fg = style.match(/(?:^|;)color:([^;]+)/)[1].trim();
      expect(contrastRatio(fg, compositeOver(bg, SURFACES.panel))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe.skipIf(!haveMonza)('with Monza 2024 loaded', () => {
  it('WeatherMini: values at the data size, DRY / WET chip from the flag palette with its word', () => {
    useF1Store.setState({ sessionData: monza, currentLap: 10, maxLap: 53 });
    const html = renderToString(<WeatherMini />);
    expect(html).toMatch(/DRY|WET/);
    expect(html).not.toMatch(/font-size:\s*(9|10)px/);
    expect(html).toContain('font-size:max(11px, var(--font-size-data, 11px))');
  });

  it('DockedLayout: every pane and the toolbar are CSS classes, the tab label has its tooltip', () => {
    useF1Store.setState({ sessionData: monza, dockedLayout: WINDOW_PRESETS.pace.dockedLayout });
    const none = { Component: () => null };
    const html = renderToString(<DockedLayout vizComponents={{ laptimes: none, sectors: none, consistency: none }} />);
    expect((html.match(/class="docked-pane"/g) || []).length).toBe(3);
    expect(html).toContain('class="docked-layout__toolbar"');
    expect(html).toMatch(/class="docked-pane__tab docked-pane__tab--active" title="Lap Times"/);
    expect(html).not.toMatch(/overflow-[xy]:auto/);
  });

  it('PitWallLayout: tower, focus cards with their toggle, pace grid and map row in the fixed grid', () => {
    useF1Store.setState({
      sessionData: monza, drivers: monza.driver_info, currentLap: 15, maxLap: 53, totalRaceLaps: 53, focusDriver: 'LEC',
    });
    const html = renderToString(<PitWallLayout />);
    expect(html).toContain('class="pitwall-layout__tower"');
    expect(html).toMatch(/class="pitwall-layout__focus"/); // open: no matchMedia on the server (tall)
    expect(html).toMatch(/class="pitwall-layout__focus-toggle"[^>]*aria-expanded="true"/);
    expect(textOf(html)).toContain('Focus LEC');
    expect(html).toContain('class="session-info-bar"');
    expect(html).toMatch(/grid-template-rows:44px 1fr 35vh/);
  });

  it('TimelinePlayer (collapsed): the lap counter in the text red class, no inline colour or size literal', () => {
    useF1Store.setState({ sessionData: monza, currentLap: 15, maxLap: 53, totalRaceLaps: 53 });
    const html = renderToString(<TimelinePlayer />);
    expect(html).toContain('class="timeline-player__lap-text"');
    expect(textOf(html)).toMatch(/LAP 15 \/ 53/);
    expect(html).not.toMatch(/font-size:\s*[6-9]px/);
  });

  it('BottomTabBar renders every dock item before measuring (capacity starts unlimited)', () => {
    useF1Store.setState({ sessionData: monza });
    const html = renderToString(<BottomTabBar />);
    const items = useF1Store.getState().dockItems.filter((id) => id !== 'settings' && id !== 'charts');
    const buttons = (html.match(/class="bottom-tab-bar__tab(?: bottom-tab-bar__tab--active)?"/g) || []).length;
    expect(buttons).toBeGreaterThanOrEqual(items.length);
    expect(html).not.toContain('bottom-tab-bar__tab--overflow');
  });
});

describe('no hex literal for a semantic colour in the layout views', () => {
  for (const rel of ['components/ui/SessionInfoBar.jsx', 'components/ui/WeatherMini.jsx', 'components/layout/DockedLayout.jsx',
    'components/layout/PitWallLayout.jsx', 'components/ui/TimelinePlayer.jsx']) {
    it(rel, () => {
      const code = fs.readFileSync(path.join(SRC, rel), 'utf8')
        .split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
      expect(code.match(/['"`]#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
    });
  }
});

// V5 / V13 r2: in the Analyse sidebar the Leaderboard rows were clipped under
// the focus cards (an inline height of 20 rows in an overflow-hidden wrapper,
// no scroll, no pager). The rows now fit or page (fitRows / pageOf) and the
// cards stay collapsed below 1200 px of window height, "Details" laying them
// over the sidebar (docs/evidence/leaderboard_sidebar_fit.txt).
describe.skipIf(!haveMonza)('Analyse sidebar: Leaderboard rows and the focus cards', () => {
  const withMatchMedia = (matches, fn) => {
    const saved = globalThis.window;
    globalThis.window = { matchMedia: (q) => ({ matches: matches(q), addEventListener() {}, removeEventListener() {} }) };
    try { return fn(); } finally { globalThis.window = saved; }
  };

  it('under 1200 px of height the cards render collapsed to their headers, with the Details toggle', () => {
    useF1Store.setState({ sessionData: monza, drivers: monza.driver_info, currentLap: 15, maxLap: 53, focusDriver: 'LEC' });
    const html = withMatchMedia((q) => q === '(max-height: 1199px)', () => renderToString(<SidebarFocusCards withSectors />));
    expect(html).toMatch(/class="app-sidebar__focus app-sidebar__focus--collapsed"/);
    expect(html).toMatch(/aria-expanded="false"/);
    expect(textOf(html)).toContain('Details');
    expect(html).not.toContain('app-sidebar__focus--overlay');
  });

  it('on a tall window (or with no matchMedia) the cards are in the flow, open', () => {
    useF1Store.setState({ sessionData: monza, drivers: monza.driver_info, currentLap: 15, maxLap: 53, focusDriver: 'LEC' });
    const html = withMatchMedia(() => false, () => renderToString(<SidebarFocusCards withSectors />));
    expect(html).toMatch(/class="app-sidebar__focus"/);
    expect(html).toMatch(/aria-expanded="true"/);
    expect(html).not.toContain('app-sidebar__focus--collapsed');
  });

  it('no focus driver: the widget hint only, nothing collapsed and no toggle', () => {
    useF1Store.setState({ sessionData: monza, drivers: monza.driver_info, currentLap: 15, maxLap: 53, focusDriver: null });
    const html = withMatchMedia(() => true, () => renderToString(<SidebarFocusCards withSectors />));
    expect(html).not.toContain('pitwall-layout__focus-toggle');
    expect(textOf(html)).toContain('Double-click a driver to focus');
  });

  it('the Leaderboard fits its rows (fitRows 28 -> 18 px) and pages them, the body never scrolls', async () => {
    const code = fs.readFileSync(path.join(SRC, 'components/visualizations/Leaderboard.jsx'), 'utf8');
    expect(code).toMatch(/const ROW_MIN = 18;/);
    expect(code).toMatch(/fitRows\(towerBox\.height, standings\.length, \{ rowMin: ROW_MIN, rowMax: ROW_MAX, rowDefault: ROW_MAX, pagerH: PAGER_H \}\)/);
    expect(code).toMatch(/pageRows\.map\(\(d\) =>/);
    expect(code).not.toMatch(/standings\.length \* ROW_HEIGHT/);
    for (const f of ['styles/dashboard.css', 'styles/visualizations.css']) {
      const { parseCss } = await import('./helpers/layoutCss.js');
      const rules = parseCss(fs.readFileSync(path.join(SRC, f), 'utf8')).filter((r) => r.selector.includes('.tower-body'));
      expect(rules.length, f).toBeGreaterThan(0);
      for (const r of rules) {
        for (const d of r.decls) if (/^overflow/.test(d.prop)) expect(`${r.selector} ${d.prop}: ${d.value}`, f).not.toMatch(/(auto|scroll)/);
      }
    }
    useF1Store.setState({ sessionData: monza, drivers: monza.driver_info, currentLap: 15, maxLap: 53, totalRaceLaps: 53, currentFrameIndex: 3000 });
    const html = renderToString(<Leaderboard collapsed={false} />);
    // not measured on the server: every row at 28 px, no pager
    expect((html.match(/class="tower-row[ "]/g) || []).length).toBe(20);
    expect(html).not.toContain('tower-pager');
  });
});
