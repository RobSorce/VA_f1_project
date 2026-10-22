import React, { useMemo, useState, useRef, useEffect } from 'react';
import * as d3 from 'd3';
import { useF1Store } from '../../store/useF1Store';
import {
  driverStyle, tyreColor, textColor, markColor, withAlpha, CHART_FONT, chartFontPx,
  TEXT_COLORS, GRID_COLORS, UI_COLORS,
} from '../../utils/colors';
import { patternStopCount } from '../../utils/strategyViews';
import {
  selectionRows, selectionStatistics, forestHalfWidth, fmtSigned, fmtInterval, fmtMean,
  sameSelection, selectionClockNote, missingIntervalNote, progressRowNote, pageByHeights,
} from '../../utils/views/pcaSelection';
import {
  drawForestStrip, drawForestAxis, FOREST_W, FOREST_H, FOREST_AXIS_H,
} from '../../utils/views/pcaForestChart';
import { drawStintStrips, stintSegments } from '../../utils/views/stintStripChart';
import { drawLegend } from '../../utils/views/d3Legend';
import { useBoxSize, useChartBox, fitRows, pageOf } from '../../utils/views/chartBox';
import { lapRangeTooltip } from '../../utils/chartHelp';
import Panel from '../ui/Panel';

/* ── Shared tab pill style helper ── */
const tabPillStyle = (active) => ({
  padding: '3px 8px', fontSize: CHART_FONT.label, fontWeight: 700,
  borderRadius: 4, border: `1px solid ${active ? ACCENT : 'transparent'}`, cursor: 'pointer',
  background: active ? withAlpha(ACCENT, 0.15) : 'transparent',
  color: active ? TEXT_COLORS.primary : TEXT_COLORS.secondary,
  transition: 'background 0.12s, color 0.12s',
});

// Accent of the panel (the selection / brush colour of the biplot: it carries
// no category). A feature flagged above random is drawn in it AND labelled
// "above random" (never colour alone); the others in the neutral secondary.
const ACCENT = UI_COLORS.brush;
const ABOVE_RANDOM_COLOR = ACCENT;
const WITHIN_RANDOM_COLOR = TEXT_COLORS.secondary;
// Columns of the forest table (feature, forest strip, numbers): one grid for
// the head and every row (CSS subgrid), so the g axis of the head and the
// strips of the rows share their column to the pixel
const FOREST_COLUMNS = 'minmax(80px, 1fr) minmax(90px, 1.6fr) minmax(96px, auto)';
// Colours of the forest strips (utils/views/pcaForestChart.js)
const FOREST_COLORS = {
  band: withAlpha(TEXT_COLORS.primary, 0.14),
  threshold: GRID_COLORS.rule,
  zero: GRID_COLORS.axis,
};
// Height of a text line of the paged lists
const LINE_PX = () => Math.ceil(chartFontPx('data') * 1.35);
const PAGER_H = 22;
const muted = { color: TEXT_COLORS.secondary };
const sectionTitle = {
  color: TEXT_COLORS.secondary, margin: '0 0 6px', fontSize: CHART_FONT.data, textTransform: 'uppercase', fontWeight: 700,
};

export default function PCAAnalysisPanel() {
  const pcaStrategyAnalysis = useF1Store((s) => s.pcaStrategyAnalysis);
  const selectedPCAPoints = useF1Store((s) => s.selectedPCAPoints);
  const setSelectedPCAPoints = useF1Store((s) => s.setSelectedPCAPoints);
  const applyPCAPattern = useF1Store((s) => s.applyPCAPattern);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const setSelectedDrivers = useF1Store((s) => s.setSelectedDrivers);
  const simulatorStrategy = useF1Store((s) => s.simulatorStrategy);
  const setSelectedLapRange = useF1Store((s) => s.setSelectedLapRange);
  const pcaAnalysisIds = useF1Store((s) => s.pcaAnalysisIds);
  const pcaAnalysisError = useF1Store((s) => s.pcaAnalysisError);
  const [activeTab, setActiveTab] = useState('summary');

  // An analysis is shown only for the selection it answers (an answer set
  // without its ids is taken as the selection's)
  const analysis = pcaStrategyAnalysis && (!pcaAnalysisIds || sameSelection(pcaAnalysisIds, selectedPCAPoints))
    ? pcaStrategyAnalysis
    : null;
  const rows = useMemo(() => selectionRows(analysis), [analysis]);
  const stats = useMemo(() => selectionStatistics(analysis), [analysis]);
  const half = useMemo(() => forestHalfWidth(rows, stats.threshold), [rows, stats.threshold]);
  const strategies = useMemo(() => analysis?.strategies || [], [analysis]);
  const commonPatterns = useMemo(() => analysis?.common_patterns || [], [analysis]);
  const pitWindows = useMemo(() => analysis?.pit_windows || [], [analysis]);
  // Rows of the race on screen taken at the replay clock (null otherwise)
  const clockNote = selectionClockNote(analysis);


  // Convert PCA strategy pattern stints to simulator format with cumulative lapStart
  const applyStrategyToSimulator = (strategy) => {
    const driver = focusDriver || (selectedDrivers.length === 1 ? selectedDrivers[0] : null);
    if (!driver) return;
    let lapStart = 1;
    const stints = strategy.stints.map((s) => {
      const stint = { compound: s.compound, lapStart, length: s.length };
      lapStart += s.length;
      return stint;
    });
    applyPCAPattern({ driver, stints });
  };

  const canApply = !!(focusDriver || (selectedDrivers.length === 1));

  // Parse selected point IDs to get driver/year/round info
  const selectionInfo = useMemo(() => {
    if (!selectedPCAPoints || selectedPCAPoints.length === 0) return null;
    const drivers = new Set();
    const years = new Set();
    const rounds = new Set();
    for (const id of selectedPCAPoints) {
      const parts = id.rsplit ? id.split('_') : id.split('_');
      if (parts.length >= 3) {
        const round = parts.pop();
        const year = parts.pop();
        const driver = parts.join('_');
        drivers.add(driver);
        years.add(year);
        rounds.add(round);
      }
    }
    return {
      count: selectedPCAPoints.length,
      drivers: [...drivers],
      years: [...years],
      races: rounds.size,
    };
  }, [selectedPCAPoints]);

  // Tab definitions — must be before any early returns (Rules of Hooks)
  const pcaTabs = useMemo(() => {
    const tabs = [{ id: 'summary', label: 'Summary' }];
    if (strategies.length > 0 || commonPatterns.length > 0)
      tabs.push({ id: 'patterns', label: `Patterns (${strategies.length})` });
    if (rows.length > 0)
      tabs.push({ id: 'differences', label: 'Differences' });
    if (pitWindows.length > 0 || (selectionInfo && selectionInfo.drivers.length > 0))
      tabs.push({ id: 'details', label: 'Details' });
    return tabs;
  }, [strategies, commonPatterns, rows, pitWindows, selectionInfo]);
  // A tab the new answer does not have falls back to the summary
  const tab = pcaTabs.some((t) => t.id === activeTab) ? activeTab : 'summary';

  // No selection state
  if (!selectedPCAPoints || selectedPCAPoints.length === 0) {
    return (
      <Panel title="Cross-Race Analysis">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-md)', color: ACCENT, fontWeight: 700, marginBottom: 12 }}>
            PCA Biplot Analysis
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: TEXT_COLORS.secondary, lineHeight: 1.8, maxWidth: 240 }}>
            <strong>Lasso-select</strong> points on the PCA biplot to analyze cross-race strategy patterns.
          </div>
          <div style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary, lineHeight: 1.6, marginTop: 12, maxWidth: 240 }}>
            Each point is one driver in one race (the race on screen: the laps completed so far during its replay). Clusters reveal similar strategies across different races and seasons.
          </div>
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary, textAlign: 'left' }}>
            <span>Click a point to toggle selection</span>
            <span>Shift+drag to lasso-select a group</span>
            <span>Loading vectors show feature directions</span>
          </div>
        </div>
      </Panel>
    );
  }

  // Waiting for analysis response (or its error)
  if (!analysis) {
    return (
      <Panel title="Cross-Race Analysis">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: TEXT_COLORS.secondary }}>
            {pcaAnalysisError ? `Analysis failed: ${pcaAnalysisError}` : 'Analyzing selection...'}
          </div>
        </div>
      </Panel>
    );
  }

  // The clock of the race on screen's rows, wherever its stints / stops show
  const clockBanner = clockNote ? (
    <div className="pca-clock-note" style={{
      fontSize: CHART_FONT.data, color: TEXT_COLORS.primary, lineHeight: 1.4, flexShrink: 0,
      padding: '3px 6px', borderLeft: `2px solid ${TEXT_COLORS.secondary}`, background: withAlpha(TEXT_COLORS.primary, 0.04),
    }}>
      {clockNote}
    </div>
  ) : null;

  // What the numbers are: label, group sizes, how many features pass the
  // random-selection threshold
  const statsBanner = (
    <div className="pca-stats-banner" style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.secondary, lineHeight: 1.4, flexShrink: 0 }}>
      <div style={{ fontWeight: 700, color: TEXT_COLORS.primary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {stats.label}
      </div>
      <div>
        {stats.nSelected != null && stats.nRest != null
          ? `N = ${stats.nSelected} selected vs ${stats.nRest} other rows`
          : `N = ${selectedPCAPoints.length} selected`}
        {stats.threshold != null && rows.length > 0
          ? ` · ${stats.nAboveRandom} of ${stats.nFeatures} features above random`
          : ''}
      </div>
      {/* the selection's mix of row kinds, and the baseline drawn with it */}
      {stats.composition && (
        <div className="pca-composition">{stats.composition}</div>
      )}
      {clockBanner && <div style={{ marginTop: 4 }}>{clockBanner}</div>}
    </div>
  );

  return (
    <Panel title="Cross-Race Analysis">
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* Tab pills */}
        {pcaTabs.length > 1 && (
          <div style={{
            display: 'flex', gap: 4, padding: '4px 8px', flexShrink: 0, flexWrap: 'wrap',
            borderBottom: `1px solid ${GRID_COLORS.grid}`,
          }}>
            {pcaTabs.map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={tabPillStyle(tab === t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Tab content — takes all remaining space; lists are paged, never scrolled */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 'var(--spacing-sm)', display: 'flex', flexDirection: 'column' }}>

          {tab === 'summary' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              {/* Selection summary + cluster label */}
              <div style={{
                background: withAlpha(ACCENT, 0.06),
                borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)', borderLeft: `3px solid ${ACCENT}`,
              }}>
                <div style={{ fontSize: CHART_FONT.data, fontWeight: 700, color: ACCENT, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                  {analysis.cluster_label || 'Selected Cluster'}
                </div>
                <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.5, color: TEXT_COLORS.primary }}>
                  {analysis.summary}
                </div>
                <div style={{ marginTop: 6 }}>{statsBanner}</div>
                {selectionInfo && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: CHART_FONT.data, ...muted, flexWrap: 'wrap' }}>
                    <span>{selectionInfo.count} race entries</span>
                    <span>{selectionInfo.drivers.length} drivers</span>
                    <span>{selectionInfo.years.length > 1 ? `${selectionInfo.years.length} seasons` : `${selectionInfo.years[0]} season`}</span>
                  </div>
                )}
                {selectedPCAPoints.length > 0 && (
                  <button type="button" onClick={() => setSelectedPCAPoints([])} style={{
                    marginTop: 6, background: withAlpha(TEXT_COLORS.primary, 0.06), border: `1px solid ${GRID_COLORS.rule}`,
                    borderRadius: 3, padding: '2px 8px', fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, cursor: 'pointer',
                  }}>Clear selection</button>
                )}
              </div>

              {/* Compound usage inline */}
              {commonPatterns.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {commonPatterns.map((p, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                      background: withAlpha(TEXT_COLORS.primary, 0.04), borderLeft: `3px solid ${markColor(tyreColor(p.compound))}`,
                    }}>
                      {/* the compound named in full, in its colour lifted to 4.5:1 */}
                      <span style={{ fontSize: CHART_FONT.data, fontWeight: 700, color: textColor(tyreColor(p.compound)) }}>{p.compound}</span>
                      <span style={{ fontSize: CHART_FONT.data, ...muted }}>{p.count} stints · avg {p.avg_stint_length?.toFixed(0) || '?'}L</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'patterns' && (
            <>
              {clockBanner}
              {strategies.length > 0 && (
                <PatternList
                  strategies={strategies}
                  simulatorStrategy={simulatorStrategy}
                  canApply={canApply}
                  onApply={applyStrategyToSimulator}
                />
              )}
            </>
          )}

          {tab === 'differences' && (
            <ForestTable rows={rows} stats={stats} half={half} statsBanner={statsBanner} />
          )}

          {tab === 'details' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
              {pitWindows.length > 0 && clockBanner}
              {pitWindows.length > 0 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)' }}>
                  <h6 style={sectionTitle}>
                    Common Pit Windows
                  </h6>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {pitWindows.map((pw, i) => (
                      <div key={i}
                        onClick={() => setSelectedLapRange([pw.lap_start, pw.lap_end])}
                        title={lapRangeTooltip(pw.lap_start, pw.lap_end)}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: CHART_FONT.data, cursor: 'pointer' }}>
                        <span style={{
                          padding: '2px 6px', borderRadius: 3, fontWeight: 700, fontSize: CHART_FONT.data,
                          backgroundColor: i === 0 ? withAlpha(ACCENT, 0.15) : withAlpha(TEXT_COLORS.primary, 0.06),
                          color: i === 0 ? ACCENT : TEXT_COLORS.secondary,
                        }}>L{pw.lap_start}–L{pw.lap_end}</span>
                        <span style={muted}>{pw.count} stops in this window{i === 0 ? ' (most)' : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectionInfo && selectionInfo.drivers.length > 0 && selectionInfo.drivers.length <= 12 && (
                <div style={{ background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)' }}>
                  <h6 style={sectionTitle}>
                    Drivers in Selection
                  </h6>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {selectionInfo.drivers.map((d) => (
                      <span key={d}
                        onClick={() => { setFocusDriver(d); setSelectedDrivers([d]); }}
                        title={`Focus ${d} — enables strategy simulation`}
                        style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '3px 8px', borderRadius: 'var(--radius-sm)',
                        background: focusDriver === d ? withAlpha(TEXT_COLORS.primary, 0.1) : withAlpha(TEXT_COLORS.primary, 0.04),
                        borderLeft: `2px solid ${driverStyle(d).mark}`,
                        fontSize: CHART_FONT.data, fontWeight: 600, color: driverStyle(d).text,
                        cursor: 'pointer', outline: focusDriver === d ? `1px solid ${driverStyle(d).mark}` : 'none',
                      }}>{d}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** ◀ a–b of n ▶ */
function Pager({ page, total, onPage, what }) {
  const btn = {
    fontSize: CHART_FONT.label, color: TEXT_COLORS.primary, background: 'transparent',
    border: `1px solid ${GRID_COLORS.rule}`, borderRadius: 3, padding: '0 6px', cursor: 'pointer',
  };
  return (
    <div className="pca-pager" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: PAGER_H, flexShrink: 0,
      fontSize: CHART_FONT.label, ...muted,
    }}
    >
      <button type="button" aria-label={`Previous ${what}`} disabled={page.page === 0} onClick={() => onPage(page.page - 1)} style={btn}>{'◀'}</button>
      <span>{what} {page.first}{'–'}{page.last} of {total}</span>
      <button type="button" aria-label={`Next ${what}`} disabled={page.page >= page.pages - 1} onClick={() => onPage(page.page + 1)} style={btn}>{'▶'}</button>
    </div>
  );
}

/**
 * Strategy patterns of the selection: each a line of text (count, share,
 * stops, the apply action) over its stints drawn as a D3 strip
 * (utils/views/stintStripChart.js: compound colour, letter and length).
 * Rows fitted to the panel, paged when they do not fit (no scroll).
 */
function PatternList({ strategies, simulatorStrategy, canApply, onApply }) {
  const boxRef = useRef(null);
  const box = useBoxSize(boxRef);
  const [page, setPage] = useState(0);
  const stripH = Math.max(18, Math.round(chartFontPx('data') * 1.7));
  const rowH = LINE_PX() + stripH + 12;
  const fit = fitRows(box.height > 0 ? box.height - 28 : 0, strategies.length, {
    rowMin: rowH, rowMax: rowH, rowDefault: rowH, pagerH: PAGER_H,
  });
  const pg = pageOf(strategies.map((s, i) => ({ s, i })), page, fit.perPage);
  return (
    <div ref={boxRef} className="pca-patterns" style={{
      flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm) var(--spacing-md)',
    }}
    >
      <h6 style={{ ...sectionTitle, height: 20, flexShrink: 0 }}>Strategy Patterns</h6>
      {pg.rows.map(({ s, i }) => {
        const isApplied = simulatorStrategy?.stints?.length === s.stints.length
          && s.stints.every((st, j) => simulatorStrategy.stints[j]?.compound === st.compound);
        return (
          <div
            key={i}
            className="pca-pattern"
            onClick={() => canApply && onApply(s)}
            title={canApply ? 'Click to simulate this strategy' : 'Focus a driver first (double-click in Leaderboard)'}
            style={{
              height: fit.rowH, flexShrink: 0, padding: '3px 8px', boxSizing: 'border-box',
              background: isApplied ? withAlpha(ACCENT, 0.12) : i === 0 ? withAlpha(ACCENT, 0.05) : 'transparent',
              borderRadius: 'var(--radius-sm)',
              borderLeft: `2px solid ${isApplied || i === 0 ? ACCENT : 'transparent'}`,
              cursor: canApply ? 'pointer' : 'default', transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, height: LINE_PX(), fontSize: CHART_FONT.data }}>
              <span style={{ fontWeight: 700, color: i === 0 || isApplied ? ACCENT : TEXT_COLORS.primary }}>
                {s.count}× ({(s.frequency * 100).toFixed(0)}%){i === 0 ? ' most common' : ''}
              </span>
              {/* N stints = N - 1 stops (same rule as insightsGenerator / backend pca_compute.py) */}
              <span style={muted}>{patternStopCount(s.stints)}-stop strategy</span>
              {canApply && (
                <span style={{
                  marginLeft: 'auto', fontSize: CHART_FONT.label, fontWeight: 700,
                  color: isApplied ? TEXT_COLORS.primary : ACCENT,
                  padding: '0 5px', borderRadius: 3,
                  border: `1px solid ${isApplied ? TEXT_COLORS.primary : ACCENT}`,
                }}>{isApplied ? '✓ Applied' : 'Simulate →'}</span>
              )}
            </div>
            <PatternStrip stints={s.stints} rowH={stripH} />
          </div>
        );
      })}
      {fit.paged && <Pager page={pg} total={strategies.length} onPage={setPage} what="patterns" />}
    </div>
  );
}

/** One pattern's stints as a D3 strip, its own lap axis (the pattern's length). */
function PatternStrip({ stints, rowH }) {
  const boxRef = useRef(null);
  const svgRef = useRef(null);
  // a D3 drawing: the shared, frame-throttled hook of the D3 views (D4)
  const box = useChartBox(boxRef, { parent: false });
  useEffect(() => {
    if (!svgRef.current) return;
    const segs = stintSegments(stints).map((seg, j) => ({
      ...seg, title: `Stint ${j + 1}: ${seg.compound}, ${seg.length} laps`,
    }));
    const end = segs.reduce((m, seg) => Math.max(m, seg.start + seg.length), 2);
    drawStintStrips(svgRef.current, {
      rows: [{ key: 'pattern', label: '', segments: segs }],
      domain: [1, end],
      width: box.width > 0 ? box.width : 200,
      rowH,
      font: CHART_FONT.data,
      fontPx: chartFontPx('data'),
    });
  });
  return (
    <div ref={boxRef} style={{ minWidth: 0, marginTop: 2 }}>
      <svg ref={svgRef} className="pca-pattern-strip" style={{ display: 'block', maxWidth: '100%' }} />
    </div>
  );
}

/**
 * The Differences tab: one row per feature (label, the D3 forest strip on a
 * shared g axis, the numbers), each row as tall as its text needs (a label
 * that wraps, "above random", the notes), rows fitted to the panel and paged
 * when they do not fit (no scroll); a D3 legend names the marks; the method
 * and the long explanation sit in "Method" (open: it takes the rows' place).
 *
 * Every row is laid out in the shared grid, the rows of other pages after the
 * page's own and hidden: the columns then depend on all rows, never on the
 * page, and each row's height is measured where it is drawn.
 */
function ForestTable({ rows, stats, half, statsBanner }) {
  const rowsRef = useRef(null);
  const axisBoxRef = useRef(null);
  const axisRef = useRef(null);
  const legendRef = useRef(null);
  const rowsBox = useBoxSize(rowsRef);
  // the D3 axis: the shared, frame-throttled hook of the D3 views (D4)
  const axisBox = useChartBox(axisBoxRef, { parent: false });
  const [page, setPage] = useState(0);
  const [methodOpen, setMethodOpen] = useState(false);

  // Height of each row: as measured in the grid (a label or a number that
  // wraps takes another line), else counted from its lines: label (+ "above
  // random", + progress note) and numbers (+ no-interval note, + random |g| line)
  const measured = useRowHeights(rowsRef, rows);
  const heights = rows.map((r) => {
    if (measured[r.feature] > 0) return measured[r.feature];
    const left = 1 + (r.exceedsRandom ? 1 : 0) + (progressRowNote(r, stats) ? 1 : 0);
    const right = 2 + (fmtInterval(r.ciLow, r.ciHigh) ? 0 : 1);
    return Math.max(left, right) * LINE_PX() + 6;
  });
  const pg = pageByHeights(rows, heights, page, rowsBox.height, PAGER_H);
  const shown = new Set(pg.rows.map((r) => r.feature));

  useEffect(() => {
    if (axisRef.current && axisBox.width > 0) {
      drawForestAxis(axisRef.current, {
        half, width: axisBox.width, font: CHART_FONT.data, colors: { text: TEXT_COLORS.primary, axis: GRID_COLORS.axis },
      });
    }
    if (legendRef.current) {
      const width = rowsBox.width > 0 ? rowsBox.width : 360;
      const g = d3.select(legendRef.current).selectAll('g.pca-legend').data([0]).join('g').attr('class', 'pca-legend chart-legend');
      const h = drawLegend(g, [
        { key: 'g', label: "Hedges' g", shape: 'tick', color: TEXT_COLORS.primary },
        { key: 'interval', label: stats.intervalName || 'interval', shape: 'line', color: TEXT_COLORS.primary },
        { key: 'band', label: 'random |g| (shaded)', shape: 'rect', color: FOREST_COLORS.band, stroke: GRID_COLORS.rule },
        { key: 'threshold', label: 'threshold (dashed)', shape: 'dash', color: FOREST_COLORS.threshold },
        { key: 'above', label: 'above random (labelled)', shape: 'rect', color: ABOVE_RANDOM_COLOR },
      ], {
        font: CHART_FONT.data, fontPx: chartFontPx('data'), maxWidth: width - 8, textColor: TEXT_COLORS.primary,
      });
      legendRef.current.setAttribute('width', width);
      legendRef.current.setAttribute('height', h + 2);
    }
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {statsBanner}
      <div className="pca-forest" role="table" aria-label="Differences of the selection from the other rows"
        style={{
          background: 'var(--color-bg-tertiary)', borderRadius: 'var(--radius-md)', padding: 'var(--spacing-sm)',
          display: methodOpen ? 'none' : 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden',
        }}>
        <div className="pca-forest-grid" style={{
          display: 'grid', gridTemplateColumns: FOREST_COLUMNS, gridTemplateRows: 'auto minmax(0, 1fr)',
          columnGap: 6, flex: 1, minHeight: 0,
        }}>
          {/* Column heads; the g axis (D3) over the strips, its direction under it */}
          <div role="row" className="pca-forest-head" style={{
            display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid',
            fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, fontWeight: 600, marginBottom: 2, alignItems: 'end',
          }}>
            <span role="columnheader">Feature</span>
            <span role="columnheader" ref={axisBoxRef} style={{ minWidth: 0 }}>
              <svg ref={axisRef} className="pca-forest-axis-svg" style={{ display: 'block', height: FOREST_AXIS_H }} />
              {/* one line: the strips' column is the head's too, and a second line would take a row's room */}
              <span style={{ display: 'flex', justifyContent: 'space-between', whiteSpace: 'nowrap' }}
                title="Left of 0: lower in the selection than in the other rows; right of 0: higher">
                <span>{'◀'} lower</span><span>higher {'▶'}</span>
              </span>
            </span>
            <span role="columnheader" style={{ textAlign: 'right' }}>g [interval] · random |g|</span>
          </div>
          <div ref={rowsRef} className="pca-forest-rows" style={{
            display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid', alignContent: 'start',
            // each row as tall as its content: never shrunk to fit the box (the pager does that)
            gridAutoRows: 'max-content', minHeight: 0, overflow: 'hidden',
          }}>
            {[...pg.rows, ...rows.filter((r) => !shown.has(r.feature))].map((r) => (
              <ForestRow key={r.feature} r={r} stats={stats} half={half} hidden={!shown.has(r.feature)} />
            ))}
          </div>
        </div>
        {pg.paged && <Pager page={pg} total={rows.length} onPage={setPage} what="features" />}
        <svg ref={legendRef} className="pca-forest-legend" style={{ display: 'block', flexShrink: 0, maxWidth: '100%', marginTop: 2 }} />
      </div>
      <details
        onToggle={(e) => setMethodOpen(!!e.currentTarget.open)}
        style={{ fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, lineHeight: 1.45, flexShrink: methodOpen ? 1 : 0, minHeight: 0, overflow: 'hidden' }}
      >
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Method</summary>
        <div>
          {`Tick = Hedges' g (selection minus other rows, in pooled SDs); bar = ${stats.intervalName || 'interval'}`
            + (stats.minGroupForInterval != null
              ? ` (none for a group of fewer than ${stats.minGroupForInterval} rows: one row has no spread of its own)`
              : '')
            + '; shaded = expected |g| of a random selection of the same size and mix; dashed = the threshold a feature must pass to be marked "above random"'
            + (stats.perFeatureThreshold
              ? ` (each feature its own: the ${stats.thresholdLevel != null ? `${(stats.thresholdLevel * 100).toFixed(1)}% quantile` : 'same high percentile'} of its random |g|, so that 5% of random selections pass some threshold).`
              : '.')
            + (stats.progressNote ? ` ${stats.progressNote}.` : '')}
        </div>
        {stats.effectSize && <div>{stats.effectSize}</div>}
        {stats.interval && <div>{stats.interval}</div>}
        {stats.baseline && <div>{stats.baseline}</div>}
        {stats.composition && <div>{stats.composition}</div>}
        {stats.perFeatureThreshold
          ? stats.thresholdText && <div className="pca-threshold-rule">{stats.thresholdText}</div>
          : stats.threshold != null && <div>{`Above random: |g| > ${stats.threshold}`}</div>}
        {stats.note && <div style={{ marginTop: 4 }}>{stats.note}</div>}
      </details>
    </div>
  );
}

/**
 * Heights (px) of the rows of a list, by feature, as laid out: a
 * ResizeObserver on every row (data-feature), so a wrap from a new width or a
 * font that loaded late is seen; a row with no box (the list hidden) keeps
 * its last height. Empty where there is no ResizeObserver (no layout).
 */
function useRowHeights(listRef, rows) {
  const [heights, setHeights] = useState({});
  const keys = rows.map((r) => r.feature).join('|');
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return undefined;
    const obs = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = prev;
        for (const e of entries) {
          const key = e.target.getAttribute('data-feature');
          const h = e.borderBoxSize?.[0]?.blockSize ?? e.target.getBoundingClientRect().height;
          if (key && h > 0 && Math.abs((prev[key] || 0) - h) > 0.25) {
            if (next === prev) next = { ...prev };
            next[key] = h;
          }
        }
        return next;
      });
    });
    list.querySelectorAll('[data-feature]').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [listRef, keys]);
  return heights;
}

/**
 * One feature row: label, the D3 forest strip, the numbers. A row of another
 * page is laid out but hidden (its columns and height still count).
 */
function ForestRow({ r, stats, half, hidden = false }) {
  const svgRef = useRef(null);
  const color = r.exceedsRandom ? ABOVE_RANDOM_COLOR : WITHIN_RANDOM_COLOR;
  const interval = fmtInterval(r.ciLow, r.ciHigh);
  // a group too small for an interval (one row has no spread of its own)
  const noInterval = interval ? null : missingIntervalNote(r, stats.minGroupForInterval);
  // a feature that moves with race progress, rows at the clock mixed with whole races
  const progressNote = progressRowNote(r, stats);
  const otherN = r.nSelected != null && r.nRest != null
    && (r.nSelected !== stats.nSelected || r.nRest !== stats.nRest);
  // the |g| this row must pass (its own during a replay, else the one of all rows)
  const threshold = r.threshold ?? stats.threshold;
  useEffect(() => {
    if (!svgRef.current) return;
    drawForestStrip(svgRef.current, {
      row: r, half, threshold, hasInterval: !!interval, colors: { ...FOREST_COLORS, mark: color },
    });
  });
  return (
    <div role={hidden ? undefined : 'row'} className={hidden ? 'pca-forest-row-offpage' : 'pca-forest-row'}
      data-feature={r.feature}
      aria-hidden={hidden || undefined}
      title={hidden ? undefined : `g = ${r.g} · selection mean ${fmtMean(r.selectedMean, r.unit)} · other rows ${fmtMean(r.restMean, r.unit)}`}
      style={{
        display: 'grid', gridColumn: '1 / -1', gridTemplateColumns: 'subgrid', boxSizing: 'border-box',
        alignItems: 'center', padding: '2px 0', borderTop: `1px solid ${GRID_COLORS.grid}`, overflow: 'hidden',
        visibility: hidden ? 'hidden' : undefined,
      }}>
      <span role={hidden ? undefined : 'cell'} style={{ fontSize: CHART_FONT.data, color: TEXT_COLORS.primary, fontWeight: r.exceedsRandom ? 700 : 500, lineHeight: 1.35 }}>
        {r.label}
        {r.exceedsRandom && (
          <span className="pca-above-random" style={{ display: 'block', fontSize: CHART_FONT.label, color: ABOVE_RANDOM_COLOR, fontWeight: 700 }}>
            above random
          </span>
        )}
        {progressNote && (
          <span className="pca-progress-note" title={stats.progressNote || undefined}
            style={{ display: 'block', fontSize: CHART_FONT.label, color: TEXT_COLORS.secondary, fontWeight: 600, fontStyle: 'italic' }}>
            {progressNote}
          </span>
        )}
      </span>
      <svg ref={svgRef} role={hidden ? undefined : 'cell'} viewBox={`0 0 ${FOREST_W} ${FOREST_H}`} preserveAspectRatio="none"
        width="100%" height={FOREST_H} aria-label={`g ${fmtSigned(r.g)}`} />
      <span role={hidden ? undefined : 'cell'} style={{ fontSize: CHART_FONT.data, textAlign: 'right', lineHeight: 1.35, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color, fontWeight: 700 }}>g {fmtSigned(r.g)}</span>
        {interval && <span style={{ color: TEXT_COLORS.secondary }}> {interval}</span>}
        {noInterval && (
          <span className="pca-no-interval" style={{ display: 'block', color: TEXT_COLORS.secondary }}>
            {noInterval}
          </span>
        )}
        <span style={{ display: 'block', color: TEXT_COLORS.secondary }}>
          {r.baseline != null ? `random |g| ${r.baseline.toFixed(2)}` : 'no random baseline'}
          {stats.perFeatureThreshold && r.threshold != null
            ? <span className="pca-row-threshold">{` · threshold ${r.threshold.toFixed(2)}`}</span>
            : null}
          {otherN ? ` · n ${r.nSelected} vs ${r.nRest}` : ''}
        </span>
      </span>
    </div>
  );
}
