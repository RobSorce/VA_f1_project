// The measurement scripts of this folder print their report; teeToEvidence
// also writes it, line for line, to docs/evidence/<name> (or to the file given
// after --out), the tracked output the docs and code comments cite.
// docs/evidence/README.md lists every output and the script that writes it.
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/evidence');

/** Copy everything console.log prints from now on into the evidence file. */
export function teeToEvidence(name) {
  const i = process.argv.indexOf('--out');
  const file = i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(EVIDENCE_DIR, name);
  const lines = [];
  const log = console.log;
  console.log = (...args) => { log(...args); lines.push(util.format(...args)); };
  process.on('exit', () => {
    if (!lines.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
  });
  return file;
}
