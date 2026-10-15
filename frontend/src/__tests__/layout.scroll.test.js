// V5: every scrollable area of the frontend (overflow auto / scroll / overlay
// in the CSS or in an inline style) has its justification row, with the
// design constraint, in docs/SCROLL_JUSTIFICATIONS.md; the doc no longer
// claims zoom / pan that the code does not have; the dashboard's own chrome
// (layout lane) has no scroll left that the doc does not name.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrollInventory } from './helpers/scrollInventory.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/SCROLL_JUSTIFICATIONS.md'), 'utf8');
const { areas, stale } = scrollInventory(ROOT);

// Files of the layout lane: a stale row naming one of them is an error here
// (other files may lose a scroll area in a parallel change before the doc
// follows; the inventory script lists those rows as STALE)
const LAYOUT_FILES = /^(base|dashboard|components|visualizations|tokens)\.css |^(CommandBar|CommandPalette|ShortcutCheatsheet|ShortcutHints)\.css |^(DockedLayout|PitWallLayout|OverlayPanel|BottomTabBar|TimelinePlayer|WeatherBar)\.jsx:/;

describe('scroll inventory against docs/SCROLL_JUSTIFICATIONS.md', () => {
  it('finds the scroll areas (the inventory works)', () => {
    expect(areas.length).toBeGreaterThan(5);
    expect(areas.some((a) => a.key === 'dashboard.css .overlay-panel__content')).toBe(true);
  });

  it('every scroll area has a justification row', () => {
    const missing = areas.filter((a) => !a.row).map((a) => `${a.file}:${a.line} \`${a.key}\` ${a.decl}`);
    expect(missing).toEqual([]);
  });

  it('no row of the layout lane names a scroll area that no longer exists', () => {
    expect(stale.filter((k) => LAYOUT_FILES.test(k))).toEqual([]);
  });

  it('every justification row states a design constraint (non-empty last cell)', () => {
    const rows = DOC.split(/\r?\n/).filter((l) => /^\|.*`[^`]+`.*\|$/.test(l) && !/^\|\s*-/.test(l));
    for (const r of rows.filter((l) => l.split('|').length >= 6)) {
      const cells = r.split('|').slice(1, -1).map((c) => c.trim());
      expect(cells[cells.length - 1].length, r).toBeGreaterThan(30);
    }
  });
});

describe('the doc tells the truth about the layout', () => {
  it('names d3.zoom only for the Track Map, the one view that has it', () => {
    const src = path.join(ROOT, 'frontend/src/components/visualizations');
    const withZoom = fs.readdirSync(src).filter((f) => /d3\.zoom\(/.test(fs.readFileSync(path.join(src, f), 'utf8')));
    expect(withZoom).toEqual(['TrackMap.jsx']);
    expect(DOC).toMatch(/only the Track Map has d3\.zoom/);
    expect(DOC).not.toMatch(/D3 pan\/zoom allows horizontal navigation/);
  });

  it('the page-scroll fallback it once described is gone from the CSS', () => {
    const base = fs.readFileSync(path.join(ROOT, 'frontend/src/styles/base.css'), 'utf8');
    const dash = fs.readFileSync(path.join(ROOT, 'frontend/src/styles/dashboard.css'), 'utf8');
    expect(base).not.toMatch(/@media \(max-width: 1440px\), \(max-height: 900px\)/);
    expect(dash).not.toMatch(/@media \(max-width: 1440px\), \(max-height: 900px\)/);
    expect(DOC).toMatch(/It was removed on\s+2026-10-15/);
  });

  it('the dashboard chrome has no unexplained scroll: dock, docked panes, timeline legend, weather bar', () => {
    const keys = areas.map((a) => a.key);
    for (const k of ['dashboard.css .bottom-tab-bar', 'dashboard.css .timeline-player__legend', 'dashboard.css .weather-bar__center']) {
      expect(keys).not.toContain(k);
    }
    expect(keys.filter((k) => k.startsWith('DockedLayout.jsx'))).toEqual([]);
  });
});
