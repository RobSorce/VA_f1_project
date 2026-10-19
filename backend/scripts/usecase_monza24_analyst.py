"""
Backend half of the use case "Monza 2024, data analyst: post-race debrief of
the strategy split" (frontend/scripts/usecases/uc2_monza24_analyst.mjs runs
this script and prints its answers in docs/evidence/usecase_uc2_monza24_analyst.txt).

Run from backend/ (backend virtual environment):
    python -m scripts.usecase_monza24_analyst [--ids IDS.json] [--json FILE]
Writes FILE (JSON); without --json it prints the JSON. --ids: the id lists
of the selections ({name: [ids]}) in the order the frontend's lasso and
clicks produce them, for the answers of 1. (default: the matrix order). Read-only
on the data.

Selections (the rows of 2024 R16 in the served feature matrix,
processed/pca_feature_matrix.csv): A = the one-stoppers (pit_count 1),
B = the two-or-more-stoppers (pit_count >= 2), C = all of them, and the
click selections LEC, LEC + SAI, PIA + NOR.

1. post: pca_compute.analyze_selection(ids) with no clock, the function
   POST /api/pca/analyze-selection runs for the race on screen at its end
   (store pcaRequestOf params null): what the local app's Cross-Race Analysis
   panel shows. The frontend script compares it with the static demo's
   answer (utils/pcaSelectionStats.js).
2. served: the post-race biplot (pca_embeddings.json, GET /api/pca/embeddings
   with no clock): axis labels, explained variance and every point.
3. archives: NOT what the dashboard shows. The dashboard fits its axes on, and
   compares the selection with, every cached race, including races run after
   Monza 2024 (2024 R17-R24 and the 2025 rounds). The same readings with the
   archive restricted to the races run by a date: the axes refitted with
   pca_compute.fit_pca (the backend's scaler, PCA(2) and sign rule; signs
   matched to the served loadings) and projected with pca_compute._project;
   the panel's statistics with pca_compute.feature_differences, the function
   analyze_selection calls, and its label with _generate_cluster_label. The
   full archive is run the same way as a check (it must give the served
   numbers).
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402

YEAR, ROUND = 2024, 16


def clean(o):
    """JSON-safe copy: numpy scalars to Python, NaN / inf to None."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float) and (math.isnan(o) or math.isinf(o)):
        return None
    return o


def hull_intruders(points, selected_ids, visible_ids):
    """Visible points that are NOT selected but lie inside the convex hull of
    the selected ones (biplot coordinates). Empty = a lasso drawn around the
    selection's hull catches exactly it among the visible points
    (PCABiplot.jsx: the lasso tests the points drawn). points: {id: (x, y)}."""
    from scipy.spatial import Delaunay
    sel = [points[i] for i in selected_ids if i in points]
    if len(sel) < 3:
        return []
    tri = Delaunay(np.array(sel))
    chosen = set(selected_ids)
    others = [i for i in visible_ids if i not in chosen]
    if not others:
        return []
    inside = tri.find_simplex(np.array([points[i] for i in others])) >= 0
    return [i for i, f in zip(others, inside) if f]


def selections(df):
    race = df[(df['year'] == YEAR) & (df['round'] == ROUND)]
    return {
        'A': race[race['pit_count'] == 1]['id'].tolist(),
        'B': race[race['pit_count'] >= 2]['id'].tolist(),
        'C': race['id'].tolist(),
        'LEC': ['LEC_2024_16'],
        'LEC+SAI': ['LEC_2024_16', 'SAI_2024_16'],
        'PIA+NOR': ['PIA_2024_16', 'NOR_2024_16'],
    }


def panel_on(sub, ids):
    """The panel's numbers for a selection against the archive rows `sub`."""
    sub = sub.reset_index(drop=True).assign(as_of=pc.ROW_FINISHED)
    sel = sub['id'].isin(ids).to_numpy()
    d = pc.feature_differences(sub, sel)
    fi = d['feature_importance']
    return {
        'n_rows': int(len(sub)),
        'n_selected': int(sel.sum()),
        'threshold': d['baseline']['max_p95'],
        'threshold_rule': d['threshold_rule'],
        'cluster_label': pc._generate_cluster_label(fi),
        'n_above': int(sum(1 for r in fi if r['exceeds_random'])),
        'rows': [{k: r[k] for k in ('feature', 'label', 'g', 'ci_low', 'ci_high', 'baseline_abs_g',
                                    'threshold_abs_g', 'exceeds_random', 'selected_mean', 'rest_mean')}
                 for r in fi],
    }


def geometry_on(sub, reference, groups, race_ids):
    """Axes fitted on the archive rows `sub`; PC2 of each group; intruders."""
    sub = sub.reset_index(drop=True)
    fit = pc.fit_pca(sub, reference)
    P = pc._project(sub, fit)
    loads = pc._loadings(fit)
    pts = {i: (float(P[k, 0]), float(P[k, 1])) for k, i in enumerate(sub['id'])}
    out = {
        'pc1_label': pc._axis_label(loads, 0),
        'pc2_label': pc._axis_label(loads, 1),
        'explained': [float(v) for v in fit['pca'].explained_variance_ratio_],
        'groups': {},
    }
    for name in ('A', 'B'):
        ys = [pts[i][1] for i in groups[name]]
        out['groups'][name] = {
            'y_min': min(ys), 'y_max': max(ys),
            'intruders_this_race': hull_intruders(pts, groups[name], race_ids),
            'intruders_all_rows': len(hull_intruders(pts, groups[name], list(pts))),
        }
    out['gap_A_min_minus_B_max'] = out['groups']['A']['y_min'] - out['groups']['B']['y_max']
    return out


def _option(argv, name):
    if name not in argv:
        return None
    i = argv.index(name)
    if i + 1 >= len(argv):
        raise SystemExit(f'{name} needs a file name')
    return argv[i + 1]


def main(argv):
    json_out = _option(argv, '--json')
    ids_in = _option(argv, '--ids')

    df = pc._load_matrix()
    df['id'] = df['driver'] + '_' + df['year'].astype(int).astype(str) + '_' + df['round'].astype(int).astype(str)
    emb = pc.load_pca_embeddings()
    sels = selections(df)
    # The id lists as the frontend's lasso / clicks produce them (their order
    # decides which of two equally common patterns is listed first)
    asked = sels
    if ids_in:
        with open(ids_in, encoding='utf-8') as f:
            asked = {**sels, **json.load(f)}

    post = {name: pc.analyze_selection(ids) for name, ids in asked.items()}

    by_feat = {l['feature']: l for l in emb['loadings']}
    cols = [c for c in pc.FEATURE_COLS if c in df.columns]
    reference = [[by_feat[c][f'pc{k + 1}'] for c in cols] for k in range(2)]
    archives = [
        ('end of Monza 2024: 2024 R1-R16',
         (df['year'] == 2024) & (df['round'] <= 16)),
        ('before Monza 2025: 2024 R1-R24, 2025 R1, R6, R8',
         (df['year'] == 2024) | ((df['year'] == 2025) & (df['round'] < 16))),
        ('full archive, as the dashboard (check)',
         df['year'].notna()),
    ]
    out_archives = []
    for label, mask in archives:
        sub = df[mask]
        races = sorted({(int(y), int(r)) for y, r in zip(sub['year'], sub['round'])})
        out_archives.append({
            'label': label,
            'n_rows': int(len(sub)),
            'n_races': len(races),
            'races': [f'{y} R{r}' for y, r in races],
            'geometry': geometry_on(sub, reference, sels, sels['C']),
            'panels': {name: panel_on(sub, ids) for name, ids in sels.items()},
        })

    result = clean({
        'selections': sels,
        'served': {
            'n_points': len(emb['points']),
            'pc1_label': emb['pc1_label'],
            'pc2_label': emb['pc2_label'],
            'explained': emb['explained_variance'],
            'points': {p['id']: [p['x'], p['y']] for p in emb['points']},
        },
        'post': post,
        'archives': out_archives,
    })
    text = json.dumps(result)
    if json_out:
        with open(json_out, 'w', encoding='utf-8') as f:
            f.write(text)
    else:
        print(text)


if __name__ == '__main__':
    main(sys.argv[1:])
