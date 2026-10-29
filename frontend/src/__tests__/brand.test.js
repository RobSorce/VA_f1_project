// The product's name, its logo, its trade-mark notice and its fonts: the name
// is one constant (utils/brand.js) that index.html's <title> repeats and that
// names the logo image (components/ui/Wordmark.jsx, the files of
// public/brand) on the start screen, in the top bar, the session menu and
// Settings > About; the brand files carry no metadata and every icon link of
// index.html names a file; the notice is on the start screen, in Settings >
// About and in the README word for word; the fonts are self-hosted (no font
// service is asked), each with its licence; no Formula 1 font or logo file is
// shipped.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { APP_NAME, APP_TAGLINE, TRADEMARK_NOTICE } from '../utils/brand.js';
import { listFiles } from './helpers/layoutCss.js';
import { logosIn } from './helpers/logo.js';

// Server rendering reads getServerState: point it at the live state
vi.mock('zustand', async (importOriginal) => {
  const orig = await importOriginal();
  const bind = (createState) => {
    const api = orig.createStore(createState);
    api.getServerState = api.getState;
    const useBound = (selector, equalityFn) => orig.useStore(api, selector, equalityFn);
    Object.assign(useBound, api);
    return useBound;
  };
  return { ...orig, create: (createState) => (createState ? bind(createState) : bind) };
});
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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(SRC, '..');
const ROOT = path.resolve(FRONTEND, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const oneLine = (s) => s.replace(/\s+/g, ' ');

describe('the name and the logo', () => {
  it('index.html\'s <title> is APP_NAME', () => {
    expect(read(path.join(FRONTEND, 'index.html'))).toMatch(new RegExp(`<title>${APP_NAME}</title>`));
  });

  it('no component or helper writes the name: the logo image reads APP_NAME', () => {
    const offenders = listFiles(SRC, ['.js', '.jsx'])
      .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`) && path.basename(f) !== 'brand.js')
      .filter((f) => read(f).includes(APP_NAME))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
    expect(read(path.join(SRC, 'components/ui/Wordmark.jsx'))).toMatch(/role="img" aria-label=\{APP_NAME\}/);
  });

  it('the start screen keeps exactly one h1: the hero logo with its tagline', async () => {
    const { default: SessionSelectorScreen } = await import('../components/ui/SessionSelectorScreen.jsx');
    const start = renderToString(React.createElement(SessionSelectorScreen));
    expect(start.match(/<h1\b/g)).toHaveLength(1);
    const h1 = start.match(/<h1 class="session-screen__title">([\s\S]*?)<\/h1>/);
    expect(h1).toBeTruthy();
    const logos = logosIn(h1[1]);
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ size: 'hero', tagline: APP_TAGLINE });
    expect(logos[0].image['aria-label']).toBe(APP_NAME);
    expect(logos[0].imgs.map((i) => path.basename(i.src))).toEqual(['variante_intro_primary_dark.svg', 'variante_intro_primary_light.svg']);
  });

  it('the weather bar and the header show the header logo, no tagline', async () => {
    const { default: WeatherBar } = await import('../components/ui/WeatherBar.jsx');
    const { default: Header } = await import('../components/ui/Header.jsx');
    for (const [name, Comp, cls] of [['WeatherBar', WeatherBar, 'weather-bar__wordmark'], ['Header', Header, 'header-wordmark']]) {
      const html = renderToString(React.createElement(Comp));
      // the bar's own logo, and the session menu's (the bar holds the menu)
      const logos = logosIn(html);
      const own = logos.filter((l) => l.classes.includes(cls));
      expect(own, name).toHaveLength(1);
      expect(own[0].classes, name).toEqual(['wordmark', 'wordmark--header', cls]);
      expect(own[0].image['aria-label'], name).toBe(APP_NAME);
      expect(own[0].imgs.map((i) => path.basename(i.src)), name).toEqual(['variante_primary_dark.svg', 'variante_primary_light.svg']);
      expect(logos.map((l) => [l.size, l.tagline]), name).toEqual(logos.map(() => ['header', null]));
      expect(html, name).not.toContain(APP_TAGLINE);
    }
  });

  it('the session menu\'s title is the header logo', async () => {
    const { default: SessionMenu } = await import('../components/ui/SessionMenu.jsx');
    const html = renderToString(React.createElement(SessionMenu, { isOpen: true, onClose: () => {} }));
    const title = html.match(/<div class="session-menu__title">([\s\S]*?)<\/div>/);
    expect(title).toBeTruthy();
    const logos = logosIn(title[1]);
    expect(logos).toHaveLength(1);
    expect(logos[0]).toMatchObject({ size: 'header', tagline: null });
    expect(logos[0].image['aria-label']).toBe(APP_NAME);
  });

  it('the brand files carry no <metadata>', () => {
    const files = [...listFiles(path.join(FRONTEND, 'public/brand'), ['.svg']), path.join(FRONTEND, 'public/favicon.svg')];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) expect(read(f), path.relative(FRONTEND, f)).not.toMatch(/<metadata\b/i);
  });

  it('every icon link of index.html names a file of public/, root-relative (the build adds its base)', () => {
    const html = read(path.join(FRONTEND, 'index.html'));
    const links = [...html.matchAll(/<link\b([^>]*)>/g)].map((m) => Object.fromEntries(
      [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    )).filter((l) => /\b(icon|apple-touch-icon)\b/.test(l.rel));
    expect(links.map((l) => [l.rel, l.href, l.type ?? null, l.sizes ?? null])).toEqual([
      ['icon', '/favicon.ico', null, 'any'],
      ['icon', '/favicon.svg', 'image/svg+xml', null],
      ['icon', '/favicon-32.png', 'image/png', '32x32'],
      ['icon', '/favicon-16.png', 'image/png', '16x16'],
      ['apple-touch-icon', '/apple-touch-icon.png', null, null],
    ]);
    for (const l of links) expect(fs.existsSync(path.join(FRONTEND, 'public', l.href)), l.href).toBe(true);
  });

  it('the README\'s title is the logo: the dark file for a dark scheme, the light one otherwise', () => {
    const readme = read(path.join(ROOT, 'README.md'));
    const pic = readme.match(/<picture>([\s\S]*?)<\/picture>/);
    expect(pic).toBeTruthy();
    expect(readme.indexOf(pic[0])).toBeLessThan(readme.indexOf('\n## '));
    expect(pic[1]).toMatch(/<source media="\(prefers-color-scheme: dark\)" srcset="frontend\/public\/brand\/variante_primary_dark\.svg" \/>/);
    expect(pic[1]).toMatch(new RegExp(`<img src="frontend/public/brand/variante_primary_light\\.svg" alt="${APP_NAME}"`));
    for (const f of ['variante_primary_dark.svg', 'variante_primary_light.svg']) {
      expect(fs.existsSync(path.join(FRONTEND, 'public/brand', f)), f).toBe(true);
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

  it('no Formula 1 font or logo file in public/ (the brand files are the app\'s own)', () => {
    const files = listFiles(path.join(FRONTEND, 'public'), ['.ttf', '.otf', '.woff', '.woff2', '.png', '.jpg', '.svg', '.webp'])
      .map((f) => path.relative(path.join(FRONTEND, 'public'), f));
    expect(files.filter((f) => /formula1|logo/i.test(f))).toEqual([]);
  });
});

describe('Settings > About', () => {
  it('its title is the header logo, over the tagline', async () => {
    // mounted in the mini DOM: the About section opens on a click
    const { installMiniDom } = await import('./helpers/miniDom.js');
    const dom = installMiniDom();
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { useF1Store } = await import('../store/useF1Store.js');
    const { default: SettingsTabContent } = await import('../components/tabs/SettingsTabContent.jsx');
    useF1Store.setState({ fetchSeasons: vi.fn(async () => {}) });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(SettingsTabContent)); });
    const about = [...host.querySelectorAll('.settings-tab__section-header')]
      .find((b) => b.querySelector('.settings-tab__section-title').textContent === 'About');
    expect(about).toBeTruthy();
    await act(async () => { dom.mouse(about, 'click'); });
    const title = host.querySelector('.settings-tab__about-title');
    expect(title).toBeTruthy();
    const logos = [...title.querySelectorAll('.wordmark')];
    expect(logos).toHaveLength(1);
    expect(logos[0].getAttribute('class')).toBe('wordmark wordmark--header');
    const image = logos[0].querySelector('[role="img"]');
    expect(image.getAttribute('aria-label')).toBe(APP_NAME);
    expect([...image.querySelectorAll('img')].map((i) => path.basename(i.getAttribute('src'))))
      .toEqual(['variante_primary_dark.svg', 'variante_primary_light.svg']);
    expect(logos[0].querySelector('.wordmark__tagline')).toBeNull();
    expect(host.querySelector('.settings-tab__about-subtitle').textContent).toBe(APP_TAGLINE);
    await act(async () => { root.unmount(); });
  });
});
