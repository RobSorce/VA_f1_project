// Help and methodology texts of the PCA views (P3, P10, P11): the in-app
// help (utils/chartHelp.js) and docs/PCA_METHODOLOGY.md describe what the code
// does now, not the methods it replaced: Hedges' g with a random baseline
// ("descriptive differences, not a test") instead of Cohen's d with fixed
// cut-offs; a live PCA refitted every lap and turned onto the previous lap
// (LIVE_PCA_ALIGN) instead of a basis frozen after warm-up laps; the race on
// screen at the replay clock. The help carries no number of its own (counts
// and rates live in the script outputs the methodology doc cites).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_HELP } from '../utils/chartHelp.js';
import { LIVE_PCA_ALIGN } from '../utils/livePCA.js';
import { ANALYSIS_LABEL } from '../utils/views/pcaSelection.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const all = (e) => [e.summary, ...(e.howToRead || []), ...(e.limitations || [])].join(' ');
// Terms of the removed methods and the old artefact's counts
const STALE = [/Cohen/i, /\b17\b/, /\b499\b/, /\b24 cached\b/, /frozen/i, /warm-?up/i, /exponential/i, /half-life/i,
  /fuel_corrected_pace/, /0\.8 large/];

describe('in-app help of the PCA panels (utils/chartHelp.js)', () => {
  it('no term of the removed methods, no number of its own', () => {
    for (const key of ['analytics', 'crossrace', 'racesituation']) {
      const text = all(CHART_HELP[key]);
      for (const re of STALE) expect(text, `${key} ${re}`).not.toMatch(re);
      expect(text.match(/\d/g), key).toBeNull();
    }
  });

  it('the lasso analysis: Hedges\' g, the random baseline, not a test', () => {
    const analysis = all(CHART_HELP.crossrace);
    expect(analysis).toMatch(/Hedges' g/);
    expect(analysis).toMatch(/random selection of the same size/);
    expect(CHART_HELP.crossrace.summary).toMatch(/not a significance test/);
    expect(ANALYSIS_LABEL).toBe('Descriptive differences, not a test');
    expect(all(CHART_HELP.analytics)).toMatch(/Hedges' g/);
  });

  it('the race on screen at the replay clock; the live map refitted and turned every lap', () => {
    expect(all(CHART_HELP.analytics)).toMatch(/rows at the replay clock/);
    expect(all(CHART_HELP.analytics)).toMatch(/has not started/);
    const live = all(CHART_HELP.racesituation);
    expect(live).toMatch(/refitted every lap/);
    // the help names the alignment the store uses
    expect(LIVE_PCA_ALIGN).toBe('rotation');
    expect(live).toMatch(/orthogonal Procrustes/);
    expect(live).toMatch(/arrows read the dots exactly/);
  });
});

describe('docs/PCA_METHODOLOGY.md', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/PCA_METHODOLOGY.md'), 'utf8');

  it('describes the live alignment and the lasso statistics in use', () => {
    expect(doc).not.toMatch(/WARMUP_LAPS|frozen|Cohen/i);
    expect(doc).toMatch(/LIVE_PCA_ALIGN = 'rotation'/);
    expect(doc).toMatch(/Hedges' g/);
    expect(doc).toMatch(/Descriptive differences, not a test/);
  });

  it('every number it quotes is in a script output it names', () => {
    const names = ['pca_rebuild.txt', 'pca_diagnostic.txt', 'pca_selection_baseline.txt', 'pca_repair_check.txt',
      'pca_clock_check.txt', 'pca_interval_coverage.txt', 'live_pca_rewind.txt'];
    // the tracked outputs of the scripts (docs/evidence/README.md)
    const outputs = names.map((f) => path.join(ROOT, 'docs/evidence', f));
    for (const f of outputs) expect(fs.existsSync(f), f).toBe(true);
    const text = outputs.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    // [as the doc writes it, as the output prints it]
    const pairs = [
      ['534 rows from 30 cached races', 'rows: 534 (driver, race) from 30 cached races'],
      ['64 (driver, race) pairs', 'left out: 64 below 90%'],
      ['PC1 44.1% and PC2 20.3%', 'PC1 0.441, PC2 0.203'], ['64.5% together', 'sum 0.645'],
      ['0.028', 'eta2(race): PC1 0.028, PC2 0.558'], ['0.558', 'PC2 0.558'],
      ['average stint length 0.602, pit stops -0.562, longest stint 0.519', 'avg_stint_length         -0.059   0.602'],
      ['-0.562', 'pit_count                 0.054  -0.562'], ['0.519', 'max_stint_length          0.023   0.519'],
      ['1720 laps', '1720 laps of 30 cached races'], ['6.02e-14', 'largest gap 6.02e-14'],
      ['from 3.26 to 1.98', 'max 1.98; sign median 0.65, p95 1.53, max 3.26'], ['(median 0.65 to 0.56)', 'median 0.56, p95 1.25'],
      ['0.47 instead of 2.67', '42 |       0.47  1.00  0.98 |       2.67'], ['22.6 degrees', 'median 22.6 deg'],
      ['35.5%', 'PC2       0.203        0.645'],
      ['41.0%', '5            41.0%'], ['3.0% pass', '41.0%            3.0%'], ['1.399 for 5 rows', '3.0%                  1.399'],
      ['19 points are rows as of lap 10', "its points: 19; as_of ['session_now']; as_of_lap [10]"],
      ['one pit window (lap 5)', 'pit_windows [(5, 5, 1)]'],
      // the interval of g (backend/scripts/pca_interval_coverage.py)
      ['g +/- 1.96 SE', 'g +/- 1.96 SE'], ['Hedges and Olkin 1985', '(Hedges and Olkin 1985)'],
      ['MIN_GROUP_FOR_INTERVAL = 2', 'pca_compute.MIN_GROUP_FOR_INTERVAL = 2'],
      ['at most 6.4%', 'largest share excluding 0 from n = 2 on: 6.4%'],
      ['from 2 to 50 rows', 'median width falls as n grows (n = 2: 2.78 ... n = 50: 0.58)'],
      ['92.7% of the single-row cases', '   1 |   2225/2400  =  92.7%'], ['16.3% at 5 rows', '   5 |    391/2400  =  16.3%'],
      // the live map on backward navigation and its arrows (frontend/scripts/live_pca_rewind.mjs)
      ['0 laps leave an input without its arrow', 'laps with a non-zero loading but no arrow 0'],
      ['1690 one-lap steps back', '1690 one-lap steps back over 30 races'],
      ['largest mean dot distance 0.00e+0 PC units', 'mean dot distance max 0.00e+0 PC units'],
      ['reflected 0 of 1690', 'turned > 45 deg or reflected 0 of 1690'],
      ['median 0.56, max 1.98 PC units', 'median 0.56, p95 1.25, max 1.98 PC units; forward lap-to-lap move: median 0.56, p95 1.25, max 1.98'], ['instead of the whole race\'s three', 'pit_windows [(5, 23, 17), (30, 41, 12), (50, 50, 1)]'],
    ];
    for (const [inDoc, inOutput] of pairs) {
      expect(doc, inDoc).toContain(inDoc);
      expect(text, inOutput).toContain(inOutput);
    }
  });

  it('T2: the table of every component is the diagnostic\'s, row by row', () => {
    const diag = fs.readFileSync(path.join(ROOT, 'docs/evidence/pca_diagnostic.txt'), 'utf8');
    const printed = [...diag.matchAll(/^(PC\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*$/gm)].map((m) => m.slice(1, 5));
    const inDoc = [...doc.matchAll(/^\| (PC\d+) \| ([\d.]+) \| ([\d.]+) \| ([\d.]+) \|$/gm)].map((m) => m.slice(1, 5));
    expect(printed).toHaveLength(12);
    expect(inDoc).toEqual(printed);
    // the features of the doc's table are FEATURE_COLS of pca_compute.py, and the doc names no deleted module
    const compute = read('backend/data/processors/pca_compute.py');
    const cols = [...compute.match(/FEATURE_COLS = \[([\s\S]*?)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(cols).toHaveLength(12);
    for (const c of cols) expect(doc, c).toContain(`\`${c}\``);
    for (const p of ['docs/PCA_METHODOLOGY.md', 'docs/pca_features.md']) {
      expect(read(p), p).not.toMatch(/tsne_features|tsne_compute|tsne_scaler|tsne_feature_matrix|\b17 features/);
    }
  });
});

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

// P3 (round 4): the interval of g that ships is the 95% normal-approximation
// (large-sample) interval, g +/- 1.96 SE (backend pca_compute.g_interval); a
// bootstrap is degenerate for the one- or two-row selections a click makes.
// docs/RELATED_WORK.md called it a bootstrap interval. During a replay the
// random baseline keeps the selection's mix of row kinds (stratified).
describe('the interval of g and the stratified baseline, as the docs and the help name them (P3)', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const DOCS = ['docs/RELATED_WORK.md', 'docs/PCA_METHODOLOGY.md'];
  const SE = 'SE^2 = (n1 + n2) / (n1 n2) + g^2 / (2 (n1 + n2))';

  it('docs and help say "normal-approximation interval", and the docs give its formula', () => {
    for (const p of DOCS) {
      expect(read(p), p).toMatch(/normal-approximation interval/);
      expect(read(p), p).toContain('g +/- 1.96 SE');
      expect(read(p), p).toContain(SE);
      expect(read(p), p).toContain('Hedges and Olkin 1985');
    }
    expect(all(CHART_HELP.crossrace)).toMatch(/normal-approximation interval/);
    expect(all(CHART_HELP.analytics)).toMatch(/normal-approximation interval/);
  });

  it('no text calls the shipped interval a bootstrap', () => {
    for (const key of ['analytics', 'crossrace']) expect(all(CHART_HELP[key]), key).not.toMatch(/bootstrap/i);
    for (const p of ['frontend/src/components/visualizations/PCAAnalysisPanel.jsx',
      'frontend/src/utils/views/pcaSelection.js', 'docs/pca_features.md']) {
      expect(read(p), p).not.toMatch(/bootstrap/i);
    }
    for (const p of DOCS) {
      expect(read(p), p).not.toMatch(/bootstrap interval/i);
      // a bootstrap is named only as the method replaced or why it is not used
      const sentences = read(p).split(/(?<=[.;])\s+/).filter((s) => /bootstrap/i.test(s));
      for (const s of sentences) expect(s, `${p}: ${s}`).toMatch(/used before|degenerate/);
    }
    for (const line of read('README.md').split('\n').filter((l) => /Hedges/.test(l))) {
      expect(line).not.toMatch(/bootstrap/i);
    }
  });

  it('the help explains the mix of rows and the progress-dependent rows', () => {
    const analysis = all(CHART_HELP.crossrace);
    expect(analysis).toMatch(/same size and the same mix of rows/);
    expect(analysis).toMatch(/progress-dependent/);
    expect(analysis).toMatch(/states the mix and the lap/);
  });

  it('every number the methodology doc quotes for them is in a script output', () => {
    const names = ['pca_stratified_baseline.txt', 'pca_progress_features.txt', 'pca_interval_coverage.txt',
      'pca_selection_baseline.txt', 'pca_mixed_threshold.txt'];
    // the tracked outputs of the scripts (docs/evidence/README.md)
    const files = names.map((f) => path.join(ROOT, 'docs/evidence', f));
    for (const f of files) expect(fs.existsSync(f), f).toBe(true);
    const out = Object.fromEntries(names.map((n, i) => [n, fs.readFileSync(files[i], 'utf8')]));
    const doc = read('docs/PCA_METHODOLOGY.md');
    const line = (name, start) => out[name].split('\n').find((l) => l.startsWith(start)) || '';
    // [as the doc writes it, as the output prints it]
    const pairs = [
      ['over 15 replay clocks of 5 races', out['pca_stratified_baseline.txt'], 'all 15 clocks of 5 races'],
      ['random selections of 2 to 8 of its rows', out['pca_stratified_baseline.txt'], 'b = random selections of 2 to 8 rows'],
      ['63.5% of the cases with the former baseline and 1.7% with the stratified one', out['pca_stratified_baseline.txt'],
        'progress-dependent feature 63.5% (former) -> 1.7% (stratified)'],
      ['(some feature: 73.0% and 5.9%)', out['pca_stratified_baseline.txt'], 'any feature 73.0% -> 5.9%'],
      ['some feature in 30.9% and 5.4% of the cases', out['pca_stratified_baseline.txt'], 'flagging any feature 30.9% -> 5.4%'],
      // verifier r1: per-feature thresholds with rows of two kinds (backend/scripts/pca_mixed_threshold.py)
      ['(0.992 to 0.994 at the four clocks of section 1', line('pca_mixed_threshold.txt', '2024 R12 lap 15      1.5'), '| 0.992'],
      ['(0.992 to 0.994 at the four clocks of section 1', line('pca_mixed_threshold.txt', '2024 R16 lap 20      1.5'), '| 0.994'],
      ['flagged in 0.0% of 60 selections with one threshold for all and in 55.0% with per-feature thresholds',
        out['pca_mixed_threshold.txt'], '2024 R16 lap 20      1.5 |  53.3% /   0.0% /  55.0% /  91.7%'],
      ['of 96 real lassos', out['pca_mixed_threshold.txt'], 'all: 96 selections'],
      ['1 and 68 are flagged', out['pca_mixed_threshold.txt'], 'the selected feature flagged: former 21, round4 1, shipped 68'],
      ['6.3% (rows of the race on screen only)', line('pca_mixed_threshold.txt', '  all clocks, type L'), 'shipped 6.3%'],
      ['4.7% (mixed)', line('pca_mixed_threshold.txt', '  all clocks, type M'), 'shipped 4.7%'],
      ['5.6% (finished rows only)', line('pca_mixed_threshold.txt', '  all clocks, type F'), 'shipped 5.6%'],
      ['Post-race the rule and the answers are unchanged', out['pca_mixed_threshold.txt'],
        'post-race flags and thresholds identical to round4: True'],
      ['the stratified baseline is the former one', out['pca_stratified_baseline.txt'], 'identical True'],
      ['two clocks inside one leader lap give different keys', out['pca_stratified_baseline.txt'], 'content key equal False'],
      ['1.984, 1.752 and 1.879 matrix SDs', line('pca_progress_features.txt', 'pit_count'), '1.984'],
      ['1.984, 1.752 and 1.879 matrix SDs', line('pca_progress_features.txt', 'avg_stint_length'), '1.752'],
      ['1.984, 1.752 and 1.879 matrix SDs', line('pca_progress_features.txt', 'max_stint_length'), '1.879'],
      ['2.49 times the post-race spread', line('pca_progress_features.txt', 'degradation_slope'), '2.49'],
      // rerun unchanged
      ['at most 6.4%', out['pca_interval_coverage.txt'], 'largest share excluding 0 from n = 2 on: 6.4%'],
      ['16.3% at 5 rows', out['pca_interval_coverage.txt'], '   5 |    391/2400  =  16.3%'],
      ['41.0% show at least one', out['pca_selection_baseline.txt'], '5            41.0%            41.0%            3.0%                  1.399'],
    ];
    for (const [inDoc, where, inOutput] of pairs) {
      expect(doc, inDoc).toContain(inDoc);
      expect(where, inOutput).toContain(inOutput);
    }
    expect(out['pca_progress_features.txt']).toContain('same set: True');
  });
});

describe('no frozen basis left in the code', () => {
  it('WARMUP_LAPS is gone from frontend/src', () => {
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); } else if (/\.(js|jsx)$/.test(e.name) && /WARMUP_LAPS/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
      }
    };
    walk(path.resolve(HERE, '..'));
    expect(hits).toEqual([]);
  });
});
