// Low ends of the Track Map channel ramps at >= 3:1 on the map
// background (the panel surface): the track-surface grey lifted by markColor,
// and the first cividis t whose colour reaches 3:1.
// Run: node frontend/scripts/audit/ramp_ends.mjs
// Writes docs/evidence/ramp_ends.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('ramp_ends.txt');
const C = await import(pathToFileURL(path.resolve('frontend/src/utils/colors.js')).href);
const d3 = await import(pathToFileURL(path.resolve('frontend/node_modules/d3/src/index.js')).href);
for (const bg of [C.SURFACES.page, C.SURFACES.panel, '#101020']) {
  const low = C.markColor(C.TRACK_COLORS.surface, bg);
  let t0 = 0;
  while (C.contrastRatio(d3.color(d3.interpolateCividis(t0)).formatHex(), bg) < 3) t0 = +(t0 + 0.01).toFixed(2);
  console.log(`bg ${bg}: track grey ${C.TRACK_COLORS.surface} ${C.contrastRatio(C.TRACK_COLORS.surface, bg).toFixed(2)} -> lifted ${low} ${C.contrastRatio(low, bg).toFixed(2)}; cividis first t >= 3:1 = ${t0} (${d3.color(d3.interpolateCividis(t0)).formatHex()} ${C.contrastRatio(d3.color(d3.interpolateCividis(t0)).formatHex(), bg).toFixed(2)})`);
}
