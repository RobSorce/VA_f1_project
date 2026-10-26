// Repair of V13 (Timing Tower columns, "needs browser check"): does every
// tower cell and header fit its column? The tower is a fixed 480 px column, so
// its text is CHART_FONT.fixed (--font-size-data-fixed, 11 px at every
// viewport); the columns are COL shares of a 476 px table.
// Widths from the real Inter faces (fontMetrics.mjs) at the weights of
// TimingTower.jsx, with the tabular forms its cells ask for (cellBase
// font-variant-numeric: tabular-nums; the header row has none); the status
// marks (◆ ● P O before a time, the status column's P / ✕) in JetBrains Mono,
// 0.6 em; letter-spacing and paddings as in TimingTower.jsx.
// Run: node frontend/scripts/audit/tower_columns.mjs
// Writes docs/evidence/tower_columns.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFaces } from './fontMetrics.mjs';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('tower_columns.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const src = fs.readFileSync(path.join(ROOT, 'frontend/src/components/visualizations/TimingTower.jsx'), 'utf8');
const tokens = fs.readFileSync(path.join(ROOT, 'frontend/src/styles/tokens.css'), 'utf8');
const font = Number((tokens.match(/--font-size-data-fixed: (\d+(?:\.\d+)?)px;/) || [])[1]);
const COL = Object.fromEntries([...(src.match(/const COL = \{([\s\S]*?)\};/) || [])[1].matchAll(/(\w+): (\d+)/g)].map((m) => [m[1], Number(m[2])]));
const total = Object.values(COL).reduce((a, b) => a + b, 0);
const usesFixed = /const TOWER_FONT = CHART_FONT\.fixed;/.test(src) && !/CHART_FONT\.data/.test(src);
const spacing = Number((src.match(/const colHeaderStyle = \{[\s\S]*?letterSpacing: '([\d.]+)em'/) || [])[1]);
const F = loadFaces('Inter');
if (!F) { console.log('Inter font files missing: frontend/public/fonts'); process.exit(1); }
// a cell's text (tabular forms) at its weight; a header label: Bold, uppercase, its letter-spacing
const w = (text, weight = 400) => F.width(text, font, weight, { tabular: true });
const head = (t, pad = 2) => F.width(t, font, 700, { letterSpacingEm: spacing, upper: true }) + pad;
const mono = (t) => [...t].length * 0.6 * font;
const monoMarks = /className="timing-glyph" style=\{\{[^}]*fontFamily: 'var\(--font-mono\)'/.test(src)
  && /title=\{statusLabel\}\s*style=\{\{[^}]*fontFamily: 'var\(--font-mono\)'/.test(src);
if (!monoMarks) { console.log('TimingTower.jsx: the status marks are not in var(--font-mono)'); process.exit(1); }
console.log(`Timing Tower text ${font} px (CHART_FONT.fixed everywhere in the tower: ${usesFixed}); COL sum ${total} px, header letter-spacing ${spacing} em`);
const timed = (glyph, t) => mono(glyph) + 2 + w(t, 500) + 4; // TimingValue: the mark + 2 px, the time (500)
// the driver codes of the 2024 and 2025 grids: the widest one in the driver cell
const CODES = ['ALB', 'ALO', 'ANT', 'BEA', 'BOR', 'BOT', 'COL', 'DOO', 'GAS', 'HAD', 'HAM', 'HUL', 'LAW', 'LEC',
  'MAG', 'NOR', 'OCO', 'PER', 'PIA', 'RIC', 'RUS', 'SAI', 'SAR', 'STR', 'TSU', 'VER', 'ZHO'];
const code = CODES.map((c) => [c, w(c, 700) + 3 * 0.03 * font]).sort((a, b) => b[1] - a[1])[0];
const cases = [
  // the position centred in the cell (2 px padding a side), clear of the 3 px team bar on its left edge
  ['pos', 'value "20" (800) centred, clear of the 3 px team bar', w('20', 800) + 2 * 3], ['pos', 'header "P"', head('P')],
  ['num', 'badge "44" (700, minWidth 24 + 4 px padding)', Math.max(24, w('44', 700) + 8) + 4], ['num', 'header "#"', head('#')],
  ['driver', `"${code[0]}" (700, the widest code) + compound badge 13 + 4 (margins) + "25" (+6 left, 2 right)`, 6 + code[1] + 13 + 4 + w('25') + 2],
  ['driver', 'header "DRIVER" (6 left)', head('DRIVER', 7)],
  ['gap', '"+12.345"', w('+12.345') + 4], ['gap', '"LEADER" (600)', w('LEADER', 600) + 4], ['gap', '"+102.3" (>= 100 s)', w('+102.3') + 4], ['gap', 'header "GAP"', head('GAP')],
  ['int', '"+12.345"', w('+12.345') + 4], ['int', 'header "INT"', head('INT')],
  ['s1', '"◆28.123" (glyph + 2 px margin)', timed('◆', '28.123')], ['s1', 'header "S1"', head('S1')],
  ['lapTime', '"◆1:21.456"', timed('◆', '1:21.456')], ['lapTime', 'header "TIME"', head('TIME')],
  ['lap', '"57"', w('57') + 4], ['lap', 'header "LAP"', head('LAP')],
  ['status', 'mark "✕" / "P"', mono('✕') + 4],
];
let fails = 0;
for (const [col, what, need] of cases) {
  const have = (COL[col] * 476) / total;
  const ok = need <= have;
  if (!ok) fails += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${col.padEnd(8)} ${have.toFixed(1)} px holds ${what}: ${need.toFixed(1)} px`);
}
console.log(fails ? `${fails} cell(s) too narrow` : 'Every tower cell and header fits its column at the four target viewports (the size does not depend on the viewport).');
process.exitCode = fails ? 1 : 0;
