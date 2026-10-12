import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHART_HELP } from '../utils/chartHelp.js';
import { FALLBACK_PIT_LOSS } from '../utils/pitLoss.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = fs.readFileSync(path.resolve(HERE, '../App.jsx'), 'utf8');

/** Every string of the help registry, flattened. */
function helpStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => helpStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => helpStrings(v, out));
  return out;
}

const PIT_LOSS = /pit[- ]?loss|pit window|pit stops? appear/i;
// a number of seconds, e.g. "22 s", "~22s", "18 s"
const SECONDS = /~?\b(\d+(?:\.\d+)?)\s*s\b/g;

describe('help text claims no hard-coded pit-loss value', () => {
  it('chartHelp: a pit-loss sentence quotes no seconds except the labelled fallback', () => {
    const offenders = [];
    for (const text of helpStrings(CHART_HELP)) {
      if (!PIT_LOSS.test(text)) continue;
      for (const m of text.matchAll(SECONDS)) {
        const isFallback = Number(m[1]) === FALLBACK_PIT_LOSS.median && /fallback/i.test(text);
        if (!isFallback) offenders.push(text);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('chartHelp: the undercut entry explains the measured pit loss and the fallback', () => {
    const text = helpStrings(CHART_HELP.undercut).join(' ');
    expect(text).toMatch(/green-flag stops/);
    expect(text).toMatch(/in-lap \+ out-lap minus twice the driver's green-flag median lap/);
    expect(text).toContain(`${FALLBACK_PIT_LOSS.median} s fallback`);
    expect(text).toContain('"fallback"');
    expect(text).not.toMatch(/default 22|Monaco|Singapore/);
  });

  it('chartHelp: the strategy entry explains the per-stop labels', () => {
    const text = helpStrings(CHART_HELP.strategy).join(' ');
    expect(text).toMatch(/Stint column/);
    expect(text).toMatch(/"est"/);
    expect(text).toMatch(/"fallback"/);
  });

  it('App.jsx overlay help: the undercut entry no longer claims "~22s"', () => {
    const line = APP_SOURCE.split('\n').find((l) => /^\s*undercut:\s*\{/.test(l));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/~\s*\d+\s*s\b/);
    expect(line).toMatch(/green-flag stops/);
    // the only number is the fallback constant, interpolated and labelled
    expect(line).toContain('${FALLBACK_PIT_LOSS.median} s fallback');
    expect(line).toContain('"fallback"');
    expect([...line.matchAll(SECONDS)].map((m) => m[0])).toEqual([]);
  });
});
