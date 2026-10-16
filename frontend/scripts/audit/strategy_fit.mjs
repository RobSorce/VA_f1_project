// Repair of V13 (Strategy Timeline in the pitwindow preset): driver rows per
// page at the four target viewports, in every window preset that holds the
// strategy view. The view (StrategyTimeline.jsx) fits its rows to the chart
// (fitRows, rows >= ceil(data type + 9) px); a wide pane that cannot hold
// every row in one column lays them in up to 3 columns (>= 400 px each); the
// other drivers are paged with the pager in the Panel header.
// Chart height = pane - Panel chrome (header: --spacing-sm x 2 + the 22 px
// export button + 1 px rule; content padding --spacing-sm x 2, the view's
// Panel being .panel--dense, else --spacing-md x 2) - the legend
// line under the chart (label type x 1.3 + 6) - the chart margins (12 + 28).
// 20 drivers.
// Run: node frontend/scripts/audit/strategy_fit.mjs
// Writes docs/evidence/strategy_fit.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('strategy_fit.txt');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const { WINDOW_PRESETS } = await import(pathToFileURL(path.join(SRC, 'utils/windowPresets.js')).href);
const { fitRows } = await import(pathToFileURL(path.join(SRC, 'utils/views/chartBox.js')).href);
const view = fs.readFileSync(path.join(SRC, 'components/visualizations/StrategyTimeline.jsx'), 'utf8');
const pad = Number((view.match(/const ROW_MIN_PAD = (\d+);/) || [])[1]);
const [mt, mb] = [Number((view.match(/const MARGIN = \{ top: (\d+)/) || [])[1]), Number((view.match(/bottom: (\d+), left/) || [])[1])];
const maxCols = Number((view.match(/const MAX_COLS = (\d+);/) || [])[1]);
const colMinW = Number((view.match(/const COL_MIN_W = (\d+);/) || [])[1]);
const right = Number((view.match(/const MARGIN = \{[^}]*right: (\d+)/) || [])[1]);
const css = M.loadCss(SRC);
const N = 20;
const dense = /className="panel--dense"/.test(view);
for (const vp of M.VIEWPORTS) {
  const data = M.px(css, '--font-size-data', vp);
  const label = M.px(css, '--font-size-label', vp);
  const sm = M.px(css, '--spacing-sm', vp);
  const md = M.px(css, '--spacing-md', vp);
  const rowMin = Math.ceil(data + pad);
  for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
    for (const pane of M.dockedPanesAt(css, preset.dockedLayout, vp)) {
      if (!pane.tabs.includes('strategy')) continue;
      const pad = dense ? sm : md;
      const chart = pane.height - (2 * sm + 22 + 1) - 2 * pad - (label * 1.3 + 6);
      const width = pane.width - 2 * pad;
      const rows = fitRows(chart - mt - mb, N, { rowMin, rowMax: 1000 });
      const cols = rows.paged ? Math.max(1, Math.min(maxCols, Math.floor((width - right) / colMinW))) : 1;
      const perPage = Math.min(N, rows.perPage * cols);
      const rowH = rows.paged ? rowMin : (chart - mt - mb) / N;
      const lapW = (width - right) / cols - 96 - (cols > 1 ? 16 : 0);
      console.log(`${vp.name} ${key.padEnd(9)} strategy pane ${pane.width.toFixed(0)}x${pane.height.toFixed(0)}: chart ${chart.toFixed(0)} px -> ${cols} column(s) of ${Math.min(rows.perPage, N)} rows, ${perPage < N ? `${perPage} of ${N} drivers per page (${Math.ceil(N / perPage)} pages)` : `all ${N} drivers`}, rows ${rowH.toFixed(1)} px for ${data.toFixed(2)} px labels (min ${rowMin} px), ${lapW.toFixed(0)} px of laps per column`);
    }
  }
}
