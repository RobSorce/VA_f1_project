// Repair 3 (V4 r2 minor): the legend rows of every view whose legend is
// built by a helper of utils/views (the rows each view's Legend / drawLegend
// draws), printed label by label with the swatch shape, glyph and dash, for
// the per-view list of docs/COLOR_ENCODING.md ("Legend rows per view").
// Sample inputs: the McLaren / Mercedes line-up below, Monza-like states.
// Run from frontend/: npx vite-node scripts/audit/legend_rows.mjs
// Writes docs/evidence/legend_rows.txt (or the file after --out) and prints the same text.
import { setSessionDriverColors } from '../../src/utils/colors.js';
import { timingSheetLegend, forecastChartLegend } from '../../src/utils/views/lapTimeChart.js';
import { timingTowerLegend } from '../../src/utils/views/timingTower.js';
import { paceLegend } from '../../src/utils/views/racePaceGrid.js';
import { sectorsLegend } from '../../src/utils/views/sectorsPanel.js';
import { pitWallLegend } from '../../src/utils/views/pitWallSectorPanel.js';
import { lapDeltaLegend } from '../../src/utils/views/lapDeltaChart.js';
import {
  championshipLegend, championshipStandingsLegend, championshipStyles, usedDashes,
} from '../../src/utils/views/championshipChart.js';
import { teamPairLegend } from '../../src/utils/views/teamLegend.js';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('legend_rows.txt');

const LINEUP = [
  { Abbreviation: 'NOR', TeamName: 'McLaren', DriverNumber: '4' },
  { Abbreviation: 'PIA', TeamName: 'McLaren', DriverNumber: '81' },
  { Abbreviation: 'HAM', TeamName: 'Mercedes', DriverNumber: '44' },
  { Abbreviation: 'RUS', TeamName: 'Mercedes', DriverNumber: '63' },
];
setSessionDriverColors(LINEUP);
const row = (i) => [
  i.shape || 'line',
  i.glyph ? `glyph ${i.glyph}` : '',
  i.dash ? `dash ${i.dash}` : '',
  i.color2 ? `pair ${i.color}/${i.color2}` : (i.color ? i.color : ''),
  JSON.stringify(i.label ?? ''),
].filter(Boolean).join(' ');
const show = (name, items) => {
  console.log(`${name}: ${items.length} rows`);
  for (const i of items) console.log(`   ${row(i)}`);
};
show('Lap Times sheet (timingSheetLegend, with a forecast)', timingSheetLegend({ forecast: true }));
show('Lap Times forecast chart (forecastChartLegend)', forecastChartLegend('#FF8000', true));
show('Timing Tower (timingTowerLegend)', timingTowerLegend());
show('Race Pace Grid (paceLegend)', paceLegend());
show('Sectors panel, live (sectorsLegend)', sectorsLegend('live'));
show('Sectors panel, best (sectorsLegend)', sectorsLegend('best'));
show('Pit Wall sector panel (pitWallLegend)', pitWallLegend());
show('Lap Delta (lapDeltaLegend, base NOR)', lapDeltaLegend('NOR', ['PIA', 'HAM']));
const entries = [
  { abbr: 'NOR', team: 'McLaren', position: 1 }, { abbr: 'PIA', team: 'McLaren', position: 2 },
  { abbr: 'HAM', team: 'Mercedes', position: 3 }, { abbr: 'RUS', team: 'Mercedes', position: 4 },
  { abbr: 'ANT', team: 'Mercedes', position: 9 },
];
const st = championshipStyles(entries, true);
show('Championship chart (championshipLegend, a third Mercedes driver)', championshipLegend({ isDriverView: true, showPredictions: true, dashes: usedDashes(st) }));
show('Championship standings (championshipStandingsLegend)', championshipStandingsLegend(entries, st, true));
show('Race Situation map (teamPairLegend)', teamPairLegend(LINEUP));
