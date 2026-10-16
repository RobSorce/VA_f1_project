// Repair r2 (F8 minor): Position Tracker context end labels on the panel and
// on the brush tint, before (contextText on the panel) and after (on the tint).
//   node frontend/scripts/audit/posbrush_labels.mjs
// Writes docs/evidence/posbrush_labels.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('posbrush_labels.txt');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const C = await import(pathToFileURL(path.join(ROOT, 'frontend/src/utils/colors.js')).href);
const { TEAM_COLORS, SURFACES, textColor, contextText, contrastRatio, brushTintOver, CONTEXT_MIX_LINES, BRUSH_TINT_ALPHA } = C;
const panel = SURFACES.panel;
const tint = brushTintOver(panel);
console.log(`brush tint alpha ${BRUSH_TINT_ALPHA.toFixed(3)}: background ${tint}`);
const rows = [];
for (const [team, col] of Object.entries(TEAM_COLORS)) {
  const t = textColor(col);
  const before = contextText(t, panel, CONTEXT_MIX_LINES);
  const after = contextText(t, tint, CONTEXT_MIX_LINES);
  rows.push({ team, before, after,
    bPanel: contrastRatio(before, panel), bTint: contrastRatio(before, tint),
    aPanel: contrastRatio(after, panel), aTint: contrastRatio(after, tint) });
}
for (const r of rows) console.log(`${r.team.padEnd(18)} before ${r.before} panel ${r.bPanel.toFixed(2)} tint ${r.bTint.toFixed(2)} | after ${r.after} panel ${r.aPanel.toFixed(2)} tint ${r.aTint.toFixed(2)}`);
const min = (k) => Math.min(...rows.map((r) => r[k])).toFixed(2);
const max = (k) => Math.max(...rows.map((r) => r[k])).toFixed(2);
console.log(`before: panel ${min('bPanel')}-${max('bPanel')}, tint ${min('bTint')}-${max('bTint')}`);
console.log(`after:  panel ${min('aPanel')}-${max('aPanel')}, tint ${min('aTint')}-${max('aTint')}`);
