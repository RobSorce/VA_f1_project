"""
Feature Engineering Module
Creates derived metrics for F1 race analysis and ML model training.
"""
import pandas as pd
import numpy as np
from typing import Dict, Any, Optional, Tuple
import logging

logger = logging.getLogger(__name__)


class FeatureEngineer:
    """Generate engineered features for F1 data analysis and ML models."""
    
    # F1 team colors for visualization
    TEAM_COLORS = {
        'Red Bull Racing': '#3671C6',
        'Ferrari': '#E8002D',
        'Mercedes': '#27F4D2',
        'McLaren': '#FF8000',
        'Aston Martin': '#229971',
        'Alpine': '#FF87BC',
        'Williams': '#64C4FF',
        'AlphaTauri': '#5E8FAA',
        'RB': '#6692FF',
        'Alfa Romeo': '#C92D4B',
        'Haas F1 Team': '#B6BABD',
        'Kick Sauber': '#52E252',
    }
    
    # Tyre compound characteristics
    COMPOUND_BASE_DELTA = {
        'SOFT': 0.0,      # Baseline
        'MEDIUM': 0.5,    # ~0.5s slower per lap
        'HARD': 1.0,      # ~1.0s slower per lap
        'INTERMEDIATE': 5.0,
        'WET': 8.0
    }
    
    def calculate_tyre_degradation(self, lap_times: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate tyre degradation rate for each driver stint.
        
        Degradation = lap time increase per lap on used tyres
        """
        if lap_times.empty:
            return lap_times
        
        df = lap_times.copy()
        
        # Ensure we have lap time in seconds
        if 'LapTimeSeconds' not in df.columns and 'LapTime' in df.columns:
            df['LapTimeSeconds'] = df['LapTime'].dt.total_seconds()
        
        # Calculate degradation per driver and stint
        degradation_data = []
        
        for driver in df['Driver'].unique():
            driver_laps = df[df['Driver'] == driver].sort_values('LapNumber')
            
            # Group by compound (pit stops change compound)
            stint_num = 0
            prev_compound = None
            
            for _, lap in driver_laps.iterrows():
                compound = lap.get('Compound', 'UNKNOWN')
                tyre_life = lap.get('TyreLife', 1)
                lap_time = lap.get('LapTimeSeconds', np.nan)
                
                if compound != prev_compound:
                    stint_num += 1
                    stint_start_time = lap_time
                    prev_compound = compound
                
                degradation_data.append({
                    'Driver': driver,
                    'LapNumber': lap['LapNumber'],
                    'Compound': compound,
                    'TyreLife': tyre_life,
                    'StintNumber': stint_num,
                    'LapTimeSeconds': lap_time,
                    'DegradationFromStintStart': lap_time - stint_start_time if pd.notna(lap_time) and pd.notna(stint_start_time) else np.nan
                })
        
        result = pd.DataFrame(degradation_data)
        
        # Calculate degradation rate (seconds lost per lap)
        result['DegradationRate'] = result.groupby(['Driver', 'StintNumber'])['DegradationFromStintStart'].transform(
            lambda x: x / (result.loc[x.index, 'TyreLife'].clip(lower=1))
        )
        
        return result
    
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
    
    def calculate_position_changes(self, race_results: pd.DataFrame) -> pd.DataFrame:
        """
        Calculate position gains/losses from grid to finish.
        """
        df = race_results.copy()
        
        if 'GridPosition' in df.columns and 'Position' in df.columns:
            df['PositionChange'] = df['GridPosition'] - df['Position']
            df['PositionChangeCategory'] = pd.cut(
                df['PositionChange'],
                bins=[-20, -3, -0.5, 0.5, 3, 20],
                labels=['Lost 3+', 'Lost 1-2', 'Same', 'Gained 1-2', 'Gained 3+']
            )
        
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
        
        # Merge final position from results
        if race_results is not None and 'Position' in race_results.columns:
            finish_positions = race_results[['Driver', 'Position']].rename(
                columns={'Position': 'FinishPosition'}
            )
            df = df.merge(finish_positions, on='Driver', how='left')
        
        return df
    
    @staticmethod
    def get_team_color(team_name: str) -> str:
        """Get hex color for a team."""
        return FeatureEngineer.TEAM_COLORS.get(team_name, '#FFFFFF')
    
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


def create_race_features(session_data: Dict[str, Any]) -> pd.DataFrame:
    """
    Convenience function to create all features from session data.
    """
    engineer = FeatureEngineer()
    
    lap_times = session_data.get('lap_times', pd.DataFrame())
    race_results = session_data.get('race_results', pd.DataFrame())
    
    # Estimate total laps from max lap number
    total_laps = int(lap_times['LapNumber'].max()) if not lap_times.empty else 56
    
    features = engineer.prepare_ml_features(lap_times, race_results, total_laps)
    
    return features
