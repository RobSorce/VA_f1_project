// V12, the static demo's light analytics: utils/pcaSelectionStats.js (the
// lasso analysis of POST /api/pca/analyze-selection and the biplot at a
// replay clock of GET /api/pca/embeddings) and utils/demoData.js
// degradationResponse (POST /api/predict/degradation) give the backend's
// answer on the same input. The input is the demo export
// (frontend/public/data: the post-race matrix, the stints, the basis fitted
// without each demo race, the session payloads); the Python side is the
// backend module itself (backend venv: pca_compute.analyze_selection,
// pca_embeddings_at, predictions.degradation_response), executed here,
// nothing hard-coded. Every number equal to 1e-9 (relative above 1), every
// text and key equal, the seeded random baseline draw for draw (numpy's
// default_rng). Skips without the venv or the git-ignored cache.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as PS from '../utils/pcaSelectionStats.js';
import { degradationResponse, PIT_DEG_THRESHOLD_S, UNDERCUT_WINDOW_LAPS_BEFORE, UNDERCUT_WINDOW_LAPS_AFTER } from '../utils/demoData.js';
import { leaderLapEndTime } from '../utils/raceTime.js';
import { hasCachedSession } from './helpers/cachedSession.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '../../../backend');
const DATA = path.resolve(HERE, '../../public/data');
const OUT_FILE = path.resolve(HERE, '../../../notes/experiments/phase9/demo/pca_selection_parity.txt');
const PYTHON = [
  path.join(BACKEND, '.venv', 'Scripts', 'python.exe'),
  path.join(BACKEND, '.venv', 'bin', 'python'),
].find((p) => fs.existsSync(p));
const parseJson = (t) => JSON.parse(t.replace(/([:\[,]\s*)-?(NaN|Infinity)\b/g, '$1null'));
const readData = (rel) => {
  const b = fs.readFileSync(path.join(DATA, rel));
  return JSON.parse((rel.endsWith('.gz') ? zlib.gunzipSync(b) : b).toString('utf8'));
};
const MANIFEST = fs.existsSync(path.join(DATA, 'manifest.json')) ? readData('manifest.json') : { races: [] };
const RACES = MANIFEST.races || [];
const READY = Boolean(PYTHON) && RACES.length > 0 && RACES.every((r) => hasCachedSession(r.year, r.round));

const PY = `
import json, math, sys
sys.path.insert(0, '.')
import numpy as np
from data.processors import pca_compute as pc
from api.routers.predictions import degradation_response, PIT_DEG_THRESHOLD_S, UNDERCUT_WINDOW_LAPS_BEFORE, UNDERCUT_WINDOW_LAPS_AFTER
req = json.load(sys.stdin)
out = {'constants': {k: getattr(pc, k) for k in req['constants']}}
out['constants'].update({'PIT_DEG_THRESHOLD_S': PIT_DEG_THRESHOLD_S,
                         'UNDERCUT_WINDOW_LAPS_BEFORE': UNDERCUT_WINDOW_LAPS_BEFORE,
                         'UNDERCUT_WINDOW_LAPS_AFTER': UNDERCUT_WINDOW_LAPS_AFTER})
for k, v in list(out['constants'].items()):
    if isinstance(v, tuple):
        out['constants'][k] = list(v)
out['rng'] = np.random.default_rng(req['rng']['seed']).random(req['rng']['n']).tolist()
b = req['baseline']
base = pc.random_selection_baseline(np.array(b['values'], dtype=float), b['n_selected'], strata=b.get('strata'))
out['baseline'] = base
out['g'] = [[pc.hedges_g(x, y), list(pc.g_interval(x, y))] for x, y in req['g']]
out['embeddings'] = [pc.pca_embeddings_at(e['year'], e['round'], e['session_now']) for e in req['embeddings']]
out['analyze'] = [pc.analyze_selection(a['ids'], None, a.get('year'), a.get('round'), a.get('session_now'))
                  for a in req['analyze']]
out['degradation'] = []
for d in req['degradation']:
    payload = pc._load_payload(d['year'], d['round'])
    out['degradation'].append(degradation_response(payload.get('lap_times') or [], d['drivers'], d['lap_start'],
                                                   d['lap_end'], session_now=d['session_now'],
                                                   session_type=d['session_type']))
print(json.dumps(out))
`;

/** Differences of a (JS) against b (Python): numbers to 1e-9 (relative above 1). */
function diff(a, b, at, out, stat) {
  if (typeof a === 'number' && typeof b === 'number') {
    const d = Math.abs(a - b);
    if (Number.isFinite(d)) stat.max = Math.max(stat.max, d / Math.max(1, Math.abs(b)));
    stat.numbers += 1;
    if (!(d <= 1e-9 * Math.max(1, Math.abs(b))) && !(Number.isNaN(a) && Number.isNaN(b))) out.push(`${at}: ${a} != ${b}`);
    return;
  }
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a === 'string') stat.texts += 1;
    if (a !== b && !(a == null && b == null)) out.push(`${at}: ${JSON.stringify(a)?.slice(0, 200)} != ${JSON.stringify(b)?.slice(0, 200)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(`${at}: array / object`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) { out.push(`${at}: length ${a.length} != ${b.length}`); return; }
    a.forEach((v, i) => diff(v, b[i], `${at}[${i}]`, out, stat));
    return;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) out.push(`${at}: keys ${ka.join()} != ${kb.join()}`);
  for (const k of kb) if (k in a) diff(a[k], b[k], `${at}.${k}`, out, stat);
}

const OUT = [];
afterAll(() => {
  if (OUT.length && fs.existsSync(path.dirname(OUT_FILE))) fs.writeFileSync(OUT_FILE, `${OUT.join('\n')}\n`);
});

describe('the comparison of this file', () => {
  it('catches a number off by more than 1e-9, a changed text and a missing key', () => {
    const out = [];
    const stat = { max: 0, numbers: 0, texts: 0 };
    diff({ a: 1 + 2e-9, t: 'x', k: 1 }, { a: 1, t: 'y', k: 1, m: 2 }, 'r', out, stat);
    expect(out.length).toBe(3);
    const ok = [];
    diff({ a: 1 + 5e-10, b: [null] }, { a: 1, b: [null] }, 'r', ok, stat);
    expect(ok).toEqual([]);
  });
});

describe.skipIf(!READY)('V12: the demo analytics == the backend (pca_compute, degradation_response), same input', () => {
  it('rng, baseline, g, biplot at a replay clock, lasso analysis and degradation fits to 1e-9', () => {
    const matrix = readData('pca/matrix.json.gz');
    const strategies = readData('pca/strategies.json.gz');
    const post = readData('pca/embeddings.json.gz');
    const races = RACES.map((r) => {
      const payload = readData(`${r.year}_${r.round}_R/session.json.gz`);
      const laps = payload.lap_times || [];
      let maxLap = 0;
      let maxEnd = 0;
      for (const lt of laps) {
        maxLap = Math.max(maxLap, Number(lt.LapNumber) || 0);
        if (Number.isFinite(lt.Time)) maxEnd = Math.max(maxEnd, lt.Time);
      }
      return {
        ...r,
        payload,
        fitWithout: readData(`pca/fit_without_${r.year}_${r.round}.json.gz`),
        // before the start, a third, two thirds, post-race, after the flag
        clocks: [0, leaderLapEndTime(laps, Math.round(maxLap / 3)), leaderLapEndTime(laps, Math.round((2 * maxLap) / 3)),
          null, maxEnd + 60],
        maxLap,
      };
    });

    // ── the inputs, built from the JS side's own answers ──
    const embeddingCases = [];
    const analyzeCases = [];
    const degradationCases = [];
    const finished = post.points.filter((p) => !(RACES.some((r) => r.year === p.year && r.round === p.round)));
    const fast = post.points.filter((p) => ['VER', 'NOR', 'LEC'].includes(p.driver) && p.year === 2024).map((p) => p.id);
    analyzeCases.push({ ids: fast });                                            // post-race, no race on screen
    analyzeCases.push({ ids: [fast[0]] });                                       // one row: no interval
    analyzeCases.push({ ids: ['XXX_1999_1', 'not-an-id'] });                     // no row
    analyzeCases.push({ ids: post.points.map((p) => p.id) });                    // every row
    for (const r of races) {
      const sorted = [...r.payload.race_results || []].sort((a, b) => (a.Position ?? 99) - (b.Position ?? 99));
      const drivers = sorted.slice(0, 3).map((d) => d.Abbreviation);
      r.clocks.forEach((now, k) => {
        embeddingCases.push({ year: r.year, round: r.round, session_now: now });
        const emb = PS.embeddingsAt(r.fitWithout, r.payload, r.year, r.round, r.race_name, now);
        const own = emb.points.filter((p) => p.year === r.year && p.round === r.round).map((p) => p.id).sort();
        const half = own.slice(0, Math.ceil(own.length / 2));
        const others = finished.slice(k * 7, k * 7 + 6).map((p) => p.id);
        analyzeCases.push({ ids: [...half, ...others], year: r.year, round: r.round, session_now: now }); // mixed kinds
        if (k === 1 || k === 2) {
          analyzeCases.push({ ids: half, year: r.year, round: r.round, session_now: now });  // race rows only
          analyzeCases.push({ ids: own, year: r.year, round: r.round, session_now: now });   // all of them: no alternative
          analyzeCases.push({ ids: others, year: r.year, round: r.round, session_now: now }); // finished rows only
        }
        if (now !== 0) {
          degradationCases.push({ year: r.year, round: r.round, drivers, lap_start: 1, lap_end: r.maxLap, session_now: now, session_type: 'R' });
        }
      });
      degradationCases.push({ year: r.year, round: r.round, drivers, lap_start: 10, lap_end: 25, session_now: null, session_type: 'R' });
      degradationCases.push({ year: r.year, round: r.round, drivers, lap_start: 2, lap_end: 6, session_now: null, session_type: 'R' });
      degradationCases.push({ year: r.year, round: r.round, drivers: [drivers[1], 'ZZZ'], lap_start: 1, lap_end: r.maxLap, session_now: null, session_type: 'Q' });
    }
    // a stratified baseline on a small matrix with missing values
    const values = matrix.rows.slice(0, 60).map((row) => matrix.feature_cols.map((c) => {
      const v = row[matrix.columns.indexOf(c)];
      return v == null ? NaN : v;
    }));
    const strata = values.map((_, i) => (i % 3 === 0 ? 'session_now' : 'post-race'));
    const nSelected = { 'post-race': 7, session_now: 4 };
    const gCases = [[[1, 2, 3.5, NaN], [2, 4, 4.5, 6, 7]], [[1], [2, 3, 4]], [[1, 1], [1, 1, 1]], [[0.3, -1.2, 2.2], [0.1, 0.4, -0.7, 1.9, 2.2, 0.0]]];

    const constants = ['MIN_LAP_SHARE', 'MIN_CLEAN_LAPS', 'RECENT_LAPS', 'FEATURE_COLS', 'SELECTION_SEED',
      'MIN_GROUP_FOR_INTERVAL', 'BASELINE_DRAWS', 'CI_LEVEL', 'BASELINE_QUANTILE', 'ROW_FINISHED', 'ROW_LIVE',
      'PROGRESS_DEPENDENT_FEATURES', 'TIE_TOLERANCE', 'THRESHOLD_MAX', 'THRESHOLD_PER_FEATURE', 'ANALYSIS_LABEL',
      'ANALYSIS_NOTE'];
    const req = {
      constants,
      rng: { seed: PS.SELECTION_SEED, n: 2000 },
      baseline: { values: values.map((r) => r.map((v) => (Number.isNaN(v) ? null : v))), n_selected: nSelected, strata },
      g: gCases.map(([x, y]) => [x.map((v) => (Number.isNaN(v) ? null : v)), y]),
      embeddings: embeddingCases,
      analyze: analyzeCases,
      degradation: degradationCases,
    };
    const res = spawnSync(PYTHON, ['-c', PY], {
      cwd: BACKEND, input: JSON.stringify(req),
      encoding: 'utf8', maxBuffer: 1 << 29,
    });
    if (res.status !== 0) throw new Error(`python failed: ${res.error || res.stderr}`);
    const py = parseJson(res.stdout.trim().split('\n').pop());

    const stat = { max: 0, numbers: 0, texts: 0 };
    // the JS answer as the API sends it (JSON: NaN -> null, undefined dropped)
    const report = (label, js, back) => {
      const out = [];
      diff(JSON.parse(JSON.stringify(js)), back, label, out, stat);
      expect(out.slice(0, 12), label).toEqual([]);
    };

    // constants
    const mod = { PIT_DEG_THRESHOLD_S, UNDERCUT_WINDOW_LAPS_BEFORE, UNDERCUT_WINDOW_LAPS_AFTER };
    {
      const { analyzeSelection, embeddingsAt, Pcg64, SELECTION_SEED, randomSelectionBaseline, hedgesG, gInterval,
        BASELINE_DRAWS } = PS;
      for (const k of Object.keys(py.constants)) report(`constant ${k}`, k in mod ? mod[k] : PS[k], py.constants[k]);

      // numpy default_rng(SELECTION_SEED).random: the same doubles, bit for bit
      const rng = Array.from(new Pcg64(SELECTION_SEED).random(2000));
      expect(rng).toEqual(py.rng);

      // the stratified random baseline (1000 draws) and g / its interval
      report('baseline', randomSelectionBaseline(values, nSelected, { strata }), py.baseline);
      gCases.forEach(([x, y], i) => report(`g case ${i}`, [hedgesG(x, y), gInterval(x, y)], py.g[i]));

      // the biplot during a replay (and post-race / after the flag)
      embeddingCases.forEach((c, i) => {
        const r = races.find((x) => x.year === c.year && x.round === c.round);
        report(`embeddings ${c.year} R${c.round} at ${c.session_now}`,
          embeddingsAt(r.fitWithout, r.payload, c.year, c.round, r.race_name, c.session_now), py.embeddings[i]);
      });

      // the lasso analysis
      const kinds = { per_feature: 0, max: 0, live: 0, noAlternative: 0, exceeds: 0 };
      analyzeCases.forEach((c, i) => {
        const r = races.find((x) => x.year === c.year && x.round === c.round);
        const race = c.year != null ? { year: c.year, round: c.round, payload: r.payload, raceName: r.race_name } : null;
        const js = analyzeSelection({ pointIds: c.ids, matrix, strategies, race, sessionNow: c.session_now ?? null });
        report(`analyze case ${i} (${c.ids.length} ids, ${c.year ?? '-'} R${c.round ?? '-'} at ${c.session_now})`, js, py.analyze[i]);
        const st = js.statistics;
        if (st) {
          kinds[st.threshold_rule] += 1;
          if (st.composition.selected_live) kinds.live += 1;
          if (st.composition.no_random_alternative) kinds.noAlternative += 1;
          kinds.exceeds += js.feature_importance.filter((f) => f.exceeds_random).length;
        }
      });

      // the degradation fits of a brushed range
      let fitted = 0;
      degradationCases.forEach((c, i) => {
        const r = races.find((x) => x.year === c.year && x.round === c.round);
        const js = degradationResponse(r.payload.lap_times, c.drivers, c.lap_start, c.lap_end, c.session_now, c.session_type);
        report(`degradation case ${i}`, js, py.degradation[i]);
        fitted += js.all_drivers.length;
      });

      OUT.push(`Demo analytics parity (frontend/src/__tests__/demo.pcaSelectionStats.test.js), input = frontend/public/data, `
        + `Python = backend modules (pca_compute, predictions.degradation_response)`);
      OUT.push(`demo races: ${races.map((r) => `${r.year} R${r.round}`).join(', ')}; clocks per race: before the start, `
        + 'leader at 1/3 and 2/3 of the laps, post-race, 60 s after the last lap');
      OUT.push(`constants equal: ${Object.keys(py.constants).length}`);
      OUT.push(`default_rng(${SELECTION_SEED}).random(2000): equal bit for bit`);
      OUT.push(`random baseline: ${values.length} rows x ${values[0].length} features, ${BASELINE_DRAWS} draws, strata ${JSON.stringify(nSelected)}: equal`);
      OUT.push(`biplot at a clock: ${embeddingCases.length} cases equal`);
      OUT.push(`lasso analysis: ${analyzeCases.length} cases equal (threshold rule per_feature ${kinds.per_feature}, `
        + `max ${kinds.max}; with rows of the race at the clock ${kinds.live}; no random alternative ${kinds.noAlternative}; `
        + `features above random ${kinds.exceeds})`);
      OUT.push(`degradation fits: ${degradationCases.length} cases equal (${fitted} driver fits)`);
      OUT.push(`compared: ${stat.numbers} numbers (max relative difference ${stat.max.toExponential(2)}, tolerance 1e-9), ${stat.texts} texts`);
      console.log(OUT.join('\n'));
      expect(kinds.per_feature).toBeGreaterThan(0);
      expect(kinds.max).toBeGreaterThan(0);
      expect(kinds.noAlternative).toBeGreaterThan(0);
      expect(fitted).toBeGreaterThan(0);
    }
  }, 600000);
});
