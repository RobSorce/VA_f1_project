// The palette module (utils/colors.js), V1-V3 and V13 targets 2 and 4:
// contrast of text, marks and badges on the dark surfaces, CVD separation of
// every palette that must stand on colour alone, the teammate rule, the
// diverging pair with its sign, and the font floors handed to D3 code.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SURFACES, TEXT_COLORS, DIVERGING, STATUS_COLORS, STATUS_GLYPHS, FLAG_COLORS, TRACK_STATUS_STYLES,
  CHANNEL_COLORS, SERIES_COLORS, SECTOR_COLORS, TEAM_COLORS, TYRE_COLORS, TYRE_LABELS,
  CHART_FONT, FONT_FLOOR_PX, chartFontPx, contrastRatio, contrastText, markColor, textColor,
  closestPair, deltaE2000, simulateCvd, CVD_MIN_DELTA_E, deltaColor, signedDelta, tintedChip,
  setSessionDriverColors, getDriverColor, getDriverTeamColor, getDriverDash, teammateIndex,
  teammateTint, driverStyle, getTyreTextColor, parseColor, compositeOver, withAlpha, tyreLetter,
} from '../utils/colors.js';

const TYPES = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];
const surfaces = Object.values(SURFACES);
const minOver = (pal) => Math.min(...TYPES.map((t) => closestPair(pal, t).deltaE));

describe('colour science', () => {
  it('parses hex and rgba, composites and measures WCAG contrast', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    expect(compositeOver('rgba(255,255,255,0.5)', '#000000')).toBe('#808080');
    expect(withAlpha('#FF8000', 0.2)).toBe('rgba(255,128,0,0.2)');
  });

  it('CIEDE2000 matches the Sharma et al. reference pair (1)', () => {
    // Pair 1 of Sharma, Wu & Dalal (2005) is in Lab; check the metric's basics
    expect(deltaE2000('#FF0000', '#FF0000')).toBeCloseTo(0, 6);
    expect(deltaE2000('#000000', '#FFFFFF')).toBeGreaterThan(90);
    // Red and green collapse under deuteranopia (the reason V1 exists)
    expect(deltaE2000(simulateCvd('#E10600', 'deuteranopia'), simulateCvd('#00A000', 'deuteranopia')))
      .toBeLessThan(deltaE2000('#E10600', '#00A000') / 3);
  });
});

describe('text and marks on the dark surfaces (V13 target 2)', () => {
  it('neutral text >= 4.5:1 on every surface', () => {
    for (const c of Object.values(TEXT_COLORS)) {
      for (const s of surfaces) expect(contrastRatio(c, s), `${c} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every semantic text colour >= 4.5:1 on every surface', () => {
    const text = [DIVERGING.better, DIVERGING.worse, ...Object.values(STATUS_COLORS), ...Object.values(FLAG_COLORS)];
    for (const c of text) {
      for (const s of surfaces) expect(contrastRatio(c, s), `${c} on ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('team colours drawn as marks reach 3:1 on every surface through markColor; text 4.5:1 through textColor', () => {
    for (const [team, c] of Object.entries(TEAM_COLORS)) {
      for (const s of surfaces) {
        expect(contrastRatio(markColor(c, s), s), `${team} mark on ${s}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(textColor(c, s), s), `${team} text on ${s}`).toBeGreaterThanOrEqual(4.5);
        const tint = teammateTint(c);
        expect(contrastRatio(markColor(tint, s), s), `${team} teammate mark on ${s}`).toBeGreaterThanOrEqual(3);
      }
    }
    // A colour that already passes is drawn unchanged
    expect(markColor(TEAM_COLORS.McLaren)).toBe(TEAM_COLORS.McLaren);
  });

  it('contrastText: black on light team colours (the findings badges), white on dark ones, >= 4.5:1', () => {
    // Findings 2026-10-14: white text measured 1.40 (Mercedes) .. 3.58 (Aston Martin)
    for (const team of ['Mercedes', 'Kick Sauber', 'Williams', 'Haas F1 Team', 'Alpine', 'McLaren', 'RB', 'Aston Martin']) {
      expect(contrastText(TEAM_COLORS[team]), team).toBe('#000000');
    }
    expect(contrastText(TEAM_COLORS['Red Bull Racing'])).toBe('#FFFFFF');
    const fills = [...Object.values(TEAM_COLORS), ...Object.values(TEAM_COLORS).map(teammateTint), ...Object.values(TYRE_COLORS)];
    for (const c of fills) expect(contrastRatio(contrastText(c), c), c).toBeGreaterThanOrEqual(4.5);
    for (const k of Object.keys(TYRE_COLORS)) expect(getTyreTextColor(k)).toBe(contrastText(TYRE_COLORS[k]));
  });

  it('tinted chips never put a colour on its own dark tint below 4.5:1 (red-on-dark-red)', () => {
    for (const c of [...Object.values(FLAG_COLORS), STATUS_COLORS.pit, STATUS_COLORS.overallBest, '#E10600']) {
      const chip = tintedChip(c);
      const under = compositeOver(chip.background, SURFACES.raised);
      expect(contrastRatio(chip.color, under), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('colour-vision deficiency (V13 target 4)', () => {
  it('palettes that carry no other cue stay >= CIEDE2000 10 apart under every vision type', () => {
    expect(minOver({ b: DIVERGING.better, w: DIVERGING.worse })).toBeGreaterThanOrEqual(40);
    expect(minOver(CHANNEL_COLORS)).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
    expect(minOver(Object.fromEntries(SERIES_COLORS.map((c, i) => [i, c])))).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
    expect(minOver(SECTOR_COLORS)).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
    expect(minOver({
      fast: STATUS_COLORS.fast, normal: STATUS_COLORS.normal, slower: STATUS_COLORS.slower, much: STATUS_COLORS.muchSlower,
    })).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
    expect(minOver({
      ob: STATUS_COLORS.overallBest, pb: STATUS_COLORS.personalBest, slower: STATUS_COLORS.slower,
      normal: STATUS_COLORS.normal, pit: STATUS_COLORS.pit,
    })).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
  });

  it('palettes kept for convention carry their cue: compound letters, flag labels, timing glyphs', () => {
    for (const k of ['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET']) expect(tyreLetter(k)).toBe(TYRE_LABELS[k]);
    for (const s of Object.values(TRACK_STATUS_STYLES)) expect(s.short.length).toBeGreaterThan(0);
    expect(STATUS_GLYPHS.overallBest).not.toBe(STATUS_GLYPHS.personalBest);
    // ... and they are the palettes that would fail without it
    expect(minOver(Object.fromEntries(Object.entries(TYRE_COLORS).filter(([k]) => TYRE_LABELS[k])))).toBeLessThan(CVD_MIN_DELTA_E);
  });

  it('no green/red pair is left in the two-sided encodings (better/worse, throttle/brake)', () => {
    for (const t of ['protanopia', 'deuteranopia']) {
      expect(closestPair({ better: DIVERGING.better, worse: DIVERGING.worse }, t).deltaE, t)
        .toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
      expect(closestPair({ throttle: CHANNEL_COLORS.throttle, brake: CHANNEL_COLORS.brake }, t).deltaE, t)
        .toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
    }
    expect(FLAG_COLORS.green).toBe(STATUS_COLORS.personalBest);
  });
});

describe('diverging pair with its sign (V1)', () => {
  it('lower is better for lap times and gaps, higher for positions; sign always shown', () => {
    expect(deltaColor(-0.2)).toBe(DIVERGING.better);
    expect(deltaColor(0.2)).toBe(DIVERGING.worse);
    expect(deltaColor(0.01, { deadband: 0.05 })).toBe(DIVERGING.neutral);
    expect(deltaColor(2, { lowerIsBetter: false })).toBe(DIVERGING.better);
    expect(signedDelta(0.1234)).toBe('+0.123');
    expect(signedDelta(-0.1234)).toBe('−0.123');
    expect(signedDelta(0)).toBe('0.000');
    expect(signedDelta(NaN)).toBe('');
  });
});

describe('teammates (V3)', () => {
  beforeEach(() => setSessionDriverColors([]));

  it('the session line-up: lower car number solid, teammate dashed and tinted', () => {
    setSessionDriverColors([
      { Abbreviation: 'PIA', TeamName: 'McLaren', DriverNumber: '81' },
      { Abbreviation: 'NOR', TeamName: 'McLaren', DriverNumber: '4' },
      { Abbreviation: 'RUS', TeamName: 'Mercedes', DriverNumber: '63' },
      { Abbreviation: 'HAM', TeamName: 'Mercedes', DriverNumber: '44' },
    ]);
    expect(teammateIndex('NOR')).toBe(0);
    expect(teammateIndex('PIA')).toBe(1);
    expect(getDriverDash('NOR')).toBeNull();
    expect(getDriverDash('PIA')).toBe('6,3');
    expect(getDriverColor('NOR')).toBe(TEAM_COLORS.McLaren);
    expect(getDriverColor('PIA')).toBe(teammateTint(TEAM_COLORS.McLaren));
    expect(getDriverTeamColor('PIA')).toBe(TEAM_COLORS.McLaren);
    expect(getDriverColor('HAM')).toBe(TEAM_COLORS.Mercedes);
    expect(getDriverColor('RUS')).not.toBe(getDriverColor('HAM'));
    const s = driverStyle('RUS');
    expect(s.teammate).toBe(1);
    expect(contrastRatio(s.badgeText, s.color)).toBeGreaterThanOrEqual(4.5);
  });

  it('without car numbers (live feed) the code orders the pair; static 2024 map alphabetical', () => {
    setSessionDriverColors([
      { Abbreviation: 'VER', TeamName: 'Red Bull Racing' },
      { Abbreviation: 'PER', TeamName: 'Red Bull Racing' },
    ]);
    expect(teammateIndex('PER')).toBe(0);
    expect(teammateIndex('VER')).toBe(1);
    setSessionDriverColors([]);
    expect(teammateIndex('LEC')).toBe(0);
    expect(teammateIndex('SAI')).toBe(1);
  });

  it('every team: the two drivers differ by CIEDE2000 >= 10 under every vision type', () => {
    for (const [team, c] of Object.entries(TEAM_COLORS)) {
      const t = teammateTint(c);
      for (const ty of TYPES) {
        const d = ty === 'normal' ? deltaE2000(c, t) : deltaE2000(simulateCvd(c, ty), simulateCvd(t, ty));
        expect(d, `${team} ${ty}`).toBeGreaterThanOrEqual(CVD_MIN_DELTA_E);
      }
    }
  });
});

describe('font floors for D3 and inline styles (V13 target 3)', () => {
  it('CHART_FONT never resolves under 11 px (data) / 10 px (label)', () => {
    expect(FONT_FLOOR_PX).toEqual({ data: 11, label: 10 });
    expect(CHART_FONT.data).toMatch(/^max\(11px, var\(--font-size-data, 11px\)\)$/);
    expect(CHART_FONT.label).toMatch(/^max\(10px, var\(--font-size-label, 10px\)\)$/);
    expect(chartFontPx('data')).toBeGreaterThanOrEqual(11);
    expect(chartFontPx('label')).toBeGreaterThanOrEqual(10);
  });

  // A browser returns an unregistered custom property as declared (math not
  // evaluated): chartFontPx must evaluate it with the viewport, so layout code
  // measures text at the size CSS draws it (it returned the floor)
  it('chartFontPx evaluates the declared token at the viewport, as CSS draws it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const tokens = fs.readFileSync(path.resolve(__dirname, '../styles/tokens.css'), 'utf8');
    const declared = (name) => tokens.match(new RegExp(`${name}:\\s*([^;]+);`))[1].trim();
    expect(declared('--font-size-data')).toMatch(/^clamp\(/);
    const saved = {
      document: globalThis.document, gcs: globalThis.getComputedStyle, window: globalThis.window,
    };
    globalThis.document = { documentElement: {} };
    globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => ` ${declared(n)}`, fontSize: '16px' });
    const at = (W, H) => { globalThis.window = { innerWidth: W, innerHeight: H }; return [chartFontPx('data'), chartFontPx('label')]; };
    try {
      const [d750, l750] = at(1536, 750);
      const [d768] = at(1366, 768);
      const [d1080, l1080] = at(1920, 1080);
      const [d1100] = at(2048, 1100);
      console.log(`chartFontPx data: 1536x750 ${d750.toFixed(2)}, 1366x768 ${d768.toFixed(2)}, 1920x1080 ${d1080.toFixed(2)}, 2048x1100 ${d1100.toFixed(2)}; label 1536x750 ${l750.toFixed(2)}, 1920x1080 ${l1080.toFixed(2)}`);
      // clamp(11px, calc(7.786px + 0.4286vh), 12.5px)
      expect(d750).toBeCloseTo(7.786 + 0.4286 * 7.5, 3);
      expect(d768).toBeCloseTo(7.786 + 0.4286 * 7.68, 3);
      expect(d1080).toBeCloseTo(7.786 + 0.4286 * 10.8, 3);
      expect(d1080).toBeGreaterThan(12.4);
      expect(d1100).toBe(12.5);
      expect(l1080).toBeCloseTo(6.786 + 0.4286 * 10.8, 3);
      expect(l750).toBeGreaterThanOrEqual(10);
    } finally {
      globalThis.document = saved.document;
      globalThis.getComputedStyle = saved.gcs;
      globalThis.window = saved.window;
    }
  });
});
