// Repair (V2): STATUS_COLORS.slower / muchSlower mean one set of bands in
// every view, on one ordered scale (normal -> yellow -> orange, never back to
// white). Prints TIMING_BANDS, the colour of a sweep of deltas through the
// helpers of the Timing Tower (getTimingStatus, through timingBandColor), the
// Pit Wall sector panel (pitWallTimingCue) and the Race Pace Grid legend, and
// checks the order.
// Run from frontend/: npx vite-node scripts/audit/timing_bands.mjs
// Writes docs/evidence/timing_bands.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import {
  TIMING_BANDS, timingBandColor, STATUS_COLORS,
} from '../../src/utils/colors.js';
import { pitWallTimingCue, pitWallLegend, PITWALL_BANDS } from '../../src/utils/views/pitWallSectorPanel.js';
import { timingTowerLegend } from '../../src/utils/views/timingTower.js';
import { paceLegend } from '../../src/utils/views/racePaceGrid.js';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('timing_bands.txt');

const name = (c) => Object.entries(STATUS_COLORS).find(([, v]) => v === c)?.[0] || c;
const rank = { normal: 0, slower: 1, muchSlower: 2 };
let fails = 0;
console.log(`TIMING_BANDS: lap fast ${TIMING_BANDS.lap.fast} s, slower ${TIMING_BANDS.lap.slower} s, much slower ${TIMING_BANDS.lap.muchSlower} s; sector slower ${TIMING_BANDS.sector.slower} s, much slower ${TIMING_BANDS.sector.muchSlower} s; best tolerance ${TIMING_BANDS.tolerance} s`);
console.log(`Pit Wall panel bands are TIMING_BANDS: ${PITWALL_BANDS === TIMING_BANDS}`);
if (PITWALL_BANDS !== TIMING_BANDS) fails += 1;

const deltas = [0.05, 0.2, 0.29, 0.31, 0.45, 0.6, 0.9, 1.1, 1.6, 1.99, 2.01, 3.5];
for (const kind of ['sector', 'lap']) {
  const seqBand = deltas.map((d) => name(timingBandColor(d, kind)));
  const seqPanel = deltas.map((d) => name(pitWallTimingCue(30 + d, 30, 29, kind).color));
  const ordered = (seq) => seq.every((c, i) => i === 0 || rank[c] >= rank[seq[i - 1]]);
  const same = seqBand.every((c, i) => c === seqPanel[i]);
  console.log(`${kind}: deltas ${deltas.join(' ')} s over the reference`);
  console.log(`  timingBandColor (Timing Tower)   ${seqBand.join(' ')}  ordered ${ordered(seqBand)}`);
  console.log(`  pitWallTimingCue (Pit Wall)      ${seqPanel.join(' ')}  same as the tower ${same}`);
  if (!ordered(seqBand) || !same) fails += 1;
}

// the tower's status function goes through timingBandColor (source check)
const towerSrc = fs.readFileSync(path.resolve('src/utils/views/timingTower.js'), 'utf8');
const towerUses = /return cue\(timingBandColor\(value - personalBest, kind\)\)/.test(towerSrc) && /'lap',\n\s*\),/.test(towerSrc);
console.log(`Timing Tower getTimingStatus uses timingBandColor (sectors 'sector', lap time 'lap'): ${towerUses}`);
if (!towerUses) fails += 1;
const paceSrc = fs.readFileSync(path.resolve('src/utils/views/racePaceGrid.js'), 'utf8');
const paceUses = /\.domain\(\[-TIMING_BANDS\.lap\.fast, TIMING_BANDS\.lap\.slower, TIMING_BANDS\.lap\.muchSlower\]\)/.test(paceSrc);
console.log(`Race Pace Grid threshold scale reads TIMING_BANDS.lap: ${paceUses}`);
if (!paceUses) fails += 1;

const legendRows = (items) => items.filter((i) => [STATUS_COLORS.slower, STATUS_COLORS.muchSlower].includes(i.color))
  .map((i) => `${name(i.color)} "${i.label}"`).join(', ');
console.log(`legends: tower ${legendRows(timingTowerLegend())}; pit wall ${legendRows(pitWallLegend())}; pace grid ${legendRows(paceLegend())}`);
console.log(fails ? `RESULT: FAIL (${fails})` : 'RESULT: PASS (one ordered scale, one set of bands)');
process.exitCode = fails ? 1 : 0;
