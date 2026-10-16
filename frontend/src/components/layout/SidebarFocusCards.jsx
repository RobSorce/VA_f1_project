import React, { useEffect, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import FocusDriverWidget from '../ui/FocusDriverWidget';
import PitWallSectorPanel from '../ui/PitWallSectorPanel';

// The focus driver's cards under the Leaderboard in the Analyse sidebar
// (App.jsx). Stacked in the 240-300 px sidebar they take 479-515 px, so the
// 20 Leaderboard rows and the cards fit together only on a window 1200 px
// high or more (docs/evidence/leaderboard_sidebar_fit.txt).
// Below that the cards stay collapsed to their header lines in the sidebar,
// so the Leaderboard keeps the whole field; "Details" opens them in full as a
// card laid over the bottom of the sidebar (closed with "Less"), so opening
// them never squeezes or clips the Leaderboard rows (the rows
// were clipped under the cards, with no scroll and no pager).
const SIDEBAR_SHORT_VIEWPORT = '(max-height: 1199px)';

function Toggle({ focusDriver, open, onToggle }) {
  return (
    <button
      type="button"
      className="pitwall-layout__focus-toggle"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? 'Collapse the focus cards to their header lines' : 'Show the focus cards in full'}
    >
      <span>Focus {focusDriver}</span>
      <span aria-hidden="true">{open ? '▾ Less' : '▸ Details'}</span>
    </button>
  );
}

export default function SidebarFocusCards({ withSectors = true }) {
  const focusDriver = useF1Store((s) => s.focusDriver);
  const short = useMediaQuery(SIDEBAR_SHORT_VIEWPORT);
  const [open, setOpen] = useState(!short);
  useEffect(() => { setOpen(!short); }, [short]);
  const toggle = () => setOpen((v) => !v);
  // No focus driver: the widget's one-line hint, nothing to collapse
  const collapsed = !!focusDriver && (short || !open);
  const overlay = !!focusDriver && short && open;

  return (
    <>
      <div className={`app-sidebar__focus${collapsed ? ' app-sidebar__focus--collapsed' : ''}`}>
        {focusDriver && <Toggle focusDriver={focusDriver} open={open} onToggle={toggle} />}
        {withSectors && <PitWallSectorPanel />}
        <FocusDriverWidget />
      </div>
      {overlay && (
        <div className="app-sidebar__focus app-sidebar__focus--overlay" role="dialog" aria-label={`Focus ${focusDriver}: details`}>
          <Toggle focusDriver={focusDriver} open={open} onToggle={toggle} />
          {withSectors && <PitWallSectorPanel />}
          <FocusDriverWidget />
        </div>
      )}
    </>
  );
}
