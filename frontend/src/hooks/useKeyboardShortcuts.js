import { useEffect } from 'react';
import { useF1Store } from '../store/useF1Store';
import { seasonHasDrs, sessionSeasonOf } from '../utils/seasons';
import { stepPlaybackSpeed } from '../utils/playbackSpeed';

/**
 * One lap step of the arrow keys on the store state. In lap mode (no frames)
 * the step after the last lap is the race-over state (store showRaceOver:
 * the clock after the chequered flag), and the step back from it is the last
 * lap (the leader starting it).
 *
 * @param {Object} state - useF1Store.getState()
 * @param {number} delta - +1 (ArrowRight) or -1 (ArrowLeft)
 */
export function stepLap(state, delta) {
  if (delta < 0) {
    if (state.lapModeRaceOver) state.setCurrentLap(state.currentLap);
    else if (state.currentLap > 1) state.setCurrentLap(state.currentLap - 1);
    return;
  }
  if (state.currentLap < state.maxLap) state.setCurrentLap(state.currentLap + 1);
  else if (!state.totalFrames && !state.isLiveMode && !state.lapModeRaceOver && state.maxLap > 1) {
    state.showRaceOver();
  }
}

/**
 * The element takes typed text (input, textarea, select, contentEditable):
 * no shortcut fires while it has the focus. Shared with the keys a view
 * handles itself (the Circle of Doom's [ and ], "pit in k laps").
 *
 * @param {Element|null} el - usually document.activeElement
 * @returns {boolean}
 */
export function isTypingTarget(el) {
  return !!el && (
    el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT'
    || !!el.isContentEditable
  );
}

/**
 * The key event comes with the layout's character modifier: AltGr (reported
 * as AltGraph, or by Windows browsers as Ctrl + Alt together).
 */
function isAltGraph(e) {
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return true;
  return !!e.ctrlKey && !!e.altKey && !e.metaKey;
}

/**
 * Step of the Circle of Doom's "pit in k laps" keys: ']' one lap more, '['
 * one lap fewer, matched on the character the layout produces (e.key), so the
 * modifier a layout needs to type it counts as part of the key: AltGr on the
 * Italian, Spanish or German layouts ('[' = AltGr+è on it-IT; Windows reports
 * AltGr as Ctrl + Alt), Option on a Mac layout. 0 for any other key, for a
 * Cmd chord or a Ctrl chord (Ctrl without Alt: a shortcut, not a character),
 * while the focus is in a text field (isTypingTarget) or while the command
 * palette or the cheatsheet is open (as every global shortcut).
 *
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean,
 *   getModifierState?: function(string): boolean}} e - keydown event
 * @param {Object} [state] - useF1Store.getState() (commandPaletteOpen, cheatsheetOpen)
 * @param {Element|null} [activeElement] - document.activeElement
 * @returns {-1|0|1}
 */
export function pitInLapsKeyStep(e, state = {}, activeElement = null) {
  if (e.key !== '[' && e.key !== ']') return 0;
  if (e.metaKey) return 0;
  if (e.ctrlKey && !isAltGraph(e)) return 0;
  if (state?.commandPaletteOpen || state?.cheatsheetOpen) return 0;
  if (isTypingTarget(activeElement)) return 0;
  return e.key === ']' ? 1 : -1;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e) => {
      const state = useF1Store.getState();

      // Cmd/Ctrl+Alt+D — reset dock to defaults. Moved off Cmd+Shift+D to
      // avoid Chrome's "Bookmark all tabs" chord (H5/V5.3).
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        state.resetDockItems();
        return;
      }

      // Any other Alt-held key: ignore (avoids browser menu collisions).
      if (e.altKey) return;

      // Cmd/Ctrl+K — always toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        state.toggleCommandPalette();
        return;
      }

      // Ctrl+Arrow — tile/maximize/restore windows
      if (e.ctrlKey && !e.metaKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          state.tileActiveOverlay('left');
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          state.tileActiveOverlay('right');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          state.tileActiveOverlay('maximize');
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const active = state.activeTab;
          if (state.overlayTiles[active]) {
            state.clearTile(active);
          }
          return;
        }
        // Ctrl+G — cycle arrange layouts
        if (e.key === 'g' || e.key === 'G') {
          e.preventDefault();
          state.arrangeOverlays();
          return;
        }
      }

      // Don't intercept other Cmd/Ctrl combos (browser shortcuts)
      if (e.metaKey || e.ctrlKey) return;

      // If command palette modal is open, let it handle its own keys
      if (state.commandPaletteOpen) return;

      // Escape — close cheatsheet, close overlays/docked, blur inputs
      if (e.key === 'Escape') {
        if (state.cheatsheetOpen) {
          state.closeCheatsheet();
          return;
        }
        if (state.dockedLayout || state.openOverlays.length > 0) {
          state.closeAllOverlays();
          return;
        }
        if (document.activeElement && document.activeElement !== document.body) {
          document.activeElement.blur();
        }
        return;
      }

      // If cheatsheet is open, only Esc and ? (the key that opened it) close it
      if (state.cheatsheetOpen) {
        if (e.key === '?') {
          e.preventDefault();
          state.closeCheatsheet();
        }
        return;
      }

      // If typing in any input, don't fire shortcuts
      if (isTypingTarget(document.activeElement)) return;

      // [ and ] are the Circle of Doom's "pit in k laps" keys, handled by
      // that view (CircleOfDoom.jsx): no global shortcut uses them

      // === SHORTCUTS (no input focused, no modal open) ===

      // ? — toggle cheatsheet
      if (e.key === '?') {
        e.preventDefault();
        state.toggleCheatsheet();
        return;
      }

      // / — focus command bar (handled by CommandBar component)
      if (e.key === '/') return;

      // Number keys — open panels (X closes all, numbers only open)
      const tabMap = {
        '1': 'laptimes',
        '2': 'tyres',
        '3': 'strategy',
        '4': 'sectors',
        '5': 'prediction',
        '6': 'analytics',
        '7': 'ai',
        '8': 'compare',
        '9': 'consistency',
        '0': 'championship',
      };
      if (tabMap[e.key]) {
        e.preventDefault();
        state.setActiveTab(tabMap[e.key]);
        return;
      }

      // W — close last/active tab (works in both overlay and docked mode)
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        state.closeLastTab();
        return;
      }

      // X — close all windows/tabs (exit docked layout or close all overlays)
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        state.closeAllOverlays();
        return;
      }

      // Space — play/pause replay
      if (e.key === ' ') {
        e.preventDefault();
        state.setIsPlaying(!state.isPlaying);
        return;
      }

      // Arrow left/right — navigate laps
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepLap(state, -1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepLap(state, 1);
        return;
      }

      // Home / End — jump to first / last lap
      if (e.key === 'Home') {
        e.preventDefault();
        state.setCurrentLap(1);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        if (state.maxLap) state.setCurrentLap(state.maxLap);
        return;
      }

      // > / < — the next faster / slower speed of the timeline's speed pills
      // (utils/playbackSpeed.js), from any current speed
      if (e.key === '>' || e.key === '<') {
        e.preventDefault();
        const next = stepPlaybackSpeed(state.playSpeed, e.key === '>' ? 1 : -1);
        if (next != null) state.setPlaySpeed(next);
        return;
      }

      // L — toggle leaderboard sidebar
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        state.toggleLeaderboard();
        return;
      }

      // Shift+D toggles the DRS zones (no DRS from 2026, utils/seasons.js
      // seasonHasDrs: nothing to toggle then, and the cheatsheet and the help
      // say "seasons before 2026"); d opens the driver picker
      if (e.key === 'D' && e.shiftKey) {
        e.preventDefault();
        if (seasonHasDrs(sessionSeasonOf(state))) state.toggleTrackDRS();
        return;
      }
      if (e.key === 'd') {
        e.preventDefault();
        useF1Store.setState({ commandPaletteOpen: true, _paletteInitialCommand: 'select-driver' });
        return;
      }

      // Shift+H — toggle dashboard auto-hide
      if (e.key === 'H' && e.shiftKey) {
        e.preventDefault();
        state.setShowDashboard(!state.showDashboard);
        return;
      }

      // h — toggle shortcut hints
      if (e.key === 'h') {
        e.preventDefault();
        state.toggleShortcutHints();
        return;
      }

      // V — cycle leaderboard column mode
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        state.cycleLeaderboardColumn();
        return;
      }

      // r — rotate track CW; Shift+R — rotate track CCW
      if (e.key === 'R' && e.shiftKey) {
        e.preventDefault();
        state.rotateTrackCCW();
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        state.rotateTrackCW();
        return;
      }

      // Shift+S — toggle sectors on track map
      if (e.key === 'S' && e.shiftKey) {
        e.preventDefault();
        state.toggleTrackSectors();
        return;
      }

      // s — open Strategy Timeline
      if (e.key === 's') {
        e.preventDefault();
        state.setActiveTab('strategy');
        return;
      }

      // t/T — open Tyres overlay
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        state.setActiveTab('tyres');
        return;
      }

      // Shift+P — the lap-time forecast of the focus driver (the store's one
      // trigger, as a double-click on the driver) + open prediction view
      if (e.key === 'P' && e.shiftKey) {
        e.preventDefault();
        const driver = state.focusDriver || state.selectedDrivers[0];
        if (driver && state.currentLap >= 2) {
          if (state.focusDriver !== driver) state.setFocusDriver(driver);
          useF1Store.getState().triggerPrediction(driver, state.currentLap);
        }
        state.setActiveTab('prediction');
        return;
      }
      // p — toggle Pit Wall <-> Analysis mode
      if (e.key === 'p') {
        e.preventDefault();
        if (state.activeTab === 'pitwall') {
          state.setActiveTab('charts');
        } else {
          state.setActiveTab('pitwall');
        }
        return;
      }

      // M — open Strategy Simulator
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        state.setActiveTab('simulator');
        return;
      }

      // A — open Analytics overlay
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        state.setActiveTab('analytics');
        return;
      }

      // Shift+C — championship
      if (e.key === 'C' && e.shiftKey) {
        e.preventDefault();
        state.setActiveTab('championship');
        return;
      }
      if (e.key === 'c') {
        e.preventDefault();
        state.toggleCompareMode();
        return;
      }

      // G — toggle Gemini floating panel
      if (e.key === 'g') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('toggle-gemini-panel'));
        return;
      }
      if (e.key === 'G' && e.shiftKey && state.compareMode && state.compareDrivers?.length === 2) {
        e.preventDefault();
        state.setActiveTab('compare');
        return;
      }

      // F — toggle focus on highlighted driver
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        const driver = state.highlightedDriver || state.selectedDrivers[0];
        if (driver) {
          state.setFocusDriver(state.focusDriver === driver ? null : driver);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
