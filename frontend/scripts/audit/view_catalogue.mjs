// What each file of components/visualizations draws with,
// for the catalogue of docs/MASTER_LEDGER.md section 8. A view "draws with
// D3" when it selects and draws SVG with d3 itself (d3.select) or calls a
// utils/views helper that does (the D3 ports draw through such helpers);
// otherwise it is HTML (a table, a grid, cards), even when it uses a d3 scale
// for a colour (noted). Also lists the D3 drawing helpers each view uses.
// Run: node frontend/scripts/audit/view_catalogue.mjs
// Writes docs/evidence/view_catalogue.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('view_catalogue.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const VIS = path.join(ROOT, 'frontend/src/components/visualizations');
const VIEWS = path.join(ROOT, 'frontend/src/utils/views');
const importsD3 = (src) => /from ['"]d3['"]|import\s+\*\s+as\s+d3\s+from/.test(src);
const drawsD3 = (src) => importsD3(src) && /d3\.select\(|\.append\(/.test(src);
const helperD3 = new Map();
for (const f of fs.readdirSync(VIEWS).filter((x) => x.endsWith('.js'))) {
  helperD3.set(f.replace(/\.js$/, ''), drawsD3(fs.readFileSync(path.join(VIEWS, f), 'utf8')));
}
// a helper that imports another D3 helper draws with D3 too (one level)
for (const f of [...helperD3.keys()]) {
  const src = fs.readFileSync(path.join(VIEWS, `${f}.js`), 'utf8');
  for (const m of src.matchAll(/from ['"]\.\/([\w]+)(?:\.js)?['"]/g)) if (helperD3.get(m[1])) helperD3.set(f, true);
}
const rows = [];
for (const f of fs.readdirSync(VIS).filter((x) => x.endsWith('.jsx')).sort()) {
  const src = fs.readFileSync(path.join(VIS, f), 'utf8');
  const own = drawsD3(src);
  const scaleOnly = !own && (importsD3(src) || [...src.matchAll(/from ['"]\.\.\/\.\.\/utils\/views\/([\w]+)(?:\.js)?['"]/g)]
    .some((m) => fs.existsSync(path.join(VIEWS, `${m[1]}.js`)) && importsD3(fs.readFileSync(path.join(VIEWS, `${m[1]}.js`), 'utf8'))));
  const helpers = [...src.matchAll(/from ['"]\.\.\/\.\.\/utils\/views\/([\w]+)(?:\.js)?['"]/g)].map((m) => m[1]).filter((h) => helperD3.get(h));
  const d3 = own || helpers.length > 0;
  rows.push({ f, d3, own, helpers });
  console.log(`${d3 ? 'D3  ' : 'HTML'} ${f}${own ? ' (draws with d3)' : ''}${helpers.length ? ` (D3 drawing helpers: ${[...new Set(helpers)].join(', ')})` : ''}${!d3 && scaleOnly ? ' (a d3 scale for colours only)' : ''}`);
}
const n = rows.length;
const d3n = rows.filter((r) => r.d3).length;
console.log(`\n${n} view files in components/visualizations: ${d3n} draw with D3, ${n - d3n} are HTML only (${rows.filter((r) => !r.d3).map((r) => r.f.replace('.jsx', '')).join(', ')})`);
console.log(`SpeedPanel.jsx exists: ${fs.existsSync(path.join(VIS, 'SpeedPanel.jsx'))}`);
