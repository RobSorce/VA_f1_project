import { useF1Store } from '../../store/useF1Store';
import { seasonHasDrs, sessionSeasonOf } from '../../utils/seasons';
import { getDriverColor, markColor, SURFACES } from '../../utils/colors';

// Team dot of a driver command: the driver's palette colour (team colour or
// teammate tint, V3) as a mark on the menu surface, never FastF1's raw TeamColor
const driverDot = (abbr) => markColor(getDriverColor(abbr), SURFACES.elevated);

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

/** Helper: open an overlay tab */
function openOverlayTab(state, tabId) {
  state.setActiveTab(tabId);
  state.closeCommandPalette();
}

export function createCommandRegistry() {
  const store = useF1Store;
  const getState = () => store.getState();

  const commands = [
    // === NAVIGATION (number keys map to overlay tabs) ===
    {
      id: 'open-laptimes',
      label: 'Lap Times',
      category: 'Navigation',
      shortcut: '1',
      icon: 'clock',
      action: () => openOverlayTab(getState(), 'laptimes'),
    },
    {
      id: 'open-tyres',
      label: 'Tyres',
      category: 'Navigation',
      shortcut: '2',
      icon: 'circle',
      action: () => openOverlayTab(getState(), 'tyres'),
    },
    {
      id: 'open-strategy',
      label: 'Strategy Timeline',
      category: 'Navigation',
      shortcut: '3',
      icon: 'bar-chart',
      action: () => openOverlayTab(getState(), 'strategy'),
    },
    {
      id: 'open-sectors',
      label: 'Sectors',
      category: 'Navigation',
      shortcut: '4',
      icon: 'bar-chart',
      action: () => openOverlayTab(getState(), 'sectors'),
    },
    {
      id: 'open-prediction',
      label: 'Prediction',
      category: 'Navigation',
      shortcut: '5',
      icon: 'activity',
      action: () => openOverlayTab(getState(), 'prediction'),
    },
    {
      id: 'open-analytics',
      label: 'Analytics (PCA)',
      category: 'Navigation',
      shortcut: '6',
      icon: 'bar-chart',
      action: () => openOverlayTab(getState(), 'analytics'),
    },
    {
      id: 'open-ai',
      label: 'AI Strategist',
      category: 'Navigation',
      shortcut: '7',
      icon: 'sparkles',
      action: () => openOverlayTab(getState(), 'ai'),
    },
    {
      id: 'open-compare',
      label: 'Compare',
      category: 'Navigation',
      shortcut: '8',
      icon: 'git-compare',
      action: () => openOverlayTab(getState(), 'compare'),
    },
    {
      id: 'open-consistency',
      label: 'Consistency',
      category: 'Navigation',
      shortcut: '9',
      icon: 'trending-down',
      action: () => openOverlayTab(getState(), 'consistency'),
    },
    {
      id: 'open-championship',
      label: 'Championship',
      category: 'Navigation',
      shortcut: '0',
      icon: 'trophy',
      action: () => openOverlayTab(getState(), 'championship'),
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
          teamColor: driverDot(d.Abbreviation),
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
          teamColor: driverDot(d.Abbreviation),
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

    // === MODE SWITCHING ===
    {
      id: 'go-home',
      label: 'Close All Overlays (Charts View)',
      category: 'Navigation',
      shortcut: 'X',
      icon: 'home',
      action: () => { getState().closeAllOverlays(); getState().closeCommandPalette(); },
      available: () => getState().openOverlays.length > 0,
    },
    {
      id: 'toggle-mode',
      label: 'Close All Overlays',
      category: 'Navigation',
      shortcut: 'P',
      icon: 'layout',
      action: () => { getState().closeAllOverlays(); getState().closeCommandPalette(); },
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
      label: 'Lap-Time Forecast of the Focus Driver + Prediction View',
      category: 'Analytics',
      shortcut: '⇧P',
      icon: 'activity',
      action: () => {
        // The store's one forecast trigger, as a double-click on the driver
        // (the focus driver, else the first selected one, which becomes the focus)
        const s = getState();
        const driver = s.focusDriver || s.selectedDrivers[0];
        if (driver && s.currentLap >= 2) {
          if (s.focusDriver !== driver) s.setFocusDriver(driver);
          getState().triggerPrediction(driver, s.currentLap);
        }
        openOverlayTab(getState(), 'prediction');
      },
    },
    {
      id: 'open-tyres-shortcut',
      label: 'Open Tyres (Degradation & Management)',
      category: 'Analytics',
      shortcut: 'T',
      icon: 'circle',
      action: () => openOverlayTab(getState(), 'tyres'),
    },
    {
      id: 'open-strategy-ai',
      label: 'Strategy & AI Assistant',
      category: 'Analytics',
      shortcut: 'S',
      icon: 'layers',
      action: () => openOverlayTab(getState(), 'ai'),
    },
    {
      id: 'open-analytics-pca',
      label: 'Analytics (PCA)',
      category: 'Analytics',
      shortcut: 'A',
      icon: 'bar-chart',
      action: () => openOverlayTab(getState(), 'analytics'),
    },
    {
      id: 'toggle-gemini-panel',
      label: 'Toggle Gemini Floating Panel',
      category: 'Analytics',
      shortcut: 'G',
      icon: 'sparkles',
      action: () => {
        window.dispatchEvent(new CustomEvent('toggle-gemini-panel'));
        getState().closeCommandPalette();
      },
    },
    {
      id: 'driver-comparison',
      label: 'Driver Comparison (Head-to-Head)',
      category: 'Analytics',
      shortcut: '⇧G',
      icon: 'git-compare',
      action: () => openOverlayTab(getState(), 'compare'),
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
      // No DRS from 2026 (utils/seasons.js seasonHasDrs)
      available: () => seasonHasDrs(sessionSeasonOf(getState())),
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

    // === LAYOUT ===
    {
      id: 'toggle-dashboard',
      label: 'Toggle Bottom Bar',
      category: 'Layout',
      shortcut: '⇧H',
      icon: 'layout',
      action: () => {
        const s = getState();
        s.setShowDashboard(!s.showDashboard);
        s.closeCommandPalette();
      },
    },
    {
      id: 'arrange-overlays',
      label: 'Arrange Open Overlays',
      category: 'Layout',
      shortcut: null,
      icon: 'grid',
      action: () => {
        getState().arrangeOverlays();
        getState().closeCommandPalette();
      },
      available: () => getState().openOverlays.length > 1,
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
