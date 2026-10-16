// The playback speed keys broke above 4x. The timeline's speed pills
// offered 0.5x-50x, while the < and > keys and the palette's speed commands
// stepped through [0.25, 0.5, 1, 2, 4, 8] by indexOf(playSpeed): at 5x or
// more ">" jumped to 0.25x and "<" did nothing; the footer and Settings
// listed two more sets. Now every control offers one list
// (utils/playbackSpeed.js PLAYBACK_SPEEDS) and both keys step to the next
// listed speed from any current speed.
//
// "?" is labelled "open / close the shortcut cheatsheet", but while the
// cheatsheet was open the handler returned before reading it, so "?" only
// opened it. It now closes it too.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYBACK_SPEEDS, stepPlaybackSpeed } from '../utils/playbackSpeed.js';
import { installHandler } from '../../scripts/shortcuts_table.mjs';
import { createCommandRegistry } from '../components/CommandPalette/commandRegistry.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const key = (k) => ({ shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, key: k });
const speedSet = (r) => r.calls.find((c) => c.name === 'setPlaySpeed')?.args[0] ?? null;

// Speeds not in the list: older stored speeds (0.25x, 4x, 8x), in between, past both ends
const OFF_LIST = [0.25, 0.75, 3, 4, 8, 15, 100];

/** The expected step, by hand: the nearest listed speed on that side, null past the end. */
function expected(speed, dir) {
  const side = PLAYBACK_SPEEDS.filter((v) => (dir > 0 ? v > speed : v < speed));
  if (!side.length) return null;
  return dir > 0 ? side[0] : side[side.length - 1];
}

describe('One speed list, stepped from any speed', () => {
  it('the list is the timeline pills\' speeds, slowest first', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.5, 1, 2, 5, 10, 20, 50]);
  });

  it('from every listed speed: ">" to the next one, "<" to the previous one, nothing past either end', () => {
    PLAYBACK_SPEEDS.forEach((sp, i) => {
      expect(stepPlaybackSpeed(sp, 1), `> at ${sp}x`).toBe(PLAYBACK_SPEEDS[i + 1] ?? null);
      expect(stepPlaybackSpeed(sp, -1), `< at ${sp}x`).toBe(PLAYBACK_SPEEDS[i - 1] ?? null);
    });
  });

  it('from a speed not in the list: the nearest listed speed on that side', () => {
    for (const sp of OFF_LIST) {
      expect(stepPlaybackSpeed(sp, 1), `> at ${sp}x`).toBe(expected(sp, 1));
      expect(stepPlaybackSpeed(sp, -1), `< at ${sp}x`).toBe(expected(sp, -1));
    }
    expect(stepPlaybackSpeed(5, 1)).toBe(10); // the reported case: 5x went to 0.25x
    expect(stepPlaybackSpeed(50, -1)).toBe(20); // and "<" did nothing
    expect(stepPlaybackSpeed(undefined, 1)).toBe(2); // not a number: from 1x
    expect(stepPlaybackSpeed(null, 1)).toBe(2); // missing: from 1x, not 0x
    expect(stepPlaybackSpeed(null, -1)).toBe(0.5);
    expect(stepPlaybackSpeed(0, 1)).toBe(2); // not a speed: from 1x
  });

  it('the < and > keys and the palette\'s speed commands step alike, from every listed and unlisted speed', () => {
    const h = installHandler();
    try {
      const reg = createCommandRegistry();
      const up = reg.find((c) => c.id === 'speed-up');
      const down = reg.find((c) => c.id === 'speed-down');
      for (const sp of [...PLAYBACK_SPEEDS, ...OFF_LIST]) {
        expect(speedSet(h.probe(key('>'), { playSpeed: sp })), `> at ${sp}x`).toBe(stepPlaybackSpeed(sp, 1));
        expect(speedSet(h.probe(key('<'), { playSpeed: sp })), `< at ${sp}x`).toBe(stepPlaybackSpeed(sp, -1));
        expect(speedSet(h.record(() => up.action(), { playSpeed: sp })), `speed-up at ${sp}x`).toBe(stepPlaybackSpeed(sp, 1));
        expect(speedSet(h.record(() => down.action(), { playSpeed: sp })), `speed-down at ${sp}x`).toBe(stepPlaybackSpeed(sp, -1));
      }
      // walking ">" from the slowest visits every pill once, then stops
      const walk = [];
      for (let sp = PLAYBACK_SPEEDS[0]; sp != null && walk.length < 20; sp = speedSet(h.probe(key('>'), { playSpeed: sp }))) walk.push(sp);
      expect(walk).toEqual([...PLAYBACK_SPEEDS]);
    } finally {
      h.restore();
    }
  });

  it('every speed control offers the shared list (no speed list of its own)', () => {
    for (const rel of ['components/ui/TimelinePlayer.jsx', 'components/tabs/SettingsTabContent.jsx', 'components/ui/Footer.jsx']) {
      const src = read(rel);
      expect(src, rel).toMatch(/PLAYBACK_SPEEDS\.map\(/);
      expect(src, rel).not.toMatch(/\[\s*0\.25?\s*,\s*[\d.]+\s*,/);
      expect(src, rel).not.toMatch(/<option value=\{[\d.]+\}>/);
    }
    for (const rel of ['hooks/useKeyboardShortcuts.js', 'components/CommandPalette/commandRegistry.js']) {
      const src = read(rel);
      expect(src, rel).toMatch(/stepPlaybackSpeed\(/);
      expect(src, rel).not.toMatch(/speeds\.indexOf/);
    }
  });
});

describe('"?" opens and closes the cheatsheet', () => {
  it('closed: "?" toggles it open; open: "?" closes it, other keys still do nothing', () => {
    const h = installHandler();
    try {
      expect(h.probe(key('?'), { cheatsheetOpen: false }).calls.map((c) => c.name)).toEqual(['toggleCheatsheet']);
      const open = h.probe(key('?'), { cheatsheetOpen: true });
      expect(open.calls.map((c) => c.name)).toEqual(['closeCheatsheet']);
      expect(open.prevented).toBe(true);
      expect(h.probe(key('s'), { cheatsheetOpen: true }).calls).toEqual([]);
      expect(h.probe(key('>'), { cheatsheetOpen: true }).calls).toEqual([]);
    } finally {
      h.restore();
    }
  });
});
