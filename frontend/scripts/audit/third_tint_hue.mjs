// A third-driver tint that keeps the team hue.
// The old rule searched mixes of 10-90 % toward white or black and picked the
// farthest mark: near-white or near-black for most teams, so the third drivers
// of different teams (e.g. Alpine #FFF3F8, Haas #F8F8F8, Williams #F0F9FF)
// were CIEDE2000 0.7-3.0 apart, all dashed 2,2. Candidate rule: the mix weight
// is capped (the tint keeps a share of the team colour, so its hue), and among
// the allowed mixes the mark farthest (worst vision type) from the marks of
// the team colour and of tint 1 is taken. Prints, per cap: the smallest
// distance to the team's other two marks, and the smallest distance between
// third-driver marks of different teams (same dash 2,2).
// Run: node frontend/scripts/audit/third_tint_hue.mjs
// Writes docs/evidence/third_tint_hue.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';
teeToEvidence('third_tint_hue.txt');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const C = await import(pathToFileURL(path.join(ROOT, 'frontend/src/utils/colors.js')).href);
const types = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
const d = (a, b) => Math.min(...types.map((t) => C.deltaE2000(t === 'normal' ? a : C.simulateCvd(a, t), t === 'normal' ? b : C.simulateCvd(b, t))));
// one colour per team (2024 + 2025 names, RB = Racing Bulls)
const teams = Object.entries(C.TEAM_COLORS).filter(([k]) => k !== 'Racing Bulls');
const tint1 = (c) => (C.relativeLuminance(c) < 0.4 ? C.mixColors(c, '#FFFFFF', 0.45) : C.mixColors(c, '#000000', 0.38));
function tint2(c, cap) {
  const m0 = C.markColor(c);
  const m1 = C.markColor(tint1(c));
  let best = null;
  for (const target of ['#FFFFFF', '#000000']) {
    for (let step = 2; step * 0.05 <= cap + 1e-9; step += 1) {
      const t = C.mixColors(c, target, step * 0.05);
      const m = C.markColor(t);
      const v = Math.min(d(m0, m), d(m1, m));
      if (!best || v > best.v) best = { v, t, m, w: step * 0.05, target };
    }
  }
  return best;
}
for (const cap of [0.9, 0.7, 0.6, 0.5, 0.4]) {
  const rows = teams.map(([team, c]) => ({ team, c, ...tint2(c, cap) }));
  const own = Math.min(...rows.map((r) => r.v));
  let cross = Infinity; let pair = '';
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const v = d(rows[i].m, rows[j].m);
      if (v < cross) { cross = v; pair = `${rows[i].team} ${rows[i].t} / ${rows[j].team} ${rows[j].t}`; }
    }
  }
  console.log(`cap ${cap}: smallest distance to the team colour / tint 1 marks ${own.toFixed(1)}; smallest distance between third-driver marks of two teams ${cross.toFixed(1)} (${pair})`);
  if (cap === 0.5) for (const r of rows) console.log(`   ${r.team.padEnd(16)} ${r.c} -> ${r.t} (${r.target === '#FFFFFF' ? 'white' : 'black'} ${r.w.toFixed(2)}), mark ${r.m}, dE to own ${r.v.toFixed(1)}`);
}

// One season's line-up (2024 team names): third-driver marks against each
// other and against every mark of the other teams (team colour, tint 1)
const S2024 = ['Red Bull Racing', 'Ferrari', 'Mercedes', 'McLaren', 'Aston Martin', 'Alpine', 'Williams', 'RB', 'Haas F1 Team', 'Kick Sauber'];
for (const cap of [0.9, 0.6]) {
  const rows = S2024.map((team) => ({ team, c: C.TEAM_COLORS[team], ...tint2(C.TEAM_COLORS[team], cap) }));
  let a = Infinity; let pa = '';
  let b = Infinity; let pb = '';
  for (const r of rows) {
    for (const o of rows) {
      if (o.team === r.team) continue;
      const v = d(r.m, o.m);
      if (v < a) { a = v; pa = `${r.team} ${r.t} / ${o.team} ${o.t}`; }
      for (const om of [C.markColor(o.c), C.markColor(tint1(o.c))]) {
        const w = d(r.m, om);
        if (w < b) { b = w; pb = `${r.team} third ${r.t} / ${o.team} mark ${om}`; }
      }
    }
  }
  console.log(`2024, cap ${cap}: third drivers of two teams (both dashed 2,2) at least ${a.toFixed(1)} apart (${pa}); a third driver and another team's solid or 6,3 mark at least ${b.toFixed(1)} apart (${pb})`);
}
