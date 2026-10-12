"""
t-SNE Feature Matrix Builder
Builds per-(driver, race) feature vectors from cached 2024 race data.
"""
import pandas as pd
import numpy as np
from pathlib import Path
import logging
import sys
import json

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from data.extractors.fastf1_extractor import FastF1Extractor
from data.processors.feature_engineering import FeatureEngineer

logger = logging.getLogger(__name__)

CACHED_ROUNDS_2024 = [1, 2, 3, 4, 5, 6, 7, 8]  # Adjust to actual cached rounds


def build_feature_matrix(year: int = 2024, rounds: list = None) -> pd.DataFrame:
    """
    Build per-(driver, race) feature vectors for t-SNE embedding.

    Returns DataFrame with columns:
    - driver, team, year, round, race_name
    - avg_lap_time, std_lap_time, best_lap_time
    - avg_sector1, avg_sector2, avg_sector3
    - pit_count, stint_count
    - stint_lengths (list encoded as mean/max)
    - degradation_rate_mean
    - grid_position, finish_position, position_change
    - fuel_corrected_pace_mean, gap_to_leader_mean
    - rolling_pace_3, rolling_pace_5
    """
    if rounds is None:
        rounds = CACHED_ROUNDS_2024

    extractor = FastF1Extractor()
    engineer = FeatureEngineer()
    rows = []

    for round_num in rounds:
        try:
            logger.info(f"Processing {year} round {round_num}")
            session = extractor.get_session(year, round_num, "R")
            lap_times = extractor.extract_lap_times(session)
            results = extractor.extract_race_results(session)
            strategy = extractor.extract_tyre_strategy(session)
            weather = extractor.extract_weather_data(session)
            driver_info = extractor.extract_driver_info(session)

            if lap_times is None or lap_times.empty:
                continue

            # Ensure LapTimeSeconds
            if 'LapTimeSeconds' not in lap_times.columns and 'LapTime' in lap_times.columns:
                lap_times['LapTimeSeconds'] = lap_times['LapTime'].dt.total_seconds()

            total_laps = int(lap_times['LapNumber'].max())
            features_df = engineer.prepare_ml_features(lap_times, results, total_laps)
            degradation = engineer.calculate_tyre_degradation(lap_times)

            # Build driver info map
            driver_team_map = {}
            if driver_info is not None and not driver_info.empty:
                for _, di in driver_info.iterrows():
                    abbr = di.get('Abbreviation', di.get('Driver', ''))
                    driver_team_map[abbr] = di.get('TeamName', 'Unknown')

            race_name = session.event['EventName'] if hasattr(session, 'event') else f"Round {round_num}"

            for driver in features_df['Driver'].unique():
                df = features_df[features_df['Driver'] == driver]
                valid = df[df['LapTimeSeconds'].notna() & (df['LapTimeSeconds'] > 0) & (df['LapTimeSeconds'] < 300)]

                if valid.empty or len(valid) < 5:
                    continue

                # Strategy features
                driver_strats = strategy[strategy['Driver'] == driver] if strategy is not None and not strategy.empty else pd.DataFrame()
                pit_count = max(0, len(driver_strats) - 1) if not driver_strats.empty else 0

                stint_lengths = []
                if not driver_strats.empty:
                    for _, s in driver_strats.iterrows():
                        sl = s.get('TotalLaps', s.get('StintLength', s.get('Stint_Length', 0)))
                        if pd.notna(sl) and sl > 0:
                            stint_lengths.append(float(sl))

                # Degradation
                driver_deg = degradation[degradation['Driver'] == driver] if not degradation.empty else pd.DataFrame()
                deg_rate = driver_deg['DegradationRate'].mean() if not driver_deg.empty else 0.0

                # Position
                driver_col = 'Abbreviation' if 'Abbreviation' in results.columns else 'Driver'
                driver_results = results[results[driver_col] == driver] if results is not None and not results.empty else pd.DataFrame()
                grid_pos = float(driver_results['GridPosition'].iloc[0]) if not driver_results.empty and 'GridPosition' in driver_results.columns else np.nan
                finish_pos = float(driver_results['Position'].iloc[0]) if not driver_results.empty and 'Position' in driver_results.columns else np.nan

                # Weather
                avg_track_temp = weather['TrackTemp'].mean() if weather is not None and not weather.empty and 'TrackTemp' in weather.columns else 30.0
                avg_air_temp = weather['AirTemp'].mean() if weather is not None and not weather.empty and 'AirTemp' in weather.columns else 25.0

                row = {
                    'driver': driver,
                    'team': driver_team_map.get(driver, 'Unknown'),
                    'year': year,
                    'round': round_num,
                    'race_name': race_name,
                    'avg_lap_time': valid['LapTimeSeconds'].mean(),
                    'std_lap_time': valid['LapTimeSeconds'].std(),
                    'best_lap_time': valid['LapTimeSeconds'].min(),
                    'avg_sector1': valid['Sector1TimeSeconds'].mean() if 'Sector1TimeSeconds' in valid.columns else np.nan,
                    'avg_sector2': valid['Sector2TimeSeconds'].mean() if 'Sector2TimeSeconds' in valid.columns else np.nan,
                    'avg_sector3': valid['Sector3TimeSeconds'].mean() if 'Sector3TimeSeconds' in valid.columns else np.nan,
                    'pit_count': pit_count,
                    'stint_count': len(stint_lengths),
                    'avg_stint_length': np.mean(stint_lengths) if stint_lengths else 0,
                    'max_stint_length': max(stint_lengths) if stint_lengths else 0,
                    'degradation_rate': deg_rate if pd.notna(deg_rate) else 0.0,
                    'grid_position': grid_pos,
                    'finish_position': finish_pos,
                    'position_change': grid_pos - finish_pos if pd.notna(grid_pos) and pd.notna(finish_pos) else 0,
                    'fuel_corrected_pace': valid['FuelCorrectedLapTime'].mean() if 'FuelCorrectedLapTime' in valid.columns else np.nan,
                    'gap_to_leader_mean': valid['GapToLeader'].mean() if 'GapToLeader' in valid.columns else np.nan,
                    'rolling_pace_3': valid['Pace_Last3Laps'].mean() if 'Pace_Last3Laps' in valid.columns else np.nan,
                    'rolling_pace_5': valid['Pace_Last5Laps'].mean() if 'Pace_Last5Laps' in valid.columns else np.nan,
                    'track_temp': avg_track_temp,
                    'air_temp': avg_air_temp,
                }
                rows.append(row)

        except Exception as e:
            logger.warning(f"Failed to process {year} round {round_num}: {e}")
            continue

    df = pd.DataFrame(rows)
    logger.info(f"Built feature matrix: {len(df)} rows x {len(df.columns)} features")
    return df


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    df = build_feature_matrix()
    output_path = Path(__file__).parent.parent / 'processed' / 'tsne_feature_matrix.csv'
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    print(f"Saved feature matrix to {output_path}: {df.shape}")
