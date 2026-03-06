/**
 * Analysis slot visualization registry.
 * Each entry maps an id to a lazy-loaded component.
 * Using React.lazy avoids pulling every visualization into one bundle chunk.
 */
import { lazy } from 'react';

const TrackMap           = lazy(() => import('../components/visualizations/TrackMap'));
const LapTimeChart       = lazy(() => import('../components/visualizations/LapTimeChart'));
const LapDeltaChart      = lazy(() => import('../components/visualizations/LapDeltaChart'));
const StrategyTimeline   = lazy(() => import('../components/visualizations/StrategyTimeline'));
const TSNEScatterplot    = lazy(() => import('../components/visualizations/TSNEScatterplot'));
const AnalyticsTabContent = lazy(() => import('../components/tabs/AnalyticsTabContent'));
const TireDegradation    = lazy(() => import('../components/visualizations/TireDegradation'));
const TyreHealth         = lazy(() => import('../components/visualizations/TyreHealth'));
const TyreManagement     = lazy(() => import('../components/visualizations/TyreManagement'));
const ConsistencyPanel   = lazy(() => import('../components/visualizations/ConsistencyPanel'));
const SectorsPanel       = lazy(() => import('../components/visualizations/SectorsPanel'));
const RacePredictionPanel= lazy(() => import('../components/visualizations/RacePredictionPanel'));
const DriverComparePanel = lazy(() => import('../components/visualizations/DriverComparePanel'));
const GeminiAssistant    = lazy(() => import('../components/visualizations/GeminiAssistant'));
const RaceSituationMap   = lazy(() => import('../components/visualizations/RaceSituationMap'));
const TelemetryStrip     = lazy(() => import('../components/visualizations/TelemetryStrip'));
const StrategyAnalysis   = lazy(() => import('../components/visualizations/StrategyAnalysis'));
const RacePaceGrid       = lazy(() => import('../components/visualizations/RacePaceGrid'));
const SpeedPanel         = lazy(() => import('../components/visualizations/SpeedPanel'));
const SettingsTabContent = lazy(() => import('../components/tabs/SettingsTabContent'));

export const SLOT_OPTIONS = [
  { id: 'trackmap',       label: 'Track Map',            component: TrackMap },
  { id: 'laptimes',       label: 'Lap Times',            component: LapTimeChart },
  { id: 'lapdelta',       label: 'Lap Delta',            component: LapDeltaChart },
  { id: 'strategy',       label: 'Strategy Timeline',    component: StrategyTimeline },
  { id: 'analytics',      label: 'Analytics (PCA)',       component: AnalyticsTabContent },
  { id: 'tsne',           label: 'Strategy Space (PCA)', component: TSNEScatterplot },
  { id: 'tiredeg',        label: 'Tyre Degradation',     component: TireDegradation },
  { id: 'tyrehealth',     label: 'Tyre Health',          component: TyreHealth },
  { id: 'tyremgmt',       label: 'Pace Retention',       component: TyreManagement },
  { id: 'consistency',    label: 'Consistency',           component: ConsistencyPanel },
  { id: 'sectors',        label: 'Sectors & Speeds',     component: SectorsPanel },
  { id: 'speed',          label: 'Speed Rankings',        component: SpeedPanel },
  { id: 'prediction',     label: 'Race Prediction',      component: RacePredictionPanel },
  { id: 'compare',        label: 'Driver Compare',       component: DriverComparePanel },
  { id: 'gemini',         label: 'AI Strategist',        component: GeminiAssistant },
  { id: 'racesituation',  label: 'Race Situation (PCA)', component: RaceSituationMap },
  { id: 'telemetry',      label: 'Telemetry',            component: TelemetryStrip },
  { id: 'analysis',       label: 'Strategy Analysis',    component: StrategyAnalysis },
  { id: 'racepace',       label: 'Race Pace Grid',       component: RacePaceGrid },
  { id: 'settings',       label: 'Settings',             component: SettingsTabContent },
];

export const PRESETS = {
  strategy: { label: 'Strategy',   slotA: 'analytics',  slotB: 'strategy',  slotC: 'analysis',  splitV: 0.55, splitH: 0.6 },
  tyres:    { label: 'Tyres',      slotA: 'laptimes',   slotB: 'tiredeg',   slotC: 'tyrehealth', splitV: 0.55, splitH: 0.65 },
  pace:     { label: 'Pace',       slotA: 'laptimes',   slotB: 'trackmap',  slotC: 'lapdelta',   splitV: 0.5,  splitH: 0.65 },
  predict:  { label: 'Prediction', slotA: 'prediction', slotB: 'strategy',  slotC: 'gemini',     splitV: 0.5,  splitH: 0.55 },
  overview: { label: 'Overview',   slotA: 'trackmap',   slotB: 'sectors',   slotC: 'racepace',   splitV: 0.5,  splitH: 0.5 },
};
