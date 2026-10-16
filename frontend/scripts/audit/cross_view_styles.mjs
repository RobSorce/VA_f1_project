// V3: for every session of public/data and the championship of
// its year: (1) is every driver of the session drawn alike in the session
// views (getDriverColor / getDriverDash) and in the Championship tab
// (championshipStyles, driver view)? (2) do two drivers of one team share a
// colour or a dash pattern in the championship? (3) the championship's
// teammate styles with no session loaded (the static 2024 map).
// Run from frontend/: npx vite-node scripts/audit/cross_view_styles.mjs
// Writes docs/evidence/cross_view_styles.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { championshipStyles } from '../../src/utils/views/championshipChart.js';
import { setSessionDriverColors, getDriverColor, getDriverDash } from '../../src/utils/colors.js';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('cross_view_styles.txt');

const gz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
function teamClashes(entries, styles) {
  const byTeam = {};
  for (const e of entries) (byTeam[e.team] ||= []).push(e.abbr);
  const out = [];
  for (const [team, ds] of Object.entries(byTeam)) {
    for (let i = 0; i < ds.length; i++) for (let j = i + 1; j < ds.length; j++) {
      const a = styles[ds[i]]; const b = styles[ds[j]];
      if (a.color === b.color || (a.dash || null) === (b.dash || null)) out.push(`  ${team}: ${ds[i]} ${a.color} ${a.dash || 'solid'} / ${ds[j]} ${b.color} ${b.dash || 'solid'}`);
    }
  }
  return out;
}
const dirs = fs.readdirSync('public/data').filter((d) => /^\d{4}_\d+_R$/.test(d));
for (const year of [2024, 2025]) {
  const champ = gz(`public/data/championship_${year}.json.gz`);
  const entries = [...champ.drivers].sort((a, b) => a.position - b.position);
  setSessionDriverColors([]);
  const none = teamClashes(entries, championshipStyles(entries, true));
  console.log(`${year} championship, no session loaded: teammates sharing a colour or a dash: ${none.length}`);
  for (const l of none) console.log(l);
  for (const dir of dirs.filter((d) => d.startsWith(`${year}_`))) {
    const sess = gz(`public/data/${dir}/session.json.gz`);
    const info = sess.driver_info || sess.data?.driver_info || sess.session?.driver_info;
    setSessionDriverColors(info);
    const styles = championshipStyles(entries, true);
    const diff = [];
    for (const e of entries) {
      const inSession = info.some((d) => (d.Abbreviation || d.abbreviation) === e.abbr);
      if (!inSession) continue;
      const sv = { color: getDriverColor(e.abbr), dash: getDriverDash(e.abbr) || null };
      const cv = styles[e.abbr];
      if (sv.color !== cv.color || sv.dash !== (cv.dash || null)) diff.push(`  ${e.abbr} (${e.team}): session ${sv.color} ${sv.dash || 'solid'} | championship ${cv.color} ${cv.dash || 'solid'}`);
    }
    const clash = teamClashes(entries, styles);
    console.log(`${dir} loaded: session drivers drawn differently in the championship ${diff.length}; teammates sharing a colour or a dash ${clash.length}`);
    for (const l of [...diff, ...clash]) console.log(l);
  }
}
process.exit(0);
