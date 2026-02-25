"""
LSTM Training Data Preparation
Builds sliding-window sequences from cached race data across multiple seasons.
Auto-discovers cached rounds from both processed JSON cache and FastF1 raw cache.
"""
import json
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.preprocessing import StandardScaler
import joblib
import logging
import sys
import re

sys.path.insert(0, str(Path(__file__).parent.parent))

from data.extractors.fastf1_extractor import FastF1Extractor
from data.processors.feature_engineering import FeatureEngineer

logger = logging.getLogger(__name__)

SEQUENCE_LEN = 10
PREDICT_LEN = 5
YEARS = list(range(2018, 2026))

LAP_FEATURES = [
    'LapTimeSeconds',
    'Sector1TimeSeconds', 'Sector2TimeSeconds', 'Sector3TimeSeconds',
    'compound_encoded', 'TyreLife',
    'fuel_estimate', 'track_temp',
    'Position', 'GapToLeader', 'gap_ahead', 'drs_available',
]

COMPOUND_MAP = {
    'SOFT': 0, 'MEDIUM': 1, 'HARD': 2,
    'INTERMEDIATE': 3, 'INTER': 3, 'WET': 4,
    'HYPERSOFT': 0, 'ULTRASOFT': 0, 'SUPERSOFT': 0,
    'SUPERHARD': 2,
}


def discover_processed_cache_rounds(cache_dir: Path) -> list:
    """
    Discover race sessions from processed JSON cache files.
    Scans for files matching session_{year}_{round}_R.json.
    Returns list of (year, round_number, 'json') tuples.
    """
    discovered = []
    if not cache_dir.exists():
        return discovered

    pattern = re.compile(r'^session_(\d{4})_(\d+)_R\.json$')
    for f in sorted(cache_dir.iterdir()):
        m = pattern.match(f.name)
        if m:
            year, round_num = int(m.group(1)), int(m.group(2))
            if year in YEARS:
                discovered.append((year, round_num, 'json'))
                logger.info(f"Discovered JSON cache: {year} R{round_num}")

    return discovered


def discover_fastf1_cached_rounds(cache_dir: Path) -> list:
    """
    Auto-discover cached race sessions by scanning the FastF1 cache directory.
    Returns list of (year, round_number, 'fastf1') tuples.
    """
    import fastf1

    discovered = []
    for year in YEARS:
        year_dir = cache_dir / str(year)
        if not year_dir.exists():
            continue

        try:
            schedule = fastf1.get_event_schedule(year)
        except Exception as e:
            logger.warning(f"Could not get schedule for {year}: {e}")
            continue

        for event_dir in sorted(year_dir.iterdir()):
            if not event_dir.is_dir():
                continue

            has_race = False
            for sub in event_dir.iterdir():
                if sub.is_dir() and 'Race' in sub.name:
                    has_race = True
                    break

            if not has_race:
                continue

            folder_name = event_dir.name
            event_name = re.sub(r'^\d{4}-\d{2}-\d{2}_', '', folder_name)
            event_name = event_name.replace('_', ' ')

            for _, row in schedule.iterrows():
                sched_name = str(row.get('EventName', ''))
                if sched_name and sched_name.replace(' ', '') == event_name.replace(' ', ''):
                    round_num = int(row['RoundNumber'])
                    discovered.append((year, round_num, 'fastf1'))
                    logger.info(f"Discovered FastF1 cache: {year} R{round_num} ({sched_name})")
                    break

    return discovered


def discover_all_rounds() -> list:
    """
    Discover all available rounds from both JSON cache and FastF1 raw cache.
    JSON source takes priority (faster to load). Deduplicates by (year, round).
    Returns list of (year, round_number, source) tuples.
    """
    base_dir = Path(__file__).parent.parent / 'data'
    json_cache_dir = base_dir / 'processed_cache'
    fastf1_cache_dir = base_dir / 'cache'

    json_rounds = discover_processed_cache_rounds(json_cache_dir)
    fastf1_rounds = discover_fastf1_cached_rounds(fastf1_cache_dir)

    # JSON takes priority — deduplicate by (year, round)
    seen = set()
    merged = []
    for year, rnd, source in json_rounds:
        seen.add((year, rnd))
        merged.append((year, rnd, source))

    for year, rnd, source in fastf1_rounds:
        if (year, rnd) not in seen:
            seen.add((year, rnd))
            merged.append((year, rnd, source))

    merged.sort(key=lambda x: (x[0], x[1]))

    if not merged:
        logger.warning("No cached races found at all.")

    return merged


def load_features_from_json(cache_dir: Path, year: int, round_num: int) -> pd.DataFrame:
    """
    Load lap features from a processed JSON cache file.
    Returns a DataFrame compatible with the sliding window sequence builder.
    """
    json_path = cache_dir / f'session_{year}_{round_num}_R.json'
    with open(json_path) as f:
        data = json.load(f)

    laps = data.get('lap_times', [])
    if not laps:
        return pd.DataFrame()

    df = pd.DataFrame(laps)

    # Filter to laps that have a valid LapTimeSeconds
    df = df[df['LapTimeSeconds'].notna()].copy()
    if df.empty:
        return df

    total_laps = int(df['LapNumber'].max())

    # Encode compound
    df['compound_encoded'] = df['Compound'].map(COMPOUND_MAP).fillna(1).astype(float)

    # Fuel estimate
    df['fuel_estimate'] = (total_laps - df['LapNumber'] + 1) / total_laps

    # Track temperature from weather data
    avg_track_temp = 30.0
    weather = data.get('weather_data', [])
    if weather:
        temps = [w['TrackTemp'] for w in weather if w.get('TrackTemp') is not None]
        if temps:
            avg_track_temp = sum(temps) / len(temps)
    df['track_temp'] = avg_track_temp

    # DRS
    df['drs_available'] = 0.0

    # GapToLeader — fill NaN with 0
    if 'GapToLeader' not in df.columns:
        df['GapToLeader'] = 0.0
    df['GapToLeader'] = df['GapToLeader'].fillna(0.0)

    # Gap ahead: per-driver diff of GapToLeader
    df['gap_ahead'] = 0.0
    for driver in df['Driver'].unique():
        mask = df['Driver'] == driver
        df.loc[mask, 'gap_ahead'] = df.loc[mask, 'GapToLeader'].diff().fillna(0)

    # Pit detection
    if 'PitInTimeSeconds' in df.columns:
        df['_is_pit'] = df['PitInTimeSeconds'].notna()
    else:
        df['_is_pit'] = False

    return df


def build_sequences_from_df(features_df: pd.DataFrame, all_X: list, all_y: list):
    """
    Build sliding window sequences from a features DataFrame.
    Appends to all_X and all_y in place.
    """
    for driver in features_df['Driver'].unique():
        df = features_df[features_df['Driver'] == driver].sort_values('LapNumber')
        df = df.reset_index(drop=True)

        available = [c for c in LAP_FEATURES if c in df.columns]
        feat_df = df[available].copy()

        feat_df = feat_df.replace([np.inf, -np.inf], np.nan)
        feat_matrix = feat_df.values.astype(np.float64)

        if len(feat_matrix) < SEQUENCE_LEN + PREDICT_LEN:
            continue

        for i in range(len(feat_matrix) - SEQUENCE_LEN - PREDICT_LEN):
            X_seq = feat_matrix[i:i + SEQUENCE_LEN]
            y_window = feat_matrix[i + SEQUENCE_LEN:i + SEQUENCE_LEN + PREDICT_LEN]

            if np.isnan(X_seq).any() or np.isnan(y_window[:, 0]).any():
                continue

            window_laps = df.iloc[i:i + SEQUENCE_LEN + PREDICT_LEN]
            lap_times_in_window = window_laps['LapTimeSeconds'].values if 'LapTimeSeconds' in window_laps.columns else []
            if len(lap_times_in_window) > 0 and (lap_times_in_window > 150).any():
                continue

            input_laps = df.iloc[i:i + SEQUENCE_LEN]
            if '_is_pit' in input_laps.columns and input_laps['_is_pit'].any():
                continue

            y_times = y_window[:, 0]

            next_laps = df.iloc[i + SEQUENCE_LEN:i + SEQUENCE_LEN + PREDICT_LEN]
            pit_prob = 0.0
            if '_is_pit' in next_laps.columns:
                pit_prob = float(next_laps['_is_pit'].any())

            y_vec = np.append(y_times, pit_prob)

            all_X.append(X_seq)
            all_y.append(y_vec)


def prepare_sequences():
    """
    Build (X, y) training data for LSTM across all discovered cached races.

    X: (n_samples, SEQUENCE_LEN, n_features) — past 10 laps
    y: (n_samples, PREDICT_LEN + 1)          — next 5 lap times + pit probability
    """
    base_dir = Path(__file__).parent.parent / 'data'
    json_cache_dir = base_dir / 'processed_cache'

    rounds = discover_all_rounds()
    logger.info(f"Discovered {len(rounds)} race(s) total")

    # Lazy-init FastF1 tools only if needed
    extractor = None
    engineer = None

    all_X, all_y = [], []

    for year, round_num, source in rounds:
        try:
            logger.info(f"Processing {year} R{round_num} (source: {source})")

            if source == 'json':
                features_df = load_features_from_json(json_cache_dir, year, round_num)
                if features_df.empty:
                    continue
                build_sequences_from_df(features_df, all_X, all_y)

            else:
                # FastF1 raw cache path
                if extractor is None:
                    extractor = FastF1Extractor()
                    engineer = FeatureEngineer()

                session = extractor.get_session(year, round_num, "R")
                lap_times = extractor.extract_lap_times(session)
                results = extractor.extract_race_results(session)
                weather = extractor.extract_weather_data(session)

                if lap_times is None or lap_times.empty:
                    continue

                if 'LapTimeSeconds' not in lap_times.columns and 'LapTime' in lap_times.columns:
                    lap_times['LapTimeSeconds'] = lap_times['LapTime'].dt.total_seconds()

                total_laps = int(lap_times['LapNumber'].max())

                if results is not None and 'Abbreviation' in results.columns and 'Driver' not in results.columns:
                    results = results.rename(columns={'Abbreviation': 'Driver'})

                features_df = engineer.prepare_ml_features(lap_times, results, total_laps)

                features_df['compound_encoded'] = features_df['Compound'].apply(engineer.encode_compound)
                features_df['fuel_estimate'] = (total_laps - features_df['LapNumber'] + 1) / total_laps

                avg_track_temp = 30.0
                if weather is not None and not weather.empty and 'TrackTemp' in weather.columns:
                    avg_track_temp = float(weather['TrackTemp'].mean())
                features_df['track_temp'] = avg_track_temp

                features_df['drs_available'] = 0

                features_df['gap_ahead'] = 0.0
                for driver in features_df['Driver'].unique():
                    mask = features_df['Driver'] == driver
                    features_df.loc[mask, 'gap_ahead'] = features_df.loc[mask, 'GapToLeader'].diff().fillna(0)

                if 'PitInTimeSeconds' not in features_df.columns:
                    features_df['_is_pit'] = False
                else:
                    features_df['_is_pit'] = features_df['PitInTimeSeconds'].notna()

                build_sequences_from_df(features_df, all_X, all_y)

        except Exception as e:
            logger.warning(f"Failed to process {year} R{round_num}: {e}")
            import traceback
            traceback.print_exc()
            continue

    if not all_X:
        logger.error("No training sequences generated!")
        return np.array([]), np.array([]), None

    X = np.array(all_X, dtype=np.float32)
    y = np.array(all_y, dtype=np.float32)

    logger.info(f"Raw data: X={X.shape}, y={y.shape}")

    # Fit StandardScaler on X features (flatten sequence dim)
    n_samples, seq_len, n_feat = X.shape
    X_flat = X.reshape(-1, n_feat)
    scaler = StandardScaler()
    X_flat_scaled = scaler.fit_transform(X_flat)
    X = X_flat_scaled.reshape(n_samples, seq_len, n_feat).astype(np.float32)

    # Compute and store y (lap time) statistics for inverse transform at inference
    y_time_mean = float(y[:, :PREDICT_LEN].mean())
    y_time_std = float(y[:, :PREDICT_LEN].std())

    # Normalize y times (first 5 columns), leave pit_prob (last col) as-is
    y_times_norm = (y[:, :PREDICT_LEN] - y_time_mean) / (y_time_std + 1e-8)
    y[:, :PREDICT_LEN] = y_times_norm

    logger.info(f"Prepared LSTM data: X={X.shape}, y={y.shape}")
    logger.info(f"y_time_mean={y_time_mean:.3f}, y_time_std={y_time_std:.3f}")

    return X, y, scaler, y_time_mean, y_time_std


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    result = prepare_sequences()

    if len(result) == 5:
        X, y, scaler, y_time_mean, y_time_std = result
    else:
        print("No data generated!")
        sys.exit(1)

    if X.size == 0:
        print("No training sequences generated!")
        sys.exit(1)

    output_dir = Path(__file__).parent / 'saved'
    output_dir.mkdir(parents=True, exist_ok=True)

    np.save(output_dir / 'lstm_X.npy', X)
    np.save(output_dir / 'lstm_y.npy', y)
    joblib.dump(scaler, output_dir / 'scaler.pkl')

    stats = {'y_time_mean': y_time_mean, 'y_time_std': y_time_std}
    with open(output_dir / 'data_stats.json', 'w') as f:
        json.dump(stats, f)

    print(f"Saved: X={X.shape}, y={y.shape}")
    print(f"Scaler saved to {output_dir / 'scaler.pkl'}")
    print(f"Stats: y_time_mean={y_time_mean:.3f}, y_time_std={y_time_std:.3f}")
