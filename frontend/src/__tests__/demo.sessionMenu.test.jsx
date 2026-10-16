// In the static demo the dashboard's Session menu said "No active F1
// session" and, under Show Mock Replay, "No cached sessions": the live status
// and the mock list need the local backend, their calls rejected with a
// BackendOnlyError and the menu swallowed it. It now says what the start
// screen says (utils/demoMode.js useBackendOnlyText): "Requires the local
// backend". Mounted in the mini DOM with the real API client (demo answers);
// out of demo mode the live calls are mocked and the menu reads as before.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
// Demo mode: the real client (demo answers, BackendOnlyError for live timing);
// with the backend: no live session, no cached session
vi.mock('../utils/apiClient', async (importOriginal) => {
  const orig = await importOriginal();
  const { isDemoActive } = await import('../utils/demoMode.js');
  const either = (name, backend) => vi.fn((...a) => (isDemoActive() ? orig[name](...a) : backend(...a)));
  return {
    ...orig,
    getLiveStatus: either('getLiveStatus', async () => ({ active: false })),
    connectSignalR: either('connectSignalR', async () => { throw new Error('no feed'); }),
    getMockSessions: either('getMockSessions', async () => ({ sessions: [] })),
  };
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
const api = await import('../utils/apiClient');
const { useF1Store } = await import('../store/useF1Store.js');
const { useDemoMode, BACKEND_ONLY_TEXT } = await import('../utils/demoMode.js');
const { default: SessionMenu } = await import('../components/ui/SessionMenu.jsx');

const INITIAL = useF1Store.getState();
const DEMO_INITIAL = useDemoMode.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

beforeEach(() => {
  useF1Store.setState({
    ...INITIAL, year: 2024, round: 16, schedule: [], isLoading: false, error: null, isLiveMode: false,
    fetchSchedule: vi.fn(async () => {}), fetchSeasons: vi.fn(async () => {}),
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
  await act(async () => { root.render(React.createElement(SessionMenu, { isOpen: true, onClose: () => {} })); });
  // let the live-status check settle
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const live = () => host.querySelector('.session-menu__live-section');
  return {
    host,
    live,
    async showMock() {
      const btn = [...live().querySelectorAll('button')].find((b) => /Mock Replay/.test(text(b)));
      await act(async () => { dom.mouse(btn, 'click'); });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('The Session menu in the static demo', () => {
  it('demo mode: live timing and the mock replay say "Requires the local backend", not "no session"', async () => {
    useDemoMode.setState({ active: true, source: 'build', reason: null });
    const v = await mount();
    try {
      const live = text(v.live());
      expect(live).toContain(`${BACKEND_ONLY_TEXT}: live timing.`);
      expect(live).not.toContain('No active F1 session');
      await v.showMock();
      const withMock = text(v.live());
      expect(withMock).toContain(`${BACKEND_ONLY_TEXT}: the mock replay streams a cached race through it.`);
      expect(withMock).not.toContain('No cached sessions');
      expect(withMock.toLowerCase()).toContain('requires the local backend');
    } finally {
      await v.unmount();
    }
  });

  it('a run-time demo (the backend did not answer) reads the same flag', async () => {
    useDemoMode.setState({ active: true, source: 'fallback', reason: 'the backend did not answer' });
    api.getLiveStatus.mockClear();
    const v = await mount();
    try {
      expect(text(v.live())).toContain(`${BACKEND_ONLY_TEXT}: live timing.`);
      // no live-status polling while the answer can only be "requires the backend"
      expect(api.getLiveStatus).not.toHaveBeenCalled();
    } finally {
      await v.unmount();
    }
  });

  it('with the backend: no active session and no cached session read as before, no demo note', async () => {
    useDemoMode.setState({ active: false, source: null, reason: null });
    const v = await mount();
    try {
      expect(text(v.live())).toContain('No active F1 session');
      await v.showMock();
      expect(text(v.live())).toContain('No cached sessions');
      expect(text(v.live())).not.toContain(BACKEND_ONLY_TEXT);
    } finally {
      await v.unmount();
    }
  });
});
