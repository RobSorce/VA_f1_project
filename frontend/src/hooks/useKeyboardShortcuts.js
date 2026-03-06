import { useEffect } from 'react';
import { useF1Store } from '../store/useF1Store';

export function useKeyboardShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Skip if modifier keys are held (except for Cmd/Ctrl+K)
      if (e.altKey) return;

      const state = useF1Store.getState();

      // Cmd/Ctrl+K — always toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        state.toggleCommandPalette();
        return;
      }

      // Don't intercept other Cmd/Ctrl combos (browser shortcuts)
      if (e.metaKey || e.ctrlKey) return;

      // If command palette modal is open, let it handle its own keys
      if (state.commandPaletteOpen) return;

      // Escape — close cheatsheet, clear focused view, blur inputs
      if (e.key === 'Escape') {
        if (state.cheatsheetOpen) {
          state.closeCheatsheet();
          return;
        }
        if (state.focusedView) {
          state.clearFocusedView();
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

      // Number keys — in analysis mode, set slot A content; in pitwall mode, switch to analysis
      const slotVizMap = {
        '2': 'trackmap',
        '3': 'laptimes',
        '4': 'sectors',
        '5': 'tiredeg',
        '6': 'consistency',
        '7': 'prediction',
        '8': 'gemini',
        '9': 'compare',
        '0': 'analytics',
      };
      if (e.key === '1') {
        e.preventDefault();
        state.setLayoutMode('pitwall');
        return;
      }
      if (slotVizMap[e.key]) {
        e.preventDefault();
        if (state.layoutMode === 'pitwall') {
          state.setLayoutMode('analysis');
        }
        state.setSlotContent('slotA', slotVizMap[e.key]);
        return;
      }

      // X — go to Pit Wall home
      if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        state.setLayoutMode('pitwall');
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

      // r — in analysis mode: reset panel splits; otherwise rotate track CW
      // Shift+R — rotate track CCW
      if (e.key === 'R' && e.shiftKey) {
        e.preventDefault();
        state.rotateTrackCCW();
        return;
      }
      if (e.key === 'r') {
        e.preventDefault();
        if (state.layoutMode === 'analysis') {
          state.resetSplits();
        } else {
          state.rotateTrackCW();
        }
        return;
      }

      // Shift+S — toggle sectors on track map
      if (e.key === 'S' && e.shiftKey) {
        e.preventDefault();
        state.toggleTrackSectors();
        return;
      }

      // s — open AI/Strategy in analysis mode
      if (e.key === 's') {
        e.preventDefault();
        if (state.layoutMode === 'pitwall') state.setLayoutMode('analysis');
        state.setSlotContent('slotA', 'gemini');
        return;
      }

      // t/T — open Tyres in analysis mode
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        if (state.layoutMode === 'pitwall') state.setLayoutMode('analysis');
        state.setSlotContent('slotA', 'tiredeg');
        return;
      }

      // p — toggle Pit Wall / Analysis mode; Shift+P — prediction
      if (e.key === 'p') {
        e.preventDefault();
        state.toggleLayoutMode();
        return;
      }
      if (e.key === 'P' && e.shiftKey) {
        e.preventDefault();
        const activeDriver = state.focusDriver || state.selectedDrivers[0];
        if (activeDriver && state.currentLap >= 2) {
          state.triggerLSTMPredictions();
        }
        if (state.layoutMode === 'pitwall') {
          state.setLayoutMode('analysis');
        }
        state.setSlotContent('slotA', 'prediction');
        return;
      }

      // A — open Analytics (t-SNE) in analysis mode
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        if (state.layoutMode === 'pitwall') state.setLayoutMode('analysis');
        state.setSlotContent('slotA', 'tsne');
        return;
      }

      // Shift+C — championship in slot
      if (e.key === 'C' && e.shiftKey) {
        e.preventDefault();
        // No direct slot for championship - just ignore or keep as-is
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
        if (state.layoutMode === 'pitwall') state.setLayoutMode('analysis');
        state.setSlotContent('slotA', 'compare');
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
