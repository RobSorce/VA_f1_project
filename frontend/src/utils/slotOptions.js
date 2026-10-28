/**
 * Analysis slot visualization registry — single source of truth.
 *
 * Each entry describes a dockable view:
 *   id       — unique string key
 *   label    — human-readable title
 *   component — lazy-loaded React component (omitted for isMode entries)
 *   icon     — SVG path `d` attribute (24x24, stroke="currentColor", stroke-width=1.8)
 *   category — grouping key for the add-popover
 *   isMode   — if true, the dock fires setActiveTab(id) for a top-level mode switch
 *              (Pit Wall / Home) rather than an overlay/pane open
 *
 * The key hint shown with a view comes from the key handler's binding table
 * (hooks/useKeyboardShortcuts.js viewKeyHint), not from here.
 */
import { lazy } from 'react';

const TrackMap           = lazy(() => import('../components/visualizations/TrackMap'));
const LapTimeChart       = lazy(() => import('../components/visualizations/LapTimeChart'));
const LapDeltaChart      = lazy(() => import('../components/visualizations/LapDeltaChart'));
const StrategyTimeline   = lazy(() => import('../components/visualizations/StrategyTimeline'));
const AnalyticsTabContent = lazy(() => import('../components/tabs/AnalyticsTabContent'));
const TireDegradation    = lazy(() => import('../components/visualizations/TireDegradation'));
const TyreHealth         = lazy(() => import('../components/visualizations/TyreHealth'));
const TyreManagement     = lazy(() => import('../components/visualizations/TyreManagement'));
const ConsistencyPanel   = lazy(() => import('../components/visualizations/ConsistencyPanel'));
const SectorsPanel       = lazy(() => import('../components/visualizations/SectorsPanel'));
const RacePredictionPanel= lazy(() => import('../components/visualizations/RacePredictionPanel'));
const DriverComparePanel = lazy(() => import('../components/visualizations/DriverComparePanel'));
const RaceSituationMap   = lazy(() => import('../components/visualizations/RaceSituationMap'));
const TelemetryStrip     = lazy(() => import('../components/visualizations/TelemetryStrip'));
const StrategyAnalysis   = lazy(() => import('../components/visualizations/StrategyAnalysis'));
const RacePaceGrid       = lazy(() => import('../components/visualizations/RacePaceGrid'));
const StrategySimulator  = lazy(() => import('../components/visualizations/StrategySimulator'));
const PositionByLap      = lazy(() => import('../components/visualizations/PositionByLap'));
const SectorDeltaWaterfall = lazy(() => import('../components/visualizations/SectorDeltaWaterfall'));
const CircleOfDoom       = lazy(() => import('../components/visualizations/CircleOfDoom'));
const RaceControlPanel   = lazy(() => import('../components/visualizations/RaceControlPanel'));
const SettingsTabContent = lazy(() => import('../components/tabs/SettingsTabContent'));
const ChampionshipTabContent = lazy(() => import('../components/tabs/ChampionshipTabContent'));
const RaceTrace          = lazy(() => import('../components/visualizations/RaceTrace'));
const FieldPace          = lazy(() => import('../components/visualizations/FieldPace'));

/* Icon paths — Feather-style single-path 24x24, stroke=currentColor width=1.8 */
const ICONS = {
  pitwall:       'M3 3h18v18H3zM3 9h18M9 9v12M15 9v12',
  charts:        'M3 12l9-9 9 9M5 10v10h14V10',
  trackmap:      'M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  laptimes:      'M12 6v6l4 2M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0z',
  lapdelta:      'M3 17l6-6 4 4 8-8M14 7h7v7',
  strategy:      'M3 3h18v6H3zM3 15h18v6H3zM8 9v6M16 9v6',
  analytics:     'M21 21H3V3m4 14l4-6 4 4 6-8',
  tiredeg:       'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14l-2 3h4l-2 3',
  tyrehealth:    'M12 21s-7-4.5-7-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6.5-7 11-7 11z',
  tyremgmt:      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM8 12a4 4 0 0 1 8 0M12 12v-2',
  consistency:   'M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',
  sectors:       'M4 6h16M4 12h16M4 18h16',
  speed:         'M13 2L3 14h9l-1 8 10-12h-9l1-8',
  prediction:    'M12 3a8 8 0 1 0 7.7 10M12 3v6l4 4M15 3h6v6',
  compare:       'M7 7h10M7 17h10M7 7L4 4M7 7L4 10M17 17l3-3M17 17l3 3',
  racesituation:'M4 18c2-2 4-2 6 0s4 2 6 0 4-2 4-2M6 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM14 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  telemetry:     'M3 3v18h18M6 15l4-6 4 4 5-9',
  analysis:      'M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM21 21l-5.4-5.4',
  racepace:      'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  simulator:     'M6 4l14 8-14 8z',
  positionlaps:  'M3 20h18M6 20V10M12 20V4M18 20V14',
  sectordelta:   'M4 12h4v6H4zM10 8h4v10h-4zM16 14h4v4h-4z',
  circle:        'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 1.5v4.5M3.5 9.5a9 9 0 0 1 4-5',
  championship:  'M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M18 2H6v7a6 6 0 0 0 12 0V2z',
  racecontrol:   'M5 4h14v6H5zM5 14h14v6H5zM8 7h2M8 17h8M14 7h2',
  settings:      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.15.67.4.89.72.22.33.34.72.34 1.12v.32c0 .4-.12.79-.34 1.12-.22.32-.53.57-.89.72z',
  racetrace:     'M3 12h4l3-6 4 10 3-4h4',
  teampace:      'M4 6h16M4 12h16M4 18h16M9 4v4M14 10v4M11 16v4',
};

export const SLOT_OPTIONS = [
  // ── Mode switches (no component — handled by setActiveTab directly) ─────
  { id: 'pitwall', label: 'Pit Wall', category: 'monitor', icon: ICONS.pitwall, isMode: true },

  // ── Monitor ────────────────────────────────────────────────────────────
  { id: 'trackmap',      label: 'Track Map',           component: TrackMap,        category: 'monitor',    icon: ICONS.trackmap },
  { id: 'telemetry',     label: 'Telemetry',           component: TelemetryStrip,  category: 'monitor',    icon: ICONS.telemetry },
  { id: 'racecontrol',   label: 'Race Control',        component: RaceControlPanel,category: 'monitor',    icon: ICONS.racecontrol },

  // ── Timing ─────────────────────────────────────────────────────────────
  { id: 'laptimes',      label: 'Lap Times',           component: LapTimeChart,    category: 'timing',     icon: ICONS.laptimes },
  { id: 'lapdelta',      label: 'Lap Delta',           component: LapDeltaChart,   category: 'timing',     icon: ICONS.lapdelta },
  { id: 'sectors',       label: 'Sectors & Speeds',    component: SectorsPanel,    category: 'timing',     icon: ICONS.sectors },
  { id: 'sectordelta',   label: 'Sector Delta',        component: SectorDeltaWaterfall, category: 'timing', icon: ICONS.sectordelta },
  { id: 'consistency',   label: 'Consistency',         component: ConsistencyPanel,category: 'timing',     icon: ICONS.consistency },
  { id: 'racepace',      label: 'Race Pace Grid',      component: RacePaceGrid,    category: 'timing',     icon: ICONS.racepace },
  { id: 'positionlaps',  label: 'Position Tracker',    component: PositionByLap,   category: 'timing',     icon: ICONS.positionlaps },

  // ── Tyres ──────────────────────────────────────────────────────────────
  { id: 'tyres',         label: 'Tyres',               component: TireDegradation, category: 'tyres',      icon: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z' },
  { id: 'tiredeg',       label: 'Tyre Degradation',    component: TireDegradation, category: 'tyres',      icon: ICONS.tiredeg },
  { id: 'tyrehealth',    label: 'Tyre Health',         component: TyreHealth,      category: 'tyres',      icon: ICONS.tyrehealth },
  { id: 'tyremgmt',      label: 'Pace Retention',      component: TyreManagement,  category: 'tyres',      icon: ICONS.tyremgmt },

  // ── Strategy ───────────────────────────────────────────────────────────
  { id: 'strategy',      label: 'Strategy Timeline',   component: StrategyTimeline,category: 'strategy',   icon: ICONS.strategy },
  { id: 'analysis',      label: 'Strategy Analysis',   component: StrategyAnalysis,category: 'strategy',   icon: ICONS.analysis },
  { id: 'simulator',     label: 'Strategy Simulator',  component: StrategySimulator,category: 'strategy',  icon: ICONS.simulator },
  { id: 'circle',        label: 'Circle of Doom',      component: CircleOfDoom,    category: 'strategy',   icon: ICONS.circle },

  // ── Analysis ───────────────────────────────────────────────────────────
  { id: 'analytics',     label: 'Analytics (PCA)',     component: AnalyticsTabContent, category: 'analysis', icon: ICONS.analytics },
  { id: 'compare',       label: 'Driver Compare',      component: DriverComparePanel,  category: 'analysis', icon: ICONS.compare },
  { id: 'racesituation', label: 'Race Situation (PCA)',component: RaceSituationMap,    category: 'analysis', icon: ICONS.racesituation },

  // ── Prediction ─────────────────────────────────────────────────────────
  { id: 'prediction',    label: 'Race Prediction',     component: RacePredictionPanel, category: 'prediction', icon: ICONS.prediction },

  // ── System ─────────────────────────────────────────────────────────────
  { id: 'championship',  label: 'Championship',        component: ChampionshipTabContent, category: 'system', icon: ICONS.championship },
  { id: 'settings',      label: 'Settings',            component: SettingsTabContent,     category: 'system', icon: ICONS.settings },

  // ── Race Trace and Race Pace (strategy / timing) ──────────────────────
  { id: 'racetrace',     label: 'Race Trace',          component: RaceTrace,       category: 'strategy',   icon: ICONS.racetrace },
  { id: 'teampace',      label: 'Race Pace',           component: FieldPace,       category: 'timing',     icon: ICONS.teampace },
];

/** Lightweight id set for dock validation (avoids circular imports with the store). */
export const SLOT_IDS = new Set(SLOT_OPTIONS.map((o) => o.id));

/** Category display order + labels used by the Add-to-dock popover. */
export const CATEGORY_ORDER = ['monitor', 'timing', 'tyres', 'strategy', 'analysis', 'prediction', 'system'];
export const CATEGORY_LABELS = {
  monitor:    'Monitor',
  timing:     'Timing',
  tyres:      'Tyres',
  strategy:   'Strategy',
  analysis:   'Analysis',
  prediction: 'Prediction',
  system:     'System',
};

export const PRESETS = {
  strategy: { label: 'Strategy',   slotA: 'analytics',  slotB: 'strategy',  slotC: 'analysis',  splitV: 0.55, splitH: 0.6 },
  tyres:    { label: 'Tyres',      slotA: 'laptimes',   slotB: 'tiredeg',   slotC: 'tyrehealth', splitV: 0.55, splitH: 0.65 },
  pace:     { label: 'Pace',       slotA: 'laptimes',   slotB: 'trackmap',  slotC: 'lapdelta',   splitV: 0.5,  splitH: 0.65 },
  predict:  { label: 'Prediction', slotA: 'prediction', slotB: 'strategy',  slotC: 'analysis',   splitV: 0.5,  splitH: 0.55 },
  overview:   { label: 'Overview',   slotA: 'trackmap',   slotB: 'sectors',   slotC: 'racepace',   splitV: 0.5,  splitH: 0.5 },
  simulator:  { label: 'Simulator', slotA: 'simulator',  slotB: 'strategy',  slotC: 'prediction', splitV: 0.4,  splitH: 0.55 },
};
