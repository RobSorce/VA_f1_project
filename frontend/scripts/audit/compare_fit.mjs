// Repair of V13 (Driver Comparison): the panel's sections in columns and
// pages that fit its pane, at the four target viewports, in every window
// preset that holds the compare view (utils/windowPresets.js), with the
// view's own layout functions (utils/views/driverCompare.js). Panel chrome
// from dashboard.css: header 6 + 6 padding around a driver card (4 + 4
// padding, abbr 18 px + 1 + a data line x 1.3, 1 px borders) and its 1 px
// rule; body padding 6 + 6. Tables: 3 sector rows, 4 speed rows, 5 summary
// rows, tyres shown.
// Run: node frontend/scripts/audit/compare_fit.mjs
// Writes docs/evidence/compare_fit.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('compare_fit.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const { WINDOW_PRESETS } = await import(pathToFileURL(path.join(SRC, 'utils/windowPresets.js')).href);
const D = await import(pathToFileURL(path.join(SRC, 'utils/views/driverCompare.js')).href);
const css = M.loadCss(SRC);
let fails = 0;
for (const vp of M.VIEWPORTS) {
  const data = M.px(css, '--font-size-data', vp);
  const header = 12 + (8 + Math.max(28, 18 + 1 + Math.ceil(data * 1.3)) + 2) + 1;
  const sections = D.compareSections({ sectors: 3, speeds: 4, summary: 5, tyres: true }, data);
  for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
    for (const pane of M.dockedPanesAt(css, preset.dockedLayout, vp)) {
      if (!pane.tabs.includes('compare')) continue;
      const body = { width: Math.floor(pane.width - 20), height: Math.floor(pane.height - header - 12) };
      const { pages, cols, pagerH } = D.comparePages(body, sections);
      const room = body.height - pagerH - (pagerH ? D.COMPARE_GAP : 0);
      const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));
      let worst = 0;
      const desc = pages.map((pg) => pg.map((col) => {
        const used = col.reduce((a, k, i) => a + byKey[k].h + (i ? D.COMPARE_GAP : 0), 0);
        // a chart shrinks to its column (it reads its box); a table must fit whole
        const tables = col.filter((k) => byKey[k].kind === 'table').reduce((a, k) => a + byKey[k].h, 0)
          + (col.length - 1) * D.COMPARE_GAP;
        worst = Math.max(worst, tables - room, col.some((k) => byKey[k].kind === 'chart') ? 0 : used - room);
        return col.join('+');
      }).join(' | ')).join('  //  ');
      const ok = worst <= 0;
      if (!ok) fails += 1;
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${vp.name} ${key.padEnd(9)} pane ${pane.width.toFixed(0)}x${pane.height.toFixed(0)}: body ${body.width}x${body.height} (data ${data.toFixed(2)} px, header ${header} px), ${cols} column(s) of >= ${D.COMPARE_COL_MIN_W} px, ${pages.length} page(s)${pagerH ? ' with the pager' : ''}: ${desc}${ok ? '' : ` (a table is ${worst.toFixed(0)} px taller than its column)`}`);
    }
  }
}
console.log(`sections (px at 11 px data): ${D.compareSections({ sectors: 3, speeds: 4, summary: 5, tyres: true }, 11).map((s) => `${s.key} ${s.h}`).join(', ')}; a chart is >= ${D.COMPARE_CHART_MIN_H} px and takes what its column leaves`);
console.log(fails ? `${fails} pane(s) where a table does not fit` : 'Every section of the Driver Comparison fits a column of its page at the four target viewports: nothing is cut, nothing scrolls.');
process.exitCode = fails ? 1 : 0;
