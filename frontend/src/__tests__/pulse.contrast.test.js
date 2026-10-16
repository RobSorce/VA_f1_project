// No endless animation of the app takes a status mark under
// 3:1, or a text under 4.5:1, at its lowest keyframe (docs/COLOR_ENCODING.md,
// "Animations"; WCAG 2.1 1.4.3 / 1.4.11).
//
// The Race Situation map's focus ring pulsed down to opacity 0.3: 2.69:1 on
// the panel. The sweep of the other endless animations of dashboard.css and
// visualizations.css found three more: the Leaderboard's flag banner pulsed
// to 0.8 (its RED FLAG label 3.93:1), the Track Map's winner banner to 0.9
// (the winner's name 4.08:1 for LEC), the focused tower row brightened to a
// 0.18 white tint (its ▲ / ▼ text 4.03 / 4.18:1, its muted text 4.41:1). Now
// the ring pulses down to 0.5, the two banners are static, the focused row
// pulses up to its static 0.14.
//
// That sweep left out the other stylesheets and the inline styles of every
// component but the Track Map, where five more were: the
// Leaderboard's winner banner at 0.9 (the winner's name 3.73:1 at the tinted
// end, Aston Martin), the Pit Wall Timing Tower's flag banner and the
// session bar's flag chip at 0.8 (their RED FLAG label 4.37 / 4.15:1), the
// live dots at 0.6 (1.93:1 on the panel; the Weather Bar's LIVE badge text
// 4.45:1), the live progress bar at 0.7 (2.02:1 on its track). Now the
// banners, the chip and the bar are static, the live dots' glow pulses and
// the dots never fade.
//
// Every rule of every stylesheet that runs an endless animation, and every
// endless animation a component sets inline, is listed below with what it
// animates: a status mark or a text (its contrast at the lowest keyframe), a
// row tint under text (the texts on every keyframe), a halo behind a mark
// that never fades, keyframes without opacity, or a disabled control. A new
// one fails the first test until it is listed.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './helpers/layoutCss.js';
import * as C from '../utils/colors.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILES = H.listFiles(SRC, ['.css']);
const rules = CSS_FILES.flatMap((f) => H.parseCssFile(f));
const tokens = H.rootTokens(rules);
const col = (v) => {
  const c = H.parseColor(H.resolveVars(String(v), tokens));
  if (!c) throw new Error(`colour ${v}`);
  return c;
};
const decl = (sel, prop) => H.declOf(rules, sel, prop);
const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// Every @keyframes block of the app's CSS (brace matched), by name
const KEYFRAMES = new Map();
for (const f of CSS_FILES) {
  const text = H.stripComments(fs.readFileSync(f, 'utf8'));
  for (const m of text.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1;
    let j = m.index + m[0].length;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    const body = text.slice(m.index + m[0].length, j - 1);
    KEYFRAMES.set(m[1], [...(KEYFRAMES.get(m[1]) || []), body]);
  }
}
/** Lowest opacity (opacity, stroke-opacity, fill-opacity) of a keyframes, null when it sets none. */
const lowestOpacity = (name) => {
  const ops = (KEYFRAMES.get(name) || []).flatMap((b) => [...b.matchAll(/(?:^|[\s;{])(?:stroke-|fill-)?opacity:\s*([\d.]+)/g)].map((x) => Number(x[1])));
  return ops.length ? Math.min(...ops) : null;
};
/** The background of each keyframe (resolved), in order. */
const frameBackgrounds = (name) => (KEYFRAMES.get(name) || [])
  .flatMap((b) => [...b.matchAll(/background:\s*([^;}]+)/g)].map((x) => H.resolveVars(x[1].trim(), tokens)));

// The endless animations: the rules of every stylesheet, and the inline
// styles of every component and module (a string "<name> ... infinite")
const ANIMATED = [];
for (const r of rules) {
  for (const d of r.decls) {
    if (d.prop !== 'animation' || !/\binfinite\b/.test(d.value)) continue;
    const name = d.value.split(/\s+/).find((t) => KEYFRAMES.has(t));
    ANIMATED.push({ id: `${r.selector} ${name}`, where: `${rel(r.file)}:${d.line}`, important: d.important });
  }
}
const SOURCES = H.listFiles(SRC, ['.js', '.jsx']);
for (const f of SOURCES) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/(['"`])([\w-]+) [^'"`\n]*\binfinite\b[^'"`\n]*\1/g)) {
    ANIMATED.push({ id: `${path.basename(f)} (inline) ${m[2]}`, where: `${rel(f)}:${text.slice(0, m.index).split('\n').length}` });
  }
}
const TRACK_MAP = read('components/visualizations/TrackMap.jsx');
const TIMING_TOWER = read('components/visualizations/TimingTower.jsx');

// Surfaces (the dark theme: the app always runs it, docs/COLOR_ENCODING.md)
const PANEL = col(C.SURFACES.panel);
const RAISED = col(C.SURFACES.raised);
const PAGE = col(C.SURFACES.page);
// The Track Map's own background: the viz-container's radial gradient over the panel, both stops
const mapStops = /radial-gradient\(ellipse at center, (rgba\([^)]+\)) 0%, (rgba\([^)]+\)) 100%\)/.exec(TRACK_MAP);
const MAP_BG = mapStops ? [mapStops[1], mapStops[2]].map((s) => H.over(col(s), PANEL)) : [];
// The tower's texts on a row: their CSS colours (a pitting row keeps its own !important pit tint)
const TOWER_TEXTS = [
  '.tower-row', '.tower-col-value', '.tower-col-value--leader', '.tower-col-value--retired',
  '.tower-row__grid-arrows--up', '.tower-row__grid-arrows--down', '.tower-row__arrow--up', '.tower-row__arrow--down',
  '.tower-row__battle-badge',
].map((sel) => [sel, col(decl(sel, 'color'))]);

const rows = [];
const check = (name, fg, bg, need) => {
  const r = H.contrast(fg, bg);
  rows.push(`${r >= need ? 'OK  ' : 'FAIL'} ${r.toFixed(2)}:1 (needs ${need})  ${name}`);
  return r;
};

/*
 * What each endless animation draws. kind:
 *  - 'mark' / 'text': contrast of the element at the lowest keyframe opacity
 *    on the surfaces it is drawn on (>= 3:1 / >= 4.5:1)
 *  - 'row-tint': the keyframes animate a row's background; the row's texts
 *    on every keyframe (>= 4.5:1)
 *  - 'row-tint-capped': the keyframes animate a row's background, never
 *    lighter than the static tint the component sets with them (the texts
 *    on the row read as on its static tint)
 *  - 'halo': a glow behind a mark that is never animated itself
 *  - 'no-opacity': the keyframes animate no opacity (border, shadow, rotation)
 *  - 'disabled': an inactive control (WCAG 2.1 exempts it)
 */
const LIVE_GLOW = 'the glow of a live dot (box-shadow); the dot, or the LIVE badge, keeps full opacity';
const PULSES = {
  '.situation-focus-ring situation-pulse': {
    kind: 'mark', what: 'Race Situation map focus ring', fg: () => col(decl('.situation-focus-ring', 'stroke')), on: [['panel', PANEL], ['raised surface', RAISED]],
  },
  '.focus-widget__pulse focusPulse': {
    kind: 'mark', what: 'Focus Driver widget prediction dot', fg: () => col(decl('.focus-widget__pulse', 'background')), on: [['focus widget', H.over(col(decl('.focus-widget', 'background')), PAGE)]],
  },
  '.drs-zone-outer--active drs-pulse': {
    kind: 'mark', what: 'Track Map active DRS zone edge', fg: () => col(decl('.drs-zone-outer', 'stroke')), on: MAP_BG.map((bg, i) => [`map ${i ? 'edge' : 'centre'}`, bg]),
  },
  '.app-sidebar .panel.panel--bezel-active::after bezel-glow-pulse': {
    // the bezel's top stop is the flag's colour (Leaderboard.jsx --bezel-color)
    kind: 'mark', what: 'Leaderboard bezel top edge', fgs: () => Object.values(C.TRACK_STATUS_STYLES).map((s) => [s.short, col(s.color)]), on: [['panel', PANEL]],
  },
  '.tower-col-value--pit pit-blink': {
    kind: 'text', what: 'Timing Tower PIT value', fg: () => col(decl('.tower-col-value--pit', 'color')), on: [['pitting row', H.over(col('color-mix(in srgb, var(--status-pit) 8%, transparent)'), PANEL)]],
  },
  '.status-dot pulse': {
    // the header's backend status dot (Header.jsx), as in docs/evidence/contrast_pairs.txt
    kind: 'mark', what: 'header status dot', fg: () => col(decl('.status-dot', 'background-color')), on: [['page', PAGE]],
  },
  '.tower-row--focused focus-row-pulse': { kind: 'row-tint', what: 'focused tower row' },
  '.tower-row--winner winner-row-pulse': { kind: 'row-tint', what: 'winner tower row', staticImportant: true },
  'TimingTower.jsx (inline) focus-row-pulse': {
    kind: 'row-tint-capped', what: 'Pit Wall Timing Tower focused row',
    staticTint: () => /rowStyle\.background = '(rgba\([^)]+\))';\s*rowStyle\.animation = 'focus-row-pulse /.exec(TIMING_TOWER)?.[1],
  },
  '.car-marker.leader .car-glow leader-pulse': { kind: 'halo', why: 'glow behind the leader\'s dot (no rule sets .leader today)' },
  '.car-glow--selected pulse-glow': { kind: 'halo', why: 'glow behind a selected car\'s dot; the selection is its blue stroke (.car-marker.selected .car-dot)' },
  '.car-glow--focused focus-car-pulse': { kind: 'halo', why: 'glow behind the focus car\'s dot; the focus is its white stroke and its size' },
  '.app-sidebar .panel.panel--bezel-active bezel-outer-glow': { kind: 'no-opacity', why: 'box-shadow' },
  '.session-screen__spinner spin': { kind: 'no-opacity', why: 'rotation' },
  '.spinner spin': { kind: 'no-opacity', why: 'rotation' },
  '.session-menu__spinner spin': { kind: 'no-opacity', why: 'rotation' },
  '.track-map-hazard--active hazard-border-pulse': { kind: 'no-opacity', why: 'border colour and shadow, the flag colour at full strength' },
  'TrackMap.jsx (inline) hazard-border-pulse': { kind: 'no-opacity', why: 'the panel border under a flag or the chequered flag' },
  '.live-pulse.active livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  'RadioPipToast.jsx (inline) livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  'SessionSelectorScreen.jsx (inline) livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  'WeatherBar.jsx (inline) livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  'RaceControlPanel.jsx (inline) livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  'RacePaceGrid.jsx (inline) livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  'TimingTower.jsx (inline) livePulse': { kind: 'no-opacity', why: LIVE_GLOW },
  '.timeline-player__play-btn.loading loading-pulse': {
    kind: 'disabled', why: 'the play button while the frames load: disabled (no frames yet), its glyph the hourglass emoji',
    disabled: () => decl('.timeline-player__play-btn:disabled', 'cursor') === 'not-allowed',
  },
  '.header-quali-pill.loading:disabled quali-pill-pulse': {
    kind: 'disabled', why: 'a qualifying segment pill while the frames load: the rule matches it only when disabled',
    disabled: (id) => id.startsWith('.header-quali-pill.loading:disabled '),
  },
};

describe('Every endless animation keeps its mark >= 3:1 and its text >= 4.5:1 at the lowest keyframe', () => {
  it('every endless animation of every stylesheet and of every component\'s inline styles is listed', () => {
    expect(ANIMATED.length).toBeGreaterThan(20);
    // the sweep reads every stylesheet and the inline styles of every component (an earlier sweep read only two of them and the Track Map)
    for (const f of ['styles/components.css', 'components/visualizations/TimingTower.jsx', 'components/ui/WeatherBar.jsx', 'components/ui/RadioPipToast.jsx']) {
      expect(ANIMATED.some((a) => a.where.startsWith(`${f}:`)), f).toBe(true);
    }
    expect(ANIMATED.filter((a) => !PULSES[a.id]).map((a) => `${a.id} (${a.where})`)).toEqual([]);
    // and each listed one is still there (a stale entry hides nothing)
    const ids = new Set(ANIMATED.map((a) => a.id));
    expect(Object.keys(PULSES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('the status marks and texts at the lowest opacity of their keyframes', () => {
    for (const [id, p] of Object.entries(PULSES)) {
      if (p.kind !== 'mark' && p.kind !== 'text') continue;
      const kf = id.split(' ').at(-1);
      const lo = lowestOpacity(kf);
      expect(lo, id).not.toBeNull();
      const need = p.kind === 'text' ? 4.5 : 3;
      const fgs = p.fgs ? p.fgs() : [['', p.fg()]];
      expect(p.on.length, id).toBeGreaterThan(0);
      for (const [fgName, fg] of fgs) {
        for (const [bgName, bg] of p.on) {
          const r = check(`${p.what}${fgName ? ` ${fgName}` : ''} on the ${bgName}, ${kf} at its lowest opacity ${lo}`, H.over(fg, bg, lo), bg, need);
          expect(r, `${id} ${fgName} ${bgName}`).toBeGreaterThanOrEqual(need);
        }
      }
    }
  });

  it('the Race Situation focus ring: 0.5 at the lowest (5.28:1); 0.3 read 2.69:1', () => {
    expect(lowestOpacity('situation-pulse')).toBe(0.5);
    const ring = col(decl('.situation-focus-ring', 'stroke'));
    expect(H.contrast(H.over(ring, PANEL, 0.5), PANEL)).toBeCloseTo(5.28, 2);
    expect(H.contrast(H.over(ring, PANEL, 0.3), PANEL)).toBeLessThan(3);
  });

  it('the tower rows: their texts on every keyframe of the row tint >= 4.5:1', () => {
    for (const [id, p] of Object.entries(PULSES)) {
      if (p.kind !== 'row-tint') continue;
      const [sel, kf] = [id.slice(0, id.lastIndexOf(' ')), id.split(' ').at(-1)];
      let tints = frameBackgrounds(kf);
      if (p.staticImportant) {
        // an !important background is not overridden by the animation: the static one is drawn
        expect(ANIMATED.find((a) => a.id === id)).toBeTruthy();
        const bg = rules.find((r) => r.selector === sel && r.decls.some((d) => d.prop === 'background' && d.important));
        expect(bg, `${sel} background !important`).toBeTruthy();
        tints = [H.resolveVars(bg.decls.find((d) => d.prop === 'background').value, tokens)];
      }
      expect(tints.length, id).toBeGreaterThan(0);
      for (const t of tints) {
        // a gradient: its strongest stop (the first)
        const stop = /color-mix\(in srgb, [^()]*\)|rgba?\([^()]*\)/.exec(t)[0];
        const bg = H.over(col(stop), PANEL);
        for (const [tsel, fg] of TOWER_TEXTS) {
          const r = check(`${p.what} (${stop}): ${tsel}`, H.over(fg, bg), bg, 4.5);
          expect(r, `${id} ${stop} ${tsel}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('a row tint capped at its static tint: no keyframe lighter than the tint the component sets', () => {
    const capped = Object.entries(PULSES).filter(([, p]) => p.kind === 'row-tint-capped');
    expect(capped.length).toBeGreaterThan(0);
    for (const [id, p] of capped) {
      const tint = p.staticTint();
      expect(tint, `${id}: the static tint set with the animation`).toBeTruthy();
      const frames = frameBackgrounds(id.split(' ').at(-1));
      expect(frames.length, id).toBeGreaterThan(0);
      const st = col(tint);
      for (const f of frames) {
        const c = col(f);
        expect(c.slice(0, 3), `${id} ${f}`).toEqual(st.slice(0, 3));
        expect(c[3], `${id} ${f} over the static ${tint}`).toBeLessThanOrEqual(st[3]);
      }
    }
  });

  it('halos, keyframes without opacity, the disabled controls: as listed', () => {
    for (const [id, p] of Object.entries(PULSES)) {
      const kf = id.split(' ').at(-1);
      if (p.kind === 'no-opacity') expect(lowestOpacity(kf), id).toBeNull();
      if (p.kind === 'halo') expect(id).toMatch(/car-glow/);
      if (p.kind === 'disabled') expect(p.disabled(id), id).toBe(true);
    }
    // the marks the halos surround are never animated
    expect(rules.filter((r) => /\.car-dot\b/.test(r.selector) && r.decls.some((d) => d.prop === 'animation')).map((r) => r.selector)).toEqual([]);
  });

  it('the banners and chips with a label are static: the flag banners and chip, the winner banners', () => {
    expect(decl('.tower-flag-banner', 'animation')).toBeNull();
    expect(TRACK_MAP).not.toMatch(/animation: '[^']*winner-banner-glow/);
    // nothing runs the three pulses of the labels and of the live progress bar any more
    expect(ANIMATED.filter((a) => /(flag-pulse|winner-banner-glow|liveProgressPulse)$/.test(a.id)).map((a) => a.where)).toEqual([]);
    // before: the RED FLAG label at flag-pulse's 0.8 on the panel
    const chip = C.tintedChip(C.TRACK_STATUS_STYLES['5'].color, 0.15);
    const at = (o) => H.contrast(H.over(col(chip.color), PANEL, o), H.over(col(chip.background), PANEL, o));
    expect(at(1)).toBeGreaterThanOrEqual(4.5);
    expect(at(0.8)).toBeLessThan(4.5);
  });

  // An element (a text on its own tint) at group opacity o over an opaque surface
  const elementAt = (text, tint, surface, o = 1) => {
    const under = H.over(col(tint), surface);
    return H.contrast(H.over(H.over(col(text), under), surface, o), H.over(under, surface, o));
  };

  it('the Pit Wall flag labels: the Timing Tower banner and the session bar chip, static (4.37 / 4.15:1 at flag-pulse 0.8)', () => {
    // the Timing Tower's container (rgba(10,10,20,0.95)) and the session bar over the page
    const tower = H.over(col(/background: '(rgba\(10,10,20,0\.95\))'/.exec(TIMING_TOWER)[1]), PAGE);
    const bar = H.over(col(decl('.session-info-bar', 'background')), PAGE);
    expect(TIMING_TOWER).toMatch(/const chip = tintedChip\(st\.color, 0\.12\);/);
    expect(read('components/ui/SessionInfoBar.jsx')).toMatch(/tintedChip\(st\.color, 0\.15, SURFACES\.panel\)/);
    for (const [k, st] of Object.entries(C.TRACK_STATUS_STYLES)) {
      if (k === '1') continue;
      const tc = C.tintedChip(st.color, 0.12);
      const sc = C.tintedChip(st.color, 0.15, C.SURFACES.panel);
      check(`Timing Tower flag banner ${st.short} (static) on its container`, col(tc.color), H.over(col(tc.background), tower), 4.5);
      check(`session bar flag chip ${st.short} (static) on the bar`, col(sc.color), H.over(col(sc.background), bar), 4.5);
      expect(elementAt(tc.color, tc.background, tower), st.short).toBeGreaterThanOrEqual(4.5);
      expect(elementAt(sc.color, sc.background, bar), st.short).toBeGreaterThanOrEqual(4.5);
    }
    // before: RED FLAG at flag-pulse's 0.8
    const red = C.TRACK_STATUS_STYLES['5'].color;
    const tc = C.tintedChip(red, 0.12);
    const sc = C.tintedChip(red, 0.15, C.SURFACES.panel);
    expect(elementAt(tc.color, tc.background, tower, 0.8)).toBeCloseTo(4.37, 2);
    expect(elementAt(sc.color, sc.background, bar, 0.8)).toBeCloseTo(4.15, 2);
  });

  it('the Leaderboard winner banner: static, the name >= 4.5:1 on the tinted ends and the middle for every driver and team colour', () => {
    const lb = read('components/visualizations/Leaderboard.jsx');
    expect(lb).toMatch(/const chip = tintedChip\(winner\.color, 0\.15\);/);
    expect(lb).toMatch(/background: `linear-gradient\(90deg, \$\{chip\.background\}, transparent, \$\{chip\.background\}\)`/);
    expect(lb).toMatch(/fontSize: '12px',\s*color: chip\.color,/);
    // the panel, and the Leaderboard's glass (--glass-bg) over the page
    const glass = H.over(col('var(--glass-bg)'), PAGE);
    const colours = new Set([
      ...Object.keys(C.DRIVER_COLORS).map((d) => C.getDriverColor(d)),
      ...Object.values(C.TEAM_COLORS), C.UNKNOWN_TEAM_COLOR,
    ]);
    let worst = Infinity;
    for (const c of colours) {
      const chip = C.tintedChip(c, 0.15);
      for (const s of [PANEL, glass]) {
        for (const tint of [chip.background, 'rgba(0,0,0,0)']) worst = Math.min(worst, elementAt(chip.color, tint, s));
      }
    }
    rows.push(`${worst >= 4.5 ? 'OK  ' : 'FAIL'} ${worst.toFixed(2)}:1 (needs 4.5)  Leaderboard winner name, worst of ${colours.size} colours, tinted end and middle, panel and glass (static)`);
    expect(worst).toBeGreaterThanOrEqual(4.5);
    // before: the name lifted on the chart surface only, at the tinted end on the panel (Aston Martin)
    const am = C.TEAM_COLORS['Aston Martin'];
    expect(elementAt(C.textColor(am), C.withAlpha(am, 0.15), PANEL, 0.9)).toBeCloseTo(3.73, 2);
    expect(elementAt(C.textColor(am), C.withAlpha(am, 0.15), PANEL)).toBeCloseTo(4.28, 2);
  });

  it('the live dots and the LIVE badge keep full opacity (1.93:1 and 4.45:1 at livePulse 0.6); the live progress bar is static (2.02:1 at 0.7)', () => {
    expect(lowestOpacity('livePulse')).toBeNull();
    expect(decl('.timeline-player--live .timeline-player__progress-fill--live', 'animation')).toBeNull();
    const dot = col(C.UI_COLORS.accent);
    expect(decl('.live-pulse.active', 'background')).toBe('#e10600');
    for (const [name, s] of [['page', PAGE], ['panel', PANEL]]) {
      check(`live dot (full opacity) on the ${name}`, dot, s, 3);
      expect(H.contrast(dot, s), name).toBeGreaterThanOrEqual(3);
    }
    // the Weather Bar's LIVE badge: white text on the accent at 0.8, over the bar
    const wbar = H.over(col(decl('.weather-bar', 'background')), PAGE);
    expect(read('components/ui/WeatherBar.jsx')).toMatch(/background: withAlpha\(UI_COLORS\.accent, liveConnected \? 0\.8 : 0\.3\)/);
    const badge = C.withAlpha(C.UI_COLORS.accent, 0.8);
    check('Weather Bar LIVE badge text (full opacity)', col(decl('.weather-bar__live-badge', 'color')), H.over(col(badge), wbar), 4.5);
    expect(elementAt(decl('.weather-bar__live-badge', 'color'), badge, wbar)).toBeGreaterThanOrEqual(4.5);
    // the live progress bar: both stops on the track over the player's glass
    const track = H.over(col(decl('.timeline-player__progress-track', 'background')), H.over(col(decl('.timeline-player', 'background')), PAGE));
    const stops = /linear-gradient\(90deg, (#\w+) 0%, (#\w+) 100%\)/.exec(decl('.timeline-player--live .timeline-player__progress-fill--live', 'background'));
    for (const stop of stops.slice(1)) {
      check(`live progress bar ${stop} (static) on its track`, col(stop), track, 3);
      expect(H.contrast(col(stop), track), stop).toBeGreaterThanOrEqual(3);
    }
    // before
    expect(H.contrast(H.over(dot, PANEL, 0.6), PANEL)).toBeCloseTo(1.93, 2);
    expect(elementAt(decl('.weather-bar__live-badge', 'color'), badge, wbar, 0.6)).toBeCloseTo(4.45, 2);
    expect(H.contrast(H.over(col(stops[1]), track, 0.7), track)).toBeCloseTo(2.02, 2);
  });

  it('prints the table', () => {
    console.log(rows.join('\n'));
    expect(rows.filter((r) => r.startsWith('FAIL'))).toEqual([]);
  });
});
