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

      // Ctrl+Arrow — macOS-style window tiling
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowLeft') {
        e.preventDefault();
        state.tileActiveOverlay('left');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowRight') {
        e.preventDefault();
        state.tileActiveOverlay('right');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
        e.preventDefault();
        state.tileActiveOverlay('maximize');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
        e.preventDefault();
        // Clear tile — restore to default
        if (state.openOverlays.includes(state.activeTab)) {
          state.clearTile(state.activeTab);
        }
        return;
      }
      // Ctrl+G — cycle auto-arrange layouts
      if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        state.arrangeOverlays();
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

      // / — focus command bar (handled by CommandBar component, but prevent default here too)
      if (e.key === '/') return; // let CommandBar handle it

      // Number keys 1-9,0 — open tabs (matches BottomTabBar order)
      const tabMap = {
        '1': 'charts',       // Track Map (close overlays)
        '2': 'laptimes',     // Lap Times overlay
        '3': 'sectors',      // Sectors overlay
        '4': 'tyres',        // Tyres overlay
        '5': 'speed',        // Charts (telemetry) overlay
        '6': 'consistency',  // Consistency overlay
        '7': 'prediction',   // Race Prediction overlay
        '8': 'ai',           // AI Assistant overlay
        '9': 'compare',      // Driver Comparison overlay
        '0': 'settings',     // Settings overlay
      };
      if (tabMap[e.key]) {
        e.preventDefault();
        state.setActiveTab(tabMap[e.key]);
        return;
      }

      // ] / [ — cycle through open overlays (like Alt+Tab)
      if (e.key === ']') {
        e.preventDefault();
        state.cycleOverlay(1);
        return;
      }
      if (e.key === '[') {
        e.preventDefault();
        state.cycleOverlay(-1);
        return;
      }

      // W — close active overlay window
      if ((e.key === 'w' || e.key === 'W') && state.openOverlays.length > 0) {
        e.preventDefault();
        state.closeOverlay(state.activeTab);
        return;
      }

      // X — close all overlays (back to Track Map)
      if ((e.key === 'x' || e.key === 'X') && state.openOverlays.length > 0) {
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

      // Shift+D — toggle DRS on track map
      if (e.key === 'D' && e.shiftKey) {
        e.preventDefault();
        state.toggleTrackDRS();
        return;
      }

      // d — open driver selector
      if (e.key === 'd') {
        e.preventDefault();
        useF1Store.setState({ commandPaletteOpen: true, _paletteInitialCommand: 'select-driver' });
        return;
      }

      // C — toggle compare mode
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        state.toggleCompareMode();
        return;
      }

      // L — jump to lap
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        useF1Store.setState({ commandPaletteOpen: true, _paletteInitialCommand: 'jump-to-lap' });
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

      // V — cycle leaderboard column mode (INT → GAP → TYRE)
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        state.cycleLeaderboardColumn();
        return;
      }

      // Shift+R — rotate track counter-clockwise
      if (e.key === 'R' && e.shiftKey) {
        e.preventDefault();
        state.rotateTrackCCW();
        return;
      }

      // r — rotate track clockwise
      if (e.key === 'r') {
        e.preventDefault();
        state.rotateTrackCW();
        return;
      }

      const activeDriver = state.focusDriver || state.selectedDrivers[0];

      // Shift+S — toggle sectors on track map
      if (e.key === 'S' && e.shiftKey) {
        e.preventDefault();
        state.toggleTrackSectors();
        return;
      }

      // s — open Strategy / AI tab (StrategyTimeline + Gemini)
      if (e.key === 's') {
        e.preventDefault();
        state.setActiveTab('ai');
        return;
      }

      // T — open Tyres tab (tyre degradation & management)
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        state.setActiveTab('tyres');
        return;
      }

      // P — open Race Prediction panel (Monte Carlo) + trigger LSTM
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (activeDriver && state.currentLap >= 2) {
          state.triggerLSTMPredictions();
        }
        state.setActiveTab('prediction');
        return;
      }

      // A — open Analytics (t-SNE) tab
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        state.setActiveTab('analytics');
        return;
      }

      // G — driver comparison (compare mode with 2 drivers)
      if ((e.key === 'g' || e.key === 'G') && state.compareMode && state.compareDrivers.length === 2) {
        e.preventDefault();
        state.setActiveTab('compare');
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
