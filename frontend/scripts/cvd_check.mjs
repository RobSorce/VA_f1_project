/**
 * Colour-vision and contrast check of every categorical and diverging palette
 * of utils/colors.js (V13 target 4, V1-V3), and of the contrast of each colour
 * in the role it is drawn in (target 2).
 *
 * Run from frontend/:
 *     npx vite-node scripts/cvd_check.mjs [--out FILE]
 * Writes docs/evidence/cvd_check.txt (or FILE) and prints it; exits 1 when a
 * palette that must stand on colour alone fails, or a colour misses its
 * contrast floor.
 *
 * Method:
 *  - simulation: Machado, Oliveira & Fernandes (2009), severity 1.0, linear RGB
 *    (colors.js simulateCvd) for protanopia, deuteranopia and tritanopia;
 *  - distance: CIEDE2000 between every pair of the palette, as seen by each
 *    vision type; "distinguishable" = smallest pair >= CVD_MIN_DELTA_E (10);
 *  - a palette drawn with a redundant cue (letter, glyph, label, sign, dash)
 *    is reported with its cue and does not fail on distance;
 *  - contrast: WCAG 2.1 ratio against each dark surface (colors.js SURFACES);
 *    role 'text' needs 4.5:1, role 'mark' 3:1, checked on the surface each
 *    role is drawn on (marks: panel and raised, the PCA biplot only on the
 *    panel it was designed for; text: every surface).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SURFACES, TEXT_COLORS, DIVERGING, STATUS_COLORS, STATUS_GLYPHS, FLAG_COLORS, CHANNEL_COLORS,
  SERIES_COLORS, SECTOR_COLORS, TYRE_COLORS, TYRE_LABELS, TEAM_COLORS, UI_COLORS,
  contrastRatio, contrastText, markColor, teammateTint, closestPair, deltaE2000, simulateCvd,
  CVD_MIN_DELTA_E, tintedChip, TRACK_STATUS_STYLES, compositeOver, MEDAL_COLORS, TRACK_COLORS, TEAMMATE_DASHES,
} from '../src/utils/colors.js';
import { OUTCOME_CLASSES } from '../src/utils/views/pcaBiplot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ARG = process.argv.indexOf('--out');
const OUT = OUT_ARG > 0 && process.argv[OUT_ARG + 1]
  ? path.resolve(process.argv[OUT_ARG + 1])
  : path.resolve(HERE, '../../docs/evidence/cvd_check.txt');
const lines = [];
const emit = (s = '') => { lines.push(s); console.log(s); };
const TYPES = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
let failures = 0;

// 2024 and 2025 grids: one colour per team actually on the grid that season
const TEAMS_2024 = ['Red Bull Racing', 'Ferrari', 'Mercedes', 'McLaren', 'Aston Martin', 'Alpine', 'Williams', 'RB', 'Haas F1 Team', 'Kick Sauber'];

const PALETTES = [
  { name: 'DIVERGING (better / worse)', colors: { better: DIVERGING.better, worse: DIVERGING.worse }, cue: 'sign + / − (signedDelta) or ▲ ▼; must also stand alone', standAlone: true, role: 'text' },
  {
    name: 'STATUS timing (overall best / personal best / no improvement / normal / pit)',
    colors: { overallBest: STATUS_COLORS.overallBest, personalBest: STATUS_COLORS.personalBest, slower: STATUS_COLORS.slower, normal: STATUS_COLORS.normal, pit: STATUS_COLORS.pit },
    cue: `glyphs ${STATUS_GLYPHS.overallBest} overall best, ${STATUS_GLYPHS.personalBest} personal best, '${STATUS_GLYPHS.pit}'/'PIT' pit, '${STATUS_GLYPHS.pitOut}'/'OUT' out-lap`,
    role: 'text',
  },
  { name: 'STATUS pace scale (fast / normal / slower / much slower)', colors: { fast: STATUS_COLORS.fast, normal: STATUS_COLORS.normal, slower: STATUS_COLORS.slower, muchSlower: STATUS_COLORS.muchSlower }, cue: 'ordered scale; the cell shows the lap time; must also stand alone', standAlone: true, role: 'text' },
  { name: 'TYRE_COLORS (FIA compounds)', colors: Object.fromEntries(Object.entries(TYRE_COLORS).filter(([k]) => TYRE_LABELS[k])), cue: `compound letter ${Object.values(TYRE_LABELS).join(' ')}`, role: 'mark' },
  { name: 'FLAG_COLORS (FIA flags)', colors: { green: FLAG_COLORS.green, yellow: FLAG_COLORS.yellow, safetyCar: FLAG_COLORS.safetyCar, red: FLAG_COLORS.red, blue: FLAG_COLORS.blue }, cue: `label text (${Object.values(TRACK_STATUS_STYLES).map((s) => s.short).join(', ')})`, role: 'text' },
  { name: 'CHANNEL_COLORS (speed / throttle / brake)', colors: CHANNEL_COLORS, cue: 'channel name in the legend; must also stand alone', standAlone: true, role: 'mark' },
  { name: 'SERIES_COLORS (comparison laps)', colors: Object.fromEntries(SERIES_COLORS.map((c, i) => [`series${i + 1}`, c])), cue: 'lap number label; must also stand alone', standAlone: true, role: 'mark' },
  { name: 'SECTOR_COLORS (track map sectors)', colors: Object.fromEntries(Object.entries(SECTOR_COLORS).map(([k, c]) => [`S${k}`, c])), cue: 'S1 / S2 / S3 labels; must also stand alone', standAlone: true, role: 'mark' },
  { name: 'PCA outcome classes (cividis ends, cyan middle)', colors: Object.fromEntries(OUTCOME_CLASSES.map((c) => [c.key, c.color])), cue: 'ordered by lightness; must also stand alone', standAlone: true, role: 'mark', markSurfaces: ['panel'] },
  { name: 'Ordered three-level scales (tyre-health zones / health %, battle levels)', colors: { better: DIVERGING.better, slower: STATUS_COLORS.slower, worse: DIVERGING.worse, neutral: TEXT_COLORS.secondary }, cue: 'zone labels CRITICAL / WORN, the % or probability text; must also stand alone', standAlone: true, role: 'text' },
  { name: 'Track map sectors and DRS zones', colors: { S1: SECTOR_COLORS[1], S2: SECTOR_COLORS[2], S3: SECTOR_COLORS[3], DRS: TRACK_COLORS.drs }, cue: 'S1 / S2 / S3 legend, the label DRS; must also stand alone', standAlone: true, role: 'mark' },
  { name: 'Podium medals (MEDAL_COLORS)', colors: { P1: MEDAL_COLORS[1], P2: MEDAL_COLORS[2], P3: MEDAL_COLORS[3] }, cue: 'the position number on the medal', role: 'mark' },
  { name: 'TEAM_COLORS 2024 grid', colors: Object.fromEntries(TEAMS_2024.map((t) => [t, TEAM_COLORS[t]])), cue: 'driver code next to every mark / in every badge, teammate dash; brand colours kept', role: 'mark' },
];

emit('# CVD and contrast check of utils/colors.js palettes');
emit(`Surfaces: ${Object.entries(SURFACES).map(([k, v]) => `${k} ${v}`).join(', ')}`);
emit(`Distinguishable: smallest CIEDE2000 pair >= ${CVD_MIN_DELTA_E} (Machado 2009 severity 1.0 simulation)`);
emit('');

for (const p of PALETTES) {
  emit(`## ${p.name}`);
  emit(`   cue: ${p.cue}`);
  const entries = Object.entries(p.colors);
  for (const [k, c] of entries) {
    const sims = TYPES.slice(1).map((t) => simulateCvd(c, t)).join(' ');
    const cr = Object.entries(SURFACES).map(([n, s]) => `${n} ${contrastRatio(c, s).toFixed(2)}`).join(', ');
    emit(`   ${k.padEnd(16)} ${c}  sim P/D/T ${sims}  contrast ${cr}`);
  }
  let worst = Infinity;
  for (const t of TYPES) {
    const { deltaE, pair } = closestPair(p.colors, t);
    worst = Math.min(worst, deltaE);
    emit(`   ${t.padEnd(13)} closest pair ${pair.join(' / ').padEnd(30)} dE2000 ${deltaE.toFixed(1)}${deltaE < CVD_MIN_DELTA_E ? '  (< 10: needs the cue)' : ''}`);
  }
  const floor = p.role === 'text' ? 4.5 : 3;
  const surfaces = p.role === 'text'
    ? Object.entries(SURFACES)
    : (p.markSurfaces || ['panel', 'raised']).map((n) => [n, SURFACES[n]]);
  const low = [];
  for (const [k, c] of entries) {
    for (const [n, s] of surfaces) if (contrastRatio(c, s) < floor) low.push(`${k} on ${n} ${contrastRatio(c, s).toFixed(2)}`);
  }
  const distOk = worst >= CVD_MIN_DELTA_E;
  const verdict = p.standAlone
    ? (distOk ? 'PASS (distinguishable on colour alone)' : 'FAIL (must stand alone)')
    : (distOk ? 'PASS (distinguishable on colour alone, cue kept)' : 'PASS WITH CUE (redundant cue always drawn)');
  if (p.standAlone && !distOk) failures++;
  emit(`   smallest pair over all vision types: ${worst.toFixed(1)} -> ${verdict}`);
  if (p.name.startsWith('TEAM_COLORS')) {
    // Brand colours: marks are drawn through markColor (lifted to 3:1)
    const lifted = entries.filter(([, c]) => markColor(c, SURFACES.raised) !== c);
    emit(`   ${p.role} contrast >= ${floor}: ${low.length ? `raw below floor: ${low.join('; ')}` : 'all raw colours pass'}; drawn through markColor: ${lifted.length ? lifted.map(([k, c]) => `${k} ${c} -> ${markColor(c, SURFACES.raised)}`).join(', ') : 'none changed on raised'}`);
  } else {
    if (low.length) failures++;
    emit(`   ${p.role} contrast >= ${floor}: ${low.length ? `FAIL ${low.join('; ')}` : 'PASS'}`);
  }
  emit('');
}

emit('## Teammates (V3): team colour vs teammate tint, every team key');
let teammateWorst = Infinity;
for (const [team, c] of Object.entries(TEAM_COLORS)) {
  const t = teammateTint(c);
  const ds = TYPES.map((ty) => (ty === 'normal' ? deltaE2000(c, t) : deltaE2000(simulateCvd(c, ty), simulateCvd(t, ty))));
  const m = Math.min(...ds);
  teammateWorst = Math.min(teammateWorst, m);
  const mk = markColor(t, SURFACES.raised);
  emit(`   ${team.padEnd(16)} ${c} -> ${t}  dE2000 N/P/D/T ${ds.map((d) => d.toFixed(1)).join(' / ')}  tint mark on raised ${contrastRatio(mk, SURFACES.raised).toFixed(2)}${mk !== t ? ` (lifted to ${mk})` : ''}`);
}
emit(`   smallest teammate distance over all vision types: ${teammateWorst.toFixed(1)} -> ${teammateWorst >= CVD_MIN_DELTA_E ? 'PASS' : 'FAIL'} (plus dashed lines)`);
if (teammateWorst < CVD_MIN_DELTA_E) failures++;
emit('');

// A third driver of a team in one session (a substitute): teammateTint(c, 2),
// against the team colour and tint 1, as drawn (marks, markColor on raised)
emit('## Third driver of a team (V3): tint 2 vs team colour and tint 1, as marks');
let thirdWorst = Infinity;
for (const [team, c] of Object.entries(TEAM_COLORS)) {
  const t2 = teammateTint(c, 2);
  const marks = [c, teammateTint(c), t2].map((x) => markColor(x, SURFACES.raised));
  const ds = TYPES.map((ty) => {
    const seen = ty === 'normal' ? marks : marks.map((x) => simulateCvd(x, ty));
    return Math.min(deltaE2000(seen[0], seen[2]), deltaE2000(seen[1], seen[2]));
  });
  const m = Math.min(...ds);
  thirdWorst = Math.min(thirdWorst, m);
  emit(`   ${team.padEnd(16)} ${c} -> ${t2}  dE2000 to the nearer of the two N/P/D/T ${ds.map((d) => d.toFixed(1)).join(' / ')}  mark ${marks[2]} ${contrastRatio(marks[2], SURFACES.raised).toFixed(2)}:1`);
}
emit(`   smallest third-driver distance over all vision types: ${thirdWorst.toFixed(1)} -> ${thirdWorst >= CVD_MIN_DELTA_E ? 'PASS' : 'FAIL'} (plus the dash-dot ${TEAMMATE_DASHES[2]})`);
if (thirdWorst < CVD_MIN_DELTA_E) failures++;
emit('');

emit('## Team-colour marks (markColor rule: lifted toward white until >= 3:1)');
for (const [n, s] of Object.entries(SURFACES)) {
  const changed = Object.entries(TEAM_COLORS).filter(([, c]) => markColor(c, s) !== c);
  const min = Math.min(...Object.values(TEAM_COLORS).map((c) => contrastRatio(markColor(c, s), s)));
  emit(`   on ${n.padEnd(8)} lifted: ${changed.length ? changed.map(([k, c]) => `${k} ${c}->${markColor(c, s)}`).join(', ') : 'none'}; smallest contrast after the rule ${min.toFixed(2)}`);
  if (min < 3) failures++;
}
emit('');

emit('## Badge text (contrastText: black or white, whichever is higher)');
const badges = {
  ...Object.fromEntries(Object.entries(TEAM_COLORS).map(([k, c]) => [k, c])),
  ...Object.fromEntries(Object.entries(TEAM_COLORS).map(([k, c]) => [`${k} (teammate)`, teammateTint(c)])),
  ...Object.fromEntries(Object.entries(TYRE_COLORS).map(([k, c]) => [`tyre ${k}`, c])),
  ...Object.fromEntries(Object.entries(MEDAL_COLORS).map(([k, c]) => [`medal P${k}`, c])),
  'playhead (white bubble)': TEXT_COLORS.primary,
};
let badgeMin = Infinity;
for (const [k, c] of Object.entries(badges)) {
  const t = contrastText(c);
  const r = contrastRatio(t, c);
  badgeMin = Math.min(badgeMin, r);
  emit(`   ${k.padEnd(28)} ${c} text ${t} ${r.toFixed(2)} (white would be ${contrastRatio('#FFFFFF', c).toFixed(2)})`);
}
emit(`   smallest badge text contrast: ${badgeMin.toFixed(2)} (bold >= 14 px badges need 3:1, normal text 4.5:1)`);
emit('');

emit('## Single accents drawn as marks (>= 3:1 on panel and raised)');
for (const [k, c] of Object.entries({ pitWindow: UI_COLORS.pitWindow, brush: UI_COLORS.brush, predicted: UI_COLORS.predicted, drs: TRACK_COLORS.drs, north: TRACK_COLORS.north, surface: TRACK_COLORS.surface })) {
  const rs = ['panel', 'raised'].map((n) => `${n} ${contrastRatio(c, SURFACES[n]).toFixed(2)}`).join(', ');
  const min = Math.min(contrastRatio(c, SURFACES.panel), contrastRatio(c, SURFACES.raised));
  // the unsectored track surface is a background, not a data mark
  if (k !== 'surface' && min < 3) failures++;
  emit(`   ${k.padEnd(10)} ${c}  ${rs}${k === 'surface' ? '  (track surface, background)' : min < 3 ? '  FAIL' : ''}`);
}
emit('');

emit('## Neutral text and accents');
for (const [k, c] of Object.entries({ ...TEXT_COLORS, brush: UI_COLORS.brush, predicted: UI_COLORS.predicted })) {
  const rs = Object.entries(SURFACES).map(([n, s]) => `${n} ${contrastRatio(c, s).toFixed(2)}`).join(', ');
  const min = Math.min(...Object.values(SURFACES).map((s) => contrastRatio(c, s)));
  if (min < 4.5) failures++;
  emit(`   ${k.padEnd(10)} ${c}  ${rs}${min < 4.5 ? '  FAIL' : ''}`);
}
const hover = compositeOver('rgba(255,255,255,0.14)', SURFACES.panel);
emit(`   muted on a hovered row (white 0.14 over panel = ${hover}): ${contrastRatio(TEXT_COLORS.muted, hover).toFixed(2)}`);
emit('');

emit('## Tinted chips (tintedChip: tint 0.15 behind, text lifted to 4.5:1 on it)');
for (const [k, c] of Object.entries({ ...FLAG_COLORS, pit: STATUS_COLORS.pit, overallBest: STATUS_COLORS.overallBest, personalBest: STATUS_COLORS.personalBest, worse: DIVERGING.worse, better: DIVERGING.better, accent: UI_COLORS.accent })) {
  const chip = tintedChip(c);
  const under = compositeOver(chip.background, SURFACES.raised);
  const r = contrastRatio(chip.color, under);
  if (r < 4.5) failures++;
  emit(`   ${k.padEnd(13)} ${c} on ${under}: text ${chip.color} ${r.toFixed(2)} (raw colour ${contrastRatio(c, under).toFixed(2)})`);
}
emit('');
emit(`RESULT: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
if (failures) process.exitCode = 1;
