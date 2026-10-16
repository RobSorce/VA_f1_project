// Phase 9d G5: in the static demo (npm run build:demo, no backend) the start
// screen offered CONNECT LIVE and START MOCK LIVE, which need the local
// backend (live timing; the mock replay streams a cached race through it).
// In demo mode both are disabled and say "Requires the local backend", from
// the flag the model-only views read (utils/demoMode.js useBackendOnlyText);
// out of demo mode they work as before. Mounted in the mini DOM; the flag is
// set as a demo build sets it (source 'build').
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const mocked = {};
  for (const [k, v] of Object.entries(orig)) mocked[k] = typeof v === 'function' ? vi.fn(async () => ({})) : v;
  mocked.setHealthReporter = vi.fn();
  return mocked;
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

const dom = installMiniDom();
// The mini DOM has no HTMLSelectElement.options (React reads it for the pickers)
const ElementProto = Object.getPrototypeOf(dom.document.createElement('div'));
if (!('options' in ElementProto)) {
  Object.defineProperty(ElementProto, 'options', {
    configurable: true,
    get() { return this.localName === 'select' ? [...this.querySelectorAll('option')] : undefined; },
  });
}
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { useDemoMode, BACKEND_ONLY_TEXT } = await import('../utils/demoMode.js');
const { default: SessionSelectorScreen } = await import('../components/ui/SessionSelectorScreen.jsx');

const INITIAL = useF1Store.getState();
const DEMO_INITIAL = useDemoMode.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

let enterLiveMode;
beforeEach(() => {
  enterLiveMode = vi.fn(async () => {});
  useF1Store.setState({
    ...INITIAL, year: 2024, round: 16, schedule: [], previewDrivers: [], isLoading: false, error: null,
    enterLiveMode,
    fetchSchedule: vi.fn(async () => {}), fetchDriversPreview: vi.fn(async () => {}), fetchSeasons: vi.fn(async () => {}),
  });
});
afterAll(() => {
  useDemoMode.setState({ ...DEMO_INITIAL });
  useF1Store.setState({ ...INITIAL });
});

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(SessionSelectorScreen)); });
  const button = (label) => [...host.querySelectorAll('button')].find((b) => text(b) === label);
  return {
    host,
    live: () => button('CONNECT LIVE'),
    mock: () => button('START MOCK LIVE'),
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const click = (el) => act(async () => {
  el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true, _stop: false, preventDefault() {}, stopPropagation() { this._stop = true; } });
});

describe('G5: the start screen in the static demo', () => {
  it('demo mode: CONNECT LIVE and START MOCK LIVE are disabled and say "Requires the local backend"', async () => {
    useDemoMode.setState({ active: true, source: 'build', reason: null });
    const v = await mount();
    try {
      for (const [btn, noteId, what] of [
        [v.live(), 'session-live-backend-note', 'live timing'],
        [v.mock(), 'session-mock-backend-note', 'the mock replay'],
      ]) {
        expect(btn).toBeTruthy();
        expect(btn.disabled === true || btn.getAttribute('disabled') != null).toBe(true);
        expect(btn.getAttribute('title')).toBe(`${BACKEND_ONLY_TEXT}: ${what}`);
        expect(btn.getAttribute('aria-describedby')).toBe(noteId);
        const note = v.host.querySelector(`#${noteId}`);
        expect(text(note)).toMatch(new RegExp(`^${BACKEND_ONLY_TEXT}: ${what}`));
        expect(text(note).toLowerCase()).toContain('requires the local backend');
      }
      // a click (were it delivered) starts nothing
      await click(v.live());
      await click(v.mock());
      expect(enterLiveMode).not.toHaveBeenCalled();
    } finally {
      await v.unmount();
    }
  });

  it('a run-time demo (the backend did not answer) reads the same flag', async () => {
    useDemoMode.setState({ active: true, source: 'fallback', reason: 'the backend did not answer' });
    const v = await mount();
    try {
      expect(v.live().getAttribute('disabled')).not.toBeNull();
      expect(v.mock().getAttribute('disabled')).not.toBeNull();
      expect(text(v.host)).toContain(BACKEND_ONLY_TEXT);
    } finally {
      await v.unmount();
    }
  });

  it('with the backend: both enabled, no note; CONNECT LIVE and START MOCK LIVE start the live mode', async () => {
    useDemoMode.setState({ active: false, source: null, reason: null });
    const v = await mount();
    try {
      expect(v.live().getAttribute('disabled')).toBeNull();
      expect(v.mock().getAttribute('disabled')).toBeNull();
      expect(v.live().getAttribute('title')).toBeNull();
      expect(text(v.host)).not.toContain(BACKEND_ONLY_TEXT);
      await click(v.live());
      expect(enterLiveMode).toHaveBeenCalledTimes(1);
      expect(enterLiveMode).toHaveBeenLastCalledWith();
      await click(v.mock());
      expect(enterLiveMode).toHaveBeenCalledTimes(2);
      expect(enterLiveMode).toHaveBeenLastCalledWith(2024, 16, 10);
    } finally {
      await v.unmount();
    }
  });
});
