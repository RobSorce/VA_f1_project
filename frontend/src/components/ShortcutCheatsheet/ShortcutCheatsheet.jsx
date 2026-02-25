import React from 'react';
import { useF1Store } from '../../store/useF1Store';
import { modKey } from '../CommandPalette/commandRegistry';
import './ShortcutCheatsheet.css';

const SHORTCUT_SECTIONS = [
  {
    title: 'General',
    shortcuts: [
      { keys: [`${modKey}+K`], desc: 'Open Command Palette' },
      { keys: ['/'], desc: 'Focus Command Bar' },
      { keys: ['Esc'], desc: 'Close overlay / Deselect' },
      { keys: ['?'], desc: 'Toggle this cheatsheet' },
      { keys: ['H'], desc: 'Toggle shortcut hints' },
    ],
  },
  {
    title: 'Open Tabs (1-9, 0)',
    shortcuts: [
      { keys: ['1'], desc: 'Track Map (close overlays)' },
      { keys: ['2'], desc: 'Lap Times' },
      { keys: ['3'], desc: 'Sectors' },
      { keys: ['4'], desc: 'Tyres' },
      { keys: ['5'], desc: 'Charts (Telemetry)' },
      { keys: ['6'], desc: 'Consistency' },
      { keys: ['7'], desc: 'Prediction (Monte Carlo)' },
      { keys: ['8'], desc: 'AI Assistant' },
      { keys: ['9'], desc: 'Compare' },
      { keys: ['0'], desc: 'Settings' },
    ],
  },
  {
    title: 'Window Management',
    shortcuts: [
      { keys: [']'], desc: 'Next open window' },
      { keys: ['['], desc: 'Previous open window' },
      { keys: ['W'], desc: 'Close active window' },
      { keys: ['X'], desc: 'Close all windows' },
      { keys: ['Ctrl', '\u2190'], desc: 'Tile window left half' },
      { keys: ['Ctrl', '\u2192'], desc: 'Tile window right half' },
      { keys: ['Ctrl', '\u2191'], desc: 'Maximize window' },
      { keys: ['Ctrl', '\u2193'], desc: 'Restore window' },
      { keys: ['Ctrl', 'G'], desc: 'Cycle auto-arrange layouts' },
    ],
  },
  {
    title: 'Replay & Navigation',
    shortcuts: [
      { keys: ['Space'], desc: 'Play / Pause' },
      { keys: ['\u2190', '\u2192'], desc: 'Previous / Next Lap' },
      { keys: ['Home', 'End'], desc: 'First / Last Lap' },
      { keys: ['L'], desc: 'Jump to Lap' },
      { keys: ['<', '>'], desc: 'Slower / Faster playback' },
    ],
  },
  {
    title: 'Track Map',
    shortcuts: [
      { keys: ['R'], desc: 'Rotate Clockwise' },
      { keys: ['\u21E7', 'R'], desc: 'Rotate Counter-Clockwise' },
      { keys: ['\u21E7', 'S'], desc: 'Toggle Sectors' },
      { keys: ['\u21E7', 'D'], desc: 'Toggle DRS Zones' },
    ],
  },
  {
    title: 'Driver & Analytics',
    shortcuts: [
      { keys: ['D'], desc: 'Select Driver' },
      { keys: ['C'], desc: 'Toggle Compare Mode' },
      { keys: ['P'], desc: 'Race Prediction (Monte Carlo)' },
      { keys: ['S'], desc: 'Strategy & AI Assistant' },
      { keys: ['T'], desc: 'Tyres (Degradation)' },
      { keys: ['A'], desc: 'Analytics' },
      { keys: ['G'], desc: 'Driver Comparison (2 drivers)' },
      { keys: ['V'], desc: 'Cycle Leaderboard view (INT/GAP/TYRE)' },
    ],
  },
];

export default function ShortcutCheatsheet() {
  const isOpen = useF1Store((s) => s.cheatsheetOpen);
  const closeCheatsheet = useF1Store((s) => s.closeCheatsheet);

  if (!isOpen) return null;

  return (
    <div className="cs-overlay" onClick={closeCheatsheet} role="presentation">
      <div
        className="cs-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard Shortcuts"
        aria-modal="true"
      >
        <div className="cs-header">
          <h2 className="cs-title">Keyboard Shortcuts</h2>
          <kbd className="cs-close" onClick={closeCheatsheet} role="button" tabIndex={0} aria-label="Close cheatsheet">
            Esc
          </kbd>
        </div>

        <div className="cs-body">
          {SHORTCUT_SECTIONS.map((section) => (
            <div key={section.title} className="cs-section">
              <h3 className="cs-section-title">{section.title}</h3>
              <div className="cs-list">
                {section.shortcuts.map((s) => (
                  <div key={s.desc} className="cs-row">
                    <div className="cs-keys">
                      {s.keys.map((k) => (
                        <kbd key={k} className="cs-key">{k}</kbd>
                      ))}
                    </div>
                    <span className="cs-desc">{s.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
