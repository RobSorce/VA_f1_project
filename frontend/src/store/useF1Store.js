import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import * as api from '../utils/apiClient';
import { setHealthReporter } from '../utils/apiClient';
import { computePCA, procrustesAlign2D } from '../utils/livePCA';
import { extractRaceSituationFeatures, FEATURE_NAMES } from '../utils/raceSituationFeatures';
import { simulateRaceFinish } from '../utils/raceSimulation';
import { WINDOW_PRESETS } from '../utils/windowPresets';
import { SLOT_IDS } from '../utils/slotOptions';

/* ── Customizable dock ─────────────────────────────────────────── */

export const DOCK_DEFAULTS = [
  'pitwall',
  'laptimes',
  'tyres',
  'strategy',
  'analytics',
  'prediction',
  'ai',
  'championship',
];

export const DOCK_STORAGE_KEY = 'va-dock-items-v1';

function loadDockItems() {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    if (!raw) return [...DOCK_DEFAULTS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [...DOCK_DEFAULTS];
    // Silently drop ids that no longer exist in the registry.
    const cleaned = parsed.filter((id) => typeof id === 'string' && SLOT_IDS.has(id));
    return cleaned.length > 0 ? cleaned : [...DOCK_DEFAULTS];
  } catch {
    return [...DOCK_DEFAULTS];
  }
}

/* ── Docked layout tree helpers ────────────────────────────────── */

const MAX_PANES = 4;

/** Count leaf panes in the tree */
function _countPanes(node) {
  if (!node) return 0;
  if (!node.children) return 1;
  return _countPanes(node.children[0]) + _countPanes(node.children[1]);
}

/** Collect all tab IDs from every leaf pane in the layout tree */
function _collectDockedTabs(node) {
  if (!node) return [];
  if (!node.children) return node.tabs || [];
  return [..._collectDockedTabs(node.children[0]), ..._collectDockedTabs(node.children[1])];
}

/** Activate a tab in the pane that contains it (set activeTab) */
function _activateTabInTree(node, tabId) {
  if (!node) return node;
  if (!node.children) {
    if (node.tabs && node.tabs.includes(tabId)) {
      return { ...node, activeTab: tabId };
    }
    return node;
  }
  return {
    ...node,
    children: [
      _activateTabInTree(node.children[0], tabId),
      _activateTabInTree(node.children[1], tabId),
    ],
  };
}

/** Append a new single-tab pane to the tree without rebuilding existing panes */
function _appendPane(node, tabId) {
  const newLeaf = { tabs: [tabId], activeTab: tabId };
  // Alternate split direction from the root
  const dir = (node.children && node.direction === 'horizontal') ? 'vertical' : 'horizontal';
  const panes = _countPanes(node);
  // Give existing content proportional space, new pane gets 1/(n+1)
  const ratio = panes / (panes + 1);
  return { direction: dir, ratio, children: [node, newLeaf] };
}

/** Add a tab to the first leaf pane found (depth-first) and activate it */
function _addTabToFirstLeaf(node, tabId) {
  if (!node) return node;
  if (!node.children) {
    // This is a leaf — add the tab here
    return { ...node, tabs: [...(node.tabs || []), tabId], activeTab: tabId };
  }
  // Recurse into first child only (so tab goes to top-left pane)
  return {
    ...node,
    children: [
      _addTabToFirstLeaf(node.children[0], tabId),
      node.children[1],
    ],
  };
}

/** Remove a tab from the entire tree. If a pane becomes empty, collapse the split. */
function _removeTabFromTree(node, tabId) {
  if (!node) return node;
  if (!node.children) {
    // Leaf node
    const newTabs = (node.tabs || []).filter((t) => t !== tabId);
    if (newTabs.length === 0) return null; // pane is empty — signal removal
    return { ...node, tabs: newTabs, activeTab: node.activeTab === tabId ? newTabs[0] : node.activeTab };
  }
  // Split node — recurse
  let left = _removeTabFromTree(node.children[0], tabId);
  let right = _removeTabFromTree(node.children[1], tabId);
  // If one child was emptied, collapse to the other
  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

/**
 * Group an array of tab IDs into at most MAX_PANES pane groups.
 * Each group becomes a single pane with multiple tabs.
 */
function _groupTabs(tabIds) {
  if (tabIds.length <= MAX_PANES) {
    return tabIds.map((id) => [id]);
  }
  // Distribute tabs into MAX_PANES groups as evenly as possible
  const groups = Array.from({ length: MAX_PANES }, () => []);
  tabIds.forEach((id, i) => groups[i % MAX_PANES].push(id));
  return groups;
}

/**
 * Build a docked layout tree from an array of tab IDs.
 * Caps at MAX_PANES panes — excess tabs are grouped into shared panes.
 * Generates different arrangements based on `variant` index:
 *   0 = balanced grid (2-col rows)
 *   1 = all horizontal (side by side columns)
 *   2 = all vertical (stacked rows)
 *   3 = main + sidebar (first pane big, rest stacked on right)
 */
function _buildDockedTree(tabIds, variant = 0) {
  if (tabIds.length === 0) return null;
  if (tabIds.length === 1) {
    return { tabs: [tabIds[0]], activeTab: tabIds[0] };
  }

  // Group tabs into at most MAX_PANES panes
  const groups = _groupTabs(tabIds);
  const pane = (g) => ({ tabs: g, activeTab: g[0] });
  const n = groups.length;
  // n is guaranteed <= MAX_PANES (4)

  const effectiveVariant = variant % 4;

  if (n === 1) return pane(groups[0]);

  if (n === 2) {
    const dir = effectiveVariant === 2 ? 'vertical' : 'horizontal';
    return { direction: dir, ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] };
  }

  if (n === 3) {
    if (effectiveVariant === 1) {
      // 3 columns
      return {
        direction: 'horizontal', ratio: 0.33,
        children: [
          pane(groups[0]),
          { direction: 'horizontal', ratio: 0.5, children: [pane(groups[1]), pane(groups[2])] },
        ],
      };
    }
    if (effectiveVariant === 2) {
      // 3 rows
      return {
        direction: 'vertical', ratio: 0.33,
        children: [
          pane(groups[0]),
          { direction: 'vertical', ratio: 0.5, children: [pane(groups[1]), pane(groups[2])] },
        ],
      };
    }
    if (effectiveVariant === 3) {
      // Main + sidebar (2 stacked)
      return {
        direction: 'horizontal', ratio: 0.6,
        children: [
          pane(groups[0]),
          { direction: 'vertical', ratio: 0.5, children: [pane(groups[1]), pane(groups[2])] },
        ],
      };
    }
    // Variant 0: top row of 2 + bottom
    return {
      direction: 'vertical', ratio: 0.5,
      children: [
        { direction: 'horizontal', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
        pane(groups[2]),
      ],
    };
  }

  // n === 4
  if (effectiveVariant === 1) {
    // 4 columns
    return {
      direction: 'horizontal', ratio: 0.5,
      children: [
        { direction: 'horizontal', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
        { direction: 'horizontal', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
      ],
    };
  }
  if (effectiveVariant === 2) {
    // 4 rows
    return {
      direction: 'vertical', ratio: 0.5,
      children: [
        { direction: 'vertical', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
        { direction: 'vertical', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
      ],
    };
  }
  if (effectiveVariant === 3) {
    // Main + 3 stacked on right
    return {
      direction: 'horizontal', ratio: 0.5,
      children: [
        pane(groups[0]),
        { direction: 'vertical', ratio: 0.33,
          children: [
            pane(groups[1]),
            { direction: 'vertical', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
          ],
        },
      ],
    };
  }
  // Variant 0: 2x2 grid
  return {
    direction: 'vertical', ratio: 0.5,
    children: [
      { direction: 'horizontal', ratio: 0.5, children: [pane(groups[0]), pane(groups[1])] },
      { direction: 'horizontal', ratio: 0.5, children: [pane(groups[2]), pane(groups[3])] },
    ],
  };
}

const ARRANGE_LAYOUTS = {
  1: [
    (ids) => ({ [ids[0]]: { left: '0%', top: '0%', width: '100%', height: '100%' } }),
  ],
  2: [
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '100%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '100%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '100%', height: '50%' },
      [ids[1]]: { left: '0%', top: '50%', width: '100%', height: '50%' },
    }),
  ],
  3: [
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '100%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '50%' },
      [ids[2]]: { left: '50%', top: '50%', width: '50%', height: '50%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '33.33%', height: '100%' },
      [ids[1]]: { left: '33.33%', top: '0%', width: '33.34%', height: '100%' },
      [ids[2]]: { left: '66.67%', top: '0%', width: '33.33%', height: '100%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '50%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '50%' },
      [ids[2]]: { left: '0%', top: '50%', width: '100%', height: '50%' },
    }),
  ],
  4: [
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '50%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '50%' },
      [ids[2]]: { left: '0%', top: '50%', width: '50%', height: '50%' },
      [ids[3]]: { left: '50%', top: '50%', width: '50%', height: '50%' },
    }),
    (ids) => ({
      [ids[0]]: { left: '0%', top: '0%', width: '50%', height: '100%' },
      [ids[1]]: { left: '50%', top: '0%', width: '50%', height: '33.33%' },
      [ids[2]]: { left: '50%', top: '33.33%', width: '50%', height: '33.34%' },
      [ids[3]]: { left: '50%', top: '66.67%', width: '50%', height: '33.33%' },
    }),
  ],
};

function autoGridLayout(ids) {
  const n = ids.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const tiles = {};
  ids.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    tiles[id] = {
      left: `${(col / cols) * 100}%`,
      top: `${(row / rows) * 100}%`,
      width: `${100 / cols}%`,
      height: `${100 / rows}%`,
    };
  });
  return tiles;
}

// Module-level dedup for schedule fetch (immune to store/middleware timing)
let _schedulePromise = null;
let _scheduleYear = null;

// Module-level generation counter for loadSession to prevent stale async responses
let _sessionLoadGeneration = 0;

export const useF1Store = create(persist((set, get) => ({
  // ── Session ─────────────────────────────────────────────────────
  year: 2024,
  round: null,
  sessionType: 'R',
  schedule: [],
  sessionData: null,
  drivers: [],
  circuitInfo: null,
  isLoading: false,
  isLoadingFrames: false,
  error: null,
  trackStatus: [],       // [{status, start_time, end_time, message}]
  currentFlagStatus: '1', // '1'=green, '2'=yellow, '4'=SC, '5'=red, '6'/'7'=VSC
  dnfMap: {},            // { driverAbbr: { status: 'Crash', lastLap: 45 } }

  // ── Live Mode ──────────────────────────────────────────────────
  isLiveMode: false,
  liveConnected: false,          // WebSocket connected
  liveSessionInfo: null,         // {event_name, session_type, ...}
  liveConnectionStatus: 'disconnected', // 'connected'|'disconnected'|'reconnecting'
  liveStandings: null,           // driver standings from live position updates
  raceControlMessages: [],       // live race control messages
  totalRaceLaps: null,           // total laps in the race (from lap_count)
  liveTelemetry: {},             // {DRIVER: {speed, throttle, brake, gear, rpm, drs, updated}}

  // ── Qualifying replay ──────────────────────────────────────────
  qualiSegments: null,     // {Q1: {frames, driver_colors, ...}, Q2: {...}, Q3: {...}}
  qualiSegment: 'Q3',     // Active segment
  isQualifyingReplay: false,

  // ── Pre-session driver preview (selector screen) ──────────────
  previewDrivers: [],          // drivers fetched before full session load
  previewDriversLoading: false,
  preSelectedDrivers: [],      // drivers toggled on selector screen

  // ── Help overlay (per-chart docs) ─────────────────────────────
  helpTabId: null,
  helpTitle: null,
  openHelp: (tabId, title = null) => set({ helpTabId: tabId || null, helpTitle: title || null }),
  closeHelp: () => set({ helpTabId: null, helpTitle: null }),

  // ── Toast / notification stack ────────────────────────────────
  // { id, kind: 'info'|'warn'|'error'|'undo', message, action?, actionLabel?, timeout? }
  toasts: [],
  pushToast: (toast) => {
    const id = toast.id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry = { id, kind: 'info', timeout: 5000, ...toast };
    set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== id), entry] }));
    if (entry.timeout > 0) {
      setTimeout(() => {
        const cur = get().toasts;
        if (cur.some((t) => t.id === id)) {
          set({ toasts: cur.filter((t) => t.id !== id) });
        }
      }, entry.timeout);
    }
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),

  // ── Backend reachability (for the global status banner) ───────
  backendHealthy: true,
  lastBackendError: null,
  reportBackendError: (message) => {
    set({ backendHealthy: false, lastBackendError: message });
    get().pushToast({
      id: 'backend-down',
      kind: 'error',
      message: `Backend unreachable (${message || 'network error'}). Panels may show stale data.`,
      actionLabel: 'Retry',
      timeout: 0,
      action: () => {
        // Cheap health probe — any successful fetch flips backendHealthy back
        // via the axios response interceptor.
        const y = get().year;
        if (y) api.getSchedule(y).catch(() => {});
      },
    });
  },
  reportBackendOk: () => {
    const s = get();
    if (!s.backendHealthy) {
      set({ backendHealthy: true, lastBackendError: null });
      s.dismissToast('backend-down');
      s.pushToast({ kind: 'info', message: 'Backend reconnected', timeout: 3000 });
    }
  },

  setYear: (year) => set({ year }),
  setRound: (round) => set({ round }),
  setSessionType: (sessionType) => set({ sessionType }),

  fetchSchedule: async (year) => {
    // Return existing promise if already fetching this year
    if (_scheduleYear === year && _schedulePromise) return _schedulePromise;
    // Skip if schedule already loaded for this year
    const s = get();
    if (s.schedule.length > 0 && s.year === year) return;
    _scheduleYear = year;
    _schedulePromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.getSchedule(year);
          set({ schedule: data.events || [], year });
          return;
        } catch (e) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
            continue;
          }
          console.error('Failed to fetch schedule', e);
        }
      }
    })();
    _schedulePromise.finally(() => { _schedulePromise = null; _scheduleYear = null; });
    return _schedulePromise;
  },

  fetchDriversPreview: async (year, round) => {
    if (!year || !round) return;
    set({ previewDriversLoading: true, previewDrivers: [], preSelectedDrivers: [] });
    try {
      const data = await api.getDrivers(year, round);
      set({ previewDrivers: data.drivers || [], previewDriversLoading: false });
    } catch (e) {
      console.warn('Failed to fetch driver preview', e);
      set({ previewDriversLoading: false });
    }
  },

  togglePreSelectedDriver: (abbr) =>
    set((s) => {
      const sel = s.preSelectedDrivers.includes(abbr)
        ? s.preSelectedDrivers.filter((d) => d !== abbr)
        : [...s.preSelectedDrivers, abbr];
      return { preSelectedDrivers: sel };
    }),

  setPreSelectedDrivers: (list) => set({ preSelectedDrivers: list }),

  loadSession: async () => {
    const { year, round, sessionType } = get();
    if (!year || !round) return;

    // If switching from live mode, disconnect first
    if (get().isLiveMode) {
      try {
        const { liveWS } = await import('../utils/liveWebSocket');
        liveWS.disconnect();
        await api.stopMockReplay().catch(() => {});
      } catch (_) { /* ignore */ }
      set({
        isLiveMode: false,
        liveConnected: false,
        liveSessionInfo: null,
        liveConnectionStatus: 'disconnected',
        liveStandings: null,
        raceControlMessages: [],
        totalRaceLaps: null,
        liveTelemetry: {},
      });
    }

    // Increment generation counter to invalidate any in-flight loads
    const generation = ++_sessionLoadGeneration;

    set({ isLoading: true, error: null });
    try {
      const data = await api.getSession(year, round, sessionType);

      // If another loadSession was triggered while we waited, discard this result
      if (generation !== _sessionLoadGeneration) return;

      // Compute maxLap from lap_times data
      const lapTimes = data.lap_times || [];
      let computedMaxLap = 1;
      for (const lt of lapTimes) {
        if (lt.LapNumber && lt.LapNumber > computedMaxLap) {
          computedMaxLap = lt.LapNumber;
        }
      }

      // Build DNF map from race_results
      const dnfMap = {};
      (data.race_results || []).forEach((r) => {
        const abbr = r.Abbreviation;
        if (!abbr) return;
        const cp = String(r.ClassifiedPosition || '');
        // "R" = retired, "D" = disqualified, "E" = excluded, "W" = withdrawn, "N" = not classified
        if (cp === 'R' || cp === 'D' || cp === 'E' || cp === 'W' || cp === 'N') {
          dnfMap[abbr] = {
            status: r.Status || 'Retired',
            lastLap: r.Laps || computedMaxLap,
            classifiedPosition: cp,
          };
        }
      });

      // Apply pre-selected drivers if any
      const preSelected = get().preSelectedDrivers;

      set({
        sessionData: data,
        drivers: data.driver_info || [],
        trackStatus: data.track_status || [],
        dnfMap,
        maxLap: computedMaxLap,
        currentLap: 1,
        isPlaying: false,
        frameData: null,
        lapFrameMap: null,
        currentFrameIndex: 0,
        totalFrames: 0,
        telemetryCache: {},
        telemetryCompareLaps: [],
        sectorRankings: null,
        consistencyData: null,
        speedRankings: null,
        // Reset race situation state from previous session
        raceSituationLap: null,
        raceSituationData: null,
        raceProjection: null,
        simulatorStrategy: null, simulatorResult: null, simulatorComparisons: [], isSimulatorActive: false,
        _prevPcaResult: null,
        lstmPredictions: null,
        degradationRegression: null,
        // Clear qualifying state from previous session
        qualiSegments: null,
        qualiSegment: 'Q3',
        isQualifyingReplay: false,
        ...(preSelected.length > 0 ? { selectedDrivers: preSelected } : {}),
      });

      // Load circuit, strategy, frames, and analytics in parallel
      // For qualifying: skip strategy (irrelevant), load frames eagerly
      const parallelTasks = [
        api.getCircuit(year, round).then((circuit) => set({ circuitInfo: circuit })),
      ];

      if (sessionType !== 'Q') {
        parallelTasks.push(
          api.getStrategy(year, round)
            .then((strategy) => set((s) => ({
              sessionData: { ...s.sessionData, strategies: strategy.strategies || [] },
            })))
            .catch((e) => console.warn('Strategy data not available', e))
        );
      }

      if (sessionType === 'R' || sessionType === 'S' || sessionType === 'Q') {
        console.log(`Session loaded (${sessionType}): ${computedMaxLap} laps. Loading frames in background...`);
        parallelTasks.push(get().loadFrames());
      } else {
        console.log(`Session loaded (${sessionType}): ${computedMaxLap} laps. Skipping frame loading.`);
      }

      parallelTasks.push(get().fetchAnalytics());

      await Promise.allSettled(parallelTasks);
      // Only clear loading if this is still the active session load
      if (generation === _sessionLoadGeneration) {
        set({ isLoading: false });
      }

    } catch (e) {
      set({ isLoading: false, error: e.message });
      console.error('Failed to load session', e);
    }
  },

  // ── Live Mode Actions ──────────────────────────────────────────

  enterLiveMode: async (mockYear, mockRound, mockSpeed) => {
    const { liveWS: _liveWSRef } = await import('../utils/liveWebSocket');
    const liveWS = _liveWSRef ?? (await import('../utils/liveWebSocket')).liveWS;

    set({ isLoading: true, error: null });
    try {
      // If mock parameters provided, start mock replay first
      if (mockYear && mockRound) {
        await api.startMockReplay(mockYear, mockRound, mockSpeed || 10);
        // Give the mock replay a moment to initialize
        await new Promise((r) => setTimeout(r, 500));
      }

      // Get live status — if not active, try connecting SignalR first
      let status = await api.getLiveStatus();
      if (!status.active && !mockYear) {
        // Attempt to connect to F1 live timing
        try {
          await api.connectSignalR();
          // Wait for connection and initial data
          await new Promise((r) => setTimeout(r, 3000));
          status = await api.getLiveStatus();
        } catch (_) { /* ignore */ }
        if (!status.active) {
          set({ isLoading: false, error: 'No active F1 session. SignalR connection failed or no session running.' });
          return;
        }
      }

      // Get full snapshot
      const snapshot = await api.getLiveSnapshot();

      // Compute maxLap
      const lapTimes = snapshot.lap_times || [];
      let computedMaxLap = 1;
      for (const lt of lapTimes) {
        if (lt.LapNumber && lt.LapNumber > computedMaxLap) computedMaxLap = lt.LapNumber;
      }

      // Load circuit info if available
      let circuitInfo = snapshot.circuit_info || null;
      // If circuit_info exists but has no track_coordinates, it's metadata only
      if (circuitInfo && !circuitInfo.track_coordinates) {
        circuitInfo = null;
      }

      set({
        isLiveMode: true,
        liveSessionInfo: status.session_info || null,
        sessionData: snapshot,
        drivers: snapshot.driver_info || [],
        trackStatus: snapshot.track_status || [],
        maxLap: computedMaxLap,
        currentLap: status.current_lap || computedMaxLap,
        totalRaceLaps: status.total_laps || null,
        isPlaying: false,
        frameData: null,
        lapFrameMap: null,
        currentFrameIndex: 0,
        totalFrames: 0,
        circuitInfo,
        dnfMap: {},
        telemetryCache: {},
        lstmPredictions: null,
        degradationRegression: null,
        raceSituationLap: null,
        raceSituationData: null,
        raceProjection: null,
        _prevPcaResult: null,
      });

      // If no track coordinates in snapshot, try loading from cached session
      if (!circuitInfo && mockYear && mockRound) {
        try {
          const cached = await api.getCircuit(mockYear, mockRound);
          if (cached?.track_coordinates?.length) {
            set({ circuitInfo: cached });
          }
        } catch (_) { /* ignore — track map just won't show */ }
      }

      // If session has already ended, load full data from FastF1
      // (SignalR snapshot only has current state, not full lap history)
      const sessionStatus = status.session_status || '';
      const isFinished = ['Ends', 'Finished', 'Finalised'].includes(sessionStatus);
      if (isFinished) {
        try {
          console.log('Session finished — loading full data from FastF1...');
          const fullData = await api.loadLiveFullSession();
          if (fullData && fullData.lap_times?.length > 0 && !fullData.error) {
            const fullLapTimes = fullData.lap_times;
            let fullMaxLap = 1;
            for (const lt of fullLapTimes) {
              if (lt.LapNumber && lt.LapNumber > fullMaxLap) fullMaxLap = lt.LapNumber;
            }
            const fullCircuitInfo = fullData.circuit_info?.track_coordinates
              ? fullData.circuit_info : get().circuitInfo;
            set({
              sessionData: fullData,
              drivers: fullData.driver_info || get().drivers,
              trackStatus: fullData.track_status || get().trackStatus,
              maxLap: fullMaxLap,
              currentLap: fullMaxLap,
              circuitInfo: fullCircuitInfo,
            });
            console.log(`Full session loaded: ${fullLapTimes.length} lap entries, ${fullMaxLap} laps`);
          }
        } catch (e) {
          console.warn('Could not load full session data:', e.message);
        }
      }

      // Connect WebSocket for incremental updates
      liveWS.connect(
        (msg) => get()._handleLiveMessage(msg),
        (statusVal) => set({
          liveConnected: statusVal === 'connected',
          liveConnectionStatus: statusVal,
        }),
      );

      set({ isLoading: false });
    } catch (e) {
      set({ isLoading: false, error: e.message });
      console.error('Failed to enter live mode', e);
    }
  },

  exitLiveMode: async () => {
    const { liveWS } = await import('../utils/liveWebSocket');
    liveWS.disconnect();

    // Stop mock replay if running
    try { await api.stopMockReplay(); } catch (_) { /* ignore */ }

    set({
      isLiveMode: false,
      liveConnected: false,
      liveSessionInfo: null,
      liveConnectionStatus: 'disconnected',
      liveStandings: null,
      raceControlMessages: [],
      liveTelemetry: {},
      sessionData: null,
      drivers: [],
      frameData: null,
      circuitInfo: null,
      trackStatus: [],
      currentLap: 1,
      maxLap: 1,
    });
  },

  _handleLiveMessage: (msg) => {
    const { type, data } = msg;
    const state = get();

    switch (type) {
      case 'session_init': {
        // Full snapshot on connect — already handled by enterLiveMode
        break;
      }

      case 'lap_update': {
        // Append new lap time entry
        const lapTimes = [...(state.sessionData?.lap_times || []), data];
        const lapNum = data.LapNumber || 0;
        const updatedMaxLap = Math.max(state.maxLap, lapNum);
        set({
          sessionData: { ...state.sessionData, lap_times: lapTimes },
          currentLap: Math.max(state.currentLap, lapNum),
          // maxLap tracks the furthest lap seen (not totalRaceLaps)
          maxLap: updatedMaxLap,
        });

        // Trigger LSTM predictions every 2 laps
        if (updatedMaxLap > 2 && updatedMaxLap % 2 === 0 && state.triggerLSTMPredictions) {
          state.triggerLSTMPredictions();
        }

        // Compute race situation (PCA + Monte Carlo) every lap
        if (updatedMaxLap >= 3) {
          setTimeout(() => get().computeRaceSituation(), 0);
        }
        break;
      }

      case 'position_update': {
        // Update driver standings — data is array of standings
        if (Array.isArray(data)) {
          set({ liveStandings: data });
        }
        break;
      }

      case 'strategy_update': {
        const strategies = [...(state.sessionData?.tyre_strategy || []), data];
        set({
          sessionData: {
            ...state.sessionData,
            tyre_strategy: strategies,
            strategies, // Also update the strategies key used by some components
          },
        });
        break;
      }

      case 'weather_update': {
        const weather = [...(state.sessionData?.weather_data || []), data];
        set({ sessionData: { ...state.sessionData, weather_data: weather } });
        break;
      }

      case 'track_status': {
        const newStatus = [...state.trackStatus, data];
        set({
          trackStatus: newStatus,
          currentFlagStatus: data.status || '1',
          sessionData: { ...state.sessionData, track_status: newStatus },
        });
        break;
      }

      case 'lap_count': {
        const { current_lap, total_laps } = data;
        set({
          currentLap: current_lap,
          maxLap: Math.max(state.maxLap, current_lap),
          totalRaceLaps: total_laps || state.totalRaceLaps,
        });
        break;
      }

      case 'driver_list': {
        set({ drivers: data });
        break;
      }

      case 'session_info': {
        set({ liveSessionInfo: data });
        // Also update sessionData so UI components (WeatherBar, SessionInfoBar) see the name
        if (data && state.sessionData) {
          const updatedCircuit = { ...(state.sessionData.circuit_info || {}), ...data };
          set({
            sessionData: { ...state.sessionData, circuit_info: updatedCircuit },
          });
          // If circuit_info gained track coordinates, update circuitInfo too
          if (data.circuit_info?.track_coordinates) {
            set({ circuitInfo: data.circuit_info });
          }
        }
        break;
      }

      case 'frame': {
        // Append position frame — used by TrackMap
        const frames = state.frameData?.frames || [];
        frames.push(data);
        // Keep bounded
        if (frames.length > 500) frames.splice(0, frames.length - 300);
        set({
          frameData: { ...state.frameData, frames },
          currentFrameIndex: frames.length - 1,
          totalFrames: frames.length,
        });
        break;
      }

      case 'session_end': {
        set({ liveSessionInfo: { ...state.liveSessionInfo, ended: true } });
        break;
      }

      case 'race_control': {
        set((s) => ({
          raceControlMessages: [
            ...s.raceControlMessages,
            { ...data, timestamp: Date.now() },
          ],
        }));
        break;
      }

      case 'telemetry_update': {
        // Live telemetry from OpenF1: {driver, driver_number, samples}
        const driver = data.driver;
        const samples = data.samples || [];
        if (driver && samples.length > 0) {
          set((s) => ({
            liveTelemetry: {
              ...s.liveTelemetry,
              [driver]: {
                ...samples[samples.length - 1],
                updated: Date.now(),
              },
            },
          }));
        }
        break;
      }

      case 'heartbeat':
        break;

      default:
        break;
    }
  },

  // ── Command Palette & Keyboard ────────────────────────────────
  commandPaletteOpen: false,
  focusedView: null,         // 'trackmap' | 'leaderboard' | 'laptimes' | 'strategy' | 'tires' | null
  compareMode: false,
  compareDrivers: [],        // max 2 driver abbreviations
  comparisonDriver: null,    // shared focus-vs-comparison target for Sector Delta / Undercut Calculator
  leaderboardColumnMode: 0,  // index into ['INT','GAP','TYRE','PIT']
  shortcutHintsVisible: true,
  cheatsheetOpen: false,

  toggleCommandPalette: () => set(s => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  setFocusedView: (view) => set(s => ({ focusedView: s.focusedView === view ? null : view })),
  clearFocusedView: () => set({ focusedView: null }),
  toggleCompareMode: () => set(s => ({
    compareMode: !s.compareMode,
    compareDrivers: s.compareMode ? [] : s.compareDrivers,
  })),
  cycleLeaderboardColumn: () => set(s => ({ leaderboardColumnMode: (s.leaderboardColumnMode + 1) % 4 })),
  addCompareDriver: (driver) => set(s => {
    if (s.compareDrivers.includes(driver)) {
      return { compareDrivers: s.compareDrivers.filter(d => d !== driver) };
    }
    return {
      compareDrivers: s.compareDrivers.length < 2
        ? [...s.compareDrivers, driver]
        : [s.compareDrivers[1], driver],
    };
  }),
  removeCompareDriver: (driver) => set(s => ({
    compareDrivers: s.compareDrivers.filter(d => d !== driver),
  })),
  setComparisonDriver: (driver) => set({ comparisonDriver: driver }),
  clearComparisonDriver: () => set({ comparisonDriver: null }),
  toggleShortcutHints: () => set(s => ({ shortcutHintsVisible: !s.shortcutHintsVisible })),
  toggleCheatsheet: () => set(s => ({ cheatsheetOpen: !s.cheatsheetOpen })),
  openCheatsheet: () => set({ cheatsheetOpen: true }),
  closeCheatsheet: () => set({ cheatsheetOpen: false }),

  // ── Track Map Overlays ────────────────────────────────────────
  showTrackSectors: true,   // all 3 sectors
  showTrackDRS: true,
  toggleTrackSectors: () => set(s => ({ showTrackSectors: !s.showTrackSectors })),
  toggleTrackDRS: () => set(s => ({ showTrackDRS: !s.showTrackDRS })),

  // Track rotation (90° steps, 4 clicks = full cycle)
  trackRotationOffset: 0,
  rotateTrackCW: () => set(s => ({ trackRotationOffset: (s.trackRotationOffset - 90 + 360) % 360 })),
  rotateTrackCCW: () => set(s => ({ trackRotationOffset: (s.trackRotationOffset + 90) % 360 })),
  resetTrackRotation: () => set({ trackRotationOffset: 0 }),
  setTrackRotationAbsolute: (deg) => set({ trackRotationOffset: ((deg % 360) + 360) % 360 }),

  // ── Tab / Panel system (multi-window) ──────────────────────────
  activeTab: 'pitwall',
  openOverlays: [],

  // ── Customizable dock ──────────────────────────────────────────
  dockItems: loadDockItems(),

  setDockItems: (items) => set({ dockItems: items }),

  addDockItem: (id, position = -1) => set((s) => {
    if (s.dockItems.includes(id)) return s;
    if (!SLOT_IDS.has(id)) return s;
    const next = [...s.dockItems];
    if (position < 0 || position > next.length) next.push(id);
    else next.splice(position, 0, id);
    return { dockItems: next };
  }),

  removeDockItem: (id) => {
    const s = get();
    if (s.dockItems.length <= 1) return; // never allow empty dock
    const idx = s.dockItems.indexOf(id);
    if (idx < 0) return;
    const prev = [...s.dockItems];
    const label = (SLOT_IDS.has(id) && id) || 'item';
    set({ dockItems: prev.filter((t) => t !== id) });
    // Offer undo — restores the item at its original index.
    s.pushToast({
      kind: 'undo',
      message: `Removed "${label}" from dock`,
      actionLabel: 'Undo',
      timeout: 6000,
      action: () => set({ dockItems: prev }),
    });
  },

  moveDockItem: (id, direction) => set((s) => {
    const idx = s.dockItems.indexOf(id);
    if (idx < 0) return s;
    const newIdx = direction === 'left' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= s.dockItems.length) return s;
    const next = [...s.dockItems];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    return { dockItems: next };
  }),

  resetDockItems: () => {
    const prev = [...get().dockItems];
    set({ dockItems: [...DOCK_DEFAULTS] });
    get().pushToast({
      kind: 'undo',
      message: 'Dock reset to defaults',
      actionLabel: 'Undo',
      timeout: 6000,
      action: () => set({ dockItems: prev }),
    });
  },

  setActiveTab: (tab) => {
    const UTILITY_TABS = new Set(['settings']);

    // ── Mode switches ──
    if (tab === 'pitwall') {
      set((s) => ({
        activeTab: 'pitwall',
        dockedLayout: null,
        _arrangeIdx: 0,
        // Keep utility overlays open
      }));
      return;
    }

    if (tab === 'charts') {
      set((s) => ({
        activeTab: 'charts',
        dockedLayout: null,
        _arrangeIdx: 0,
      }));
      return;
    }

    // ── Utility tabs → floating overlay (works over ANY mode) ──
    if (UTILITY_TABS.has(tab)) {
      set((s) => {
        const already = s.openOverlays.includes(tab);
        if (already) {
          // Toggle off
          const next = s.openOverlays.filter((t) => t !== tab);
          return { openOverlays: next };
        }
        // Toggle on — add to overlays without changing active mode
        return { openOverlays: [...s.openOverlays, tab] };
      });
      return;
    }

    // ── Analysis tabs → docked layout ──
    // Tabbed-MDI behaviour: a new chart from the dock or from any
    // chart picker always opens as a *tab* in the existing pane.
    // Splits stay available via the layout toolbar (the arrange-buttons
    // cycle) and the per-pane `+` dropdown — but never happen silently
    // as a side effect of opening a chart. This matches the VS Code /
    // JetBrains mental model users already have and removes the
    // inconsistency between dock-click and `+`-click paths.
    set((s) => {
      if (s.dockedLayout) {
        const allTabs = _collectDockedTabs(s.dockedLayout);
        if (allTabs.includes(tab)) {
          // Tab exists in layout — remove it (toggle off)
          const newLayout = _removeTabFromTree(s.dockedLayout, tab);
          if (!newLayout) return { dockedLayout: null, activeTab: s.activeTab === 'pitwall' ? 'pitwall' : 'charts', _arrangeIdx: 0 };
          return { dockedLayout: newLayout };
        }
        // Tab not in layout — add to the first leaf as a new tab.
        // If the user wants it in a different pane of a split layout,
        // they can drag it there or use the target pane's `+` menu.
        return { dockedLayout: _addTabToFirstLeaf(s.dockedLayout, tab), activeTab: 'charts' };
      }

      // No docked layout exists yet — create one with this tab
      return {
        dockedLayout: { tabs: [tab], activeTab: tab },
        activeTab: 'charts',
        openOverlays: s.openOverlays.filter((t) => UTILITY_TABS.has(t)),
        _arrangeIdx: 0,
      };
    });
  },

  focusOverlay: (tab) => set((s) => {
    if (!s.openOverlays.includes(tab)) return s;
    return { activeTab: tab };
  }),

  closeOverlay: (tab) => set((s) => {
    // Utility overlays live in openOverlays — always check there first
    if (s.openOverlays.includes(tab)) {
      const next = s.openOverlays.filter((t) => t !== tab);
      const tiles = { ...s.overlayTiles };
      delete tiles[tab];
      const vizMap = { ...s.overlayVizMapping };
      delete vizMap[tab];
      return { openOverlays: next, overlayTiles: tiles, overlayVizMapping: vizMap };
    }
    // In docked mode: remove tab from the layout tree
    if (s.dockedLayout) {
      const newLayout = _removeTabFromTree(s.dockedLayout, tab);
      if (!newLayout) return { dockedLayout: null, activeTab: 'charts', _arrangeIdx: 0 };
      return { dockedLayout: newLayout };
    }
    return {};
  }),

  /** Close the most recently added tab (last leaf, last tab). Works in both modes. */
  closeLastTab: () => set((s) => {
    if (s.dockedLayout) {
      const allTabs = _collectDockedTabs(s.dockedLayout);
      if (allTabs.length === 0) return { dockedLayout: null, activeTab: 'charts' };
      const lastTab = allTabs[allTabs.length - 1];
      const newLayout = _removeTabFromTree(s.dockedLayout, lastTab);
      if (!newLayout) return { dockedLayout: null, activeTab: 'charts', _arrangeIdx: 0 };
      return { dockedLayout: newLayout };
    }
    if (s.openOverlays.length === 0) return s;
    const last = s.openOverlays[s.openOverlays.length - 1];
    const next = s.openOverlays.slice(0, -1);
    const tiles = { ...s.overlayTiles };
    delete tiles[last];
    const vizMap = { ...s.overlayVizMapping };
    delete vizMap[last];
    return { openOverlays: next, activeTab: next.length > 0 ? next[next.length - 1] : 'charts', overlayTiles: tiles, overlayVizMapping: vizMap };
  }),

  closeAllOverlays: () => set({
    openOverlays: [],
    activeTab: 'pitwall',
    overlayTiles: {},
    overlayVizMapping: {},
    dockedLayout: null,
    _arrangeIdx: 0,
  }),

  cycleOverlay: (direction = 1) => set((s) => {
    if (s.openOverlays.length === 0) return s;
    const idx = s.openOverlays.indexOf(s.activeTab);
    const len = s.openOverlays.length;
    const next = s.openOverlays[((idx === -1 ? 0 : idx) + direction + len) % len];
    return { activeTab: next };
  }),

  // ── Gemini floating panel ─────────────────────────────────────
  geminiPanelOpen: false,
  toggleGeminiPanel: () => set((s) => ({ geminiPanelOpen: !s.geminiPanelOpen })),

  // ── Settings (persist across sessions) ──────────────────────────
  theme: 'dark',
  tempUnit: 'C',
  speedUnit: 'kmh',
  overlayTiles: {},
  overlayVizMapping: {},
  _arrangeIdx: 0,
  dockedLayout: null, // JetBrains-style split-pane layout tree (null = use floating overlays)
  showDashboard: true,
  leaderboardCollapsed: false,
  telemetryChannels: { speed: true, delta: true, throttle: true, brake: true, gear: true, rpm: true },

  setTheme: () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    set({ theme: 'dark' });
  },
  setTempUnit: (tempUnit) => set({ tempUnit }),
  toggleLeaderboard: () => set((s) => ({ leaderboardCollapsed: !s.leaderboardCollapsed })),
  setSpeedUnit: (speedUnit) => set({ speedUnit }),
  tileOverlay: (tabId, tile) => set((s) => ({
    overlayTiles: { ...s.overlayTiles, [tabId]: tile },
  })),
  clearTile: (tabId) => set((s) => {
    const next = { ...s.overlayTiles };
    delete next[tabId];
    return { overlayTiles: next };
  }),
  tileActiveOverlay: (tile) => set((s) => {
    if (s.openOverlays.length === 0) return s;
    const tabId = s.activeTab;
    if (!s.openOverlays.includes(tabId)) return s;
    if (s.overlayTiles[tabId] === tile) {
      const next = { ...s.overlayTiles };
      delete next[tabId];
      return { overlayTiles: next };
    }
    return { overlayTiles: { ...s.overlayTiles, [tabId]: tile } };
  }),
  arrangeOverlays: () => set((s) => {
    // ── Docked mode: cycle through layout variants for the same tabs ──
    if (s.dockedLayout) {
      const currentTabs = _collectDockedTabs(s.dockedLayout);
      if (currentTabs.length === 0) return s;
      const nextIdx = (s._arrangeIdx + 1) % 4; // 4 variants: grid, horizontal, vertical, main+sidebar
      return {
        dockedLayout: _buildDockedTree(currentTabs, nextIdx),
        _arrangeIdx: nextIdx,
      };
    }

    // ── Floating overlay mode: Ctrl+G docks them into a layout ──
    const ids = s.openOverlays;
    if (ids.length === 0) return s;
    // Convert floating overlays → docked layout
    return {
      activeTab: 'charts',
      openOverlays: [],
      overlayTiles: {},
      overlayVizMapping: {},
      dockedLayout: _buildDockedTree(ids, 0),
      _arrangeIdx: 0,
    };
  }),
  applyWindowPreset: (preset) => {
    const UTILITY_TABS = new Set(['settings']);
    // If preset has a docked layout tree, use the JetBrains-style docked mode
    if (preset.dockedLayout) {
      set((s) => ({
        activeTab: 'charts',
        // Keep utility overlays open, clear analysis overlays
        openOverlays: s.openOverlays.filter((t) => UTILITY_TABS.has(t)),
        overlayTiles: {},
        overlayVizMapping: {},
        dockedLayout: JSON.parse(JSON.stringify(preset.dockedLayout)),
        _arrangeIdx: 0,
      }));
      return;
    }
    // Fallback: floating overlays with percentage positions
    const windowIds = preset.windows.map(w => w.id);
    const tiles = {};
    preset.windows.forEach(w => {
      tiles[w.id] = w.position;
    });
    set({
      activeTab: windowIds[0] || 'charts',
      openOverlays: windowIds,
      overlayTiles: tiles,
      dockedLayout: null,
      _arrangeIdx: 0,
    });
  },
  setDockedLayout: (layout) => set({ dockedLayout: layout }),
  exitDockedLayout: () => set({ dockedLayout: null }),
  setOverlayVisualization: (overlayId, vizTabId) => set((s) => ({
    overlayVizMapping: { ...s.overlayVizMapping, [overlayId]: vizTabId }
  })),
  setShowDashboard: (show) => set({ showDashboard: show }),
  setTelemetryChannel: (channel, enabled) => set((s) => ({
    telemetryChannels: { ...s.telemetryChannels, [channel]: enabled },
  })),

  // Legacy panel system (kept for backward compat)
  activePanel: null,
  setActivePanel: (panel) => set((s) => ({ activePanel: s.activePanel === panel ? null : panel })),
  openPanel: (panel) => set({ activePanel: panel }),
  closePanel: () => set({ activePanel: null }),

  // Reset session to return to startup selector
  resetSession: () => set({
    sessionData: null,
    circuitInfo: null,
    drivers: [],
    frameData: null,
    lapFrameMap: null,
    currentFrameIndex: 0,
    totalFrames: 0,
    currentLap: 1,
    maxLap: 1,
    isPlaying: false,
    activeTab: 'pitwall',
    openOverlays: [],
    overlayTiles: {},
    overlayVizMapping: {},
    dockedLayout: null,
    _arrangeIdx: 0,
    activePanel: null,
    sectorRankings: null,
    consistencyData: null,
    speedRankings: null,
    telemetryCache: {},
    telemetryCompareLaps: [],
    lstmPredictions: null,
    predictionLoading: false,
    lastPredictionTrigger: null,
    degradationRegression: null,
    pcaStrategyAnalysis: null,
    raceSituationData: null,
    raceSituationLap: null,
    raceProjection: null,
    _prevPcaResult: null,
    rivalContext: [],
    geminiMessages: [],
    geminiOverlays: [],
    selectedDrivers: [],
    highlightedDriver: null,
    focusDriver: null,
    focusTeam: null,
    watchedRivals: [],
    lapDeltaBaseDriver: null,
    error: null,
    previewDrivers: [],
    previewDriversLoading: false,
    preSelectedDrivers: [],
    commandPaletteOpen: false,
    focusedView: null,
    compareMode: false,
    compareDrivers: [],
    comparisonDriver: null,
    cheatsheetOpen: false,
    qualiSegments: null,
    qualiSegment: 'Q3',
    isQualifyingReplay: false,
  }),

  // ── Selection (bidirectional coordination) ─────────────────────
  selectedDrivers: [],
  highlightedDriver: null,
  highlightedDriverPosition: null, // {x, y} | null — for MFD card positioning
  selectedLapRange: null, // [startLap, endLap]
  brushLapRange: null, // [startLap, endLap] — set by PositionByLap brush, consumed by LapTimeChart
  setBrushLapRange: (range) => set({ brushLapRange: range }),
  selectedPCAPoints: [],

  // ── Focus driver system ───────────────────────────────────────
  focusDriver: null,      // driver abbreviation string or null
  focusTeam: null,        // team name or null — auto-set when focusDriver changes
  watchedRivals: [],      // array of driver abbreviations considered rivals
  lapDeltaBaseDriver: null, // driver abbreviation for delta chart base

  // ── Track progress (Speed Trace ↔ TrackMap coordination) ──────
  trackProgress: null,       // 0.0–1.0 fraction along track for playhead sync
  setTrackProgress: (frac) => set({ trackProgress: frac }),

  // ── Stint selection (for TireSilhouette ↔ StrategyTimeline) ──
  selectedStint: null,       // {driver, stintNumber, compound, lapStart, stintLength}
  highlightedCompound: null, // 'SOFT'|'MEDIUM'|'HARD'|null
  setSelectedStint: (stint) => set({ selectedStint: stint }),
  setHighlightedCompound: (c) => set({ highlightedCompound: c }),

  setFocusDriver: (abbreviation) => {
    set((s) => {
      // Toggle: if same driver, clear focus
      if (s.focusDriver === abbreviation) {
        return { focusDriver: null, focusTeam: null, watchedRivals: [], lapDeltaBaseDriver: null, lstmPredictions: null };
      }
      // Look up the driver's team from the loaded driver_info
      const driverInfo = s.drivers.find((d) => d.Abbreviation === abbreviation);
      const team = driverInfo?.TeamName || null;
      return {
        focusDriver: abbreviation,
        focusTeam: team,
        watchedRivals: [],
        lapDeltaBaseDriver: abbreviation,
      };
    });
    // Trigger LSTM predictions and rival context for the newly focused driver (race only)
    if (get().focusDriver && !get().isQualifyingReplay) {
      get().triggerLSTMPredictions();
      get().updateRivalContext();
    } else if (!get().focusDriver) {
      set({ rivalContext: [] });
    }
  },
  setLapDeltaBaseDriver: (abbr) => set({ lapDeltaBaseDriver: abbr }),

  setWatchedRivals: (rivals) => set({ watchedRivals: rivals }),

  toggleDriver: (abbr) =>
    set((s) => {
      const sel = s.selectedDrivers.includes(abbr)
        ? s.selectedDrivers.filter((d) => d !== abbr)
        : [...s.selectedDrivers, abbr];
      return { selectedDrivers: sel };
    }),

  setSelectedDrivers: (drivers) => set({ selectedDrivers: drivers }),
  setHighlightedDriver: (abbr, pos = null) => set({
    highlightedDriver: abbr,
    highlightedDriverPosition: abbr ? pos : null,
  }),
  setSelectedLapRange: (range) => set({ selectedLapRange: range }),
  setSelectedPCAPoints: (ids) => set({ selectedPCAPoints: ids }),

  clearSelection: () =>
    set({
      selectedDrivers: [],
      highlightedDriver: null,
      highlightedDriverPosition: null,
      selectedLapRange: null,
      selectedPCAPoints: [],
      focusDriver: null,
      focusTeam: null,
      watchedRivals: [],
      lapDeltaBaseDriver: null,
      selectedStint: null,
      highlightedCompound: null,
    }),

  // ── Simulation ────────────────────────────────────────────────
  isPlaying: false,
  playSpeed: 1,
  currentLap: 1,
  maxLap: 1,
  currentTime: 0,
  maxTime: 0,
  frameData: null,
  positionData: null,
  lapFrameMap: null, // { lapNumber: frameIndex } — for quick frame lookup

  // Frame-based replay state
  currentFrameIndex: 0,
  totalFrames: 0,
  frameDt: 0.4, // seconds between frames (computed from data)

  setCurrentFlagStatus: (status) => set({ currentFlagStatus: status }),

  // Compute flag from track status and current time
  updateFlagForTime: (time) => {
    const { trackStatus } = get();
    if (!trackStatus?.length) {
      set({ currentFlagStatus: '1' });
      return;
    }
    let flag = '1';
    for (const s of trackStatus) {
      if (s.start_time <= time) {
        flag = s.status;
      }
    }
    set({ currentFlagStatus: flag });
  },

  // Compute flag from track status and current lap time
  updateFlagForLap: (lap) => {
    const { frameData, lapFrameMap, trackStatus } = get();
    if (!trackStatus?.length) {
      set({ currentFlagStatus: '1' });
      return;
    }
    if (frameData?.frames?.length && lapFrameMap) {
      const frameIdx = lapFrameMap[lap];
      if (frameIdx != null) {
        const time = frameData.frames[frameIdx].t;
        let flag = '1';
        for (const s of trackStatus) {
          if (s.start_time <= time) {
            flag = s.status;
          }
        }
        set({ currentFlagStatus: flag });
        return;
      }
    }
    set({ currentFlagStatus: '1' });
  },

  // Set frame index and derive currentLap + flag from it
  setCurrentFrameIndex: (idx) => {
    const { frameData, trackStatus, currentLap: prevLap, sessionData } = get();
    const updates = { currentFrameIndex: idx };

    if (frameData?.frames?.[idx]) {
      const frame = frameData.frames[idx];
      // Derive currentLap from highest lap among drivers
      let maxLapInFrame = 1;
      if (frame.drivers) {
        for (const d of Object.values(frame.drivers)) {
          if (d.lap > maxLapInFrame) maxLapInFrame = d.lap;
        }
      }
      updates.currentLap = maxLapInFrame;
      updates.currentTime = frame.t;

      // Update flag from frame time
      if (trackStatus?.length) {
        let flag = '1';
        for (const s of trackStatus) {
          if (s.start_time <= frame.t) {
            flag = s.status;
          }
        }
        updates.currentFlagStatus = flag;
      }

      // Re-trigger LSTM predictions every 2 laps during replay (skip for qualifying)
      if (!get().isQualifyingReplay && maxLapInFrame !== prevLap && maxLapInFrame >= 3) {
        const shouldPredict = maxLapInFrame % 2 === 0;

        // Also trigger after focus driver pits
        const focusDrv = get().focusDriver;
        const pitTrigger = focusDrv && sessionData?.lap_times?.some(
          (lt) => lt.Driver === focusDrv && lt.LapNumber === maxLapInFrame && lt.PitOutTime
        );

        // Also trigger when flag transitions from SC/VSC back to green
        const prevFlag = get().currentFlagStatus;
        const newFlag = updates.currentFlagStatus;
        const flagTrigger = newFlag === '1' && (prevFlag === '4' || prevFlag === '6' || prevFlag === '7');

        if (shouldPredict || pitTrigger || flagTrigger) {
          setTimeout(() => {
            get().triggerLSTMPredictions();
            get().updateRivalContext();
            get().computeRaceSituation();
          }, 0);
        } else {
          // Always update rival context and race situation on lap change
          setTimeout(() => {
            get().updateRivalContext();
            get().computeRaceSituation();
          }, 0);
        }
      }
    }
    set(updates);
  },

  setCurrentLap: (lap) => {
    // When setting lap directly (e.g., seeking), also update frame index and currentTime
    const { lapFrameMap, frameData } = get();
    const updates = { currentLap: lap };
    if (lapFrameMap && lapFrameMap[lap] != null) {
      updates.currentFrameIndex = lapFrameMap[lap];
      // Sync currentTime from the frame so sector timing comparisons work
      const frame = frameData?.frames?.[lapFrameMap[lap]];
      if (frame?.t != null) updates.currentTime = frame.t;
    }
    set(updates);
    get().updateFlagForLap(lap);
    // Re-trigger predictions, rival context, and race situation on manual seek
    setTimeout(() => {
      get().triggerLSTMPredictions();
      get().updateRivalContext();
      get().computeRaceSituation();
    }, 0);
  },
  setMaxLap: (max) => set({ maxLap: max }),
  setCurrentTime: (t) => set({ currentTime: t }),
  setIsPlaying: (v) => set({ isPlaying: v }),
  setPlaySpeed: (s) => set({ playSpeed: s }),

  loadFrames: async () => {
    const { year, round, sessionType } = get();
    if (!year || !round) return;
    set({ isLoadingFrames: true });
    try {
      const data = await api.getFrames(year, round, sessionType);

      // ── Qualifying: response has { segments: { Q1: {...}, Q2: {...}, Q3: {...} } }
      if (data.segments) {
        const segments = data.segments;
        const defaultSeg = segments.Q3 ? 'Q3' : segments.Q2 ? 'Q2' : 'Q1';
        const activeData = segments[defaultSeg];

        if (!activeData?.frames?.length) {
          set({ isLoadingFrames: false, qualiSegments: segments, isQualifyingReplay: true });
          console.warn('Qualifying frames: no frames in default segment');
          return;
        }

        let frameDt = 0.4;
        if (activeData.frames.length > 1) {
          frameDt = activeData.frames[1].t - activeData.frames[0].t;
          if (frameDt <= 0) frameDt = 0.4;
        }

        set({
          qualiSegments: segments,
          qualiSegment: defaultSeg,
          isQualifyingReplay: true,
          frameData: activeData,
          maxTime: activeData.max_time || 0,
          lapFrameMap: { 1: 0 },
          totalFrames: activeData.frames.length,
          frameDt,
          currentFrameIndex: 0,
          isLoadingFrames: false,
        });
        console.log(`Qualifying frames loaded: ${defaultSeg} has ${activeData.frames.length} frames, segments: ${Object.keys(segments).join(', ')}`);
        return;
      }

      // ── Race/Sprint: response has { frames: [...], driver_colors, total_laps, max_time }
      const lapFrameMap = {};
      let totalFrames = 0;
      let frameDt = 0.4;

      if (data.frames?.length) {
        totalFrames = data.frames.length;

        // Compute frameDt from actual timestamps
        if (totalFrames > 1) {
          frameDt = data.frames[1].t - data.frames[0].t;
          if (frameDt <= 0) frameDt = 0.4; // safety fallback
        }

        for (let i = 0; i < data.frames.length; i++) {
          const frame = data.frames[i];
          if (!frame.drivers) continue;

          const driverEntries = Object.values(frame.drivers);
          if (driverEntries.length === 0) continue;

          let maxLapInFrame = 0;
          for (const d of driverEntries) {
            if (d.lap > maxLapInFrame) maxLapInFrame = d.lap;
          }

          if (maxLapInFrame > 0 && !(maxLapInFrame in lapFrameMap)) {
            lapFrameMap[maxLapInFrame] = i;
          }
        }

        // Update maxLap if frames provide more accurate count
        const frameMaxLap = data.total_laps || Math.max(...Object.keys(lapFrameMap).map(Number));
        const { maxLap } = get();
        if (frameMaxLap > maxLap) {
          set({ maxLap: frameMaxLap });
        }
      }

      set({
        frameData: data,
        maxTime: data.max_time || 0,
        lapFrameMap,
        totalFrames,
        frameDt,
        currentFrameIndex: 0,
        isLoadingFrames: false,
        qualiSegments: null,
        isQualifyingReplay: false,
      });
      console.log(`Frames loaded: ${totalFrames} frames (${frameDt.toFixed(2)}s/frame), lap map has ${Object.keys(lapFrameMap).length} entries`);
    } catch (e) {
      set({ isLoadingFrames: false });
      console.error('Failed to load frames', e);
    }
  },

  setQualiSegment: (seg) => {
    const { qualiSegments } = get();
    if (!qualiSegments?.[seg]) return;
    const activeData = qualiSegments[seg];
    if (!activeData?.frames?.length) return;

    let frameDt = 0.4;
    if (activeData.frames.length > 1) {
      frameDt = activeData.frames[1].t - activeData.frames[0].t;
      if (frameDt <= 0) frameDt = 0.4;
    }

    set({
      qualiSegment: seg,
      frameData: activeData,
      maxTime: activeData.max_time || 0,
      totalFrames: activeData.frames.length,
      frameDt,
      currentFrameIndex: 0,
      isPlaying: false,
      lapFrameMap: { 1: 0 },
    });
    console.log(`Switched to ${seg}: ${activeData.frames.length} frames`);
  },

  // Get the frame data for the current frame index (used by TrackMap)
  getCurrentFrame: () => {
    const { frameData, currentFrameIndex } = get();
    if (!frameData?.frames?.length) return null;
    const idx = Math.min(currentFrameIndex, frameData.frames.length - 1);
    return frameData.frames[idx] || null;
  },

  loadPositions: async () => {
    const { year, round } = get();
    if (!year || !round) return;
    try {
      const data = await api.getPositions(year, round);
      set({ positionData: data });
    } catch (e) {
      console.error('Failed to load positions', e);
    }
  },

  // ── Analytics (Sectors, Consistency, Speed Rankings) ──────────────
  sectorRankings: null,
  consistencyData: null,
  speedRankings: null,

  fetchAnalytics: async () => {
    const { year, round } = get();
    if (!year || !round) return;
    const [sectors, consistency, speed] = await Promise.allSettled([
      api.getSectors(year, round),
      api.getConsistency(year, round),
      api.getSpeedRankings(year, round),
    ]);
    set({
      sectorRankings: sectors.status === 'fulfilled' ? sectors.value : null,
      consistencyData: consistency.status === 'fulfilled' ? consistency.value : null,
      speedRankings: speed.status === 'fulfilled' ? speed.value : null,
    });
  },

  // ── Telemetry Strip ──────────────────────────────────────────────
  telemetryCache: {},              // { "VER-12": [{Distance, Speed, Throttle, Brake, nGear, ...}] }
  telemetryCompareMode: 'drivers', // 'drivers' | 'laps'
  telemetryCompareLaps: [],        // [12, 23, 36] for laps mode
  telemetryLoading: false,

  fetchDriverTelemetry: async (driver, lap) => {
    const sessionType = get().isQualifyingReplay ? 'Q' : 'R';
    const key = `${driver}-${lap}-${sessionType}`;
    if (get().telemetryCache[key]) return get().telemetryCache[key];

    const { year, round } = get();
    if (!year || !round) return null;

    set({ telemetryLoading: true });
    try {
      const data = await api.getTelemetry(year, round, driver, lap, sessionType);
      const telemetry = data.telemetry || [];
      set((s) => ({
        telemetryCache: { ...s.telemetryCache, [key]: telemetry },
        telemetryLoading: false,
      }));
      return telemetry;
    } catch (e) {
      console.error(`Telemetry fetch failed for ${key}:`, e);
      set({ telemetryLoading: false });
      return null;
    }
  },

  setTelemetryCompareMode: (mode) => set({ telemetryCompareMode: mode }),
  setTelemetryCompareLaps: (laps) => set({ telemetryCompareLaps: laps }),

  // ── Race Situation Map ──────────────────────────────────────────
  raceSituationData: null,
  raceSituationLap: null,
  _prevPcaResult: null, // for sign consistency across recomputes

  computeRaceSituation: () => {
    const {
      sessionData, currentLap, dnfMap, frameData, currentFrameIndex,
      lstmPredictions, focusDriver, isQualifyingReplay, raceSituationLap,
      _prevPcaResult,
    } = get();

    if (isQualifyingReplay) return;
    if (currentLap < 3) return;
    // Debounce: skip if already computed for this lap
    if (raceSituationLap != null && currentLap === raceSituationLap) return;

    const lapTimes = sessionData?.lap_times;
    const strategies = sessionData?.tyre_strategy || sessionData?.strategies || [];
    if (!lapTimes?.length) return;

    const frame = frameData?.frames?.[Math.min(currentFrameIndex, (frameData?.frames?.length || 1) - 1)];
    const frameDrivers = frame?.drivers || {};

    const result = extractRaceSituationFeatures({
      lapTimes, strategies, dnfMap, currentLap,
      frameDrivers, lstmPredictions, focusDriver,
    });

    if (!result) {
      set({ raceSituationData: null, raceSituationLap: currentLap });
      return;
    }

    const pcaResult = computePCA(result.matrix, FEATURE_NAMES, _prevPcaResult);
    if (!pcaResult) {
      set({ raceSituationData: null, raceSituationLap: currentLap });
      return;
    }

    // Procrustes alignment: only needed during warmup (before basis is frozen).
    // Once frozen, axes are stable — Procrustes would just add noise.
    const isFrozen = pcaResult._frozen?.callCount > 8;
    const prevData = get().raceSituationData;
    let alignedScores = pcaResult.scores;
    if (!isFrozen && prevData?.scores?.length && prevData?.driverAbbrs?.length) {
      // Build matched point pairs (drivers present in both frames)
      const prevMap = {};
      prevData.driverAbbrs.forEach((abbr, i) => { prevMap[abbr] = prevData.scores[i]; });
      const refPts = [];
      const newPts = [];
      result.driverAbbrs.forEach((abbr, i) => {
        if (prevMap[abbr]) {
          refPts.push(prevMap[abbr]);
          newPts.push(pcaResult.scores[i]);
        }
      });
      alignedScores = procrustesAlign2D(refPts, newPts, pcaResult.scores);
    }

    set({
      raceSituationData: {
        driverAbbrs: result.driverAbbrs,
        scores: alignedScores,
        loadings: pcaResult.loadings,
        explainedVariance: pcaResult.explainedVariance,
        driverFeatures: result.driverFeatures,
        computedAtLap: currentLap,
      },
      raceSituationLap: currentLap,
      _prevPcaResult: pcaResult,
    });

    // Trigger Monte Carlo projection every 3 laps (after lap 5)
    if (currentLap >= 5 && currentLap % 3 === 0) {
      setTimeout(() => get().computeRaceProjection(), 0);
    }
  },

  // ── Predictions ────────────────────────────────────────────────
  lstmPredictions: null,
  degradationRegression: null,
  pcaStrategyAnalysis: null,
  rivalContext: [],

  fetchLSTMPrediction: async (params) => {
    try {
      const data = await api.predictLSTM(params);
      set({ lstmPredictions: data });
    } catch (e) {
      console.error('LSTM prediction failed', e);
      set({ lstmPredictions: null });
    }
  },

  fetchDegradationRegression: async (params) => {
    try {
      const data = await api.predictDegradation(params);
      set({ degradationRegression: data });
    } catch (e) {
      console.error('Degradation regression failed', e);
    }
  },

  fetchPCAAnalysis: async (pointIds) => {
    try {
      const data = await api.analyzeTSNESelection(pointIds); // Backend endpoint still named tsne — kept for compatibility
      set({ pcaStrategyAnalysis: data });
    } catch (e) {
      console.error('PCA analysis failed', e);
    }
  },

  triggerLSTMPredictions: async () => {
    const { year, round, currentLap, maxLap, focusDriver, selectedDrivers, sessionData, isQualifyingReplay } = get();
    if (isQualifyingReplay) return; // LSTM predictions not applicable for qualifying
    if (!sessionData?.lap_times?.length || currentLap < 2) return;

    const driver = focusDriver || selectedDrivers[0];
    if (!driver) return;

    const driverLaps = sessionData.lap_times
      .filter(d => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .slice(-10);

    if (driverLaps.length < 3) return;

    const weather = sessionData.weather_data;
    const trackTemp = weather?.length ? (weather[0].TrackTemp ?? 30) : 30;

    const last_10_laps = driverLaps.map(d => ({
      lap_time: d.LapTimeSeconds,
      tyre_life: d.TyreLife || 0,
      compound: d.Compound || 'UNKNOWN',
      sector1: d.Sector1TimeSeconds || 0,
      sector2: d.Sector2TimeSeconds || 0,
      sector3: d.Sector3TimeSeconds || 0,
      position: d.Position || 10,
      gap_to_leader: d.GapToLeader || 0,
      gap_ahead: 0,
      fuel_estimate: maxLap > 0 ? (maxLap - d.LapNumber + 1) / maxLap : 0.5,
      track_temp: trackTemp,
      drs: 0,
      lap_number: d.LapNumber,
    }));

    try {
      const data = await api.predictLSTM({
        last_10_laps,
        driver,
        year,
        round,
        current_lap: currentLap,
        max_lap: maxLap,
      });
      set({ lstmPredictions: data });
    } catch (e) {
      console.error('LSTM prediction failed', e);
      set({ lstmPredictions: null });
    }
  },

  triggerPrediction: async (driver, lap) => {
    const { year, round, maxLap, sessionData, isQualifyingReplay } = get();
    if (!year || !round || !driver) return;
    if (isQualifyingReplay) return;

    const currentLap = lap || get().currentLap;
    const lapTimes = sessionData?.lap_times || [];
    const driverLaps = lapTimes
      .filter(d => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber)
      .slice(-10);

    if (driverLaps.length < 3) return;

    const weather = sessionData?.weather_data;
    const trackTemp = weather?.length ? (weather[0].TrackTemp ?? 30) : 30;

    const last_10_laps = driverLaps.map(d => ({
      lap_time: d.LapTimeSeconds,
      tyre_life: d.TyreLife || 0,
      compound: d.Compound || 'UNKNOWN',
      sector1: d.Sector1TimeSeconds || 0,
      sector2: d.Sector2TimeSeconds || 0,
      sector3: d.Sector3TimeSeconds || 0,
      position: d.Position || 10,
      gap_to_leader: d.GapToLeader || 0,
      gap_ahead: 0,
      fuel_estimate: maxLap > 0 ? (maxLap - d.LapNumber + 1) / maxLap : 0.5,
      track_temp: trackTemp,
      drs: 0,
      lap_number: d.LapNumber,
    }));

    set({ predictionLoading: true, lastPredictionTrigger: { driver, lap: currentLap } });
    try {
      const result = await api.predictLSTM({
        last_10_laps,
        driver,
        year,
        round,
        current_lap: currentLap,
        max_lap: maxLap,
      });
      set((s) => ({
        lstmPredictions: { ...s.lstmPredictions, [driver]: result },
        predictionLoading: false
      }));
    } catch (e) {
      console.error('Prediction failed:', e);
      set({ predictionLoading: false });
    }
  },

  updateRivalContext: () => {
    const { focusDriver, sessionData, currentLap, frameData, currentFrameIndex, isQualifyingReplay } = get();
    if (isQualifyingReplay) { set({ rivalContext: [] }); return; } // Not applicable for qualifying
    if (!focusDriver || !sessionData?.lap_times?.length || currentLap < 1) {
      set({ rivalContext: [] });
      return;
    }
    const lapTimes = sessionData.lap_times;

    // Find each driver's latest position and data at currentLap
    const driverLatest = {};
    for (const lt of lapTimes) {
      if (lt.LapNumber > currentLap) continue;
      const drv = lt.Driver;
      if (!drv) continue;
      if (!driverLatest[drv] || lt.LapNumber > driverLatest[drv].LapNumber) {
        driverLatest[drv] = lt;
      }
    }

    const focusLt = driverLatest[focusDriver];
    if (!focusLt || !focusLt.Position) { set({ rivalContext: [] }); return; }
    const focusPos = focusLt.Position;

    // Get tyre info from frame data
    const frameDrivers = frameData?.frames?.[Math.min(currentFrameIndex, (frameData?.frames?.length || 1) - 1)]?.drivers || {};
    const COMPOUND_NAMES = { 0: 'UNKNOWN', 1: 'SOFT', 2: 'MEDIUM', 3: 'HARD', 4: 'INTERMEDIATE', 5: 'WET' };

    // Collect nearby rivals (2 ahead, 2 behind)
    const rivals = [];
    for (const [drv, lt] of Object.entries(driverLatest)) {
      if (drv === focusDriver || !lt.Position) continue;
      const posDiff = lt.Position - focusPos;
      if (Math.abs(posDiff) <= 2) {
        // Gap trend: compare gap over last 3 laps
        const recentGaps = [];
        for (let lap = Math.max(1, currentLap - 2); lap <= currentLap; lap++) {
          const fLap = lapTimes.find((l) => l.Driver === focusDriver && l.LapNumber === lap);
          const rLap = lapTimes.find((l) => l.Driver === drv && l.LapNumber === lap);
          if (fLap?.GapToLeader != null && rLap?.GapToLeader != null) {
            recentGaps.push(rLap.GapToLeader - fLap.GapToLeader);
          }
        }
        let gapTrend = 'stable';
        if (recentGaps.length >= 2) {
          const delta = recentGaps[recentGaps.length - 1] - recentGaps[0];
          if (delta < -0.3) gapTrend = 'closing';
          else if (delta > 0.3) gapTrend = 'opening';
        }

        // Tyre info from frame
        const fd = frameDrivers[drv];
        const compound = fd ? (COMPOUND_NAMES[fd.tyre] || 'UNKNOWN') : (lt.Compound || 'UNKNOWN');
        const tyreAge = fd?.tyre_life != null ? Math.round(fd.tyre_life) : (lt.TyreLife || 0);

        // Estimated laps until pit (rough: avg stint for compound - current age)
        const AVG_STINT = { SOFT: 18, MEDIUM: 28, HARD: 40, INTERMEDIATE: 25, WET: 20, UNKNOWN: 25 };
        const estPitIn = Math.max(0, (AVG_STINT[compound] || 25) - tyreAge);

        // Gap from focus driver
        const gap = (lt.GapToLeader != null && focusLt.GapToLeader != null)
          ? lt.GapToLeader - focusLt.GapToLeader
          : null;

        rivals.push({
          driver: drv,
          position: lt.Position,
          gap,
          gapTrend,
          compound,
          tyreAge,
          estPitIn,
        });
      }
    }

    rivals.sort((a, b) => a.position - b.position);
    set({ rivalContext: rivals });
  },

  // ── Championship ────────────────────────────────────────────────
  championshipData: null,
  championshipLoading: false,
  championshipError: null,
  championshipView: 'drivers', // 'drivers' | 'constructors'
  showChampionshipPredictions: true,

  fetchChampionship: async (year, loadAll = false) => {
    if (!year) year = get().year;
    set({ championshipLoading: true, championshipError: null });
    try {
      const data = await api.getChampionship(year, loadAll);
      set({ championshipData: data, championshipLoading: false });
    } catch (e) {
      console.error('Failed to fetch championship', e);
      set({ championshipLoading: false, championshipError: e.message || 'Failed to load' });
    }
  },

  setChampionshipView: (view) => set({ championshipView: view }),
  toggleChampionshipPredictions: () => set((s) => ({ showChampionshipPredictions: !s.showChampionshipPredictions })),

  // ── PCA Embeddings ───────────────────────────────────────────
  pcaEmbeddings: null,

  loadPCAEmbeddings: async () => {
    try {
      const data = await api.getPCAEmbeddings();
      set({ pcaEmbeddings: data });
    } catch (e) {
      console.error('Failed to load PCA embeddings', e);
    }
  },

  // ── Gemini ────────────────────────────────────────────────────
  geminiMessages: [],
  geminiOverlays: [],

  sendGeminiQuery: async (query) => {
    const { year, round, currentLap, maxLap, selectedDrivers, focusDriver,
            lstmPredictions, raceProjection, raceSituationData,
            degradationRegression, simulatorResult, pcaStrategyAnalysis,
            rivalContext, sessionData } = get();
    set((s) => ({
      geminiMessages: [
        ...s.geminiMessages,
        { role: 'user', content: query },
      ],
    }));

    // Build rich race context from ALL analytical sources
    const raceContext = {};

    // Session info
    if (sessionData?.session_info) raceContext.session = sessionData.session_info;
    const weather = sessionData?.weather_data;
    if (weather?.length) raceContext.weather = weather[weather.length - 1];

    // Monte Carlo projections
    if (raceProjection) {
      raceContext.monteCarloProjections = (raceProjection.projections || []).slice(0, 10).map((p) => ({
        driver: p.driver, currentPos: p.currentPos, expectedPos: p.expectedPos,
        modePos: p.modePos, posRange: p.posRange,
        podiumProb: p.podiumProb, pointsProb: p.pointsProb,
      }));
      raceContext.battles = (raceProjection.battles || []).slice(0, 5).map((b) => ({
        driver1: b.ahead, driver2: b.behind,
        overtakeProb: b.prob, type: b.behindCompound + ' vs ' + b.aheadCompound,
      }));
      raceContext.risks = (raceProjection.risks || []).slice(0, 5);
      if (raceProjection.raceParams) {
        raceContext.raceParams = {
          pitLoss: raceProjection.raceParams.pitLoss,
          scRate: raceProjection.raceParams.scRate,
          lapNoise: raceProjection.raceParams.lapNoise,
        };
      }
    }

    // Driver features from live PCA
    if (raceSituationData?.driverFeatures && selectedDrivers.length > 0) {
      const feats = {};
      for (const d of selectedDrivers) {
        if (raceSituationData.driverFeatures[d]) feats[d] = raceSituationData.driverFeatures[d];
      }
      if (Object.keys(feats).length > 0) raceContext.driverFeatures = feats;
    }

    // Degradation regression
    if (degradationRegression) {
      raceContext.degradationRegression = degradationRegression;
    }

    // Simulator what-if result
    if (simulatorResult) {
      raceContext.simulator = {
        customPos: simulatorResult.simProjection?.expectedPos,
        baselinePos: simulatorResult.baselineProjection?.expectedPos,
        delta: simulatorResult.delta,
      };
    }

    // PCA cluster strategy patterns
    if (pcaStrategyAnalysis?.strategies?.length) {
      raceContext.pcaPatterns = pcaStrategyAnalysis.strategies.slice(0, 3);
    }

    // Rival context for focus driver
    if (rivalContext?.length) {
      raceContext.rivals = rivalContext.slice(0, 4);
    }

    // LSTM predictions for focus driver
    const target = focusDriver || (selectedDrivers.length === 1 ? selectedDrivers[0] : null);
    if (target && lstmPredictions?.[target]) {
      const pred = lstmPredictions[target];
      raceContext.lstm = {
        driver: target,
        predictedTimes: pred.predicted_times,
        predictedLapTime: pred.predicted_lap_time,
        pitProbability: pred.pit_probability,
      };
    }

    // Tyre strategy summary for selected drivers
    const tyreStrats = sessionData?.tyre_strategy || sessionData?.strategies || [];
    if (tyreStrats.length > 0) {
      const targetDrivers = selectedDrivers.length > 0 ? selectedDrivers : (target ? [target] : []);
      if (targetDrivers.length > 0) {
        raceContext.tyreStrategy = {};
        for (const drv of targetDrivers) {
          const stints = tyreStrats
            .filter((s) => s.Driver === drv && (s.LapStart || s.StartLap || 1) <= currentLap)
            .map((s) => ({
              compound: s.Compound, startLap: s.LapStart || s.StartLap || 1,
              length: s.StintLength || s.TotalLaps || 10, stintNumber: s.StintNumber,
            }));
          if (stints.length > 0) raceContext.tyreStrategy[drv] = stints;
        }
      }
    }

    // Recent lap times for focus driver
    if (target && sessionData?.lap_times) {
      raceContext.recentLaps = sessionData.lap_times
        .filter((lt) => lt.Driver === target && lt.LapNumber <= currentLap && lt.LapTimeSeconds > 0)
        .sort((a, b) => b.LapNumber - a.LapNumber)
        .slice(0, 5)
        .map((lt) => ({
          lap: lt.LapNumber, time: lt.LapTimeSeconds,
          compound: lt.Compound, tyreLife: lt.TyreLife,
          s1: lt.Sector1TimeSeconds, s2: lt.Sector2TimeSeconds, s3: lt.Sector3TimeSeconds,
        }));
      raceContext.focusDriver = target;
    }
    raceContext.selectedDrivers = selectedDrivers;
    raceContext.currentLap = currentLap;
    raceContext.maxLap = maxLap;

    try {
      const resp = await api.queryGemini({
        query,
        year,
        round,
        current_lap: currentLap,
        drivers: selectedDrivers,
        lstm_predictions: lstmPredictions,
        race_context: Object.keys(raceContext).length > 0 ? raceContext : undefined,
      });
      set((s) => ({
        geminiMessages: [
          ...s.geminiMessages,
          { role: 'ai', content: resp.response, scenarios: resp.scenarios, is_mock: !!resp.is_mock },
        ],
        geminiOverlays: resp.scenarios || [],
      }));
    } catch (e) {
      set((s) => ({
        geminiMessages: [
          ...s.geminiMessages,
          { role: 'ai', content: 'Failed to get response from Gemini.' },
        ],
      }));
    }
  },

  setGeminiOverlays: (overlays) => set({ geminiOverlays: overlays }),
  setRaceProjection: (data) => set({ raceProjection: data }),

  // ── Monte Carlo Race Projection ──────────────────────────────────
  computeRaceProjection: () => {
    const {
      sessionData, currentLap, maxLap, raceSituationData, isQualifyingReplay,
    } = get();

    if (isQualifyingReplay) return;
    if (!raceSituationData?.driverFeatures || currentLap < 5 || maxLap <= currentLap) return;

    const lapTimes = sessionData?.lap_times;
    const strategies = sessionData?.tyre_strategy || sessionData?.strategies || [];
    const trackStatus = sessionData?.track_status || [];
    if (!lapTimes?.length) return;

    const result = simulateRaceFinish({
      driverFeatures: raceSituationData.driverFeatures,
      currentLap,
      maxLap,
      lapTimes,
      strategies,
      trackStatus,
    });

    if (result) set({ raceProjection: result });
  },

  // ── Strategy Simulator ───────────────────────────────────────────
  simulatorStrategy: null,   // { driver, stints: [{compound, lapStart, length}] }
  simulatorResult: null,     // { simProjection, baselineProjection, delta }
  simulatorComparisons: [],  // [{ label, stints, result }]
  isSimulatorActive: false,

  setSimulatorStrategy: (strategy) => set({ simulatorStrategy: strategy }),
  toggleSimulator: () => set((s) => ({ isSimulatorActive: !s.isSimulatorActive })),
  clearSimulator: () => set({
    simulatorStrategy: null, simulatorResult: null,
    simulatorComparisons: [], isSimulatorActive: false,
  }),

  addSimulatorComparison: (label, stints, result) => set((s) => ({
    simulatorComparisons: [...s.simulatorComparisons, { label, stints, result }],
  })),

  applyPCAPattern: (strategy) => set({
    simulatorStrategy: strategy,
    isSimulatorActive: true,
  }),

  applyGeminiScenario: (scenario) => {
    if (!scenario?.stints) return;
    const { focusDriver } = get();
    set({
      simulatorStrategy: { driver: focusDriver || scenario.driver, stints: scenario.stints },
      isSimulatorActive: true,
    });
  },

  runSimulation: () => {
    const {
      simulatorStrategy, sessionData, currentLap, maxLap,
      raceSituationData, isQualifyingReplay,
    } = get();

    if (isQualifyingReplay || !simulatorStrategy?.stints?.length) return;
    if (!raceSituationData?.driverFeatures || currentLap < 5 || maxLap <= currentLap) return;

    const lapTimes = sessionData?.lap_times;
    const strategies = sessionData?.tyre_strategy || sessionData?.strategies || [];
    const trackStatus = sessionData?.track_status || [];
    if (!lapTimes?.length) return;

    // Baseline: standard projection (no override)
    const baseline = simulateRaceFinish({
      driverFeatures: raceSituationData.driverFeatures,
      currentLap, maxLap, lapTimes, strategies, trackStatus,
    });

    // Custom: override the focused driver's strategy
    const driver = simulatorStrategy.driver;
    if (!driver || !raceSituationData.driverFeatures[driver]) return;

    // Modify driver features to reflect custom strategy
    const modifiedFeatures = { ...raceSituationData.driverFeatures };
    const customStints = simulatorStrategy.stints;
    // Find which stint the driver would be on at currentLap
    let activeStint = customStints[0];
    for (const stint of customStints) {
      if (stint.lapStart <= currentLap) activeStint = stint;
    }
    if (activeStint) {
      modifiedFeatures[driver] = {
        ...modifiedFeatures[driver],
        compoundName: activeStint.compound,
        tyreLife: Math.max(0, currentLap - activeStint.lapStart),
        stintNumber: customStints.indexOf(activeStint) + 1,
      };
    }

    const simResult = simulateRaceFinish({
      driverFeatures: modifiedFeatures,
      currentLap, maxLap, lapTimes, strategies, trackStatus,
    });

    if (!baseline || !simResult) return;

    const baseProj = baseline.projections.find((p) => p.driver === driver);
    const simProj = simResult.projections.find((p) => p.driver === driver);
    if (!baseProj || !simProj) return;

    set({
      simulatorResult: {
        simProjection: simProj,
        baselineProjection: baseProj,
        delta: {
          position: baseProj.expectedPos - simProj.expectedPos,
          podium: simProj.podiumProb - baseProj.podiumProb,
          points: simProj.pointsProb - baseProj.pointsProb,
        },
        fullProjection: simResult,
      },
    });
  },
}), {
  name: 'f1-settings',
  partialize: (state) => ({
    theme: state.theme,
    tempUnit: state.tempUnit,
    speedUnit: state.speedUnit,
    playSpeed: state.playSpeed,
    showDashboard: state.showDashboard,
    openOverlays: state.openOverlays,
    telemetryChannels: state.telemetryChannels,
    year: state.year,
    sessionType: state.sessionType,
  }),
  onRehydrateStorage: () => (state) => {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (state) state.theme = 'dark';
  },
}));

// Wire the api client's health interceptor now that the store exists.
setHealthReporter(
  () => useF1Store.getState().reportBackendOk(),
  (msg) => useF1Store.getState().reportBackendError(msg),
);
