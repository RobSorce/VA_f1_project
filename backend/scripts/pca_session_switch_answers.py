"""
The backend's own answers for frontend/scripts/pca_session_switch_check.mjs
(the PCA answers across a session switch, P3 / P6): analyze_selection of the
19 rows of 2024 R16 post-race (no clock) and with the race clock 0 (another
session of that weekend on screen); the embeddings at clock 0.

Run from backend/:
    python -m scripts.pca_session_switch_answers
Writes notes/experiments/phase67/pca_session_switch_answers.json.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))

from data.processors import pca_compute as pc  # noqa: E402

OUT = os.path.join(HERE, '..', '..', 'notes', 'experiments', 'phase67', 'pca_session_switch_answers.json')


def main():
    emb = pc.load_pca_embeddings()
    ids = [p['id'] for p in emb['points'] if p['year'] == 2024 and p['round'] == 16]
    post = pc.analyze_selection(ids)
    at0 = pc.analyze_selection(ids, None, 2024, 16, 0)
    emb0 = pc.pca_embeddings_at(2024, 16, 0)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'ids': ids, 'post': post, 'at0': at0, 'emb0_current_race': emb0['current_race']}, f)
    print('ids', len(ids))
    print('post-race: n_selected', post['n_selected'],
          'pit_windows', [(w['lap_start'], w['lap_end'], w['count']) for w in post['pit_windows']])
    print('clock 0: n_selected', at0['n_selected'], 'pit_windows', at0['pit_windows'],
          'strategies', at0['strategies'], 'current_race', at0.get('current_race'))


if __name__ == '__main__':
    main()
