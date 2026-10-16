/**
 * Colours of the PCA biplot's outcome encoding (P2): three sequential
 * classes of the finishing position (podium, points, no points), picked from
 * a perceptual sequential colour map so that every class reaches WCAG 2.1
 * non-text contrast (3:1, SC 1.4.11) on the panel background, with the
 * lightness rising with the result (the better the finish, the brighter).
 *
 * Run from frontend/:
 *     npx vite-node scripts/pca_outcome_palette.mjs
 * Writes docs/evidence/pca_outcome_palette.txt and prints it.
 *
 * Method: the panel background is --color-bg-panel (rgba(20,20,40,0.75))
 * over --color-bg-primary (#0f0f1e) (styles/tokens.css, dark theme: the only
 * theme the store sets). For each colour map, t_low = the smallest t (step
 * 0.01) whose colour reaches 3:1 on that background and every t above it
 * does too; the classes sit at t_low, (t_low + 1) / 2 and 1. Reported: hex,
 * contrast, CIE L*, the smallest L* step between adjacent classes, and the
 * same contrasts for the team colours of utils/colors.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as d3 from 'd3';
import { TEAM_COLORS } from '../src/utils/colors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../../docs/evidence/pca_outcome_palette.txt');
const lines = [];
const emit = (s = '') => { lines.push(s); console.log(s); };

const PANEL = { r: 20, g: 20, b: 40, a: 0.75 };
const PAGE = d3.rgb('#0f0f1e');
const bg = d3.rgb(
  PANEL.r * PANEL.a + PAGE.r * (1 - PANEL.a),
  PANEL.g * PANEL.a + PAGE.g * (1 - PANEL.a),
  PANEL.b * PANEL.a + PAGE.b * (1 - PANEL.a),
);

function luminance(c) {
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const { r, g, b } = d3.rgb(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const lstar = (c) => d3.lab(c).l;
const hex = (c) => d3.rgb(c).formatHex();

emit(`panel background (composited): ${hex(bg)}`);
emit('');
const MAPS = {
  cividis: d3.interpolateCividis,
  viridis: d3.interpolateViridis,
  plasma: d3.interpolatePlasma,
  inferno: d3.interpolateInferno,
};
emit('map       t_low  classes (no points / points / podium)                      contrast            L*                min dL*');
for (const [name, interp] of Object.entries(MAPS)) {
  let tLow = null;
  for (let k = 100; k >= 0; k--) {
    const t = k / 100;
    if (contrast(interp(t), bg) >= 3) tLow = t; else break;
  }
  const ts = [tLow, (tLow + 1) / 2, 1];
  const cols = ts.map((t) => hex(interp(t)));
  const cs = cols.map((c) => contrast(c, bg).toFixed(2));
  const ls = cols.map((c) => lstar(c).toFixed(1));
  const dl = Math.min(lstar(cols[1]) - lstar(cols[0]), lstar(cols[2]) - lstar(cols[1]));
  emit(`${name.padEnd(9)} ${tLow.toFixed(2)}   ${cols.join(' / ')} (t ${ts.map((t) => t.toFixed(3)).join(', ')})   ${cs.join(' / ')}   ${ls.join(' / ')}   ${dl.toFixed(1)}`);
}
emit('');
emit('Chosen: cividis (designed for colour-vision deficiency; monotone lightness).');
emit('');
emit('Team colours on the same background (utils/colors.js TEAM_COLORS):');
for (const [team, c] of Object.entries(TEAM_COLORS)) {
  emit(`  ${team.padEnd(16)} ${c}  contrast ${contrast(c, bg).toFixed(2)}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
