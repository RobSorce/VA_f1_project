"""
Cross-race PCA of per-(driver, race) feature vectors built from the cached race
sessions (processed_cache/session_*_R.json), and the analysis of a lasso
selection on the biplot.

- build_feature_matrix_from_cache: one row per (driver, race) from
  race_feature_rows (definitions below) -> processed/pca_feature_matrix.csv.
- compute_pca / load_pca_embeddings: StandardScaler + PCA(2) over every cached
  race -> processed/pca_embeddings.json. Every point is a post-race row
  (``as_of`` = 'post-race').
- pca_embeddings_at(year, round, session_now): the biplot during a replay of
  (year, round). The basis is fitted WITHOUT that race, and its points are its
  rows at session_now (laps completed by then), projected on that basis: no
  value of a current-race point uses a lap after the clock.
- analyze_selection: descriptive differences between the selected rows and the
  rest (Hedges' g, its 95% normal-approximation interval, random-selection
  baseline stratified by row kind: during a replay, rows of the race on
  screen at the clock and whole-race rows of the finished races; with rows of
  both kinds each feature has its own family-wise threshold), the stints and
  the pit windows of the selected rows.
- No t-SNE: the PCA is the one projection (docs/PCA_METHODOLOGY.md, section 2);
  the /api/tsne/... routes of api/main.py are aliases of the PCA routes.

Feature definitions (race_feature_rows). Laps, stints and stops come from the
shared definitions: data/processors/stints.py (R1 stint, R2 pit stop = tyre
change) and data/processors/degradation.py (clean laps, fuel correction,
per-stint fit, consistency sigma), at session_now (inf = post-race).
- Eligible rows: the driver completed at least MIN_LAP_SHARE of the leader's
  completed laps and has at least MIN_CLEAN_LAPS clean laps.
- Pace features are relative to the field of the same race, so that the
  circuit (lap length, weather) does not enter the PCA: for a driver statistic
  s, ``100 * (s / median of s over the race's eligible rows - 1)``, in percent.
    pace_delta_pct        s = mean fuel-corrected time of the clean laps
    best_lap_delta_pct    s = fastest clean lap (raw time)
    recent_pace_delta_pct s = mean fuel-corrected time of the last RECENT_LAPS clean laps
    sector{1,2,3}_delta_pct s = mean sector time over the clean laps (raw)
- consistency_pct: degradation.consistency_sigma (pooled residual sigma of the
  per-stint fits) as a percent of the driver's mean clean lap time.
- degradation_slope: lap-weighted mean of the per-stint TyreLife slopes
  (degradation.stint_fits, fuel-corrected s per lap of tyre age).
- pit_count: R2 pit stops (stints visible at session_now - 1).
- avg_stint_length / max_stint_length: laps of the stints visible at
  session_now (completed laps only).
- grid_position: starting position (a pit-lane start counts as the back of
  the grid).
Race-level constants (track / air temperature) and outcome fields (finishing
position, position change, gap to the leader) are not PCA features; the
finishing position is kept as point metadata for post-race rows only.

sklearn is imported inside the functions that need it, so that importing this
module (API startup) never fails on a missing optional dependency.
"""
import hashlib
import json
import logging
import math
import re
from collections import Counter
from pathlib import Path
from statistics import NormalDist

import numpy as np
import pandas as pd

from data.processors.degradation import (
    _is_lap_completed, _lap_end_time, _normalise_now, clean_stint_laps, consistency_sigma, fuel_corrected_time,
    stint_fits,
)
from data.processors.stints import (
    _dominant_compound, _group_by_driver, _known_compound, _number, build_tyre_strategy,
)

logger = logging.getLogger(__name__)

PROCESSED_DIR = Path(__file__).parent.parent / 'processed'
CACHE_DIR = Path(__file__).parent.parent / 'processed_cache'

MATRIX_FILE = 'pca_feature_matrix.csv'
PCA_FILE = 'pca_embeddings.json'

# A (driver, race) enters the matrix when the driver completed at least this
# share of the race leader's laps (at session_now). ASSUMPTION: 0.9, the share
# of the winner's laps F1 uses to classify a finisher; below it (early
# retirements) the stint and pace features describe a fragment of the race.
MIN_LAP_SHARE = 0.9

# ... and has at least this many clean laps (degradation.clean_stint_laps).
# ASSUMPTION: 5, the minimum of the previous builder.
MIN_CLEAN_LAPS = 5

# Window of the recent-pace feature, in clean laps. ASSUMPTION: 5, the window
# of the previous rolling_pace_5 feature.
RECENT_LAPS = 5

FEATURE_COLS = [
    'pace_delta_pct', 'best_lap_delta_pct', 'recent_pace_delta_pct',
    'sector1_delta_pct', 'sector2_delta_pct', 'sector3_delta_pct',
    'consistency_pct', 'degradation_slope',
    'pit_count', 'avg_stint_length', 'max_stint_length',
    'grid_position',
    # Not features: stint_count (= pit_count + 1, r = 1), track_temp / air_temp
    # (constant within a race: pure race identity), absolute lap / sector times
    # (circuit length), finish_position / position_change / gap_to_leader_mean
    # (race outcome).
]

# Human-readable names, units and the "better" direction of each feature
FEATURE_LABELS = {
    'pace_delta_pct': ('Race Pace vs Field', '%', 'lower'),
    'best_lap_delta_pct': ('Best Lap vs Field', '%', 'lower'),
    'recent_pace_delta_pct': ('Last 5-Lap Pace vs Field', '%', 'lower'),
    'sector1_delta_pct': ('Sector 1 vs Field', '%', 'lower'),
    'sector2_delta_pct': ('Sector 2 vs Field', '%', 'lower'),
    'sector3_delta_pct': ('Sector 3 vs Field', '%', 'lower'),
    'consistency_pct': ('Lap-Time Scatter', '%', 'lower'),
    'degradation_slope': ('Tyre Degradation', 's/lap', None),
    'pit_count': ('Pit Stops', '', None),
    'avg_stint_length': ('Avg Stint Length', 'laps', None),
    'max_stint_length': ('Longest Stint', 'laps', None),
    'grid_position': ('Grid Position', '', 'lower'),
}

# Features that describe the same aspect (one of them per summary / label)
FEATURE_CATEGORY = {
    'pace_delta_pct': 'pace', 'best_lap_delta_pct': 'pace', 'recent_pace_delta_pct': 'pace',
    'sector1_delta_pct': 'sectors', 'sector2_delta_pct': 'sectors', 'sector3_delta_pct': 'sectors',
    'consistency_pct': 'consistency', 'degradation_slope': 'deg',
    'pit_count': 'stops', 'avg_stint_length': 'stint_len', 'max_stint_length': 'stint_len',
    'grid_position': 'position',
}

# Pace statistics normalised to the race median (raw column -> feature)
_RELATIVE = {
    '_pace_s': 'pace_delta_pct',
    '_best_s': 'best_lap_delta_pct',
    '_recent_s': 'recent_pace_delta_pct',
    '_s1_s': 'sector1_delta_pct',
    '_s2_s': 'sector2_delta_pct',
    '_s3_s': 'sector3_delta_pct',
}


# ---------------------------------------------------------------------------
# Feature rows
# ---------------------------------------------------------------------------

def _mean(values):
    vals = [v for v in values if v is not None]
    return sum(vals) / len(vals) if vals else float('nan')


def _pit_out_seconds(lap):
    t = _number(lap.get('PitOutTimeSeconds'))
    return t if t is not None else _number(lap.get('PitOutTime'))


def visible_stints(driver_rows, driver_stints, session_now=math.inf):
    """One driver's stints visible at session_now, with their completed laps.

    driver_stints: build_tyre_strategy rows of the driver over the full rows
    (its split decisions use only earlier rows). Stint 1 is visible from the
    start; a later stint from the PitOutTime of its first row, or, without
    one, once that row is completed (R3, same rule as deriveStints in
    frontend/src/utils/stints.js). EndLap = last completed lap of the stint
    (StartLap - 1 while none), TotalLaps = EndLap - StartLap + 1, Compound =
    most common known compound of the stint's first row and completed laps
    (deriveStints). Each row also carries InLap: the last lap of the previous
    stint (the in-lap, the lap carrying PitInTime) for stints after the
    first, else None.
    """
    now = _normalise_now(session_now)
    by_lap = {}
    for lap in driver_rows:
        n = _number(lap.get('LapNumber'))
        if n is not None:
            by_lap[int(n)] = lap
    out = []
    for i, st in enumerate(driver_stints):
        first = by_lap.get(st['StartLap'])
        if i > 0 and now != math.inf:
            exit_t = _pit_out_seconds(first) if first is not None else None
            visible = exit_t <= now if exit_t is not None and exit_t > 0 else (
                first is not None and _is_lap_completed(first, now))
            if not visible:
                break
        done = [n for n in range(st['StartLap'], st['EndLap'] + 1)
                if n in by_lap and _is_lap_completed(by_lap[n], now)]
        end = done[-1] if done else st['StartLap'] - 1
        known = [by_lap[n] for n in done]
        if first is not None and (not known or known[0] is not first):
            known.insert(0, first)
        out.append({
            'StintNumber': st['StintNumber'],
            'Compound': _dominant_compound(_known_compound(lap.get('Compound')) for lap in known),
            'StartLap': st['StartLap'],
            'EndLap': end,
            'TotalLaps': end - st['StartLap'] + 1,
            'InLap': driver_stints[i - 1]['EndLap'] if i > 0 else None,
        })
    return out


def race_feature_rows(payload, year, round_num, race_name=None, session_now=None, excluded=None):
    """Feature rows of one race at session_now (None / inf = post-race).

    payload: a session_*_R.json dict (lap_times, race_results, driver_info).
    Returns a list of dicts: driver, team, year, round, race_name, the
    FEATURE_COLS, and metadata (laps_completed, race_laps, n_clean_laps,
    as_of_lap, session_now, position at the clock, finish_position for
    post-race rows only). Only eligible rows (module docstring) are returned;
    when ``excluded`` is a list, (driver, reason) of every other driver with
    a completed lap is appended to it (reason 'laps' or 'clean_laps').
    """
    now = _normalise_now(session_now)
    rows = [lap for lap in (payload or {}).get('lap_times') or [] if isinstance(lap, dict) and lap.get('Driver')]
    done = [lap for lap in rows if _is_lap_completed(lap, now) and _number(lap.get('LapNumber')) is not None]
    if not done:
        return []
    race_laps = int(max(_number(lap['LapNumber']) for lap in done))
    grouped = _group_by_driver(rows)
    clean_by_driver = {}
    for st in clean_stint_laps(rows, session_now=now):
        clean_by_driver.setdefault(st['driver'], []).extend(st['laps'])
    fits_by_driver = {}
    for f in stint_fits(rows, session_now=now):
        if f['slope'] is not None:
            fits_by_driver.setdefault(f['driver'], []).append(f)
    stints_by_driver = {}
    for st in build_tyre_strategy(rows):
        stints_by_driver.setdefault(st['Driver'], []).append(st)

    team = {}
    for di in (payload or {}).get('driver_info') or []:
        if di.get('Abbreviation'):
            team[di['Abbreviation']] = di.get('TeamName') or 'Unknown'
    results = {r.get('Abbreviation'): r for r in (payload or {}).get('race_results') or [] if r.get('Abbreviation')}
    n_cars = len(results)

    out = []
    for drv, drows in grouped.items():
        ddone = [lap for lap in drows if _is_lap_completed(lap, now)]
        if not ddone:
            continue
        laps_done = int(_number(ddone[-1]['LapNumber']))
        if laps_done < MIN_LAP_SHARE * race_laps:
            if excluded is not None:
                excluded.append((drv, 'laps'))
            continue
        clean = sorted(clean_by_driver.get(drv, []), key=lambda lap: _number(lap['LapNumber']))
        if len(clean) < MIN_CLEAN_LAPS:
            if excluded is not None:
                excluded.append((drv, 'clean_laps'))
            continue
        fc = [fuel_corrected_time(lap) for lap in clean]
        raw = [_number(lap.get('LapTimeSeconds')) for lap in clean]
        sectors = []
        for k in (1, 2, 3):
            vals = [_number(lap.get(f'Sector{k}TimeSeconds')) for lap in clean]
            sectors.append(_mean(v for v in vals if v is not None and v > 0))
        sigma = consistency_sigma(rows, drv, session_now=now)['sigma']
        fits = fits_by_driver.get(drv, [])
        n_fit = sum(f['n'] for f in fits)
        stints = visible_stints(drows, stints_by_driver.get(drv, []), now)
        lengths = [st['TotalLaps'] for st in stints if st['TotalLaps'] > 0]
        res = results.get(drv, {})
        grid = _number(res.get('GridPosition'))
        if grid is not None and grid <= 0:
            grid = float(n_cars)  # pit-lane start: the back of the grid
        pos = _number(ddone[-1].get('Position'))
        finish = _number(res.get('Position')) if now == math.inf else None
        out.append({
            'driver': drv,
            'team': team.get(drv) or drows[0].get('Team') or 'Unknown',
            'year': int(year),
            'round': int(round_num),
            'race_name': race_name or f'Round {round_num}',
            '_pace_s': _mean(fc),
            '_best_s': min(raw),
            '_recent_s': _mean(fc[-RECENT_LAPS:]),
            '_s1_s': sectors[0],
            '_s2_s': sectors[1],
            '_s3_s': sectors[2],
            'consistency_pct': 100 * sigma / _mean(raw) if sigma is not None else float('nan'),
            'degradation_slope': (sum(f['slope'] * f['n'] for f in fits) / n_fit) if n_fit else float('nan'),
            'pit_count': len(stints) - 1,
            'avg_stint_length': sum(lengths) / len(lengths) if lengths else float('nan'),
            'max_stint_length': max(lengths) if lengths else float('nan'),
            'grid_position': grid if grid is not None else float('nan'),
            'laps_completed': laps_done,
            'race_laps': race_laps,
            'n_clean_laps': len(clean),
            'as_of_lap': race_laps,
            'session_now': None if now == math.inf else float(now),
            'position': pos,
            'finish_position': finish,
        })
    for raw_col, feat in _RELATIVE.items():
        vals = [r[raw_col] for r in out if not math.isnan(r[raw_col])]
        ref = float(np.median(vals)) if vals else float('nan')
        for r in out:
            v = r.pop(raw_col)
            r[feat] = 100 * (v / ref - 1) if ref and not math.isnan(v) and not math.isnan(ref) else float('nan')
    return out


def _schedule_names():
    names = {}
    for sched_file in CACHE_DIR.glob('schedule_*.json'):
        try:
            with open(sched_file, encoding='utf-8') as f:
                sched = json.load(f)
            for evt in sched.get('events', []):
                names[(sched.get('year', 0), evt.get('RoundNumber', 0))] = evt.get(
                    'EventName', f"Round {evt.get('RoundNumber')}")
        except Exception:
            pass
    return names


_payload_cache = {}


def _load_payload(year, round_num):
    """Cached session payload of (year, round), or None. Keeps the last one
    read per (year, round, file mtime)."""
    path = CACHE_DIR / f'session_{int(year)}_{int(round_num)}_R.json'
    if not path.exists():
        return None
    key = (int(year), int(round_num), path.stat().st_mtime)
    if key not in _payload_cache:
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read {path.name}: {e}")
            return None
        if len(_payload_cache) >= 4:
            _payload_cache.pop(next(iter(_payload_cache)))
        _payload_cache[key] = data
    return _payload_cache[key]


def build_feature_matrix_from_cache() -> pd.DataFrame:
    """Post-race feature rows of every cached race (session_*_R.json in
    processed_cache/), saved to processed/pca_feature_matrix.csv."""
    if not CACHE_DIR.exists():
        logger.warning(f"Cache directory not found: {CACHE_DIR}")
        return pd.DataFrame()
    session_files = sorted(CACHE_DIR.glob('session_*_R.json'))
    if not session_files:
        logger.warning("No cached session files found")
        return pd.DataFrame()
    names = _schedule_names()
    rows = []
    for sf in session_files:
        m = re.match(r'session_(\d+)_(\d+)_R\.json', sf.name)
        if not m:
            continue
        year, round_num = int(m.group(1)), int(m.group(2))
        try:
            with open(sf, encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read {sf.name}: {e}")
            continue
        rows.extend(race_feature_rows(data, year, round_num, names.get((year, round_num))))
    df = pd.DataFrame(rows)
    if df.empty:
        logger.warning("No rows built from cache")
        return df
    df = df.sort_values(['year', 'round', 'driver'], kind='stable').reset_index(drop=True)
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = PROCESSED_DIR / MATRIX_FILE
    df.to_csv(csv_path, index=False)
    logger.info(f"Built feature matrix from cache: {len(df)} rows -> {csv_path}")
    return df


def _load_matrix():
    """The post-race feature matrix (built from the cache when missing), or None."""
    csv_path = PROCESSED_DIR / MATRIX_FILE
    if not csv_path.exists():
        logger.info("Feature matrix missing - building from session cache...")
        if build_feature_matrix_from_cache().empty:
            return None
    return pd.read_csv(csv_path)


# ---------------------------------------------------------------------------
# Projections
# ---------------------------------------------------------------------------

def _design(df, cols, medians=None):
    """Numeric design matrix: NaN / inf filled with the column medians (of the
    fit data when ``medians`` is given), then 0."""
    X = df[cols].astype(float).replace([np.inf, -np.inf], np.nan)
    med = X.median() if medians is None else medians
    return X.fillna(med).fillna(0), med


def eta_squared(values, groups):
    """Between-group / total sum of squares of ``values`` grouped by ``groups``
    (1 = constant within every group, 0 = equal group means)."""
    v = np.asarray(values, dtype=float)
    total = float(((v - v.mean()) ** 2).sum())
    if total == 0:
        return 0.0
    means = pd.Series(v).groupby(pd.Series(list(groups)).values).transform('mean').to_numpy()
    return float(((means - v.mean()) ** 2).sum()) / total


def fit_pca(df, reference=None):
    """StandardScaler + PCA(2) on the FEATURE_COLS of ``df``.

    Component signs are arbitrary: with ``reference`` (a list of two component
    vectors over the same columns) each component is flipped to a
    non-negative dot product with it, else so that its largest loading is
    positive.
    """
    from sklearn.decomposition import PCA
    from sklearn.preprocessing import StandardScaler

    cols = [c for c in FEATURE_COLS if c in df.columns]
    X, med = _design(df, cols)
    scaler = StandardScaler().fit(X)
    pca = PCA(n_components=2, random_state=42).fit(scaler.transform(X))
    for k in range(2):
        comp = pca.components_[k]
        if reference is not None and len(reference) > k and len(reference[k]) == len(comp):
            flip = float(np.dot(comp, reference[k])) < 0
        else:
            flip = comp[int(np.argmax(np.abs(comp)))] < 0
        if flip:
            pca.components_[k] = -comp
    return {'cols': cols, 'medians': med, 'scaler': scaler, 'pca': pca}


def _project(df, fit):
    X, _ = _design(df, fit['cols'], fit['medians'])
    return fit['pca'].transform(fit['scaler'].transform(X))


def _opt(v):
    """JSON value of a matrix cell: None for NaN / missing."""
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return float(v)
    return v


def _points(df, emb, as_of):
    points = []
    for i, row in enumerate(df.to_dict('records')):
        fin = _opt(row.get('finish_position'))
        points.append({
            'id': f"{row['driver']}_{int(row['year'])}_{int(row['round'])}",
            'x': float(emb[i, 0]),
            'y': float(emb[i, 1]),
            'driver': row['driver'],
            'team': row.get('team', 'Unknown'),
            'year': int(row['year']),
            'round': int(row['round']),
            'race_name': row.get('race_name', f"Round {row['round']}"),
            'grid_position': _opt(row.get('grid_position')),
            # running position at as_of_lap (post-race: the final running order)
            'position': _opt(row.get('position')),
            # classified finishing position: post-race points only
            'finish_position': int(fin) if fin is not None and as_of == 'post-race' else None,
            'as_of': as_of,
            'as_of_lap': _opt(row.get('as_of_lap')),
        })
    return points


def _loadings(fit):
    loadings = []
    for j, col in enumerate(fit['cols']):
        loadings.append({
            'feature': col,
            'label': FEATURE_LABELS.get(col, (col, '', None))[0],
            'pc1': float(fit['pca'].components_[0, j]),
            'pc2': float(fit['pca'].components_[1, j]),
        })
    loadings.sort(key=lambda l: l['pc1'] ** 2 + l['pc2'] ** 2, reverse=True)
    return loadings


def _axis_label(loadings, k):
    ranked = sorted(loadings, key=lambda l: abs(l[f'pc{k + 1}']), reverse=True)
    names = [l['label'] for l in ranked[:2]]
    return ' & '.join(names) if names else f'PC{k + 1}'


def _embedding_payload(df, fit, points):
    emb = _project(df, fit)
    race = list(zip(df['year'], df['round']))
    loadings = _loadings(fit)
    return {
        'points': points,
        'loadings': loadings,
        'explained_variance': [float(v) for v in fit['pca'].explained_variance_ratio_],
        'eta2_race': [eta_squared(emb[:, k], race) for k in range(2)],
        'pc1_label': _axis_label(loadings, 0),
        'pc2_label': _axis_label(loadings, 1),
        'feature_cols': fit['cols'],
        'n_points': len(points),
        'n_races': len(set(race)),
        'features_as_of': 'post-race',
    }


def compute_pca(feature_matrix: pd.DataFrame = None) -> dict:
    """StandardScaler + PCA(2) over every post-race row; saved to
    processed/pca_embeddings.json.

    Returns {points: [{id, x, y, driver, team, year, round, race_name,
    grid_position, position, finish_position, as_of, as_of_lap}], loadings: [{feature,
    label, pc1, pc2}], explained_variance, eta2_race (share of each PC's
    variance explained by race identity), pc1_label, pc2_label, feature_cols,
    n_points, n_races, features_as_of}.
    """
    df = feature_matrix if feature_matrix is not None else _load_matrix()
    if df is None or df.empty:
        raise FileNotFoundError(f"Feature matrix not found at {PROCESSED_DIR / MATRIX_FILE}.")
    df = df.reset_index(drop=True)
    fit = fit_pca(df)
    result = _embedding_payload(df, fit, _points(df, _project(df, fit), 'post-race'))
    output_path = PROCESSED_DIR / PCA_FILE
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    logger.info(f"Saved PCA embeddings to {output_path} ({len(result['points'])} points)")
    return result


def load_pca_embeddings() -> dict:
    """Pre-computed PCA embeddings, built from the session cache when missing."""
    path = PROCESSED_DIR / PCA_FILE
    if not path.exists():
        try:
            logger.info("PCA embeddings missing - computing PCA...")
            compute_pca()
        except Exception as e:
            logger.error(f"Failed to compute PCA: {e}")
            return None
        if not path.exists():
            return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


_loro_cache = {}


def _fit_without(df, year, round_num, reference):
    """PCA fit on every race except (year, round), cached per matrix content."""
    cols = [c for c in FEATURE_COLS if c in df.columns]
    key = (int(year), int(round_num), len(df),
           int(pd.util.hash_pandas_object(df[['driver', 'year', 'round'] + cols], index=False).sum()))
    if key not in _loro_cache:
        rest = df[~((df['year'] == year) & (df['round'] == round_num))].reset_index(drop=True)
        if len(_loro_cache) >= 8:
            _loro_cache.pop(next(iter(_loro_cache)))
        _loro_cache[key] = (rest, fit_pca(rest, reference))
    return _loro_cache[key]


def current_race_rows(year, round_num, session_now=None):
    """Feature rows of (year, round) at session_now (None = post-race) from the
    cached payload, or None when the race is not cached."""
    payload = _load_payload(year, round_num)
    if payload is None:
        return None
    name = _schedule_names().get((int(year), int(round_num)))
    return pd.DataFrame(race_feature_rows(payload, year, round_num, name, session_now))


def _leader_laps_done(payload, now):
    """The race leader's completed laps at ``now`` (session seconds, inf =
    every lap): the largest LapNumber of a row completed by then, 0 before
    the first."""
    laps = [_number(lap.get('LapNumber')) for lap in (payload or {}).get('lap_times') or []
            if isinstance(lap, dict) and _is_lap_completed(lap, now)]
    laps = [n for n in laps if n is not None]
    return int(max(laps)) if laps else 0


def pca_embeddings_at(year, round_num, session_now=None) -> dict:
    """The biplot during a replay of (year, round) at session_now (session
    seconds; None / inf = post-race).

    The basis (scaler, PCA, fill medians) is fitted on every OTHER race; the
    other races' points are post-race rows (as_of 'post-race'), the points of
    (year, round) are its rows at session_now (as_of 'session_now' while the
    clock is before the end, laps completed by then only; features_as_of
    'mixed'). ``current_race`` describes them: {year, round, available,
    session_now, as_of, as_of_lap (the leader's completed laps), n_points,
    excluded_from_fit, reason}. Falls back to the static embeddings (with
    current_race.available False) when the race is not cached.
    """
    base = load_pca_embeddings()
    df = _load_matrix()
    now = _normalise_now(session_now)
    cur = current_race_rows(year, round_num, None if now == math.inf else now)
    if base is None or df is None or cur is None:
        out = dict(base or {'points': [], 'loadings': [], 'explained_variance': [], 'feature_cols': [], 'n_points': 0})
        out['current_race'] = {'year': year, 'round': round_num, 'available': False,
                               'reason': 'race not in the session cache'}
        return out
    reference = None
    if base.get('loadings'):
        by_feat = {l['feature']: l for l in base['loadings']}
        reference = [[by_feat.get(c, {}).get(f'pc{k + 1}', 0.0) for c in FEATURE_COLS if c in df.columns]
                     for k in range(2)]
    rest, fit = _fit_without(df, year, round_num, reference)
    as_of = 'post-race' if now == math.inf else 'session_now'
    points = _points(rest, _project(rest, fit), 'post-race')
    if not cur.empty:
        points += _points(cur, _project(cur, fit), as_of)
    out = _embedding_payload(rest, fit, points)
    out['n_points'] = len(points)
    # 'mixed': each point's as_of says whether it is a post-race row or a row at session_now
    out['features_as_of'] = as_of if as_of == 'post-race' else 'mixed'
    reason = None
    if cur.empty:
        reason = (f'no driver has {MIN_CLEAN_LAPS} clean laps and {MIN_LAP_SHARE:.0%} of the '
                  "leader's laps yet")
    out['current_race'] = {
        'year': int(year), 'round': int(round_num), 'available': True,
        'session_now': None if now == math.inf else float(now),
        'as_of': as_of,
        # the race leader's completed laps at session_now
        'as_of_lap': _leader_laps_done(_load_payload(year, round_num), now),
        'n_points': int(len(cur)),
        'excluded_from_fit': True,
        'reason': reason,
    }
    return out


# ---------------------------------------------------------------------------
# Selection analysis
# ---------------------------------------------------------------------------

# Seed of the random-selection baseline, so that the same selection always
# gives the same baselines. ASSUMPTION: any fixed value; 20261014 is the date
# the rule was written.
SELECTION_SEED = 20261014

# Smallest group (selected rows, or other rows) that gets an interval of g.
# ASSUMPTION: one row has no spread of its own, so its interval would rest
# entirely on the other rows' spread standing in for it; from 2 rows on the
# interval is given. On random selections (true difference 0) the interval
# excludes 0 about as often as a 95% interval should at every tested size
# from 2 on, while the former percentile bootstrap excluded 0 far more often
# for small groups (scripts/pca_interval_coverage.py ->
# notes/experiments/phase7b/pca_interval_coverage.txt).
MIN_GROUP_FOR_INTERVAL = 2

# Random selections of the same size behind the baseline. ASSUMPTION: 1000.
BASELINE_DRAWS = 1000

# Interval level, and the quantile of the random-selection baseline above
# which a feature is flagged (exceeds_random).
CI_LEVEL = 0.95
BASELINE_QUANTILE = 0.95

# Kinds of rows the analysis compares (column 'as_of' of _analysis_matrix):
# whole-race rows of a finished race, and, during a replay, rows of the race
# on screen computed from the laps completed at the replay clock. The random
# baseline is stratified by kind: each random selection draws as many rows of
# each kind as the selection holds, from the rows of that kind.
ROW_FINISHED = 'post-race'
ROW_LIVE = 'session_now'

# Features whose distribution moves with the laps completed: the counts of
# stops and the laps of stints (they grow with the race), and the tyre
# degradation slope (fitted on short stints early on, so far more spread).
# Rows of the race on screen at the replay clock and whole-race rows differ in
# them whatever the drivers did. These are exactly the features whose rows at
# a quarter, half or three quarters of a race, against the same race's
# post-race rows (same drivers, median over the cached races), move by half a
# matrix SD or more, or have their spread doubled or halved
# (scripts/pca_progress_features.py ->
# notes/experiments/phase7b/pca_progress_features.txt). A row of one of them
# is marked progress_dependent when the compared rows mix the two kinds.
PROGRESS_DEPENDENT_FEATURES = ('degradation_slope', 'pit_count', 'avg_stint_length', 'max_stint_length')

# A |g| equal to the threshold up to floating-point rounding is not above it.
# Ties are common in a stratified baseline: stint lengths of a race in
# progress take few distinct values, so a random selection often has exactly
# the selection's |g|, computed along another arithmetic path. ASSUMPTION:
# 1e-9 relative, far above double rounding and far below any reported digit.
TIE_TOLERANCE = 1e-9

# Family-wise rule of exceeds_random (feature_differences).
# - Rows of one kind (post-race): one threshold for every feature, the
#   BASELINE_QUANTILE of the largest |g| over all features in the random
#   selections (THRESHOLD_MAX).
# - Rows of two kinds (a replay): in random selections with the selection's
#   mix the progress-dependent features reach far larger |g| than the others
#   (the mix alone), so that maximum is theirs and the other features could
#   almost never pass it (notes/experiments/phase7b/verify_r1/v_power.txt).
#   Each feature gets its own threshold instead (THRESHOLD_PER_FEATURE): the
#   same quantile level of its own random |g| for every feature, that level
#   chosen so that a share 1 - BASELINE_QUANTILE of the random selections pass
#   the threshold of some feature (common_level_thresholds: the maximum of
#   per-feature standardised statistics, standardised by ranks, the min-p form
#   of Westfall and Young 1993, Resampling-Based Multiple Testing). Measured
#   in scripts/pca_mixed_threshold.py ->
#   notes/experiments/phase7b/pca_mixed_threshold.txt.
THRESHOLD_MAX = 'max'
THRESHOLD_PER_FEATURE = 'per_feature'

ANALYSIS_LABEL = 'Descriptive differences, not a test'
ANALYSIS_NOTE = (
    'The selection was drawn on a projection of these same features, so large |g| values '
    'are expected by construction. Baseline = |g| of random selections of the same size and '
    'the same mix of row kinds (during a replay: rows of the race on screen at the clock, '
    'rows of finished races); exceeds_random marks a feature whose |g| is above the 95th '
    'percentile of the largest |g| over all features in those random selections. When the '
    'compared rows mix the two kinds, each feature is held to its own threshold instead: the '
    'same high percentile of its own random |g| for every feature, chosen so that 5% of the '
    'random selections pass the threshold of some feature (the progress-dependent features '
    'reach far larger |g| in random selections and would otherwise set the threshold of all).'
)


def _g_from_sums(n1, s1, q1, n2, s2, q2):
    """Hedges' g (group 1 minus group 2) from per-group counts, sums and sums
    of squares (numpy arrays, broadcast). Pooled SD with n1 + n2 - 2 degrees
    of freedom, small-sample factor J = 1 - 3 / (4 df - 1). NaN when a group
    is empty, df < 2 or the pooled SD is 0."""
    with np.errstate(divide='ignore', invalid='ignore'):
        n1 = np.asarray(n1, dtype=float)
        n2 = np.asarray(n2, dtype=float)
        m1 = s1 / n1
        m2 = s2 / n2
        ss1 = np.maximum(q1 - s1 * m1, 0.0)  # sum of squared deviations
        ss2 = np.maximum(q2 - s2 * m2, 0.0)
        df = n1 + n2 - 2
        sp = np.sqrt((ss1 + ss2) / df)
        j = 1 - 3 / (4 * df - 1)
        g = j * (m1 - m2) / sp
        bad = (n1 < 1) | (n2 < 1) | (df < 2) | ~(sp > 1e-12)
        return np.where(bad, np.nan, g)


def hedges_g(x, y):
    """Hedges' g of sample x against sample y (NaN dropped); NaN when undefined."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    x = x[~np.isnan(x)]
    y = y[~np.isnan(y)]
    c = np.concatenate([x, y]).mean() if len(x) + len(y) else 0.0
    x, y = x - c, y - c
    return float(_g_from_sums(len(x), x.sum(), (x * x).sum(), len(y), y.sum(), (y * y).sum()))


def g_standard_error(g, n1, n2):
    """Large-sample standard error of a standardized mean difference g of
    groups of n1 and n2 rows: sqrt((n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)))
    (Hedges and Olkin 1985, Statistical Methods for Meta-Analysis)."""
    return math.sqrt((n1 + n2) / (n1 * n2) + g * g / (2 * (n1 + n2)))


def g_interval(x, y, level=CI_LEVEL, min_group=MIN_GROUP_FOR_INTERVAL):
    """Normal-approximation (large-sample) interval of Hedges' g of x against
    y (NaN dropped):

        g +/- z * sqrt((n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)))

    z the normal quantile of ``level`` (1.96 for 95%), the square root
    g_standard_error (Hedges and Olkin 1985). Not a bootstrap: resampling a
    group of one or two rows gives one or a few distinct values, so a
    bootstrap interval is degenerate exactly for the small selections a click
    or a short lasso makes. (low, high), or (None, None) when g is undefined
    or a group has fewer than ``min_group`` rows (MIN_GROUP_FOR_INTERVAL: one
    row has no spread of its own). Coverage on random selections:
    scripts/pca_interval_coverage.py."""
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    x = x[~np.isnan(x)]
    y = y[~np.isnan(y)]
    if len(x) < max(1, min_group) or len(y) < max(1, min_group):
        return None, None
    g = hedges_g(x, y)
    if math.isnan(g):
        return None, None
    half = NormalDist().inv_cdf(1 - (1 - level) / 2) * g_standard_error(g, len(x), len(y))
    return g - half, g + half


def _above(values, threshold):
    """values > threshold beyond floating-point rounding (TIE_TOLERANCE);
    a NaN value is never above, any number is above a threshold of -inf."""
    t = np.asarray(threshold, dtype=float)
    with np.errstate(invalid='ignore'):
        return np.asarray(values, dtype=float) > t + TIE_TOLERANCE * np.maximum(1.0, t)


def common_level_thresholds(abs_g, rate=1 - BASELINE_QUANTILE):
    """Per-feature thresholds of |g| at one common quantile level, the
    family-wise rule of selections that mix row kinds (THRESHOLD_PER_FEATURE).

    abs_g: |g| of random selections (draws x features, NaN = undefined). For a
    level index i (0 .. draws - 1) the threshold of feature f is the (i + 1)-th
    smallest of its |g| over the draws (NaN counted as the smallest); the
    share of draws passing the threshold of some feature (_above) falls as i
    grows and is 0 at the largest i. Returns (level, thresholds): the smallest
    i whose share is at most ``rate``, as the level (i + 1) / draws, and the
    thresholds there (None for a feature without |g| in that many draws).
    Every feature is held to the same high percentile of its own random |g|:
    one feature whose random |g| is larger (rows of two kinds that differ in
    it by the mix alone) does not raise the threshold of the others, and the
    share of random selections with some feature flagged stays at ``rate``.
    With one feature the threshold is its (1 - rate) quantile."""
    A = np.asarray(abs_g, dtype=float)
    draws = A.shape[0]
    if draws == 0 or A.ndim != 2 or A.shape[1] == 0:
        return None, []
    S = np.sort(np.where(np.isnan(A), -np.inf, A), axis=0)

    def share(i):
        return float(_above(A, S[i]).any(axis=1).mean())

    lo, hi = 0, draws - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if share(mid) <= rate:
            hi = mid
        else:
            lo = mid + 1
    return (lo + 1) / draws, [float(t) if np.isfinite(t) else None for t in S[lo]]


def random_selection_baseline(values, n_selected, draws=BASELINE_DRAWS, seed=SELECTION_SEED,
                              quantile=BASELINE_QUANTILE, strata=None):
    """|g| of ``draws`` random selections against the other rows (seeded),
    per column of ``values`` (rows x features, NaN = missing).

    Without ``strata``: selections of ``n_selected`` rows drawn from all rows.
    With ``strata`` (one label per row) ``n_selected`` is {label: count}: each
    random selection draws ``count`` rows from the rows of each label
    (stratified), so it has the composition of the selection it stands for.
    One label covering every row gives the same draws as no strata.

    Returns {mean: [...], p95: [...], max_p95: float, level: float,
    thresholds: [...]}: the mean and the ``quantile`` of |g| per feature, the
    ``quantile`` of the largest |g| over all features of a draw (family-wise
    threshold, THRESHOLD_MAX), and the common level and per-feature
    thresholds of common_level_thresholds at rate 1 - ``quantile``
    (THRESHOLD_PER_FEATURE)."""
    V = np.asarray(values, dtype=float)
    n_rows, n_feat = V.shape
    rng = np.random.default_rng(seed)
    M = np.zeros((draws, n_rows))
    if strata is None:
        order = np.argsort(rng.random((draws, n_rows)), axis=1)[:, :n_selected]
        np.put_along_axis(M, order, 1.0, axis=1)
    else:
        labels = np.asarray(strata)
        for lab in sorted(n_selected):
            k = int(n_selected[lab])
            pool = np.flatnonzero(labels == lab)
            if k > len(pool):
                raise ValueError(f'{k} rows of kind {lab!r} asked, {len(pool)} available')
            if k <= 0:
                continue
            order = np.argsort(rng.random((draws, len(pool))), axis=1)[:, :k]
            M[np.arange(draws)[:, None], pool[order]] = 1.0
    abs_g = np.full((draws, n_feat), np.nan)
    for f in range(n_feat):
        col = V[:, f]
        w = (~np.isnan(col)).astype(float)
        x = np.where(w > 0, col - np.nanmean(col) if w.any() else 0.0, 0.0)
        n1 = M @ w
        s1 = M @ x
        q1 = M @ (x * x)
        abs_g[:, f] = np.abs(_g_from_sums(n1, s1, q1, w.sum() - n1, x.sum() - s1, (x * x).sum() - q1))
    with np.errstate(all='ignore'):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)
            mean = np.nanmean(abs_g, axis=0)
            p = np.nanquantile(abs_g, quantile, axis=0)
            mx = np.nanmax(abs_g, axis=1)
            max_p = np.nanquantile(mx, quantile) if (~np.isnan(mx)).any() else np.nan
    level, thresholds = common_level_thresholds(abs_g, 1 - quantile)
    return {'mean': [_opt(v) for v in mean], 'p95': [_opt(v) for v in p], 'max_p95': _opt(max_p),
            'level': level, 'thresholds': [_opt(v) for v in thresholds]}


def rows_content_key(values, kinds):
    """Content hash of the rows the analysis compares: their feature values
    in row order (NaN in one canonical form) and their kinds. Two matrices
    with the same number of rows but one different value get different keys
    (the rows of the race on screen change inside one leader lap)."""
    V = np.ascontiguousarray(np.asarray(values, dtype=np.float64))
    V = np.where(np.isnan(V), np.nan, V)
    h = hashlib.sha256()
    h.update(repr(V.shape).encode())
    h.update(V.tobytes())
    h.update('\x1f'.join(str(k) for k in kinds).encode())
    return h.hexdigest()


def baseline_cache_key(values, kinds, n_by_kind):
    """Cache key of a random-selection baseline: the rows' content hash
    (rows_content_key), the selection size, its composition {kind: count}
    and the baseline settings (draws, seed, quantile)."""
    composition = tuple(sorted((str(k), int(v)) for k, v in n_by_kind.items()))
    return (rows_content_key(values, kinds), sum(v for _, v in composition), composition,
            BASELINE_DRAWS, SELECTION_SEED, BASELINE_QUANTILE)


_baseline_cache = {}


def _baseline(values, kinds, n_by_kind):
    """random_selection_baseline of a selection with composition n_by_kind
    ({kind: rows}, stratified by ``kinds``), cached per baseline_cache_key."""
    ck = baseline_cache_key(values, kinds, n_by_kind)
    if ck not in _baseline_cache:
        if len(_baseline_cache) >= 64:
            _baseline_cache.pop(next(iter(_baseline_cache)))
        _baseline_cache[ck] = random_selection_baseline(values, dict(n_by_kind), strata=kinds)
    return _baseline_cache[ck]


_strategy_cache = {}


def _strategy_of_race(year, round_num, session_now=math.inf):
    """{driver: visible_stints rows} of a cached race at session_now (the
    post-race ones are kept per file mtime)."""
    path = CACHE_DIR / f'session_{int(year)}_{int(round_num)}_R.json'
    now = _normalise_now(session_now)
    key = (int(year), int(round_num), path.stat().st_mtime if path.exists() else 0)
    if now == math.inf and key in _strategy_cache:
        return _strategy_cache[key]
    payload = _load_payload(year, round_num)
    if payload is None:
        return {}
    rows = [lap for lap in payload.get('lap_times') or [] if isinstance(lap, dict) and lap.get('Driver')]
    grouped = _group_by_driver(rows)
    by_driver = {}
    for st in build_tyre_strategy(rows):
        by_driver.setdefault(st['Driver'], []).append(st)
    out = {drv: visible_stints(grouped[drv], sts, now) for drv, sts in by_driver.items() if drv in grouped}
    if now == math.inf:
        _strategy_cache[key] = out
    return out


def _describe_effect(feature: str, effect_size: float, direction: str,
                     selected_mean: float, rest_mean: float) -> str:
    """Plain-English description of a feature difference (|g| = effect_size)."""
    label, unit, _ = FEATURE_LABELS.get(feature, (feature, '', None))
    diff = abs(selected_mean - rest_mean)
    magnitude = 'slightly' if effect_size < 0.5 else ('notably' if effect_size < 0.8 else 'much')
    if unit == '%':
        diff_str = f"{diff:.2f}%"
    elif unit == 'laps':
        diff_str = f"{diff:.0f} laps"
    elif unit == 's/lap':
        diff_str = f"{diff:.3f} s/lap"
    else:
        diff_str = f"{diff:.1f}"
    if feature in ('pace_delta_pct', 'best_lap_delta_pct', 'recent_pace_delta_pct'):
        adj = 'faster' if direction == 'lower' else 'slower'
        return f"{magnitude} {adj} relative to their race's field ({label.lower()}, {diff_str})"
    if feature == 'grid_position':
        adj = 'better' if direction == 'lower' else 'worse'
        return f"{magnitude} {adj} grid positions ({selected_mean:.1f} vs {rest_mean:.1f} avg)"
    if feature == 'degradation_slope':
        adj = 'higher tyre degradation' if direction == 'higher' else 'lower tyre degradation'
        return f"{magnitude} {adj} ({diff_str})"
    if feature == 'consistency_pct':
        adj = 'less consistent' if direction == 'higher' else 'more consistent'
        return f"{magnitude} {adj} lap times"
    if feature == 'pit_count':
        adj = 'more' if direction == 'higher' else 'fewer'
        return f"{adj} pit stops ({selected_mean:.1f} vs {rest_mean:.1f} avg)"
    if feature in ('avg_stint_length', 'max_stint_length'):
        adj = 'longer' if direction == 'higher' else 'shorter'
        return f"{adj} stints ({diff_str})"
    if feature in ('sector1_delta_pct', 'sector2_delta_pct', 'sector3_delta_pct'):
        sector_num = feature[6]
        adj = 'slower' if direction == 'higher' else 'faster'
        return f"{magnitude} {adj} in sector {sector_num} relative to the field ({diff_str})"
    return f"{label} {direction} by {diff_str}"


def _generate_summary(feature_importance: list, n_selected: int, n_rest: int,
                      strategies: list, baseline_max: float, current_race: dict = None,
                      stratified: bool = False, threshold_level: float = None,
                      no_alternative: bool = False) -> str:
    """Natural-language summary: only features flagged exceeds_random (a
    progress_dependent one says so); ``stratified``: the random selections
    keep the selection's mix of row kinds; ``threshold_level``: each feature
    was held to that quantile of its own random |g| (THRESHOLD_PER_FEATURE),
    else to ``baseline_max``; ``no_alternative``: every random selection is
    the selection itself (nothing can be above random). With
    ``current_race`` (analyze_selection) taken at a replay clock and selected
    rows of that race, a closing sentence says that their features, stints
    and stops stop at that clock and that the random selections keep the same
    mix of rows."""
    parts = [f"Selection of {n_selected} race entries, compared with the other {n_rest} "
             f"({ANALYSIS_LABEL.lower()})."]
    mix = ' and mix' if stratified else ''
    seen, descriptions = set(), []
    for fi in feature_importance:
        if not fi.get('exceeds_random'):
            continue
        cat = FEATURE_CATEGORY.get(fi['feature'], fi['feature'])
        if cat in seen:
            continue
        seen.add(cat)
        text = _describe_effect(fi['feature'], fi['abs_g'], fi['direction'], fi['selected_mean'], fi['rest_mean'])
        if fi.get('progress_dependent'):
            text += ' (progress-dependent)'
        descriptions.append(text)
        if len(descriptions) >= 3:
            break
    if descriptions:
        parts.append(f"Beyond what random selections of the same size{mix} show: {descriptions[0]}.")
        for d in descriptions[1:]:
            parts.append(f"{d[0].upper()}{d[1:]}.")
    elif no_alternative:
        parts.append(f"No feature can differ more than in random selections of the same size{mix}: every one "
                     f"of them is the selection itself.")
    elif threshold_level is not None:
        parts.append(f"No feature differs more than in random selections of the same size{mix} "
                     f"(each feature against the {threshold_level:.1%} quantile of its own random |g|).")
    elif baseline_max is not None:
        parts.append(f"No feature differs more than in random selections of the same size{mix} "
                     f"(95th percentile of the largest |g|: {baseline_max:.2f}).")
    if strategies:
        top = strategies[0]
        compounds = ' -> '.join(s['compound'] for s in top['stints'])
        pct = int(round(top['frequency'] * 100))
        stops = len(top['stints']) - 1
        parts.append(f"Most common strategy: {compounds} ({stops}-stop, {pct}% of the selection).")
    cr = current_race or {}
    if cr.get('as_of') == 'session_now' and cr.get('n_selected'):
        parts.append(f"The {cr['n_selected']} selected rows of {cr['year']} R{cr['round']} use only the laps "
                     f"completed by lap {cr['as_of_lap']} (the replay clock): their stints and stops end "
                     f"there; the other races are whole races. The random selections of the baseline "
                     f"keep the same mix of rows.")
    return ' '.join(parts)


_CLUSTER_WORDS = {
    'pace': ('Fast pace', 'Slow pace'),
    'sectors': ('Fast sectors', 'Slow sectors'),
    'position': ('Front of grid', 'Back of grid'),
    'consistency': ('Consistent', 'Inconsistent'),
    'stops': ('Few stops', 'Multi-stop'),
    'stint_len': ('Short stints', 'Long stints'),
    'deg': ('Low degradation', 'High degradation'),
}


def _generate_cluster_label(feature_importance: list) -> str:
    """2-3 word label from the features flagged exceeds_random ('Mixed
    cluster' when none)."""
    seen, labels = set(), []
    for fi in feature_importance:
        if not fi.get('exceeds_random') or len(labels) >= 2:
            continue
        cat = FEATURE_CATEGORY.get(fi['feature'], fi['feature'])
        if cat in seen:
            continue
        seen.add(cat)
        low, high = _CLUSTER_WORDS.get(cat, (None, None))
        if low is None:
            name = FEATURE_LABELS.get(fi['feature'], (fi['feature'], '', None))[0]
            labels.append(f"{fi['direction'].title()} {name.lower()}")
        else:
            labels.append(low if fi['direction'] == 'lower' else high)
    return ', '.join(labels) if labels else 'Mixed cluster'


def _analysis_now(year, round_num, session_now):
    """The clock the analysis takes the rows of (year, round) at: inf (post-
    race) without a clock, without a race, or when the race has ended by
    session_now (every row of its lap_times with an end time ended by then:
    its rows are then its whole-race rows, and they are compared as finished
    rows, the same answer as post-race); else session_now."""
    now = _normalise_now(session_now)
    if now == math.inf or year is None or round_num is None:
        return now
    payload = _load_payload(year, round_num)
    ends = [_lap_end_time(lap) for lap in (payload or {}).get('lap_times') or [] if isinstance(lap, dict)]
    ends = [e for e in ends if e is not None]
    return math.inf if ends and max(ends) <= now else now


def _analysis_matrix(year=None, round_num=None, session_now=None):
    """(matrix, content key): the rows the analysis compares. The post-race
    matrix, with the rows of (year, round) replaced by its rows at
    session_now when a finite clock before the race end is given (a replay
    of that race; _analysis_now). Column 'as_of' gives each row's kind:
    ROW_LIVE for the rows of that race at the clock, ROW_FINISHED for
    whole-race rows. The key is rows_content_key of the feature values and
    kinds (it changes when any value changes, e.g. between two clocks inside
    one leader lap). (None, None) without a matrix."""
    df = _load_matrix()
    if df is None:
        return None, None
    now = _analysis_now(year, round_num, session_now)
    cur = None
    if year is not None and round_num is not None and now != math.inf:
        cur = current_race_rows(year, round_num, now)
    if cur is None:
        out = df.assign(as_of=ROW_FINISHED)
    else:
        rest = df[~((df['year'] == int(year)) & (df['round'] == int(round_num)))]
        cols = ['driver', 'team', 'year', 'round', 'race_name'] + [c for c in FEATURE_COLS if c in df.columns]
        parts = [rest[cols].assign(as_of=ROW_FINISHED)]
        if not cur.empty:
            parts.append(cur[cols].astype({c: float for c in cols[5:]}).assign(as_of=ROW_LIVE))
        out = pd.concat(parts, ignore_index=True)
    feat = [c for c in FEATURE_COLS if c in out.columns]
    V = out[feat].astype(float).replace([np.inf, -np.inf], np.nan).to_numpy()
    return out, rows_content_key(V, out['as_of'].tolist())


def _rows(n):
    return f"{n} row{'' if n == 1 else 's'}"


def _composition_text(n_live, n_finished, lap, live_rows_present, no_alternative, rest_live=0):
    """'selection: 3 rows of the race on screen at lap 20, 2 rows of finished
    races; baseline drawn with the same mix' (the statistics block). A
    selection without rows of the race on screen while the other rows hold
    ``rest_live`` of them says so, with the lap: 'selection: 5 rows of
    finished races; the other rows include 19 rows of the race on screen at
    lap 15; baseline drawn with the same mix'."""
    parts = []
    if n_live:
        parts.append(f'{_rows(n_live)} of the race on screen at lap {lap}')
    if n_finished:
        parts.append(f'{_rows(n_finished)} of finished races')
    text = f"selection: {', '.join(parts)}; "
    if not n_live and rest_live:
        text += f'the other rows include {_rows(rest_live)} of the race on screen at lap {lap}; '
    text += 'baseline drawn with the same mix' if live_rows_present else 'baseline drawn from the same rows'
    if no_alternative:
        text += ('; every random selection with this mix is the selection itself, so no feature can be '
                 'above random')
    return text


def feature_differences(df, sel_mask):
    """Per-feature differences of the selected rows (boolean ``sel_mask``)
    of an _analysis_matrix ``df`` from the other rows, against the random
    baseline stratified by row kind (column 'as_of').

    The family-wise rule (threshold_rule): THRESHOLD_MAX while every row is
    of one kind, THRESHOLD_PER_FEATURE when the matrix holds both kinds (the
    module constants say why). Each row carries its threshold_abs_g.

    Returns {feature_importance (the rows of analyze_selection, sorted by
    abs_g), baseline (random_selection_baseline), n_by_kind ({kind: selected
    rows}; ROW_LIVE only when the matrix holds rows at a clock), live
    (boolean mask of the ROW_LIVE rows), no_random_alternative,
    threshold_rule, threshold_level (the common quantile level of
    THRESHOLD_PER_FEATURE, else None)}."""
    cols = [c for c in FEATURE_COLS if c in df.columns]
    V = df[cols].astype(float).replace([np.inf, -np.inf], np.nan).to_numpy()
    kinds = df['as_of'].to_numpy() if 'as_of' in df.columns else np.full(len(df), ROW_FINISHED)
    live = kinds == ROW_LIVE
    # composition of the selection, reproduced by every random selection
    n_by_kind = {ROW_FINISHED: int((sel_mask & ~live).sum())}
    if live.any():
        n_by_kind[ROW_LIVE] = int((sel_mask & live).sum())
    base = _baseline(V, kinds, n_by_kind)
    # every random selection with this composition is the selection itself
    alternatives = 1
    for kind, k in n_by_kind.items():
        alternatives *= math.comb(int((kinds == kind).sum()), k)
    no_alternative = alternatives == 1
    # rows of two kinds: each feature against its own threshold
    per_feature = bool(live.any() and (~live).any())
    rule = THRESHOLD_PER_FEATURE if per_feature else THRESHOLD_MAX
    thresholds = base['thresholds'] if per_feature else [base['max_p95']] * len(cols)
    feature_importance = []
    for j, col in enumerate(cols):
        xs = V[sel_mask, j]
        ys = V[~sel_mask, j]
        xs, ys = xs[~np.isnan(xs)], ys[~np.isnan(ys)]
        if len(xs) == 0 or len(ys) == 0:
            continue
        g = hedges_g(xs, ys)
        if math.isnan(g):
            continue
        lo, hi = g_interval(xs, ys)
        label, unit, _ = FEATURE_LABELS.get(col, (col, '', None))
        abs_g = abs(g)
        p95 = base['p95'][j]
        threshold = thresholds[j]
        has_value = ~np.isnan(V[:, j])
        # rows of a race in progress and of finished races both compared
        mixed = bool((has_value & live).any() and (has_value & ~live).any())
        feature_importance.append({
            'feature': col,
            'label': label,
            'unit': unit,
            'selected_mean': round(float(xs.mean()), 3),
            'rest_mean': round(float(ys.mean()), 3),
            'g': round(g, 3),
            'abs_g': round(abs_g, 3),
            'effect_size': round(abs_g, 3),
            'ci_low': round(lo, 3) if lo is not None else None,
            'ci_high': round(hi, 3) if hi is not None else None,
            'n_selected': int(len(xs)),
            'n_rest': int(len(ys)),
            'baseline_abs_g': round(base['mean'][j], 3) if base['mean'][j] is not None else None,
            'baseline_abs_g_p95': round(p95, 3) if p95 is not None else None,
            # the |g| this feature must pass (the same for every feature under THRESHOLD_MAX)
            'threshold_abs_g': round(threshold, 3) if threshold is not None else None,
            'exceeds_random': bool(not no_alternative and threshold is not None and _above(abs_g, threshold)),
            'progress_dependent': bool(mixed and col in PROGRESS_DEPENDENT_FEATURES),
            'direction': 'higher' if xs.mean() > ys.mean() else 'lower',
            'magnitude': 'small' if abs_g < 0.5 else ('medium' if abs_g < 0.8 else 'large'),
        })
    feature_importance.sort(key=lambda fi: fi['abs_g'], reverse=True)
    return {'feature_importance': feature_importance, 'baseline': base, 'n_by_kind': n_by_kind,
            'live': live, 'no_random_alternative': no_alternative, 'threshold_rule': rule,
            'threshold_level': base['level'] if per_feature else None}


def analyze_selection(point_ids: list, embeddings: dict = None, year=None, round_num=None,
                      session_now=None) -> dict:
    """
    Analyze a lasso selection of biplot points (ids 'DRV_YEAR_ROUND').
    ``embeddings`` is unused (kept for callers of the former signature).

    With year / round / session_now (a replay of that race), the selected and
    the other rows of that race are its rows at session_now, and its stints
    and stops are those visible at session_now; every other race is post-race.
    A clock at or after the race end (_analysis_now) gives the post-race
    answer: the race's rows are then its whole-race rows.

    The random baseline is stratified by row kind (ROW_LIVE: rows of that
    race at the clock, ROW_FINISHED: whole-race rows): each random selection
    draws as many rows of each kind as the selection holds, from the rows of
    that kind, so a difference that comes only from the mix (stints and stops
    of a race in progress against whole races) is in the baseline too. With
    rows of both kinds each feature is held to its own threshold
    (THRESHOLD_PER_FEATURE), else to one threshold for all (THRESHOLD_MAX).

    Returns:
    - feature_importance: [{feature, label, unit, selected_mean, rest_mean, g,
      abs_g, effect_size (= abs_g), ci_low, ci_high, n_selected, n_rest,
      baseline_abs_g, baseline_abs_g_p95, threshold_abs_g, exceeds_random,
      progress_dependent, direction, magnitude}] sorted by abs_g. g = Hedges'
      g (selection minus rest), [ci_low, ci_high] = 95% normal-approximation
      interval (g_interval; None when a group has fewer than
      MIN_GROUP_FOR_INTERVAL rows), baseline_abs_g = mean |g| of random
      selections of the same size and composition, threshold_abs_g = the |g|
      the feature must pass to be exceeds_random, progress_dependent = a
      PROGRESS_DEPENDENT_FEATURES feature while the compared rows (the
      selection, the rest, or the two together) hold both kinds, magnitude =
      Cohen's conventional label of |g| (0.5 / 0.8).
    - statistics: {label, effect_size, interval, min_group_for_interval, baseline,
      baseline_max_abs_g_p95 (the threshold of THRESHOLD_MAX), threshold_rule
      (THRESHOLD_MAX or THRESHOLD_PER_FEATURE), threshold_level (the common
      quantile level of THRESHOLD_PER_FEATURE, else None), threshold (the rule
      in words), composition {selected_live, selected_finished, rest_live,
      rest_finished, as_of_lap (None without rows at a clock), mixed (both
      kinds among the compared rows), no_random_alternative (every random
      selection with this composition is the selection itself)},
      composition_text, progress_dependent_features, progress_note (None when
      no feature is progress_dependent), note}
    - common_patterns, pit_windows (in-laps of R2 stops), strategies
    - summary, cluster_label, n_selected, n_rest, n_total
    - current_race (only with year / round): {year, round, as_of
      ('session_now' for a finite clock before the race end, else
      'post-race'), session_now (the clock asked, None without one),
      as_of_lap (the race leader's completed laps at the clock), n_selected
      (selected rows of that race found)}: what the rows, stints and stops of
      that race are taken at.
    """
    df, _ = _analysis_matrix(year, round_num, session_now)
    if df is None:
        return {'error': 'Feature matrix not available. Load at least one race session first.'}
    asked = _normalise_now(session_now)
    now = _analysis_now(year, round_num, session_now)

    selected_keys = []
    for pid in point_ids or []:
        parts = str(pid).rsplit('_', 2)
        if len(parts) == 3:
            try:
                selected_keys.append((parts[0], int(parts[1]), int(parts[2])))
            except ValueError:
                continue
    sel_set = set(selected_keys)
    row_keys = list(zip(df['driver'], df['year'].astype(int), df['round'].astype(int)))
    sel_mask = np.array([k in sel_set for k in row_keys], dtype=bool)
    n_sel = int(sel_mask.sum())
    current_race = None
    if year is not None and round_num is not None:
        cur_key = (int(year), int(round_num))
        current_race = {
            'year': cur_key[0], 'round': cur_key[1],
            'as_of': 'post-race' if now == math.inf else 'session_now',
            'session_now': None if asked == math.inf else float(asked),
            'as_of_lap': _leader_laps_done(_load_payload(*cur_key), now),
            'n_selected': int(sum(1 for k in set(row_keys) & sel_set if (k[1], k[2]) == cur_key)),
        }
    if n_sel == 0:
        out = {'common_patterns': [], 'pit_windows': [], 'strategies': [], 'feature_importance': [],
               'summary': 'No matching data found.', 'cluster_label': '', 'n_selected': 0,
               'n_rest': int(len(df)), 'n_total': int(len(df))}
        if current_race is not None:
            out['current_race'] = current_race
        return out
    present = set(row_keys)
    sel_keys_found = [k for k in dict.fromkeys(selected_keys) if k in present]

    # ── Stints and R2 pit stops of the selected rows ──
    races = {}
    for driver, y, r in sel_keys_found:
        clock = now if (year is not None and round_num is not None
                        and int(y) == int(year) and int(r) == int(round_num)) else math.inf
        if (y, r, clock) not in races:
            races[(y, r, clock)] = _strategy_of_race(y, r, clock)
    all_stints, driver_race_strategies, pit_laps = [], [], []
    for driver, y, r in sel_keys_found:
        clock = now if (year is not None and round_num is not None
                        and int(y) == int(year) and int(r) == int(round_num)) else math.inf
        stints = [s for s in races[(y, r, clock)].get(driver, []) if s['TotalLaps'] > 0]
        if not stints:
            continue
        all_stints.extend(stints)
        driver_race_strategies.append([{'compound': s['Compound'], 'lap_start': s['StartLap'],
                                        'length': s['TotalLaps']} for s in stints])
        # Pit lap = the in-lap (the lap carrying PitInTime) of each R2 stop
        pit_laps.extend(int(s['InLap']) for s in races[(y, r, clock)].get(driver, []) if s['InLap'])

    compound_stints = {}
    for s in all_stints:
        info = compound_stints.setdefault(s['Compound'], {'lengths': [], 'count': 0})
        info['lengths'].append(s['TotalLaps'])
        info['count'] += 1
    common_patterns = []
    for compound in ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET']:
        if compound in compound_stints:
            info = compound_stints[compound]
            common_patterns.append({
                'compound': compound,
                'avg_stint_length': round(sum(info['lengths']) / len(info['lengths']), 1),
                'count': info['count'],
                'total_laps': sum(info['lengths']),
            })

    pit_windows = []
    if pit_laps:
        pit_laps.sort()
        windows, current = [], [pit_laps[0]]
        for lap in pit_laps[1:]:
            if lap - current[-1] <= 5:
                current.append(lap)
            else:
                windows.append(current)
                current = [lap]
        windows.append(current)
        for window in windows:
            pit_windows.append({'lap_start': min(window), 'lap_end': max(window), 'count': len(window),
                                'median_lap': int(np.median(window))})

    strategy_patterns, strategy_details = Counter(), {}
    for seq in driver_race_strategies:
        k = '-'.join(s['compound'] for s in seq)
        strategy_patterns[k] += 1
        strategy_details.setdefault(k, seq)
    total_strat = sum(strategy_patterns.values())
    strategies = [{'stints': strategy_details[k], 'frequency': round(c / total_strat, 2) if total_strat else 0,
                   'count': c} for k, c in strategy_patterns.most_common(5)]

    # ── Feature differences: Hedges' g, its interval, random baseline ──
    diff = feature_differences(df, sel_mask)
    feature_importance, base, live = diff['feature_importance'], diff['baseline'], diff['live']
    n_by_kind, no_alternative = diff['n_by_kind'], diff['no_random_alternative']
    n_rest = int(len(df) - n_sel)
    baseline_max = base['max_p95']
    n_live = n_by_kind.get(ROW_LIVE, 0)
    n_fin = n_by_kind[ROW_FINISHED]
    lap = current_race['as_of_lap'] if current_race is not None and live.any() else None
    composition = {
        'selected_live': n_live,
        'selected_finished': n_fin,
        'rest_live': int(live.sum()) - n_live,
        'rest_finished': int((~live).sum()) - n_fin,
        'as_of_lap': lap,
        'mixed': bool(live.any() and (~live).any()),
        'no_random_alternative': no_alternative,
    }
    progress = [fi['feature'] for fi in feature_importance if fi['progress_dependent']]
    if live.any():
        baseline_text = (f'|g| of {BASELINE_DRAWS} random selections of {n_sel} rows with the selection\'s mix '
                         f'({n_live} of the race on screen at lap {lap}, {n_fin} of finished races, each drawn '
                         f'from the rows of its kind; seed {SELECTION_SEED}): mean per feature (baseline_abs_g) '
                         f'and {BASELINE_QUANTILE:.0%} quantile (baseline_abs_g_p95)')
    else:
        baseline_text = (f'|g| of {BASELINE_DRAWS} random selections of {n_sel} rows (seed {SELECTION_SEED}): '
                         f'mean per feature (baseline_abs_g) and {BASELINE_QUANTILE:.0%} quantile '
                         f'(baseline_abs_g_p95)')
    level = diff['threshold_level']
    if no_alternative:
        threshold_text = ('above random: not possible, every random selection with this mix is the selection '
                          'itself')
    elif diff['threshold_rule'] == THRESHOLD_PER_FEATURE:
        threshold_text = (f'above random: |g| above the feature\'s own threshold (threshold_abs_g), the '
                          f'{level:.1%} quantile of its random |g|, the same level for every feature, chosen so '
                          f'that {1 - BASELINE_QUANTILE:.0%} of the random selections pass the threshold of some '
                          f'feature (rows of two kinds: the progress-dependent features reach far larger random '
                          f'|g| and would otherwise set the threshold of all)')
    else:
        threshold_text = (f'above random: |g| above {baseline_max:.3f} for every feature, the '
                          f'{BASELINE_QUANTILE:.0%} quantile of the largest |g| over all features in the random '
                          f'selections') if baseline_max is not None else None
    statistics = {
        'label': ANALYSIS_LABEL,
        'effect_size': "Hedges' g: (selection mean - rest mean) / pooled SD x (1 - 3 / (4 df - 1)), df = N - 2",
        'interval': f'{CI_LEVEL:.0%} normal-approximation interval of g, g +/- '
                    f'{NormalDist().inv_cdf(1 - (1 - CI_LEVEL) / 2):.2f} SE, '
                    'SE^2 = (n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2)) (Hedges and Olkin 1985); '
                    f'none when a group has fewer than {MIN_GROUP_FOR_INTERVAL} rows (one row has no '
                    'spread of its own)',
        'min_group_for_interval': MIN_GROUP_FOR_INTERVAL,
        'baseline': baseline_text,
        'baseline_max_abs_g_p95': round(baseline_max, 3) if baseline_max is not None else None,
        'threshold_rule': diff['threshold_rule'],
        'threshold_level': round(level, 4) if level is not None else None,
        'threshold': threshold_text,
        'composition': composition,
        'composition_text': _composition_text(n_live, n_fin, lap, bool(live.any()), no_alternative,
                                              rest_live=composition['rest_live']),
        'progress_dependent_features': progress,
        'progress_note': (
            f"progress-dependent ({', '.join(FEATURE_LABELS[f][0].lower() for f in progress)}): the rows of the "
            f'race on screen use only the laps completed by lap {lap}, those of finished races the whole race, '
            f'so the two kinds differ in these features whatever the drivers did; the random baseline draws '
            f'the same mix, so read these rows against it'
        ) if progress else None,
        'note': ANALYSIS_NOTE,
    }
    out = {
        'common_patterns': common_patterns,
        'pit_windows': pit_windows,
        'strategies': strategies,
        'feature_importance': feature_importance,
        'statistics': statistics,
        'summary': _generate_summary(feature_importance, n_sel, n_rest, strategies, baseline_max, current_race,
                                     stratified=bool(live.any()), threshold_level=level,
                                     no_alternative=no_alternative),
        'cluster_label': _generate_cluster_label(feature_importance),
        'n_selected': n_sel,
        'n_rest': n_rest,
        'n_total': int(len(df)),
    }
    if current_race is not None:
        out['current_race'] = current_race
    return out


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    matrix = build_feature_matrix_from_cache()
    if not matrix.empty:
        pca_result = compute_pca(matrix)
        print(f"Built {len(matrix)} rows; PCA {pca_result['n_points']} points, "
              f"eta2(race) PC1 {pca_result['eta2_race'][0]:.3f}")
    else:
        print("No cached data available.")
