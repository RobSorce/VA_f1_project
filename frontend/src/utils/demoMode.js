/**
 * Static demo mode: the dashboard without its backend (GitHub Pages).
 *
 * GitHub Pages serves only the static build, so every /api request there
 * would fail. In demo mode utils/apiClient.js answers the API from the files
 * of public/data/ (utils/demoData.js; written by
 * backend/scripts/export_demo_data.py): a few cached races, their replay
 * frames, analytics, the PCA biplot and its lasso analysis (computed in the
 * browser, utils/pcaSelectionStats.js), the degradation fits
 * (utils/degradation.js). The LSTM forecast, telemetry, live timing and
 * every race outside the demo need the local backend: their calls reject with a BackendOnlyError and the views read
 * useDemoMode to say so (BACKEND_ONLY_TEXT).
 *
 * Demo mode starts
 *  - at build time: `npm run build:demo` (vite build --mode demo) or
 *    VITE_DEMO=1, the GitHub Pages build (.github/workflows/deploy.yml);
 *  - at run time: when a request fails and GET /api/health does not answer
 *    (apiClient.js), e.g. `npm run dev` with no backend running. A run-time
 *    demo asks /api/health again at most every BACKEND_RECHECK_MS and leaves
 *    demo mode once the backend answers.
 *
 * Pure module apart from the small zustand store below: no React rendering,
 * no I/O.
 */
import { create } from 'zustand';

const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};

/** True in a demo build (vite --mode demo, or VITE_DEMO=1). */
export const DEMO_BUILD = ENV.MODE === 'demo' || ENV.VITE_DEMO === '1' || ENV.VITE_DEMO === 'true';

/** How often a run-time demo asks /api/health again, ms. ASSUMPTION: a few
 * seconds after the backend is started is soon enough; one request per
 * 30 s while it is down costs nothing. */
export const BACKEND_RECHECK_MS = 30000;

/** What a model-only view shows in demo mode (one line, the views' wording). */
export const BACKEND_ONLY_TEXT = 'Requires the local backend';

/** The longer explanation (tooltip / help line of the demo chip). */
export const DEMO_NOTE = 'Static demo: a few bundled races, no backend. The LSTM forecast, '
  + 'telemetry, live timing and the other races need the local backend (see the README).';

/** Features that only the backend can answer (keys of BackendOnlyError.feature). */
export const BACKEND_ONLY_FEATURES = Object.freeze({
  forecast: 'the LSTM lap-time forecast',
  telemetry: 'car telemetry',
  live: 'live timing',
  session: 'races outside the static demo',
  positions: 'raw position data',
});

/**
 * The demo flag the views read: active (answers come from public/data),
 * source ('build' | 'fallback' | null) and the reason a run-time demo
 * started.
 */
export const useDemoMode = create(() => ({
  active: DEMO_BUILD,
  source: DEMO_BUILD ? 'build' : null,
  reason: null,
}));

/** True while the API is answered from public/data. */
export const isDemoActive = () => useDemoMode.getState().active;

/** A run-time demo (the backend did not answer); a demo build is never left. */
export const isFallbackDemo = () => useDemoMode.getState().source === 'fallback';

/** Starts a run-time demo (no effect in a demo build or when already on). */
export function activateDemo(reason = 'the backend did not answer') {
  const s = useDemoMode.getState();
  if (s.active) return;
  useDemoMode.setState({ active: true, source: 'fallback', reason });
}

/** Leaves a run-time demo (the backend answers again); a demo build stays. */
export function deactivateDemo() {
  if (useDemoMode.getState().source !== 'fallback') return;
  useDemoMode.setState({ active: false, source: null, reason: null });
}

/**
 * The rejection of a call only the backend can answer, in demo mode.
 * message = `${BACKEND_ONLY_TEXT}: ${what}`; backendOnly = true.
 */
export class BackendOnlyError extends Error {
  constructor(feature, detail = null) {
    const what = BACKEND_ONLY_FEATURES[feature] || feature;
    super(`${BACKEND_ONLY_TEXT}: ${detail || what}`);
    this.name = 'BackendOnlyError';
    this.backendOnly = true;
    this.feature = feature;
  }
}

/** True for a BackendOnlyError (also across module copies). */
export const isBackendOnlyError = (e) => Boolean(e && e.backendOnly);

/**
 * The views' one read of the flag: BACKEND_ONLY_TEXT while demo mode is
 * on, else null. `const backendOnly = useBackendOnlyText();` then
 * `{backendOnly && <p className="backend-only-note">{backendOnly}</p>}`.
 */
export function useBackendOnlyText() {
  return useDemoMode((s) => (s.active ? BACKEND_ONLY_TEXT : null));
}
