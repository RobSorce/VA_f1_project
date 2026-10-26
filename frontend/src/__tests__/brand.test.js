// The product's name, its trade-mark notice and its fonts: the name is one
// constant (utils/brand.js) that index.html's <title> repeats; the notice is
// on the start screen, in Settings > About and in the README word for word;
// the fonts are self-hosted (no font service is asked), each with its
// licence; no Formula 1 font or logo file is shipped.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME, TRADEMARK_NOTICE } from '../utils/brand.js';
import { listFiles } from './helpers/layoutCss.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(SRC, '..');
const ROOT = path.resolve(FRONTEND, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const oneLine = (s) => s.replace(/\s+/g, ' ');

describe('the name', () => {
  it('index.html\'s <title> is APP_NAME', () => {
    expect(read(path.join(FRONTEND, 'index.html'))).toMatch(new RegExp(`<title>${APP_NAME}</title>`));
  });

  it('no component or helper writes the name: they read APP_NAME', () => {
    const offenders = listFiles(SRC, ['.js', '.jsx'])
      .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`) && path.basename(f) !== 'brand.js')
      .filter((f) => read(f).includes(APP_NAME))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
    for (const f of ['components/ui/WeatherBar.jsx', 'components/ui/SessionMenu.jsx',
      'components/ui/SessionSelectorScreen.jsx', 'components/tabs/SettingsTabContent.jsx']) {
      expect(read(path.join(SRC, f)), f).toMatch(/\{APP_NAME\}/);
    }
  });
});

describe('the trade-mark notice', () => {
  it('on the start screen and in Settings > About', () => {
    for (const f of ['components/ui/SessionSelectorScreen.jsx', 'components/tabs/SettingsTabContent.jsx']) {
      expect(read(path.join(SRC, f)), f).toMatch(/\{TRADEMARK_NOTICE\}/);
    }
  });

  it('in the README, word for word', () => {
    expect(oneLine(read(path.join(ROOT, 'README.md')))).toContain(TRADEMARK_NOTICE);
  });
});

describe('the fonts', () => {
  const css = listFiles(SRC, ['.css']).map((f) => [f, read(f)]);
  const html = read(path.join(FRONTEND, 'index.html'));

  it('no stylesheet, script or page asks a font service', () => {
    const remote = /fonts\.(googleapis|gstatic)\.com|@import\s+url\(\s*['"]?https?:/;
    expect(remote.test(html)).toBe(false);
    for (const [f, text] of css) expect(remote.test(text), path.relative(SRC, f)).toBe(false);
    for (const f of listFiles(SRC, ['.js', '.jsx']).filter((x) => !x.includes(`${path.sep}__tests__${path.sep}`))) {
      expect(/fonts\.(googleapis|gstatic)\.com/.test(read(f)), path.relative(SRC, f)).toBe(false);
    }
  });

  it('every @font-face names a file of public/, with the licence next to it', () => {
    const tokens = read(path.join(SRC, 'styles/tokens.css'));
    const urls = [...tokens.matchAll(/@font-face\s*\{[^}]*src:\s*url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u, u).toMatch(/^\/fonts\/[^/]+\/[^/]+\.woff2$/);
      const file = path.join(FRONTEND, 'public', u);
      expect(fs.existsSync(file), u).toBe(true);
      expect(read(path.join(path.dirname(file), 'OFL.txt')), u).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    }
    expect(new Set(urls.map((u) => u.split('/')[2]))).toEqual(new Set(['inter', 'jetbrains-mono']));
  });

  it('no Formula 1 font and no logo image in public/', () => {
    const files = listFiles(path.join(FRONTEND, 'public'), ['.ttf', '.otf', '.woff', '.woff2', '.png', '.jpg', '.svg', '.webp'])
      .map((f) => path.relative(path.join(FRONTEND, 'public'), f));
    expect(files.filter((f) => /formula1|logo/i.test(f))).toEqual([]);
  });
});
