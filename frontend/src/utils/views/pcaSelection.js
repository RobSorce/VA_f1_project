/**
 * View model of the lasso analysis panel
 * (components/visualizations/PCAAnalysisPanel.jsx), from the answer of
 * POST /api/pca/analyze-selection (backend data/processors/pca_compute.py
 * analyze_selection): per feature Hedges' g of the selection against the
 * other rows, its 95% normal-approximation interval (none for a group of
 * fewer than statistics.min_group_for_interval rows), the group sizes and the
 * random-selection baseline (|g| that random selections of the same size and
 * the same mix of row kinds reach: during a replay, rows of the race on
 * screen at the clock and rows of finished races) with the threshold a
 * feature must pass to be "above random" (one for every feature post-race;
 * during a replay each feature its own, statistics.threshold_rule
 * 'per_feature'). Every number shown comes from that answer; nothing here is
 * a significance test.
 */

// Shown when an answer carries no statistics block (the backend's label)
export const ANALYSIS_LABEL = 'Descriptive differences, not a test';

const MINUS = '−';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Signed number with a true minus sign and `digits` decimals ('' for null). */
export function fmtSigned(v, digits = 2) {
  const n = num(v);
  if (n == null) return '';
  const s = Math.abs(n).toFixed(digits);
  if (Number(s) === 0) return s;
  return n < 0 ? `${MINUS}${s}` : `+${s}`;
}

/** '[lo, hi]' with signed bounds, or null when the interval is missing. */
export function fmtInterval(lo, hi, digits = 2) {
  if (num(lo) == null || num(hi) == null) return null;
  return `[${fmtSigned(lo, digits)}, ${fmtSigned(hi, digits)}]`;
}

/** A mean with its unit ('%', 's/lap', 'laps', or none). */
export function fmtMean(v, unit) {
  const n = num(v);
  if (n == null) return '';
  const s = n < 0 ? `${MINUS}${Math.abs(n).toFixed(2)}` : n.toFixed(2);
  if (!unit) return s;
  return unit === '%' ? `${s}%` : `${s} ${unit}`;
}

/** Display name of a feature row. */
export function featureLabel(fi) {
  return fi?.label || String(fi?.feature || '').replace(/_/g, ' ');
}

/**
 * Rows of the differences table, in the answer's order (largest |g| first).
 * An answer of the former route (effect_size + direction only) gives g from
 * them and no interval or baseline. threshold = the |g| the row must pass to
 * be "above random" (threshold_abs_g; an answer without it: the one
 * threshold of every feature, statistics.baseline_max_abs_g_p95).
 */
export function selectionRows(analysis) {
  const shared = num(analysis?.statistics?.baseline_max_abs_g_p95);
  return (analysis?.feature_importance || []).map((fi) => {
    let g = num(fi.g);
    if (g == null && num(fi.effect_size) != null) {
      g = fi.direction === 'lower' ? -Math.abs(fi.effect_size) : Math.abs(fi.effect_size);
    }
    return {
      feature: fi.feature,
      label: featureLabel(fi),
      unit: fi.unit || '',
      g,
      absG: g == null ? null : Math.abs(g),
      ciLow: num(fi.ci_low),
      ciHigh: num(fi.ci_high),
      nSelected: num(fi.n_selected),
      nRest: num(fi.n_rest),
      baseline: num(fi.baseline_abs_g),
      baselineP95: num(fi.baseline_abs_g_p95),
      threshold: num(fi.threshold_abs_g) ?? shared,
      exceedsRandom: fi.exceeds_random === true,
      // the feature moves with race progress and the compared rows mix rows
      // of the race on screen at the clock with whole races
      progressDependent: fi.progress_dependent === true,
      selectedMean: num(fi.selected_mean),
      restMean: num(fi.rest_mean),
      direction: fi.direction,
    };
  }).filter((r) => r.g != null);
}

/**
 * The statistics block of an answer, with the counts: label, N of the
 * selection and of the rest, the threshold above which a feature is flagged
 * (95th percentile of the largest |g| over all features in random selections
 * of the same size), whether each feature has its own threshold instead
 * (perFeatureThreshold: rows of two kinds during a replay), and the method
 * strings.
 */
export function selectionStatistics(analysis) {
  const st = analysis?.statistics || {};
  const rows = selectionRows(analysis);
  return {
    label: st.label || ANALYSIS_LABEL,
    nSelected: num(analysis?.n_selected),
    nRest: num(analysis?.n_rest),
    nTotal: num(analysis?.n_total),
    threshold: num(st.baseline_max_abs_g_p95),
    // each feature against its own threshold (rows' threshold), the same
    // quantile level of its own random |g| (thresholdLevel) for every feature
    perFeatureThreshold: st.threshold_rule === 'per_feature',
    thresholdLevel: num(st.threshold_level),
    // the rule in words (the answer's own wording)
    thresholdText: st.threshold || null,
    nFeatures: rows.length,
    nAboveRandom: rows.filter((r) => r.exceedsRandom).length,
    effectSize: st.effect_size || null,
    interval: st.interval || null,
    baseline: st.baseline || null,
    note: st.note || null,
    // e.g. '95% normal-approximation interval of g' (the answer's own wording)
    intervalName: st.interval ? st.interval.split(',')[0] : null,
    // smallest group given an interval (backend MIN_GROUP_FOR_INTERVAL)
    minGroupForInterval: num(st.min_group_for_interval),
    // what the selection is made of and how the baseline was drawn, e.g.
    // 'selection: 3 rows of the race on screen at lap 20, 2 rows of finished
    // races; baseline drawn with the same mix' (the answer's own wording)
    composition: st.composition_text || null,
    // lap of the race on screen's rows (null: no rows at a replay clock)
    asOfLap: num(st.composition?.as_of_lap),
    // why some rows are marked progress-dependent (null when none is)
    progressNote: st.progress_note || null,
  };
}

/**
 * Note of a row whose feature depends on race progress while the compared
 * rows mix rows of the race on screen at the clock with whole races
 * (backend progress_dependent), e.g. 'progress-dependent: lap 20 rows vs
 * whole races'; null for any other row.
 *
 * @param {Object} row - a selectionRows row
 * @param {Object} stats - selectionStatistics(...)
 * @returns {string|null}
 */
export function progressRowNote(row, stats) {
  if (!row?.progressDependent) return null;
  const lap = stats?.asOfLap;
  return lap != null
    ? `progress-dependent: lap ${lap} rows vs whole races`
    : 'progress-dependent: rows at the clock vs whole races';
}

/**
 * Why a row has no interval: a group (the selection or the other rows) below
 * the smallest size given one (statistics.min_group_for_interval: one row has
 * no spread of its own), e.g. 'no interval: 1 selected row'; null when the row
 * has its interval or the answer gives no reason (a former answer).
 *
 * @param {Object} row - a selectionRows row
 * @param {number|null} minGroup - selectionStatistics(...).minGroupForInterval
 * @returns {string|null}
 */
export function missingIntervalNote(row, minGroup) {
  if (!row || (row.ciLow != null && row.ciHigh != null) || minGroup == null) return null;
  const rows = (n) => (n === 1 ? '1' : String(n));
  if (row.nSelected != null && row.nSelected < minGroup) {
    return `no interval: ${rows(row.nSelected)} selected row${row.nSelected === 1 ? '' : 's'}`;
  }
  if (row.nRest != null && row.nRest < minGroup) {
    return `no interval: ${rows(row.nRest)} other row${row.nRest === 1 ? '' : 's'}`;
  }
  return null;
}

/**
 * Half-width of the shared, symmetric g axis of the forest plot: the largest
 * |value| drawn (g, interval bounds, baselines, thresholds), rounded up to
 * the next 0.5.
 */
export function forestHalfWidth(rows, threshold = null) {
  let m = num(threshold) || 0;
  for (const r of rows) {
    for (const v of [r.g, r.ciLow, r.ciHigh, r.baseline, r.baselineP95, r.threshold]) {
      if (v != null) m = Math.max(m, Math.abs(v));
    }
  }
  return Math.max(0.5, Math.ceil(m / 0.5) * 0.5);
}

/** Position (0..width) of a g value on the forest plot axis [-half, +half]. */
export function forestX(v, half, width) {
  const c = Math.max(-half, Math.min(half, v));
  return ((c + half) / (2 * half)) * width;
}

/** Same members, any order. */
export function sameSelection(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((id) => s.has(id));
}

/**
 * What the selected rows of the race on screen are taken at: the answer's
 * current_race (store fetchPCAAnalysis asks at the biplot's clock, backend
 * analyze_selection). A note when the selection holds rows of that race at a
 * replay clock (their features, stints, stops and pit windows stop at that
 * lap), else null (post-race rows, or none of that race).
 *
 * @param {Object|null} analysis
 * @returns {string|null}
 */
export function selectionClockNote(analysis) {
  const cr = analysis?.current_race;
  const n = num(cr?.n_selected);
  if (!cr || cr.as_of !== 'session_now' || !n) return null;
  const rows = n === 1 ? '1 selected row' : `${n} selected rows`;
  return `${rows} of ${cr.year} R${cr.round} as of lap ${cr.as_of_lap} (the replay clock): `
    + 'their stints, stops and pit windows stop there; the other races are whole races.';
}
