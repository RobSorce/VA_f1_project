// Repair (V1 minor): the smallest alpha at which the diverging tints of the
// Lap Delta chart and the telemetry delta areas reach 3:1 against the
// surfaces they are drawn on (WCAG 1.4.11 non-text contrast).
// Run: node frontend/scripts/audit/area_alpha.mjs
// Writes docs/evidence/area_alpha.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('area_alpha.txt');
const C = await import(pathToFileURL(path.resolve('frontend/src/utils/colors.js')).href);
const surfaces = { panel: C.SURFACES.panel, raised: '#1A1F33', elevated: C.SURFACES.elevated };
for (const [name, col] of Object.entries({ worse: C.DIVERGING.worse, better: C.DIVERGING.better })) {
  for (const [sn, bg] of Object.entries(surfaces)) {
    let a = 0;
    while (a < 1 && C.contrastRatio(C.mixColors(bg, col, a), bg) < 3) a = Math.round((a + 0.01) * 100) / 100;
    console.log(`${name} ${col} on ${sn} ${bg}: alpha 0.22 -> ${C.contrastRatio(C.mixColors(bg, col, 0.22), bg).toFixed(2)}:1; 3:1 from alpha ${a.toFixed(2)}`);
  }
}
