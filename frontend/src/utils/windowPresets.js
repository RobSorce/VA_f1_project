/**
 * Window presets for the docked layout system.
 *
 * Each preset defines a `dockedLayout` tree that creates a JetBrains-style
 * split-pane layout with draggable splitters and tabs per pane.
 *
 * Layout tree nodes:
 *   Split: { direction: 'horizontal'|'vertical', ratio: 0-1, children: [A, B] }
 *   Pane:  { tabs: ['vizId', ...], activeTab: 'vizId' }
 *
 * Legacy `windows` array is kept as fallback for floating overlay mode.
 */

export const WINDOW_PRESETS = {
  strategy: {
    label: 'Strategy',
    description: 'PCA + Strategy Analysis + Strategy Timeline',
    dockedLayout: {
      direction: 'vertical', ratio: 0.6,
      children: [
        {
          direction: 'horizontal', ratio: 0.55,
          children: [
            { tabs: ['analytics'], activeTab: 'analytics' },
            { tabs: ['ai'], activeTab: 'ai' },
          ],
        },
        { tabs: ['laptimes'], activeTab: 'laptimes' },
      ],
    },
    windows: [
      { id: 'analytics', position: { left: '0%', top: '0%', width: '55%', height: '60%' } },
      { id: 'ai',        position: { left: '55%', top: '0%', width: '45%', height: '60%' } },
      { id: 'laptimes',  position: { left: '0%', top: '60%', width: '100%', height: '40%' } },
    ],
  },
  tyres: {
    label: 'Tyres',
    description: 'Lap Times + Tyre Degradation + Tyre Health',
    dockedLayout: {
      direction: 'horizontal', ratio: 0.55,
      children: [
        { tabs: ['laptimes'], activeTab: 'laptimes' },
        { tabs: ['tyres'], activeTab: 'tyres' },
      ],
    },
    windows: [
      { id: 'laptimes', position: { left: '0%', top: '0%', width: '55%', height: '100%' } },
      { id: 'tyres',    position: { left: '55%', top: '0%', width: '45%', height: '100%' } },
    ],
  },
  pace: {
    label: 'Pace',
    description: 'Lap Times + Sectors + Lap Delta',
    dockedLayout: {
      direction: 'vertical', ratio: 0.55,
      children: [
        {
          direction: 'horizontal', ratio: 0.5,
          children: [
            { tabs: ['laptimes'], activeTab: 'laptimes' },
            { tabs: ['sectors'], activeTab: 'sectors' },
          ],
        },
        { tabs: ['consistency'], activeTab: 'consistency' },
      ],
    },
    windows: [
      { id: 'laptimes', position: { left: '0%', top: '0%', width: '50%', height: '55%' } },
      { id: 'sectors',  position: { left: '50%', top: '0%', width: '50%', height: '55%' } },
      { id: 'consistency', position: { left: '0%', top: '55%', width: '100%', height: '45%' } },
    ],
  },
  prediction: {
    label: 'Prediction',
    description: 'Position Tracker + Race Prediction + AI Assistant',
    dockedLayout: {
      direction: 'horizontal', ratio: 0.55,
      children: [
        {
          direction: 'vertical', ratio: 0.55,
          children: [
            { tabs: ['positionlaps'], activeTab: 'positionlaps' },
            { tabs: ['laptimes'], activeTab: 'laptimes' },
          ],
        },
        {
          direction: 'vertical', ratio: 0.5,
          children: [
            { tabs: ['prediction'], activeTab: 'prediction' },
            { tabs: ['ai'], activeTab: 'ai' },
          ],
        },
      ],
    },
    windows: [
      { id: 'positionlaps', position: { left: '0%', top: '0%', width: '55%', height: '55%' } },
      { id: 'laptimes',     position: { left: '0%', top: '55%', width: '55%', height: '45%' } },
      { id: 'prediction',   position: { left: '55%', top: '0%', width: '45%', height: '50%' } },
      { id: 'ai',           position: { left: '55%', top: '50%', width: '45%', height: '50%' } },
    ],
  },
  overview: {
    label: 'Overview',
    description: 'Sectors + Consistency + Compare',
    dockedLayout: {
      direction: 'vertical', ratio: 0.5,
      children: [
        {
          direction: 'horizontal', ratio: 0.5,
          children: [
            { tabs: ['sectors'], activeTab: 'sectors' },
            { tabs: ['consistency'], activeTab: 'consistency' },
          ],
        },
        { tabs: ['compare'], activeTab: 'compare' },
      ],
    },
    windows: [
      { id: 'sectors',     position: { left: '0%', top: '0%', width: '50%', height: '50%' } },
      { id: 'consistency', position: { left: '50%', top: '0%', width: '50%', height: '50%' } },
      { id: 'compare',     position: { left: '0%', top: '50%', width: '100%', height: '50%' } },
    ],
  },
  pitwindow: {
    label: 'Pit Window',
    description: 'Track Map + Circle of Doom + Strategy Timeline',
    dockedLayout: {
      direction: 'vertical', ratio: 0.62,
      children: [
        {
          direction: 'horizontal', ratio: 0.5,
          children: [
            { tabs: ['trackmap'], activeTab: 'trackmap' },
            { tabs: ['circle'], activeTab: 'circle' },
          ],
        },
        { tabs: ['strategy'], activeTab: 'strategy' },
      ],
    },
    windows: [
      { id: 'trackmap', position: { left: '0%', top: '0%', width: '50%', height: '62%' } },
      { id: 'circle',   position: { left: '50%', top: '0%', width: '50%', height: '62%' } },
      { id: 'strategy', position: { left: '0%', top: '62%', width: '100%', height: '38%' } },
    ],
  },
  simulator: {
    label: 'Simulator',
    description: 'Strategy Simulator + Strategy Timeline + Race Prediction',
    dockedLayout: {
      direction: 'vertical', ratio: 0.55,
      children: [
        {
          direction: 'horizontal', ratio: 0.4,
          children: [
            { tabs: ['simulator'], activeTab: 'simulator' },
            { tabs: ['strategy'], activeTab: 'strategy' },
          ],
        },
        { tabs: ['prediction'], activeTab: 'prediction' },
      ],
    },
    windows: [
      { id: 'simulator',  position: { left: '0%', top: '0%', width: '40%', height: '55%' } },
      { id: 'strategy',   position: { left: '40%', top: '0%', width: '60%', height: '55%' } },
      { id: 'prediction', position: { left: '0%', top: '55%', width: '100%', height: '45%' } },
    ],
  },
};
