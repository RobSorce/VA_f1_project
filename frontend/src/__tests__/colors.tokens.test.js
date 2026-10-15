// The palette module is the single source (V13 target 5): the CSS tokens the
// views' stylesheets use for a semantic colour mirror utils/colors.js exactly,
// so a colour changed in the module and not in tokens.css (or the reverse)
// fails here.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCssFile, rootTokens } from './helpers/layoutCss.js';
import {
  DIVERGING, STATUS_COLORS, FLAG_COLORS, CHANNEL_COLORS, UI_COLORS, TYRE_COLORS, TEXT_COLORS, TRACK_COLORS,
  MEDAL_COLORS, toHex,
} from '../utils/colors.js';

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles');
const tokens = rootTokens(parseCssFile(path.join(STYLES, 'tokens.css')));
const token = (name) => toHex(tokens.get(name));

describe('tokens.css mirrors utils/colors.js', () => {
  it('diverging pair, timing status, flags, channels, accents', () => {
    const MIRROR = {
      '--color-better': DIVERGING.better,
      '--color-worse': DIVERGING.worse,
      '--sector-purple': STATUS_COLORS.overallBest,
      '--sector-green': STATUS_COLORS.personalBest,
      '--sector-yellow': STATUS_COLORS.slower,
      '--status-pit': STATUS_COLORS.pit,
      '--status-retired': STATUS_COLORS.retired,
      '--status-predicted': STATUS_COLORS.predicted,
      '--flag-green': FLAG_COLORS.green,
      '--flag-yellow': FLAG_COLORS.yellow,
      '--flag-sc': FLAG_COLORS.safetyCar,
      '--flag-red': FLAG_COLORS.red,
      '--channel-throttle': CHANNEL_COLORS.throttle,
      '--channel-brake': CHANNEL_COLORS.brake,
      '--color-brush': UI_COLORS.brush,
      '--color-pit-window': UI_COLORS.pitWindow,
      '--track-drs': TRACK_COLORS.drs,
      '--medal-gold': MEDAL_COLORS[1],
      '--color-text-secondary': TEXT_COLORS.secondary,
      '--color-text-muted': TEXT_COLORS.muted,
      '--tyre-soft': TYRE_COLORS.SOFT,
      '--tyre-medium': TYRE_COLORS.MEDIUM,
      '--tyre-hard': TYRE_COLORS.HARD,
      '--tyre-intermediate': TYRE_COLORS.INTERMEDIATE,
      '--tyre-wet': TYRE_COLORS.WET,
    };
    const rows = Object.entries(MIRROR).map(([name, c]) => [name, token(name), toHex(c)]);
    for (const [name, css, js] of rows) expect(css, name).toBe(js);
  });
});
