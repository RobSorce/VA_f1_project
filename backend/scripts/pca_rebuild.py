"""
Rebuild the cross-race PCA artefacts from every cached race and report what
went into them.

Run from backend/:
    python -m scripts.pca_rebuild [--out REPORT.txt]

Writes data/processed/pca_feature_matrix.csv, pca_embeddings.json and
tsne_embeddings.json (data/processors/pca_compute.py), then prints:
- rows, races, and the (driver, race) pairs left out by the eligibility rule
  (MIN_LAP_SHARE of the leader's laps, MIN_CLEAN_LAPS clean laps);
- explained variance and eta^2(race) of PC1 / PC2 (share of the PC variance
  explained by race identity) and the PC loadings;
- the pit-window lap check (P7): share of R2 stops whose in-lap (the last lap
  of the previous stint, the lap the pit windows use) carries PitInTime.
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402
from data.processors.stints import _group_by_driver, _is_set, build_tyre_strategy  # noqa: E402


def run(out=None):
    lines = []

    def emit(s=''):
        lines.append(s)
        print(s)

    df = pc.build_feature_matrix_from_cache()
    pca = pc.compute_pca(df)
    tsne = pc.compute_tsne(df)

    excluded, drivers, stops, stops_pit_in = [], 0, 0, 0
    for sf in sorted(pc.CACHE_DIR.glob('session_*_R.json')):
        m = re.match(r'session_(\d+)_(\d+)_R\.json', sf.name)
        if not m:
            continue
        with open(sf, encoding='utf-8') as fh:
            payload = json.load(fh)
        rows = [lap for lap in payload.get('lap_times') or [] if isinstance(lap, dict) and lap.get('Driver')]
        grouped = _group_by_driver(rows)
        drivers += len(grouped)
        pc.race_feature_rows(payload, int(m.group(1)), int(m.group(2)), excluded=excluded)
        by_driver = {}
        for st in build_tyre_strategy(rows):
            by_driver.setdefault(st['Driver'], []).append(st)
        for drv, sts in by_driver.items():
            laps = {int(lap['LapNumber']): lap for lap in grouped.get(drv, [])}
            for st in pc.visible_stints(grouped.get(drv, []), sts):
                if st['InLap']:
                    stops += 1
                    lap = laps.get(st['InLap'], {})
                    stops_pit_in += _is_set(lap.get('PitInTimeSeconds')) or _is_set(lap.get('PitInTime'))

    n_laps = sum(1 for _, r in excluded if r == 'laps')
    n_clean = sum(1 for _, r in excluded if r == 'clean_laps')
    emit(f'rows: {len(df)} (driver, race) from {df.groupby(["year", "round"]).ngroups} cached races; '
         f'{drivers} (driver, race) pairs with lap rows')
    emit(f'left out: {n_laps} below {pc.MIN_LAP_SHARE:.0%} of the leader\'s laps, '
         f'{n_clean} with fewer than {pc.MIN_CLEAN_LAPS} clean laps')
    emit(f'features ({len(pca["feature_cols"])}): {", ".join(pca["feature_cols"])}')
    emit(f'PCA explained variance: PC1 {pca["explained_variance"][0]:.3f}, PC2 {pca["explained_variance"][1]:.3f} '
         f'(sum {sum(pca["explained_variance"]):.3f})')
    emit(f'eta2(race): PC1 {pca["eta2_race"][0]:.3f}, PC2 {pca["eta2_race"][1]:.3f}')
    emit(f'axis labels: PC1 "{pca["pc1_label"]}", PC2 "{pca["pc2_label"]}"')
    emit('loadings (PC1, PC2):')
    for l in pca['loadings']:
        emit(f'  {l["feature"]:<23s} {l["pc1"]:7.3f} {l["pc2"]:7.3f}')
    emit(f't-SNE points: {tsne["n_points"]}')
    emit(f'R2 stops (stint boundaries): {stops}; in-lap carries PitInTime: {stops_pit_in} '
         f'({stops_pit_in / stops:.1%})' if stops else 'R2 stops: 0')
    if out:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        with open(out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', default=None, help='also write the report to this file')
    run(ap.parse_args().out)


if __name__ == '__main__':
    main()
