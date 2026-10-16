// V5: static inventory of every scrollable area in the frontend.
//
// Lists every overflow / overflow-x / overflow-y set to auto | scroll |
// overlay in the CSS (frontend/src/**/*.css) and in inline styles of the
// .jsx / .js sources (React style objects, D3 .style('overflow', ...)),
// with a stable key per area, and checks each key against the
// "Inventory key" column of docs/SCROLL_JUSTIFICATIONS.md. The inventory
// itself lives in frontend/src/__tests__/helpers/scrollInventory.js (also
// used by __tests__/layout.scroll.test.js).
//
//   CSS key:  <file basename> <selector>          e.g. `dashboard.css .settings-tab`
//   JS key:   <file basename>:<enclosing name>#<k> e.g. `TimingTower.jsx:bodyStyle#1`
//
// Exit code 1 when an area is not justified (or a justification row names a
// key that no longer exists). Run:
//   node frontend/scripts/audit/overflow_inventory.mjs
// Writes docs/evidence/overflow_inventory.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('overflow_inventory.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { scrollInventory } = await import(
  pathToFileURL(path.join(ROOT, 'frontend/src/__tests__/helpers/scrollInventory.js')).href
);

const { areas, keys, stale } = scrollInventory(ROOT);
const unjustified = areas.filter((a) => !a.row).length;
console.log(`Scroll inventory (overflow auto|scroll|overlay), ${new Date().toLocaleDateString('sv-SE')}`);
console.log(`Doc: docs/SCROLL_JUSTIFICATIONS.md, ${keys.size} inventory keys\n`);
for (const a of areas) {
  const media = a.media ? ` @media ${a.media} (live at: ${a.live.join(', ') || 'none of the four viewports'})` : '';
  console.log(`${a.row ? 'JUSTIFIED  ' : 'UNJUSTIFIED'} ${a.file}:${a.line}  \`${a.key}\`  ${a.decl}${media}${a.row ? `  -> row "${a.row}"` : ''}`);
}
for (const k of stale) console.log(`STALE ROW   \`${k}\` (row "${keys.get(k)}") names no scroll area in the code`);
console.log(`\nTotal ${areas.length} scroll areas (${areas.filter((a) => a.kind === 'css').length} CSS, ${areas.filter((a) => a.kind === 'js').length} inline/D3); justified ${areas.length - unjustified}; unjustified ${unjustified}; stale rows ${stale.length}`);
process.exitCode = unjustified || stale.length ? 1 : 0;
