"""
S4 / lead decision D5, the assistant's strategy cards: how often a card's
finishing position ('Finish P{n}', GeminiAssistant.jsx renders
scenario.projected_position) changes when the same race state is recomputed
with another Monte Carlo seed.

Input: the store-shaped contexts written by frontend/scripts/
s4_assistant_contexts.mjs (every cached race x 25 / 50 / 75 % of the
distance x 10 seeds, chained as the store chains its projections). Each
context is sent through the route's answer for this environment (no
GEMINI_API_KEY: the labelled heuristic fallback, api/routers/gemini.py
gemini_strategy -> _heuristic_fallback), once per query kind of the
heuristic, with each of the 10 drivers whose Monte Carlo row is sent as the
focus driver. A change = any card's projected_position of that (driver,
query) differs from the previous seed's.

Two columns:
  - as sent (the store's context: medianPos present): the cards read
    medianPos, the Race Prediction panel's P label (_projected_position);
  - without medianPos (an older client, and the checkpoint's rule): the
    cards read round(expectedPos), the raw Monte Carlo mean.

Run from backend/:
    python -m scripts.s4_assistant_cards --contexts CONTEXTS.json [--out REPORT.txt]
"""
import argparse
import asyncio
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
os.environ.pop('GEMINI_API_KEY', None)

from api.routers.gemini import GeminiRequest, gemini_strategy  # noqa: E402

# One query per branch of the heuristic (api/routers/gemini.py _mock_response)
QUERIES = ['compare strategy options', 'undercut?', 'pit now or extend?', 'attack or defend?', 'risk?',
           'how is it going?']
TARGET_PCT = 5
LOOP = asyncio.new_event_loop()


def cards(ctx, driver, query, lap):
    req = GeminiRequest(query=query, year=None, round=None, session_type='R', current_lap=lap,
                        drivers=[driver], race_context=ctx)
    data = LOOP.run_until_complete(gemini_strategy(req))
    assert data.get('fallback') == 'heuristic', data.get('fallback')
    return tuple(s.get('projected_position') for s in data.get('scenarios', []))


def without_median(ctx):
    c = copy.deepcopy(ctx)
    for p in c.get('monteCarloProjections') or []:
        p.pop('medianPos', None)
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--contexts', required=True)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    with open(args.contexts, encoding='utf-8') as fh:
        data = json.load(fh)
    lines = []

    def out(s=''):
        lines.append(s)
        print(s)

    cols = {'sent': {'pairs': 0, 'changed': 0, 'any': 0, 'with_cards': 0},
            'no_median': {'pairs': 0, 'changed': 0, 'any': 0, 'with_cards': 0}}
    panel = {'pairs': 0, 'disagree': 0}
    recomputes = 0
    examples = []
    for state in data['states']:
        seeds = state['seeds']
        lap = state['lap']
        prev = None
        for k, ctx in enumerate(seeds):
            variants = {'sent': ctx, 'no_median': without_median(ctx)}
            rows = {p['driver']: p for p in ctx['monteCarloProjections']}
            now = {}
            for col, c in variants.items():
                now[col] = {(d, q): cards(c, d, q, lap) for d in rows for q in QUERIES}
            # the 'hold position' card (compare: 1-Stop Standard) against the panel's P label
            for d, p in rows.items():
                panel['pairs'] += 1
                if now['sent'][(d, QUERIES[0])][0] != p['medianPos']:
                    panel['disagree'] += 1
            if prev is not None:
                recomputes += 1
                for col in cols:
                    any_changed = False
                    for key, cur in now[col].items():
                        if key not in prev[col]:
                            continue
                        if not cur and not prev[col][key]:
                            continue
                        cols[col]['with_cards'] += 1
                        if cur != prev[col][key]:
                            cols[col]['changed'] += 1
                            any_changed = True
                            if col == 'sent' and len(examples) < 8:
                                examples.append(f"{state['file']} L{lap} {key[0]} '{key[1]}' seed {k - 1}->{k}: "
                                                f"cards {prev[col][key]} -> {cur}")
                    cols[col]['pairs'] += 1
                    if any_changed:
                        cols[col]['any'] += 1
            prev = now

    def pc(a, b):
        return f"{a} / {b} ({100 * a / b:.2f}%)" if b else f"{a} / 0"

    out("S4 / D5, the assistant's strategy cards (api/routers/gemini.py heuristic fallback through gemini_strategy):")
    out(f"same state, a new seed per recompute: {len(data['states'])} states (cached races x 25/50/75 %) x "
        f"{data['seeds']} seeds (salt '{data['salt']}'), {recomputes} recomputes; each of the 10 drivers sent as the "
        f"focus x {len(QUERIES)} query kinds")
    out(f"target: <= {TARGET_PCT} % of the (driver, query) cards change")
    out('')
    for col, label in (('sent', "as sent (medianPos, the panel's P label)"),
                       ('no_median', 'without medianPos (round(expectedPos), the checkpoint rule)')):
        c = cols[col]
        pct = 100 * c['changed'] / c['with_cards'] if c['with_cards'] else 0
        out(f"  {label}:")
        out(f"    a (driver, query)'s card P changed: {pc(c['changed'], c['with_cards'])} "
            f"{'ok' if pct <= TARGET_PCT else 'OVER'}")
        out(f"    any card of any of the 10 drivers changed: {pc(c['any'], c['pairs'])}")
    out('')
    out(f"'1-Stop Standard' card P (hold position) != the panel's P label (medianPos) of that driver: "
        f"{pc(panel['disagree'], panel['pairs'])}")
    if examples:
        out('')
        out('examples of a change, as sent:')
        for e in examples:
            out(f'  {e}')
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
