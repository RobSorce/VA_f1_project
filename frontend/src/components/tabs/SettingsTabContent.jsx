import React, { useState, useCallback, useMemo } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { SLOT_OPTIONS, CATEGORY_ORDER, CATEGORY_LABELS } from '../../utils/slotOptions';
import { CHART_HELP_LIST } from '../../utils/chartHelp';

const SESSION_TYPES = [
  { value: 'R', label: 'Race' },
  { value: 'Q', label: 'Qualifying' },
  { value: 'S', label: 'Sprint' },
  { value: 'FP1', label: 'FP1' },
  { value: 'FP2', label: 'FP2' },
  { value: 'FP3', label: 'FP3' },
];

const YEARS = [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

const TELEM_CHANNELS = [
  { key: 'speed', label: 'Speed' },
  { key: 'delta', label: 'Gap Delta' },
  { key: 'throttle', label: 'Throttle' },
  { key: 'brake', label: 'Brake' },
  { key: 'gear', label: 'Gear' },
  { key: 'rpm', label: 'RPM' },
];

const TECH_STACK = [
  'React 18', 'D3.js', 'Zustand', 'Vite', 'FastAPI', 'FastF1',
  'TensorFlow / LSTM', 'Google Gemini AI', 'PCA',
];

function SectionHeader({ title, isOpen, onClick }) {
  return (
    <button
      type="button"
      className={`settings-tab__section-header${isOpen ? ' settings-tab__section-header--open' : ''}`}
      aria-expanded={isOpen}
      onClick={onClick}
    >
      <h3 className="settings-tab__section-title">{title}</h3>
      <span className="settings-tab__section-chevron" aria-hidden="true">▾</span>
    </button>
  );
}

export default function SettingsTabContent() {
  // Settings state
  const tempUnit = useF1Store((s) => s.tempUnit);
  const setTempUnit = useF1Store((s) => s.setTempUnit);
  const speedUnit = useF1Store((s) => s.speedUnit);
  const setSpeedUnit = useF1Store((s) => s.setSpeedUnit);
  const playSpeed = useF1Store((s) => s.playSpeed);
  const setPlaySpeed = useF1Store((s) => s.setPlaySpeed);
  const showDashboard = useF1Store((s) => s.showDashboard);
  const setShowDashboard = useF1Store((s) => s.setShowDashboard);
  const telemetryChannels = useF1Store((s) => s.telemetryChannels);
  const setTelemetryChannel = useF1Store((s) => s.setTelemetryChannel);

  // Session state (for dataset selector)
  const year = useF1Store((s) => s.year);
  const setYear = useF1Store((s) => s.setYear);
  const round = useF1Store((s) => s.round);
  const setRound = useF1Store((s) => s.setRound);
  const sessionType = useF1Store((s) => s.sessionType);
  const setSessionType = useF1Store((s) => s.setSessionType);
  const schedule = useF1Store((s) => s.schedule);
  const fetchSchedule = useF1Store((s) => s.fetchSchedule);
  const loadSession = useF1Store((s) => s.loadSession);
  const isLoading = useF1Store((s) => s.isLoading);

  const [loadingDataset, setLoadingDataset] = useState(false);

  // Dock panel management — all state lives in the Zustand store now.
  const dockItems = useF1Store((s) => s.dockItems);
  const addDockItem = useF1Store((s) => s.addDockItem);
  const removeDockItem = useF1Store((s) => s.removeDockItem);
  const resetDockItems = useF1Store((s) => s.resetDockItems);
  const [confirmReset, setConfirmReset] = useState(false);

  // Accordion: only one section expanded at a time → no scrolling.
  const [openSection, setOpenSection] = useState('units');
  const toggleSection = useCallback(
    (id) => setOpenSection((prev) => (prev === id ? null : id)),
    []
  );

  const handleReset = useCallback(() => {
    if (!confirmReset) {
      setConfirmReset(true);
      setTimeout(() => setConfirmReset(false), 3000);
      return;
    }
    resetDockItems();
    setConfirmReset(false);
  }, [confirmReset, resetDockItems]);

  const handleYearChange = (newYear) => {
    setYear(newYear);
    setRound(null);
    fetchSchedule(newYear);
  };

  const handleLoadDataset = async () => {
    if (!round) return;
    setLoadingDataset(true);
    try {
      await loadSession();
    } finally {
      setLoadingDataset(false);
    }
  };

  return (
    <div className="settings-tab">
      {/* ── Units ── */}
      <section className={`settings-tab__section${openSection === 'units' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Units" isOpen={openSection === 'units'} onClick={() => toggleSection('units')} />
        {openSection === 'units' && (
          <div className="settings-tab__section-body">
            <div className="settings-tab__row">
              <span className="settings-tab__label">Temperature</span>
              <div className="settings-tab__pills">
                {['C', 'F'].map((u) => (
                  <button
                    key={u}
                    className={`settings-tab__pill${tempUnit === u ? ' settings-tab__pill--active' : ''}`}
                    onClick={() => setTempUnit(u)}
                  >
                    {u === 'C' ? '°C' : '°F'}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-tab__row">
              <span className="settings-tab__label">Speed</span>
              <div className="settings-tab__pills">
                {[['kmh', 'km/h'], ['mph', 'mph']].map(([val, label]) => (
                  <button
                    key={val}
                    className={`settings-tab__pill${speedUnit === val ? ' settings-tab__pill--active' : ''}`}
                    onClick={() => setSpeedUnit(val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Playback ── */}
      <section className={`settings-tab__section${openSection === 'playback' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Playback" isOpen={openSection === 'playback'} onClick={() => toggleSection('playback')} />
        {openSection === 'playback' && (
          <div className="settings-tab__section-body">
            <div className="settings-tab__row">
              <span className="settings-tab__label">Replay Speed</span>
              <div className="settings-tab__pills">
                {[0.5, 1, 2, 4].map((spd) => (
                  <button
                    key={spd}
                    className={`settings-tab__pill${playSpeed === spd ? ' settings-tab__pill--active' : ''}`}
                    onClick={() => setPlaySpeed(spd)}
                  >
                    {spd}x
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Telemetry Channels ── */}
      <section className={`settings-tab__section${openSection === 'telemetry' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Telemetry Channels" isOpen={openSection === 'telemetry'} onClick={() => toggleSection('telemetry')} />
        {openSection === 'telemetry' && (
          <div className="settings-tab__section-body">
            <div className="settings-tab__toggles">
              {TELEM_CHANNELS.map(({ key, label }) => (
                <label key={key} className="settings-tab__toggle">
                  <input
                    type="checkbox"
                    checked={telemetryChannels[key]}
                    onChange={(e) => setTelemetryChannel(key, e.target.checked)}
                  />
                  <span className="settings-tab__toggle-slider" />
                  <span className="settings-tab__toggle-label">{label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Windows ── */}
      <section className={`settings-tab__section${openSection === 'windows' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Windows" isOpen={openSection === 'windows'} onClick={() => toggleSection('windows')} />
        {openSection === 'windows' && (
          <div className="settings-tab__section-body">
            <div className="settings-tab__row">
              <span className="settings-tab__label">Tiling</span>
              <span className="settings-tab__hint">
                Ctrl+Left/Right: snap half &middot; Ctrl+Up: max &middot; Ctrl+Down: restore &middot; Ctrl+G: auto-arrange
              </span>
            </div>
            <div className="settings-tab__row">
              <span className="settings-tab__label">Dashboard</span>
              <div className="settings-tab__pills">
                {[['show', 'Always Show'], ['hide', 'Auto-hide']].map(([val, label]) => (
                  <button
                    key={val}
                    className={`settings-tab__pill${(val === 'show') === showDashboard ? ' settings-tab__pill--active' : ''}`}
                    onClick={() => setShowDashboard(val === 'show')}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Dock ── */}
      <section className={`settings-tab__section${openSection === 'dock' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Dock" isOpen={openSection === 'dock'} onClick={() => toggleSection('dock')} />
        {openSection === 'dock' && (
          <div className="settings-tab__section-body">
            <p className="settings-tab__hint" style={{ marginBottom: 10 }}>
              Toggle a panel to add or remove it from the bottom dock. Drag icons on the dock itself to reorder.
            </p>

            {CATEGORY_ORDER.map((cat) => {
              const entries = SLOT_OPTIONS.filter(
                (o) => !o.isMode && o.category === cat && o.id !== 'settings'
              );
              if (entries.length === 0) return null;
              return (
                <div key={cat} className="settings-dock__group">
                  <div className="settings-dock__group-label">{CATEGORY_LABELS[cat]}</div>
                  <div className="settings-tab__toggles">
                    {entries.map((opt) => {
                      const inDock = dockItems.includes(opt.id);
                      const canRemove = dockItems.length > 1;
                      return (
                        <div key={opt.id} className="settings-dock__toggle-row">
                          <label className="settings-tab__toggle">
                            <input
                              type="checkbox"
                              checked={inDock}
                              disabled={inDock && !canRemove}
                              onChange={(e) => {
                                if (e.target.checked) addDockItem(opt.id);
                                else if (canRemove) removeDockItem(opt.id);
                              }}
                            />
                            <span className="settings-tab__toggle-slider" />
                            <span className="settings-tab__toggle-label">{opt.label}</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              className="settings-tab__load-btn"
              onClick={handleReset}
              style={{ marginTop: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              {confirmReset ? 'Click again to confirm' : 'Reset dock to defaults'}
            </button>
          </div>
        )}
      </section>

      {/* ── Dataset / Session ── */}
      <section className={`settings-tab__section${openSection === 'dataset' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Dataset" isOpen={openSection === 'dataset'} onClick={() => toggleSection('dataset')} />
        {openSection === 'dataset' && (
          <div className="settings-tab__section-body">
            <div className="settings-tab__row">
              <span className="settings-tab__label">Year</span>
              <select
                className="settings-tab__select"
                value={year}
                onChange={(e) => handleYearChange(Number(e.target.value))}
              >
                {YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div className="settings-tab__row">
              <span className="settings-tab__label">Grand Prix</span>
              <select
                className="settings-tab__select"
                value={round || ''}
                onChange={(e) => setRound(Number(e.target.value))}
              >
                <option value="">Select GP</option>
                {schedule.map((evt) => (
                  <option key={evt.RoundNumber} value={evt.RoundNumber}>
                    {evt.EventName}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-tab__row">
              <span className="settings-tab__label">Session</span>
              <div className="settings-tab__pills settings-tab__pills--wrap">
                {SESSION_TYPES.map(({ value, label }) => (
                  <button
                    key={value}
                    className={`settings-tab__pill${sessionType === value ? ' settings-tab__pill--active' : ''}`}
                    onClick={() => setSessionType(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="settings-tab__load-btn"
              disabled={!round || isLoading || loadingDataset}
              onClick={handleLoadDataset}
            >
              {loadingDataset ? 'Loading...' : 'Load Session'}
            </button>
          </div>
        )}
      </section>

      {/* ── Help & Reference (H10/V10.1) — searchable catalogue of every
          chart's help entry. Same content as the in-chart (i) button. ── */}
      <section className={`settings-tab__section${openSection === 'help' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="Help & Reference" isOpen={openSection === 'help'} onClick={() => toggleSection('help')} />
        {openSection === 'help' && <HelpReferenceBody />}
      </section>

      {/* ── About ── */}
      <section className={`settings-tab__section${openSection === 'about' ? ' settings-tab__section--open' : ''}`}>
        <SectionHeader title="About" isOpen={openSection === 'about'} onClick={() => toggleSection('about')} />
        {openSection === 'about' && (
          <div className="settings-tab__section-body">
            <div className="settings-tab__about-header">
              <img src="/f1-logo.png" alt="F1" className="settings-tab__about-logo" />
              <div>
                <h2 className="settings-tab__about-title">F1 Race Control</h2>
                <p className="settings-tab__about-subtitle">F1 Grand-Prix Analysis</p>
              </div>
            </div>

            <div className="settings-tab__about-grid">
              <div className="settings-tab__about-item">
                <span className="settings-tab__about-key">Developer</span>
                <span className="settings-tab__about-val">Roberto Sorce</span>
              </div>
              <div className="settings-tab__about-item">
                <span className="settings-tab__about-key">University</span>
                <span className="settings-tab__about-val">Sapienza Universita di Roma</span>
              </div>
              <div className="settings-tab__about-item">
                <span className="settings-tab__about-key">Course</span>
                <span className="settings-tab__about-val">Visual Analytics</span>
              </div>
              <div className="settings-tab__about-item">
                <span className="settings-tab__about-key">Academic Year</span>
                <span className="settings-tab__about-val">2024 / 2025</span>
              </div>
              <div className="settings-tab__about-item">
                <span className="settings-tab__about-key">Version</span>
                <span className="settings-tab__about-val">1.0.0</span>
              </div>
            </div>

            <div className="settings-tab__about-section">
              <span className="settings-tab__about-key">Tech Stack</span>
              <div className="settings-tab__tech-tags">
                {TECH_STACK.map((t) => (
                  <span key={t} className="settings-tab__tech-tag">{t}</span>
                ))}
              </div>
            </div>

            <div className="settings-tab__about-section">
              <span className="settings-tab__about-key">Data Sources</span>
              <p className="settings-tab__about-text">
                Telemetry data provided by <strong>FastF1</strong> (open-source F1 data library).
                AI-powered strategy analysis by <strong>Google Gemini</strong>.
              </p>
            </div>

            <p className="settings-tab__disclaimer">
              This project is for academic purposes only.
              Not affiliated with Formula 1, FIA, or any F1 team.
              All trademarks belong to their respective owners.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Help & Reference body — renders every CHART_HELP entry as a row.
 * Clicking a row opens the HelpOverlay for that chart.
 * ──────────────────────────────────────────────────────────────────── */
function HelpReferenceBody() {
  const openHelp = useF1Store((s) => s.openHelp);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return CHART_HELP_LIST;
    const q = query.toLowerCase();
    return CHART_HELP_LIST.filter((e) =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.summary || '').toLowerCase().includes(q) ||
      e.tabId.toLowerCase().includes(q)
    );
  }, [query]);

  return (
    <div className="settings-tab__section-body">
      <p className="settings-tab__hint" style={{ marginBottom: 8 }}>
        Browse help for any chart. Opens the same help panel as the
        <span style={{ display: 'inline-block', margin: '0 4px', verticalAlign: 'middle' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <circle cx="12" cy="16" r="0.6" fill="currentColor" />
          </svg>
        </span>
        button in each chart's header.
      </p>
      <input
        type="text"
        className="settings-help__search"
        placeholder="Search charts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="settings-help__list">
        {filtered.length === 0 && (
          <div className="settings-help__empty">No matches for "{query}"</div>
        )}
        {filtered.map((entry) => (
          <button
            key={entry.tabId}
            type="button"
            className="settings-help__row"
            onClick={() => openHelp(entry.tabId, entry.title)}
          >
            <span className="settings-help__row-title">{entry.title || entry.tabId}</span>
            <span className="settings-help__row-summary">{entry.summary}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
