// The key hints of the panels, the dock and the hints bar come from the
// binding table of the key handler (hooks/useKeyboardShortcuts.js
// VIEW_KEYS), the table docs/SHORTCUTS.md is generated from
// (scripts/shortcuts_table.mjs).
//
// The browser pass found panel hints of keys bound to other views: the
// Track Map showed "1" (it opens Lap Times), Lap Times "2" (Tyres), Tyre
// Degradation "4" (Sectors & Speeds), the Leaderboard "2"; the hints bar said
// "1-0 Views" though 7 opens nothing. The hints' titles said "Press N to
// focus", and the panels' focused state read the store's focusedView, set by
// setFocusedView, which nothing called.
//
// Here the handler itself is run (installHandler of the shortcuts script):
// what a key opens is what the handler does with it.
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Server rendering reads getServerState: point it at the live state
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

const React = (await import('react')).default;
const { renderToString } = await import('react-dom/server');
const { installHandler } = await import('../../scripts/shortcuts_table.mjs');
const keys = await import('../hooks/useKeyboardShortcuts.js');
const { useF1Store, DOCK_DEFAULTS } = await import('../store/useF1Store.js');
const { SLOT_OPTIONS } = await import('../utils/slotOptions.js');
const { default: Panel } = await import('../components/ui/Panel.jsx');
const { default: ShortcutHints } = await import('../components/ShortcutHints/ShortcutHints.jsx');
const { default: BottomTabBar } = await import('../components/ui/BottomTabBar.jsx');

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const INITIAL = useF1Store.getState();
const decode = (t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

// What every plain number and letter key opens, as the handler runs it
// (setActiveTab), in the replay state of the shortcuts script
const opened = (() => {
  const h = installHandler();
  try {
    const out = [];
    for (const key of [...'1234567890', ...'abcdefghijklmnopqrstuvwxyz']) {
      const r = h.probe({
        key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      });
      const call = r.calls.find((c) => c.name === 'setActiveTab');
      if (call) out.push({ key, view: call.args[0] });
    }
    return out;
  } finally {
    h.restore();
  }
})();
/** The key a hint names for a view: its number key, else its letter (upper case), else none. */
const expectedHint = (view) => {
  const k = opened.find((o) => o.view === view && /\d/.test(o.key)) || opened.find((o) => o.view === view);
  return k ? k.key.toUpperCase() : null;
};
const VIEWS = [...SLOT_OPTIONS.map((o) => o.id), 'leaderboard'];

afterAll(() => { useF1Store.setState({ ...INITIAL }); });

describe('the binding table of the handler', () => {
  it('VIEW_KEYS is what the handler does: each key opens its view, no other plain key opens one', () => {
    expect(keys.VIEW_KEYS).toBeTruthy();
    const table = Object.entries(keys.VIEW_KEYS).filter(([k]) => /^[0-9a-z]$/.test(k)).map(([key, view]) => ({ key, view }));
    expect(opened.map((o) => `${o.key}:${o.view}`).sort()).toEqual(table.map((o) => `${o.key}:${o.view}`).sort());
    // 7 opens nothing
    expect(opened.find((o) => o.key === '7')).toBeUndefined();
  });

  it('viewKeyHint: the number key of a view, else its letter, else none', () => {
    for (const view of VIEWS) expect(keys.viewKeyHint(view), view).toBe(expectedHint(view));
    expect(keys.viewKeyHint('laptimes')).toBe('1');
    expect(keys.viewKeyHint('simulator')).toBe('M');
    expect(keys.viewKeyHint('trackmap')).toBeNull();
    expect(keys.viewKeyHint('tiredeg')).toBeNull();
  });

  it('the hints bar names the number keys that open a view: 1-6 8-0', () => {
    expect(keys.viewDigitRanges()).toBe('1-6 8-0');
    useF1Store.setState({ ...INITIAL, shortcutHintsVisible: true, focusDriver: null, selectedDrivers: [] });
    const html = decode(renderToString(<ShortcutHints />));
    expect(html).toContain('>1-6 8-0</kbd>');
    expect(html).not.toContain('>1-0<');
  });
});

describe('the hints shown', () => {
  it('panels: a hint only from viewKeyHint of the view the panel is, none on the Track Map, Tyre Degradation, Leaderboard', () => {
    const files = fs.readdirSync(path.join(SRC, 'components/visualizations')).map((f) => `components/visualizations/${f}`);
    for (const rel of files) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/shortcutKey="/);
      expect(src, rel).not.toMatch(/className="panel-shortcut-hint"/);
      for (const m of src.matchAll(/shortcutKey=\{[^}]*\}/g)) {
        expect(m[0], rel).toMatch(/^shortcutKey=\{viewKeyHint\('[a-z]+'\)\}$/);
      }
    }
    expect(read('components/visualizations/StrategyTimeline.jsx')).toContain("shortcutKey={viewKeyHint('strategy')}");
    expect(read('components/visualizations/LapTimeChart.jsx')).toContain("shortcutKey={viewKeyHint('laptimes')}");
    for (const rel of ['TrackMap.jsx', 'TireDegradation.jsx', 'Leaderboard.jsx']) {
      expect(read(`components/visualizations/${rel}`), rel).not.toMatch(/shortcutKey|panel-shortcut-hint/);
    }
  });

  it('a panel hint names the key and what it does there', () => {
    const html = decode(renderToString(<Panel title="Strategy Timeline" shortcutKey={keys.viewKeyHint('strategy')}>x</Panel>));
    expect(html).toMatch(/<kbd class="panel-shortcut-hint" title="Key 3 opens this view, or closes it when it is open">3<\/kbd>/);
    expect(html).not.toContain('to focus');
  });

  it('dock, its overflow and its pickers: the hint of each view from viewKeyHint, none written in SLOT_OPTIONS', () => {
    // no key written with a view (a hint: null left by an older entry is harmless)
    for (const o of SLOT_OPTIONS) expect(o.hint ?? null, o.id).toBeNull();
    for (const rel of ['components/ui/BottomTabBar.jsx', 'components/ui/DockOverflowPopover.jsx', 'components/ui/DockCustomizePopover.jsx', 'components/ui/LayoutDockPopover.jsx']) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/\.hint\b/);
      expect(src, rel).toMatch(/viewKeyHint\(/);
    }
    // the default dock as rendered: each button's label and hint
    useF1Store.setState({ ...INITIAL, dockItems: [...DOCK_DEFAULTS], showDashboard: true });
    const html = decode(renderToString(<BottomTabBar />));
    const buttons = [...html.matchAll(/<span class="bottom-tab-bar__label">([^<]*)<\/span>(?:<kbd class="tab-kbd">([^<]*)<\/kbd>)?/g)]
      .map((m) => [m[1], m[2] ?? null]);
    const label = Object.fromEntries(SLOT_OPTIONS.map((o) => [o.id, o.label]));
    // the dock's own buttons after the views (Layouts, the palette, Settings) carry no view hint
    expect(buttons.slice(0, DOCK_DEFAULTS.length)).toEqual(DOCK_DEFAULTS.map((id) => [label[id], expectedHint(id)]));
    expect(buttons.filter(([, k]) => k).length).toBeGreaterThan(5);
  });

  it('setFocusedView is gone with the state it set: nothing calls or reads it', () => {
    const s = useF1Store.getState();
    for (const k of ['setFocusedView', 'clearFocusedView', 'focusedView']) expect(s, k).not.toHaveProperty(k);
    const all = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.(jsx?|mjs)$/.test(e.name)) all.push(p);
      }
    };
    walk(SRC);
    const users = all.filter((f) => /focusedView|FocusedView/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
    expect(users).toEqual([]);
  });
});
