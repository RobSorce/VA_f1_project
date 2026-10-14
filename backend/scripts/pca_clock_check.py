"""
The cross-race PCA at the clock of the session on screen (P6 repair): what
the biplot and the lasso analysis return for a replay of 2024 R16 (Monza) at
lap 10, at its end, and while another session of that weekend is on screen
(the race not started: session_now 0, the frontend's store pcaRequestOf).

Run from backend/:
    python -m scripts.pca_clock_check [--out REPORT.txt]

Sections:
1. biplot (pca_embeddings_at): current_race at lap 10, its points' as_of and
   finishing positions; at session_now 0 (race not started);
2. lasso of the 2024 R16 stars at lap 10: the post-race call the store made
   before (no year / round / session_now) against the call at the clock:
   pit windows, top strategies, current_race and the summary's last sentence;
3. the same ids with the race not started (session_now 0).
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402
from data.processors.stints import leader_lap_times  # noqa: E402

YEAR, ROUND, LAP = 2024, 16, 10


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    lines = []

    def out(s=''):
        lines.append(s)
        print(s)

    payload = pc._load_payload(YEAR, ROUND)
    now = leader_lap_times(payload['lap_times'])[LAP][1] + 1.0
    out(f'== 1. Biplot of {YEAR} R{ROUND} at the clock (pca_embeddings_at) ==')
    out(f'clock: end of leader lap {LAP} + 1 s = session second {now:.2f}')
    emb = pc.pca_embeddings_at(YEAR, ROUND, now)
    cur = [p for p in emb['points'] if p['year'] == YEAR and p['round'] == ROUND]
    out(f"current_race: {emb['current_race']}")
    out(f"its points: {len(cur)}; as_of {sorted({p['as_of'] for p in cur})}; as_of_lap {sorted({p['as_of_lap'] for p in cur})}; "
        f"finish_position {sorted({str(p['finish_position']) for p in cur})}")
    before = pc.pca_embeddings_at(YEAR, ROUND, 0.0)
    out(f"race not started (session_now 0): current_race n_points {before['current_race']['n_points']}, "
        f"as_of_lap {before['current_race']['as_of_lap']}, points of the race drawn "
        f"{sum(1 for p in before['points'] if p['year'] == YEAR and p['round'] == ROUND)}, other points {len(before['points'])}")

    ids = [p['id'] for p in cur]
    out('')
    out(f'== 2. Lasso of the {len(ids)} stars of {YEAR} R{ROUND} at lap {LAP} ==')
    for name, kwargs in [('post-race call (the store before the repair)', {}),
                         ('call at the clock (the store now)', {'year': YEAR, 'round_num': ROUND, 'session_now': now})]:
        res = pc.analyze_selection(ids, None, **kwargs)
        out(f'{name}:')
        out(f"  n_selected {res['n_selected']}; current_race {res.get('current_race')}")
        out(f"  pit_windows {[(w['lap_start'], w['lap_end'], w['count']) for w in res['pit_windows']]}")
        out(f"  strategies {[('-'.join(s['compound'] for s in st['stints']), st['count']) for st in res['strategies']]}")
        out(f"  longest stint end lap {max((s['lap_start'] + s['length'] - 1 for st in res['strategies'] for s in st['stints']), default=None)}")
        out(f"  summary: {res['summary']}")

    out('')
    out(f'== 3. The same ids, the race not started (another session of the weekend on screen: session_now 0) ==')
    res = pc.analyze_selection(ids + ['VER_2024_1'], None, YEAR, ROUND, 0.0)
    out(f"  n_selected {res['n_selected']} (of {len(ids) + 1} ids); current_race {res.get('current_race')}")
    out(f"  pit_windows {[(w['lap_start'], w['lap_end'], w['count']) for w in res['pit_windows']]}")

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
