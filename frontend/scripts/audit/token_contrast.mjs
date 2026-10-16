// V13: the contrast ratios quoted in the comments of
// frontend/src/styles/tokens.css (text greys, the text red, the key-cap
// greys, the light theme), computed with the WCAG 2.1 formula of
// frontend/src/__tests__/helpers/layoutCss.js.
//   node frontend/scripts/audit/token_contrast.mjs
// Writes docs/evidence/token_contrast.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('token_contrast.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const H = await import(pathToFileURL(path.join(ROOT, 'frontend/src/__tests__/helpers/layoutCss.js')).href);

const ratio = (fg, bg) => {
  const back = H.flatten(['#0f0f1e', bg]);
  return H.contrast(H.over(H.parseColor(fg), back), back).toFixed(2);
};
const rows = [
  // dark theme surfaces (utils/colors.js SURFACES): page, panel, raised, elevated
  ['--color-text-secondary #C9CCD6', '#C9CCD6', ['#0f0f1e', '#131326', '#1a1f33', '#242938']],
  ['--color-text-muted #A3A7B7', '#A3A7B7', ['#0f0f1e', '#131326', '#1a1f33', '#242938']],
  ['old muted rgba(255,255,255,0.45)', 'rgba(255,255,255,0.45)', ['#0f0f1e', '#242938']],
  ['--color-f1-red #e10600 (as text)', '#e10600', ['#0f0f1e', '#242938', 'rgba(225,6,0,0.12)']],
  ['--color-f1-red-text #FF6B63', '#FF6B63', ['#0f0f1e', '#242938', 'rgba(225,6,0,0.12)']],
  ['--rh-text-muted #A6A6A6', '#A6A6A6', ['#141414', '#222222', '#2A2A2A']],
  ['--rh-text-faint #9A9A9A', '#9A9A9A', ['#141414', '#222222', '#2A2A2A']],
  ['--rh-text-dimmed #939393', '#939393', ['#141414', '#222222', '#2A2A2A']],
  ['old --rh-text-muted #666666', '#666666', ['#222222']],
  ['old --rh-text-faint #555555', '#555555', ['#222222']],
  ['old --rh-text-dimmed #444444', '#444444', ['#222222']],
];
console.log(`Token contrast (WCAG 2.1; a translucent background is composited over the page #0f0f1e), ${new Date().toLocaleDateString('sv-SE')}`);
for (const [name, fg, bgs] of rows) console.log(`  ${name.padEnd(36)} ${bgs.map((b) => `on ${b} ${ratio(fg, b)}:1`).join(', ')}`);
// light theme: opaque surfaces, no page underneath
const light = (fg, bg) => H.contrast(H.parseColor(fg), H.parseColor(bg)).toFixed(2);
console.log('Light theme ([data-theme="light"]):');
for (const [name, fg] of [['--color-text-muted #5F6673', '#5F6673'], ['--color-f1-red-text #B80500', '#B80500']]) {
  console.log(`  ${name.padEnd(36)} ${['#F7F6F3', '#FFFFFF', '#EFEEE9'].map((b) => `on ${b} ${light(fg, b)}:1`).join(', ')}`);
}
