// Phase 9c F2 (D2): does the bottom dock fit its bar at the four target
// viewports? Static model from the CSS as written (dashboard.css
// .bottom-tab-bar rules at each viewport's media) and the real font metrics
// (frontend/public/fonts, fontMetrics.mjs): every button is its padding plus
// the wider of its 18 px icon and its label (uppercase, letter-spacing
// 0.05em, --font-size-label, weight 600 -> the Inter SemiBold face); the bar
// adds its padding, its 0.5 px borders, a gap between every two children and
// the divider with its margins. The capacity is decided as BottomTabBar does
// (utils/dockCapacity.js dockCapacity + dockRow) and the rendered row is
// checked against the bar's max-width.
//
// It also replays the measure of the code before Phase 9c, on the default
// dock of that time (ten items, with the AI Strategist removed since): the
// buttons measured once at mount with the fallback font (system-ui = Segoe UI
// Bold on Windows; only where that file is) and the divider's margins and the
// border left out, then the web font's labels once it is in.
//
// Exit code 1 when the row is wider than the bar at a target viewport. Run:
//   node frontend/scripts/audit/dock_fit.mjs
// Writes docs/evidence/dock_fit.txt (or the file after --out) and prints the same text.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadFaces, loadSystemFace } from './fontMetrics.mjs';
import { teeToEvidence } from './evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = path.join(ROOT, 'frontend/src');
const M = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutModel.js')).href);
const { mediaMatches, resolveVars, evalLength } = await import(pathToFileURL(path.join(SRC, '__tests__/helpers/layoutCss.js')).href);
const { dockCapacity, dockRow } = await import(pathToFileURL(path.join(SRC, 'utils/dockCapacity.js')).href);

const css = M.loadCss(SRC);
const WEB = loadFaces('Inter');
const SEGOE = loadSystemFace('C:/Windows/Fonts/segoeuib.ttf');
if (!WEB) { console.log('Inter font files missing: frontend/public/fonts'); process.exit(1); }

// The default dock (store DOCK_DEFAULTS) and every view the dock can hold
// (utils/slotOptions.js labels; settings and charts are never dock items)
const DEFAULT_LABELS = ['Pit Wall', 'Lap Times', 'Tyres', 'Strategy Timeline', 'Circle of Doom', 'Analytics (PCA)',
  'Race Prediction', 'Race Control', 'Championship'];
// The default dock before Phase 9c (it held the AI Strategist)
const DEFAULT_LABELS_9C = [...DEFAULT_LABELS.slice(0, -1), 'AI Strategist', 'Championship'];
const ALL_LABELS = [...DEFAULT_LABELS, 'Track Map', 'Telemetry', 'Lap Delta', 'Sectors & Speeds', 'Sector Delta',
  'Consistency', 'Race Pace Grid', 'Position Tracker', 'Tyre Degradation', 'Tyre Health', 'Pace Retention',
  'Strategy Analysis', 'Strategy Simulator', 'Driver Compare', 'Race Situation (PCA)'];
const FIXED_LABELS = ['Layouts', '\u2318K', 'Settings'];
const OVERFLOW_BUTTON_W = 44; // BottomTabBar.jsx (an upper bound of the ⋯ button)

/** Last declaration of `prop` for an exact selector live at vp (dashboard.css order). */
function declAt(selector, prop, vp) {
  let v = null;
  for (const r of css.rules) {
    if (!mediaMatches(r.media, vp)) continue;
    if (!r.selector.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) v = d.value;
  }
  return v;
}
const len = (value, vp) => evalLength(resolveVars(value, css.tokens), { W: vp.W, H: vp.H, root: M.shellAt(css, vp).root });
const sides = (value, vp) => {
  const parts = String(value).trim().split(/\s+/).map((p) => len(p, vp));
  return { v: parts[0], h: parts.length > 1 ? parts[1] : parts[0] };
};

export function dockAt(vp, measure) {
  const label = M.px(css, '--font-size-label', vp);
  const labelHidden = declAt('.bottom-tab-bar__label', 'display', vp) === 'none';
  const fixedLabelHidden = labelHidden || declAt('.bottom-tab-bar__tab--fixed .bottom-tab-bar__label', 'display', vp) === 'none';
  const tabPad = sides(declAt('.bottom-tab-bar__tab', 'padding', vp), vp).h;
  const fixedPad = sides(declAt('.bottom-tab-bar__tab--fixed', 'padding', vp) || declAt('.bottom-tab-bar__tab', 'padding', vp), vp).h;
  // the later of the two rules wins for a fixed button (same specificity)
  const fixedPadLive = (() => {
    let v = null;
    for (const r of css.rules) {
      if (!mediaMatches(r.media, vp)) continue;
      const sels = r.selector.split(',').map((s) => s.trim());
      if (!sels.includes('.bottom-tab-bar__tab') && !sels.includes('.bottom-tab-bar__tab--fixed')) continue;
      for (const d of r.decls) if (d.prop === 'padding') v = d.value;
    }
    return v ? sides(v, vp).h : fixedPad;
  })();
  const overflowPad = sides(declAt('.bottom-tab-bar__tab--overflow', 'padding', vp), vp).h;
  const icon = 18;
  const text = (t) => measure(t, label);
  const item = (t) => ({ width: 2 * tabPad + Math.max(icon, labelHidden ? 0 : text(t)) });
  const fixed = (t) => ({ width: 2 * fixedPadLive + Math.max(icon, fixedLabelHidden ? 0 : text(t)) });
  const nav = sides(declAt('.bottom-tab-bar', 'padding', vp), vp);
  const border = 0.5; // border: 0.5px solid (dashboard.css .bottom-tab-bar)
  const box = { gap: len(declAt('.bottom-tab-bar', 'gap', vp), vp), paddingLeft: nav.h, paddingRight: nav.h, borderLeft: border, borderRight: border };
  const divMargin = sides(declAt('.bottom-tab-bar__divider', 'margin', vp), vp).h;
  const divider = { width: len(declAt('.bottom-tab-bar__divider', 'width', vp), vp), marginLeft: divMargin, marginRight: divMargin };
  const maxWidth = len(declAt('.bottom-tab-bar', 'max-width', vp), vp);
  return {
    label, labelHidden, fixedLabelHidden, tabPad, box, divider, maxWidth,
    items: (labels) => labels.map(item),
    fixedGroup: [divider, ...FIXED_LABELS.map(fixed)],
    overflow: { width: 2 * overflowPad + icon },
  };
}

/** Capacity as BottomTabBar decides it, and the rendered row. */
export function layOut(d, labels) {
  const items = d.items(labels);
  const fixedWidth = dockRow(d.fixedGroup, d.box);
  const cap = dockCapacity(items.map((c) => dockRow([c])), { available: d.maxWidth, fixedWidth, overflowWidth: OVERFLOW_BUTTON_W, gap: d.box.gap });
  const shown = items.slice(0, cap);
  const row = dockRow([...shown, ...(cap < items.length ? [d.overflow] : []), ...d.fixedGroup], d.box);
  return { cap, row, all: dockRow([...items, ...d.fixedGroup], d.box) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  teeToEvidence('dock_fit.txt');
  const web = (t, size) => WEB.width(t, size, 600, { letterSpacingEm: 0.05, upper: true });
  const sg = SEGOE ? (t, size) => SEGOE.width(t, size, { letterSpacingEm: 0.05, upper: true }) : null;
  let failures = 0;
  console.log(`Dock fit at the V13 target viewports (dashboard.css .bottom-tab-bar rules, Inter SemiBold metrics), ${new Date().toLocaleDateString('sv-SE')}`);
  for (const vp of M.VIEWPORTS) {
    const d = dockAt(vp, web);
    console.log(`\n== ${vp.name} == bar max-width ${d.maxWidth.toFixed(1)} px; label ${d.label.toFixed(2)} px${d.labelHidden ? ' (hidden)' : ''}, button padding ${d.tabPad} px, fixed labels ${d.fixedLabelHidden ? 'hidden' : 'shown'}; gap ${d.box.gap}, bar padding ${d.box.paddingLeft} + border 0.5 each side, divider ${d.divider.width} + ${d.divider.marginLeft} + ${d.divider.marginRight}`);
    for (const [name, labels] of [[`default dock (${DEFAULT_LABELS.length} items)`, DEFAULT_LABELS], [`every view (${ALL_LABELS.length} items)`, ALL_LABELS]]) {
      const r = layOut(d, labels);
      const ok = r.row <= d.maxWidth + 0.5;
      if (!ok) failures += 1;
      console.log(`  ${name}: all buttons ${r.all.toFixed(1)} px -> ${r.cap} of ${labels.length} on the bar${r.cap < labels.length ? ' + ⋯' : ''}, row ${r.row.toFixed(1)} px ${ok ? '<=' : '>'} ${d.maxWidth.toFixed(1)} ${ok ? 'fits' : 'CUT'}`);
    }
    if (sg) {
      // Before Phase 9c: measured at mount with the fallback font, without the
      // divider margins and the border, never again after the fonts loaded
      const dFallback = dockAt(vp, sg);
      const items = dFallback.items(DEFAULT_LABELS_9C);
      const oldFixed = dFallback.box.paddingLeft + dFallback.box.paddingRight
        + dFallback.fixedGroup.reduce((a, c) => a + c.width + dFallback.box.gap, 0);
      const oldCap = dockCapacity(items.map((c) => c.width), { available: d.maxWidth, fixedWidth: oldFixed, overflowWidth: OVERFLOW_BUTTON_W, gap: d.box.gap });
      const after = dockRow([...d.items(DEFAULT_LABELS_9C).slice(0, oldCap), ...(oldCap < DEFAULT_LABELS_9C.length ? [d.overflow] : []), ...d.fixedGroup], d.box);
      console.log(`  before 9c (measured once with the fallback font): ${oldCap} of ${DEFAULT_LABELS_9C.length} shown (fallback row ${dockRow([...items, ...dFallback.fixedGroup], dFallback.box).toFixed(1)} px); with the web font's labels that row is ${after.toFixed(1)} px${after > d.maxWidth + 0.5 ? `, ${(after - d.maxWidth).toFixed(1)} px wider than the bar: the first and last buttons cut (centred row)` : ', fits'}`);
    }
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nThe dock row fits its bar at the four viewports (default dock and every view).');
  process.exitCode = failures ? 1 : 0;
}
