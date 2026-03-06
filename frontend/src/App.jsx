import React from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';
import WelcomeToast from './components/ui/WelcomeToast';
import GeminiFloatingButton from './components/ui/GeminiFloatingButton';

// Layout modes
import PitWallLayout from './components/layout/PitWallLayout';
import AnalysisLayout from './components/layout/AnalysisLayout';

// Command Palette & Keyboard
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutHints from './components/ShortcutHints/ShortcutHints';
import ShortcutCheatsheet from './components/ShortcutCheatsheet/ShortcutCheatsheet';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

export default function App() {
  const sessionData = useF1Store((s) => s.sessionData);
  const layoutMode = useF1Store((s) => s.layoutMode);

  // Activate global keyboard shortcuts
  useKeyboardShortcuts();

  // Show startup screen if no session loaded
  if (!sessionData) {
    return <SessionSelectorScreen />;
  }

  return (
    <div className="app-container">
      {/* Header — always visible */}
      <WeatherBar />

      {/* Main body — mode-dependent layout */}
      <div className="app-body" style={{ animation: 'fadeIn 0.15s ease-out' }}>
        {layoutMode === 'pitwall' ? <PitWallLayout /> : <AnalysisLayout />}
      </div>

      {/* Timeline player — always visible */}
      <TimelinePlayer />

      {/* Bottom tab bar — always visible */}
      <BottomTabBar />

      {/* Floating elements */}
      <DriverMFDCard />
      <GeminiFloatingButton />
      <CommandPalette />
      <ShortcutCheatsheet />
      <ShortcutHints />
      <WelcomeToast />
    </div>
  );
}
