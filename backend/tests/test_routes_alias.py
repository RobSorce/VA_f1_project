"""t-SNE leftovers in the API.

The dashboard's one projection is the PCA. Every /api/tsne/... path is a
former route name kept as an alias of its /api/pca/... route (same answer);
no route reads a t-SNE file any more, and processed/tsne_embeddings.json is
gone. In api/main.py the words t-SNE / tsne appear only on the alias routes
and the comment that names them as aliases.
"""
import asyncio
import re

from conftest import BACKEND
from data.processors import pca_compute as pc

MAIN = BACKEND / 'api' / 'main.py'
ALIASES = {
    '/api/tsne/embeddings': '/api/pca/embeddings',
    '/api/tsne/analyze-selection': '/api/pca/analyze-selection',
    '/api/tsne/point-features/{point_id}': '/api/pca/point-features/{point_id}',
}


def _routes():
    import api.main as main
    return main, {getattr(r, 'path', None): r for r in main.app.routes}


def test_every_former_route_is_an_alias_of_a_pca_route():
    main, routes = _routes()
    for old, new in ALIASES.items():
        assert old in routes, old
        assert new in routes, new
        assert routes[old].methods == routes[new].methods, old
    tsne_paths = sorted(p for p in routes if p and '/tsne/' in p)
    assert tsne_paths == sorted(ALIASES)


def test_aliases_answer_as_the_pca_routes():
    main, _ = _routes()
    assert asyncio.run(main.get_embeddings_former_route()) == asyncio.run(main.get_pca_embeddings())
    req = main.PCAAnalyzeRequest(point_ids=['LEC_2024_16', 'PIA_2024_16', 'NOR_2024_16'])
    assert asyncio.run(main.analyze_tsne_selection(req)) == asyncio.run(main.analyze_pca_selection(req))
    old = asyncio.run(main.get_point_features_former_route('LEC_2024_16'))
    assert old == asyncio.run(main.get_point_features('LEC_2024_16'))
    assert set(old['features']) == set(pc.FEATURE_COLS)


def test_no_tsne_file_is_read():
    main, _ = _routes()
    assert not hasattr(main, 'load_embeddings')
    assert not (BACKEND / 'data' / 'processed' / 'tsne_embeddings.json').exists()
    # the former embeddings route answers with the PCA biplot (loadings, PC labels)
    out = asyncio.run(main.get_embeddings_former_route())
    assert 'loadings' in out and 'pc1_label' in out


def test_main_mentions_tsne_only_on_aliases():
    lines = MAIN.read_text(encoding='utf-8').split('\n')
    hits = [(i, l) for i, l in enumerate(lines) if re.search(r't-sne|tsne', l, re.I)]
    assert hits
    for i, line in hits:
        s = line.strip()
        alias_route = s.startswith('@app.') and '/api/tsne/' in s
        alias_def = s.startswith('async def ') and 'Alias of' in lines[i + 1]
        comment = s.startswith('#') and re.search(r'alias|former|why pca and not t-sne|projection itself was removed', s, re.I)
        assert alias_route or alias_def or comment, f'main.py:{i + 1}: {s}'
    print('\n'.join(f'main.py:{i + 1}: {l.strip()}' for i, l in hits))
