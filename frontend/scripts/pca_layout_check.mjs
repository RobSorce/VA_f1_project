#!/usr/bin/env node
/**
 * Layout check of the PCA views in a real browser, on the static demo build:
 * the loading labels of the PCA Biplot and the rows and g axis of the
 * Cross-Race Analysis panel's Differences tab, measured in the DOM in the
 * states of use case UC2 (docs/USE_CASES.md: 2024 R16, "Skip to end", "This
 * race", colour "Finish"; the lassos of the one-stoppers and of the
 * two-or-more-stoppers; the PIA + NOR pair), at the owner's window sizes.
 *
 *   npm run build:demo            (DEMO_BASE=/ or any base: read from dist/index.html)
 *   node scripts/pca_layout_check.mjs [--dist DIR] [--chrome PATH] [--sizes 1536x864,1920x1080,2048x1152] [--out FILE]
 *
 * Writes docs/evidence/pca_layout_check.txt (or FILE) and prints it; exit
 * code 1 when a check fails. The browser is Chrome / Chromium in headless
 * mode, driven over the DevTools protocol on a pipe (no package needed):
 * --chrome, else $CHROME_PATH, else the first one found among the usual
 * install paths. The build is served the way GitHub Pages serves it
 * (scripts/serve_dist_check.mjs). The dashboard is driven as a user drives
 * it: selects and clicks on the start screen, the key 6, clicks on the
 * toggles, a Shift+drag lasso and clicks on stars with the mouse.
 *
 * Measured (CSS px, getBoundingClientRect):
 *  - biplot: every loading label drawn; overlap of two labels = the area of
 *    their intersection over the smaller label's area; a label over a point
 *    = any intersection with the point's mark; labels shown only on hover /
 *    keyboard focus (no room), and the leader lines;
 *  - Differences: the share of each row's "above random", no-interval and
 *    random-|g| lines inside the row; the g axis of the head against every
 *    row's strip (left edge and width); the pager.
 * A label of an older build that keeps its labels with the arrows
 * (.pca-arrows text) is measured the same way, so --dist can point at a
 * build of any commit.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DIST = path.resolve(opt('--dist', path.join(FRONTEND, 'dist')));
const OUT = path.resolve(opt('--out', path.join(FRONTEND, '../docs/evidence/pca_layout_check.txt')));
const SIZES = opt('--sizes', '1536x864,1920x1080,2048x1152').split(',').map((s) => s.split('x').map(Number));

const lines = [];
const failures = [];
const log = (s = '') => { lines.push(s); console.log(s); };
const check = (ok, what) => { if (!ok) failures.push(what); return ok; };

// ── Browser ───────────────────────────────────────────────────────────

function findChrome() {
  const given = opt('--chrome', process.env.CHROME_PATH || '');
  if (given) return given;
  const candidates = [];
  for (const root of ['/opt/pw-browsers', path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      candidates.push(path.join(root, d, 'chrome-linux/chrome'), path.join(root, d, 'chrome-linux64/chrome'));
    }
  }
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return found;
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { /* next */ }
  }
  return null;
}

/** Chrome on a DevTools pipe (fd 3 in, fd 4 out, messages ending in NUL). */
function launch(chromePath) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-layout-'));
  const proc = spawn(chromePath, [
    '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars', '--mute-audio', `--user-data-dir=${profile}`,
    // Chrome refuses to run as root with its sandbox (containers, CI)
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const toChrome = proc.stdio[3];
  const fromChrome = proc.stdio[4];
  let nextId = 1;
  const pending = new Map();
  let buf = '';
  let stderr = '';
  proc.stdio[2].on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });
  const fail = (why) => {
    for (const { reject } of pending.values()) reject(new Error(`${why}\n${stderr}`));
    pending.clear();
  };
  proc.on('exit', (code) => fail(`Chrome exited (${code})`));
  toChrome.on('error', () => fail('the DevTools pipe closed'));
  fromChrome.on('error', () => fail('the DevTools pipe closed'));
  fromChrome.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)); else resolve(msg.result);
      }
    }
  });
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    toChrome.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
  const close = async () => {
    try { await send('Browser.close'); } catch { /* gone */ }
    proc.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  };
  return { send, close };
}

/** One page (tab) at width x height CSS px. */
async function openPage(browser, width, height) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  await send('Runtime.enable');
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const evaluate = (fn, ...fnArgs) => run(`(${fn})(...${JSON.stringify(fnArgs)})`);
  // a condition in the page (an element found counts as true)
  const waitFor = async (fn, what, timeout = 30000, ...fnArgs) => {
    const t0 = Date.now();
    for (;;) {
      const v = await run(`Boolean((${fn})(...${JSON.stringify(fnArgs)}))`);
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const key = async (k) => {
    const code = /^\d$/.test(k) ? `Digit${k}` : k;
    const vk = k.charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const close = () => browser.send('Target.closeTarget', { targetId });
  return { send, evaluate, waitFor, mouse, key, close };
}

// ── In-page helpers (run with Runtime.evaluate: no closure) ──────────

// Clicks the first element matching `sel` whose text contains `text` (or any, with text '')
function clickText(sel, text) {
  const el = [...document.querySelectorAll(sel)].find((e) => !text || e.textContent.includes(text));
  if (!el) return false;
  el.click();
  return true;
}

// Sets a <select> to `value` the way a user's choice does (React reads the change event)
function choose(index, value) {
  const s = document.querySelectorAll('select.session-screen__select')[index];
  if (!s || ![...s.options].some((o) => o.value === value)) return false;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, value);
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Resolves once the biplot and the panel have had no DOM change for `quiet` ms
function settle(quiet) {
  return new Promise((resolve) => {
    const roots = [document.querySelector('.analytics-tab')].filter(Boolean);
    let t;
    const done = () => { mo.disconnect(); resolve(true); };
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, quiet); });
    roots.forEach((r) => mo.observe(r, { childList: true, subtree: true, attributes: true }));
    t = setTimeout(done, quiet);
  });
}

// Screen geometry of the stars of the race on screen, above or below the
// horizontal line of the crosshair (PC2 = 0), and of the named drivers' stars
function starGeometry() {
  const svg = document.querySelector('.analytics-tab__scatterplot .viz-container > svg');
  const stars = [...svg.querySelectorAll('.pca-point--current')].map((s) => {
    const r = s.getBoundingClientRect();
    return { driver: s.__data__?.driver, x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  });
  const h = [...svg.querySelectorAll('line[stroke-dasharray="4,4"]')].find((l) => l.getAttribute('y1') === l.getAttribute('y2'));
  return { stars, lineY: h ? h.getBoundingClientRect().top : null };
}

function measureBiplot() {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const svg = document.querySelector('.analytics-tab__scatterplot .viz-container > svg');
  const all = [...svg.querySelectorAll('.pca-arrow-labels text, .pca-arrows text')];
  const shown = all.filter((t) => getComputedStyle(t).display !== 'none');
  const boxes = shown.map((t) => ({ label: t.textContent, ...R(t) }));
  const pairs = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = inter(boxes[i], boxes[j]);
      if (a > 0) pairs.push({ a: boxes[i].label, b: boxes[j].label, pct: (100 * a) / Math.min(boxes[i].w * boxes[i].h, boxes[j].w * boxes[j].h) });
    }
  }
  const points = [...svg.querySelectorAll('.pca-point')].map((p) => ({ driver: p.__data__?.driver, ...R(p) }));
  const onPoints = [];
  for (const b of boxes) for (const p of points) if (inter(b, p) > 0) onPoints.push({ label: b.label, driver: p.driver, pct: (100 * inter(b, p)) / (p.w * p.h) });
  return {
    labels: boxes.length,
    hoverOnly: all.filter((t) => !shown.includes(t)).map((t) => t.textContent),
    leaders: svg.querySelectorAll('.pca-arrow-leader').length,
    points: points.length,
    pairs,
    onPoints,
  };
}

function measureDifferences() {
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const inside = (el, row) => {
    if (!el) return null;
    const b = R(el);
    if (b.w * b.h === 0) return 0;
    const w = Math.max(0, Math.min(b.x + b.w, row.x + row.w) - Math.max(b.x, row.x));
    const h = Math.max(0, Math.min(b.y + b.h, row.y + row.h) - Math.max(b.y, row.y));
    return (w * h) / (b.w * b.h);
  };
  const axis = document.querySelector('.pca-forest-axis-svg');
  const ax = axis ? R(axis) : null;
  const rows = [...document.querySelectorAll('.pca-forest-row')].map((row) => {
    const rr = R(row);
    const cells = row.children;
    const numbers = [...cells[2].children];
    const strip = R(cells[1]);
    return {
      feature: cells[0].firstChild?.textContent,
      height: rr.h,
      above: inside(row.querySelector('.pca-above-random'), rr),
      noInterval: inside(row.querySelector('.pca-no-interval'), rr),
      random: inside(numbers.find((s) => /random/.test(s.textContent)), rr),
      label: inside(cells[0], rr),
      dLeft: ax ? strip.x - ax.x : null,
      dWidth: ax ? strip.w - ax.w : null,
    };
  });
  return { rows, pager: document.querySelector('.pca-pager span')?.textContent || 'no pager (every row on one page)' };
}

// ── Driving the dashboard ────────────────────────────────────────────

async function loadUc2(page, origin) {
  await page.send('Page.navigate', { url: origin });
  await page.waitFor(() => document.querySelectorAll('select.session-screen__select').length >= 2, 'the start screen');
  await page.waitFor(choose, 'season 2024', 30000, 0, '2024');
  await page.waitFor(choose, 'round 16', 30000, 1, '16');
  await page.evaluate(clickText, 'button.session-screen__pill', 'Race');
  await page.waitFor(() => !document.querySelector('.session-screen__btn')?.disabled, 'ENTER SESSION');
  await page.evaluate(clickText, 'button.session-screen__btn', '');
  await page.waitFor(() => !document.querySelector('.session-screen__btn') && document.querySelector('.timeline-player, button[title="Skip to end"]'), 'the session', 60000);
  await page.key('6');
  await page.waitFor(() => document.querySelector('.analytics-tab__toggle-btn'), 'the Analytics (PCA) view');
  await page.evaluate(clickText, '.analytics-tab__toggle-btn', 'PCA Biplot');
  await page.waitFor(() => document.querySelector('button[title="Skip to end"]'), 'Skip to end');
  await page.evaluate(clickText, 'button[title="Skip to end"]', '');
  await page.waitFor(() => [...document.querySelectorAll('[aria-label="Races drawn"] button')].some((b) => b.textContent.includes('This race') && !b.disabled), '"This race"');
  await page.evaluate(clickText, '[aria-label="Races drawn"] button', 'This race');
  await page.evaluate(clickText, '[aria-label="Colour encodes"] button', 'Finish');
  await page.waitFor(() => document.querySelectorAll('.pca-point--current').length >= 19, 'the 19 stars');
  await page.waitFor(() => /whole race/.test(document.querySelector('.pca-legends')?.textContent || ''), 'the post-race rows');
  await page.evaluate(settle, 1000);
}

async function lasso(page, side) {
  const { stars, lineY } = await page.evaluate(starGeometry);
  const group = stars.filter((s) => (side === 'above' ? s.y < lineY : s.y > lineY));
  const pad = 8;
  const x0 = Math.min(...group.map((s) => s.x - s.r)) - pad;
  const x1 = Math.max(...group.map((s) => s.x + s.r)) + pad;
  const y0 = side === 'above' ? Math.min(...group.map((s) => s.y - s.r)) - pad : lineY + 1;
  const y1 = side === 'above' ? lineY - 1 : Math.max(...group.map((s) => s.y + s.r)) + pad;
  const SHIFT = 8;
  const path = [[x1, y0], [x1, y1], [x0, y1], [x0, y0 + 1]];
  await page.mouse('mouseMoved', x0, y0, { modifiers: SHIFT });
  await page.mouse('mousePressed', x0, y0, { modifiers: SHIFT, button: 'left', buttons: 1, clickCount: 1 });
  let [px, py] = [x0, y0];
  for (const [qx, qy] of path) {
    for (let k = 1; k <= 8; k++) {
      await page.mouse('mouseMoved', px + ((qx - px) * k) / 8, py + ((qy - py) * k) / 8, { modifiers: SHIFT, button: 'left', buttons: 1 });
    }
    [px, py] = [qx, qy];
  }
  await page.mouse('mouseReleased', px, py, { modifiers: SHIFT, button: 'left', buttons: 0, clickCount: 1 });
  return group.length;
}

async function clickStar(page, driver) {
  const { stars } = await page.evaluate(starGeometry);
  const s = stars.find((v) => v.driver === driver);
  await page.mouse('mouseMoved', s.x, s.y);
  await page.mouse('mousePressed', s.x, s.y, { button: 'left', buttons: 1, clickCount: 1 });
  await page.mouse('mouseReleased', s.x, s.y, { button: 'left', buttons: 0, clickCount: 1 });
}

async function openDifferences(page, n) {
  await page.waitFor((k) => new RegExp(`N = ${k} selected`).test(document.querySelector('.pca-stats-banner')?.textContent || '')
    || [...document.querySelectorAll('button')].some((b) => b.textContent === 'Differences'), 'the analysis', 30000, n);
  await page.waitFor(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Differences'), 'the Differences tab');
  await page.evaluate(clickText, 'button', 'Differences');
  await page.waitFor((k) => document.querySelector('.pca-forest-row')
    && new RegExp(`N = ${k} selected`).test(document.querySelector('.pca-stats-banner')?.textContent || ''), 'the forest rows', 30000, n);
  await page.evaluate(settle, 1000);
}

// ── Report ────────────────────────────────────────────────────────────

const pct = (v) => (v == null ? '—' : `${(100 * v).toFixed(0)} %`);

function reportBiplot(tag, b) {
  log(`  biplot: ${b.labels} labels drawn, ${b.hoverOnly.length} on hover / focus only${b.hoverOnly.length ? ` (${b.hoverOnly.join(', ')})` : ''}, ${b.leaders} leader lines, ${b.points} points`);
  log(`    label / label overlaps: ${b.pairs.length ? b.pairs.map((p) => `${p.a} / ${p.b} ${p.pct.toFixed(0)} %`).join('; ') : 'none'}`);
  log(`    label / point overlaps: ${b.onPoints.length ? b.onPoints.map((p) => `${p.label} / ${p.driver} ${p.pct.toFixed(0)} % of the mark`).join('; ') : 'none'}`);
  check(b.pairs.length === 0, `${tag}: labels overlap`);
  check(b.onPoints.length === 0, `${tag}: a label covers a point`);
}

function reportDifferences(tag, d) {
  log(`  Differences: ${d.rows.length} rows on the first page, pager: ${d.pager}`);
  log('    row                        height  above random  no interval  random |g|  axis vs strip (left, width)');
  for (const r of d.rows) {
    log(`    ${String(r.feature).padEnd(26)} ${r.height.toFixed(1).padStart(6)}  ${pct(r.above).padStart(12)}  ${pct(r.noInterval).padStart(11)}  ${pct(r.random).padStart(10)}  ${r.dLeft == null ? '—' : `${r.dLeft.toFixed(2)}, ${r.dWidth.toFixed(2)}`}`);
    for (const k of ['above', 'noInterval', 'random', 'label']) {
      check(r[k] == null || r[k] > 0.999, `${tag}: ${r.feature} ${k} ${pct(r[k])} inside its row`);
    }
    check(r.dLeft != null && Math.abs(r.dLeft) < 0.5 && Math.abs(r.dWidth) < 1, `${tag}: ${r.feature} strip off the g axis`);
  }
}

async function main() {
  log('PCA layout check (frontend/scripts/pca_layout_check.mjs)');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`no build at ${DIST} (npm run build:demo)`);
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const asset = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).find((u) => /\/assets\//.test(u)) || '';
  const BASE = asset.slice(0, asset.indexOf('assets/'));
  if (!BASE.startsWith('/')) throw new Error('not a demo build (npm run build:demo)');
  const chromePath = findChrome();
  if (!chromePath) throw new Error('no Chrome / Chromium found: pass --chrome PATH or set CHROME_PATH');

  const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  };
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = url.startsWith(BASE) ? url.slice(BASE.length) : null;
    if (rel != null && (rel === '' || rel.endsWith('/'))) rel += 'index.html';
    const file = rel == null ? null : path.join(DIST, rel);
    if (!file || !file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}${BASE}`;
  const browser = launch(chromePath);
  const { product } = await browser.send('Browser.getVersion');
  log(`build: ${path.relative(path.join(FRONTEND, '..'), DIST) || DIST} (base ${BASE}); browser: ${product}, headless, device scale factor 1`);
  log('UC2 states: 2024 R16, Analytics (PCA) (key 6), "PCA Biplot", "Skip to end", "This race", colour "Finish", axes on');
  log('overlap of two labels = intersection area / the smaller label\'s area; "inside its row" = share of the line\'s box within the row\'s box');

  try {
    for (const [W, H] of SIZES) {
      const page = await openPage(browser, W, H);
      const tag = `${W}x${H}`;
      log('');
      log(`## ${W} x ${H} CSS px`);
      await loadUc2(page, origin);
      log('- no selection');
      reportBiplot(`${tag} no selection`, await page.evaluate(measureBiplot));

      for (const [side, name] of [['above', 'one-stoppers (lasso above the line)'], ['below', 'two-or-more-stoppers (lasso below the line)']]) {
        const n = await lasso(page, side);
        await openDifferences(page, n);
        log(`- ${name}: ${n} stars`);
        reportBiplot(`${tag} ${side}`, await page.evaluate(measureBiplot));
        reportDifferences(`${tag} ${side}`, await page.evaluate(measureDifferences));
        await page.evaluate(settle, 500);
      }

      await page.evaluate(clickText, '.analytics-tab__scatterplot button', 'Clear');
      await page.evaluate(settle, 500);
      await clickStar(page, 'PIA');
      await page.evaluate(settle, 500);
      await clickStar(page, 'NOR');
      await openDifferences(page, 2);
      log('- PIA + NOR (two clicks)');
      reportBiplot(`${tag} PIA+NOR`, await page.evaluate(measureBiplot));
      reportDifferences(`${tag} PIA+NOR`, await page.evaluate(measureDifferences));
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  log('');
  log(failures.length ? `RESULT: FAIL (${failures.length})\n${failures.map((f) => `  ${f}`).join('\n')}` : 'RESULT: PASS');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${lines.join('\n')}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
