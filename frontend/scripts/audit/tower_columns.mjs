// Repair of V13 (Timing Tower columns, "needs browser check"): does every
// tower cell and header fit its column? The tower is a fixed 480 px column, so
// its text is CHART_FONT.fixed (--font-size-data-fixed, 11 px at every
// viewport); the columns are COL shares of a 476 px table.
// Widths with CONSERVATIVE glyph advances (em), the larger of Titillium Web
// (the web font) and Segoe UI (the Windows fallback): digit 0.56, '.' ':' 0.28,
// '+' 0.58, upper case (bold) 0.66, '◆' '●' '✕' 0.80 (a symbol font);
// letter-spacing and paddings as in TimingTower.jsx.
// Run: node frontend/scripts/audit/tower_columns.mjs
// Writes docs/evidence/tower_columns.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const EM = { digit: 0.56, dot: 0.28, plus: 0.58, cap: 0.66, glyph: 0.80 };
const w = (text) => [...text].reduce((a, ch) => a + (/\d/.test(ch) ? EM.digit : /[.:]/.test(ch) ? EM.dot
  : /[+\-−]/.test(ch) ? EM.plus : /[◆●✕]/.test(ch) ? EM.glyph : EM.cap), 0) * font;
const head = (t, pad = 2) => w(t) + t.length * spacing * font + pad;
console.log(`Timing Tower text ${font} px (CHART_FONT.fixed everywhere in the tower: ${usesFixed}); COL sum ${total} px, header letter-spacing ${spacing} em`);
const cases = [
  ['pos', 'value "20" (+4 px padding)', w('20') + 4], ['pos', 'header "POS"', head('POS')],
  ['num', 'badge "44" (minWidth 24 + 4 px padding)', Math.max(24, w('44') + 8) + 4], ['num', 'header "#"', head('#')],
  ['driver', '"VER" + compound badge 13 + 4 (margins) + "25" (+6 left, 2 right)', 6 + w('VER') + 3 * 0.03 * font + 13 + 4 + w('25') + 2],
  ['driver', 'header "DRIVER" (6 left)', head('DRIVER', 7)],
  ['gap', '"+12.345"', w('+12.345') + 4], ['gap', '"LEADER"', w('LEADER') + 4], ['gap', '"+102.3" (>= 100 s)', w('+102.3') + 4], ['gap', 'header "GAP"', head('GAP')],
  ['int', '"+12.345"', w('+12.345') + 4], ['int', 'header "INT"', head('INT')],
  ['s1', '"◆28.123" (glyph + 2 px margin)', w('◆28.123') + 2 + 4], ['s1', 'header "S1"', head('S1')],
  ['lapTime', '"◆1:21.456"', w('◆1:21.456') + 2 + 4], ['lapTime', 'header "TIME"', head('TIME')],
  ['lap', '"57"', w('57') + 4], ['lap', 'header "LAP"', head('LAP')],
  ['status', 'glyph "✕"', w('✕') + 4],
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
