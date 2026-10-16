// In a full run, with every worker busy, the async tests
// that mount a view or read the stylesheets took 3.5-4.7 s (the Circle of
// Doom fill 4.7 s, the Sectors best chart's labels before and after a resize
// 4.4 s, the pit-window label of the palette check 3.9 s, the Leaderboard's
// fitted rows 3.5 s), at the edge of Vitest's 5 s default. Giving a timeout to
// the slowest ones left the others on the default: the config now gives
// every test without its own timeout 20 s.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import viteConfig from '../../vite.config.js';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('The default test timeout', () => {
  it('vite.config.js gives every test 20 s', () => {
    const cfg = viteConfig({ mode: 'test', command: 'serve' });
    expect(cfg.test.testTimeout).toBe(20000);
  });

  it('Vitest reads vite.config.js: no vitest.config.* or workspace file takes its place', () => {
    expect(fs.readdirSync(FRONTEND).filter((f) => /^vitest\.(config|workspace)\./.test(f))).toEqual([]);
  });
});
