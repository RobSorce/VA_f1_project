import React from 'react';
import { useF1Store } from './store/useF1Store';

// UI components
import SessionSelectorScreen from './components/ui/SessionSelectorScreen';
import WeatherBar from './components/ui/WeatherBar';
import BottomTabBar from './components/ui/BottomTabBar';
import TimelinePlayer from './components/ui/TimelinePlayer';
import DriverMFDCard from './components/ui/DriverMFDCard';
import WelcomeToast from './components/ui/WelcomeToast';
import ToastStack from './components/ui/ToastStack';
import HelpOverlay from './components/ui/HelpOverlay';
import RadioPipToast from './components/ui/RadioPipToast';
import { CHART_HELP, DOCS_BASE } from './utils/chartHelp';

// Layout
import OverlayPanel from './components/layout/OverlayPanel';
import PitWallLayout from './components/layout/PitWallLayout';
import DockedLayout from './components/layout/DockedLayout';
import SidebarFocusCards from './components/layout/SidebarFocusCards';

// Visualizations
import Leaderboard from './components/visualizations/Leaderboard';
import SectorsPanel from './components/visualizations/SectorsPanel';
import ConsistencyPanel from './components/visualizations/ConsistencyPanel';
import DriverComparePanel from './components/visualizations/DriverComparePanel';
import TrackMap from './components/visualizations/TrackMap';

// Tab content
import ChartsTabContent from './components/tabs/ChartsTabContent';
import LapTimesTabContent from './components/tabs/LapTimesTabContent';
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
import CircleOfDoom from './components/visualizations/CircleOfDoom';
import RaceControlPanel from './components/visualizations/RaceControlPanel';

// Command Palette & Keyboard
import CommandPalette from './components/CommandPalette/CommandPalette';
import ShortcutHints from './components/ShortcutHints/ShortcutHints';
import ShortcutCheatsheet from './components/ShortcutCheatsheet/ShortcutCheatsheet';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { FALLBACK_PIT_LOSS } from './utils/pitLoss';
import { FUEL_EFFECT_S_PER_LAP, MIN_FIT_LAPS } from './utils/degradation';
import { DEFAULT_NUM_SIMULATIONS } from './utils/raceSimulation';

// Per-panel `helpText`: a one-line source summary of each view. The (?)
// button of the overlay and docked headers and the help overlay read the help
// registry (utils/chartHelp.js CHART_HELP), the single text shown; keep these
// lines consistent with it.
const OVERLAY_TABS = {
  trackmap:     { title: 'Track Map',            Component: TrackMap,              helpText: 'Animated circuit SVG. Dots are live driver positions; sectors S1 / S2 / S3 in reddish purple, yellow and sky blue. Channel overlay (Speed/Throttle/Brake) recolours the track by the focus driver\'s telemetry on the most recent cached lap.' },
  laptimes:     { title: 'Lap Times',            Component: LapTimesTabContent,    helpText: 'Timing sheet: sector times, lap time, gap to the fastest lap and tyre per driver. The lap-range bar is the Position Tracker\'s brushed range (either view sets it, both draw it) and picks laps for the Tyre Degradation fit. Purple ◆ = session best, green ● = personal best.' },
  lapdelta:     { title: 'Lap Delta',            Component: LapDeltaChart,         helpText: 'Cumulative lap-time delta vs a baseline driver. Positive = losing time, negative = gaining. Use to read undercut/overcut dynamics.' },
  sectors:      { title: 'Sectors & Speeds',     Component: SectorsPanel,          helpText: 'Sector times of the lap in progress (Live), each sector\'s best times ranked with the gap to the session best (Best) and the speed-trap tops (Top Speeds). Purple ◆ = session best, green ● = personal best.' },
  tyres:        { title: 'Tyres',                Component: TyresTabContent,       helpText: 'Tyre Health and Pace Retention of the focus driver: one tab each, or both stacked with Split. For the fitted tyre wear see Tyre Degradation.' },
  tiredeg:      { title: 'Tyre Degradation',     Component: TireDegradation,       helpText: `Per-stint linear fit of lap time on TyreLife, clean laps only (lap 1, pit in/out, non-green laps and slow outliers left out; at least ${MIN_FIT_LAPS} laps). Fuel-corrected slope = raw + ${FUEL_EFFECT_S_PER_LAP.toFixed(3)} s/lap, an assumed fuel effect. Worked example: the Monza 2024 insights.`, helpHref: `${DOCS_BASE}DEGRADATION_METHODOLOGY.md` },
  tyrehealth:   { title: 'Tyre Health',          Component: TyreHealth,            helpText: 'Estimated tyre life of the focus driver, lap by lap: one curve per stint in the compound colour, from tyre age (exponent 1.6 of age over the compound\'s max life) and pace (80 × the fraction slower than the stint\'s best lap), CRITICAL / WORN zones.' },
  tyremgmt:     { title: 'Pace Retention',       Component: TyreManagement,        helpText: 'Pace retention of the focus driver, lap by lap: each lap as a share of its stint\'s opening pace (median of the stint\'s laps 2 to 4), one line per stint in the compound colour.' },
  consistency:  { title: 'Consistency',          Component: ConsistencyPanel,      helpText: 'Residual σ: the scatter of the clean laps around each stint\'s tyre-wear fit (lap 1, pit in/out and non-green laps left out), so wear, fuel burn and stops are not inconsistency. "LOW DATA" = σ from a small sample, not comparable.' },
  analytics:    { title: 'Analytics',            Component: AnalyticsTabContent,   helpText: 'PCA biplot of per-(driver, race) feature vectors: a point is one driver in one race; loading arrows show feature contributions. A lasso selection is compared with the other rows (Hedges\' g, random baseline) in the Cross-Race Analysis panel.', helpHref: `${DOCS_BASE}PCA_METHODOLOGY.md` },
  prediction:   { title: 'Race Prediction',      Component: RacePredictionPanel,   helpText: 'Lap-time forecast of the focus driver by the method with the best validation error (named on the chip, with its held-out error), pit-stop probability and Monte Carlo position projections.', helpHref: `${DOCS_BASE}analytics_provenance.md` },
  simulator:    { title: 'Strategy Simulator',   Component: StrategySimulator,     helpText: `Monte Carlo (${DEFAULT_NUM_SIMULATIONS.toLocaleString('en-US')} runs, the same random numbers for both strategies) race projection given a hypothetical strategy. Shows position distribution and podium/points probabilities.` },
  strategy:     { title: 'Strategy Timeline',    Component: StrategyTimeline,      helpText: 'Gantt of each driver\'s stints (one bar per tyre set, from FastF1\'s Stint column), pit stops, and compound transitions. Each stop is labelled with its pit loss: measured, race median ("est"), or "fallback". Drawn over it: the focus driver\'s forecast stints (hatched), the Strategy Simulator\'s plan (dashed) and, under the drivers, the strategies of a PCA lasso selection.' },
  analysis:     { title: 'Strategy Analysis',    Component: StrategyAnalysis,      helpText: 'Race Analysis: insights from the analytical outputs, the field overview, and for drivers lassoed on the Race Situation map the features that separate them from the field (Cohen\'s d).' },
  racesituation:{ title: 'Race Situation',       Component: RaceSituationMap,      helpText: 'Live PCA of each driver\'s race state, refitted every lap and turned onto the previous lap\'s axes (orthogonal Procrustes). Lasso-select a subset to select those drivers in the other panels.' },
  racepace:     { title: 'Race Pace Grid',       Component: RacePaceGrid,          helpText: 'Pace grid, rows = laps, columns = drivers. Cells coloured by Δ to the driver\'s median clean lap (blue fast, white, yellow, orange slow; ◆ / ● bests, P / O pit laps) so fast/slow stints are visible at a glance.' },
  telemetry:    { title: 'Telemetry',            Component: TelemetryStrip,        helpText: 'Telemetry of a lap: speed, gap, throttle and brake, gear and RPM, for the focus and selected drivers or for the laps of the lap range.' },
  championship: { title: 'Championship',         Component: ChampionshipTabContent,helpText: 'Season standings + weighted-moving-average projection (the chart\'s Predictions button).' },
  settings:     { title: 'Settings',             Component: SettingsTabContent,    helpText: 'App-level preferences. The Dock accordion lets you toggle any panel in or out of the bottom bar.' },
  compare:      { title: 'Driver Comparison',    Component: DriverComparePanel,    helpText: 'Head-to-head on two drivers: lap-time delta, sectors, consistency. Select two drivers first.' },
  positionlaps: { title: 'Position Tracker',     Component: PositionByLap,         helpText: 'Position-per-lap lines for all drivers. Click a line to set the focus (the others turn to context); hover for the driver\'s position and tyre. Drag to brush a lap range, the same range as the Lap Times bar\'s.' },
  sectordelta:  { title: 'Sector Delta',         Component: SectorDeltaWaterfall,  helpText: 'Waterfall of the focus driver\'s sector deltas against a reference driver, lap by lap (+ / ▲ slower, − / ▼ faster).' },
  circle:       { title: 'Circle of Doom',       Component: CircleOfDoom,          helpText: 'One lap drawn as a circle in seconds: top = timing line, cars clockwise, angle between two cars = time gap. Click a car for its pit window: purple band back to the predicted rejoin, hatched p10–p90 arc, rejoin-position probabilities. The pit loss is measured from this race\'s green-flag stops, or labelled "fallback". Pit in k laps ([ and ] or the header stepper): dashed ghost = the rejoin if it pits k laps later, with the places vs pitting now (lap model of the race simulation, no traffic, rivals stop only when toggled).' },
  // Superseded by the Circle of Doom (not in the dock or the layouts); kept for direct opening
  undercut:     { title: 'Undercut Calculator',  Component: UndercutCalculator,    helpText: `For each lap the focus driver could pit on, the projected gap to the rival at the flag, both cars on their plans to the finish (+ = focus ahead; a stint longer than the tyres run is charged an extra stop); the rival stops on its likely lap (stint-life survival) or a chosen one. Lap model of the race simulation (degradation by compound and tyre age, fresh-tyre delta), no traffic. Pit loss is measured from this race's green-flag stops (in-lap + out-lap minus twice the driver's green-flag median lap; the median over stops is used). Before the first valid stop a ${FALLBACK_PIT_LOSS.median} s fallback is used, shown as "fallback".` },
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
              {/* the focus cards open collapsed on a window under 1200 px high,
                  so the Leaderboard keeps its 20 rows (SidebarFocusCards) */}
              {!leaderboardCollapsed && <SidebarFocusCards withSectors />}
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
              {!leaderboardCollapsed && <SidebarFocusCards withSectors={false} />}
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
