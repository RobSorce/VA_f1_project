// Repair of V5 (cheatsheet): does the shortcut cheatsheet show its
// shortcuts without a scrollbar at the four target viewports, now that a
// section may continue in the next column (ShortcutCheatsheet.css: rows never
// split, a title never ends a column, rows 2 px padding, modal 92vh)?
//
// UPPER-bound estimate of the content: every description wrapped at an
// average glyph width of 0.58 em (13 px sans) and keys at 0.62 em (mono),
// line-height 1.25 (CSS 'normal' is about 1.15-1.2), every section margin
// counted; the three columns balanced as a browser does (the smallest height
// for which the unbreakable chunks fill three columns in order).
// Run: node frontend/scripts/audit/cheatsheet_fit.mjs
// Writes docs/evidence/cheatsheet_fit.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('cheatsheet_fit.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const css = M.loadCss(SRC);
const jsx = fs.readFileSync(path.join(SRC, 'components/ShortcutCheatsheet/ShortcutCheatsheet.jsx'), 'utf8');
const cs = fs.readFileSync(path.join(SRC, 'components/ShortcutCheatsheet/ShortcutCheatsheet.css'), 'utf8');

const starts = [...jsx.matchAll(/title: '([^']+)'/g)];
const sections = starts.map((m, i) => {
  const body = jsx.slice(m.index, starts[i + 1]?.index ?? jsx.length);
  const rows = [...body.matchAll(/\{ keys: \[([^\]]*)\], desc: [`']([^`']*)[`'] \}/g)].map((r) => ({
    keys: r[1].split(',').map((k) => k.trim().replace(/^[`']|[`']$/g, '').replace(/\$\{modKey\}/, 'Ctrl')
      .replace(/\\u[0-9A-F]{4}/gi, 'X')),
    desc: r[2].replace(/\$\{FIRST_SEASON_WITHOUT_DRS\}/, '2026'),
  }));
  return { title: m[1], rows };
});
const maxH = Number(cs.match(/\.cs-modal \{[^}]*max-height: (\d+)vh;/)[1]);
const cols = Number(cs.match(/\.cs-body \{[^}]*column-count: (\d+);/)[1]);
const rowPadV = Number(cs.match(/\.cs-row \{[^}]*padding: (\d+)px \d+px;/)[1]);
const sectionBreaks = !/\.cs-section \{[^}]*break-inside: avoid/.test(cs);
const nRows = sections.reduce((a, s) => a + s.rows.length, 0);
console.log(`${sections.length} sections, ${nRows} rows; ${cols} columns; modal max-height ${maxH}vh; row padding ${rowPadV} px; sections ${sectionBreaks ? 'may continue in the next column' : 'never split'}`);

const LH = 1.25;
for (const vp of M.VIEWPORTS) {
  const data = M.px(css, '--font-size-data', vp);
  const label = M.px(css, '--font-size-label', vp);
  const sm = M.px(css, '--font-size-sm', vp);
  const modalW = Math.min(1040, 0.94 * vp.W);
  const colW = (modalW - 2 - 40 - (cols - 1) * 24) / cols;
  const keyH = data * 1.4 + 4 + 2;
  const chunks = [];
  let wrapped = 0;
  for (const s of sections) {
    const titleH = label * LH + 8;
    s.rows.forEach((r, i) => {
      const keysW = r.keys.reduce((a, k) => a + Math.max(24, k.length * 0.62 * data + 16 + 2), 0) + (r.keys.length - 1) * 4;
      const avail = colW - 16 - 12 - keysW;
      const lines = Math.max(1, Math.ceil((r.desc.length * 0.58 * sm) / avail));
      if (lines > 1) wrapped += 1;
      const h = Math.max(keyH, lines * sm * LH) + 2 * rowPadV + 2;
      const last = i === s.rows.length - 1;
      chunks.push((i === 0 ? titleH : 0) + h + (last ? 12 : 0));
    });
  }
  const fits = (H) => {
    let col = 1;
    let acc = 0;
    for (const c of chunks) {
      if (c > H) return false;
      if (acc + c > H) { col += 1; acc = 0; }
      acc += c;
    }
    return col <= cols;
  };
  let lo = 0;
  let hi = chunks.reduce((a, b) => a + b, 0);
  while (hi - lo > 0.5) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  const column = hi;
  const header = 16 * 2 + Math.max(16 * LH, 11 * 1.4 + 3 * 2 + 2) + 1;
  const room = (maxH / 100) * vp.H - 2 - header - (12 + 16);
  const ok = column <= room;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${vp.W}x${vp.H}: column ${colW.toFixed(0)} px wide, ${wrapped} descriptions on 2+ lines; tallest column <= ${column.toFixed(0)} px, body room ${room.toFixed(0)} px (${ok ? `${(room - column).toFixed(0)} px to spare` : `short by ${(column - room).toFixed(0)} px`})`);
}
