"""
t-SNE Computation Module
Computes 2D embeddings from the feature matrix and saves results.

The heavy sklearn / joblib imports are deferred to ``compute_tsne()`` so
that ``load_embeddings()`` and ``analyze_selection()`` (used at API startup)
never fail due to missing optional dependencies.
"""
import json
import logging
import math
import re
import numpy as np
import pandas as pd
from pathlib import Path
from collections import Counter

logger = logging.getLogger(__name__)

PROCESSED_DIR = Path(__file__).parent.parent / 'processed'
CACHE_DIR = Path(__file__).parent.parent / 'processed_cache'

FEATURE_COLS = [
    'avg_lap_time', 'std_lap_time', 'best_lap_time',
    'avg_sector1', 'avg_sector2', 'avg_sector3',
    'pit_count', 'stint_count', 'avg_stint_length', 'max_stint_length',
    'degradation_rate', 'grid_position',
    # Removed 'finish_position' — data leakage: encodes the race outcome directly
    # Removed 'position_change' — data leakage: derived from finish_position
    # Removed 'fuel_corrected_pace' — always NaN (not available from disk cache)
    'gap_to_leader_mean',
    'rolling_pace_3', 'rolling_pace_5',
    'track_temp', 'air_temp',
]

# Human-readable names and units for features
FEATURE_LABELS = {
    'avg_lap_time': ('Avg Lap Time', 's', 'lower'),
    'std_lap_time': ('Lap Consistency', 's', 'lower'),
    'best_lap_time': ('Best Lap', 's', 'lower'),
    'avg_sector1': ('Sector 1', 's', 'lower'),
    'avg_sector2': ('Sector 2', 's', 'lower'),
    'avg_sector3': ('Sector 3', 's', 'lower'),
    'pit_count': ('Pit Stops', '', None),
    'stint_count': ('Stints', '', None),
    'avg_stint_length': ('Avg Stint Length', 'laps', None),
    'max_stint_length': ('Longest Stint', 'laps', None),
    'degradation_rate': ('Tyre Degradation', '%/lap', None),
    'grid_position': ('Grid Position', '', 'lower'),
    # 'finish_position', 'position_change', 'fuel_corrected_pace' removed (data leakage / always NaN)
    'gap_to_leader_mean': ('Gap to Leader', 's', 'lower'),
    'rolling_pace_3': ('Last 3-Lap Pace', 's', 'lower'),
    'rolling_pace_5': ('Last 5-Lap Pace', 's', 'lower'),
    'track_temp': ('Track Temp', '°C', None),
    'air_temp': ('Air Temp', '°C', None),
}


def build_feature_matrix_from_cache() -> pd.DataFrame:
    """
    Build per-(driver, race) feature vectors from disk-cached session JSONs.
    Reads all session_*_R.json from processed_cache/ — no FastF1 access needed.
    """
    if not CACHE_DIR.exists():
        logger.warning(f"Cache directory not found: {CACHE_DIR}")
        return pd.DataFrame()

    session_files = sorted(CACHE_DIR.glob('session_*_R.json'))
    if not session_files:
        logger.warning("No cached session files found")
        return pd.DataFrame()

    # Load schedule for race names
    schedule_map = {}
    for sched_file in CACHE_DIR.glob('schedule_*.json'):
        try:
            with open(sched_file) as f:
                sched = json.load(f)
            for evt in sched.get('events', []):
                key = (sched.get('year', 0), evt.get('RoundNumber', 0))
                schedule_map[key] = evt.get('EventName', f"Round {evt.get('RoundNumber')}")
        except Exception:
            pass

    rows = []
    for sf in session_files:
        m = re.match(r'session_(\d+)_(\d+)_R\.json', sf.name)
        if not m:
            continue
        year, round_num = int(m.group(1)), int(m.group(2))

        try:
            with open(sf) as f:
                data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed to read {sf.name}: {e}")
            continue

        lap_times = data.get('lap_times', [])
        tyre_strategy = data.get('tyre_strategy', [])
        race_results = data.get('race_results', [])
        weather_data = data.get('weather_data', [])
        driver_info = data.get('driver_info', [])

        if not lap_times:
            continue

        # Build lookup maps
        driver_team = {}
        for di in driver_info:
            abbr = di.get('Abbreviation', '')
            if abbr:
                driver_team[abbr] = di.get('TeamName', 'Unknown')

        result_map = {}
        for r in race_results:
            abbr = r.get('Abbreviation', '')
            if abbr:
                result_map[abbr] = r

        race_name = schedule_map.get((year, round_num), f"Round {round_num}")

        # Weather averages
        avg_track_temp = 30.0
        avg_air_temp = 25.0
        if weather_data:
            temps = [w.get('TrackTemp') for w in weather_data if w.get('TrackTemp') is not None]
            airs = [w.get('AirTemp') for w in weather_data if w.get('AirTemp') is not None]
            if temps:
                avg_track_temp = sum(temps) / len(temps)
            if airs:
                avg_air_temp = sum(airs) / len(airs)

        # Group laps by driver
        driver_laps = {}
        for lt in lap_times:
            drv = lt.get('Driver')
            if not drv:
                continue
            driver_laps.setdefault(drv, []).append(lt)

        # Group strategy by driver
        driver_strats = {}
        for s in tyre_strategy:
            drv = s.get('Driver')
            if drv:
                driver_strats.setdefault(drv, []).append(s)

        for driver, laps in driver_laps.items():
            # Filter valid laps (reasonable times, no pit in/out)
            valid = []
            for lt in laps:
                t = lt.get('LapTimeSeconds')
                if t is None or not isinstance(t, (int, float)):
                    continue
                if math.isnan(t) or t <= 0 or t >= 300:
                    continue
                if lt.get('PitOutTimeSeconds') or lt.get('PitInTimeSeconds'):
                    continue
                valid.append(lt)

            if len(valid) < 5:
                continue

            times = [lt['LapTimeSeconds'] for lt in valid]
            s1 = [lt.get('Sector1TimeSeconds') for lt in valid if lt.get('Sector1TimeSeconds') and lt['Sector1TimeSeconds'] > 0]
            s2 = [lt.get('Sector2TimeSeconds') for lt in valid if lt.get('Sector2TimeSeconds') and lt['Sector2TimeSeconds'] > 0]
            s3 = [lt.get('Sector3TimeSeconds') for lt in valid if lt.get('Sector3TimeSeconds') and lt['Sector3TimeSeconds'] > 0]

            # Strategy features
            stints = driver_strats.get(driver, [])
            pit_count = max(0, len(stints) - 1)
            stint_lengths = [s.get('TotalLaps', 0) for s in stints if s.get('TotalLaps', 0) > 0]

            # Degradation: slope of lap time over tyre life within each stint
            deg_rates = []
            for lt in valid:
                tyre_life = lt.get('TyreLife', 0) or 0
                if tyre_life > 3:
                    deg_rates.append(lt['LapTimeSeconds'])
            deg_rate = 0.0
            if len(deg_rates) > 5:
                # Simple linear regression: lap time vs index
                n = len(deg_rates)
                x_mean = (n - 1) / 2
                y_mean = sum(deg_rates) / n
                num = sum((i - x_mean) * (deg_rates[i] - y_mean) for i in range(n))
                den = sum((i - x_mean) ** 2 for i in range(n))
                if den > 0:
                    slope = num / den
                    deg_rate = slope * 100 / y_mean if y_mean > 0 else 0

            # Position
            res = result_map.get(driver, {})
            grid_pos = res.get('GridPosition')
            finish_pos = res.get('Position')
            if grid_pos is not None and isinstance(grid_pos, (int, float)) and not math.isnan(grid_pos):
                grid_pos = float(grid_pos)
            else:
                grid_pos = float('nan')
            if finish_pos is not None and isinstance(finish_pos, (int, float)) and not math.isnan(finish_pos):
                finish_pos = float(finish_pos)
            else:
                finish_pos = float('nan')

            pos_change = grid_pos - finish_pos if not (math.isnan(grid_pos) or math.isnan(finish_pos)) else 0

            # Gap to leader
            gaps = [lt.get('GapToLeader', 0) or 0 for lt in valid if lt.get('GapToLeader') is not None]
            gap_mean = sum(gaps) / len(gaps) if gaps else 0

            # Rolling pace (last 3 and 5 laps)
            sorted_valid = sorted(valid, key=lambda x: x.get('LapNumber', 0))
            last3 = [lt['LapTimeSeconds'] for lt in sorted_valid[-3:]]
            last5 = [lt['LapTimeSeconds'] for lt in sorted_valid[-5:]]

            row = {
                'driver': driver,
                'team': driver_team.get(driver, 'Unknown'),
                'year': year,
                'round': round_num,
                'race_name': race_name,
                'avg_lap_time': sum(times) / len(times),
                'std_lap_time': (sum((t - sum(times)/len(times))**2 for t in times) / len(times)) ** 0.5,
                'best_lap_time': min(times),
                'avg_sector1': sum(s1) / len(s1) if s1 else float('nan'),
                'avg_sector2': sum(s2) / len(s2) if s2 else float('nan'),
                'avg_sector3': sum(s3) / len(s3) if s3 else float('nan'),
                'pit_count': pit_count,
                'stint_count': len(stint_lengths),
                'avg_stint_length': sum(stint_lengths) / len(stint_lengths) if stint_lengths else 0,
                'max_stint_length': max(stint_lengths) if stint_lengths else 0,
                'degradation_rate': round(deg_rate, 4),
                'grid_position': grid_pos,
                'finish_position': finish_pos,
                'position_change': pos_change,
                'fuel_corrected_pace': float('nan'),  # Not available from cache
                'gap_to_leader_mean': gap_mean,
                'rolling_pace_3': sum(last3) / len(last3) if last3 else float('nan'),
                'rolling_pace_5': sum(last5) / len(last5) if last5 else float('nan'),
                'track_temp': avg_track_temp,
                'air_temp': avg_air_temp,
            }
            rows.append(row)

    df = pd.DataFrame(rows)
    if df.empty:
        logger.warning("No rows built from cache")
        return df

    # Save CSV
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = PROCESSED_DIR / 'tsne_feature_matrix.csv'
    df.to_csv(csv_path, index=False)
    logger.info(f"Built feature matrix from cache: {len(df)} rows → {csv_path}")
    return df


def _ensure_data():
    """Ensure feature matrix and embeddings exist, building from cache if needed."""
    csv_path = PROCESSED_DIR / 'tsne_feature_matrix.csv'
    embed_path = PROCESSED_DIR / 'tsne_embeddings.json'

    if embed_path.exists() and csv_path.exists():
        return True

    # Try building from cache
    if not csv_path.exists():
        logger.info("Feature matrix missing — building from session cache...")
        df = build_feature_matrix_from_cache()
        if df.empty:
            return False

    if not embed_path.exists():
        logger.info("Embeddings missing — computing t-SNE...")
        try:
            compute_tsne()
        except Exception as e:
            logger.error(f"Failed to compute t-SNE: {e}")
            return False

    return embed_path.exists()


def compute_tsne(feature_matrix: pd.DataFrame = None, perplexity: int = 15) -> dict:
    """
    Run StandardScaler + t-SNE on the feature matrix.

    Returns dict with:
    - points: [{id, x, y, driver, team, year, round, race_name}]
    - feature_cols: list of feature column names used
    """
    from sklearn.preprocessing import StandardScaler
    from sklearn.manifold import TSNE
    import joblib

    if feature_matrix is None:
        csv_path = PROCESSED_DIR / 'tsne_feature_matrix.csv'
        if not csv_path.exists():
            raise FileNotFoundError(f"Feature matrix not found at {csv_path}. Run tsne_features.py first.")
        feature_matrix = pd.read_csv(csv_path)

    df = feature_matrix.copy()

    # Select numeric features
    available_cols = [c for c in FEATURE_COLS if c in df.columns]
    X = df[available_cols].copy()

    # Fill NaN with column median
    X = X.fillna(X.median())
    X = X.replace([np.inf, -np.inf], np.nan).fillna(0)

    # Scale
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Save scaler for runtime projection
    scaler_path = PROCESSED_DIR / 'tsne_scaler.pkl'
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(scaler, scaler_path)
    logger.info(f"Saved scaler to {scaler_path}")

    # t-SNE
    actual_perplexity = min(perplexity, len(X_scaled) - 1)
    # sklearn >=1.5 renamed n_iter → max_iter
    import inspect
    tsne_params = inspect.signature(TSNE.__init__).parameters
    iter_key = 'max_iter' if 'max_iter' in tsne_params else 'n_iter'
    tsne = TSNE(
        n_components=2,
        perplexity=max(5, actual_perplexity),
        random_state=42,
        init='pca',
        learning_rate='auto',
        **{iter_key: 1000},
    )
    embeddings = tsne.fit_transform(X_scaled)

    # Build output
    points = []
    for i, row in df.iterrows():
        points.append({
            'id': f"{row['driver']}_{row['year']}_{row['round']}",
            'x': float(embeddings[i, 0]),
            'y': float(embeddings[i, 1]),
            'driver': row['driver'],
            'team': row.get('team', 'Unknown'),
            'year': int(row['year']),
            'round': int(row['round']),
            'race_name': row.get('race_name', f"Round {row['round']}"),
        })

    result = {
        'points': points,
        'feature_cols': available_cols,
        'n_points': len(points),
    }

    # Save embeddings
    output_path = PROCESSED_DIR / 'tsne_embeddings.json'
    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2)
    logger.info(f"Saved t-SNE embeddings to {output_path} ({len(points)} points)")

    return result


def load_embeddings() -> dict:
    """Load pre-computed t-SNE embeddings, auto-building from cache if needed."""
    path = PROCESSED_DIR / 'tsne_embeddings.json'
    if not path.exists():
        # Try to auto-build from cached session data
        if _ensure_data():
            if path.exists():
                with open(path) as f:
                    return json.load(f)
        return None
    with open(path) as f:
        return json.load(f)


def compute_pca(feature_matrix: pd.DataFrame = None) -> dict:
    """
    Run StandardScaler + PCA on the feature matrix.

    Returns dict with:
    - points: [{id, x, y, driver, team, year, round, race_name}]
    - loadings: [{feature, label, pc1, pc2}]  — arrow vectors for biplot
    - explained_variance: [float, float]
    - pc1_label, pc2_label: auto-generated from top loadings
    """
    from sklearn.preprocessing import StandardScaler
    from sklearn.decomposition import PCA

    if feature_matrix is None:
        csv_path = PROCESSED_DIR / 'tsne_feature_matrix.csv'
        if not csv_path.exists():
            raise FileNotFoundError(f"Feature matrix not found at {csv_path}.")
        feature_matrix = pd.read_csv(csv_path)

    df = feature_matrix.copy()
    available_cols = [c for c in FEATURE_COLS if c in df.columns]
    X = df[available_cols].copy()
    X = X.fillna(X.median())
    X = X.replace([np.inf, -np.inf], np.nan).fillna(0)

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    pca = PCA(n_components=2, random_state=42)
    embeddings = pca.fit_transform(X_scaled)

    # Build points (same format as t-SNE)
    points = []
    for i, row in df.iterrows():
        points.append({
            'id': f"{row['driver']}_{row['year']}_{row['round']}",
            'x': float(embeddings[i, 0]),
            'y': float(embeddings[i, 1]),
            'driver': row['driver'],
            'team': row.get('team', 'Unknown'),
            'year': int(row['year']),
            'round': int(row['round']),
            'race_name': row.get('race_name', f"Round {row['round']}"),
        })

    # Loadings: each feature's weight on PC1 and PC2
    loadings = []
    for j, col in enumerate(available_cols):
        label = FEATURE_LABELS.get(col, (col, '', None))[0]
        loadings.append({
            'feature': col,
            'label': label,
            'pc1': float(pca.components_[0, j]),
            'pc2': float(pca.components_[1, j]),
        })

    # Sort by combined magnitude (for picking top arrows)
    loadings.sort(key=lambda l: l['pc1']**2 + l['pc2']**2, reverse=True)

    explained = [float(v) for v in pca.explained_variance_ratio_]

    # Auto-label axes from top loadings
    def _axis_label(component_idx, top_n=3):
        ranked = sorted(loadings, key=lambda l: abs(l[f'pc{component_idx+1}']), reverse=True)
        names = [l['label'] for l in ranked[:top_n]]
        return ' & '.join(names[:2]) if len(names) >= 2 else names[0] if names else f'PC{component_idx+1}'

    pc1_label = _axis_label(0)
    pc2_label = _axis_label(1)

    result = {
        'points': points,
        'loadings': loadings,
        'explained_variance': explained,
        'pc1_label': pc1_label,
        'pc2_label': pc2_label,
        'feature_cols': available_cols,
        'n_points': len(points),
    }

    output_path = PROCESSED_DIR / 'pca_embeddings.json'
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(result, f, indent=2)
    logger.info(f"Saved PCA embeddings to {output_path} ({len(points)} points)")

    return result


def load_pca_embeddings() -> dict:
    """Load pre-computed PCA embeddings, auto-building if needed."""
    path = PROCESSED_DIR / 'pca_embeddings.json'
    if not path.exists():
        # Ensure feature matrix exists
        csv_path = PROCESSED_DIR / 'tsne_feature_matrix.csv'
        if not csv_path.exists():
            if not _ensure_data():
                return None
        # Compute PCA
        try:
            logger.info("PCA embeddings missing — computing PCA...")
            compute_pca()
        except Exception as e:
            logger.error(f"Failed to compute PCA: {e}")
            return None
        if not path.exists():
            return None
    with open(path) as f:
        return json.load(f)


def _load_session_strategy(year: int, round_num: int) -> list:
    """Load tyre_strategy from a disk-cached session file."""
    session_path = CACHE_DIR / f'session_{year}_{round_num}_R.json'
    if not session_path.exists():
        return []
    try:
        with open(session_path) as f:
            data = json.load(f)
        return data.get('tyre_strategy', [])
    except Exception:
        return []


def _describe_effect(feature: str, effect_size: float, direction: str,
                     selected_mean: float, rest_mean: float) -> str:
    """Generate plain-English description of a feature difference."""
    label, unit, better_dir = FEATURE_LABELS.get(feature, (feature, '', None))
    diff = abs(selected_mean - rest_mean)

    if effect_size < 0.3:
        return ''  # Not significant enough to mention

    magnitude = 'slightly' if effect_size < 0.5 else ('notably' if effect_size < 0.8 else 'significantly')

    # Format the difference value
    if unit == 's':
        diff_str = f"{diff:.1f}s"
    elif unit == 'laps':
        diff_str = f"{diff:.0f} laps"
    elif unit == '%/lap':
        diff_str = f"{diff:.2f}%/lap"
    elif unit == '°C':
        diff_str = f"{diff:.1f}°C"
    else:
        diff_str = f"{diff:.1f}"

    # Build description based on what's "good" or "bad"
    if feature in ('avg_lap_time', 'best_lap_time',
                    'rolling_pace_3', 'rolling_pace_5'):
        adj = 'faster' if direction == 'lower' else 'slower'
        return f"{magnitude} {adj} ({diff_str} {direction})"
    elif feature == 'grid_position':
        adj = 'better' if direction == 'lower' else 'worse'
        return f"{magnitude} {adj} grid positions ({diff_str} {direction})"
    elif feature == 'degradation_rate':
        adj = 'higher tyre wear' if direction == 'higher' else 'lower tyre wear'
        return f"{magnitude} {adj} ({diff_str})"
    elif feature in ('gap_to_leader_mean',):
        adj = 'closer to the leader' if direction == 'lower' else 'further from the leader'
        return f"{magnitude} {adj} ({diff_str})"
    elif feature == 'std_lap_time':
        adj = 'more consistent' if direction == 'lower' else 'less consistent'
        return f"{magnitude} {adj} lap times"
    elif feature == 'pit_count':
        adj = 'more' if direction == 'higher' else 'fewer'
        return f"{adj} pit stops ({selected_mean:.1f} vs {rest_mean:.1f} avg)"
    elif feature == 'stint_count':
        adj = 'more' if direction == 'higher' else 'fewer'
        return f"{adj} stints ({selected_mean:.1f} vs {rest_mean:.1f} avg)"
    elif feature in ('avg_stint_length', 'max_stint_length'):
        adj = 'longer' if direction == 'higher' else 'shorter'
        return f"{adj} stints ({diff_str})"
    elif feature in ('avg_sector1', 'avg_sector2', 'avg_sector3'):
        sector_num = feature[-1]
        adj = 'slower' if direction == 'higher' else 'faster'
        return f"{magnitude} {adj} in sector {sector_num} ({diff_str})"
    elif feature in ('track_temp', 'air_temp'):
        adj = 'warmer' if direction == 'higher' else 'cooler'
        return f"{adj} conditions ({diff_str})"
    else:
        return f"{label} {direction} by {diff_str}"


def _generate_summary(feature_importance: list, n_selected: int,
                      strategies: list, common_patterns: list) -> str:
    """Generate natural language summary of the cluster analysis."""
    parts = [f"Cluster of {n_selected} race performances."]

    # Describe top features, skipping duplicate categories
    # (e.g., grid_position and finish_position are both "position")
    FEAT_CATEGORY = {
        'avg_lap_time': 'pace', 'best_lap_time': 'pace',
        'rolling_pace_3': 'pace', 'rolling_pace_5': 'pace',
        'grid_position': 'position',
        'avg_sector1': 'sectors', 'avg_sector2': 'sectors', 'avg_sector3': 'sectors',
        'pit_count': 'stops', 'stint_count': 'stops',
        'avg_stint_length': 'stint_len', 'max_stint_length': 'stint_len',
        'track_temp': 'temp', 'air_temp': 'temp',
    }
    seen_cats = set()
    descriptions = []
    for fi in feature_importance[:8]:
        cat = FEAT_CATEGORY.get(fi['feature'], fi['feature'])
        if cat in seen_cats:
            continue
        desc = _describe_effect(
            fi['feature'], fi['effect_size'], fi['direction'],
            fi['selected_mean'], fi['rest_mean']
        )
        if desc:
            seen_cats.add(cat)
            descriptions.append(desc)
        if len(descriptions) >= 3:
            break

    if descriptions:
        parts.append(f"Compared to all other races: {descriptions[0]}.")
        for d in descriptions[1:]:
            parts.append(f"{d[0].upper()}{d[1:]}.")

    # Top strategy
    if strategies:
        top = strategies[0]
        compounds = ' → '.join(s['compound'] for s in top['stints'])
        pct = int(top['frequency'] * 100)
        stops = len(top['stints']) - 1
        parts.append(f"Most common strategy: {compounds} ({stops}-stop, {pct}% of selected races).")

    return ' '.join(parts)


def _generate_cluster_label(feature_importance: list) -> str:
    """Generate a short 2-3 word cluster label from the top features."""
    if not feature_importance:
        return 'Mixed cluster'

    seen_categories = set()
    labels = []
    for fi in feature_importance[:4]:
        if fi['effect_size'] < 0.3 or len(labels) >= 2:
            break
        feat = fi['feature']
        direction = fi['direction']

        # Determine category to avoid duplicates (e.g. pit_count + stint_count)
        if feat in ('avg_lap_time', 'best_lap_time',
                     'rolling_pace_3', 'rolling_pace_5'):
            cat, label = 'pace', ('Fast pace' if direction == 'lower' else 'Slow pace')
        elif feat == 'grid_position':
            cat, label = 'position', ('Front runners' if direction == 'lower' else 'Back markers')
        elif feat == 'degradation_rate':
            cat, label = 'deg', ('High degradation' if direction == 'higher' else 'Low degradation')
        elif feat in ('pit_count', 'stint_count'):
            cat, label = 'stops', ('Multi-stop' if direction == 'higher' else 'Few stops')
        elif feat == 'std_lap_time':
            cat, label = 'consistency', ('Consistent' if direction == 'lower' else 'Inconsistent')
        elif feat == 'gap_to_leader_mean':
            cat, label = 'gap', ('Close to leader' if direction == 'lower' else 'Far from leader')
        elif feat in ('avg_stint_length', 'max_stint_length'):
            cat, label = 'stint_len', ('Long stints' if direction == 'higher' else 'Short stints')
        elif feat in ('track_temp', 'air_temp'):
            cat, label = 'temp', ('Hot races' if direction == 'higher' else 'Cool races')
        elif feat in ('avg_sector1', 'avg_sector2', 'avg_sector3'):
            cat, label = 'pace', ('Fast sectors' if direction == 'lower' else 'Slow sectors')
        else:
            cat = feat
            label_name = FEATURE_LABELS.get(feat, (feat, '', None))[0]
            label = f"{direction.title()} {label_name.lower()}"

        if cat not in seen_categories:
            seen_categories.add(cat)
            labels.append(label)

    return ', '.join(labels) if labels else 'Mixed cluster'


def analyze_selection(point_ids: list, embeddings: dict = None) -> dict:
    """
    Analyze a selection of t-SNE points using REAL race data.

    Returns:
    - common_patterns: [{compound, avg_stint_length, count, total_laps}]
    - pit_windows: [{lap_start, lap_end, count}]
    - strategies: [{stints: [{compound, lap_start, length}], frequency, count}]
    - feature_importance: [{feature, label, selected_mean, rest_mean, effect_size, direction, magnitude}]
    - summary: natural language description
    - cluster_label: short label
    """
    # Ensure data is available
    _ensure_data()

    if embeddings is None:
        embeddings = load_embeddings()
    if not embeddings:
        return {'error': 'No embeddings available. Load at least one race session first.'}

    # Load feature matrix
    csv_path = PROCESSED_DIR / 'tsne_feature_matrix.csv'
    if not csv_path.exists():
        return {'error': 'Feature matrix not available. Load at least one race session first.'}

    df = pd.read_csv(csv_path)

    # Parse selected point IDs → (driver, year, round)
    selected_keys = []
    for pid in point_ids:
        parts = pid.rsplit('_', 2)
        if len(parts) == 3:
            selected_keys.append((parts[0], int(parts[1]), int(parts[2])))

    # Filter from feature matrix
    selected = []
    for driver, year, round_num in selected_keys:
        match = df[(df['driver'] == driver) & (df['year'] == year) & (df['round'] == round_num)]
        if not match.empty:
            selected.append(match.iloc[0])

    if not selected:
        return {'common_patterns': [], 'pit_windows': [], 'strategies': [],
                'feature_importance': [], 'summary': 'No matching data found.', 'cluster_label': ''}

    sel_df = pd.DataFrame(selected)

    # ── Load REAL tyre strategies from cached sessions ──
    all_stints = []  # flat list of stint dicts
    driver_race_strategies = []  # per (driver, race) strategy sequence
    pit_laps = []  # all pit stop laps

    for driver, year, round_num in selected_keys:
        strategy = _load_session_strategy(year, round_num)
        driver_stints = [s for s in strategy if s.get('Driver') == driver]
        driver_stints.sort(key=lambda s: s.get('StintNumber', 0))

        if driver_stints:
            all_stints.extend(driver_stints)
            # Record strategy sequence (e.g., "SOFT-HARD-MEDIUM")
            seq = [{'compound': s.get('Compound', 'UNKNOWN'),
                     'lap_start': s.get('StartLap', 0),
                     'length': s.get('TotalLaps', 0)} for s in driver_stints]
            driver_race_strategies.append(seq)

            # Pit laps = start laps of stints after the first
            for s in driver_stints[1:]:
                start_lap = s.get('StartLap')
                if start_lap and start_lap > 1:
                    pit_laps.append(int(start_lap))

    # ── Common Patterns: real compound usage ──
    compound_stints = {}
    for s in all_stints:
        compound = s.get('Compound', 'UNKNOWN')
        length = s.get('TotalLaps', 0) or 0
        if compound not in compound_stints:
            compound_stints[compound] = {'lengths': [], 'count': 0}
        compound_stints[compound]['lengths'].append(length)
        compound_stints[compound]['count'] += 1

    common_patterns = []
    for compound in ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET']:
        if compound in compound_stints:
            info = compound_stints[compound]
            avg_len = sum(info['lengths']) / len(info['lengths']) if info['lengths'] else 0
            common_patterns.append({
                'compound': compound,
                'avg_stint_length': round(avg_len, 1),
                'count': info['count'],
                'total_laps': sum(info['lengths']),
            })

    # ── Pit Windows: real pit stop laps with distribution ──
    pit_windows = []
    if pit_laps:
        pit_laps.sort()
        # Group into windows (pit laps within 5 laps of each other)
        windows = []
        current_window = [pit_laps[0]]
        for lap in pit_laps[1:]:
            if lap - current_window[-1] <= 5:
                current_window.append(lap)
            else:
                windows.append(current_window)
                current_window = [lap]
        windows.append(current_window)

        for window in windows:
            pit_windows.append({
                'lap_start': min(window),
                'lap_end': max(window),
                'count': len(window),
                'median_lap': int(np.median(window)),
            })

    # ── Strategies: real compound sequences with frequency ──
    strategy_patterns = Counter()
    strategy_details = {}
    for strat_seq in driver_race_strategies:
        # Create a hashable key from compound sequence
        key = '-'.join(s['compound'] for s in strat_seq)
        strategy_patterns[key] += 1
        if key not in strategy_details:
            strategy_details[key] = strat_seq

    total_strat = sum(strategy_patterns.values())
    strategies = []
    for key, count in strategy_patterns.most_common(5):
        strategies.append({
            'stints': strategy_details[key],
            'frequency': round(count / total_strat, 2) if total_strat > 0 else 0,
            'count': count,
        })

    # ── Feature importance: Cohen's d effect size vs rest of data ──
    available_cols = [c for c in FEATURE_COLS if c in df.columns]
    # Build a boolean mask using (driver, year, round) tuples instead of index
    # because sel_df has a fresh 0-based index that doesn't match df's index
    sel_keys = set(zip(sel_df['driver'], sel_df['year'], sel_df['round']))
    rest_mask = ~pd.Series(
        list(zip(df['driver'], df['year'], df['round']))
    ).apply(lambda x: x in sel_keys).values
    rest_df = df[rest_mask]
    feature_importance = []
    for col in available_cols:
        sel_mean = sel_df[col].mean()
        rest_mean = rest_df[col].mean() if len(rest_df) > 0 else 0

        # Skip features with NaN means
        if pd.isna(sel_mean) or pd.isna(rest_mean):
            continue

        # Use weighted pooled std (Bessel-corrected) for unequal group sizes
        n_sel, n_rest = len(sel_df), len(rest_df)
        if n_rest > 1 and n_sel > 1:
            s1 = sel_df[col].std()**2
            s2 = rest_df[col].std()**2
            pooled_std = np.sqrt(((n_sel - 1) * s1 + (n_rest - 1) * s2) / (n_sel + n_rest - 2))
        else:
            pooled_std = np.sqrt((sel_df[col].std()**2 + rest_df[col].std()**2) / 2) if n_rest > 0 else 1
        if pooled_std == 0 or pd.isna(pooled_std):
            pooled_std = 1
        effect_size = abs(sel_mean - rest_mean) / pooled_std
        if pd.isna(effect_size) or np.isinf(effect_size):
            effect_size = 0

        label, unit, _ = FEATURE_LABELS.get(col, (col, '', None))
        magnitude = 'small' if effect_size < 0.5 else ('medium' if effect_size < 0.8 else 'large')

        feature_importance.append({
            'feature': col,
            'label': label,
            'unit': unit,
            'selected_mean': round(float(sel_mean), 3),
            'rest_mean': round(float(rest_mean), 3),
            'effect_size': round(float(effect_size), 3),
            'direction': 'higher' if sel_mean > rest_mean else 'lower',
            'magnitude': magnitude,
        })
    feature_importance.sort(key=lambda x: x['effect_size'], reverse=True)

    # ── Summary and label ──
    summary = _generate_summary(feature_importance, len(selected), strategies, common_patterns)
    cluster_label = _generate_cluster_label(feature_importance)

    return {
        'common_patterns': common_patterns,
        'pit_windows': pit_windows,
        'strategies': strategies,
        'feature_importance': feature_importance,
        'summary': summary,
        'cluster_label': cluster_label,
        'n_selected': len(selected),
    }


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    # Try building from cache first
    df = build_feature_matrix_from_cache()
    if not df.empty:
        result = compute_tsne(df)
        print(f"Computed {result['n_points']} embeddings from cache")
    else:
        print("No cached data available. Run with FastF1 data instead.")
