import React, { useState, useEffect, useRef } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { modKey } from '../CommandPalette/commandRegistry';
import './ShortcutHints.css';

export default function ShortcutHints() {
  const visible = useF1Store((s) => s.shortcutHintsVisible);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const compareMode = useF1Store((s) => s.compareMode);
  const openCommandPalette = useF1Store((s) => s.openCommandPalette);

  const [hidden, setHidden] = useState(false);
  const timerRef = useRef(null);

  // Shown for 5 s when the dashboard opens and after a key press, then hidden
  // completely (ShortcutHints.css: never a faded, low-contrast state)
  useEffect(() => {
    const show = () => {
      setHidden(false);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setHidden(true), 5000);
    };

    show();
    window.addEventListener('keydown', show);
    return () => {
      window.removeEventListener('keydown', show);
      clearTimeout(timerRef.current);
    };
  }, []);

  if (!visible) return null;

  const activeDriver = focusDriver || selectedDrivers[0];

  // Build contextual hints
  const hints = [
    { key: `${modKey}K`, label: 'Commands' },
    { key: 'Esc', label: 'Close Overlays' },
    { key: '2-0', label: 'Views' },
  ];

  if (!activeDriver) {
    hints.push({ key: 'D', label: 'Driver' });
  }

  if (activeDriver) {
    hints.push({ key: 'F', label: 'Focus' });
    hints.push({ key: 'S', label: 'Strategy' });
  }

  if (!compareMode) {
    hints.push({ key: 'C', label: 'Compare' });
  }

  hints.push({ key: '?', label: 'Help' });

  // Limit to 7 hints
  const displayHints = hints.slice(0, 7);

  return (
    <div className={`shortcut-hints${hidden ? ' shortcut-hints--hidden' : ''}`} aria-hidden={hidden}>
      {displayHints.map((h) => (
        <div key={h.key} className="shortcut-hint">
          <kbd className="shortcut-hint-key">{h.key}</kbd>
          <span className="shortcut-hint-label">{h.label}</span>
        </div>
      ))}
      {/* Mobile trigger button */}
      <button
        className="shortcut-hints-trigger"
        onClick={openCommandPalette}
        aria-label="Open Command Palette"
        title="Command Palette"
      >
        {modKey}
      </button>
    </div>
  );
}
