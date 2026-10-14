"""
Regenerate the replay frames cached in backend/data/processed_cache from the local
FastF1 cache (offline: no network request), with the current extractor
(FastF1Extractor.extract_race_frames / extract_qualifying_frames).

Why: frames written before FRAMES_FORMAT 2 keep a retired car frozen on track to the
end of the replay and interpolate lap/gear/DRS/compound linearly (DRS 4-7 between 0
and 8, 11/13 between 10/12/14, codes the cars of those races never sent). The cached
frames cannot be repaired at load time: the raw samples needed to hold a categorical
value, and the last sample of a car in motion, are not in them. The offline reload
works for every cached race: 2-3 s to load a race, 3-6 min to extract its frames
(10 races + 1 qualifying, 2026-10-13: about 45 min in all).

Note: a frame-cache file without 'frames_format' predates these rules; GET /api/frames
serves whatever file is on disk, so run this script (--stale) after pulling the rules.

Run from backend/:
    python -m scripts.regenerate_frames                 # every cached frames_*_R.json
    python -m scripts.regenerate_frames 2024:3 2024:5   # selected races
    python -m scripts.regenerate_frames 2024:8:Q        # a qualifying replay
    python -m scripts.regenerate_frames --stale         # only files older than FRAMES_FORMAT
    python -m scripts.regenerate_frames --out-dir DIR   # write elsewhere (compare first)

Each file is written to a temporary file next to it and moved into place, so a
reader never sees a half-written payload. For every race the script prints the
extraction time, the frame count, the retired cars, and how the new frames compare
with the file they replace (same timeline, x/y of the cars that are kept).
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent
sys.path.insert(0, str(BACKEND))

import fastf1  # noqa: E402

from data.extractors.fastf1_extractor import FRAMES_FORMAT, FastF1Extractor  # noqa: E402

CACHE_DIR = BACKEND / "data" / "processed_cache"
NAME = re.compile(r'^frames_(\d{4})_(\d+)_(R|Q)\.json$')


def cached_frames(session_types=('R',)):
    out = []
    for f in sorted(CACHE_DIR.iterdir()):
        m = NAME.match(f.name)
        if m and m.group(3) in session_types:
            out.append((int(m.group(1)), int(m.group(2)), m.group(3)))
    return out


def parse_target(text):
    parts = text.split(':')
    if len(parts) not in (2, 3):
        raise argparse.ArgumentTypeError(f"expected YEAR:ROUND[:R|Q], got {text!r}")
    return int(parts[0]), int(parts[1]), (parts[2] if len(parts) == 3 else 'R').upper()


def write_atomic(path: Path, data):
    tmp = path.with_name(path.name + '.tmp')
    with open(tmp, 'w') as f:
        json.dump(data, f, separators=(',', ':'))  # the format of api/main.py _save_to_disk
    os.replace(tmp, path)


def compare(old, new):
    """Timeline equality and the largest x/y change of the cars present in both."""
    if old is None:
        return 'no previous file'
    of, nf = old.get('frames', []), new.get('frames', [])
    same_t = len(of) == len(nf) and all(a['t'] == b['t'] for a, b in zip(of, nf))
    dxy = 0.0
    dropped = 0
    for a, b in zip(of, nf):
        for code, p in a['drivers'].items():
            q = b['drivers'].get(code)
            if q is None:
                dropped += 1
                continue
            dxy = max(dxy, abs(p['x'] - q['x']), abs(p['y'] - q['y']))
    return (f"frames {len(of)} -> {len(nf)}, same timeline: {same_t}, "
            f"max |dx|,|dy| of kept cars: {dxy:.3f}, driver-samples dropped: {dropped}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('targets', nargs='*', type=parse_target, help='YEAR:ROUND[:R|Q] (default: every cached race)')
    ap.add_argument('--stale', action='store_true', help=f'skip files already at frames_format {FRAMES_FORMAT}')
    ap.add_argument('--out-dir', type=Path, default=CACHE_DIR, help='where to write (default: the processed cache)')
    args = ap.parse_args()

    targets = args.targets or cached_frames()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    extractor = FastF1Extractor()
    fastf1.Cache.offline_mode(True)

    for year, rnd, st in targets:
        src = CACHE_DIR / f"frames_{year}_{rnd}_{st}.json"
        old = None
        if src.exists():
            with open(src) as f:
                old = json.load(f)
        if args.stale and old is not None and old.get('frames_format') == FRAMES_FORMAT:
            print(f"{src.name}: already frames_format {FRAMES_FORMAT}, skipped")
            continue
        t0 = time.monotonic()
        try:
            session = extractor.get_session(year, rnd, st, laps=True, telemetry=True, weather=False, messages=False)
            t_load = time.monotonic() - t0
            new = extractor.extract_qualifying_frames(session) if st == 'Q' else extractor.extract_race_frames(session)
        except Exception as e:
            print(f"{src.name}: FAILED after {time.monotonic() - t0:.1f}s: {type(e).__name__}: {e}")
            continue
        t_total = time.monotonic() - t0
        dst = args.out_dir / src.name
        write_atomic(dst, new)
        if st == 'Q':
            segs = new.get('segments', {})
            print(f"{src.name}: load {t_load:.1f}s, total {t_total:.1f}s, segments "
                  f"{ {k: len(v['frames']) for k, v in segs.items()} } -> {dst}")
            continue
        print(f"{src.name}: load {t_load:.1f}s, total {t_total:.1f}s, retired_at {new.get('retired_at')}, "
              f"{compare(old, new)} -> {dst}")


if __name__ == '__main__':
    main()
