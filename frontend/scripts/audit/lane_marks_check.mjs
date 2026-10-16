/**
 * d3ports lane: contrast and colour-vision check of every mark the strategy
 * views draw (V1 / V13 targets 2 and 4) — Race Prediction, Strategy
 * Simulator, Race Analysis, Cross-Race Analysis, Undercut Calculator, Sector
 * Delta, Race Control, Strategy Engineer — with the colours of
 * utils/colors.js and utils/views/strategyMarks.js as the views use them.
 *
 * Run from frontend/ (vite-node resolves the modules' extensionless imports):
 *     npx vite-node scripts/audit/lane_marks_check.mjs
 * Writes docs/evidence/lane_marks_check.txt (or the file after --out) and
 * prints the same text; exit code 1 on a failure.
 *
 * Rules (the colours lane's, utils/colors.js header):
 *  - text >= 4.5:1, marks and UI boundaries >= 3:1 on the surfaces they are
 *    drawn on (WCAG 2.1 AA, SC 1.4.3 / 1.4.11);
 *  - a palette is distinguishable when its closest pair is CIEDE2000 >= 10
 *    under normal vision, protanopia, deuteranopia and tritanopia (Machado
 *    2009, severity 1); a palette below that must carry a redundant cue
 *    (glyph, letter, word, sign), which is listed with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SURFACES, TEXT_COLORS, DIVERGING, STATUS_COLORS, FLAG_COLORS, SERIES_COLORS, TYRE_COLORS, TYRE_LABELS,
  UI_COLORS, GRID_COLORS, contrastRatio, contrastText, textColor, markColor, tintedChip, closestPair, simulateCvd,
  CVD_MIN_DELTA_E, compositeOver, withAlpha, FONT_FLOOR_PX,
} from '../../src/utils/colors.js';
import {
  SEVERITY, levelMark, placesMark, PODIUM_COLOR, CHART_COLORS,
} from '../../src/utils/views/strategyMarks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ARG = process.argv.indexOf('--out');
const OUT = OUT_ARG > 0 && process.argv[OUT_ARG + 1]
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.resolve(HERE, '../../../docs/evidence/lane_marks_check.txt');
const TYPES = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
const lines = [];
const emit = (s = '') => { lines.push(s); console.log(s); };
let failures = 0;
const f2 = (v) => v.toFixed(2);

// Surfaces the strategy views draw on: the panel, the raised cards / chart
// backgrounds, the elevated hovered rows / tooltips, the page (Race Control rail)
const VIEW_SURFACES = { page: SURFACES.page, panel: SURFACES.panel, raised: SURFACES.raised, elevated: SURFACES.elevated };

function contrastLine(name, color, role) {
  const min = role === 'text' ? 4.5 : 3;
  const ratios = Object.entries(VIEW_SURFACES).map(([k, s]) => [k, contrastRatio(color, s)]);
  const worst = Math.min(...ratios.map((r) => r[1]));
  const ok = worst >= min;
  if (!ok) failures += 1;
  emit(`   ${name.padEnd(26)} ${String(color).padEnd(22)} ${role} >= ${min}: ${ratios.map(([k, r]) => `${k} ${f2(r)}`).join(', ')} -> ${ok ? 'PASS' : 'FAIL'}`);
}

function cvdBlock(title, palette, cue) {
  emit(`## ${title}`);
  emit(`   cue: ${cue || 'none (must stand on colour alone)'}`);
  for (const [k, c] of Object.entries(palette)) {
    emit(`   ${k.padEnd(26)} ${String(c).padEnd(22)} sim P/D/T ${['protanopia', 'deuteranopia', 'tritanopia'].map((t) => simulateCvd(c, t)).join(' ')}`);
  }
  let worst = Infinity;
  for (const t of TYPES) {
    const { deltaE, pair } = closestPair(palette, t);
    worst = Math.min(worst, deltaE);
    emit(`   ${t.padEnd(13)} closest pair ${pair.join(' / ').padEnd(30)} dE2000 ${deltaE.toFixed(1)}`);
  }
  const alone = worst >= CVD_MIN_DELTA_E;
  if (!alone && !cue) failures += 1;
  emit(`   smallest pair over all vision types: ${worst.toFixed(1)} -> ${alone ? 'PASS (distinguishable on colour alone)' : cue ? 'below 10: carried by the cue' : 'FAIL'}`);
  emit();
}

emit('# d3ports lane: contrast and CVD of the strategy views\' marks');
emit(`Surfaces: ${Object.entries(VIEW_SURFACES).map(([k, v]) => `${k} ${v}`).join(', ')}`);
emit(`Distinguishable: closest CIEDE2000 pair >= ${CVD_MIN_DELTA_E} (Machado 2009 severity 1.0); text >= 4.5:1, marks >= 3:1`);
emit(`Font floors (colors.js FONT_FLOOR_PX): data ${FONT_FLOOR_PX.data} px, label ${FONT_FLOOR_PX.label} px`);
emit();

// 1. Diverging pair: waterfall bars, sweep columns, effect bars, ▲/▼ text
cvdBlock('Diverging pair (Sector Delta bars, Undercut sweep, effect bars, places / verdicts)', {
  better: DIVERGING.better, worse: DIVERGING.worse,
}, 'sign + / − and ▲ / ▼ in every label and legend; words (ahead / behind, better / worse)');
emit('   contrast (text drawn in it and marks):');
contrastLine('better', DIVERGING.better, 'text');
contrastLine('worse', DIVERGING.worse, 'text');
contrastLine('neutral (no change)', DIVERGING.neutral, 'text');
emit();

// 2. Severity: risks, alerts, insights, battle urgency, pit probability
const sev = Object.fromEntries(Object.entries(SEVERITY).map(([k, v]) => [k, v.color]));
cvdBlock('Severity (risk chips, alerts, insights, battle urgency)', sev,
  `glyph ${Object.entries(SEVERITY).map(([k, v]) => `${v.glyph} ${k}`).join(', ')} and the word in every chip`);
for (const [k, v] of Object.entries(SEVERITY)) contrastLine(`severity ${k}`, v.color, 'text');
emit('   badge text on a severity fill (battle badge, insight icon): contrastText');
for (const [k, v] of Object.entries(SEVERITY)) {
  const r = contrastRatio(contrastText(v.color), v.color);
  if (r < 4.5) failures += 1;
  emit(`   ${`on ${k}`.padEnd(26)} ${contrastText(v.color)} on ${v.color}: ${f2(r)} -> ${r >= 4.5 ? 'PASS' : 'FAIL'}`);
}
emit();

// 3. Monte Carlo badge levels (battles)
const levels = { two: levelMark(2).color, one: levelMark(1).color, none: levelMark(0).color };
cvdBlock('Monte Carlo badge levels (overtake probabilities)', levels,
  `glyph ${levelMark(2).glyph} two badges, ${levelMark(1).glyph} one badge, ${levelMark(0).glyph} none`);
for (const [k, c] of Object.entries(levels)) contrastLine(`level ${k}`, c, 'text');
contrastLine('podium P label / gold', PODIUM_COLOR, 'text');
emit();

// 4. Places gained / lost marks (same pair as 1, via placesMark)
emit('## Places gained / lost (placesMark)');
for (const ch of [2, 0, -3]) {
  const m = placesMark(ch);
  emit(`   change ${String(ch).padStart(2)}: ${m.glyph} ${m.word.padEnd(10)} ${m.color}`);
}
emit();

// 5. Tinted chips: verdict boxes and flag / status chips (text on its own tint)
emit('## Tinted chips (tintedChip: text lifted to 4.5:1 on the tint)');
const chips = [
  ['verdict ahead (0.10)', DIVERGING.better, 0.1, SURFACES.panel],
  ['verdict behind (0.10)', DIVERGING.worse, 0.1, SURFACES.panel],
  ...Object.entries(FLAG_COLORS).map(([k, c]) => [`flag ${k} (0.14)`, c, 0.14, SURFACES.panel]),
  ...Object.entries(SEVERITY).map(([k, v]) => [`severity ${k} (0.15)`, v.color, 0.15, SURFACES.raised]),
];
for (const [name, c, a, surface] of chips) {
  const chip = tintedChip(c, a, surface);
  const under = compositeOver(chip.background, surface);
  const r = contrastRatio(chip.color, under);
  const b = contrastRatio(chip.borderColor, under);
  const ok = r >= 4.5 && b >= 3;
  if (!ok) failures += 1;
  emit(`   ${name.padEnd(26)} text ${chip.color} ${f2(r)}, border ${chip.borderColor} ${f2(b)} -> ${ok ? 'PASS' : 'FAIL'}`);
}
emit();

// 6. Race Control categories: glyph + label on every chip
const categories = {
  Flag: FLAG_COLORS.yellow, Drs: FLAG_COLORS.blue, SafetyCar: FLAG_COLORS.safetyCar, CarEvent: SERIES_COLORS[2],
  Other: TEXT_COLORS.muted, Penalty: FLAG_COLORS.red,
};
cvdBlock('Race Control categories (feed badges, filter chips)', categories,
  'glyph F / D / S / C / · / P / ⚖ (Stewards share the Penalty colour) and the category label');
emit('   badge glyph drawn in textColor(category, panel):');
for (const [k, c] of Object.entries(categories)) contrastLine(`glyph ${k}`, textColor(c, SURFACES.panel), 'text');
emit('   row accent bar markColor(category, panel):');
for (const [k, c] of Object.entries(categories)) {
  const r = contrastRatio(markColor(c, SURFACES.panel), SURFACES.panel);
  if (r < 3) failures += 1;
  emit(`   ${`bar ${k}`.padEnd(26)} ${markColor(c, SURFACES.panel)} on panel ${f2(r)} -> ${r >= 3 ? 'PASS' : 'FAIL'}`);
}
emit();

// 7. Cross-Race Analysis: above random (accent + label) vs within random
cvdBlock('Cross-Race Analysis forest marks', { aboveRandom: UI_COLORS.brush, withinRandom: TEXT_COLORS.secondary },
  'the "above random" label under the feature name');
contrastLine('above random (g, interval)', UI_COLORS.brush, 'text');
contrastLine('within random (g, interval)', TEXT_COLORS.secondary, 'text');
emit();

// 8. Neutral chart marks
emit('## Neutral chart marks (>= 3:1)');
contrastLine('MC share bars (muted)', TEXT_COLORS.muted, 'mark');
contrastLine('MC P5-P95 range line', TEXT_COLORS.secondary, 'mark');
contrastLine('MC P label diamond', TEXT_COLORS.primary, 'mark');
contrastLine('zero line / lap total', CHART_COLORS.text, 'mark');
contrastLine('brush accent (buttons, links)', UI_COLORS.brush, 'text');
contrastLine('predicted accent (pit loss)', STATUS_COLORS.predicted, 'text');
const runText = contrastText(UI_COLORS.brush);
const runR = contrastRatio(runText, UI_COLORS.brush);
if (runR < 4.5) failures += 1;
emit(`   Run Simulation button       ${runText} on ${UI_COLORS.brush}: ${f2(runR)} -> ${runR >= 4.5 ? 'PASS' : 'FAIL'}`);
emit(`   (grid ${GRID_COLORS.grid}, axis ${GRID_COLORS.axis}, rules ${GRID_COLORS.rule}: not data, no floor)`);
emit();

// 9. Stint strips: FIA compound fills (marks) and the letter on them
emit('## Stint strips (Simulator, PCA patterns, Strategy Engineer, tyre mix): compound fill and letter');
for (const [k, c] of Object.entries(TYRE_COLORS)) {
  const letter = contrastText(c);
  const lr = contrastRatio(letter, c);
  const mr = Math.min(...Object.values(VIEW_SURFACES).map((s) => contrastRatio(c, s)));
  const ok = lr >= 4.5 && mr >= 3;
  if (!ok) failures += 1;
  emit(`   ${k.padEnd(13)} ${c} letter '${TYRE_LABELS[k] || '?'}' ${letter} ${f2(lr)}:1, fill on the darkest-to-lightest surface >= ${f2(mr)}:1 -> ${ok ? 'PASS' : 'FAIL'}`);
}
cvdBlock('FIA compounds (strips, tyre letters)', Object.fromEntries(['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((k) => [k, TYRE_COLORS[k]])),
  'the compound letter S / M / H / I / W on every segment and chip');

// 10. Tints that carry no meaning (hover, selected row) keep text readable
emit('## Row tints under text (selected / hovered rows)');
for (const [name, tint] of [['selected row 0.06', withAlpha(TEXT_COLORS.primary, 0.06)], ['hover 0.06', withAlpha(TEXT_COLORS.primary, 0.06)], ['accent tint 0.15', withAlpha(UI_COLORS.brush, 0.15)]]) {
  for (const [sk, s] of [['panel', SURFACES.panel], ['raised', SURFACES.raised]]) {
    const under = compositeOver(tint, s);
    const r = contrastRatio(TEXT_COLORS.secondary, under);
    if (r < 4.5) failures += 1;
    emit(`   ${`${name} on ${sk}`.padEnd(26)} secondary text ${f2(r)} -> ${r >= 4.5 ? 'PASS' : 'FAIL'}`);
  }
}
emit();

emit(`RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
process.exitCode = failures ? 1 : 0;
