"""
Feature Engineering Module
Per-lap derived metrics for the lap-time forecast model (model/prepare_data.py).

The cross-race PCA features (biplot) are built by
data/processors/pca_compute.py (race_feature_rows), not here.
"""
import pandas as pd
import numpy as np
from typing import Dict, Any, Optional, Tuple
import logging

logger = logging.getLogger(__name__)


class FeatureEngineer:
    """Generate engineered features for F1 data analysis and ML models."""
    
    def calculate_fuel_corrected_pace(self, lap_times: pd.DataFrame, 
                                       total_laps: int,
                                       fuel_effect_per_lap: float = 0.055) -> pd.DataFrame:
        """
        Calculate fuel-corrected lap times.
        
        F1 cars lose approximately 0.055s per lap as fuel burns off (~110kg over ~50 laps).
        """
        df = lap_times.copy()
        
        if 'LapTimeSeconds' not in df.columns:
            return df
        
        # Estimate fuel load (full at lap 1, empty at final lap)
        df['EstimatedFuelLaps'] = total_laps - df['LapNumber'] + 1
        df['FuelCorrectionSeconds'] = df['EstimatedFuelLaps'] * fuel_effect_per_lap
        df['FuelCorrectedLapTime'] = df['LapTimeSeconds'] - df['FuelCorrectionSeconds']
        
        return df
    
    def calculate_gap_to_leader(self, lap_times: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate cumulative gap to race leader at each lap.
        """
        df = lap_times.copy()
        
        if 'LapTimeSeconds' not in df.columns:
            return df
        
        # Calculate cumulative race time per driver
        df['CumulativeTime'] = df.groupby('Driver')['LapTimeSeconds'].cumsum()
        
        # Find leader's time at each lap
        leader_times = df.groupby('LapNumber')['CumulativeTime'].min().reset_index()
        leader_times.columns = ['LapNumber', 'LeaderCumulativeTime']
        
        df = df.merge(leader_times, on='LapNumber', how='left')
        df['GapToLeader'] = df['CumulativeTime'] - df['LeaderCumulativeTime']
        
        return df
    
    def calculate_sector_performance(self, lap_times: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate sector performance indices relative to session best.
        """
        df = lap_times.copy()
        
        sector_cols = ['Sector1TimeSeconds', 'Sector2TimeSeconds', 'Sector3TimeSeconds']
        
        for col in sector_cols:
            if col in df.columns:
                session_best = df[col].min()
                df[f'{col.replace("Seconds", "")}Delta'] = df[col] - session_best
        
        return df
    
    def calculate_pit_stop_metrics(self, lap_times: pd.DataFrame) -> pd.DataFrame:
        """
        Extract pit stop information and calculate pit delta.
        """
        df = lap_times.copy()
        
        # Identify pit laps (where pit out time or pit in time exists)
        pit_cols = ['PitOutTimeSeconds', 'PitInTimeSeconds']
        existing_pit_cols = [c for c in pit_cols if c in df.columns]

        if existing_pit_cols:
            df['IsPitLap'] = df[existing_pit_cols].notna().any(axis=1)
            
            # Calculate pit delta (time lost vs normal lap)
            if 'IsPitLap' in df.columns:
                normal_lap_mean = df[~df['IsPitLap']].groupby('Driver')['LapTimeSeconds'].mean()
                df['PitDelta'] = df.apply(
                    lambda x: x['LapTimeSeconds'] - normal_lap_mean.get(x['Driver'], x['LapTimeSeconds'])
                    if x.get('IsPitLap', False) else 0,
                    axis=1
                )
        
        return df
    
    def calculate_recent_pace(self, lap_times: pd.DataFrame, 
                               window_sizes: list = [3, 5, 10]) -> pd.DataFrame:
        """
        Calculate rolling average pace for recent laps.
        """
        df = lap_times.copy()
        
        if 'LapTimeSeconds' not in df.columns:
            return df
        
        for window in window_sizes:
            df[f'Pace_Last{window}Laps'] = df.groupby('Driver')['LapTimeSeconds'].transform(
                lambda x: x.rolling(window=window, min_periods=1).mean()
            )
        
        return df
    
    def prepare_ml_features(self, lap_times: pd.DataFrame, 
                            race_results: pd.DataFrame,
                            total_laps: int) -> pd.DataFrame:
        """
        Prepare full feature set for ML model training/inference.
        
        Returns DataFrame with all engineered features.
        """
        # Start with lap times
        df = lap_times.copy()
        
        # Apply all feature engineering
        df = self.calculate_fuel_corrected_pace(df, total_laps)
        df = self.calculate_gap_to_leader(df)
        df = self.calculate_sector_performance(df)
        df = self.calculate_pit_stop_metrics(df)
        df = self.calculate_recent_pace(df)
        
        # Merge final position from results. FastF1 results name the driver
        # code 'Abbreviation' (callers may have renamed it to 'Driver').
        if race_results is not None and 'Position' in race_results.columns:
            key = next((c for c in ('Driver', 'Abbreviation') if c in race_results.columns), None)
            if key is not None:
                finish_positions = race_results[[key, 'Position']].rename(
                    columns={key: 'Driver', 'Position': 'FinishPosition'}
                )
                df = df.merge(finish_positions, on='Driver', how='left')
        
        return df
    
    @staticmethod
    def encode_compound(compound: str) -> int:
        """Encode tyre compound as numeric value."""
        encoding = {
            'SOFT': 0,
            'MEDIUM': 1,
            'HARD': 2,
            'INTERMEDIATE': 3,
            'WET': 4,
            'UNKNOWN': -1
        }
        return encoding.get(compound, -1)
