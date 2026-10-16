// docs/COLOR_ENCODING.md writes only colours of the code. Every hex in it
// is a literal of utils/colors.js or a dark-theme token of styles/tokens.css
// (scripts/color_doc_check.mjs, output docs/evidence/color_doc_hex.txt); a
// computed colour (a teammate tint, a lifted mark) is described by its rule.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { checkDoc, DOC } from '../../scripts/color_doc_check.mjs';
import { CVD_MIN_DELTA_E, CONTEXT_FLOOR, TEAMMATE_DASHES } from '../utils/colors.js';

const doc = fs.readFileSync(DOC, 'utf8');

describe('the colour document is the palette module', () => {
  it('every hex of the document is a literal of colors.js or a token of tokens.css', () => {
    const { rows, missing } = checkDoc(doc);
    expect(rows.length).toBeGreaterThan(20);
    expect(missing.map((r) => `${r.written} (line ${r.firstLine})`)).toEqual([]);
  });

  it('states the contrast rule and the colour-vision rule with the constants of the code', () => {
    expect(doc).toMatch(/Text >= 4\.5:1 \(SC 1\.4\.3\)/);
    expect(doc).toMatch(/>= 3:1 \(SC 1\.4\.11\)/);
    expect(CVD_MIN_DELTA_E).toBe(10);
    expect(doc).toMatch(/at least 10 under all four vision types \(`CVD_MIN_DELTA_E`\)/);
    expect(CONTEXT_FLOOR).toEqual({ text: 3, mark: 2 });
    expect(doc).toMatch(/at least 3:1 for its text and 2:1 for its marks \(`CONTEXT_FLOOR`/);
    expect(TEAMMATE_DASHES.slice(1)).toEqual(['6,3', '8,3,2,3']);
    expect(doc).toMatch(/dashed 6,3/);
    expect(doc).toMatch(/dash-dot 8,3,2,3/);
  });

  it('the mid-season team change is stated as the cross-view check prints it', () => {
    const out = fs.readFileSync(new URL('../../../docs/evidence/cross_view_styles.txt', import.meta.url), 'utf8');
    expect(out).toMatch(/2025_1_R loaded: session drivers drawn differently in the championship 2/);
    expect(doc).toMatch(/with Australia 2025 loaded 2/);
    expect(doc).not.toMatch(/a driver looks the same in every view/);
  });
});
