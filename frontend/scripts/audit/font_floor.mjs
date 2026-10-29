// V13 target (3): minimum font sizes, checked statically.
//
//  CSS  every font-size declaration in frontend/src/**/*.css is evaluated
//       (var() tokens of :root, rem from the fluid root font-size of
//       base.css, vw / vh, calc / clamp / min / max) at the four target
//       viewports where its @media applies. Floors: 11 px for every size,
//       except a size given through the --font-size-label token (non-data text,
//       floor 10 px). So a size between 10 and 11 px is possible only by
//       naming it UI text on purpose.
//  JS   literal font sizes in .jsx / .js (style objects, SVG fontSize props,
//       D3 .attr/.style('font-size', ...), CSS text in template strings):
//       < 10 px FAIL, 10 to < 11 px CHECK (allowed for non-data text only),
//       identifiers resolved from a same-file `const X = <number>`, other
//       expressions listed as DYNAMIC. var(--font-size-*) tokens and colors.js CHART_FONT pass.
//
//  DYN  every DYNAMIC expression is then resolved to its floor
//       (resolveDynamic: UNSET, TOKEN, CALLER, FLOOR); one that cannot be
//       resolved, or whose floor is under 10 px, fails the gate.
//
// Exit code 1 when a CSS size or a JS size in the files of the layout lane
// fails, or a DYNAMIC size is unresolved or under 10 px.
// Run: node frontend/scripts/audit/font_floor.mjs [--all]
// Writes docs/evidence/font_floor.txt (or the file after --out) and prints the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const H = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutCss.js')).href);

const DATA_FLOOR = 11;
const UI_FLOOR = 10;

// Files of the layout lane (Phase 9): their JS sizes gate the exit code.
const LAYOUT_LANE = [
  'components/layout/', 'components/ShortcutHints/', 'components/ShortcutCheatsheet/', 'components/CommandPalette/',
  ...['Header', 'Footer', 'BottomTabBar', 'LayoutPresetBar', 'LayoutDockPopover', 'DockCustomizePopover',
    'DockOverflowPopover', 'DockContextMenu', 'Panel', 'PanelToggleBar', 'SessionInfoBar', 'WeatherBar',
    'WeatherMini', 'TimelinePlayer', 'ToastStack', 'WelcomeToast', 'HelpOverlay', 'SessionSelectorScreen',
    'SessionSelector', 'Wordmark'].map((n) => `components/ui/${n}.jsx`),
];
const isLayoutLane = (rel) => LAYOUT_LANE.some((p) => rel.startsWith(p));

export function cssSizes() {
  const files = H.listFiles(SRC, ['.css']);
  const all = files.flatMap((f) => H.parseCssFile(f));
  const tokens = H.rootTokens(all);
  const out = [];
  for (const r of all) {
    for (const d of r.decls) {
      if (d.prop !== 'font-size') continue;
      const isUi = /var\(\s*--font-size-label\b/.test(d.value);
      const floor = isUi ? UI_FLOOR : DATA_FLOOR;
      const per = [];
      for (const vp of H.VIEWPORTS) {
        if (!H.mediaMatches(r.media, vp)) continue;
        const root = H.rootFontPx(all, tokens, vp.W, vp.H);
        const v = H.evalLength(H.resolveVars(d.value, tokens), { W: vp.W, H: vp.H, root });
        per.push({ vp: vp.name, px: v });
      }
      const evaluable = per.filter((p) => Number.isFinite(p.px));
      const min = evaluable.length ? Math.min(...evaluable.map((p) => p.px)) : NaN;
      let status = 'OK';
      if (!per.length) status = 'INACTIVE';
      else if (!evaluable.length) status = /^(inherit|1em|100%)$/.test(d.value) ? 'INHERIT' : 'UNEVALUATED';
      else if (min < floor - 1e-6) status = 'FAIL';
      out.push({
        file: path.relative(ROOT, r.file).replace(/\\/g, '/'), line: d.line, selector: r.selector,
        media: r.media, value: d.value, cls: isUi ? 'ui' : 'data', floor, per, min, status,
      });
    }
  }
  return { rows: out, tokens, all };
}

export function jsSizes() {
  const out = [];
  const pats = [
    /fontSize\s*:\s*(['"`]?)([^,}\n]+?)\1\s*(?=[,}\n])/g,
    /fontSize\s*=\s*(?:\{\s*([^}]+)\s*\}|"([^"]+)"|'([^']+)')/g,
    /\.(?:attr|style)\(\s*['"]font-size['"]\s*,\s*([^)]+)\)/g,
    /font-size\s*:\s*([\d.]+px)/g,
  ];
  for (const file of H.listFiles(SRC, ['.jsx', '.js'])) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8');
    const consts = new Map();
    for (const m of text.matchAll(/const\s+([A-Z_a-z]\w*)\s*=\s*([\d.]+)\s*;/g)) consts.set(m[1], Number(m[2]));
    const lines = text.split(/\r?\n/);
    lines.forEach((ln, idx) => {
      if (/^\s*(\/\/|\*)/.test(ln)) return;
      for (const re of pats) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(ln))) {
          let raw = (m[2] ?? m[1] ?? m[3] ?? '').trim();
          if (re === pats[1]) raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
          if (re === pats[2]) raw = m[1].trim();
          raw = raw.replace(/^['"`]|['"`]$/g, '');
          let px = NaN;
          let status;
          if (/var\(\s*--font-size-/.test(raw) || /\bCHART_FONT\./.test(raw)) status = 'TOKEN';
          else {
            const num = raw.match(/^(-?[\d.]+)(px)?$/);
            if (num) px = Number(num[1]);
            else if (consts.has(raw)) px = consts.get(raw);
            if (Number.isFinite(px)) status = px < UI_FLOOR ? 'FAIL' : px < DATA_FLOOR ? 'CHECK' : 'OK';
            else status = 'DYNAMIC';
          }
          out.push({ file: rel, line: idx + 1, raw, px, status, lane: isLayoutLane(rel) ? 'layout' : 'other' });
        }
      }
    });
  }
  return out;
}

// The DYNAMIC sizes above are expressions; what bounds them from below is
// written where they are computed. This pass reads, in every JS / JSX file:
//  - a font-like name (fs, fontSize, *Font*, *FONT*, size of a text) set from
//    clamp(x, LO, HI) or Math.max(LO, ...) / Math.max(..., LO): the floor LO;
//  - a font-like constant (MIN_*FONT*, *_FONT, *_FS) set to a number;
// LO resolved through the file's numeric constants. A floor under 10 px is a
// FAIL, 10 to 11 px a CHECK (a label may sit there, data may not). This is
// the check that missed the Circle of Doom's clamp(minSide / 38, 8, 11) and
// MIN_LABEL_FONT = 7 (found on 2026-10-15).
export function jsFloors() {
  const out = [];
  const FONTISH = /^(fs\w*|\w*[Ff]ont\w*|\w*FONT\w*|\w*_FS)$/;
  for (const file of H.listFiles(SRC, ['.jsx', '.js'])) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel.startsWith('__tests__/')) continue;
    const text = fs.readFileSync(file, 'utf8');
    const consts = new Map();
    for (const m of text.matchAll(/const\s+([A-Z_a-z]\w*)\s*=\s*([\d.]+)\s*;/g)) consts.set(m[1], Number(m[2]));
    const val = (t) => {
      const s = String(t).trim();
      if (/^[\d.]+$/.test(s)) return Number(s);
      return consts.has(s) ? consts.get(s) : NaN;
    };
    text.split(/\r?\n/).forEach((ln, idx) => {
      if (/^\s*(\/\/|\*)/.test(ln)) return;
      const push = (name, lo, how) => {
        if (!Number.isFinite(lo)) return;
        out.push({ file: rel, line: idx + 1, name, lo, how, status: lo < UI_FLOOR ? 'FAIL' : lo < DATA_FLOOR ? 'CHECK' : 'OK' });
      };
      for (const m of ln.matchAll(/(?:const|let)\s+(\w+)\s*=\s*clamp\(\s*[^,]+,\s*([\w.]+)\s*,\s*([\w.]+)\s*\)/g)) {
        if (FONTISH.test(m[1])) push(m[1], val(m[2]), `clamp(..., ${m[2]}, ${m[3]})`);
      }
      for (const m of ln.matchAll(/(?:const|let)\s+(\w+)\s*=\s*Math\.max\(\s*([\w.]+)\s*,/g)) {
        if (FONTISH.test(m[1])) push(m[1], val(m[2]), `Math.max(${m[2]}, ...)`);
      }
      for (const m of ln.matchAll(/(?:fontSize|size)\s*:\s*Math\.max\(\s*([\w.]+)\s*,/g)) push('size', val(m[1]), `Math.max(${m[1]}, ...)`);
      for (const m of ln.matchAll(/const\s+([A-Z][A-Z0-9_]*(?:FONT|_FS)[A-Z0-9_]*)\s*=\s*([\d.]+)\s*;/g)) push(m[1], Number(m[2]), 'constant');
    });
  }
  return out;
}

// The DYNAMIC sizes of jsSizes() are expressions, not literals; this pass
// resolves every one of them to its floor, and the gate fails on any it cannot
// resolve (the gap found on 2026-10-15: DYNAMIC was listed,
// never evaluated, so the Circle of Doom's clamp(minSide / 38, 8, 11) passed).
//  UNSET   .attr('font-size', null): the attribute is removed, the style size
//          set next to it applies (that one is checked on its own line)
//  TOKEN   an identifier of the same file defined from CHART_FONT.* (also the
//          zoom-compensated calc(CHART_FONT.* / var(--map-zoom)) of the Track
//          Map, whose rendered size is the token's)
//  CALLER  a `font` / `legendFont` parameter of a chart helper: every call
//          site in frontend/src passes CHART_FONT.*
//  FLOOR   a size computed with a floor that this pass reads from the code
//          (REVIEWED below: each claim is a set of regexes that must still
//          match, so an edit that drops the floor makes it UNRESOLVED)
const REVIEWED = [
  {
    file: 'components/visualizations/CircleOfDoom.jsx', raw: 'fs0', floor: 11,
    why: 'ring label size = chartFontPx("data"), the data token never under 11 px',
    proof: [['components/visualizations/CircleOfDoom.jsx', /const fs0 = chartFontPx\('data'\);/],
      ['utils/colors.js', /return Number\.isFinite\(px\) \? Math\.max\(floor, px\) : floor;/]],
  },
  {
    file: 'components/visualizations/CircleOfDoom.jsx', raw: 'fs', floor: 11,
    why: 'layout.fontSize of layoutLabels, called with fontSize and minFontSize fs0; layoutLabels never goes under minFontSize',
    proof: [['components/visualizations/CircleOfDoom.jsx', /const fs = layout\.fontSize;/],
      ['components/visualizations/CircleOfDoom.jsx', /fontSize: fs0, minFontSize: fs0/],
      ['utils/circleLabelLayout.js', /let fs = Math\.max\(minFontSize, fontSize \* step\);/],
      ['utils/circleLabelLayout.js', /fs = Math\.max\(minFontSize, fs \* /],
      ['utils/circleLabelLayout.js', /const fs = Math\.max\(minFontSize, fontSize \* FONT_STEPS/]],
  },
  {
    file: 'components/visualizations/CircleOfDoom.jsx', raw: 'gapMark.size', floor: 11,
    why: 'hover gap readout = Math.max(MIN_CENTRE_FONT, fs + 1), MIN_CENTRE_FONT = 11',
    proof: [['components/visualizations/CircleOfDoom.jsx', /size: Math\.max\(MIN_CENTRE_FONT, fs \+ 1\),/],
      ['components/visualizations/CircleOfDoom.jsx', /const MIN_CENTRE_FONT = 11;/]],
  },
  {
    file: 'components/visualizations/CircleOfDoom.jsx', raw: 'l.size', floor: 10,
    why: 'centre lines: values at clamp(R x k, MIN_CENTRE_FONT = 11, ...); the caption notes at MIN_CENTRE_NOTE = 10 (label text)',
    proof: [['components/visualizations/CircleOfDoom.jsx', /const big = clamp\(R \* 0\.12, MIN_CENTRE_FONT, 18\);/],
      ['components/visualizations/CircleOfDoom.jsx', /const small = clamp\(R \* 0\.075, MIN_CENTRE_FONT, 12\);/],
      ['components/visualizations/CircleOfDoom.jsx', /const tiny = MIN_CENTRE_NOTE;/],
      ['components/visualizations/CircleOfDoom.jsx', /const MIN_CENTRE_NOTE = 10;/]],
  },
  {
    file: 'utils/circleLabelLayout.js', raw: 'fs', floor: 11,
    why: 'Math.max(minFontSize, ...) and the only caller (CircleOfDoom.jsx) passes minFontSize fs0 = chartFontPx("data")',
    proof: [['utils/circleLabelLayout.js', /let fs = Math\.max\(minFontSize, fontSize \* step\);/],
      ['components/visualizations/CircleOfDoom.jsx', /fontSize: fs0, minFontSize: fs0/]],
  },
];

export function resolveDynamic(js) {
  const texts = new Map();
  const textOf = (rel) => {
    if (!texts.has(rel)) texts.set(rel, fs.readFileSync(path.join(SRC, rel), 'utf8'));
    return texts.get(rel);
  };
  // values passed to the chart helpers' font parameters, anywhere in src
  const callerValues = { font: [], legendFont: [] };
  for (const file of H.listFiles(SRC, ['.jsx', '.js'])) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel.startsWith('__tests__/') || rel.startsWith('utils/views/')) continue;
    const t = textOf(rel);
    for (const key of Object.keys(callerValues)) {
      for (const m of t.matchAll(new RegExp(`\\b${key}: ([^,}\\n]+)`, 'g'))) callerValues[key].push(`${rel}: ${m[1].trim()}`);
    }
  }
  const callersOk = (key) => callerValues[key].length > 0
    && callerValues[key].every((v) => /: CHART_FONT\.(data|label|fixed)$/.test(v));
  return js.filter((j) => j.status === 'DYNAMIC').map((j) => {
    const t = textOf(j.file);
    const ident = j.raw.split('.')[0];
    if (j.raw === 'null') return { ...j, how: 'UNSET', floor: null, why: 'attribute removed; the .style size next to it applies' };
    const def = t.match(new RegExp(`const ${ident} = ([^;]+);`));
    if (def && /^CHART_FONT\.(data|label|fixed)$/.test(def[1].trim())) {
      return { ...j, how: 'TOKEN', floor: /label/.test(def[1]) ? UI_FLOOR : DATA_FLOOR, why: `${ident} = ${def[1].trim()}` };
    }
    const obj = t.match(new RegExp(`const ${ident} = \\{([\\s\\S]*?)\\n\\};`));
    if (obj && j.raw.includes('.')) {
      const prop = j.raw.split('.')[1];
      const pm = obj[1].match(new RegExp(`${prop}: \`calc\\(\\$\\{CHART_FONT\\.(data|label)\\} / var\\(--map-zoom, 1\\)\\)\``));
      // the zoom handler sets --map-zoom to k (V13), or to k x the svg's
      // scale on screen through setMapZoom (Phase 9c D4: TrackMap.jsx)
      const zoomVar = /setProperty\('--map-zoom', String\(event\.transform\.k\)\)/.test(t)
        || (/setMapZoom\(svg\.node\(\), event\.transform\.k, /.test(t)
          && /function setMapZoom\([^)]*\) \{[\s\S]*?setProperty\('--map-zoom', String\(f\)\)/.test(t));
      if (pm && /\.attr\('transform', event\.transform\)/.test(t) && zoomVar) {
        return { ...j, how: 'TOKEN', floor: pm[1] === 'label' ? UI_FLOOR : DATA_FLOOR, why: `${j.raw}: CHART_FONT.${pm[1]} divided by the zoom factor of the group` };
      }
    }
    if (['font', 'legendFont'].includes(j.raw) && callersOk(j.raw)) {
      return { ...j, how: 'CALLER', floor: DATA_FLOOR, why: `${callerValues[j.raw].length} call sites, all CHART_FONT.*` };
    }
    const rev = REVIEWED.find((r) => r.file === j.file && r.raw === j.raw);
    if (rev) {
      const broken = rev.proof.filter(([f, re]) => !re.test(textOf(f)));
      if (!broken.length) return { ...j, how: 'FLOOR', floor: rev.floor, why: rev.why };
      return { ...j, how: 'UNRESOLVED', floor: null, why: `claim no longer holds: ${broken.map(([f, re]) => `${f} ${re}`).join('; ')}` };
    }
    return { ...j, how: 'UNRESOLVED', floor: null, why: 'no floor found' };
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  teeToEvidence('font_floor.txt');
  const showAll = process.argv.includes('--all');
  const { rows, tokens, all } = cssSizes();
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
  console.log(`Font-size floors, ${new Date().toLocaleDateString('sv-SE')}: data / default ${DATA_FLOOR} px, --font-size-label text ${UI_FLOOR} px`);
  console.log('Root font-size (base.css html): ' + H.VIEWPORTS.map((vp) => `${vp.name} ${fmt(H.rootFontPx(all, tokens, vp.W, vp.H))}px`).join(', '));
  for (const t of ['--font-size-label', '--font-size-data', '--font-size-xs', '--font-size-sm']) {
    if (!tokens.has(t)) { console.log(`${t}: (not defined)`); continue; }
    console.log(`${t} = ${tokens.get(t)} -> ` + H.VIEWPORTS.map((vp) => {
      const root = H.rootFontPx(all, tokens, vp.W, vp.H);
      return `${vp.name} ${fmt(H.evalLength(H.resolveVars(tokens.get(t), tokens), { W: vp.W, H: vp.H, root }))}`;
    }).join(', '));
  }
  const cssFail = rows.filter((r) => r.status === 'FAIL');
  const cssUneval = rows.filter((r) => r.status === 'UNEVALUATED');
  console.log(`\nCSS: ${rows.length} font-size declarations; FAIL ${cssFail.length}; UNEVALUATED ${cssUneval.length}; INHERIT ${rows.filter((r) => r.status === 'INHERIT').length}; INACTIVE ${rows.filter((r) => r.status === 'INACTIVE').length}`);
  for (const r of rows.filter((x) => showAll || x.status !== 'OK')) {
    console.log(`  ${r.status.padEnd(11)} ${r.file}:${r.line}  ${r.selector}${r.media ? ` @media ${r.media}` : ''}  font-size: ${r.value}  [${r.cls} >= ${r.floor}]  min ${fmt(r.min)} (${r.per.map((p) => `${p.vp} ${fmt(p.px)}`).join(', ')})`);
  }
  const js = jsSizes();
  const byFile = new Map();
  for (const j of js) {
    if (!byFile.has(j.file)) byFile.set(j.file, []);
    byFile.get(j.file).push(j);
  }
  const count = (arr, s) => arr.filter((j) => j.status === s).length;
  console.log(`\nJS/JSX literal font sizes: ${js.length}; FAIL (<${UI_FLOOR}) ${count(js, 'FAIL')}; CHECK (${UI_FLOOR}-${DATA_FLOOR}) ${count(js, 'CHECK')}; DYNAMIC ${count(js, 'DYNAMIC')}; TOKEN ${count(js, 'TOKEN')}`);
  for (const [file, arr] of [...byFile.entries()].sort()) {
    const bad = arr.filter((j) => showAll || j.status === 'FAIL' || j.status === 'CHECK' || j.status === 'DYNAMIC');
    if (!bad.length) continue;
    console.log(`  ${file} [${arr[0].lane} lane]: FAIL ${count(arr, 'FAIL')}, CHECK ${count(arr, 'CHECK')}, DYNAMIC ${count(arr, 'DYNAMIC')}`);
    for (const j of bad) console.log(`     ${j.status.padEnd(8)} :${j.line}  ${j.raw}`);
  }
  const floors = jsFloors();
  const floorFail = floors.filter((f) => f.status === 'FAIL');
  console.log(`\nFloors of the computed (DYNAMIC) sizes: ${floors.length} font-like bounds; FAIL (<${UI_FLOOR}) ${floorFail.length}; CHECK (${UI_FLOOR}-${DATA_FLOOR}) ${floors.filter((f) => f.status === 'CHECK').length}`);
  for (const f of floors.filter((x) => showAll || x.status !== 'OK')) console.log(`  ${f.status.padEnd(6)} ${f.file}:${f.line}  ${f.name} = ${f.how} -> floor ${f.lo} px`);
  const dyn = resolveDynamic(js);
  const dynCount = (h) => dyn.filter((d) => d.how === h).length;
  const dynLow = dyn.filter((d) => d.floor != null && d.floor < UI_FLOOR);
  const unresolved = dyn.filter((d) => d.how === 'UNRESOLVED');
  console.log(`\nDYNAMIC sizes resolved: ${dyn.length}; UNSET ${dynCount('UNSET')}, TOKEN ${dynCount('TOKEN')}, CALLER ${dynCount('CALLER')}, FLOOR ${dynCount('FLOOR')}, UNRESOLVED ${unresolved.length}; floor under ${UI_FLOOR} px ${dynLow.length}`);
  for (const d of dyn.filter((x) => showAll || x.how === 'UNRESOLVED' || x.how === 'FLOOR')) {
    console.log(`  ${d.how.padEnd(10)} ${d.file}:${d.line}  ${d.raw}${d.floor != null ? ` >= ${d.floor} px` : ''}  (${d.why})`);
  }
  const laneFail = js.filter((j) => j.lane === 'layout' && j.status === 'FAIL');
  console.log(`\nGate: CSS FAIL ${cssFail.length}, layout-lane JS FAIL ${laneFail.length}, computed-size floors FAIL ${floorFail.length}, DYNAMIC unresolved ${unresolved.length}, DYNAMIC floor < ${UI_FLOOR} px ${dynLow.length}`);
  process.exitCode = cssFail.length || laneFail.length || floorFail.length || unresolved.length || dynLow.length ? 1 : 0;
}
