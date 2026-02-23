import { useF1Store } from '../../store/useF1Store';

/**
 * Simple fuzzy match — checks if all characters in query appear in target in order.
 * Returns a score (lower is better match). Returns -1 if no match.
 */
export function fuzzyMatch(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact substring match gets best score
  if (t.includes(q)) return 0;

  // Character-by-character ordered matching
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
    } else {
      score++;
    }
  }

  return qi === q.length ? score : -1;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const modKey = isMac ? '\u2318' : 'Ctrl';

export function createCommandRegistry() {
  const store = useF1Store;
  const getState = () => store.getState();

  const commands = [
    // === NAVIGATION (open tabs — matches BottomTabBar 1-8) ===
    {
      id: 'open-charts',
      label: 'Track Map (close overlays)',
      category: 'Navigation',
      shortcut: '1',
      icon: 'map-pin',
      action: () => { getState().setActiveTab('charts'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-laptimes-tab',
      label: 'Open Lap Times',
      category: 'Navigation',
      shortcut: '2',
      icon: 'clock',
      action: () => { getState().setActiveTab('laptimes'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-sectors-tab',
      label: 'Open Sectors',
      category: 'Navigation',
      shortcut: '3',
      icon: 'bar-chart',
      action: () => { getState().setActiveTab('sectors'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-tyres-tab',
      label: 'Open Tyres',
      category: 'Navigation',
      shortcut: '4',
      icon: 'circle',
      action: () => { getState().setActiveTab('tyres'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-speed-tab',
      label: 'Open Speed',
      category: 'Navigation',
      shortcut: '5',
      icon: 'zap',
      action: () => { getState().setActiveTab('speed'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-consistency-tab',
      label: 'Open Consistency',
      category: 'Navigation',
      shortcut: '6',
      icon: 'trending-down',
      action: () => { getState().setActiveTab('consistency'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-ai-tab',
      label: 'Open AI Assistant',
      category: 'Navigation',
      shortcut: '7',
      icon: 'sparkles',
      action: () => { getState().setActiveTab('ai'); getState().closeCommandPalette(); },
    },
    {
      id: 'open-settings-tab',
      label: 'Open Settings',
      category: 'Navigation',
      shortcut: '8',
      icon: 'settings',
      action: () => { getState().setActiveTab('settings'); getState().closeCommandPalette(); },
    },

    // === DRIVER ACTIONS ===
    {
      id: 'select-driver',
      label: 'Select Driver',
      category: 'Actions',
      shortcut: 'D',
      icon: 'user',
      action: null, // handled by sub-commands
      getSubCommands: () => {
        const { drivers, sessionData } = getState();
        const driverList = drivers.length > 0 ? drivers : (sessionData?.driver_info || []);
        return driverList.map(d => ({
          id: `select-driver-${d.Abbreviation}`,
          label: `${d.FullName || d.BroadcastName || d.Abbreviation} (${d.Abbreviation})`,
          category: 'Drivers',
          teamColor: d.TeamColor,
          teamName: d.TeamName,
          action: () => {
            const state = getState();
            state.toggleDriver(d.Abbreviation);
            state.closeCommandPalette();
          },
        }));
      },
    },
    {
      id: 'focus-driver',
      label: 'Focus Driver (Deep Analysis)',
      category: 'Actions',
      shortcut: null,
      icon: 'crosshair',
      action: null,
      getSubCommands: () => {
        const { drivers, sessionData } = getState();
        const driverList = drivers.length > 0 ? drivers : (sessionData?.driver_info || []);
        return driverList.map(d => ({
          id: `focus-driver-${d.Abbreviation}`,
          label: `Focus ${d.FullName || d.BroadcastName || d.Abbreviation} (${d.Abbreviation})`,
          category: 'Drivers',
          teamColor: d.TeamColor,
          teamName: d.TeamName,
          action: () => {
            const state = getState();
            state.setFocusDriver(d.Abbreviation);
            state.closeCommandPalette();
          },
        }));
      },
    },
    {
      id: 'compare-drivers',
      label: 'Compare Drivers',
      category: 'Actions',
      shortcut: 'C',
      icon: 'git-compare',
      action: () => {
        getState().toggleCompareMode();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'jump-to-lap',
      label: 'Jump to Lap',
      category: 'Actions',
      shortcut: 'L',
      icon: 'hash',
      action: null, // handled by sub-commands
      getSubCommands: () => {
        const { maxLap } = getState();
        const laps = [];
        for (let i = 1; i <= maxLap; i++) {
          laps.push({
            id: `jump-to-lap-${i}`,
            label: `Lap ${i}`,
            category: 'Laps',
            action: () => {
              getState().setCurrentLap(i);
              getState().closeCommandPalette();
            },
          });
        }
        return laps;
      },
    },

    // === WINDOW MANAGEMENT ===
    {
      id: 'cycle-next',
      label: 'Next Open Window',
      category: 'Windows',
      shortcut: ']',
      icon: 'arrow-right',
      action: () => { getState().cycleOverlay(1); getState().closeCommandPalette(); },
      available: () => getState().openOverlays.length > 1,
    },
    {
      id: 'cycle-prev',
      label: 'Previous Open Window',
      category: 'Windows',
      shortcut: '[',
      icon: 'arrow-left',
      action: () => { getState().cycleOverlay(-1); getState().closeCommandPalette(); },
      available: () => getState().openOverlays.length > 1,
    },
    {
      id: 'close-window',
      label: 'Close Active Window',
      category: 'Windows',
      shortcut: 'W',
      icon: 'x',
      action: () => {
        const s = getState();
        s.closeOverlay(s.activeTab);
        s.closeCommandPalette();
      },
      available: () => getState().openOverlays.length > 0,
    },
    {
      id: 'close-all-windows',
      label: 'Close All Windows (Track Map)',
      category: 'Windows',
      shortcut: 'X',
      icon: 'x-square',
      action: () => { getState().closeAllOverlays(); getState().closeCommandPalette(); },
      available: () => getState().openOverlays.length > 0,
    },

    // === REPLAY ===
    {
      id: 'play-pause',
      label: 'Play / Pause Replay',
      category: 'Replay',
      shortcut: 'Space',
      icon: 'play',
      action: () => {
        const s = getState();
        s.setIsPlaying(!s.isPlaying);
        s.closeCommandPalette();
      },
    },
    {
      id: 'first-lap',
      label: 'Jump to First Lap',
      category: 'Replay',
      shortcut: 'Home',
      icon: 'skip-back',
      action: () => { getState().setCurrentLap(1); getState().closeCommandPalette(); },
    },
    {
      id: 'last-lap',
      label: 'Jump to Last Lap',
      category: 'Replay',
      shortcut: 'End',
      icon: 'skip-fwd',
      action: () => { const s = getState(); if (s.maxLap) s.setCurrentLap(s.maxLap); s.closeCommandPalette(); },
    },
    {
      id: 'speed-up',
      label: 'Increase Playback Speed',
      category: 'Replay',
      shortcut: '>',
      icon: 'chevrons-r',
      action: () => {
        const s = getState();
        const speeds = [0.25, 0.5, 1, 2, 4, 8];
        const idx = speeds.indexOf(s.playSpeed);
        if (idx < speeds.length - 1) s.setPlaySpeed(speeds[idx + 1]);
        s.closeCommandPalette();
      },
    },
    {
      id: 'speed-down',
      label: 'Decrease Playback Speed',
      category: 'Replay',
      shortcut: '<',
      icon: 'chevrons-l',
      action: () => {
        const s = getState();
        const speeds = [0.25, 0.5, 1, 2, 4, 8];
        const idx = speeds.indexOf(s.playSpeed);
        if (idx > 0) s.setPlaySpeed(speeds[idx - 1]);
        s.closeCommandPalette();
      },
    },

    // === ANALYTICS ===
    {
      id: 'predict-pit',
      label: 'Predict Pit Window (LSTM) + Open Lap Times',
      category: 'Analytics',
      shortcut: 'P',
      icon: 'activity',
      action: () => {
        const s = getState();
        const driver = s.focusDriver || s.selectedDrivers[0];
        if (driver && s.currentLap >= 2) {
          s.triggerLSTMPredictions();
        }
        s.setActiveTab('laptimes');
        s.closeCommandPalette();
      },
    },
    {
      id: 'open-tyres-shortcut',
      label: 'Open Tyres (Degradation & Management)',
      category: 'Analytics',
      shortcut: 'T',
      icon: 'circle',
      action: () => {
        const s = getState();
        s.setActiveTab('tyres');
        s.closeCommandPalette();
      },
    },
    {
      id: 'driver-comparison',
      label: 'Driver Comparison (Head-to-Head)',
      category: 'Analytics',
      shortcut: 'G',
      icon: 'git-compare',
      action: () => {
        const s = getState();
        s.setActiveTab('compare');
        s.closeCommandPalette();
      },
      available: () => getState().compareDrivers.length === 2,
    },
    {
      id: 'cycle-leaderboard-view',
      label: 'Cycle Leaderboard View (INT / GAP / TYRE)',
      category: 'Analytics',
      shortcut: 'V',
      icon: 'refresh-cw',
      action: () => {
        getState().cycleLeaderboardColumn();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'strategy-analysis',
      label: 'Strategy & AI Assistant',
      category: 'Analytics',
      shortcut: 'S',
      icon: 'layers',
      action: () => {
        const s = getState();
        s.setActiveTab('ai');
        s.closeCommandPalette();
      },
    },

    // === TRACK MAP ===
    {
      id: 'toggle-sectors',
      label: 'Toggle Track Sectors',
      category: 'Track Map',
      shortcut: '⇧S',
      icon: 'layers',
      action: () => {
        getState().toggleTrackSectors();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'toggle-drs',
      label: 'Toggle DRS Zones',
      category: 'Track Map',
      shortcut: '⇧D',
      icon: 'zap',
      action: () => {
        getState().toggleTrackDRS();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'rotate-track-cw',
      label: 'Rotate Track Clockwise',
      category: 'Track Map',
      shortcut: 'R',
      icon: 'refresh-cw',
      action: () => {
        getState().rotateTrackCW();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'rotate-track-ccw',
      label: 'Rotate Track Counter-Clockwise',
      category: 'Track Map',
      shortcut: '⇧R',
      icon: 'refresh-cw',
      action: () => {
        getState().rotateTrackCCW();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'reset-track-rotation',
      label: 'Reset Track Orientation',
      category: 'Track Map',
      shortcut: null,
      icon: 'refresh-cw',
      action: () => {
        getState().resetTrackRotation();
        getState().closeCommandPalette();
      },
    },

    // === UTILITY ===
    {
      id: 'clear-selection',
      label: 'Clear All Selections',
      category: 'Utility',
      shortcut: null,
      icon: 'trash',
      action: () => {
        getState().clearSelection();
        getState().closeCommandPalette();
      },
    },
    {
      id: 'show-shortcuts',
      label: 'Show Keyboard Shortcuts',
      category: 'Help',
      shortcut: '?',
      icon: 'keyboard',
      action: () => {
        getState().openCheatsheet();
        getState().closeCommandPalette();
      },
    },
  ];

  return commands;
}

export { isMac, modKey };
