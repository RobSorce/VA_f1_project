"""
Which PCA features depend on race progress? During a replay the lasso
analysis (data/processors/pca_compute.py analyze_selection) compares rows of
the race on screen, computed from the laps completed at the replay clock,
with whole-race rows of the other races. A feature whose distribution moves
with the laps completed differs between the two kinds of rows whatever the
drivers did; pca_compute.PROGRESS_DEPENDENT_FEATURES names those features.

Run from backend/:
    python -m scripts.pca_progress_features [--out REPORT.txt]

For every cached race of the post-race matrix and each share of the race
(PROGRESS_SHARES of the leader's laps), the rows at the clock just after the
leader completed that lap (pca_compute.race_feature_rows) are compared with
the same race's post-race rows (same drivers), per feature:
- shift: mean at the clock minus post-race mean, in standard deviations of
  that feature over the whole post-race matrix (median of the signed shift and
  of |shift| over the races);
- spread ratio: SD of the rows at the clock / SD of the same drivers'
  post-race rows (median over the races).
A feature depends on race progress when, at some share, the median |shift|
is >= SHIFT_MIN or the median spread ratio is outside [1 / SPREAD_MAX,
SPREAD_MAX]. Checked at the end: those features are exactly
pca_compute.PROGRESS_DEPENDENT_FEATURES (also checked by
tests/test_pca_stratified.py through moving_features).
"""
import argparse
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402
from data.processors.stints import leader_lap_times  # noqa: E402

# Shares of the race leader's laps at which the rows are taken
PROGRESS_SHARES = (0.25, 0.5, 0.75)

# Mean shift (in matrix SDs) from which a feature counts as moving with race
# progress. ASSUMPTION: 0.5, half a standard deviation of the feature over
# the whole matrix.
SHIFT_MIN = 0.5

# Spread ratio (at the clock / post-race) beyond which a feature counts as
# moving with race progress. ASSUMPTION: 2, the spread doubled or halved.
SPREAD_MAX = 2.0

# Fewest rows of a race (with a value at both clocks) for its shift and ratio
MIN_ROWS = 3


def measure():
    """{'rows', 'races', 'used' {share: races}, 'table' {feature: {share:
    (median shift, median |shift|, median ratio)}}} over the cached races."""
    df = pc._load_matrix()
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    sd = df[cols].astype(float).std(ddof=1)
    races = sorted(set(zip(df['year'].astype(int), df['round'].astype(int))))
    shifts = {s: {c: [] for c in cols} for s in PROGRESS_SHARES}
    ratios = {s: {c: [] for c in cols} for s in PROGRESS_SHARES}
    used = {s: 0 for s in PROGRESS_SHARES}
    for year, rnd in races:
        payload = pc._load_payload(year, rnd)
        if payload is None:
            continue
        ll = leader_lap_times(payload['lap_times'])
        if not ll:
            continue
        total = max(ll)
        post = df[(df['year'] == year) & (df['round'] == rnd)].set_index('driver')
        for share in PROGRESS_SHARES:
            lap = max(1, int(round(share * total)))
            if lap not in ll:
                continue
            rows = pc.race_feature_rows(payload, year, rnd, session_now=ll[lap][1] + 1.0)
            rows = [r for r in rows if r['driver'] in post.index]
            if len(rows) < MIN_ROWS:
                continue
            used[share] += 1
            drivers = [r['driver'] for r in rows]
            for c in cols:
                now_vals = np.array([r[c] for r in rows], dtype=float)
                post_vals = post.loc[drivers, c].to_numpy(dtype=float)
                ok = ~np.isnan(now_vals) & ~np.isnan(post_vals)
                if ok.sum() < MIN_ROWS or not sd[c] > 0:
                    continue
                shifts[share][c].append((now_vals[ok].mean() - post_vals[ok].mean()) / sd[c])
                if post_vals[ok].std(ddof=1) > 0:
                    ratios[share][c].append(now_vals[ok].std(ddof=1) / post_vals[ok].std(ddof=1))
    nan = float('nan')
    table = {}
    for c in cols:
        table[c] = {}
        for s in PROGRESS_SHARES:
            v, q = np.array(shifts[s][c]), np.array(ratios[s][c])
            table[c][s] = (float(np.median(v)) if len(v) else nan,
                           float(np.median(np.abs(v))) if len(v) else nan,
                           float(np.median(q)) if len(q) else nan)
    return {'rows': len(df), 'races': len(races), 'used': used, 'table': table}


def moves(cells):
    """The criterion on one feature's {share: (shift, |shift|, ratio)}."""
    return any(a >= SHIFT_MIN or (r == r and not 1 / SPREAD_MAX <= r <= SPREAD_MAX)
               for _, a, r in cells.values())


def moving_features(measured=None):
    m = measured or measure()
    return [c for c, cells in m['table'].items() if moves(cells)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    lines = []

    def say(s=''):
        print(s, flush=True)
        lines.append(s)

    m = measure()
    say(f'matrix: {m["rows"]} rows, {m["races"]} races; rows at the clock just after the leader completed '
        f'{", ".join(f"{s:.0%}" for s in PROGRESS_SHARES)} of the laps vs the same race\'s post-race rows '
        f'(same drivers)')
    say(f'races used per share: {", ".join(f"{s:.0%} {m["used"][s]}" for s in PROGRESS_SHARES)}')
    say('shift = mean at the clock minus post-race mean, in SDs of the feature over the matrix; '
        'ratio = SD at the clock / post-race SD; medians over the races')
    say(f'criterion: median |shift| >= {SHIFT_MIN} or median ratio outside [{1 / SPREAD_MAX:.2f}, {SPREAD_MAX:.2f}] '
        f'at some share')
    head = ''.join(f'{f"shift {s:.0%}":>12}{f"|shift| {s:.0%}":>13}{f"ratio {s:.0%}":>12}' for s in PROGRESS_SHARES)
    say(f'{"feature":<24}{head}')
    for c, cells in m['table'].items():
        say(f'{c:<24}' + ''.join(f'{v:12.3f}{a:13.3f}{r:12.2f}' for v, a, r in (cells[s] for s in PROGRESS_SHARES)))
    say()
    moving = moving_features(m)
    declared = list(getattr(pc, 'PROGRESS_DEPENDENT_FEATURES', []))
    say(f'features meeting the criterion: {moving}')
    say(f'pca_compute.PROGRESS_DEPENDENT_FEATURES: {declared}')
    say(f'same set: {set(moving) == set(declared)}')
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
