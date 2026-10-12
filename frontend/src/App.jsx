import React from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';
import FocusDriverWidget from './components/ui/FocusDriverWidget';
import PitWallSectorPanel from './components/ui/PitWallSectorPanel';
import WelcomeToast from './components/ui/WelcomeToast';
import ToastStack from './components/ui/ToastStack';
import HelpOverlay from './components/ui/HelpOverlay';
import GeminiFloatingButton from './components/ui/GeminiFloatingButton';
import RadioPipToast from './components/ui/RadioPipToast';
import { CHART_HELP } from './utils/chartHelp';

// Layout
import OverlayPanel from './components/layout/OverlayPanel';
import PitWallLayout from './components/layout/PitWallLayout';
import DockedLayout from './components/layout/DockedLayout';

// Visualizations
import Leaderboard from './components/visualizations/Leaderboard';
import SectorsPanel from './components/visualizations/SectorsPanel';
import ConsistencyPanel from './components/visualizations/ConsistencyPanel';
import DriverComparePanel from './components/visualizations/DriverComparePanel';
import TrackMap from './components/visualizations/TrackMap';

// Tab content
import ChartsTabContent from './components/tabs/ChartsTabContent';
import LapTimesTabContent from './components/tabs/LapTimesTabContent';
import AITabContent from './components/tabs/AITabContent';
import TyresTabContent from './components/tabs/TyresTabContent';
import SettingsTabContent from './components/tabs/SettingsTabContent';
import ChampionshipTabContent from './components/tabs/ChampionshipTabContent';
import AnalyticsTabContent from './components/tabs/AnalyticsTabContent';
import RacePredictionPanel from './components/visualizations/RacePredictionPanel';
import StrategySimulator from './components/visualizations/StrategySimulator';
import StrategyTimeline from './components/visualizations/StrategyTimeline';
import LapDeltaChart from './components/visualizations/LapDeltaChart';
import TireDegradation from './components/visualizations/TireDegradation';
import TyreHealth from './components/visualizations/TyreHealth';
import TyreManagement from './components/visualizations/TyreManagement';
import RaceSituationMap from './components/visualizations/RaceSituationMap';
import TelemetryStrip from './components/visualizations/TelemetryStrip';
import StrategyAnalysis from './components/visualizations/StrategyAnalysis';
import RacePaceGrid from './components/visualizations/RacePaceGrid';
import PositionByLap from './components/visualizations/PositionByLap';
import SectorDeltaWaterfall from './components/visualizations/SectorDeltaWaterfall';
import UndercutCalculator from './components/visualizations/UndercutCalculator';
import RaceControlPanel from './components/visualizations/RaceControlPanel';

// Command Palette & Keyboard
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutHints from './components/ShortcutHints/ShortcutHints';
import ShortcutCheatsheet from './components/ShortcutCheatsheet/ShortcutCheatsheet';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { FALLBACK_PIT_LOSS } from './utils/pitLoss';

// Per-panel `helpText` drives the (?) info button in each overlay header
// (H10/V10.1). Kept short — long-form explanations live in docs/.
const OVERLAY_TABS = {
  trackmap:     { title: 'Track Map',            Component: TrackMap,              helpText: 'Animated circuit SVG. Dots are live driver positions, sector lines colour by fastest. Channel overlay (Speed/Throttle/Brake) recolours the track by the focus driver\'s telemetry on the most recent cached lap.' },
  laptimes:     { title: 'Lap Times',            Component: LapTimesTabContent,    helpText: 'Per-driver lap-time lines. Brush a range to auto-fit a degradation regression on those laps. Points coloured by overall session best (purple) / personal best (green).' },
  lapdelta:     { title: 'Lap Delta',            Component: LapDeltaChart,         helpText: 'Cumulative lap-time delta vs a baseline driver. Positive = losing time, negative = gaining. Use to read undercut/overcut dynamics.' },
  sectors:      { title: 'Sectors & Speeds',     Component: SectorsPanel,          helpText: 'Per-sector best times, ranked. SB = session best (purple), PB = personal best (green).' },
  tyres:        { title: 'Tyres',                Component: TyresTabContent,       helpText: 'Tyre compounds (S/M/H/Inter/Wet), stint lengths and fresh-tyre flag. See Tyre Degradation for per-stint regression.' },
  tiredeg:      { title: 'Tyre Degradation',     Component: TireDegradation,       helpText: 'Per-stint linear regression: lap_time = slope × TyreLife + intercept. Raw slope vs fuel-corrected (+30 ms/lap) shown. See docs/INSIGHTS_MONZA_2024.md.', helpHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/INSIGHTS_MONZA_2024.md' },
  tyrehealth:   { title: 'Tyre Health',          Component: TyreHealth,            helpText: 'Per-driver tyre health bars using 1.6 decay exponent and 80 pace-penalty coefficient (Pirelli / 24-session calibration).' },
  tyremgmt:     { title: 'Pace Retention',       Component: TyreManagement,        helpText: 'Per-stint pace retention score — how well each driver holds their initial pace as tyres age.' },
  consistency:  { title: 'Consistency',          Component: ConsistencyPanel,      helpText: 'Population σ of lap times (clean laps only, pit laps filtered). Drivers with fewer than 75% of current-lap count are flagged "LOW DATA" — σ from small samples is not comparable.' },
  ai:           { title: 'AI Assistant',         Component: AITabContent,          helpText: 'Gemini-backed strategy engineer. If API key is missing, responses show a MOCK badge and come from hand-written examples.' },
  analytics:    { title: 'Analytics',            Component: AnalyticsTabContent,   helpText: 'PCA biplot of per-(driver, race) feature vectors. Points are races; loading vectors indicate feature contributions. Lasso-select triggers Cohen\'s d analysis.', helpHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/PCA_METHODOLOGY.md' },
  prediction:   { title: 'Race Prediction',      Component: RacePredictionPanel,   helpText: 'LSTM (64→32→Dense) predicts next 5 lap times + pit probability. "HEURISTIC" chip = no trained model loaded. Typical MAE 0.4–0.8s dry; up to 2.5s wet.', helpHref: 'https://github.com/RobSorce/VA_f1_project_v2/blob/main/docs/INSIGHTS_BRAZIL_2024.md' },
  simulator:    { title: 'Strategy Simulator',   Component: StrategySimulator,     helpText: 'Monte Carlo (100 iterations) race projection given a hypothetical strategy. Shows position distribution and podium/points probabilities.' },
  strategy:     { title: 'Strategy Timeline',    Component: StrategyTimeline,      helpText: 'Gantt of each driver\'s stints (one bar per tyre set, from FastF1\'s Stint column), pit stops, and compound transitions. Each stop is labelled with its pit loss: measured, race median ("est"), or "fallback". Overlay buttons inject predicted / ghost / Gemini scenarios.' },
  analysis:     { title: 'Strategy Analysis',    Component: StrategyAnalysis,      helpText: 'Pattern analysis triggered by PCA/t-SNE lasso selection — Cohen\'s d feature ranking shows which metrics separate the selected cluster.' },
  racesituation:{ title: 'Race Situation',       Component: RaceSituationMap,      helpText: 'Live race state with exponential-smoothed features. Lasso-select a subset to filter other panels.' },
  racepace:     { title: 'Race Pace Grid',       Component: RacePaceGrid,          helpText: 'Median-normalised pace grid. Cells coloured by Δ to median lap of the race so fast/slow stints are visible at a glance.' },
  telemetry:    { title: 'Telemetry',            Component: TelemetryStrip,        helpText: 'Throttle/Brake/Gear strip chart for the focus driver on the current lap.' },
  championship: { title: 'Championship',         Component: ChampionshipTabContent,helpText: 'Season standings + weighted-moving-average projection. "Standings" and "Prediction & AI" subtabs.' },
  settings:     { title: 'Settings',             Component: SettingsTabContent,    helpText: 'App-level preferences. The Dock accordion lets you toggle any panel in or out of the bottom bar.' },
  compare:      { title: 'Driver Comparison',    Component: DriverComparePanel,    helpText: 'Head-to-head on two drivers: lap-time delta, sectors, consistency. Select two drivers first.' },
  positionlaps: { title: 'Position Tracker',     Component: PositionByLap,         helpText: 'Position-per-lap lines for all drivers. Hover a driver to dim the rest; click to set focus.' },
  sectordelta:  { title: 'Sector Delta',         Component: SectorDeltaWaterfall,  helpText: 'Waterfall of sector deltas — where each driver gains/loses vs the session-best. Useful for setup and circuit-map comparisons.' },
  undercut:     { title: 'Undercut Calculator',  Component: UndercutCalculator,    helpText: `Projects undercut/overcut viability given current pace, tyre age, pit loss, and gap to rivals. Pit loss is measured from this race's green-flag stops (in-lap + out-lap minus twice the driver's green-flag median lap; the median over stops is used). Before the first valid stop a ${FALLBACK_PIT_LOSS.median} s fallback is used, shown as "fallback".` },
  racecontrol:  { title: 'Race Control',          Component: RaceControlPanel,     helpText: 'Live race-control feed + retirements. Categorised messages (flags, DRS, safety car, penalties, stewards), filter chips, and an "out of session" sidebar populated from F1 SignalR Retired/Stopped flags.' },
};

export default function App() {
  const sessionData = useF1Store((s) => s.sessionData);
  const activeTab = useF1Store((s) => s.activeTab);
  const openOverlays = useF1Store((s) => s.openOverlays);
  const overlayVizMapping = useF1Store((s) => s.overlayVizMapping);
  const leaderboardCollapsed = useF1Store((s) => s.leaderboardCollapsed);
  const dockedLayout = useF1Store((s) => s.dockedLayout);

  // Activate global keyboard shortcuts
  useKeyboardShortcuts();

  // Show startup screen if no session loaded — still render ToastStack so
  // a backend-down error surfaces even on the entry screen, and mount
  // HelpOverlay so any future pre-session help trigger actually opens.
  if (!sessionData) {
    return (
      <>
        <SessionSelectorScreen />
        <ToastStack />
        <HelpOverlay />
        <RadioPipToast />
      </>
    );
  }

  const isPitWall = activeTab === 'pitwall';
  const isDocked = !!dockedLayout && !isPitWall;

  return (
    <div className="app-container">
      <WeatherBar />
      <div className="app-body">
        {isPitWall ? (
          /* Monitor mode: Pit Wall full-screen layout */
          <PitWallLayout />
        ) : isDocked ? (
          /* Analyze mode: docked split-pane workspace */
          <>
            <aside className={`app-sidebar${leaderboardCollapsed ? ' app-sidebar--collapsed' : ''}`}>
              <Leaderboard collapsed={leaderboardCollapsed} />
              {!leaderboardCollapsed && <PitWallSectorPanel />}
              {!leaderboardCollapsed && <FocusDriverWidget />}
            </aside>
            <div className="app-center">
              <DockedLayout vizComponents={OVERLAY_TABS} />
            </div>
          </>
        ) : (
          /* Base state: no analysis workspace open */
          <>
            <aside className={`app-sidebar${leaderboardCollapsed ? ' app-sidebar--collapsed' : ''}`}>
              <Leaderboard collapsed={leaderboardCollapsed} />
              {!leaderboardCollapsed && <FocusDriverWidget />}
            </aside>
            <div className="app-center">
              <ChartsTabContent />
            </div>
          </>
        )}
      </div>

      {/* ── Utility floating overlays — render on top of ANY mode ── */}
      {openOverlays.length > 0 && (
        <div className="utility-overlay-container">
          {openOverlays.map((tabId) => {
            const effectiveTabId = overlayVizMapping[tabId] || tabId;
            const config = OVERLAY_TABS[effectiveTabId];
            if (!config) return null;
            return (
              <OverlayPanel
                key={tabId}
                title={config.title}
                tabId={tabId}
                autoFit={tabId === 'settings'}
                helpText={CHART_HELP[effectiveTabId]?.summary}
                hasHelp={!!CHART_HELP[effectiveTabId]}
              >
                <config.Component />
              </OverlayPanel>
            );
          })}
        </div>
      )}

      <TimelinePlayer />
      <BottomTabBar />
      <DriverMFDCard />
      <GeminiFloatingButton />
      {/* Command Palette & Keyboard Overlays */}
      <CommandPalette />
      <ShortcutCheatsheet />
      <ShortcutHints />
      <WelcomeToast />
      <ToastStack />
      <HelpOverlay />
      <RadioPipToast />
    </div>
  );
}
