// V12 (verifier): the demo bundle requested /f1-logo.png and /team-logos/*
// from the origin root, which 404s on GitHub Pages (base /VA_f1_project/).
// Every file of public/ is now referenced through publicAsset (the build's
// base); this test keeps root-relative public paths out of the components.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicAsset } from '../utils/publicAsset.js';
import { listFiles } from './helpers/layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.resolve(SRC, '../public');

describe('public assets go through the build base', () => {
  it('publicAsset joins the base and the path inside public/', () => {
    const base = import.meta.env.BASE_URL || '/';
    expect(publicAsset('f1-logo.png')).toBe(`${base}f1-logo.png`);
    expect(publicAsset('/team-logos/mclaren.png')).toBe(`${base}team-logos/mclaren.png`);
  });

  it('no component or helper names a public file by a root-relative path', () => {
    const tops = fs.readdirSync(PUBLIC).map((f) => f.replace(/[.]/g, '\\.'));
    const re = new RegExp(`["'\`]/(?:${tops.join('|')})`);
    const offenders = listFiles(SRC, ['.js', '.jsx'])
      .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`))
      .filter((f) => re.test(fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
