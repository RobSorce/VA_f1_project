"""
Regenerate backend/data/processed_cache/championship_{year}.json with the sprint points.

The standings (api/main.py _compute_championship) add, on sprint weekends, the points
of the sprint (results_{year}_{round}_S.json) to those of the race. This script fetches
the sprint classifications that are not cached yet (FastF1, results only: a few seconds
per sprint, network needed the first time), recomputes the standings from the
disk-cached race sessions, prints the top of both championships and writes the file.
A season with rounds still missing is printed but not written (unless --force).

Run from backend/:
    python -m scripts.regenerate_championship            # 2024
    python -m scripts.regenerate_championship 2023 2024
"""
import argparse
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import api.main as main  # noqa: E402


def regenerate(year: int, force: bool = False) -> dict:
    with main._fastf1_lock:
        schedule = main.extractor.get_event_schedule(year)
    sprint_rounds = sorted(int(r) for r in schedule.loc[schedule['EventFormat'].isin(main.SPRINT_FORMATS), 'RoundNumber'])
    for rnd in sprint_rounds:
        t0 = time.monotonic()
        rows = main._load_sprint_results(year, rnd, fast_only=False)
        got = 'missing' if rows is None else f"{len(rows)} rows, {sum(main._points(r) for r in rows):g} pts"
        print(f"{year} R{rnd} sprint: {got} ({time.monotonic() - t0:.1f}s)")

    result = main._compute_championship(year, fast_only=True)
    print(f"{year}: completed {result['completed_rounds']}/{result['total_rounds']}, "
          f"missing_rounds {result['missing_rounds']}, missing_sprint_rounds {result['missing_sprint_rounds']}")
    for d in result['drivers'][:5]:
        sprint = sum(p['sprint_points'] for p in d['progression'])
        print(f"  {d['position']:>2} {d['abbr']} {d['totalPoints']:g} (sprints {sprint:g})")
    for c in result['constructors'][:4]:
        print(f"  {c['position']:>2} {c['team']} {c['totalPoints']:g}")

    path = main.DISK_CACHE_DIR / f"championship_{year}.json"
    if result['missing_rounds'] and not force:
        print(f"  not written: rounds missing ({path.name} left as it is)")
    else:
        main._save_to_disk(path, result)
        main.championship_cache.pop(year, None)
        print(f"  written {path}")
    return result


def main_cli():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('years', nargs='*', type=int, default=[2024])
    ap.add_argument('--force', action='store_true', help='write even with rounds missing')
    args = ap.parse_args()
    for year in args.years:
        regenerate(year, force=args.force)


if __name__ == '__main__':
    main_cli()
