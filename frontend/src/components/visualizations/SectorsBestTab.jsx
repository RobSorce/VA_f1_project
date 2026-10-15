import React from 'react';
import { TEXT_COLORS, CHART_FONT } from '../../utils/colors';
import SectorsBestChart from './SectorsBestChart';

function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

/**
 * "Best" tab of the Sectors panel (SectorsPanel.jsx): one ranked column per
 * sector, the session-best sector times of the laps completed at the clock.
 *
 * Kept in its own file (Phase 9c): SectorsPanel.jsx owns the panel's layout
 * (the toggle, the legend, the fit and the pager: which sectors and which
 * ranks are on the page, the row height); this component draws the page it
 * is given, so its drawing can change (D5: a D3 chart, the charts lane)
 * without touching the layout. Each sector's body is a D3 chart of the gap
 * to the session best (SectorsBestChart: band scale of the ranks on the
 * page, bars on a linear gap scale, values next to them, team badges).
 *
 * @param {Object} props
 * @param {string[]} props.sectors - sectors on this page ('1' | '2' | '3')
 * @param {Object} props.bestRankings - sectorsPanelData().bestRankings
 * @param {Object} props.bestSessionBests - sectorsPanelData().bestSessionBests
 * @param {number} props.currentLap
 * @param {number} props.rowStart - first rank of the page (0-based)
 * @param {number} props.rowEnd - end of the page (exclusive)
 * @param {number} props.rowH - row height (px), fitted by SectorsPanel
 * @param {string[]} props.selectedDrivers
 * @param {string|null} props.highlightedDriver
 * @param {(driver: string|null) => void} props.onHover
 * @param {(driver: string) => void} props.onFocus
 * @param {(el: Element|null) => void} [props.bodyRef] - the first column's body (measured by the panel)
 */
export default function SectorsBestTab({
  sectors, bestRankings, bestSessionBests, currentLap, rowStart, rowEnd, rowH,
  selectedDrivers, highlightedDriver, onHover, onFocus, bodyRef,
}) {
  return (
    <>
      {sectors.map((s, colIdx) => {
        const items = bestRankings[s] || [];
        const best = bestSessionBests[s];
        return (
          <div key={s} className="sectors-panel__column">
            <div className="sectors-panel__col-header">
              <span className="sectors-panel__col-title" title={`Sector ${s}, lap ${currentLap}`}>SECTOR {s} <span style={{ color: TEXT_COLORS.muted, fontSize: CHART_FONT.label, fontWeight: 400 }}>Lap {currentLap}</span></span>
              {best && (
                <span className="sectors-panel__col-best">{formatTime(best)}</span>
              )}
            </div>
            <div ref={colIdx === 0 ? bodyRef : undefined} className="sectors-panel__col-body">
              <SectorsBestChart
                sector={s} items={items} sessionBest={best}
                rowStart={rowStart} rowEnd={rowEnd} rowH={rowH}
                selectedDrivers={selectedDrivers} highlightedDriver={highlightedDriver}
                onHighlight={onHover} onFocus={onFocus}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
