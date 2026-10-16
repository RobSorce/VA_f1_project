// Race Control (components/visualizations/RaceControlPanel.jsx):
//  - no scroll: the feed, the DNF list and the team radios show the rows that
//    fit and page through the rest (newest first); the old panel had three
//    overflow-y: auto areas;
//  - categories told apart by their glyph (every glyph different) and label,
//    flags by their label; colours from utils/colors.js (FLAG_COLORS), no
//    colour literal and no green / red pair without a label;
//  - text at the CSS font tokens (no fixed pixel font size).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { installMiniDom } from './helpers/miniDom.js';

vi.mock('../utils/liveWebSocket', () => ({ liveWS: { connect: vi.fn(), disconnect: vi.fn() } }));
if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
}

const dom = installMiniDom();
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useF1Store } = await import('../store/useF1Store.js');
const { default: RaceControlPanel } = await import('../components/visualizations/RaceControlPanel.jsx');

const SRC = path.resolve(__dirname, '../components/visualizations/RaceControlPanel.jsx');
const INITIAL = useF1Store.getState();
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

const T0 = 1730047000;
const MESSAGES = Array.from({ length: 40 }, (_, i) => ({
  timestamp: T0 + i * 30,
  message: i % 4 === 0 ? `CAR ${i} TIME DELETED - TRACK LIMITS AT TURN 4` : i % 4 === 1 ? 'DRS ENABLED' : i % 4 === 2 ? 'YELLOW IN TRACK SECTOR 3' : `FIA STEWARDS: INCIDENT ${i} NOTED`,
  category: i % 4 === 1 ? 'Drs' : i % 4 === 2 ? 'Flag' : 'Other',
  flag: i % 4 === 2 ? 'YELLOW' : undefined,
  lap: 1 + Math.floor(i / 2),
}));

async function mount(width = 720, height = 420) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width, height });
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(RaceControlPanel)); });
  return {
    host,
    rows: () => [...host.querySelectorAll('.rc-row')],
    async click(el) { await act(async () => { dom.mouse(el, 'click'); }); },
    async unmount() { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

describe('the panel source', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  it('no scroll, no colour literal, no hex-alpha suffix, no fixed pixel font size', () => {
    expect(src).not.toMatch(/overflow[XY]?:\s*'(auto|scroll)'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/rgba\(\s*\d/);
    expect(src).not.toMatch(/\}(26|20|30|33|55|88)`/);
    expect(src).not.toMatch(/fontSize:\s*'?\d/);
  });

  it('every category glyph is different (the colour is never the only cue)', async () => {
    // the glyphs as drawn in the filter chips
    useF1Store.setState({
      ...INITIAL, isLiveMode: true, sessionData: { lap_times: [] }, trackStatus: [],
      raceControlMessages: [
        { timestamp: T0, message: 'X', category: 'Flag' },
        { timestamp: T0 + 1, message: 'X', category: 'Drs' },
        { timestamp: T0 + 2, message: 'X', category: 'SafetyCar' },
        { timestamp: T0 + 3, message: 'X', category: 'CarEvent' },
        // no feed category: classified from the text
        { timestamp: T0 + 4, message: '5 SECOND TIME PENALTY' },
        { timestamp: T0 + 5, message: 'INCIDENT UNDER INVESTIGATION' },
        { timestamp: T0 + 6, message: 'X', category: 'Other' },
      ],
    });
    const view = await mount();
    const chips = [...view.host.querySelectorAll('button[aria-pressed]')].filter((b) => !/auto-play|radio|dnfs/i.test(text(b)) && !text(b).startsWith('All'));
    const glyphs = chips.map((b) => text(b.querySelector('span')));
    expect(glyphs.length).toBe(7);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    await view.unmount();
  });
});

describe('the feed is paged, never scrolled', () => {
  it('a short panel: the newest messages that fit, the pager walks every message', async () => {
    useF1Store.setState({
      ...INITIAL, isLiveMode: true, sessionData: { lap_times: [] }, trackStatus: [], raceControlMessages: MESSAGES,
    });
    const view = await mount(720, 300);
    const first = view.rows();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(MESSAGES.length);
    // newest first
    expect(text(first[0])).toContain(MESSAGES[MESSAGES.length - 1].message);
    const seen = [];
    for (let guard = 0; guard < 40; guard++) {
      seen.push(...view.rows().map((r) => text(r)));
      const older = [...view.host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Older messages');
      if (older.hasAttribute('disabled')) break;
      await view.click(older);
    }
    expect(seen).toHaveLength(MESSAGES.length);
    // a flag row carries its label (the colour is not the only cue)
    expect(seen.filter((t) => t.includes('Yellow'))).toHaveLength(MESSAGES.filter((m) => m.flag === 'YELLOW').length);
    const all = [view.host, ...view.host.querySelectorAll('*')];
    expect(all.filter((el) => /auto|scroll/.test(`${el.style.overflow || ''}${el.style.overflowY || ''}${el.style['overflow-y'] || ''}`))).toEqual([]);
    await view.unmount();
  });

  it('a tall panel shows every message without a pager', async () => {
    useF1Store.setState({
      ...INITIAL, isLiveMode: true, sessionData: { lap_times: [] }, trackStatus: [], raceControlMessages: MESSAGES.slice(0, 5),
    });
    const view = await mount(720, 600);
    expect(view.rows()).toHaveLength(5);
    expect(view.host.querySelector('.rc-pager')).toBeNull();
    await view.unmount();
  });
});

// The feed sends penalty and stewards lines with Category "Other" and the
// keyword in the text, but the panel kept a known category before reading
// the text, so those lines never reached Penalty / Stewards
describe('"Other" messages are classified from their text', () => {
  it('a penalty and a stewards line in "Other" get their category, chip and glyph; a plain "Other" line stays Other', async () => {
    useF1Store.setState({
      ...INITIAL, isLiveMode: true, sessionData: { lap_times: [] }, trackStatus: [],
      raceControlMessages: [
        { timestamp: T0, message: 'FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 1 (VER) - CAUSING A COLLISION', category: 'Other' },
        { timestamp: T0 + 30, message: 'FIA STEWARDS: TURN 4 INCIDENT INVOLVING CARS 16 (LEC) AND 55 (SAI) UNDER INVESTIGATION', category: 'Other' },
        { timestamp: T0 + 60, message: 'CAR 44 (HAM) TIME 1:32.123 DELETED - TRACK LIMITS AT TURN 4', category: 'Other' },
        { timestamp: T0 + 90, message: 'DRS ENABLED', category: 'Drs' },
      ],
    });
    const view = await mount(720, 600);
    const chip = (label) => [...view.host.querySelectorAll('button[aria-pressed]')].find((b) => text(b).replace(/\s*\d+$/, '').endsWith(label));
    for (const [label, glyph] of [['Penalty', 'P'], ['Stewards', '⚖'], ['Other', '·'], ['DRS', 'D']]) {
      const b = chip(label);
      expect(b, label).toBeTruthy();
      expect(text(b), label).toBe(`${glyph}${label}1`);
    }
    const glyphOf = (needle) => {
      const row = view.rows().find((r) => text(r).includes(needle));
      return row.querySelector('span[title]').getAttribute('title');
    };
    expect(glyphOf('TIME PENALTY')).toBe('Penalty');
    expect(glyphOf('UNDER INVESTIGATION')).toBe('Stewards');
    expect(glyphOf('TRACK LIMITS')).toBe('Other');
    // the Penalty filter shows the penalty line only
    await view.click(chip('Penalty'));
    expect(view.rows().map((r) => text(r))).toEqual([expect.stringContaining('TIME PENALTY')]);
    await view.unmount();
  });
});
