"""
Bulk Download — Fetch all race sessions (2018-2025) via FastF1 and save to processed cache.

Usage:
    cd backend
    python -m scripts.bulk_download                      # All 2018-2025
    python -m scripts.bulk_download --years 2022 2023    # Specific years
    python -m scripts.bulk_download --dry-run             # Preview only
"""
import argparse
import json
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import fastf1

from data.extractors.fastf1_extractor import FastF1Extractor
from utils.json_helpers import clean_dataframe_for_json

logger = logging.getLogger(__name__)

OUTPUT_DIR = Path(__file__).parent.parent / 'data' / 'processed_cache'
DEFAULT_YEARS = list(range(2018, 2026))


def get_race_rounds(year: int) -> list:
    """Get list of (round_number, event_name) for conventional races in a season."""
    try:
        schedule = fastf1.get_event_schedule(year)
    except Exception as e:
        logger.warning(f"Could not get schedule for {year}: {e}")
        return []

    rounds = []
    for _, row in schedule.iterrows():
        round_num = int(row['RoundNumber'])
        event_name = str(row.get('EventName', f'Round {round_num}'))
        # Skip testing events (round 0)
        if round_num < 1:
            continue
        rounds.append((round_num, event_name))
    return rounds


def download_session(extractor: FastF1Extractor, year: int, round_num: int) -> dict:
    """
    Download a race session and extract all data fields.
    Returns the session data dict ready for JSON serialization.
    """
    session = extractor.get_session(year, round_num, "R")

    lap_times = extractor.extract_lap_times(session)
    circuit_info = extractor.extract_circuit_info(session)
    driver_info = extractor.extract_driver_info(session)
    race_results = extractor.extract_race_results(session)
    weather_data = extractor.extract_weather_data(session)
    tyre_strategy = extractor.extract_tyre_strategy(session)
    track_status = extractor.extract_track_status(session)

    # Clean numpy types in circuit_info
    import numpy as np
    for key in ('track_coordinates', 'corners'):
        if circuit_info.get(key):
            cleaned = []
            for item in circuit_info[key]:
                clean_item = {}
                for k, v in item.items():
                    if isinstance(v, (np.integer, np.floating)):
                        clean_item[k] = float(v)
                    else:
                        clean_item[k] = v
                cleaned.append(clean_item)
            circuit_info[key] = cleaned

    data = {
        'lap_times': clean_dataframe_for_json(lap_times),
        'circuit_info': circuit_info,
        'driver_info': clean_dataframe_for_json(driver_info),
        'race_results': clean_dataframe_for_json(race_results),
        'weather_data': clean_dataframe_for_json(weather_data),
        'tyre_strategy': clean_dataframe_for_json(tyre_strategy),
        'track_status': track_status,
    }
    return data


def main():
    parser = argparse.ArgumentParser(description='Bulk download F1 race sessions')
    parser.add_argument('--years', nargs='+', type=int, default=DEFAULT_YEARS,
                        help='Years to download (default: 2018-2025)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Preview what would be downloaded without actually downloading')
    parser.add_argument('--delay', type=float, default=2.0,
                        help='Delay between downloads in seconds (default: 2.0)')
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Collect all rounds across requested years
    all_rounds = []
    for year in sorted(args.years):
        rounds = get_race_rounds(year)
        for round_num, event_name in rounds:
            all_rounds.append((year, round_num, event_name))

    # Check which are already cached
    cached = []
    pending = []
    for year, round_num, event_name in all_rounds:
        json_path = OUTPUT_DIR / f'session_{year}_{round_num}_R.json'
        if json_path.exists():
            cached.append((year, round_num, event_name))
        else:
            pending.append((year, round_num, event_name))

    total = len(all_rounds)
    print(f"\n{'='*60}")
    print(f"F1 Bulk Download — {len(args.years)} season(s), {total} race(s)")
    print(f"Already cached: {len(cached)} | Pending: {len(pending)}")
    print(f"{'='*60}\n")

    if args.dry_run:
        for year, round_num, event_name in all_rounds:
            json_path = OUTPUT_DIR / f'session_{year}_{round_num}_R.json'
            status = "CACHED" if json_path.exists() else "PENDING"
            print(f"  [{status:7s}] {year} R{round_num:2d} — {event_name}")
        print(f"\nDry run complete. Use without --dry-run to download.")
        return

    if not pending:
        print("All sessions already cached. Nothing to download.")
        return

    extractor = FastF1Extractor()
    success = 0
    failed = 0

    for idx, (year, round_num, event_name) in enumerate(pending, 1):
        json_path = OUTPUT_DIR / f'session_{year}_{round_num}_R.json'
        prefix = f"[{idx}/{len(pending)}]"

        try:
            print(f"{prefix} {year} R{round_num} — {event_name} ...", end=' ', flush=True)
            data = download_session(extractor, year, round_num)

            n_laps = len(data.get('lap_times', []))
            with open(json_path, 'w') as f:
                json.dump(data, f)
            size_mb = json_path.stat().st_size / (1024 * 1024)

            print(f"OK ({n_laps} laps, {size_mb:.1f} MB)")
            success += 1

        except Exception as e:
            print(f"FAILED: {e}")
            failed += 1

        # Rate-limit to be polite to FastF1/Ergast
        if idx < len(pending):
            time.sleep(args.delay)

    print(f"\n{'='*60}")
    print(f"Done. Success: {success} | Failed: {failed} | Previously cached: {len(cached)}")
    print(f"Total available: {success + len(cached)} / {total}")
    print(f"{'='*60}")


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
    main()
