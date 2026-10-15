import React, { useMemo, useEffect, useRef } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { driverStyle, CHART_FONT, chartFontPx } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import {
  runningOrderAt, sectorDeltaRows, sectorMeans, waterfallLaps, waterfallLapsThatFit, waterfallDomain, fmtDelta,
} from '../../utils/views/sectorDeltaWaterfall';
import { drawSectorDeltaWaterfall, WATERFALL_MARGIN } from '../../utils/views/sectorDeltaWaterfallChart';
import { useBoxSize } from '../../utils/views/chartBox';
import { CHART_COLORS, timeDeltaColor, UP, DOWN } from '../../utils/views/strategyMarks';

// Laps the waterfall can hold (a wide panel); a narrow one shows the most
// recent laps that fit (sectorDeltaWaterfall.js waterfallLapsThatFit)
const MAX_LAPS = 20;

/**
 * Sector Delta: the focus driver against a reference driver, sector by sector
 * over the laps both completed at the replay clock, drawn as a D3 waterfall
 * (utils/views/sectorDeltaWaterfallChart.js) with the mean of each sector
 * above it. No scroll: the chart shows the most recent laps its width holds.
 */
export default function SectorDeltaWaterfall() {
  const sessionData = useF1Store((s) => s.sessionData);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const comparisonDriver = useF1Store((s) => s.comparisonDriver);
  const setComparisonDriver = useF1Store((s) => s.setComparisonDriver);
  // Causal "now" in session seconds (utils/raceTime.js): only laps completed
  // by then are compared
  const sessionNow = useSessionNow();
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  const box = useBoxSize(boxRef);

  const lapTimes = sessionData?.lap_times || [];

  const driverList = useMemo(() => {
    const set = new Set();
    for (const lt of lapTimes) if (lt.Driver) set.add(lt.Driver);
    return Array.from(set).sort();
  }, [lapTimes]);

  // Default focus to first driver if none selected
  const effectiveFocus = focusDriver || driverList[0] || null;

  // Default reference: driver ahead of focus in the running order at sessionNow
  const defaultRef = useMemo(() => {
    if (!effectiveFocus) return null;
    const order = runningOrderAt(lapTimes, sessionNow);
    const idx = order.indexOf(effectiveFocus);
    if (idx > 0) return order[idx - 1];
    if (order.length > 1) return order.find((d) => d !== effectiveFocus);
    return driverList.find((d) => d !== effectiveFocus) || null;
  }, [lapTimes, sessionNow, effectiveFocus, driverList]);

  // Use the shared comparison driver (synced with Undercut Calculator).
  // Fall back to the heuristic default (driver ahead of focus) when unset.
  const refDriver = (comparisonDriver && comparisonDriver !== effectiveFocus)
    ? comparisonDriver
    : defaultRef;

  // Seed the shared state on first render if no comparison is set yet,
  // so both panels start showing the same rival without user action.
  useEffect(() => {
    if (!comparisonDriver && defaultRef) {
      setComparisonDriver(defaultRef);
    }
  }, [comparisonDriver, defaultRef, setComparisonDriver]);

  // Laps both drivers completed at sessionNow (an unfinished lap is never compared)
  const rows = useMemo(
    () => sectorDeltaRows(lapTimes, effectiveFocus, refDriver, sessionNow, MAX_LAPS),
    [lapTimes, effectiveFocus, refDriver, sessionNow],
  );

  // The laps the width holds (all of them before the panel is measured)
  const plotWidth = box.width > 0 ? box.width - WATERFALL_MARGIN.left - WATERFALL_MARGIN.right : 0;
  const shown = useMemo(
    () => waterfallLaps(rows, waterfallLapsThatFit(plotWidth, rows.length)),
    [rows, plotWidth],
  );
  // Mean per sector over the laps drawn
  const summary = useMemo(() => sectorMeans(shown), [shown]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || box.width <= 0 || box.height <= 0 || !effectiveFocus || !refDriver) return;
    drawSectorDeltaWaterfall(svg, {
      laps: shown,
      domain: waterfallDomain(shown),
      width: box.width,
      height: box.height,
      focus: effectiveFocus,
      reference: refDriver,
      colors: {
        faster: CHART_COLORS.better,
        slower: CHART_COLORS.worse,
        even: CHART_COLORS.neutral,
        text: CHART_COLORS.text,
        muted: CHART_COLORS.muted,
        grid: CHART_COLORS.grid,
      },
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
    });
  }, [shown, box.width, box.height, effectiveFocus, refDriver]);

  const ready = !!(effectiveFocus && refDriver);
  const focusStyle = ready ? driverStyle(effectiveFocus) : null;
  const refStyle = ready ? driverStyle(refDriver) : null;

  return (
    <div className="sdw" style={{
      display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: CHART_FONT.data,
    }}>
      {!ready && (
        <div style={{ padding: 20, color: CHART_COLORS.secondary }}>
          Select a focus driver and ensure at least two drivers have lap data.
        </div>
      )}
      {ready && (
        <>
          {/* Header: focus vs reference (the shared comparison driver) */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ color: CHART_COLORS.secondary, fontSize: CHART_FONT.label }}>FOCUS</span>
            <span style={{ fontWeight: 800, color: focusStyle.text }}>{effectiveFocus}</span>
            <span style={{ color: CHART_COLORS.secondary, fontSize: CHART_FONT.label }}>vs REF</span>
            <select
              value={refDriver}
              onChange={(e) => setComparisonDriver(e.target.value)}
              aria-label="Reference driver"
              style={{
                background: CHART_COLORS.surface,
                color: refStyle.text,
                border: `1px solid ${refStyle.mark}`,
                borderRadius: 4,
                fontWeight: 800,
                fontSize: CHART_FONT.data,
                padding: '2px 6px',
              }}
            >
              {driverList.filter((d) => d !== effectiveFocus).map((d) => (
                <option key={d} value={d} style={{ background: CHART_COLORS.surface, color: CHART_COLORS.text }}>{d}</option>
              ))}
            </select>
          </div>

          {/* Mean of each sector over the laps drawn, signed and with its arrow */}
          <div className="sdw-avg" style={{
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 2,
          }}
          >
            <span style={{ color: CHART_COLORS.secondary, fontWeight: 700 }}>
              AVG {shown.length} lap{shown.length === 1 ? '' : 's'}
            </span>
            {summary.map((v, i) => (
              <span
                key={i}
                title={v == null ? `S${i + 1}: no lap with a time for both` : `S${i + 1}: ${effectiveFocus} ${fmtDelta(v)} s on average against ${refDriver} (${v < 0 ? 'faster' : v > 0 ? 'slower' : 'level'})`}
                style={{ color: v == null ? CHART_COLORS.secondary : timeDeltaColor(v), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
              >
                S{i + 1} {v == null ? '—' : `${v < 0 ? DOWN : v > 0 ? UP : ''}${fmtDelta(v)}`}
              </span>
            ))}
          </div>
        </>
      )}

      {/* The D3 waterfall fills the rest of the panel (always mounted, so it is measured) */}
      <div ref={boxRef} className="sdw-chart" style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <svg ref={svgRef} className="sdw-svg" style={{ display: 'block' }} />
        {ready && rows.length === 0 && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, textAlign: 'center', color: CHART_COLORS.secondary,
          }}
          >
            No overlapping laps yet between {effectiveFocus} and {refDriver}.
          </div>
        )}
      </div>
    </div>
  );
}
