// Repair 3 (V5 row "Lap Times timing sheet"): what the timing sheet body
// holds and the room its panes give it, at the four target viewports.
// The sheet lists the whole field (LapTimeChart.jsx reads the session's
// lap_times; utils/views/lapTimeChart.js lapTimingSheet: one row per driver;
// displayRows filters only by qualifying segment), so 20 rows in a race.
// Room for the rows (an UPPER bound, so the rows shown are at most this):
// pane height - panel header (2 x --spacing-sm + one line of the data type at
// 1.2) - sheet column header (4 + 4 px padding + data x 1.2 + 1 px border) -
// lap-range bar (4 + 6 px padding + a label line of the label type at 1.2 +
// 3 px + the 16 px bar). Smallest row: 16 px (the compact 16 px team logo,
// no padding; the real row adds a 1 px border and the text line).
// Run: node frontend/scripts/audit/laptimes_sheet_fit.mjs
// Writes docs/evidence/laptimes_sheet_fit.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('laptimes_sheet_fit.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const { WINDOW_PRESETS } = await import(pathToFileURL(path.join(SRC, 'utils/windowPresets.js')).href);
const css = M.loadCss(SRC);
const ROW_MIN = 16;
const FIELD = 20;
const out = [];
for (const vp of M.VIEWPORTS) {
  const data = M.px(css, '--font-size-data', vp);
  const label = M.px(css, '--font-size-label', vp);
  const sm = M.px(css, '--spacing-sm', vp);
  const panelHeader = 2 * sm + 1.2 * data + 1;
  const colHeader = 8 + 1.2 * data + 1;
  const lapBar = 10 + 1.2 * label + 3 + 16;
  for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
    for (const p of M.dockedPanesAt(css, preset.dockedLayout, vp)) {
      if (!p.tabs.includes('laptimes')) continue;
      const room = p.height - panelHeader - colHeader - lapBar;
      const shown = Math.max(0, Math.min(FIELD, Math.floor(room / ROW_MIN)));
      out.push({ vp: `${vp.W}x${vp.H}`, key, pane: p.height, room, shown });
      console.log(`${shown < FIELD ? 'scrolls' : 'fits   '} ${vp.W}x${vp.H} ${key.padEnd(10)} pane ${p.width.toFixed(0)} x ${p.height.toFixed(0)} px, room for rows <= ${room.toFixed(0)} px: at most ${shown} of the ${FIELD} rows at ${ROW_MIN} px (the field needs ${FIELD * ROW_MIN} px)`);
    }
  }
}
const scroll = out.filter((r) => r.shown < FIELD);
const panes = scroll.map((r) => r.pane);
console.log(`\nsummary: the body scrolls in ${scroll.length} of ${out.length} preset x viewport cases (${[...new Set(scroll.map((r) => r.key))].join(', ')}); `
  + `those panes are ${Math.min(...panes).toFixed(0)}-${Math.max(...panes).toFixed(0)} px high; fewest rows shown: ${Math.min(...scroll.map((r) => r.shown))} of ${FIELD}`);
console.log('A focus driver with a forecast adds below the field a header line, one row per forecast lap (5) and the 90 px forecast chart (LapTimeChart.jsx ForecastChart H = 90).');
