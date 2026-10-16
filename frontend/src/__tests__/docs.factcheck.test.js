// Documentation statements checked against the code and the evidence files.
// Each claim of
// README.md, docs/ and the help texts is checked against the code it names.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_HELP } from '../utils/chartHelp.js';
import { consistencyView, LOW_DATA_FRACTION, LOW_DATA_MIN_LAPS } from '../utils/views/degradationViews.js';
import { CATEGORY_ORDER, SLOT_OPTIONS } from '../utils/slotOptions.js';
import { SERIES_COLORS, TEXT_COLORS } from '../utils/colors.js';
import { hasCachedSession, loadCachedSession } from './helpers/cachedSession.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const all = (entry) => [entry.summary, ...(entry.howToRead || []), ...(entry.limitations || [])].join(' ');
const subscribes = (file, field) => new RegExp(`useF1Store\\(\\(?s\\)? => s\\.${field}\\)`)
  .test(read(`frontend/src/components/visualizations/${file}`));

describe('README', () => {
  it('bulk_download.py fetches the race session of each round, as the README says', () => {
    const script = read('backend/scripts/bulk_download.py');
    const calls = [...script.matchAll(/extractor\.get_session\([^)]*\)/g)].map((m) => m[0]);
    expect(calls).toEqual(['extractor.get_session(year, round_num, "R")']);
    const readme = read('README.md');
    expect(readme).toMatch(/`backend\/scripts\/bulk_download\.py` downloads the race session of every round/);
    expect(readme).not.toMatch(/fills the processed cache for whole seasons/);
  });

  it('the MultiViewer credit describes ours without claiming what MultiViewer lacks', () => {
    expect(read('README.md')).not.toMatch(/Ours adds/);
    expect(read('docs/RELATED_WORK.md')).not.toMatch(/Ours differs in four ways/);
  });
});

describe('the pit-loss evidence: which row is the dashboard estimator', () => {
  it('the citing docs name causal_fixed / true_loss, the rows utils/pitLoss.js reproduces', () => {
    const ev = read('docs/evidence/validate_pit_loss_and_rejoin.txt');
    expect(ev).toMatch(/^race\s+n_green true_loss code_loss in_share$/m);
    expect(ev).toMatch(/^causal_fixed\s+stops=709 exact=71%/m);
    expect(ev).toMatch(/^current_code\s+stops=709 exact=33%/m);
    // pitLoss.js: the race median equals the script's per-race true_loss
    expect(read('frontend/src/utils/pitLoss.js')).toMatch(/per-race `true_loss`/);
    for (const doc of ['README.md', 'docs/RELATED_WORK.md', 'docs/analytics_provenance.md']) {
      const line = read(doc).split('\n').find((l) => l.includes('validate_pit_loss_and_rejoin.txt'));
      expect(line, doc).toMatch(/`causal_fixed`/);
      expect(line, doc).toMatch(/`true_loss`/);
      expect(line, doc).toMatch(/`current_code`[^;]*earlier in-lap-only estimate/);
    }
  });
});

describe('docs/RELATED_WORK.md citations', () => {
  it('AWS: the AI-powered label goes to the graphics the page gives it', () => {
    const doc = read('docs/RELATED_WORK.md');
    expect(doc).toMatch(/the page calls Pit Stop Strategy, Time Lost and Track Dominance AI-powered/);
    expect(doc).not.toMatch(/Battle Forecast, described as AI-powered/);
  });

  it('Norman: the heading cites the 2013 edition, the one of the source line', () => {
    const doc = read('docs/RELATED_WORK.md');
    expect(doc).toMatch(/^### Norman — "The Design of Everyday Things" \(revised and expanded edition, 2013\)$/m);
    expect(doc).toMatch(/\*The Design of Everyday Things\*, revised and expanded edition, Basic Books \(2013\)/);
    expect(doc).not.toMatch(/Everyday Things" \(1988/);
  });
});

describe('help texts (chartHelp.js)', () => {
  it('Championship: only the Standings bar tooltip names a team change', () => {
    const chart = read('frontend/src/components/visualizations/ChampionshipChart.jsx');
    const standings = read('frontend/src/components/visualizations/ChampionshipStandings.jsx');
    expect(chart).not.toMatch(/teamChangeNote|championshipTooltip/);
    expect(standings).toMatch(/championshipTooltip\(/);
    const help = all(CHART_HELP.championship);
    expect(help).toMatch(/the tooltip of his Standings bar names the change/);
    expect(help).not.toMatch(/and the tooltip names the change/);
  });

  it('Circle of Doom: the PCA biplot follows the selection only, the PCA panel the focus too', () => {
    expect(subscribes('PCABiplot.jsx', 'selectedDrivers')).toBe(true);
    expect(subscribes('PCABiplot.jsx', 'focusDriver')).toBe(false);
    expect(subscribes('PCAAnalysisPanel.jsx', 'focusDriver')).toBe(true);
    const help = all(CHART_HELP.circle);
    expect(help).toMatch(/the PCA biplot the selection only/);
    expect(help).not.toMatch(/the PCA views follow focus and selection only/);
  });

  it('LOW DATA: the cut is floor(LOW_DATA_FRACTION x the most laps), at least LOW_DATA_MIN_LAPS', () => {
    const src = read('frontend/src/utils/views/degradationViews.js');
    expect(src).toMatch(/Math\.max\(LOW_DATA_MIN_LAPS, Math\.floor\(raceLength \* LOW_DATA_FRACTION\)\)/);
    expect(all(CHART_HELP.consistency)).toContain(
      `fewer laps than ${LOW_DATA_FRACTION} × the most laps completed in the field, rounded down (at least ${LOW_DATA_MIN_LAPS})`,
    );
    expect(read('docs/DEGRADATION_METHODOLOGY.md')).toMatch(/max\(3, floor\(0\.75 x the most laps completed\)\)/);
    for (const doc of ['docs/DEGRADATION_METHODOLOGY.md', 'docs/HEURISTIC_EVALUATION.md', 'docs/INSIGHTS_BRAZIL_2024.md', 'docs/INSIGHTS_MONZA_2024.md']) {
      expect(read(doc).replace(/\s+/g, ' '), doc).not.toMatch(/fewer (laps )?than (max\(3, )?75 % of the most laps/);
    }
  });

  it.skipIf(!hasCachedSession(2024, 16))('LOW DATA on Monza 2024: 53 laps give the cut 39, not 39.75', () => {
    const cv = consistencyView(loadCachedSession(2024, 16).lap_times);
    expect(Math.max(...cv.drivers.map((d) => d.laps_completed))).toBe(53);
    expect(cv.minLapsThreshold).toBe(39);
  });
});

describe('docs that name views, keys and sections', () => {
  it('SCROLL_JUSTIFICATIONS: the Strategy Engineer is listed with its chat-log scroll, not as scroll-free', () => {
    expect(read('frontend/src/components/visualizations/GeminiAssistant.jsx')).toContain('className="chat-messages"');
    const row = read('docs/SCROLL_JUSTIFICATIONS.md').split('\n').find((l) => l.startsWith('| Strategy views ('));
    expect(row).toMatch(/Apart from the Strategy Engineer's chat log in its Radio tab \(row "Strategy assistant chat log" above\), no scroll area is left in these views/);
    expect(row).not.toMatch(/No scroll area is left in these files/);
  });

  it('INSIGHTS_MONZA_2024: key 2 opens Tyres; Tyre Degradation has no number key', () => {
    const keys = read('frontend/src/hooks/useKeyboardShortcuts.js');
    expect(keys).toMatch(/'2': 'tyres'/);
    expect(keys).not.toMatch(/'\d': 'tiredeg'/);
    const doc = read('docs/INSIGHTS_MONZA_2024.md');
    expect(doc).not.toMatch(/Open \*\*Tyre Degradation\*\* \(`2`\)/);
    expect(doc.replace(/\s+/g, ' ')).toMatch(/it has no number key: `2` opens Tyres, Tyre Health and Pace Retention/);
  });

  it('MASTER_LEDGER: the Not-linked list is section 8; seven dock categories; only Pit Wall has isMode', () => {
    expect(read('docs/COORDINATION_GRAPH.md')).toMatch(/^### 8\. Not linked$/m);
    const ledger = read('docs/MASTER_LEDGER.md');
    expect(ledger).toMatch(/does not follow the lap range, `docs\/COORDINATION_GRAPH\.md`, section 8\.\)/);
    expect(CATEGORY_ORDER).toEqual(['monitor', 'timing', 'tyres', 'strategy', 'analysis', 'prediction', 'system']);
    expect(ledger).toContain(CATEGORY_ORDER.map((c) => `\`${c}\``).join(' · '));
    expect(SLOT_OPTIONS.filter((o) => o.isMode).map((o) => o.id)).toEqual(['pitwall']);
    expect(ledger).toMatch(/only Pit Wall carries the `isMode` flag/);
    expect(ledger).not.toMatch(/Pit Wall \/ Settings are marked non-dockable/);
  });
});

describe('docs/COLOR_ENCODING.md', () => {
  const doc = read('docs/COLOR_ENCODING.md');

  it('the section cross-references point at the sections that hold them', () => {
    expect(doc).toMatch(/^## 6\. Better \/ worse/m);
    expect(doc).toMatch(/^## 9\. Telemetry/m);
    expect(doc).toMatch(/better \/ worse is blue \/ orange \(section 6\), throttle \/ brake is sky blue \/ orange \(section 9\)/);
  });

  it('the leader-line and former-tint ratios are those of the evidence files, cited', () => {
    expect(read('docs/evidence/focus_context_contrast.txt')).toMatch(/CircleOfDoom context leader line .*before 1\.25 {2}after 2\.01/);
    expect(doc).toMatch(/at opacity 0\.3 they read 1\.25:1; `docs\/evidence\/focus_context_contrast\.txt`/);
    const ratios = [
      ...[...read('docs/evidence/area_alpha.txt').matchAll(/alpha 0\.22 -> ([\d.]+):1/g)].map((m) => Number(m[1])),
      ...[...read('docs/evidence/contrast_pairs.txt').matchAll(/former 22 % tint .*: ([\d.]+):1/g)].map((m) => Number(m[1])),
    ];
    expect(ratios.length).toBe(8);
    expect(doc).toContain(`read ${Math.min(...ratios).toFixed(2)}-${Math.max(...ratios).toFixed(2)}:1`);
  });

  it('Race Control: Car Event and Other are not flag colours; their pair is in the closest-pair table', () => {
    const panel = read('frontend/src/components/visualizations/RaceControlPanel.jsx');
    expect(panel).toMatch(/CarEvent: +\{[^}]*color: SERIES_COLORS\[2\]/);
    expect(panel).toMatch(/Other: +\{[^}]*color: TEXT_COLORS\.muted/);
    expect(doc).toContain(`Car Event in the series pink ${SERIES_COLORS[2]}`);
    expect(doc).toContain(`Other in the muted grey ${TEXT_COLORS.muted}, which are not flag colours`);
    expect(read('docs/evidence/lane_marks_check.txt')).toMatch(/deuteranopia {2}closest pair CarEvent \/ Other +dE2000 4\.8/);
    expect(doc).toMatch(/^\| Race Control categories \(`RaceControlPanel\.jsx`\) \| Car Event \/ Other \(deuteranopia\) \| 4\.8 \| PASS WITH CUE \|/m);
  });

  it('the Track Map legend row names the DRS key the map draws', () => {
    expect(read('frontend/src/components/visualizations/TrackMap.jsx')).toMatch(/const mapKeyItems = \[\.\.\.sectorKeyItems, \.\.\.drsKeyItems, \.\.\.rampKeyItems\]/);
    expect(doc).toMatch(/^\| Track Map \| sectors, DRS zones, channel overlay \| S1 S2 S3; DRS zone/m);
  });

  it('the Circle of Doom selection ring is the selection blue, as its CSS comment says', () => {
    const css = read('frontend/src/styles/visualizations.css');
    const rule = css.slice(css.indexOf('.cod-select-ring {') - 200, css.indexOf('.cod-select-ring {') + 80);
    expect(rule).toMatch(/stroke: var\(--color-brush\)/);
    expect(rule).toMatch(/the selection blue \(--color-brush\)/);
    expect(rule).not.toMatch(/selected-car red/);
  });
});

describe('docs/INTENDED_USER.md', () => {
  const doc = read('docs/INTENDED_USER.md');

  it('the persona keeps no figure without a source', () => {
    for (const s of ['3-10 years', '20+ data streams', 'in under 30 seconds', '6+ monitors']) expect(doc).not.toContain(s);
  });

  it('Lap Delta: base = lapDeltaBaseDriver else the focus driver; the first five drivers when nobody is selected', () => {
    const chart = read('frontend/src/components/visualizations/LapDeltaChart.jsx');
    expect(chart).toMatch(/const base = lapDeltaBaseDriver \|\| focusDriver;/);
    expect(chart).toMatch(/compare = allDrivers\.filter\(\(d\) => d !== base\)\.slice\(0, 5\);/);
    expect(doc).toMatch(/selected drivers \(the first five drivers when nobody is selected\) against the base driver \(`lapDeltaBaseDriver`, set with the focus, else the focus driver\)/);
  });
});
