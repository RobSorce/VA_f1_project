// Test helper (V5): the inventory of every scrollable area of the frontend
// and the justification rows of docs/SCROLL_JUSTIFICATIONS.md. Shared by
// __tests__/layout.scroll.test.js and
// notes/experiments/v13_audit/overflow_inventory.mjs.
//
// An area is any overflow / overflow-x / overflow-y set to auto | scroll |
// overlay, in the CSS (frontend/src/**/*.css) or in an inline style of the
// .jsx / .js sources (React style objects, D3 .style('overflow', ...)). Each
// has a stable key, which the "Inventory key" column of the doc names:
//   CSS key:  <file basename> <selector>          e.g. `dashboard.css .settings-tab`
//   JS key:   <file basename>:<enclosing name>#<k> e.g. `TimingTower.jsx:bodyStyle#1`
//             (enclosing name = the nearest top-level `const X = {` style
//             object or function above the hit; k counts the hits under it)

import fs from 'node:fs';
import path from 'node:path';
import { listFiles, parseCssFile, mediaMatches, VIEWPORTS } from './layoutCss.js';

const SCROLL = /\b(auto|scroll|overlay)\b/;

export function cssAreas(src, root) {
  const out = [];
  for (const file of listFiles(src, ['.css'])) {
    for (const r of parseCssFile(file)) {
      for (const d of r.decls) {
        if (!/^overflow(-x|-y)?$/.test(d.prop) || !SCROLL.test(d.value)) continue;
        const live = VIEWPORTS.filter((vp) => mediaMatches(r.media, vp)).map((vp) => vp.name);
        out.push({
          kind: 'css',
          key: `${path.basename(file)} ${r.selector}`,
          file: path.relative(root, file).replace(/\\/g, '/'),
          line: d.line,
          decl: `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`,
          media: r.media,
          live,
        });
      }
    }
  }
  return out;
}

// The nearest top-level (column 0) declaration above the hit: a module style
// object (`const bodyStyle = {`) or the component / function itself.
function enclosingName(lines, idx) {
  for (let k = idx; k >= 0; k--) {
    const m = lines[k].match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)(\w+)/);
    if (m) return m[1];
  }
  return 'module';
}

export function jsAreas(src, root) {
  const out = [];
  const reStyle = /\boverflow([XY])?\s*:\s*['"`](auto|scroll|overlay)['"`]/g;
  const reD3 = /\.style\(\s*['"]overflow(-x|-y)?['"]\s*,\s*['"](auto|scroll|overlay)['"]/g;
  for (const file of listFiles(src, ['.jsx', '.js'])) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const counter = new Map();
    lines.forEach((ln, idx) => {
      if (/^\s*(\/\/|\*)/.test(ln)) return;
      for (const re of [reStyle, reD3]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(ln))) {
          const name = enclosingName(lines, idx);
          const k = (counter.get(name) || 0) + 1;
          counter.set(name, k);
          out.push({
            kind: 'js',
            key: `${path.basename(file)}:${name}#${k}`,
            file: path.relative(root, file).replace(/\\/g, '/'),
            line: idx + 1,
            decl: m[0].replace(/^\./, ''),
            media: null,
            live: VIEWPORTS.map((vp) => vp.name),
          });
        }
      }
    });
  }
  return out;
}

/** Map inventory key -> the doc row's first cell (the area's name). */
export function docKeys(docFile) {
  if (!fs.existsSync(docFile)) return new Map();
  const text = fs.readFileSync(docFile, 'utf8');
  const keys = new Map();
  let header = null;
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim().startsWith('|')) { header = null; continue; }
    const cells = ln.split('|').slice(1, -1).map((c) => c.trim());
    if (!header) { header = cells.map((c) => c.toLowerCase()); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const col = header.indexOf('inventory key');
    if (col < 0) continue;
    for (const m of cells[col].matchAll(/`([^`]+)`/g)) keys.set(m[1], cells[0]);
  }
  return keys;
}

/** Every area with its justification (or null), plus the doc rows naming no area. */
export function scrollInventory(root) {
  const src = path.join(root, 'frontend/src');
  const doc = path.join(root, 'docs/SCROLL_JUSTIFICATIONS.md');
  const areas = [...cssAreas(src, root), ...jsAreas(src, root)];
  const keys = docKeys(doc);
  const inv = new Set(areas.map((a) => a.key));
  return {
    areas: areas.map((a) => ({ ...a, row: keys.get(a.key) || null })),
    keys,
    stale: [...keys.keys()].filter((k) => !inv.has(k)),
  };
}
