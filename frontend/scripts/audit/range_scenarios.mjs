// V7: lap-range scenarios through the store (the one-range store), beyond the
// clear path, with a check per scenario. What each view shows (code, 2026-10-15 working tree):
//   Timing Sheet bar + title  = brushLapRange || selectedLapRange (LapTimeChart.jsx:321, :747)
//   Timing Sheet rows         = filtered by brushLapRange only   (utils/views/lapTimeChart.js:194-196)
//   Position by Lap brush     = brushLapRange                    (PositionByLap.jsx:508-510)
//   Strategy Timeline shading = selectedLapRange                 (StrategyTimeline.jsx:560)
//   Tyre Degradation fit      = brushLapRange || selectedLapRange (TireDegradation.jsx:48)
// Run from frontend/: npx vite-node scripts/audit/range_scenarios.mjs
// Writes docs/evidence/range_scenarios.txt (or the file after --out) and prints the same text.
import { useF1Store } from '../../src/store/useF1Store.js';
import { lapBrushUpdate } from '../../src/utils/views/lapTimeChart.js';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('range_scenarios.txt');

const st = () => useF1Store.getState();
const reset = () => { st().setBrushLapRange(null); st().setSelectedLapRange(null); st().setBrushLapRange(null); };
const J = (v) => JSON.stringify(v);
const show = (step) => {
  const s = st();
  const sheet = s.brushLapRange || s.selectedLapRange;
  console.log(`  ${step}: brush=${J(s.brushLapRange)} selected=${J(s.selectedLapRange)}`
    + ` | sheet bar+title ${J(sheet)}, sheet rows filtered to ${J(s.brushLapRange)}`
    + ` | Position by Lap ${J(s.brushLapRange)} | Strategy Timeline ${J(s.selectedLapRange)} | Tyre Degradation ${J(sheet)}`);
  return s;
};
const sheetDrag = (r) => { const n = lapBrushUpdate(r); st().setBrushLapRange(n.brushLapRange); st().setSelectedLapRange(n.selectedLapRange); };

console.log('A. stint click only (README.md:107, INSIGHTS.md Insight 3)');
reset();
st().setSelectedLapRange([5, 15]);
let s = show('stint L5-L15 clicked');

console.log('B. sheet bar dragged, then a stint clicked (README.md:107 "shown on the sheet\'s lap-range bar")');
reset();
sheetDrag([10, 20]);
show('drag L10-L20 on the sheet bar');
st().setSelectedLapRange([5, 15]);
s = show('stint L5-L15 clicked');

console.log('C. stint click, Position by Lap brush, Position by Lap clear');
reset();
st().setSelectedLapRange([5, 15]);
st().setBrushLapRange([30, 40]);
show('stint L5-L15 then Position by Lap L30-L40');
st().setBrushLapRange(null);
s = show('clear on Position by Lap');

// Check (repair 3): after every step every view shows the same range
const views = (x) => [x.brushLapRange || x.selectedLapRange, x.brushLapRange, x.brushLapRange, x.selectedLapRange, x.brushLapRange || x.selectedLapRange];
const same = (x) => new Set(views(x).map((v) => J(v))).size === 1;
reset();
const steps = [
  ['stint L5-L15', () => st().setSelectedLapRange([5, 15]), [5, 15]],
  ['sheet bar L10-L20', () => sheetDrag([10, 20]), [10, 20]],
  ['stint L5-L15', () => st().setSelectedLapRange([5, 15]), [5, 15]],
  ['Position by Lap L30-L40', () => st().setBrushLapRange([30, 40]), [30, 40]],
  ['clear on Position by Lap', () => st().setBrushLapRange(null), null],
  ['pit window L20-L24', () => st().setSelectedLapRange([20, 24]), [20, 24]],
  ['clear selection (Esc)', () => st().clearSelection(), null],
];
let ok = 0;
for (const [name, act, want] of steps) {
  act();
  const x = st();
  const pass = same(x) && J(x.brushLapRange) === J(want);
  if (pass) ok += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: every view shows ${J(views(x)[0])}`);
}
console.log(`${ok} of ${steps.length} steps: every view on the same range`);

process.exit(0);
