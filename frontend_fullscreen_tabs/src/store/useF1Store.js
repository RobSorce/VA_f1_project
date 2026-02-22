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
  trackStatus: [],
  currentFlagStatus: '1',
  dnfMap: {},

  // ── Pre-session driver preview (selector screen) ──────────────
  previewDrivers: [],
  previewDriversLoading: false,
  preSelectedDrivers: [],

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

      const lapTimes = data.lap_times || [];
      let computedMaxLap = 1;
      for (const lt of lapTimes) {
        if (lt.LapNumber && lt.LapNumber > computedMaxLap) {
          computedMaxLap = lt.LapNumber;
        }
      }

      const dnfMap = {};
      (data.race_results || []).forEach((r) => {
        const abbr = r.Abbreviation;
        if (!abbr) return;
        const cp = String(r.ClassifiedPosition || '');
        if (cp === 'R' || cp === 'D' || cp === 'E' || cp === 'W' || cp === 'N') {
          dnfMap[abbr] = {
            status: r.Status || 'Retired',
            lastLap: r.Laps || computedMaxLap,
            classifiedPosition: cp,
          };
        }
      });

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

      const circuit = await api.getCircuit(year, round);
      set({ circuitInfo: circuit });

      try {
        const strategy = await api.getStrategy(year, round);
        set((s) => ({
          sessionData: { ...s.sessionData, strategies: strategy.strategies || [] },
        }));
      } catch (e) {
        console.warn('Strategy data not available', e);
      }

      console.log(`Session loaded: ${computedMaxLap} laps. Loading frames in background...`);
      get().loadFrames();
      get().fetchAnalytics();

    } catch (e) {
      set({ isLoading: false, error: e.message });
      console.error('Failed to load session', e);
    }
  },

  // ── Tab / Panel system (single full-screen overlay) ─────────────
  activeTab: 'charts',
  setActiveTab: (tab) => set({ activeTab: tab }),

  // Legacy panel system
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
    activePanel: null,
    sectorRankings: null,
    consistencyData: null,
    speedRankings: null,
    telemetryCache: {},
    telemetryCompareLaps: [],
    lstmPredictions: null,
    degradationRegression: null,
    tsneStrategyAnalysis: null,
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
  }),

  // ── Selection (bidirectional coordination) ─────────────────────
  selectedDrivers: [],
  highlightedDriver: null,
  highlightedDriverPosition: null,
  selectedLapRange: null,
  selectedTSNEPoints: [],

  // ── Focus driver system ───────────────────────────────────────
  focusDriver: null,
  focusTeam: null,
  watchedRivals: [],
  lapDeltaBaseDriver: null,

  // ── Stint selection ──
  selectedStint: null,
  highlightedCompound: null,
  setSelectedStint: (stint) => set({ selectedStint: stint }),
  setHighlightedCompound: (c) => set({ highlightedCompound: c }),

  setFocusDriver: (abbreviation) => {
    set((s) => {
      if (s.focusDriver === abbreviation) {
        return { focusDriver: null, focusTeam: null, watchedRivals: [], lapDeltaBaseDriver: null, lstmPredictions: null };
      }
      const driverInfo = s.drivers.find((d) => d.Abbreviation === abbreviation);
      const team = driverInfo?.TeamName || null;
      return {
        focusDriver: abbreviation,
        focusTeam: team,
        watchedRivals: [],
        lapDeltaBaseDriver: abbreviation,
      };
    });
    if (get().focusDriver) {
      get().triggerLSTMPredictions();
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
  lapFrameMap: null,
  currentFrameIndex: 0,
  totalFrames: 0,
  frameDt: 0.4,

  setCurrentFlagStatus: (status) => set({ currentFlagStatus: status }),

  updateFlagForTime: (time) => {
    const { trackStatus } = get();
    if (!trackStatus?.length) { set({ currentFlagStatus: '1' }); return; }
    let flag = '1';
    for (const s of trackStatus) { if (s.start_time <= time) flag = s.status; }
    set({ currentFlagStatus: flag });
  },

  updateFlagForLap: (lap) => {
    const { frameData, lapFrameMap, trackStatus } = get();
    if (!trackStatus?.length) { set({ currentFlagStatus: '1' }); return; }
    if (frameData?.frames?.length && lapFrameMap) {
      const frameIdx = lapFrameMap[lap];
      if (frameIdx != null) {
        const time = frameData.frames[frameIdx].t;
        let flag = '1';
        for (const s of trackStatus) { if (s.start_time <= time) flag = s.status; }
        set({ currentFlagStatus: flag });
        return;
      }
    }
    set({ currentFlagStatus: '1' });
  },

  setCurrentFrameIndex: (idx) => {
    const { frameData, trackStatus, currentLap: prevLap } = get();
    const updates = { currentFrameIndex: idx };
    if (frameData?.frames?.[idx]) {
      const frame = frameData.frames[idx];
      let maxLapInFrame = 1;
      if (frame.drivers) {
        for (const d of Object.values(frame.drivers)) {
          if (d.lap > maxLapInFrame) maxLapInFrame = d.lap;
        }
      }
      updates.currentLap = maxLapInFrame;
      updates.currentTime = frame.t;
      if (trackStatus?.length) {
        let flag = '1';
        for (const s of trackStatus) { if (s.start_time <= frame.t) flag = s.status; }
        updates.currentFlagStatus = flag;
      }
      if (maxLapInFrame !== prevLap && maxLapInFrame % 3 === 0 && maxLapInFrame >= 3) {
        setTimeout(() => get().triggerLSTMPredictions(), 0);
      }
    }
    set(updates);
  },

  setCurrentLap: (lap) => {
    const { lapFrameMap } = get();
    const updates = { currentLap: lap };
    if (lapFrameMap && lapFrameMap[lap] != null) updates.currentFrameIndex = lapFrameMap[lap];
    set(updates);
    get().updateFlagForLap(lap);
    setTimeout(() => get().triggerLSTMPredictions(), 0);
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
      const lapFrameMap = {};
      let totalFrames = 0;
      let frameDt = 0.4;
      if (data.frames?.length) {
        totalFrames = data.frames.length;
        if (totalFrames > 1) {
          frameDt = data.frames[1].t - data.frames[0].t;
          if (frameDt <= 0) frameDt = 0.4;
        }
        for (let i = 0; i < data.frames.length; i++) {
          const frame = data.frames[i];
          if (!frame.drivers) continue;
          const driverEntries = Object.values(frame.drivers);
          if (driverEntries.length === 0) continue;
          let maxLapInFrame = 0;
          for (const d of driverEntries) { if (d.lap > maxLapInFrame) maxLapInFrame = d.lap; }
          if (maxLapInFrame > 0 && !(maxLapInFrame in lapFrameMap)) lapFrameMap[maxLapInFrame] = i;
        }
        const frameMaxLap = data.total_laps || Math.max(...Object.keys(lapFrameMap).map(Number));
        const { maxLap } = get();
        if (frameMaxLap > maxLap) set({ maxLap: frameMaxLap });
      }
      set({ frameData: data, maxTime: data.max_time || 0, lapFrameMap, totalFrames, frameDt, currentFrameIndex: 0, isLoadingFrames: false });
      console.log(`Frames loaded: ${totalFrames} frames (${frameDt.toFixed(2)}s/frame), lap map has ${Object.keys(lapFrameMap).length} entries`);
    } catch (e) {
      set({ isLoadingFrames: false });
      console.error('Failed to load frames', e);
    }
  },

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

  // ── Analytics ──────────────
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
  telemetryCache: {},
  telemetryCompareMode: 'drivers',
  telemetryCompareLaps: [],
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
      set((s) => ({ telemetryCache: { ...s.telemetryCache, [key]: telemetry }, telemetryLoading: false }));
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

  fetchLSTMPrediction: async (params) => {
    try { const data = await api.predictLSTM(params); set({ lstmPredictions: data }); }
    catch (e) { console.error('LSTM prediction failed', e); }
  },

  fetchDegradationRegression: async (params) => {
    try { const data = await api.predictDegradation(params); set({ degradationRegression: data }); }
    catch (e) { console.error('Degradation regression failed', e); }
  },

  fetchTSNEAnalysis: async (pointIds) => {
    try { const data = await api.analyzeTSNESelection(pointIds); set({ tsneStrategyAnalysis: data }); }
    catch (e) { console.error('t-SNE analysis failed', e); }
  },

  triggerLSTMPredictions: async () => {
    const { year, round, currentLap, maxLap, focusDriver, selectedDrivers, sessionData, weatherData } = get();
    if (!sessionData?.lap_times?.length || currentLap < 2) return;
    const driver = focusDriver || selectedDrivers[0];
    if (!driver) return;
    const driverLaps = sessionData.lap_times
      .filter(d => d.Driver === driver && d.LapNumber <= currentLap && d.LapTimeSeconds > 0 && d.LapTimeSeconds < 300)
      .sort((a, b) => a.LapNumber - b.LapNumber).slice(-10);
    if (driverLaps.length < 3) return;
    const trackTemp = weatherData?.TrackTemp ?? 30;
    const last_10_laps = driverLaps.map(d => ({
      lap_time: d.LapTimeSeconds, tyre_life: d.TyreLife || 0, compound: d.Compound || 'UNKNOWN',
      sector1: d.Sector1TimeSeconds || 0, sector2: d.Sector2TimeSeconds || 0, sector3: d.Sector3TimeSeconds || 0,
      position: d.Position || 10, gap_to_leader: d.GapToLeader || 0, gap_ahead: 0,
      fuel_estimate: maxLap > 0 ? (maxLap - d.LapNumber + 1) / maxLap : 0.5,
      track_temp: trackTemp, drs: 0, lap_number: d.LapNumber,
    }));
    try {
      const data = await api.predictLSTM({ last_10_laps, driver, year, round, current_lap: currentLap, max_lap: maxLap });
      set({ lstmPredictions: data });
    } catch (e) { console.error('LSTM prediction failed', e); }
  },

  // ── t-SNE Embeddings ──────────────────────────────────────────
  tsneEmbeddings: null,
  loadTSNEEmbeddings: async () => {
    try { const data = await api.getTSNEEmbeddings(); set({ tsneEmbeddings: data }); }
    catch (e) { console.error('Failed to load t-SNE embeddings', e); }
  },

  // ── Gemini ────────────────────────────────────────────────────
  geminiMessages: [],
  geminiOverlays: [],

  sendGeminiQuery: async (query) => {
    const { year, round, currentLap, selectedDrivers, lstmPredictions } = get();
    set((s) => ({ geminiMessages: [...s.geminiMessages, { role: 'user', content: query }] }));
    try {
      const resp = await api.queryGemini({ query, year, round, current_lap: currentLap, drivers: selectedDrivers, lstm_predictions: lstmPredictions });
      set((s) => ({
        geminiMessages: [...s.geminiMessages, { role: 'ai', content: resp.response, scenarios: resp.scenarios }],
        geminiOverlays: resp.scenarios || [],
      }));
    } catch (e) {
      set((s) => ({ geminiMessages: [...s.geminiMessages, { role: 'ai', content: 'Failed to get response from Gemini.' }] }));
    }
  },

  setGeminiOverlays: (overlays) => set({ geminiOverlays: overlays }),
}));
