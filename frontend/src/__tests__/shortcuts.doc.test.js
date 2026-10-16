// docs/SHORTCUTS.md is the code. Its generated block is the output of
// scripts/shortcuts_table.mjs, which sends every key combination to the real
// handler (hooks/useKeyboardShortcuts.js) and compares the cheatsheet and the
// command palette's key labels with what the handler does.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  shortcutsReport, renderMarkdown, blockOf, DOC, comboOfLabel, comboName,
} from '../../scripts/shortcuts_table.mjs';

const report = shortcutsReport();

describe('the shortcuts document is generated from the handler', () => {
  it('the block in docs/SHORTCUTS.md equals the script output', () => {
    const block = blockOf(fs.readFileSync(DOC, 'utf8'));
    expect(block, 'markers missing').not.toBeNull();
    // after changing a shortcut: npx vite-node scripts/shortcuts_table.mjs --write (from frontend/)
    expect(block).toBe(renderMarkdown(report).trim());
  });

  it('the number keys open the ten views of the handler, in this order', () => {
    const effectOf = (name) => report.rows.find((r) => r.keys.includes(name))?.effect;
    expect(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map(effectOf)).toEqual([
      'open Lap Times', 'open Tyres', 'open Strategy Timeline', 'open Sectors & Speeds', 'open Race Prediction',
      'open Analytics (PCA)', 'open AI Strategist', 'open Driver Compare', 'open Consistency', 'open Championship',
    ]);
  });

  it('the keys the old document left out are in the table: Shift+H, Ctrl+Alt+D, /, [ and ], Shift+P', () => {
    const names = report.rows.flatMap((r) => r.keys);
    for (const k of ['Shift+H', 'Ctrl+Alt+D', 'Shift+P']) expect(names).toContain(k);
    expect(report.local.flatMap((l) => l.keys)).toEqual(expect.arrayContaining(['[', ']', '/']));
  });

  it('labels are read as the keys they name', () => {
    expect(comboName(comboOfLabel('⇧P'))).toBe('Shift+P');
    expect(comboName(comboOfLabel('Ctrl+Alt+D'))).toBe('Ctrl+Alt+D');
    expect(comboName(comboOfLabel('Space'))).toBe('Space');
    expect(comboName(comboOfLabel('D'))).toBe('D');
  });
});
