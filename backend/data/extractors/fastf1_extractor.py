"""
FastF1 Data Extractor
Extracts session data, telemetry, and lap times from Formula 1 races.
"""
import fastf1
import pandas as pd
import numpy as np
from pathlib import Path
from typing import Optional, Dict, Any, List
import logging
import sys

# backend/ on the path, so the __main__ block below still runs as a script
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from data.processors.stints import build_tyre_strategy

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Set up FastF1 cache
CACHE_DIR = Path(__file__).parent.parent.parent.parent / "data" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
fastf1.Cache.enable_cache(str(CACHE_DIR))

# Version of the replay frames payloads, written into them as 'frames_format'.
# 2: retired cars leave the race frames after their last sample in motion
# ('retired_at'); lap/gear/DRS/compound/tyre life (race) and gear/DRS (qualifying)
# held from the previous sample (gear: the previous one within 0..MAX_GEAR).
FRAMES_FORMAT = 2

# A car whose last sample in motion comes this long (s) before the first car completes
# the final lap did not reach the flag: it is masked after that sample
RETIRED_MARGIN_S = 1.0


# Gears a car can report; the live feed also sends nGear readings such as 11..72 while
# a car stands in the pit lane (2024 R6 MAG lap 28, 2025 R1: 277 samples)
MAX_GEAR = 8


def hold_previous(timeline: np.ndarray, t_sorted: np.ndarray, values_sorted: np.ndarray,
                  valid: Optional[np.ndarray] = None) -> np.ndarray:
    """Step resampling of a categorical channel (lap, gear, DRS code, compound, tyre
    life): the value of the last real sample at or before each timeline instant (the
    first sample's value before it). Linear interpolation invents values between
    two codes: DRS 13 between 12 and 14, DRS 4 between 0 and 8, a MEDIUM between a
    SOFT and a HARD stint. Samples outside the boolean mask `valid` are skipped (the
    previous valid one holds); with no valid sample the channel is 0."""
    if valid is not None:
        if not valid.any():
            return np.zeros(len(timeline))
        t_sorted, values_sorted = t_sorted[valid], values_sorted[valid]
    idx = np.searchsorted(t_sorted, timeline, side='right') - 1
    return values_sorted[np.clip(idx, 0, len(t_sorted) - 1)]


def valid_gear(gear: np.ndarray) -> np.ndarray:
    return (gear >= 0) & (gear <= MAX_GEAR)


class FastF1Extractor:
    """Extract F1 data using the FastF1 library."""
    
    def __init__(self):
        self.cache_dir = CACHE_DIR
    
    def get_session(self, year: int, round_num: int, session_type: str = "R",
                    laps=True, telemetry=True, weather=True, messages=True) -> fastf1.core.Session:
        """
        Load a session from FastF1.

        Args:
            year: Season year (e.g., 2024)
            round_num: Round number in the season
            session_type: "R" for Race, "Q" for Qualifying, "FP1/FP2/FP3" for Practice
            laps, telemetry, weather, messages: passed to session.load()

        Returns:
            FastF1 Session object with loaded data
        """
        logger.info(f"Loading session: {year} Round {round_num} - {session_type} (tel={telemetry}, weather={weather}, msg={messages})")
        session = fastf1.get_session(year, round_num, session_type)
        session.load(laps=laps, telemetry=telemetry, weather=weather, messages=messages)
        return session

    def get_session_results(self, year: int, round_num: int, session_type: str = "S") -> pd.DataFrame:
        """Classification of a session (Abbreviation, TeamName, Status, Points, ...)
        loaded without laps, telemetry, weather or messages: what the championship
        standings need from a sprint ("S"). The points come from the Ergast
        classification FastF1 merges into session.results."""
        session = self.get_session(year, round_num, session_type,
                                   laps=False, telemetry=False, weather=False, messages=False)
        return self.extract_race_results(session)

    def get_event_schedule(self, year: int) -> pd.DataFrame:
        """Get the event schedule for a season."""
        schedule = fastf1.get_event_schedule(year)
        return schedule
    
    def extract_lap_times(self, session: fastf1.core.Session) -> pd.DataFrame:
        """
        Extract lap times for all drivers in a session.
        
        Returns DataFrame with columns:
        - Driver, LapNumber, LapTime, Sector1Time, Sector2Time, Sector3Time
        - Compound, TyreLife, IsPersonalBest, PitOutTime, PitInTime
        """
        laps = session.laps
        
        # Convert timedelta columns to seconds for easier processing
        lap_data = laps.copy()
        time_cols = ['LapTime', 'Sector1Time', 'Sector2Time', 'Sector3Time', 
                     'PitOutTime', 'PitInTime']
        
        for col in time_cols:
            if col in lap_data.columns:
                lap_data[f'{col}Seconds'] = lap_data[col].dt.total_seconds()

        # Compute GapToLeader and IntervalToAhead from cumulative Time
        # Time = session time at the end of each lap (timedelta → seconds)
        if 'Time' in lap_data.columns:
            lap_data['_time_sec'] = lap_data['Time'].dt.total_seconds()
            gap_rows = []
            for lap_num, grp in lap_data.groupby('LapNumber'):
                sorted_grp = grp.sort_values('Position')
                leader_time = sorted_grp['_time_sec'].iloc[0] if len(sorted_grp) > 0 else None
                prev_time = None
                for idx, row in sorted_grp.iterrows():
                    t = row['_time_sec']
                    if pd.notna(t) and pd.notna(leader_time):
                        gap_rows.append({
                            '_idx': idx,
                            'GapToLeader': round(t - leader_time, 3) if row['Position'] > 1 else 0.0,
                            'IntervalToAhead': round(t - prev_time, 3) if prev_time is not None and pd.notna(prev_time) and row['Position'] > 1 else 0.0,
                        })
                    else:
                        gap_rows.append({'_idx': idx, 'GapToLeader': None, 'IntervalToAhead': None})
                    prev_time = t
            if gap_rows:
                gap_df = pd.DataFrame(gap_rows).set_index('_idx')
                lap_data['GapToLeader'] = gap_df['GapToLeader']
                lap_data['IntervalToAhead'] = gap_df['IntervalToAhead']
            lap_data.drop(columns=['_time_sec'], inplace=True, errors='ignore')

        return lap_data
    
    def extract_telemetry(self, session: fastf1.core.Session, driver: str, 
                          lap_number: Optional[int] = None) -> pd.DataFrame:
        """
        Extract telemetry data for a specific driver.
        
        Args:
            session: FastF1 Session object
            driver: Driver abbreviation (e.g., "VER", "HAM") or driver number
            lap_number: Optional specific lap number, otherwise fastest lap
        
        Returns DataFrame with telemetry columns:
        - Speed, Throttle, Brake, nGear, RPM, DRS
        - Distance, Time, X, Y, Z (position coordinates)
        """
        try:
            driver_laps = session.laps.pick_drivers(driver)
        except Exception:
            # Fallback for older fastf1 versions
            driver_laps = session.laps.pick_driver(driver)
        
        if driver_laps.empty:
            return pd.DataFrame()
        
        if lap_number:
            lap_data = driver_laps[driver_laps['LapNumber'] == lap_number]
            if lap_data.empty:
                return pd.DataFrame()
            lap = lap_data.iloc[0]
        else:
            lap = driver_laps.pick_fastest()
        
        telemetry = lap.get_telemetry()
        return telemetry
    
    def extract_circuit_info(self, session: fastf1.core.Session) -> Dict[str, Any]:
        """
        Extract circuit information including track coordinates, sectors, and DRS zones.

        Returns dictionary with:
        - name, country, location
        - track_coordinates (X, Y, Distance, Sector from fastest lap telemetry)
        - corners list with number and position
        - drs_zones: [{start_idx, end_idx, detection_idx}]
        """
        event = session.event

        # Get circuit coordinates from any driver's fastest lap
        fastest_driver = session.laps.pick_fastest()['Driver']
        fastest_lap = session.laps.pick_driver(fastest_driver).pick_fastest()

        drs_zones = []
        try:
            telemetry = fastest_lap.get_telemetry()
            track_coords = telemetry[['X', 'Y', 'Distance']].copy()

            # Assign sectors based on sector times
            total_distance = track_coords['Distance'].max()
            try:
                s1_time = fastest_lap['Sector1SessionTime']
                s2_time = fastest_lap['Sector2SessionTime']
                s3_time = fastest_lap['Sector3SessionTime']
                lap_start_time = fastest_lap['LapStartTime'] if 'LapStartTime' in fastest_lap.index else telemetry['SessionTime'].iloc[0]

                tel_times = telemetry['SessionTime']
                sector_col = np.ones(len(telemetry), dtype=int)
                if pd.notna(s1_time) and pd.notna(s2_time):
                    sector_col[tel_times > s1_time] = 2
                    sector_col[tel_times > s2_time] = 3
                track_coords['Sector'] = sector_col
            except Exception:
                # Fallback: divide by thirds of distance
                track_coords['Sector'] = np.where(
                    track_coords['Distance'] < total_distance / 3, 1,
                    np.where(track_coords['Distance'] < 2 * total_distance / 3, 2, 3)
                )

            # Detect DRS zones from raw car_data mapped by track distance
            tel_dist = telemetry['Distance'].to_numpy()
            total_track_dist = tel_dist.max()

            try:
                # Find the driver with most DRS activations (leaders rarely have DRS)
                best_dn = None
                best_drs_count = 0
                for dn in session.drivers:
                    rc = session.car_data.get(str(dn))
                    if rc is not None and 'DRS' in rc.columns:
                        cnt = np.isin(rc['DRS'].to_numpy(), [10, 12, 14]).sum()
                        if cnt > best_drs_count:
                            best_drs_count = cnt
                            best_dn = str(dn)

                driver_num = best_dn or str(session.laps.pick_fastest()['DriverNumber'])
                raw_car = session.car_data.get(driver_num)
                if raw_car is not None and 'DRS' in raw_car.columns:
                    raw_drs = raw_car['DRS'].to_numpy()
                    raw_times = raw_car['SessionTime'].dt.total_seconds().to_numpy()

                    # Find a lap where DRS was actually used
                    active_mask = np.isin(raw_drs, [10, 12, 14])
                    try:
                        driver_laps = session.laps.pick_drivers(driver_num).sort_values('LapNumber')
                    except Exception:
                        driver_laps = session.laps.pick_driver(driver_num).sort_values('LapNumber')

                    drs_lap = None
                    for _, lp in driver_laps.iterrows():
                        lt = lp.get('LapStartTime')
                        le = lp.get('Time')
                        if lt is None or le is None:
                            continue
                        lt_s = lt.total_seconds() if hasattr(lt, 'total_seconds') else float(lt)
                        le_s = le.total_seconds() if hasattr(le, 'total_seconds') else float(le)
                        if active_mask[(raw_times >= lt_s) & (raw_times <= le_s)].sum() > 5:
                            drs_lap = lp
                            break

                    if drs_lap is not None:
                        drs_tel = drs_lap.get_telemetry()
                        drs_tel_times = drs_tel['SessionTime'].dt.total_seconds().to_numpy()
                        drs_tel_dist = drs_tel['Distance'].to_numpy()

                        lt_s = drs_lap['LapStartTime'].total_seconds() if hasattr(drs_lap['LapStartTime'], 'total_seconds') else float(drs_lap['LapStartTime'])
                        le_s = drs_lap['Time'].total_seconds() if hasattr(drs_lap['Time'], 'total_seconds') else float(drs_lap['Time'])

                        # Get DRS values for this lap from raw car_data
                        lap_mask = (raw_times >= lt_s) & (raw_times <= le_s)
                        lap_drs = raw_drs[lap_mask]
                        lap_t = raw_times[lap_mask]

                        # Map raw car_data times to distances via the lap telemetry
                        lap_drs_dist = np.interp(lap_t, drs_tel_times, drs_tel_dist)

                        # Find DRS active distance intervals
                        in_zone = False
                        zone_start_d = None
                        det_d = None
                        raw_dist_zones = []

                        for i in range(len(lap_drs)):
                            d = lap_drs_dist[i]
                            if lap_drs[i] in (10, 12, 14) and not in_zone:
                                in_zone = True
                                zone_start_d = d
                            elif lap_drs[i] not in (10, 12, 14) and in_zone:
                                in_zone = False
                                raw_dist_zones.append({
                                    'start_d': zone_start_d,
                                    'end_d': d,
                                    'det_d': det_d,
                                })
                                det_d = None
                            if lap_drs[i] == 8 and not in_zone:
                                det_d = d

                        if in_zone and zone_start_d is not None:
                            raw_dist_zones.append({'start_d': zone_start_d, 'end_d': lap_drs_dist[-1], 'det_d': det_d})

                        # Map distance zones to track coordinate indices
                        for rz in raw_dist_zones:
                            start_idx = int(np.argmin(np.abs(tel_dist - rz['start_d'])))
                            end_idx = int(np.argmin(np.abs(tel_dist - rz['end_d'])))
                            det_idx = int(np.argmin(np.abs(tel_dist - rz['det_d']))) if rz['det_d'] else max(0, start_idx - 15)
                            if end_idx > start_idx + 3:
                                drs_zones.append({
                                    'start_idx': start_idx,
                                    'end_idx': end_idx,
                                    'detection_idx': det_idx,
                                })

                        logger.info(f"Detected {len(drs_zones)} DRS zones from lap {int(drs_lap['LapNumber'])} car data")
                    else:
                        logger.info("No laps with DRS activation found")
            except Exception as e:
                logger.warning(f"DRS zone detection from car_data failed: {e}")

        except Exception as e:
            logger.warning(f"Could not extract track coordinates: {e}")
            track_coords = None

        # Get circuit info
        circuit_info = {
            'name': event['EventName'],
            'country': event['Country'],
            'location': event['Location'],
            'circuit_name': event.get('OfficialEventName', event['EventName']),
            'event_name': event['EventName'],
            'track_coordinates': track_coords.to_dict('records') if track_coords is not None else None,
            'drs_zones': drs_zones,
        }

        # Try to get corner information and rotation
        try:
            circuit = session.get_circuit_info()
            circuit_info['corners'] = circuit.corners.to_dict('records')
            circuit_info['marshal_lights'] = circuit.marshal_lights.to_dict('records') if hasattr(circuit, 'marshal_lights') else []
            circuit_info['rotation'] = float(circuit.rotation) if hasattr(circuit, 'rotation') else 0
        except Exception as e:
            logger.warning(f"Could not extract corner info: {e}")
            circuit_info['corners'] = []
            circuit_info['rotation'] = 0

        return circuit_info

    def extract_track_status(self, session: fastf1.core.Session) -> List[Dict[str, Any]]:
        """
        Extract track status events (flags, safety car, VSC).

        Status codes:
        - 1: Green flag (all clear)
        - 2: Yellow flag
        - 4: Safety Car
        - 5: Red Flag
        - 6/7: Virtual Safety Car (VSC)

        Returns list of {status, start_time, end_time, message}
        """
        try:
            track_status = session.track_status
            if track_status is None or track_status.empty:
                return []

            statuses = []
            for i, row in track_status.iterrows():
                status_code = str(row.get('Status', '1'))
                time_val = row.get('Time', row.get('SessionTime', None))
                time_sec = float(time_val.total_seconds()) if hasattr(time_val, 'total_seconds') else 0
                message = row.get('Message', '')

                statuses.append({
                    'status': status_code,
                    'time': time_sec,
                    'message': str(message) if pd.notna(message) else '',
                })

            # Convert to start/end periods
            periods = []
            for i, s in enumerate(statuses):
                end_time = statuses[i + 1]['time'] if i + 1 < len(statuses) else None
                periods.append({
                    'status': s['status'],
                    'start_time': s['time'],
                    'end_time': end_time,
                    'message': s['message'],
                })

            return periods
        except Exception as e:
            logger.warning(f"Could not extract track status: {e}")
            return []
    
    def extract_driver_info(self, session: fastf1.core.Session) -> pd.DataFrame:
        """
        Extract driver and team information for a session.
        
        Returns DataFrame with:
        - DriverNumber, Abbreviation, FullName, TeamName, TeamColor
        """
        drivers = []
        
        for driver in session.drivers:
            try:
                driver_info = session.get_driver(driver)
                drivers.append({
                    'DriverNumber': driver,
                    'Abbreviation': driver_info['Abbreviation'],
                    'FullName': driver_info.get('FullName', driver_info['Abbreviation']),
                    'TeamName': driver_info['TeamName'],
                    'TeamColor': f"#{driver_info['TeamColor']}" if driver_info.get('TeamColor') else '#FFFFFF'
                })
            except Exception as e:
                logger.warning(f"Could not get info for driver {driver}: {e}")
        
        return pd.DataFrame(drivers)
    
    def extract_race_results(self, session: fastf1.core.Session) -> pd.DataFrame:
        """
        Extract final race results.
        
        Returns DataFrame with:
        - Position, Driver, Team, Status, Points, Time/Gap
        """
        results = session.results
        return results
    
    def extract_position_data(self, session: fastf1.core.Session, 
                               sample_rate: int = 5) -> Dict[str, Any]:
        """
        Extract position data for all drivers throughout the race.
        Uses session.pos_data for efficient access to pre-computed position data.
        
        Args:
            session: FastF1 Session object
            sample_rate: Take every Nth sample (default 5 for ~10K points per driver)
        
        Returns:
            Dictionary with:
            - max_time: Maximum session time in seconds
            - drivers: List of driver position data with time, X, Y coordinates
        """
        pos_data = session.pos_data
        if pos_data is None:
            logger.warning("No position data available")
            return {'max_time': 0, 'drivers': {}}
        
        result = {
            'max_time': 0,
            'drivers': {}
        }
        
        for driver_num in session.drivers:
            try:
                driver_pos = pos_data.get(driver_num)
                if driver_pos is None or driver_pos.empty:
                    continue
                
                # Get driver abbreviation
                driver_info = session.get_driver(driver_num)
                driver_abbr = driver_info.get('Abbreviation', driver_num)
                team_color = driver_info.get('TeamColor', 'FFFFFF')
                
                # Downsample for performance
                sampled = driver_pos.iloc[::sample_rate].copy()
                
                # Filter for valid on-track data
                if 'Status' in sampled.columns:
                    sampled = sampled[sampled['Status'] == 'OnTrack']
                
                # Convert SessionTime to seconds
                if 'SessionTime' in sampled.columns:
                    times = sampled['SessionTime'].dt.total_seconds().tolist()
                elif 'Time' in sampled.columns:
                    times = sampled['Time'].dt.total_seconds().tolist()
                else:
                    continue
                
                # Get coordinates
                x_coords = sampled['X'].tolist()
                y_coords = sampled['Y'].tolist()
                
                # Track max time across all drivers
                if times:
                    max_driver_time = max([t for t in times if pd.notna(t)])
                    result['max_time'] = max(result['max_time'], max_driver_time)
                
                result['drivers'][driver_abbr] = {
                    'teamColor': f'#{team_color}' if team_color else '#FFFFFF',
                    'times': times,
                    'x': x_coords,
                    'y': y_coords
                }
                
            except Exception as e:
                logger.warning(f"Could not extract position data for driver {driver_num}: {e}")
        
        logger.info(f"Extracted position data for {len(result['drivers'])} drivers, max time: {result['max_time']:.1f}s")
        return result
    
    def extract_race_frames(self, session: fastf1.core.Session, 
                            fps: int = 25) -> Dict[str, Any]:
        """
        Extract race replay frames with full telemetry for all drivers.
        Matches the frame format from f1-race-replay project for rich animations.
        
        Args:
            session: FastF1 Session object
            fps: Frames per second for resampling (default 25)
        
        Returns:
            Dictionary with:
            - frames: List of frame snapshots at each timestep
            - driver_colors: Map of driver code to team color
            - total_laps: Maximum lap number
            - max_time: Maximum session time in seconds
        """
        dt = 1.0 / fps
        laps = session.laps
        
        # Build per-driver telemetry data
        driver_data = {}
        global_t_min = None
        global_t_max = None
        max_lap_number = 0
        driver_colors = {}
        
        for driver_num in session.drivers:
            try:
                driver_info = session.get_driver(driver_num)
                driver_code = driver_info.get('Abbreviation', str(driver_num))
                team_color = driver_info.get('TeamColor', 'FFFFFF')
                driver_colors[driver_code] = f'#{team_color}' if team_color else '#FFFFFF'
                
                try:
                    driver_laps = laps.pick_drivers(driver_num)
                except Exception:
                    driver_laps = laps.pick_driver(driver_num)
                
                if driver_laps.empty:
                    continue
                
                driver_max_lap = int(driver_laps['LapNumber'].max())
                max_lap_number = max(max_lap_number, driver_max_lap)
                
                # Collect telemetry from all laps
                t_all, x_all, y_all = [], [], []
                lap_nums, speed_all, gear_all = [], [], []
                drs_all, throttle_all, brake_all = [], [], []
                tyre_compound_all, tyre_life_all = [], []
                
                for _, lap in driver_laps.iterlaps():
                    try:
                        tel = lap.get_telemetry()
                        if tel is None or tel.empty:
                            continue
                        
                        lap_num = int(lap['LapNumber'])
                        compound = lap.get('Compound', 'UNKNOWN')
                        if pd.isna(compound):
                            compound = 'UNKNOWN'
                        tyre_life = lap.get('TyreLife', 0)
                        if pd.isna(tyre_life):
                            tyre_life = 0
                        
                        # Map compound to integer (1=SOFT, 2=MEDIUM, 3=HARD, 4=INTER, 5=WET)
                        compound_map = {'SOFT': 1, 'MEDIUM': 2, 'HARD': 3, 
                                       'INTERMEDIATE': 4, 'WET': 5, 'UNKNOWN': 0}
                        compound_int = compound_map.get(str(compound).upper(), 0)
                        
                        # Extract arrays
                        t_lap = tel['SessionTime'].dt.total_seconds().to_numpy()
                        x_lap = tel['X'].to_numpy()
                        y_lap = tel['Y'].to_numpy()
                        speed_lap = tel['Speed'].to_numpy() if 'Speed' in tel.columns else np.zeros(len(t_lap))
                        gear_lap = tel['nGear'].to_numpy() if 'nGear' in tel.columns else np.zeros(len(t_lap))
                        drs_lap = tel['DRS'].to_numpy() if 'DRS' in tel.columns else np.zeros(len(t_lap))
                        throttle_lap = tel['Throttle'].to_numpy() if 'Throttle' in tel.columns else np.zeros(len(t_lap))
                        brake_lap = tel['Brake'].to_numpy() if 'Brake' in tel.columns else np.zeros(len(t_lap))
                        
                        t_all.append(t_lap)
                        x_all.append(x_lap)
                        y_all.append(y_lap)
                        lap_nums.append(np.full_like(t_lap, lap_num))
                        speed_all.append(speed_lap)
                        gear_all.append(gear_lap)
                        drs_all.append(drs_lap)
                        throttle_all.append(throttle_lap)
                        brake_all.append(brake_lap)
                        tyre_compound_all.append(np.full_like(t_lap, compound_int))
                        tyre_life_all.append(np.full_like(t_lap, float(tyre_life)))
                        
                    except Exception as e:
                        logger.debug(f"Error processing lap for {driver_code}: {e}")
                        continue
                
                if not t_all:
                    continue
                
                # Concatenate all data
                t_all = np.concatenate(t_all)
                x_all = np.concatenate(x_all)
                y_all = np.concatenate(y_all)
                lap_nums = np.concatenate(lap_nums)
                speed_all = np.concatenate(speed_all)
                gear_all = np.concatenate(gear_all)
                drs_all = np.concatenate(drs_all)
                throttle_all = np.concatenate(throttle_all)
                brake_all = np.concatenate(brake_all)
                tyre_compound_all = np.concatenate(tyre_compound_all)
                tyre_life_all = np.concatenate(tyre_life_all)
                
                # Sort by time (stable: the interpolated end sample of lap n and the
                # first sample of lap n+1 share a timestamp and keep that order)
                order = np.argsort(t_all, kind='stable')
                t_all = t_all[order]
                x_all = x_all[order]
                y_all = y_all[order]
                lap_nums = lap_nums[order]
                speed_all = speed_all[order]
                gear_all = gear_all[order]
                drs_all = drs_all[order]
                throttle_all = throttle_all[order]
                brake_all = brake_all[order]
                tyre_compound_all = tyre_compound_all[order]
                tyre_life_all = tyre_life_all[order]
                
                t_min = float(t_all.min())
                t_max = float(t_all.max())
                
                if global_t_min is None or t_min < global_t_min:
                    global_t_min = t_min
                if global_t_max is None or t_max > global_t_max:
                    global_t_max = t_max
                
                driver_data[driver_code] = {
                    't': t_all, 'x': x_all, 'y': y_all,
                    'lap': lap_nums, 'speed': speed_all, 'gear': gear_all,
                    'drs': drs_all, 'throttle': throttle_all, 'brake': brake_all,
                    'tyre': tyre_compound_all, 'tyre_life': tyre_life_all
                }
                
            except Exception as e:
                logger.warning(f"Could not process driver {driver_num}: {e}")
        
        if global_t_min is None or global_t_max is None:
            return {'frames': [], 'driver_colors': driver_colors, 'total_laps': 0, 'max_time': 0}
        
        # Create common timeline and resample all drivers
        timeline = np.arange(global_t_min, global_t_max, dt) - global_t_min

        # The flag: the first car to complete the final lap (session seconds)
        finish_t = None
        if 'Time' in laps.columns:
            final_lap_ends = laps.loc[laps['LapNumber'] == max_lap_number, 'Time'].dropna()
            if not final_lap_ends.empty:
                finish_t = float(final_lap_ends.min().total_seconds())

        resampled_data = {}
        retired_at = {}  # code → replay time (s) of the last sample of a car that did not finish
        for code, data in driver_data.items():
            t = data['t'] - global_t_min
            order = np.argsort(t, kind='stable')
            t_sorted = t[order]

            # A car whose last real sample in motion comes before the flag retired:
            # np.interp would hold it frozen at its last position to the end of the
            # replay, so it is masked after that sample instead. A car parked on track
            # keeps streaming position samples at speed 0 (2024 R3: RUS in the barrier
            # from lap 57 to the end, HAM for 52 s after his engine failure), which
            # only show a stopped car out of the race; a car never in motion (2025 R1
            # HAD, out on the formation lap) leaves after its first sample. Finishers
            # keep their place past the line (their telemetry ends there, in motion).
            moving = np.flatnonzero(data['speed'][order] > 0)
            t_last = float(t_sorted[moving[-1]] if len(moving) else t_sorted[0])
            if finish_t is not None and t_last + global_t_min < finish_t - RETIRED_MARGIN_S:
                retired_at[code] = t_last

            resampled_data[code] = {
                'x': np.interp(timeline, t_sorted, data['x'][order]),
                'y': np.interp(timeline, t_sorted, data['y'][order]),
                'lap': hold_previous(timeline, t_sorted, data['lap'][order]),
                'speed': np.interp(timeline, t_sorted, data['speed'][order]),
                'gear': hold_previous(timeline, t_sorted, data['gear'][order], valid_gear(data['gear'][order])),
                'drs': hold_previous(timeline, t_sorted, data['drs'][order]),
                'throttle': np.interp(timeline, t_sorted, data['throttle'][order]),
                'brake': np.interp(timeline, t_sorted, data['brake'][order]),
                'tyre': hold_previous(timeline, t_sorted, data['tyre'][order]),
                'tyre_life': hold_previous(timeline, t_sorted, data['tyre_life'][order]),
            }

        # Build frames - downsample to reduce payload size (every 10th frame = 2.5 FPS is enough for web)
        frame_step = 10
        frames = []
        driver_codes = list(resampled_data.keys())

        for i in range(0, len(timeline), frame_step):
            t = float(timeline[i])
            frame_drivers = {}

            for code in driver_codes:
                if code in retired_at and t > retired_at[code]:
                    continue
                d = resampled_data[code]
                frame_drivers[code] = {
                    'x': float(d['x'][i]),
                    'y': float(d['y'][i]),
                    'lap': int(round(d['lap'][i])),
                    'speed': round(float(d['speed'][i]), 1),
                    'gear': int(round(d['gear'][i])),
                    'drs': int(round(d['drs'][i])),
                    'throttle': round(float(d['throttle'][i]), 1),
                    'brake': round(float(d['brake'][i]), 1),
                    'tyre': int(round(d['tyre'][i])),
                    'tyre_life': round(float(d['tyre_life'][i]), 1)
                }
            
            frames.append({
                't': round(t, 2),
                'drivers': frame_drivers
            })
        
        logger.info(f"Built {len(frames)} frames for {len(driver_codes)} drivers"
                    f" ({len(retired_at)} retired: {sorted(retired_at)})")

        return {
            'frames': frames,
            'driver_colors': driver_colors,
            'total_laps': int(max_lap_number),
            'max_time': round(float(global_t_max - global_t_min), 2),
            'retired_at': {code: round(t_ret, 2) for code, t_ret in retired_at.items()},
            'frames_format': FRAMES_FORMAT,
        }
    
    def extract_qualifying_frames(self, session: fastf1.core.Session,
                                    fps: int = 25) -> Dict[str, Any]:
        """
        Extract replay frames for qualifying, grouped by Q1/Q2/Q3.
        Each segment shows all participating drivers doing their fastest lap
        simultaneously, using the same frame format as race frames.

        Returns:
            Dictionary with 'segments' key containing per-segment frame data:
            {segments: {Q1: {frames, driver_colors, total_laps, max_time}, ...}}
        """
        dt = 1.0 / fps
        laps = session.laps

        try:
            q1, q2, q3 = laps.split_qualifying_sessions()
        except Exception as e:
            logger.warning(f"Could not split qualifying sessions: {e}")
            return {'segments': {}}

        import time as _time

        segment_laps = {'Q1': q1, 'Q2': q2, 'Q3': q3}
        result = {}
        extraction_start = _time.monotonic()

        for seg_name, seg in segment_laps.items():
            if seg is None or seg.empty:
                logger.info(f"{seg_name}: empty, skipping")
                continue

            seg_start = _time.monotonic()
            driver_codes = seg['Driver'].dropna().unique().tolist()
            logger.info(f"{seg_name}: extracting telemetry for {len(driver_codes)} drivers...")
            driver_data = {}
            driver_colors = {}
            global_t_min = None
            global_t_max = None

            for idx, code in enumerate(driver_codes):
                try:
                    driver_seg_laps = seg.pick_drivers(code)
                    if driver_seg_laps.empty:
                        continue

                    fastest = driver_seg_laps.pick_fastest()
                    if fastest is None or pd.isna(fastest.get('LapTime')):
                        continue

                    t0 = _time.monotonic()
                    tel = fastest.get_telemetry()
                    dt_tel = _time.monotonic() - t0
                    if dt_tel > 1.0:
                        logger.info(f"  {seg_name}/{code}: get_telemetry took {dt_tel:.1f}s")
                    if tel is None or tel.empty:
                        continue

                    # Get driver color
                    try:
                        driver_info = session.get_driver(code)
                        team_color = driver_info.get('TeamColor', 'FFFFFF')
                        driver_colors[code] = f'#{team_color}' if team_color else '#FFFFFF'
                    except Exception:
                        driver_colors[code] = '#FFFFFF'

                    # Get compound
                    compound = fastest.get('Compound', 'UNKNOWN')
                    if pd.isna(compound):
                        compound = 'UNKNOWN'
                    compound_map = {'SOFT': 1, 'MEDIUM': 2, 'HARD': 3,
                                    'INTERMEDIATE': 4, 'WET': 5, 'UNKNOWN': 0}
                    compound_int = compound_map.get(str(compound).upper(), 0)
                    tyre_life = fastest.get('TyreLife', 0)
                    if pd.isna(tyre_life):
                        tyre_life = 0

                    # Extract telemetry arrays
                    t_arr = tel['SessionTime'].dt.total_seconds().to_numpy()
                    x_arr = tel['X'].to_numpy()
                    y_arr = tel['Y'].to_numpy()
                    speed_arr = tel['Speed'].to_numpy() if 'Speed' in tel.columns else np.zeros(len(t_arr))
                    gear_arr = tel['nGear'].to_numpy() if 'nGear' in tel.columns else np.zeros(len(t_arr))
                    drs_arr = tel['DRS'].to_numpy() if 'DRS' in tel.columns else np.zeros(len(t_arr))
                    throttle_arr = tel['Throttle'].to_numpy() if 'Throttle' in tel.columns else np.zeros(len(t_arr))
                    brake_arr = tel['Brake'].to_numpy() if 'Brake' in tel.columns else np.zeros(len(t_arr))

                    # Sort by time
                    order = np.argsort(t_arr)
                    t_arr = t_arr[order]
                    x_arr = x_arr[order]
                    y_arr = y_arr[order]
                    speed_arr = speed_arr[order]
                    gear_arr = gear_arr[order]
                    drs_arr = drs_arr[order]
                    throttle_arr = throttle_arr[order]
                    brake_arr = brake_arr[order]

                    t_min = float(t_arr.min())
                    t_max = float(t_arr.max())

                    if global_t_min is None or t_min < global_t_min:
                        global_t_min = t_min
                    if global_t_max is None or t_max > global_t_max:
                        global_t_max = t_max

                    driver_data[code] = {
                        't': t_arr, 'x': x_arr, 'y': y_arr,
                        'speed': speed_arr, 'gear': gear_arr, 'drs': drs_arr,
                        'throttle': throttle_arr, 'brake': brake_arr,
                        'tyre': compound_int, 'tyre_life': float(tyre_life)
                    }

                except Exception as e:
                    logger.debug(f"Error processing {code} in {seg_name}: {e}")
                    continue

            if not driver_data or global_t_min is None:
                continue

            # Create common timeline and resample all drivers
            timeline = np.arange(global_t_min, global_t_max, dt) - global_t_min

            resampled = {}
            for code, data in driver_data.items():
                t = data['t'] - global_t_min
                order = np.argsort(t)
                t_sorted = t[order]

                resampled[code] = {
                    'x': np.interp(timeline, t_sorted, data['x'][order]),
                    'y': np.interp(timeline, t_sorted, data['y'][order]),
                    'speed': np.interp(timeline, t_sorted, data['speed'][order]),
                    # categorical: held from the previous sample, as in the race frames
                    'gear': hold_previous(timeline, t_sorted, data['gear'][order], valid_gear(data['gear'][order])),
                    'drs': hold_previous(timeline, t_sorted, data['drs'][order]),
                    'throttle': np.interp(timeline, t_sorted, data['throttle'][order]),
                    'brake': np.interp(timeline, t_sorted, data['brake'][order]),
                    'tyre': data['tyre'],
                    'tyre_life': data['tyre_life'],
                }

            # Build frames — downsample to 2.5 FPS
            frame_step = 10
            frames = []
            codes = list(resampled.keys())

            for i in range(0, len(timeline), frame_step):
                t = float(timeline[i])
                frame_drivers = {}
                for code in codes:
                    d = resampled[code]
                    frame_drivers[code] = {
                        'x': float(d['x'][i]),
                        'y': float(d['y'][i]),
                        'lap': 1,
                        'speed': round(float(d['speed'][i]), 1),
                        'gear': int(round(d['gear'][i])),
                        'drs': int(round(d['drs'][i])),
                        'throttle': round(float(d['throttle'][i]), 1),
                        'brake': round(float(d['brake'][i]), 1),
                        'tyre': int(d['tyre']),
                        'tyre_life': round(d['tyre_life'], 1)
                    }
                frames.append({'t': round(t, 2), 'drivers': frame_drivers})

            seg_elapsed = _time.monotonic() - seg_start
            logger.info(f"{seg_name}: {len(frames)} frames for {len(codes)} drivers ({seg_elapsed:.1f}s)")

            result[seg_name] = {
                'frames': frames,
                'driver_colors': driver_colors,
                'total_laps': 1,
                'max_time': round(float(global_t_max - global_t_min), 2)
            }

        total_elapsed = _time.monotonic() - extraction_start
        logger.info(f"Qualifying frames complete: {list(result.keys())} segments in {total_elapsed:.1f}s")
        return {'segments': result, 'frames_format': FRAMES_FORMAT}

    def extract_weather_data(self, session: fastf1.core.Session) -> pd.DataFrame:
        """
        Extract weather data throughout the session.
        
        Returns DataFrame with:
        - Time, AirTemp, TrackTemp, Humidity, Pressure, WindSpeed, WindDirection, Rainfall
        """
        try:
            weather = session.weather_data
            return weather
        except Exception as e:
            logger.warning(f"Could not extract weather data: {e}")
            return pd.DataFrame()
    
    def extract_tyre_strategy(self, session: fastf1.core.Session) -> pd.DataFrame:
        """
        Extract tyre strategy data - compounds and stint lengths.

        Stints follow the FastF1 Stint column (one per tyre set), so a stop
        for the same compound opens a new stint, while a pit-lane pass that
        keeps the same set (SC, drive-through) does not; see
        data/processors/stints.py build_tyre_strategy, which also rebuilds
        cached payloads at load time.

        Returns DataFrame with:
        - Driver, StintNumber, Compound, StartLap, EndLap, TotalLaps
        """
        laps = session.laps
        if laps is None or laps.empty:
            return pd.DataFrame([])

        # JSON-style lap rows: the same input the processor gets from the cache.
        # TyreLife is required: without it every Stint change counts as a tyre
        # change, so SC pit-lane passes would split stints (is_tyre_change).
        cols = ['Driver', 'DriverNumber', 'LapNumber', 'Stint', 'Compound', 'TyreLife',
                'PitOutTime', 'PitInTime']
        records = laps.reindex(columns=cols).to_dict('records')
        for rec in records:
            for col in ('PitOutTime', 'PitInTime'):
                value = rec.get(col)
                seconds = value.total_seconds() if hasattr(value, 'total_seconds') else value
                rec[col] = None if seconds is None or pd.isna(seconds) else float(seconds)

        # Keep the session's driver order (classification), as before
        num_to_abbr = {str(rec['DriverNumber']): rec['Driver'] for rec in records
                       if rec.get('Driver') and pd.notna(rec.get('DriverNumber'))}
        driver_order = [num_to_abbr[str(num)] for num in session.drivers if str(num) in num_to_abbr]

        return pd.DataFrame(build_tyre_strategy(records, driver_order=driver_order))


def get_sample_session_data(year: int = 2024, round_num: int = 24) -> Dict[str, Any]:
    """
    Convenience function to get comprehensive data for a session.
    Default is 2024 Abu Dhabi GP (round 24).
    """
    extractor = FastF1Extractor()
    session = extractor.get_session(year, round_num, "R")
    
    return {
        'lap_times': extractor.extract_lap_times(session),
        'circuit_info': extractor.extract_circuit_info(session),
        'driver_info': extractor.extract_driver_info(session),
        'race_results': extractor.extract_race_results(session),
        'weather_data': extractor.extract_weather_data(session),
        'tyre_strategy': extractor.extract_tyre_strategy(session),
        'session': session
    }


if __name__ == "__main__":
    # Test extraction with 2024 Abu Dhabi GP
    print("Testing FastF1 Extractor...")
    extractor = FastF1Extractor()
    
    # Get event schedule
    schedule = extractor.get_event_schedule(2024)
    print(f"\n2024 Season has {len(schedule)} events")
    print(schedule[['RoundNumber', 'EventName', 'Country']].head(10))
