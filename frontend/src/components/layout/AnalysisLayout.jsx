import { useCallback, useRef } from 'react';
import { useF1Store } from '../../store/useF1Store';
import Leaderboard from '../visualizations/Leaderboard';
import FocusDriverWidget from '../ui/FocusDriverWidget';
import AnalysisSlot from './AnalysisSlot';
import DragDivider from './DragDivider';

export default function AnalysisLayout() {
  const analysisSlots = useF1Store((s) => s.analysisSlots);
  const slotCVisible = useF1Store((s) => s.slotCVisible);
  const splitVertical = useF1Store((s) => s.splitVertical);
  const splitHorizontal = useF1Store((s) => s.splitHorizontal);
  const setSplitVertical = useF1Store((s) => s.setSplitVertical);
  const setSplitHorizontal = useF1Store((s) => s.setSplitHorizontal);
  const leaderboardCollapsed = useF1Store((s) => s.leaderboardCollapsed);

  const topRowRef = useRef(null);
  const containerRef = useRef(null);

  const handleVerticalDrag = useCallback((deltaPixels) => {
    if (!topRowRef.current) return;
    const totalWidth = topRowRef.current.offsetWidth;
    if (totalWidth === 0) return;
    const deltaRatio = deltaPixels / totalWidth;
    setSplitVertical(splitVertical + deltaRatio);
  }, [splitVertical, setSplitVertical]);

  const handleHorizontalDrag = useCallback((deltaPixels) => {
    if (!containerRef.current) return;
    const totalHeight = containerRef.current.offsetHeight;
    if (totalHeight === 0) return;
    const deltaRatio = deltaPixels / totalHeight;
    setSplitHorizontal(splitHorizontal + deltaRatio);
  }, [splitHorizontal, setSplitHorizontal]);

  const slotAWidth = `${splitVertical * 100}%`;
  const slotBWidth = `${(1 - splitVertical) * 100}%`;

  return (
    <div className="analysis-layout" ref={containerRef}>
      <aside className={`analysis-sidebar${leaderboardCollapsed ? ' analysis-sidebar--collapsed' : ''}`}>
        <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
          <Leaderboard collapsed={leaderboardCollapsed} />
        </div>
        {!leaderboardCollapsed && <FocusDriverWidget />}
      </aside>

      <div className="analysis-main">
        <div
          className="analysis-top-row"
          ref={topRowRef}
          style={{ flex: slotCVisible ? splitHorizontal : 1 }}
        >
          <div className="analysis-slot-a" style={{ width: slotAWidth }}>
            <AnalysisSlot slotKey="slotA" vizId={analysisSlots.slotA} />
          </div>

          <DragDivider
            direction="vertical"
            onDrag={handleVerticalDrag}
            onDragEnd={(action) => {
              if (action === 'reset') setSplitVertical(0.5);
            }}
          />

          <div className="analysis-slot-b" style={{ width: slotBWidth }}>
            <AnalysisSlot slotKey="slotB" vizId={analysisSlots.slotB} />
          </div>
        </div>

        {slotCVisible && (
          <>
            <DragDivider
              direction="horizontal"
              onDrag={handleHorizontalDrag}
              onDragEnd={(action) => {
                if (action === 'reset') setSplitHorizontal(0.65);
              }}
            />

            <div
              className="analysis-slot-c"
              style={{ flex: 1 - splitHorizontal }}
            >
              <AnalysisSlot slotKey="slotC" vizId={analysisSlots.slotC} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
