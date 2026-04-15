import React, { useMemo } from 'react';
import { WINDOW_PRESETS } from '../../utils/windowPresets';
import { useF1Store } from '../../store/useF1Store';

export default function LayoutPresetBar() {
  const applyWindowPreset = useF1Store((s) => s.applyWindowPreset);
  const dockedLayout = useF1Store((s) => s.dockedLayout);

  const activePresetKey = useMemo(() => {
    if (!dockedLayout) return null;
    const current = JSON.stringify(dockedLayout);
    for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
      if (JSON.stringify(preset.dockedLayout) === current) return key;
    }
    return null;
  }, [dockedLayout]);

  return (
    <div className="layout-preset-bar">
      <div className="layout-preset-bar__sep" />
      <span className="layout-preset-bar__label">LAYOUT</span>
      {Object.entries(WINDOW_PRESETS).map(([key, preset]) => (
        <button
          key={key}
          className={`layout-preset-bar__btn${activePresetKey === key ? ' layout-preset-bar__btn--active' : ''}`}
          onClick={() => applyWindowPreset(preset)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
