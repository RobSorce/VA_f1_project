// Escape closes the topmost transient element only. Pressing Escape to close
// a menu, a popover, the command palette, the shortcut cheatsheet, the help
// panel or a dropdown also closed every window and the docked layout (the
// global handler acted first, in the capture phase), with no undo. Now each
// transient element joins an Escape stack while it is open
// (utils/escapeStack.js, hooks/useEscapeLayer.js): Escape closes the one
// opened last, and the layout stays. With nothing transient open, Escape
// (and X) still close every window and the docked layout, and the Undo toast
// or Ctrl+Z restores them. Mounted in the mini DOM with the real global key
// handler (hooks/useKeyboardShortcuts.js).
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
Object.assign(dom.window, { innerWidth: 1536, innerHeight: 864 });
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
if (!ElementProto.scrollIntoView) ElementProto.scrollIntoView = () => {}; // the palette scrolls its selection
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { useKeyboardShortcuts } = await import('../hooks/useKeyboardShortcuts.js');
const { escapeLayerCount } = await import('../utils/escapeStack.js');
const { default: DockOverflowPopover } = await import('../components/ui/DockOverflowPopover.jsx');
const { default: HelpOverlay } = await import('../components/ui/HelpOverlay.jsx');
const { default: ShortcutCheatsheet } = await import('../components/ShortcutCheatsheet/ShortcutCheatsheet.jsx');
const { default: CommandPalette } = await import('../components/CommandPalette/CommandPalette.jsx');
const { default: CommandBar } = await import('../components/CommandPalette/CommandBar.jsx');
const { default: ToastStack } = await import('../components/ui/ToastStack.jsx');

const INITIAL = useF1Store.getState();
// A docked layout of two panes and a floating Settings window
const LAYOUT = {
  activeTab: 'charts',
  openOverlays: ['settings'],
  overlayTiles: { settings: 'right' },
  overlayVizMapping: {},
  _arrangeIdx: 1,
  dockedLayout: {
    direction: 'horizontal',
    children: [{ tabs: ['laptimes', 'tyres'], activeTab: 'tyres' }, { tabs: ['strategy'], activeTab: 'strategy' }],
    sizes: [60, 40],
  },
};
const layoutOf = (s) => Object.fromEntries(Object.keys(LAYOUT).map((k) => [k, s[k]]));
const store = () => useF1Store.getState();

function Keys() {
  useKeyboardShortcuts();
  return null;
}

let root = null;
let host = null;
async function mount(...children) {
  host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Keys), ...children)); });
}
async function press(key, init = {}, target = dom.document.body) {
  let ev;
  await act(async () => { ev = dom.keyboard(target, 'keydown', { key, ...init }); });
  return ev;
}

beforeEach(() => {
  useF1Store.setState({ ...INITIAL, ...LAYOUT, toasts: [], helpTabId: null, cheatsheetOpen: false, commandPaletteOpen: false });
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  root = null;
  host?.parentNode?.removeChild(host);
  delete dom.document.activeElement;
});
afterAll(() => { useF1Store.setState({ ...INITIAL }, true); });

const popover = (onClose) => React.createElement(DockOverflowPopover, {
  items: [{ id: 'sectors', label: 'Sectors', icon: 'M0 0' }], anchorRect: { left: 600, top: 800, width: 40, height: 30 }, onClose,
});

describe('Escape closes the topmost transient element only', () => {
  it('a dock popover open: Escape closes it, and only it; the docked layout and the window stay', async () => {
    const onClose = vi.fn();
    await mount(popover(onClose));
    expect(escapeLayerCount()).toBe(1);
    const ev = await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(layoutOf(store())).toEqual(LAYOUT);
    expect(store().toasts).toEqual([]);
    expect(ev._stop).toBe(true); // nothing below the handler sees this Escape
  });

  it('the help panel, then the cheatsheet over it: one Escape each, top first; the layout stays until a third', async () => {
    useF1Store.setState({ helpTabId: 'laptimes' });
    await mount(React.createElement(HelpOverlay), React.createElement(ShortcutCheatsheet));
    await act(async () => { store().openCheatsheet(); });
    expect(escapeLayerCount()).toBe(2);

    await press('Escape');
    expect(store().cheatsheetOpen).toBe(false);
    expect(store().helpTabId).toBe('laptimes');
    expect(layoutOf(store())).toEqual(LAYOUT);

    await press('Escape');
    expect(store().helpTabId).toBe(null);
    expect(layoutOf(store())).toEqual(LAYOUT);
    expect(escapeLayerCount()).toBe(0);

    // nothing transient open: today's behaviour, now undoable
    await press('Escape');
    expect(store().dockedLayout).toBe(null);
    expect(store().openOverlays).toEqual([]);
    expect(store().toasts.map((t) => [t.kind, t.message])).toEqual([['undo', 'Closed every window and the docked layout']]);
  });

  it('the command palette open over a popover: Escape closes the palette only', async () => {
    const onClose = vi.fn();
    useF1Store.setState({ commandPaletteOpen: true });
    await mount(popover(onClose), React.createElement(CommandPalette));
    const input = dom.document.body.querySelector('input');
    expect(input).toBeTruthy();
    await press('Escape', {}, input);
    expect(store().commandPaletteOpen).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(layoutOf(store())).toEqual(LAYOUT);
  });

  it('the command bar list open: Escape closes the list, the layout stays', async () => {
    await mount(React.createElement(CommandBar));
    const input = host.querySelector('input');
    await act(async () => { dom.mouse(input, 'focusin'); });
    expect(host.querySelector('.search-bar--focused')).toBeTruthy();
    expect(escapeLayerCount()).toBe(1);
    await press('Escape', {}, input);
    expect(host.querySelector('.search-bar--focused')).toBe(null);
    expect(layoutOf(store())).toEqual(LAYOUT);
  });

  it('a text field in focus and nothing transient open: Escape takes the focus off it, the layout stays', async () => {
    await mount();
    const field = host.appendChild(dom.document.createElement('input'));
    field.blur = vi.fn();
    Object.defineProperty(dom.document, 'activeElement', { configurable: true, get: () => field });
    await press('Escape', {}, field);
    expect(field.blur).toHaveBeenCalledTimes(1);
    expect(layoutOf(store())).toEqual(LAYOUT);
  });
});

describe('closing every window is undoable', () => {
  it('Escape with nothing transient open, then Ctrl+Z: the layout comes back as it was', async () => {
    await mount(React.createElement(ToastStack));
    await press('Escape');
    expect(store().dockedLayout).toBe(null);
    expect(host.querySelector('.toast--undo')).toBeTruthy();
    const ev = await press('z', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(layoutOf(store())).toEqual(LAYOUT);
    expect(store().toasts).toEqual([]);
    // nothing left to undo: Ctrl+Z is left to the browser
    expect((await press('z', { ctrlKey: true })).defaultPrevented).toBe(false);
  });

  it('X, as documented, closes every window; the toast\'s Undo button restores them', async () => {
    await mount(React.createElement(ToastStack));
    await press('x');
    expect(store().dockedLayout).toBe(null);
    const undo = host.querySelector('.toast__action');
    expect(undo.textContent).toBe('Undo');
    await act(async () => { dom.mouse(undo, 'click'); });
    expect(layoutOf(store())).toEqual(LAYOUT);
    expect(host.querySelector('.toast--undo')).toBe(null);
  });

  it('nothing open: Escape and X offer no undo; Ctrl+Z in a text field stays the field\'s', async () => {
    useF1Store.setState({ dockedLayout: null, openOverlays: [], activeTab: 'pitwall' });
    await mount();
    await press('Escape');
    await press('x');
    expect(store().toasts).toEqual([]);
    useF1Store.setState({ ...LAYOUT });
    await press('Escape');
    const field = host.appendChild(dom.document.createElement('textarea'));
    Object.defineProperty(dom.document, 'activeElement', { configurable: true, get: () => field });
    expect((await press('z', { ctrlKey: true }, field)).defaultPrevented).toBe(false);
    expect(store().dockedLayout).toBe(null);
  });
});

describe('one Escape path', () => {
  it('no component listens for Escape on its own, but the palette and the command bar field (their sub-lists)', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(SRC, 'components'));
    const own = files.filter((f) => /key === ['"]Escape['"]/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'));
    expect(own.sort()).toEqual(['components/CommandPalette/CommandBar.jsx', 'components/CommandPalette/CommandPalette.jsx']);
  });
});
