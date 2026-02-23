import { create } from 'zustand';
import * as api from '../utils/apiClient';

export const useF1Store = create((set, get) => ({
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

  // ── Pre-session driver preview (selector screen) ──────────────
  previewDrivers: [],          // drivers fetched before full session load
  previewDriversLoading: false,
  preSelectedDrivers: [],      // drivers toggled on selector screen

  setYear: (year) => set({ year }),
  setRound: (round) => set({ round }),
  setSessionType: (sessionType) => set({ sessionType }),

  fetchSchedule: async (year) => {
    try {
      const data = await api.getSchedule(year);
      set({ schedule: data.events || [], year });
    } catch (e) {
      console.error('Failed to fetch schedule', e);
    }
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
    set({ isLoading: true, error: null });
    try {
      const data = await api.getSession(year, round, sessionType);

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
        isLoading: false,
        frameData: null,
        lapFrameMap: null,
        currentFrameIndex: 0,
        totalFrames: 0,
        telemetryCache: {},
        telemetryCompareLaps: [],
        sectorRankings: null,
        consistencyData: null,
        speedRankings: null,
        ...(preSelected.length > 0 ? { selectedDrivers: preSelected } : {}),
      });

      // Load circuit info
      const circuit = await api.getCircuit(year, round);
      set({ circuitInfo: circuit });

      // Load strategy data (for strategy tab)
      try {
        const strategy = await api.getStrategy(year, round);
        set((s) => ({
          sessionData: { ...s.sessionData, strategies: strategy.strategies || [] },
        }));
      } catch (e) {
        console.warn('Strategy data not available', e);
      }

      // Load frames in background for smooth car animation
      console.log(`Session loaded: ${computedMaxLap} laps. Loading frames in background...`);
      get().loadFrames();
      get().fetchAnalytics();

    } catch (e) {
      set({ isLoading: false, error: e.message });
      console.error('Failed to load session', e);
    }
  },

  // ── Command Palette & Keyboard ────────────────────────────────
  commandPaletteOpen: false,
  focusedView: null,         // 'trackmap' | 'leaderboard' | 'laptimes' | 'strategy' | 'tires' | null
  compareMode: false,
  compareDrivers: [],        // max 2 driver abbreviations
  leaderboardColumnMode: 0,  // index into ['INT','GAP','TYRE']
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
  cycleLeaderboardColumn: () => set(s => ({ leaderboardColumnMode: (s.leaderboardColumnMode + 1) % 3 })),
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

  // ── Tab / Panel system (multi-window) ──────────────────────────
  activeTab: 'charts', // kept for compat — 'charts' means no legacy overlay
  openOverlays: [],    // array of tab IDs currently open as windows (max 3)

  setActiveTab: (tab) => {
    // Legacy compat: 'charts' closes all overlays, otherwise toggle
    if (tab === 'charts') {
      set({ activeTab: 'charts', openOverlays: [] });
    } else {
      set((s) => {
        const already = s.openOverlays.includes(tab);
        if (already) {
          const next = s.openOverlays.filter((t) => t !== tab);
          return { openOverlays: next, activeTab: next.length > 0 ? next[0] : 'charts' };
        }
        // Max windows — replace oldest if at limit
        const limit = s.maxOverlays || 3;
        const next = s.openOverlays.length >= limit
          ? [...s.openOverlays.slice(1), tab]
          : [...s.openOverlays, tab];
        return { openOverlays: next, activeTab: tab };
      });
    }
  },

  closeOverlay: (tab) => set((s) => {
    const next = s.openOverlays.filter((t) => t !== tab);
    return { openOverlays: next, activeTab: next.length > 0 ? next[0] : 'charts' };
  }),

  closeAllOverlays: () => set({ openOverlays: [], activeTab: 'charts' }),

  cycleOverlay: (direction = 1) => set((s) => {
    if (s.openOverlays.length === 0) return s;
    const idx = s.openOverlays.indexOf(s.activeTab);
    const len = s.openOverlays.length;
    const next = s.openOverlays[((idx === -1 ? 0 : idx) + direction + len) % len];
    return { activeTab: next };
  }),

  // ── Settings (persist across sessions) ──────────────────────────
  theme: 'dark',         // 'dark' | 'light'
  tempUnit: 'C',         // 'C' | 'F'
  speedUnit: 'kmh',      // 'kmh' | 'mph'
  // playbackSpeed uses existing playSpeed / setPlaySpeed below
  maxOverlays: 3,        // 1, 2, 3
  telemetryChannels: { speed: true, delta: true, throttle: true, brake: true, gear: true, rpm: true },

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    set({ theme });
  },
  setTempUnit: (tempUnit) => set({ tempUnit }),
  setSpeedUnit: (speedUnit) => set({ speedUnit }),
  // playbackSpeed uses setPlaySpeed (see Simulation section)
  setMaxOverlays: (maxOverlays) => set({ maxOverlays }),
  setTelemetryChannel: (channel, enabled) => set((s) => ({
    telemetryChannels: { ...s.telemetryChannels, [channel]: enabled },
  })),

  // Legacy panel system (kept for backward compat during transition)
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
    activeTab: 'charts',
    openOverlays: [],
    activePanel: null,
    sectorRankings: null,
    consistencyData: null,
    speedRankings: null,
    telemetryCache: {},
    telemetryCompareLaps: [],
    lstmPredictions: null,
    degradationRegression: null,
    tsneStrategyAnalysis: null,
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
    cheatsheetOpen: false,
  }),

  // ── Selection (bidirectional coordination) ─────────────────────
  selectedDrivers: [],
  highlightedDriver: null,
  highlightedDriverPosition: null, // {x, y} | null — for MFD card positioning
  selectedLapRange: null, // [startLap, endLap]
  selectedTSNEPoints: [],

  // ── Focus driver system ───────────────────────────────────────
  focusDriver: null,      // driver abbreviation string or null
  focusTeam: null,        // team name or null — auto-set when focusDriver changes
  watchedRivals: [],      // array of driver abbreviations considered rivals
  lapDeltaBaseDriver: null, // driver abbreviation for delta chart base

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
    // Trigger LSTM predictions and rival context for the newly focused driver
    if (get().focusDriver) {
      get().triggerLSTMPredictions();
      get().updateRivalContext();
    } else {
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
  setSelectedTSNEPoints: (ids) => set({ selectedTSNEPoints: ids }),

  clearSelection: () =>
    set({
      selectedDrivers: [],
      highlightedDriver: null,
      highlightedDriverPosition: null,
      selectedLapRange: null,
      selectedTSNEPoints: [],
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

      // Re-trigger LSTM predictions every 2 laps during replay
      if (maxLapInFrame !== prevLap && maxLapInFrame >= 3) {
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
          }, 0);
        } else {
          // Always update rival context on lap change
          setTimeout(() => get().updateRivalContext(), 0);
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
    // Re-trigger predictions and rival context on manual seek
    setTimeout(() => {
      get().triggerLSTMPredictions();
      get().updateRivalContext();
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

      // Build lap → frame index map
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
      });
      console.log(`Frames loaded: ${totalFrames} frames (${frameDt.toFixed(2)}s/frame), lap map has ${Object.keys(lapFrameMap).length} entries`);
    } catch (e) {
      set({ isLoadingFrames: false });
      console.error('Failed to load frames', e);
    }
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
    try {
      const [sectors, consistency, speed] = await Promise.all([
        api.getSectors(year, round),
        api.getConsistency(year, round),
        api.getSpeedRankings(year, round),
      ]);
      set({ sectorRankings: sectors, consistencyData: consistency, speedRankings: speed });
    } catch (e) {
      console.warn('Analytics fetch failed', e);
    }
  },

  // ── Telemetry Strip ──────────────────────────────────────────────
  telemetryCache: {},              // { "VER-12": [{Distance, Speed, Throttle, Brake, nGear, ...}] }
  telemetryCompareMode: 'drivers', // 'drivers' | 'laps'
  telemetryCompareLaps: [],        // [12, 23, 36] for laps mode
  telemetryLoading: false,

  fetchDriverTelemetry: async (driver, lap) => {
    const key = `${driver}-${lap}`;
    if (get().telemetryCache[key]) return get().telemetryCache[key];

    const { year, round } = get();
    if (!year || !round) return null;

    set({ telemetryLoading: true });
    try {
      const data = await api.getTelemetry(year, round, driver, lap);
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

  // ── Predictions ────────────────────────────────────────────────
  lstmPredictions: null,
  degradationRegression: null,
  tsneStrategyAnalysis: null,
  rivalContext: [],

  fetchLSTMPrediction: async (params) => {
    try {
      const data = await api.predictLSTM(params);
      set({ lstmPredictions: data });
    } catch (e) {
      console.error('LSTM prediction failed', e);
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

  fetchTSNEAnalysis: async (pointIds) => {
    try {
      const data = await api.analyzeTSNESelection(pointIds);
      set({ tsneStrategyAnalysis: data });
    } catch (e) {
      console.error('t-SNE analysis failed', e);
    }
  },

  triggerLSTMPredictions: async () => {
    const { year, round, currentLap, maxLap, focusDriver, selectedDrivers, sessionData } = get();
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
    }
  },

  updateRivalContext: () => {
    const { focusDriver, sessionData, currentLap, frameData, currentFrameIndex } = get();
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

  // ── t-SNE Embeddings ──────────────────────────────────────────
  tsneEmbeddings: null,

  loadTSNEEmbeddings: async () => {
    try {
      const data = await api.getTSNEEmbeddings();
      set({ tsneEmbeddings: data });
    } catch (e) {
      console.error('Failed to load t-SNE embeddings', e);
    }
  },

  // ── Gemini ────────────────────────────────────────────────────
  geminiMessages: [],
  geminiOverlays: [],

  sendGeminiQuery: async (query) => {
    const { year, round, currentLap, selectedDrivers, lstmPredictions } = get();
    set((s) => ({
      geminiMessages: [
        ...s.geminiMessages,
        { role: 'user', content: query },
      ],
    }));
    try {
      const resp = await api.queryGemini({
        query,
        year,
        round,
        current_lap: currentLap,
        drivers: selectedDrivers,
        lstm_predictions: lstmPredictions,
      });
      set((s) => ({
        geminiMessages: [
          ...s.geminiMessages,
          { role: 'ai', content: resp.response, scenarios: resp.scenarios },
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
}));
