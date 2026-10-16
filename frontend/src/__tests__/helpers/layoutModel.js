// Test helper (V13 target 1): a static model of the dashboard shell at a
// viewport, read from the CSS tokens and the layout components as written.
// Shared by __tests__/layout.viewport.test.js and
// frontend/scripts/audit/layout_fit.mjs (whose output the docs quote).
//
// It answers what can be answered without a browser: the page cannot scroll
// (no rule makes html / body / the shell scroll or grow at any target
// viewport), the chrome rows' heights, the app body left to the panels, the
// Pit Wall cells, every docked pane of every window preset, and the room of
// the floating overlays. The real-browser pass checks the rest.

import fs from 'node:fs';
import path from 'node:path';
import {
  VIEWPORTS, listFiles, parseCssFile, rootTokens, resolveVars, evalLength, rootFontPx, mediaMatches,
} from './layoutCss.js';

export { VIEWPORTS };

export function loadCss(src) {
  const rules = listFiles(src, ['.css']).flatMap((f) => parseCssFile(f));
  return { rules, tokens: rootTokens(rules) };
}

/** px of a token (or a CSS length expression) at a viewport. */
export function px(css, expr, vp) {
  const root = rootFontPx(css.rules, css.tokens, vp.W, vp.H);
  const value = expr.startsWith('--') ? css.tokens.get(expr) : expr;
  if (value == null) return NaN;
  return evalLength(resolveVars(value, css.tokens), { W: vp.W, H: vp.H, root });
}

/**
 * Declarations that could make the page scroll or the shell outgrow the
 * viewport, live at `vp`: overflow other than hidden on html / body /
 * .app-container / .app-body, or a height other than 100vh / 100% on the
 * shell. Returns a list of offending {file, line, selector, decl, media}.
 */
export function pageScrollRules(css, vp) {
  const SHELL = ['html', 'body', '.app-container', '.app-body'];
  const out = [];
  for (const r of css.rules) {
    if (!mediaMatches(r.media, vp)) continue;
    const sels = r.selector.split(',').map((s) => s.trim());
    if (!sels.some((s) => SHELL.includes(s))) continue;
    for (const d of r.decls) {
      const bad = (/^overflow(-x|-y)?$/.test(d.prop) && d.value !== 'hidden')
        || (d.prop === 'height' && !['100vh', '100%'].includes(d.value) && sels.includes('.app-container'))
        || (d.prop === 'min-height' && sels.includes('.app-container') && d.value !== '0');
      if (bad) {
        out.push({
          file: path.basename(r.file), line: d.line, selector: r.selector, decl: `${d.prop}: ${d.value}`, media: r.media,
        });
      }
    }
  }
  return out;
}

/** A declaration `prop: value` on a rule of exactly `selector`, outside @media. */
function cssHas(css, selector, prop, value) {
  return css.rules.some((r) => !r.media && r.selector === selector
    && r.decls.some((d) => d.prop === prop && d.value === value));
}

/** Chrome rows of the shell and the app body left to the panels (px). */
export function shellAt(css, vp) {
  const weather = px(css, '--weather-bar-height', vp);
  const timeline = px(css, '--timeline-height', vp);
  const timelineExpanded = timeline + px(css, '--timeline-expanded-extra', vp);
  const dock = px(css, '--bottom-tab-height', vp);
  const dockMargin = px(css, '--dock-margin', vp);
  const body = vp.H - weather - timeline - dock - dockMargin;
  // The expanded event strip opens over the bottom of the body (negative top
  // margin of .timeline-player.expanded): the body keeps its height
  const overlaysBody = cssHas(css, '.timeline-player.expanded', 'margin-top', 'calc(-1 * var(--timeline-expanded-extra))');
  const bodyExpanded = overlaysBody ? body : vp.H - weather - timelineExpanded - dock - dockMargin;
  return {
    weather, timeline, timelineExpanded, dock, dockMargin, chrome: vp.H - body, body, bodyExpanded,
    root: rootFontPx(css.rules, css.tokens, vp.W, vp.H),
    overlayTop: px(css, '--overlay-inset-top', vp),
    overlayBottom: px(css, '--overlay-inset-bottom', vp),
    overlayBottomExpanded: px(css, '--overlay-inset-bottom', vp) + px(css, '--timeline-expanded-extra', vp),
    sidebar: px(css, '--app-sidebar-width', vp),
    panelGap: px(css, '--panel-gap', vp),
  };
}

/** The Pit Wall grid as written in PitWallLayout.jsx (style objects). */
export function pitWallSpec(src) {
  const code = fs.readFileSync(path.join(src, 'components/layout/PitWallLayout.jsx'), 'utf8');
  const block = (name) => {
    const i = code.indexOf(`const ${name} = {`);
    return i < 0 ? '' : code.slice(i, code.indexOf('};', i));
  };
  const prop = (name, key) => (block(name).match(new RegExp(`${key}: '([^']+)'`)) || [])[1] || null;
  return {
    columns: prop('layoutStyle', 'gridTemplateColumns'),
    rows: prop('mainStyle', 'gridTemplateRows'),
    bottomColumns: prop('bottomRowStyle', 'gridTemplateColumns'),
    code,
  };
}

/** Pit Wall cell sizes at a viewport (gaps of 1 px as in the style objects). */
export function pitWallAt(css, spec, vp) {
  const shell = shellAt(css, vp);
  const [sideCol] = spec.columns.split(/\s+/);
  const sidebar = px(css, sideCol, vp);
  const mainW = vp.W - sidebar - 1;
  const [infoRow, , bottomRow] = spec.rows.split(/\s+/);
  const info = px(css, infoRow, vp);
  const bottom = px(css, bottomRow, vp);
  const middle = shell.body - info - bottom;
  const side = px(css, spec.bottomColumns.split(/\s+/).pop(), vp);
  const mapW = (mainW - side - 2) / 2;
  return { body: shell.body, sidebar, mainW, info, middle, bottom, mapW, side };
}

/** Leaf panes of a docked layout tree with their share of the area. */
export function paneShares(node, w = 1, h = 1, out = []) {
  if (!node) return out;
  if (!node.children) {
    out.push({ tabs: node.tabs, w, h });
    return out;
  }
  const r = node.ratio || 0.5;
  if (node.direction === 'horizontal') {
    paneShares(node.children[0], w * r, h, out);
    paneShares(node.children[1], w * (1 - r), h, out);
  } else {
    paneShares(node.children[0], w, h * r, out);
    paneShares(node.children[1], w, h * (1 - r), out);
  }
  return out;
}

/**
 * Content box (px) of each pane of a docked layout at a viewport: the app
 * centre (window minus the Leaderboard sidebar, minus its padding), minus
 * the layout toolbar, split by the ratios (5 px splitters), minus each
 * pane's tab bar and border.
 */
export function dockedPanesAt(css, tree, vp) {
  const shell = shellAt(css, vp);
  const toolbar = px(css, 'clamp(24px, 3.2vh, 28px)', vp);
  const tabs = px(css, 'clamp(26px, 3.6vh, 30px)', vp);
  const centreW = vp.W - shell.sidebar - 2 * shell.panelGap;
  const centreH = shell.body - 2 * shell.panelGap - toolbar;
  return paneShares(tree).map((p) => ({
    tabs: p.tabs,
    width: p.w * centreW - (p.w < 1 ? 2.5 : 0) - 2,
    height: p.h * centreH - (p.h < 1 ? 2.5 : 0) - tabs - 2,
  }));
}
