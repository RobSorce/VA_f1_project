// What the timing sheet's cells need at the data size, to set
// the column floors of the fit (utils/views/lapTimeChart.js). Real Formula1
// widths (driver names, header labels); JetBrains Mono at 0.6 em a character.
//   node frontend/scripts/audit/timing_floors.mjs
// Writes docs/evidence/timing_floors.txt (or the file after --out) and prints the same text.
import { loadFaces } from './fontMetrics.mjs';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('timing_floors.txt');
const F = loadFaces();
const NAMES = ['HULKENBERG', 'VERSTAPPEN', 'RICCIARDO', 'MAGNUSSEN', 'ANTONELLI', 'BORTOLETO', 'LECLERC', 'NORRIS',
  'COLAPINTO', 'BEARMAN', 'LAWSON', 'DOOHAN', 'SARGEANT', 'HAMILTON', 'RUSSELL', 'TSUNODA', 'ZHOU', 'BOTTAS'];
for (const d of [11, 11.08, 12.41, 12.5]) {
  const mono = (n) => n * 0.6 * d;
  const sur = NAMES.map((n) => [n, F.width(n, d, 800, { letterSpacingEm: 0.03, upper: true })]).sort((a, b) => b[1] - a[1]);
  const fl = F.width('◆ FL', 10, 800, { letterSpacingEm: 0.04 }) + 6 + 3;
  console.log(`data ${d} px: surname (weight 800) widest ${sur[0][0]} ${sur[0][1].toFixed(1)} px, ${sur[1][0]} ${sur[1][1].toFixed(1)}, ${sur[2][0]} ${sur[2][1].toFixed(1)}; FL chip ${fl.toFixed(1)}`);
  console.log(`  sector "◆28.123" ${(mono(7) + 2).toFixed(1)} px (${((mono(7) + 2) / d).toFixed(2)} em); lap "◆1:21.123" ${(mono(9) + 2).toFixed(1)} (${((mono(9) + 2) / d).toFixed(2)} em); gap "+12.345" ${mono(7).toFixed(1)}, "LEADER" ${mono(6).toFixed(1)}; pos "RET" ${(mono(3) + 3 * 0.02 * d).toFixed(1)}; laps "45" ${mono(2).toFixed(1)}`);
}
