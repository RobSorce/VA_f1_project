import React, { useEffect, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import TimingTower from '../visualizations/TimingTower';
import FocusDriverWidget from '../ui/FocusDriverWidget';
import PitWallSectorPanel from '../ui/PitWallSectorPanel';
import RacePaceGrid from '../visualizations/RacePaceGrid';
import TrackMap from '../visualizations/TrackMap';
import CircleOfDoom from '../visualizations/CircleOfDoom';
import SessionInfoBar from '../ui/SessionInfoBar';
import WeatherMini from '../ui/WeatherMini';
import RaceControlFeed from '../ui/RaceControlFeed';
import GeminiQuickQuery from '../ui/GeminiQuickQuery';

// Fixed viewport (V13): the layout is exactly the app body (100 % of a
// 100vh shell, no page scroll). Every grid cell below has overflow hidden and
// min-height / min-width 0, so its automatic minimum size is 0 and a `1fr`
// track behaves as minmax(0, 1fr): no view (the 53-lap pace grid, 20 tower
// rows) can grow a row past the window; it adapts or scrolls inside its own
// cell (docs/SCROLL_JUSTIFICATIONS.md). The focus-driver cards are laid out
// by .pitwall-layout__focus (styles/dashboard.css).

// Below this viewport height the focus-driver cards open collapsed to their
// header lines, so the Timing Tower keeps all 20 rows; the user expands them
// on demand (the toggle is remembered until the next viewport change).
const SHORT_VIEWPORT = '(max-height: 899px)';

const layoutStyle = {
  display: 'grid',
  gridTemplateColumns: '480px 1fr',
  gridTemplateRows: 'minmax(0, 1fr)',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  gap: 1,
};

const sidebarStyle = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: 'rgba(12, 12, 28, 0.95)',
  borderRight: '1px solid rgba(255, 255, 255, 0.06)',
};

const mainStyle = {
  display: 'grid',
  gridTemplateRows: '44px 1fr 35vh',
  gridTemplateColumns: 'minmax(0, 1fr)',
  overflow: 'hidden',
  minWidth: 0,
  minHeight: 0,
};

// Track Map and Circle of Doom side by side: the same cars on the same replay
// clock, in metres and in seconds (never overlaid)
const bottomRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) 280px',
  gridTemplateRows: 'minmax(0, 1fr)',
  gap: 1,
  overflow: 'hidden',
  minHeight: 0,
};

// Weather and the Ask box keep their height, Race Control takes the rest
// (newest messages first); the quick answer is a card laid over the column
// (position relative), so nothing pushes the Ask box out of the cell
const sideColumnStyle = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: 'rgba(12,12,28,0.75)',
  borderLeft: '1px solid rgba(255,255,255,0.04)',
};

export default function PitWallLayout() {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const short = useMediaQuery(SHORT_VIEWPORT);
  const [cardsOpen, setCardsOpen] = useState(!short);
  useEffect(() => { setCardsOpen(!short); }, [short]);

  return (
    <div style={layoutStyle} className="pitwall-layout">
      {/* Left sidebar: Timing Tower, then the focus driver's cards */}
      <aside style={sidebarStyle} className="pitwall-layout__sidebar">
        <div className="pitwall-layout__tower">
          <TimingTower />
        </div>
        <div className={`pitwall-layout__focus${cardsOpen ? '' : ' pitwall-layout__focus--collapsed'}`}>
          {focusDriver && (
            <button
              type="button"
              className="pitwall-layout__focus-toggle"
              onClick={() => setCardsOpen((v) => !v)}
              aria-expanded={cardsOpen}
              title={cardsOpen ? 'Collapse the focus cards to their header lines' : 'Show the focus cards in full'}
            >
              <span>Focus {focusDriver}</span>
              <span aria-hidden="true">{cardsOpen ? '▾ Less' : '▸ Details'}</span>
            </button>
          )}
          <div className="pitwall-layout__focus-cards">
            <PitWallSectorPanel />
            <FocusDriverWidget />
          </div>
        </div>
      </aside>

      {/* Right: main content */}
      <div style={mainStyle} className="pitwall-layout__main">
        <SessionInfoBar />
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <RacePaceGrid />
        </div>
        <div style={bottomRowStyle}>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>
            <TrackMap />
          </div>
          <div style={{ overflow: 'hidden', minHeight: 0 }}>
            <CircleOfDoom />
          </div>
          <div style={sideColumnStyle}>
            <WeatherMini />
            <RaceControlFeed />
            <GeminiQuickQuery />
          </div>
        </div>
      </div>
    </div>
  );
}
