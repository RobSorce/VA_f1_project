// V13 target (2), chrome of the layout lane: WCAG 2.1 contrast of every text
// colour declared in the CSS of the dashboard chrome (weather bar, layout
// presets, search bar, timeline, dock and its popovers, docked panes, Pit Wall
// shell, overlays, help, toasts, session screen, settings dock list, keyboard
// hints, cheatsheet, command palette), each against the surface it is drawn
// on. Surfaces are stacks of the containers' own backgrounds read from the
// same CSS (alpha composited, bottom first), so a change of a background is
// seen too. Dark theme (light-theme overrides are skipped).
//
// Threshold 4.5:1, 3:1 for large text (>= 18.66 px, or bold >= 14 px); rules
// for :disabled / --disabled controls are listed but not gated (WCAG 1.4.3
// exempts inactive components). Element opacity is applied, and the opacity
// of BEM modifier rules on the element or an ancestor of its surface stack
// (modifierRows: the faded hint bar, the dock's fixed / overflow buttons).
//
//   node frontend/scripts/audit/chrome_contrast.mjs [--rev HEAD] [--views]
// Writes docs/evidence/chrome_contrast.txt (or the file after --out) and prints the same text.
// --rev reads the CSS of a git revision (for the before / after table).
// --views also checks every other text colour of the CSS (the views' own
// rules) against the raised panel surface #1a1f33 (utils/colors.js
// SURFACES.raised, the lightest surface a view draws on): listed, not gated.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { teeToEvidence } from './evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const H = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutCss.js')).href);
const revIdx = process.argv.indexOf('--rev');
const REV = revIdx > 0 ? process.argv[revIdx + 1] : null;

function readCss(file) {
  if (!REV) return fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  try { return execFileSync('git', ['show', `${REV}:${rel}`], { cwd: ROOT, encoding: 'utf8' }); } catch { return ''; }
}

const files = H.listFiles(SRC, ['.css']);
const rules = files.flatMap((f) => H.parseCss(readCss(f)).map((r) => ({ ...r, file: f })));
const tokens = H.rootTokens(rules);
const VP = { W: 1536, H: 750, root: H.rootFontPx(rules, tokens, 1536, 750) };

const colorOf = (v) => {
  if (!v) return null;
  const r = H.resolveVars(v, tokens).trim();
  const c = H.parseColor(r);
  if (c) return c;
  const m = r.match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i); // first stop of a gradient
  return m ? H.parseColor(m[1]) : null;
};
const bgOf = (sel) => colorOf(H.declOf(rules, sel, 'background') || H.declOf(rules, sel, 'background-color'));

const PAGE = '#0f0f1e';
const PAGE_LOW = '#15152a'; // bottom of the app gradient (timeline, dock)
const stack = (...layers) => layers.map((l) => (typeof l === 'string' && l.startsWith('.') ? bgOf(l) : l)).filter(Boolean);

// Chrome selector prefix -> surface stack (most specific first)
const SURFACES = [
  ['.weather-bar__pill', () => stack(PAGE, '.weather-bar', '.weather-bar__center', '.weather-bar__pill')],
  ['.weather-bar__elapsed', () => stack(PAGE, '.weather-bar', '.weather-bar__elapsed-capsule')],
  ['.weather-bar', () => stack(PAGE, '.weather-bar')],
  ['.layout-preset-bar', () => stack(PAGE, '.weather-bar')],
  ['.search-bar', () => stack(PAGE, '.weather-bar', '.search-bar__wrap')],
  ['.sb-', () => stack(PAGE, '.sb-dropdown')],
  ['.timeline-player', () => stack(PAGE_LOW, '.timeline-player')],
  ['.bottom-tab-bar', () => stack(PAGE_LOW, '.bottom-tab-bar')],
  ['.tab-kbd', () => stack(PAGE_LOW, '.bottom-tab-bar')],
  ['.dock-ctx-menu', () => stack(PAGE, '.dock-ctx-menu')],
  ['.dock-add-popover', () => stack(PAGE, '.dock-add-popover')],
  ['.dock-overflow-popover', () => stack(PAGE, '.dock-overflow-popover')],
  ['.dock-customize-popover', () => stack(PAGE, '.dock-customize-popover')],
  ['.layout-dock-popover', () => stack(PAGE, '.layout-dock-popover')],
  ['.layout-builder', () => stack(PAGE, '.layout-builder')],
  ['.docked-layout', () => stack(PAGE, '.docked-layout__toolbar')],
  ['.docked-pane__tab', () => stack(PAGE, '.docked-pane', '.docked-pane__tabs')],
  ['.docked-pane__icon-btn', () => stack(PAGE, '.docked-pane', '.docked-pane__tabs')],
  ['.docked-pane', () => stack(PAGE, '.docked-pane')],
  ['.docked-tab-picker', () => stack(PAGE, '.docked-tab-picker')],
  ['.pitwall-layout', () => stack(PAGE, 'rgba(12, 12, 28, 0.95)')],
  ['.session-info-bar', () => stack(PAGE, '.session-info-bar')],
  ['.help-overlay', () => stack(PAGE, '.help-overlay', '.help-overlay__panel')],
  ['.shortcut-hint', () => stack(PAGE, '.shortcut-hints')],
  ['.cs-', () => stack(PAGE, '.cs-overlay', '.cs-modal')],
  ['.cp-', () => stack(PAGE, '.cp-overlay', '.cp-modal')],
  ['.overlay-panel', () => stack(PAGE, '.overlay-panel', '.overlay-panel__header')],
  ['.welcome-toast', () => stack(PAGE, '.welcome-toast')],
  ['.toast', () => stack(PAGE, '.toast')],
  ['.session-screen', () => stack(PAGE, '.session-screen')],
  ['.driver-grid', () => stack(PAGE, '.session-screen')],
  ['.settings-dock', () => stack(PAGE, '.overlay-panel')],
  ['.leaderboard-collapsed', () => stack(PAGE)],
  ['.leaderboard-toggle', () => stack(PAGE)],
  ['.panel-shortcut-hint', () => stack(PAGE, '.panel-header')],
  ['.session-menu', () => stack(PAGE, '.session-menu')],
  ['.live-badge', () => stack(PAGE_LOW, '.timeline-player')],
];

const VIEWS = process.argv.includes('--views');
const RAISED = '#1a1f33';

function surfaceFor(selector) {
  const first = selector.trim();
  for (const [prefix, fn] of SURFACES) if (first.startsWith(prefix)) return { prefix, layers: fn() };
  if (VIEWS && !/^(html|body|\*|:root)/.test(first)) return { prefix: 'view', layers: stack(PAGE, RAISED), view: true };
  return null;
}

export function chromeRows() {
  const out = [];
  for (const r of rules) {
    if (r.media) continue;
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      if (sel.includes('[data-theme')) continue;
      const surf = surfaceFor(sel);
      if (!surf) continue;
      const colorDecl = r.decls.filter((d) => d.prop === 'color').pop();
      if (!colorDecl) continue;
      const fg = colorOf(colorDecl.value);
      if (!fg) continue; // inherit / currentColor / transparent text
      const own = bgOf(sel);
      const ownBg = r.decls.filter((d) => d.prop === 'background' || d.prop === 'background-color').pop();
      const layers = [...surf.layers];
      if (ownBg && colorOf(ownBg.value)) layers.push(colorOf(ownBg.value));
      else if (own && !sel.includes(':')) layers.push(own);
      const behind = H.flatten(layers.slice(0, surf.layers.length));
      const under = H.flatten(layers);
      // opacity 0 = shown only on hover / focus (another rule sets it to 1):
      // judged as shown
      const op0 = Number(r.decls.filter((d) => d.prop === 'opacity').pop()?.value ?? 1);
      const op = op0 === 0 ? 1 : op0;
      // element opacity blends text and its own background with what is behind
      const bgPix = H.over(under, behind, op);
      const fgPix = H.over(H.over(fg, under), behind, op);
      const ratio = H.contrast(fgPix, bgPix);
      const fsDecl = r.decls.filter((d) => d.prop === 'font-size').pop();
      const fs = fsDecl ? H.evalLength(H.resolveVars(fsDecl.value, tokens), VP) : NaN;
      const fw = Number(r.decls.filter((d) => d.prop === 'font-weight').pop()?.value?.replace(/var\(--font-weight-(\w+)\)/, (m, w) => ({ normal: 400, medium: 500, semibold: 600, bold: 700, black: 900 }[w] || 400)) ?? 400);
      const large = fs >= 18.66 || (fw >= 700 && fs >= 14);
      const need = large ? 3 : 4.5;
      const disabled = /:disabled|--disabled|\[disabled\]/.test(sel);
      out.push({
        file: path.relative(ROOT, r.file).replace(/\\/g, '/'), line: colorDecl.line, selector: sel,
        color: colorDecl.value, opacity: op, ratio, need, disabled, view: !!surf.view,
        status: disabled ? 'EXEMPT' : ratio + 1e-9 >= need ? 'OK' : surf.view ? 'VIEW-FAIL' : 'FAIL',
      });
    }
  }
  return out;
}

// Opacity of BEM modifier rules (`.block--mod`, `.block__elem--mod`, no
// pseudo-class) applied to the text rows they reach: the element itself
// (`.bottom-tab-bar__tab--fixed` on `.bottom-tab-bar__tab`) or an ancestor
// named in the row's surface stack (`.shortcut-hints--faded` on
// `.shortcut-hint-key`). The rows above missed both.
export function modifierRows(rows) {
  const names = new Map(SURFACES.map(([prefix, fn]) => [prefix, (fn.toString().match(/'\.[\w-]+'/g) || []).map((q) => q.slice(1, -1))]));
  const mods = [];
  for (const r of rules) {
    if (r.media) continue;
    const opDecl = r.decls.filter((d) => d.prop === 'opacity').pop();
    const op = Number(opDecl?.value);
    if (!opDecl || !(op > 0 && op < 1)) continue;
    // exempt: a disabled control (WCAG 1.4.3 inactive components) and a
    // state moved off the screen (a translate in the same rule: the
    // auto-hidden dock keeps a 3 px peek, its text is not visible)
    const offscreen = r.decls.some((d) => d.prop === 'transform' && /translate/.test(d.value));
    for (const sel of r.selector.split(',').map((s) => s.trim())) {
      const m = sel.match(/^(\.[\w-]+?)--[\w-]+$/);
      const exempt = /--disabled/.test(sel) ? 'disabled' : offscreen ? 'off screen' : null;
      if (m) mods.push({ sel, base: m[1], op, exempt, file: path.relative(ROOT, r.file).split(path.sep).join('/'), line: opDecl.line });
    }
  }
  const out = [];
  for (const row of rows.filter((x) => !x.view && x.status !== 'EXEMPT')) {
    const surf = surfaceFor(row.selector);
    const stackNames = names.get(surf.prefix) || [];
    for (const mod of mods) {
      const own = mod.base === row.selector;
      const ancestor = !own && stackNames.includes(mod.base);
      if (!own && !ancestor) continue;
      const layers = surf.layers;
      const under = H.flatten(layers);
      const base = H.flatten(layers.slice(0, own ? layers.length : 1));
      const fg = colorOf(row.color);
      const total = row.opacity * mod.op;
      const ratio = H.contrast(H.over(H.over(fg, under), base, total), H.over(under, base, total));
      out.push({
        ...row, modifier: mod.sel, modFile: mod.file, modLine: mod.line, total, ratio, exempt: mod.exempt,
        status: mod.exempt ? 'EXEMPT' : ratio + 1e-9 >= row.need ? 'OK' : 'FAIL',
      });
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  teeToEvidence('chrome_contrast.txt');
  const rows = chromeRows();
  const fails = rows.filter((r) => r.status === 'FAIL');
  console.log(`Chrome text contrast (dark theme, WCAG 2.1), CSS of ${REV || 'the working tree'}, ${new Date().toLocaleDateString('sv-SE')}`);
  console.log(`${rows.filter((r) => !r.view).length} chrome text colours; FAIL ${fails.length}; EXEMPT (disabled) ${rows.filter((r) => r.status === 'EXEMPT').length}\n`);
  const NAMED = [
    ['dock key cap', '.tab-kbd'], ['dock key cap (active tab)', '.bottom-tab-bar__tab--active .tab-kbd'],
    ['dock tab label', '.bottom-tab-bar__tab'], ['shortcut hint key', '.shortcut-hint-key'],
    ['shortcut hint label', '.shortcut-hint-label'], ['search bar key', '.search-bar__kbd'],
    ['weather pill label', '.weather-bar__pill-label'], ['session badge', '.weather-bar__session-badge'],
    ['lap counter', '.timeline-player__lap-text'], ['layout preset label', '.layout-preset-bar__label'],
    ['layout preset button', '.layout-preset-bar__btn'], ['race details (session menu)', '.session-menu__race-detail'],
    ['timeline legend', '.timeline-player__legend-item'], ['docked pane tab', '.docked-pane__tab'],
    ['docked layout label', '.docked-layout__label'], ['Pit Wall session bar lap', '.session-info-bar__lap'],
    ['Pit Wall focus toggle', '.pitwall-layout__focus-toggle'], ['live bar flag label', '.timeline-player__flag-label'],
  ];
  console.log('Named chrome items (findings_2026-10-14.md section 2):');
  for (const [name, sel] of NAMED) {
    const r = rows.filter((x) => x.selector === sel).pop();
    console.log(`  ${name.padEnd(30)} ${sel.padEnd(42)} ${r ? `${r.ratio.toFixed(2)}:1 (needs ${r.need}) ${r.status}  color ${r.color}${r.opacity !== 1 ? ` opacity ${r.opacity}` : ''}` : 'not found'}`);
  }
  console.log('\nAll chrome rows below the threshold:');
  for (const r of fails) console.log(`  FAIL ${r.ratio.toFixed(2)}:1 < ${r.need}  ${r.file}:${r.line}  ${r.selector}  color ${r.color}${r.opacity !== 1 ? ` opacity ${r.opacity}` : ''}`);
  if (VIEWS) {
    const vf = rows.filter((r) => r.status === 'VIEW-FAIL');
    console.log(`\nOther CSS text colours (views' own rules) on the raised surface ${RAISED}: ${rows.filter((r) => r.view).length} checked, ${vf.length} below the threshold (not gated):`);
    for (const r of vf) console.log(`  VIEW-FAIL ${r.ratio.toFixed(2)}:1 < ${r.need}  ${r.file}:${r.line}  ${r.selector}  color ${r.color}${r.opacity !== 1 ? ` opacity ${r.opacity}` : ''}`);
  }
  const modRows = modifierRows(rows);
  const modFails = modRows.filter((r) => r.status === 'FAIL');
  console.log(`
Modifier opacity (BEM --modifier rules with 0 < opacity < 1, on the element or an ancestor): ${modRows.length} text rows reached, ${modFails.length} below the threshold`);
  for (const r of modRows) console.log(`  ${r.status.padEnd(6)} ${r.ratio.toFixed(2)}:1 (needs ${r.need})  ${r.selector} under ${r.modifier} (opacity ${r.total.toFixed(2)}, ${r.modFile}:${r.modLine})${r.exempt ? ` [${r.exempt}]` : ''}`);
  if (process.argv.includes('--all')) for (const r of rows.filter((x) => x.status !== 'FAIL')) console.log(`  ${r.status} ${r.ratio.toFixed(2)}:1  ${r.selector}  ${r.color}`);
  process.exitCode = fails.length + modFails.length ? 1 : 0;
}
