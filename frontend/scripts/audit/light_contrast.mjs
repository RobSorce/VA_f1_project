// Contrast of the light-theme text colours set by the integrate step, on the
// light surfaces (tokens.css [data-theme="light"]): white, #F7F6F3, #EFEEE9.
// Run: node frontend/scripts/audit/light_contrast.mjs
// Writes docs/evidence/light_contrast.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('light_contrast.txt');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { contrastRatio } = await import(pathToFileURL(path.join(ROOT, 'frontend/src/utils/colors.js')).href);
const surfaces = { white: '#FFFFFF', 'bg-primary #F7F6F3': '#F7F6F3', 'bg-tertiary #EFEEE9': '#EFEEE9' };
const colours = {
  '--color-text-primary (light) #111827': '#111827',
  '--color-text-secondary (light) #4B5563': '#4B5563',
  '--color-text-muted (light) #5F6673': '#5F6673',
  'pos-chart-toggle--active #1D4ED8': '#1D4ED8',
  'before: #9CA3AF': '#9CA3AF',
  'before: #16a34a': '#16a34a',
  'before: #D1D5DB': '#D1D5DB',
};
for (const [name, c] of Object.entries(colours)) {
  console.log(`${name.padEnd(38)} ${Object.entries(surfaces).map(([s, b]) => `${s} ${contrastRatio(c, b).toFixed(2)}:1`).join('   ')}`);
}
