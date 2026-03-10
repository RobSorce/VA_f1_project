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
    title: 'Layout & Views',
    shortcuts: [
      { keys: ['1'], desc: 'Close all overlays (Charts)' },
      { keys: ['2'], desc: 'Lap Times' },
      { keys: ['3'], desc: 'Sectors' },
      { keys: ['4'], desc: 'Tyres' },
      { keys: ['5'], desc: 'Charts Panel' },
      { keys: ['6'], desc: 'Consistency' },
      { keys: ['7'], desc: 'Prediction' },
      { keys: ['8'], desc: 'AI Assistant' },
      { keys: ['9'], desc: 'Compare' },
      { keys: ['0'], desc: 'Analytics (PCA)' },
      { keys: ['W'], desc: 'Close last tab / window' },
      { keys: ['X'], desc: 'Close all windows / exit layout' },
      { keys: ['Esc'], desc: 'Close overlays / Deselect' },
      { keys: [`Ctrl+G`], desc: 'Cycle layout arrangements' },
    ],
  },
  {
    title: 'Replay & Navigation',
    shortcuts: [
      { keys: ['Space'], desc: 'Play / Pause' },
      { keys: ['\u2190', '\u2192'], desc: 'Previous / Next Lap' },
      { keys: ['Home', 'End'], desc: 'First / Last Lap' },
      { keys: ['L'], desc: 'Toggle Leaderboard' },
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
      { keys: ['F'], desc: 'Focus / Unfocus Driver' },
      { keys: ['C'], desc: 'Toggle Compare Mode' },
      { keys: ['\u21E7', 'P'], desc: 'Run LSTM Prediction' },
      { keys: ['S'], desc: 'Strategy & AI Assistant' },
      { keys: ['T'], desc: 'Tyres (Degradation)' },
      { keys: ['A'], desc: 'Analytics (PCA)' },
      { keys: ['G'], desc: 'Gemini AI Panel' },
      { keys: ['\u21E7', 'G'], desc: 'Driver Comparison (2 selected)' },
      { keys: ['V'], desc: 'Cycle Leaderboard view' },
    ],
  },
  {
    title: 'Layout Controls',
    shortcuts: [
      { keys: ['\u21E7', 'H'], desc: 'Toggle bottom bar auto-hide' },
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
