// Test helper: the room of the two maps of the Pit Wall
// row (Track Map, Circle of Doom) at a viewport, from the CSS as written,
// PitWallLayout.jsx's grid (layoutModel.js pitWallAt), the Track Map's
// controls (utils/views/trackMapLayout.js) and the Inter font metrics
// (fontWidths.js). Shared by __tests__/trackmap.toolbar.test.jsx,
// __tests__/circleOfDoom.fill.test.jsx and
// the static layout report (layout_fit.mjs, Pit Wall maps).
//
// A Pit Wall cell is the panel's border box (.panel height 100 %). The Track
// Map panel: its border (2 px, 3 px under a flag: the worst is taken), the
// header (.panel-header padding, one row: the 24 px toolbar buttons, the
// title line, the 22 px export button; 1 px rule), the content padding of
// .panel--dense, and the map (.viz-container) the rest. The Circle of Doom
// panel: the glass border (1 px), the same header, the content padding of
// .panel (1rem); .cod is the content box.

import fs from 'node:fs';
import path from 'node:path';
import { px, pitWallSpec, pitWallAt } from './layoutModel.js';
import { mediaMatches, resolveVars } from './layoutCss.js';
import { textWidth, haveWebFont } from './fontWidths.js';
import {
  trackMapControls, toolbarLayout, TOOL_PX, LAYERS_INLINE_MIN_H, ROTATE_TOOLS_MIN_W,
} from '../../utils/views/trackMapLayout.js';

export { haveWebFont };

/** Last declaration of `prop` on a rule naming exactly `selector`, live at vp. */
export function declAt(css, selector, prop, vp) {
  let v = null;
  for (const r of css.rules) {
    if (!mediaMatches(r.media, vp)) continue;
    if (!r.selector.split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const d of r.decls) if (d.prop === prop) v = d.value;
  }
  return v;
}

/** px of a CSS length at vp (tokens resolved). */
export function lengthAt(css, value, vp) {
  if (value == null) return 0;
  return px(css, resolveVars(String(value), css.tokens), vp);
}

/** {top, right, bottom, left} of a padding / margin shorthand at vp. */
export function sidesAt(css, value, vp) {
  const parts = String(value || '0').trim().split(/\s+(?![^(]*\))/).map((p) => lengthAt(css, p, vp));
  const [t, r = t, b = t, l = r] = parts;
  return { top: t, right: r, bottom: b, left: l };
}

const HEADER_RULE_PX = 1; // .panel-header border-bottom
const EXPORT_BTN_PX = 22; // Panel.jsx export button
const CONTROLS_GAP_PX = 6; // Panel.jsx .panel-controls gap
const TRACK_BORDER_PX = 3; // TrackMap.jsx panelStyle: 2 px, 3 px under a flag or at the flag
const GLASS_BORDER_PX = 1; // --glass-border
const LINE_HEIGHT = 1.4; // base.css body

/** The header of a Panel at vp: paddings, one row of `rowPx`, its height. */
export function panelHeaderAt(css, vp, rowPx) {
  const pad = sidesAt(css, declAt(css, '.panel-header', 'padding', vp), vp);
  const titleFont = px(css, '--font-size-sm', vp);
  const row = Math.max(rowPx, EXPORT_BTN_PX, titleFont * LINE_HEIGHT);
  return { pad, titleFont, row, height: pad.top + row + pad.bottom + HEADER_RULE_PX };
}

/**
 * Width (px) of the header's title block "TRACK MAP" + the shortcut key:
 * .panel-title (font-size-sm, bold, 0.05 em, uppercase), its gap, the kbd
 * (1 px 6 px padding, 1 px border, the label mono digit, 6 px margin).
 */
export function titleBlockWidth(css, vp, title = 'Track Map', key = '1') {
  const size = px(css, '--font-size-sm', vp);
  const label = px(css, '--font-size-label', vp);
  const gap = lengthAt(css, declAt(css, '.panel-title', 'gap', vp), vp);
  const text = haveWebFont
    ? textWidth(title, size, 700, { letterSpacingEm: 0.05, upper: true })
    : title.length * 0.75 * size; // an upper bound of Bold capitals when the font files are missing
  const kbd = key ? 6 + 2 * 6 + 2 + key.length * 0.6 * label : 0;
  return text + (key ? gap + kbd : 0);
}

/**
 * The Track Map in its Pit Wall cell at vp: cell, header, content box, the
 * controls choice, the toolbar row and the map box.
 */
export function trackMapPanelAt(css, src, vp) {
  const cellModel = pitWallAt(css, pitWallSpec(src), vp);
  const cell = { width: cellModel.mapW, height: cellModel.bottom };
  const border = TRACK_BORDER_PX;
  const header = panelHeaderAt(css, vp, TOOL_PX);
  const contentPad = sidesAt(css, declAt(css, '.panel--dense > .panel-content', 'padding', vp), vp);
  const content = {
    width: cell.width - 2 * border - contentPad.left - contentPad.right,
    height: cell.height - 2 * border - header.height - contentPad.top - contentPad.bottom,
  };
  const controls = trackMapControls(content);
  const toolbar = toolbarLayout(controls);
  const available = cell.width - 2 * border - header.pad.left - header.pad.right;
  const needed = titleBlockWidth(css, vp) + 4 + toolbar.width + CONTROLS_GAP_PX + EXPORT_BTN_PX;
  // popover layout: the map is the whole content box (the key lies over it)
  const map = controls.layers === 'popover' ? { ...content } : null;
  return {
    vp: vp.name, cell, border, header, contentPad, content, controls, toolbar, headerRow: { available, needed }, map,
  };
}

/**
 * The Circle of Doom's slot (.cod, the panel's content box) in its Pit Wall
 * cell at vp: the glass border, the header (one 22 px row: the export
 * button and the pit-in stepper), the content padding of .panel.
 */
export function codSlotAt(css, src, vp) {
  const cellModel = pitWallAt(css, pitWallSpec(src), vp);
  const cell = { width: cellModel.mapW, height: cellModel.bottom };
  const header = panelHeaderAt(css, vp, EXPORT_BTN_PX);
  const pad = sidesAt(css, declAt(css, '.panel-content', 'padding', vp), vp);
  return {
    cell,
    width: Math.floor(cell.width - 2 * GLASS_BORDER_PX - pad.left - pad.right),
    height: Math.floor(cell.height - 2 * GLASS_BORDER_PX - header.height - pad.top - pad.bottom),
  };
}

/** The four constants the fit is built on, for the reports. */
export const TRACK_MAP_LIMITS = { LAYERS_INLINE_MIN_H, ROTATE_TOOLS_MIN_W, TOOL_PX };

/** True when the TrackMap source still draws its panel with .panel--dense. */
export function trackMapIsDense(src) {
  const code = fs.readFileSync(path.join(src, 'components/visualizations/TrackMap.jsx'), 'utf8');
  return /className="panel--dense track-map-panel"/.test(code);
}
