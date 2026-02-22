"""
LSTM Training Data Preparation
Builds sliding-window sequences from cached race data across multiple seasons.
Auto-discovers cached rounds by scanning the FastF1 cache directory.
"""
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
YEARS = [2023, 2024, 2025]

LAP_FEATURES = [
    'LapTimeSeconds',
    'Sector1TimeSeconds', 'Sector2TimeSeconds', 'Sector3TimeSeconds',
    'compound_encoded', 'TyreLife',
    'fuel_estimate', 'track_temp',
    'Position', 'GapToLeader', 'gap_ahead', 'drs_available',
]


def discover_cached_rounds(cache_dir: Path) -> list:
    """
    Auto-discover cached race sessions by scanning the FastF1 cache directory.
    Returns list of (year, round_number) tuples.
    """
    import fastf1

    discovered = []
    for year in YEARS:
        year_dir = cache_dir / str(year)
        if not year_dir.exists():
            continue

        # Get event schedule to map folder names to round numbers
        try:
            schedule = fastf1.get_event_schedule(year)
        except Exception as e:
            logger.warning(f"Could not get schedule for {year}: {e}")
            continue

        for event_dir in sorted(year_dir.iterdir()):
            if not event_dir.is_dir():
                continue

            # Check if this event folder contains a Race session
            has_race = False
            for sub in event_dir.iterdir():
                if sub.is_dir() and 'Race' in sub.name:
                    has_race = True
                    break

            if not has_race:
                continue

            # Extract event name from folder: "YYYY-MM-DD_Event_Name"
            folder_name = event_dir.name
            # Remove date prefix
            event_name = re.sub(r'^\d{4}-\d{2}-\d{2}_', '', folder_name)
            event_name = event_name.replace('_', ' ')

            # Match against schedule
            for _, row in schedule.iterrows():
                sched_name = str(row.get('EventName', ''))
                if sched_name and sched_name.replace(' ', '') == event_name.replace(' ', ''):
                    round_num = int(row['RoundNumber'])
                    discovered.append((year, round_num))
                    logger.info(f"Discovered cached race: {year} R{round_num} ({sched_name})")
                    break

    if not discovered:
        logger.warning("No cached races found. Falling back to 2024 rounds 1-8.")
        discovered = [(2024, r) for r in range(1, 9)]

    return discovered


def prepare_sequences():
    """
    Build (X, y) training data for LSTM across all discovered cached races.

    X: (n_samples, SEQUENCE_LEN, n_features) — past 10 laps
    y: (n_samples, PREDICT_LEN + 1)          — next 5 lap times + pit probability
    """
    extractor = FastF1Extractor()
    engineer = FeatureEngineer()

    cache_dir = Path(__file__).parent.parent / 'data' / 'cache'
    rounds = discover_cached_rounds(cache_dir)
    logger.info(f"Processing {len(rounds)} cached race(s)")

    all_X, all_y = [], []

    for year, round_num in rounds:
        try:
            logger.info(f"Processing {year} round {round_num}")
            session = extractor.get_session(year, round_num, "R")
            lap_times = extractor.extract_lap_times(session)
            results = extractor.extract_race_results(session)
            weather = extractor.extract_weather_data(session)

            if lap_times is None or lap_times.empty:
                continue

            # Ensure LapTimeSeconds
            if 'LapTimeSeconds' not in lap_times.columns and 'LapTime' in lap_times.columns:
                lap_times['LapTimeSeconds'] = lap_times['LapTime'].dt.total_seconds()

            total_laps = int(lap_times['LapNumber'].max())

            # Normalize results columns: FastF1 uses 'Abbreviation' not 'Driver'
            if results is not None and 'Abbreviation' in results.columns and 'Driver' not in results.columns:
                results = results.rename(columns={'Abbreviation': 'Driver'})

            features_df = engineer.prepare_ml_features(lap_times, results, total_laps)

            # Encode compound
            features_df['compound_encoded'] = features_df['Compound'].apply(engineer.encode_compound)

            # Fuel estimate
            features_df['fuel_estimate'] = (total_laps - features_df['LapNumber'] + 1) / total_laps

            # Weather
            avg_track_temp = 30.0
            if weather is not None and not weather.empty and 'TrackTemp' in weather.columns:
                avg_track_temp = float(weather['TrackTemp'].mean())
            features_df['track_temp'] = avg_track_temp

            # DRS
            features_df['drs_available'] = 0

            # Gap ahead
            features_df['gap_ahead'] = 0.0
            for driver in features_df['Driver'].unique():
                mask = features_df['Driver'] == driver
                features_df.loc[mask, 'gap_ahead'] = features_df.loc[mask, 'GapToLeader'].diff().fillna(0)

            # Detect pit/SC laps for filtering
            if 'PitInTimeSeconds' not in features_df.columns:
                features_df['_is_pit'] = False
            else:
                features_df['_is_pit'] = features_df['PitInTimeSeconds'].notna()

            # Build sequences per driver
            for driver in features_df['Driver'].unique():
                df = features_df[features_df['Driver'] == driver].sort_values('LapNumber')
                df = df.reset_index(drop=True)

                # Select features
                available = [c for c in LAP_FEATURES if c in df.columns]
                feat_df = df[available].copy()

                # Replace inf with NaN
                feat_df = feat_df.replace([np.inf, -np.inf], np.nan)
                feat_matrix = feat_df.values.astype(np.float64)

                if len(feat_matrix) < SEQUENCE_LEN + PREDICT_LEN:
                    continue

                # Sliding window — skip sequences containing bad laps
                for i in range(len(feat_matrix) - SEQUENCE_LEN - PREDICT_LEN):
                    X_seq = feat_matrix[i:i + SEQUENCE_LEN]
                    y_window = feat_matrix[i + SEQUENCE_LEN:i + SEQUENCE_LEN + PREDICT_LEN]

                    # Drop sequences with any NaN
                    if np.isnan(X_seq).any() or np.isnan(y_window[:, 0]).any():
                        continue

                    # Filter out pit laps and anomalous laps (> 150s)
                    window_laps = df.iloc[i:i + SEQUENCE_LEN + PREDICT_LEN]
                    lap_times_in_window = window_laps['LapTimeSeconds'].values if 'LapTimeSeconds' in window_laps.columns else []
                    if len(lap_times_in_window) > 0 and (lap_times_in_window > 150).any():
                        continue

                    # Check for pit laps in input sequence
                    input_laps = df.iloc[i:i + SEQUENCE_LEN]
                    if '_is_pit' in input_laps.columns and input_laps['_is_pit'].any():
                        continue

                    y_times = y_window[:, 0]  # LapTimeSeconds column

                    # Pit probability: did a pit stop happen in next 5 laps?
                    next_laps = df.iloc[i + SEQUENCE_LEN:i + SEQUENCE_LEN + PREDICT_LEN]
                    pit_prob = 0.0
                    if '_is_pit' in next_laps.columns:
                        pit_prob = float(next_laps['_is_pit'].any())

                    y_vec = np.append(y_times, pit_prob)

                    all_X.append(X_seq)
                    all_y.append(y_vec)

        except Exception as e:
            logger.warning(f"Failed to process {year} round {round_num}: {e}")
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

    # Save y stats in a JSON-friendly format (also used by train.py for model_config)
    import json
    stats = {'y_time_mean': y_time_mean, 'y_time_std': y_time_std}
    with open(output_dir / 'data_stats.json', 'w') as f:
        json.dump(stats, f)

    print(f"Saved: X={X.shape}, y={y.shape}")
    print(f"Scaler saved to {output_dir / 'scaler.pkl'}")
    print(f"Stats: y_time_mean={y_time_mean:.3f}, y_time_std={y_time_std:.3f}")
