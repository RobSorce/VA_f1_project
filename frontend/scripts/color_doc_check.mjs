#!/usr/bin/env node
/**
 * Every hex colour written in docs/COLOR_ENCODING.md is a colour of the code:
 * a literal of frontend/src/utils/colors.js (the palette module, with the
 * constant and key that hold it) or a token of the dark theme in
 * frontend/src/styles/tokens.css (:root). A computed colour (a teammate
 * tint, a lifted mark, a context mix) is not a literal, so the document
 * describes it by its rule and the script output that prints it, never by a
 * hex of its own.
 *
 * Usage (from frontend/):
 *   node scripts/color_doc_check.mjs              print the report and write docs/evidence/color_doc_hex.txt
 *   node scripts/color_doc_check.mjs --out FILE   write FILE instead
 * Exit code 1 when a hex of the document is not in the code.
 *
 * __tests__/colors.doc.test.js runs the same check with the test suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const DOC = path.join(ROOT, 'docs/COLOR_ENCODING.md');
export const COLORS = path.join(ROOT, 'frontend/src/utils/colors.js');
export const TOKENS = path.join(ROOT, 'frontend/src/styles/tokens.css');
const EVIDENCE = path.join(ROOT, 'docs/evidence/color_doc_hex.txt');

const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;
const norm = (h) => {
  let x = h.slice(1).toUpperCase();
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return `#${x}`;
};

/** Literal colours of colors.js: hex -> ['NAME.key', ...]. */
export function paletteLiterals(src = fs.readFileSync(COLORS, 'utf8')) {
  const out = new Map();
  let current = null;
  for (const line of src.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    // a palette constant: a top-level UPPER_CASE const; any other top-level
    // declaration (a function, a helper const) holds no palette literal
    const decl = /^(?:export )?(?:const|let|function|async function)\s+(\w+)/.exec(code);
    if (decl) current = /^[A-Z][A-Z0-9_]*$/.test(decl[1]) ? decl[1] : null;
    if (!current) continue;
    for (const m of code.matchAll(/(?:([\w$]+|'[^']+'|\d+)\s*:\s*)?'(#[0-9a-fA-F]{3,8})'/g)) {
      const key = m[1] ? m[1].replace(/'/g, '') : null;
      const name = key ? `${current}.${key}` : current;
      const h = norm(m[2]);
      if (!out.has(h)) out.set(h, []);
      out.get(h).push(name);
    }
  }
  return out;
}

/** Dark-theme tokens of tokens.css (the :root block): hex -> ['--token', ...]. */
export function darkTokens(src = fs.readFileSync(TOKENS, 'utf8')) {
  const out = new Map();
  const start = src.indexOf(':root {');
  const end = src.indexOf('\n}', start);
  const block = src.slice(start, end);
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const h = norm(m[2]);
    if (!out.has(h)) out.set(h, []);
    out.get(h).push(m[1]);
  }
  return out;
}

/** The report: one line per distinct hex of the document. */
export function checkDoc(doc = fs.readFileSync(DOC, 'utf8')) {
  const palette = paletteLiterals();
  const tokens = darkTokens();
  const seen = new Map();
  doc.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HEX)) {
      const h = norm(m[0]);
      if (!seen.has(h)) seen.set(h, { hex: h, written: m[0], firstLine: i + 1, count: 0 });
      seen.get(h).count += 1;
    }
  });
  const rows = [...seen.values()].map((r) => ({
    ...r,
    palette: palette.get(r.hex) || [],
    tokens: tokens.get(r.hex) || [],
  }));
  const missing = rows.filter((r) => !r.palette.length && !r.tokens.length);
  return { rows, missing };
}

export function renderReport({ rows, missing }) {
  const L = [];
  L.push('Hex colours of docs/COLOR_ENCODING.md against the code (frontend/scripts/color_doc_check.mjs)');
  L.push('code: literals of frontend/src/utils/colors.js and the dark-theme tokens (:root) of frontend/src/styles/tokens.css');
  L.push('');
  for (const r of rows) {
    const where = [...r.palette, ...r.tokens].join(', ') || 'NOT IN THE CODE';
    L.push(`${r.hex}  line ${String(r.firstLine).padStart(3)}  x${r.count}  ${where}`);
  }
  L.push('');
  L.push(`${rows.length} distinct hex colours in the document, ${missing.length} not in the code`);
  L.push(`RESULT: ${missing.length ? `FAIL (${missing.map((r) => r.hex).join(', ')})` : 'PASS'}`);
  return L.join('\n');
}

function main(argv) {
  const rep = checkDoc();
  const text = renderReport(rep);
  process.stdout.write(`${text}\n`);
  const i = argv.indexOf('--out');
  const out = i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : EVIDENCE;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${text}\n`);
  if (rep.missing.length) process.exitCode = 1;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (!process.env.VITEST && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2));
}
