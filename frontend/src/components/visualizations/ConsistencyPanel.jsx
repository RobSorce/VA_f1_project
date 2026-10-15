import React, {
  useMemo, useRef, useCallback, useState, useLayoutEffect,
} from 'react';
import { useF1Store } from '../../store/useF1Store';
import {
  getDriverColor, markColor, contrastText, tyreColor, tyreLetter, deltaColor, DIVERGING, TEXT_COLORS,
  TYRE_COLORS, TYRE_LABELS, chartFontPx, contextColor, SURFACES,
} from '../../utils/colors';
import Legend from '../ui/Legend';
import { exportAsPng } from '../../utils/exportChart';
import { useSessionNow } from '../../hooks/useSessionNow';
import { causalKey } from '../../utils/strategyViews';
import { MIN_FIT_LAPS, OUTLIER_K } from '../../utils/degradation';
import {
  consistencyView, formatSlope, LOW_DATA_FRACTION, FUEL_NOTE, FIT_NOTE,
} from '../../utils/views/degradationViews';
import { useBoxSize } from '../../utils/views/chartBox';
import {
  consistencyColumns, consistencyPages, consistencyPageOf, CONSISTENCY_CARD_EM, CONSISTENCY_GAP, CONSISTENCY_WIDE_CARD,
} from '../../utils/views/consistencyLayout';

const LOW_DATA_PERCENT = Math.round(LOW_DATA_FRACTION * 100);


function formatTime(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3);
  return mins > 0 ? `${mins}:${secs.padStart(6, '0')}` : secs;
}

// Legend (V4): the dry compounds of the tyre rows (FIA colour + letter) and
// the consistency badge (blue / orange of the diverging pair, with its word)
const CONSISTENCY_LEGEND = [
  ...['SOFT', 'MEDIUM', 'HARD'].map((c) => ({
    label: c[0] + c.slice(1).toLowerCase(), color: TYRE_COLORS[c], glyph: TYRE_LABELS[c], shape: 'badge',
  })),
  { label: 'Consistent: σ ≤ field median', color: DIVERGING.better, shape: 'square', title: "σ at or below the field's median σ" },
  { label: 'Inconsistent', color: DIVERGING.worse, shape: 'square', title: "σ above the field's median σ" },
];

export default function ConsistencyPanel() {
  const sessionData = useF1Store((s) => s.sessionData);
  const totalFrames = useF1Store((s) => s.totalFrames);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers);
  const highlightedDriver = useF1Store((s) => s.highlightedDriver);
  const setHighlightedDriver = useF1Store((s) => s.setHighlightedDriver);
  const setFocusDriver = useF1Store((s) => s.setFocusDriver);
  const focusDriver = useF1Store((s) => s.focusDriver);

  const panelRef = useRef(null);
  // The cards' area (callback ref: it exists only once there are cards)
  const [areaEl, setAreaEl] = useState(null);
  const areaRef = useMemo(() => ({ current: areaEl }), [areaEl]);
  const handleExport = useCallback(() => {
    if (!panelRef.current) return;
    exportAsPng(panelRef.current, 'consistency_analysis.png');
  }, []);

  // Per-driver expansion state. Default = collapsed. Focus driver and
  // explicit user toggles always override.
  const [expandedMap, setExpandedMap] = useState({});
  const [bulkMode, setBulkMode] = useState(null); // 'all' | null
  const isCardExpanded = useCallback((drv) => {
    // Precedence: explicit user toggle > focus driver > bulk mode > default.
    // Default is collapsed: one line per driver, so the whole field fits or
    // is paged (consistencyPages); an expanded card spans its row.
    if (drv in expandedMap) return expandedMap[drv];
    if (drv === focusDriver) return true;
    if (bulkMode === 'all') return true;
    return false;
  }, [expandedMap, bulkMode, focusDriver]);
  const toggleCard = useCallback((drv) => {
    setExpandedMap((m) => ({ ...m, [drv]: !isCardExpanded(drv) }));
  }, [isCardExpanded]);
  const expandAll = useCallback(() => { setExpandedMap({}); setBulkMode('all'); }, []);
  const collapseAll = useCallback(() => { setExpandedMap({}); setBulkMode(null); }, []);

  const replayStarted = totalFrames > 0;

  // Causal "now" in session seconds (utils/raceTime.js). The statistics change
  // only when a lap completes or a pit event happens (causalKey), not on
  // every replay tick.
  const sessionNow = useSessionNow();
  const lapTimes = sessionData?.lap_times;
  const lapKey = useMemo(() => causalKey(lapTimes, sessionNow), [lapTimes, sessionNow]);

  // Consistency from the laps completed at sessionNow, on the shared
  // degradation definition (consistencyView, utils/views/degradationViews):
  // σ = pooled residual sigma of the per-stint fits (consistencySigma), so
  // lap 1, pit laps, non-green laps, tyre wear, fuel burn and stops do not
  // count as inconsistency
  const { drivers, sessionAvg, minLapsThreshold } = useMemo(
    () => (replayStarted ? consistencyView(lapTimes, sessionNow)
      : { drivers: [], sessionAvg: null, minLapsThreshold: 0 }),
    // sessionNow enters through lapKey, which changes whenever the result does
    [lapTimes, lapKey, replayStarted],
  );

  /* ── Cards fitted to the panel, paged when they do not fit (D1) ──── */
  // The area under the header line holds the cards (the pager is in the
  // header line): collapsed cards are one line, in as many columns as the
  // width holds; an expanded card spans its row (its height measured once
  // drawn, an estimate until then). No scroll (the grid scrolled before
  // Phase 9c).
  const area = useBoxSize(areaRef);
  const cols = consistencyColumns(area.width, drivers.length, Math.ceil(CONSISTENCY_CARD_EM * chartFontPx('data')));
  const wideCards = area.width >= CONSISTENCY_WIDE_CARD;
  const measuredRef = useRef({ width: 0, heights: {} });
  const [measureTick, setMeasureTick] = useState(0);
  if (measuredRef.current.width !== area.width) measuredRef.current = { width: area.width, heights: {} };
  const layout = useMemo(() => consistencyPages(
    drivers.map((d) => {
      const expanded = isCardExpanded(d.driver);
      return { expanded, height: expanded ? measuredRef.current.heights[d.driver] : undefined };
    }),
    { cols, room: area.height },
  // measureTick and area.width: a new measured height of an expanded card
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [drivers, isCardExpanded, cols, area.height, area.width, measureTick]);
  // The page is the one that holds the anchor card: the card the user acted on
  // last (toggled, or the first card of a page reached with the pager), else
  // the focus driver's card. The pages move when a card expands or collapses,
  // a measured height arrives or the pane resizes; the anchor card stays on
  // screen through all of them (a page index kept, or a jump back to the
  // focus page, sent the card just expanded off the screen).
  const [anchor, setAnchor] = useState(focusDriver || null);
  const [prevFocus, setPrevFocus] = useState(focusDriver);
  if (prevFocus !== focusDriver) {
    // a new focus driver: his card is the anchor (adjusted during render)
    setPrevFocus(focusDriver);
    if (focusDriver) setAnchor(focusDriver);
  }
  const pageCount = Math.max(1, layout.pages.length);
  const anchorIndex = drivers.findIndex((d) => d.driver === anchor);
  const pageIdx = Math.min(anchorIndex >= 0 ? consistencyPageOf(layout.pages, anchorIndex) : 0, pageCount - 1);
  const pageRange = layout.pages[pageIdx] || { start: 0, end: drivers.length };
  const shown = drivers.slice(pageRange.start, pageRange.end);
  const goToPage = useCallback((k) => {
    const p = layout.pages[k];
    if (p && drivers[p.start]) setAnchor(drivers[p.start].driver);
  }, [layout.pages, drivers]);
  // Expand all / Collapse all keep the anchor card (it is on the page shown)
  const toggleAnchored = useCallback((drv) => { setAnchor(drv); toggleCard(drv); }, [toggleCard]);
  // Measure the expanded cards drawn; a new height lays the pages again
  useLayoutEffect(() => {
    if (!areaEl || !(area.width > 0)) return;
    let changed = false;
    for (const card of areaEl.querySelectorAll('[data-expanded="true"]')) {
      const h = Math.ceil(card.getBoundingClientRect().height);
      const drv = card.getAttribute('data-driver');
      if (h > 0 && Math.abs((measuredRef.current.heights[drv] || 0) - h) > 1) {
        measuredRef.current.heights[drv] = h;
        changed = true;
      }
    }
    if (changed) setMeasureTick((t) => t + 1);
  });

  if (!drivers.length) {
    return (
      <div className="consistency-panel__empty">
        {(sessionData?.lap_times?.length > 0) && !replayStarted
          ? 'Press play to start the race replay'
          : (sessionData?.lap_times?.length > 0)
            ? `No consistency yet: σ needs a stint with at least ${MIN_FIT_LAPS} clean laps `
              + '(lap 1, pit in/out laps and non-green laps do not count).'
            : 'No consistency data available. Load a session first.'}
      </div>
    );
  }

  return (
    <div ref={panelRef} className="consistency-panel">
      {/* Header line: summary, the pager (when the cards do not fit), the
          buttons, then the colour legend, which wraps on a narrow pane */}
      <div className="consistency-panel__bar">
        {sessionAvg ? (
          <div
            className="consistency-panel__session-summary"
            title={`Session average: mean of the laps behind the σ of the ${drivers.length} drivers listed: the clean laps of their fitted stints (lap 1, pit in/out laps, non-green laps and slow outliers left out)`}
          >
            <span>Avg <strong>{formatTime(sessionAvg)}</strong></span>
            <span>{drivers.length} drivers</span>
          </div>
        ) : <span />}
        {/* Pager of the cards that do not fit (consistencyPages) */}
        {pageCount > 1 && (
          <div className="consistency-panel__pager">
            <button
              type="button"
              className="consistency-panel__pager-btn"
              onClick={() => goToPage(pageIdx - 1)}
              disabled={pageIdx === 0}
              aria-label="Previous drivers"
            >{'◀'}</button>
            <span title={`Drivers ${pageRange.start + 1}–${pageRange.end} of ${drivers.length}, page ${pageIdx + 1} of ${pageCount}`}>
              {pageRange.start + 1}–{pageRange.end}/{drivers.length}
            </span>
            <button
              type="button"
              className="consistency-panel__pager-btn"
              onClick={() => goToPage(pageIdx + 1)}
              disabled={pageIdx >= pageCount - 1}
              aria-label="Next drivers"
            >{'▶'}</button>
          </div>
        )}
        <div className="consistency-panel__actions">
          {/* Expand/Collapse all — H7: power users can force full detail;
              the expanded cards are paged like the collapsed ones */}
          <button
            type="button"
            className="consistency-panel__bulk-btn"
            onClick={expandAll}
            title="Expand all cards (paged when they do not fit)"
          >Expand all</button>
          <button
            type="button"
            className="consistency-panel__bulk-btn"
            onClick={collapseAll}
            title="Collapse all cards"
          >Collapse all</button>
          <button
            onClick={handleExport}
            title="Export as PNG"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 4,
              border: 'none', background: 'transparent',
              color: TEXT_COLORS.muted, cursor: 'pointer',
              fontSize: '12px', padding: 0, flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
        {/* ── Colour legend: compounds with their letter, consistency badge ── */}
        <div className="consistency-panel__legend">
          <Legend items={CONSISTENCY_LEGEND} />
        </div>
      </div>

      <div ref={setAreaEl} className="consistency-panel__area">
        <div
          className="consistency-panel__grid"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: CONSISTENCY_GAP }}
        >
          {shown.map((d) => {
            const color = getDriverColor(d.driver);
            const compoundEntries = Object.entries(d.compounds || {});
            const isSelected = selectedDrivers.length === 0 || selectedDrivers.includes(d.driver);
            const isHl = highlightedDriver === d.driver;
            const isDimmed = highlightedDriver && !isHl;
            const expanded = isCardExpanded(d.driver);
            // Focus + context: a context card (not selected, or another card
            // hovered) turns its text to the muted colour and fades its marks
            // only (.consistency-card--context), never the card's opacity
            const isContext = !isSelected || !!isDimmed;
            return (
              <div key={d.driver}
                data-driver={d.driver}
                data-expanded={expanded ? 'true' : 'false'}
                className={[
                  'consistency-card',
                  'glass-card',
                  !expanded && 'consistency-card--collapsed',
                  expanded && wideCards && 'consistency-card--wide',
                  d.insufficient_data && 'consistency-card--low-data',
                  isContext && 'consistency-card--context',
                ].filter(Boolean).join(' ')}
                onMouseEnter={() => setHighlightedDriver(d.driver)}
                onMouseLeave={() => setHighlightedDriver(null)}
                title={d.insufficient_data
                  ? `Low data — only ${d.laps_completed} laps completed, below ${minLapsThreshold} (${LOW_DATA_PERCENT} % of the most laps completed in the field); σ from ${d.lap_count} laps is not comparable to full-race drivers.`
                  : undefined}
                style={{
                  // a collapsed card is one fitted line; an expanded one spans the row,
                  // at most as tall as the area (its details scroll beyond it:
                  // a floating overlay near its minimum size)
                  ...(expanded
                    ? { gridColumn: '1 / -1', maxHeight: area.height > 0 ? area.height : undefined }
                    : { height: layout.rowH }),
                  outline: isHl ? `1px solid ${markColor(color)}` : undefined,
                  transition: 'outline 0.15s',
                }}
              >
                {/* Header — click the name/body region to set focus; click
                    the chevron to toggle expansion. Two targets, one row. */}
                <div
                  className="consistency-card__header"
                  onClick={() => setFocusDriver(d.driver)}
                  style={{ cursor: 'pointer' }}
                >
                  {/* a context card's team bar mixed toward the panel (D7, >= 2:1) */}
                  <span className="consistency-card__team-bar" style={{ backgroundColor: isContext ? contextColor(markColor(color), SURFACES.panel) : markColor(color) }} />
                  <span className="consistency-card__name">{d.driver}</span>
                  {/* the one-line card keeps the code, σ, the badge and CV
                      (CONSISTENCY_CARD_EM); the number is in the expanded card */}
                  {expanded && d.number && <span className="consistency-card__number">#{d.number}</span>}
                  {d.insufficient_data && (
                    <span
                      className="consistency-card__low-data-chip"
                      title={`Only ${d.laps_completed} laps completed (< ${minLapsThreshold}, ${LOW_DATA_PERCENT} % of the most laps completed) — σ from a short race is not comparable.`}
                    >
                      LOW DATA
                    </span>
                  )}
                  {/* Collapsed-state key metric: σ visible without expanding */}
                  {!expanded && (
                    <span className="consistency-card__collapsed-sigma" title="σ = residual sigma of the per-stint fits">
                      &plusmn;{d.std_dev.toFixed(3)}s
                    </span>
                  )}
                  {/* a low-data σ is not comparable: its one-line card shows
                      LOW DATA in place of the badge, the expanded card both */}
                  {(expanded || !d.insufficient_data) && (
                    <span
                      className={`consistency-card__badge${d.is_consistent ? ' consistency-card__badge--consistent' : ' consistency-card__badge--inconsistent'}`}
                    >
                      {d.is_consistent ? 'Consistent' : 'Inconsistent'}
                    </span>
                  )}
                  <span className="consistency-card__cv" title="σ / average clean lap">CV: {d.cv_percent.toFixed(2)}%</span>
                  <button
                    type="button"
                    className={`consistency-card__chevron${expanded ? ' consistency-card__chevron--open' : ''}`}
                    aria-label={expanded ? `Collapse ${d.driver}` : `Expand ${d.driver}`}
                    aria-expanded={expanded}
                    onClick={(e) => { e.stopPropagation(); toggleAnchored(d.driver); }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                </div>

                {/* Detail: Performance | Consistency | Tyres, side by side on
                    a wide card (.consistency-card--wide), the tyres under the
                    two others on a narrow one */}
                {expanded && (
                  <div className="consistency-card__details">
                    <div className="consistency-card__col">
                      <div className="consistency-card__col-title">Performance</div>
                      <div className="consistency-card__stat">
                        <span>Average</span>
                        <span className="consistency-card__stat-value">{formatTime(d.avg_lap)}</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Fastest</span>
                        <span className="consistency-card__stat-value">{formatTime(d.fastest)}</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Slowest</span>
                        <span className="consistency-card__stat-value">{formatTime(d.slowest)}</span>
                      </div>
                      <div className="consistency-card__stat">
                        <span>Range</span>
                        <span className="consistency-card__stat-value">{d.range.toFixed(3)}s</span>
                      </div>
                    </div>

                    <div className="consistency-card__col">
                      <div className="consistency-card__col-title">Consistency</div>
                      <div
                        className="consistency-card__stat"
                        title={`Pooled residual sigma of ${d.fitted_stints} per-stint fit(s) of lap time on tyre life (${FIT_NOTE}): tyre wear, fuel burn and stops do not count as inconsistency`}
                      >
                        <span>Residual σ</span>
                        <span className="consistency-card__stat-value">&plusmn;{d.std_dev.toFixed(3)}s</span>
                      </div>
                      <div className="consistency-card__stat" title="Clean laps of the fitted stints">
                        <span>Sample Size</span>
                        <span className="consistency-card__stat-value">{d.sample_size} laps</span>
                      </div>
                      <div className="consistency-card__stat" title={`Slow laps of the fitted stints more than ${OUTLIER_K} robust sigmas above their stint's fit`}>
                        <span>Outliers</span>
                        <span className="consistency-card__stat-value">{d.outliers} removed</span>
                      </div>
                    </div>

                    {compoundEntries.length > 0 && (
                      <div className="consistency-card__tyres">
                        <div className="consistency-card__col-title">Tire Performance</div>
                        {compoundEntries.map(([compound, data]) => (
                          <div key={compound} className="consistency-card__tyre-row">
                            {/* FIA compound colour with its letter (contrastText) */}
                            <span
                              className="consistency-card__tyre-dot"
                              style={{
                                backgroundColor: tyreColor(compound), color: contrastText(tyreColor(compound)),
                                width: 'auto', height: 'auto', minWidth: 13, lineHeight: '13px', textAlign: 'center',
                                fontSize: 'var(--font-size-label)', fontWeight: 800,
                              }}
                            >{tyreLetter(compound)}</span>
                            <span className="consistency-card__tyre-name">{compound}</span>
                            <span className="consistency-card__tyre-stat">
                              Avg: {formatTime(data.avg)}
                            </span>
                            <span
                              className="consistency-card__tyre-stat"
                              title={data.deg_slope != null
                                ? `Mean degradation of ${data.deg_fits} fitted stint(s) on this compound; ${FUEL_NOTE}`
                                : `No stint on this compound has ${MIN_FIT_LAPS} or more clean laps: no fit`}
                              // diverging pair with the sign of formatSlope: + orange (losing time), − blue
                              style={{ color: data.deg_slope == null ? undefined : deltaColor(data.deg_slope) }}
                            >
                              Deg: {data.deg_slope != null ? `${formatSlope(data.deg_slope)} s/lap` : 'no fit'}
                            </span>
                            <span className="consistency-card__tyre-stat">
                              {data.count}L, Age {data.avg_tyre_life}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
