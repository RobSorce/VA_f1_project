import { useEffect } from 'react';
import { useF1Store } from '../store/useF1Store';

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

      // If cheatsheet is open, only Esc closes it
      if (state.cheatsheetOpen) return;

      // Check if user is typing in an input field
      const el = document.activeElement;
      const isInput = el && (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      );

      // If typing in any input, don't fire shortcuts
      if (isInput) return;

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
        if (state.currentLap > 1) state.setCurrentLap(state.currentLap - 1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (state.currentLap < state.maxLap) state.setCurrentLap(state.currentLap + 1);
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

      // > / < — increase / decrease playback speed
      if (e.key === '>') {
        e.preventDefault();
        const speeds = [0.25, 0.5, 1, 2, 4, 8];
        const idx = speeds.indexOf(state.playSpeed);
        if (idx < speeds.length - 1) state.setPlaySpeed(speeds[idx + 1]);
        return;
      }
      if (e.key === '<') {
        e.preventDefault();
        const speeds = [0.25, 0.5, 1, 2, 4, 8];
        const idx = speeds.indexOf(state.playSpeed);
        if (idx > 0) state.setPlaySpeed(speeds[idx - 1]);
        return;
      }

      // L — toggle leaderboard sidebar
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        state.toggleLeaderboard();
        return;
      }

      // D — toggle bottom bar visibility (Shift+D toggles DRS)
      if (e.key === 'D' && e.shiftKey) {
        e.preventDefault();
        state.toggleTrackDRS();
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

      // Shift+P — trigger LSTM prediction + open prediction view
      if (e.key === 'P' && e.shiftKey) {
        e.preventDefault();
        const driver = state.focusDriver || state.selectedDrivers[0];
        if (driver && state.currentLap >= 2) {
          state.triggerLSTMPredictions();
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
