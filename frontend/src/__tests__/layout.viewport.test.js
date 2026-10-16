// The dashboard is a fixed-viewport layout at the four target
// sizes (1536x750, 1366x768, 1920x1080, 2048x1100): the page never scrolls,
// the chrome rows leave the panels their room, the Pit Wall cannot grow a row
// to its content, every pane of every window preset has a box, and floating
// overlays fit between the weather bar and the dock. Static model from the
// CSS and the layout components (helpers/layoutModel.js); a browser pass
// checks the views inside.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VIEWPORTS, loadCss, pageScrollRules, shellAt, pitWallSpec, pitWallAt, dockedPanesAt, px,
} from './helpers/layoutModel.js';
import { parseCss } from './helpers/layoutCss.js';
import { WINDOW_PRESETS } from '../utils/windowPresets.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const css = loadCss(SRC);
const spec = pitWallSpec(SRC);
const dashRules = parseCss(read('styles/dashboard.css'));

describe('the page never scrolls (V13 target 1)', () => {
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: html, body, .app-container and .app-body stay overflow hidden, the shell 100vh`, () => {
      expect(pageScrollRules(css, vp)).toEqual([]);
    });
  }

  it('no @media rule anywhere switches the shell to page scroll or auto height', () => {
    const offenders = [];
    for (const [file, rules] of [['styles/base.css', parseCss(read('styles/base.css'))], ['styles/dashboard.css', dashRules]]) {
      for (const r of rules) {
        if (!r.media) continue;
        const sels = r.selector.split(',').map((s) => s.trim());
        if (!sels.some((s) => ['html', 'body', '.app-container', '.app-body'].includes(s))) continue;
        for (const d of r.decls) {
          if (/^overflow/.test(d.prop) || d.prop === 'height' || d.prop === 'min-height') offenders.push(`${file}:${d.line} ${r.selector} ${d.prop}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('base.css: html and body overflow hidden, body exactly the viewport', () => {
    const rules = parseCss(read('styles/base.css'));
    const htmlBody = rules.find((r) => !r.media && r.selector === 'html, body');
    expect(htmlBody.decls.find((d) => d.prop === 'overflow').value).toBe('hidden');
    const body = rules.filter((r) => !r.media && r.selector === 'body').pop();
    expect(body.decls.find((d) => d.prop === 'height').value).toBe('100vh');
  });
});

describe('chrome rows and the app body at each target viewport', () => {
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: weather bar + timeline + dock take at most 18 % of the height`, () => {
      const s = shellAt(css, vp);
      for (const v of [s.weather, s.timeline, s.dock, s.dockMargin]) expect(Number.isFinite(v)).toBe(true);
      expect(s.chrome / vp.H).toBeLessThanOrEqual(0.18);
      // the expanded timeline still leaves most of the window to the panels
      expect(s.bodyExpanded).toBeGreaterThan(vp.H * 0.65);
    });
  }

  it('the timeline and the dock read the shell tokens (no fixed pixel heights)', () => {
    const rules = dashRules.filter((r) => !r.media);
    const decl = (sel, prop) => rules.filter((r) => r.selector === sel).flatMap((r) => r.decls).filter((d) => d.prop === prop).pop()?.value;
    expect(decl('.timeline-player.collapsed', 'height')).toBe('var(--timeline-height)');
    expect(decl('.timeline-player.expanded', 'height')).toBe('calc(var(--timeline-height) + var(--timeline-expanded-extra))');
    expect(decl('.bottom-tab-bar', 'height')).toBe('var(--bottom-tab-height)');
    expect(decl('.weather-bar', 'height')).toBe('var(--weather-bar-height)');
    expect(decl('.utility-overlay-container', 'inset')).toBe('var(--overlay-inset-top) 20px var(--overlay-inset-bottom) 20px');
  });

  // The hover-expanded event strip pushed the body up by 104 px, so
  // every view re-laid out while the user scrubbed; it now opens over the body
  it('the expanded timeline opens over the body: the body keeps its height', () => {
    const rules = dashRules.filter((r) => !r.media);
    const decl = (sel, prop) => rules.filter((r) => r.selector === sel).flatMap((r) => r.decls).filter((d) => d.prop === prop).pop()?.value;
    expect(decl('.timeline-player.expanded', 'margin-top')).toBe('calc(-1 * var(--timeline-expanded-extra))');
    for (const vp of VIEWPORTS) {
      const s = shellAt(css, vp);
      expect(s.bodyExpanded, vp.name).toBe(s.body);
    }
  });
});

// The assistant button (fixed, bottom 76 px) covered 12-24 px of the
// timeline row and the end of its status text. It now sits in the dock row,
// in the gutter the dock pill leaves free on its right.
describe('the assistant button stays in the dock row, clear of the dock pill', () => {
  const fab = read('components/ui/GeminiFloatingButton.jsx');
  const style = fab.slice(fab.indexOf('const fabStyle = {'), fab.indexOf('};', fab.indexOf('const fabStyle = {')));
  const rules = dashRules.filter((r) => !r.media);
  const dockMax = rules.filter((r) => r.selector === '.bottom-tab-bar').flatMap((r) => r.decls).filter((d) => d.prop === 'max-width').pop()?.value;

  it('placed from the dock tokens, not a fixed bottom offset', () => {
    expect(style).toMatch(/bottom: 'calc\(var\(--dock-margin\) \+ \(var\(--bottom-tab-height\) - var\(--assistant-button-size\)\) \/ 2\)'/);
    expect(style).toMatch(/right: 16,/);
    expect(style).toMatch(/width: 'var\(--assistant-button-size\)'/);
    expect(dockMax).toBe('calc(100vw - 2 * var(--dock-side-gutter))');
  });

  for (const vp of VIEWPORTS) {
    it(`${vp.name}: inside the dock row (below the timeline row) and right of the dock pill`, () => {
      const s = shellAt(css, vp);
      const size = px(css, '--assistant-button-size', vp);
      const gutter = px(css, '--dock-side-gutter', vp);
      const bottom = s.dockMargin + (s.dock - size) / 2;
      const top = bottom + size; // px from the window's bottom edge
      const timelineLow = s.dockMargin + s.dock;
      const fabLeft = vp.W - 16 - size;
      const dockRight = vp.W / 2 + (vp.W - 2 * gutter) / 2; // widest the centred pill can be
      console.log(`${vp.name}: button ${bottom.toFixed(1)}-${top.toFixed(1)} px from the bottom, timeline row from ${timelineLow.toFixed(1)} px; x ${fabLeft}-${vp.W - 16}, dock pill ends at x <= ${dockRight}`);
      expect(bottom).toBeGreaterThanOrEqual(s.dockMargin);
      expect(top).toBeLessThanOrEqual(timelineLow);
      expect(fabLeft).toBeGreaterThan(dockRight);
    });
  }
});

describe('Pit Wall: no cell can grow past the window', () => {
  it('every cell of the grid has overflow hidden and min-height 0 (a 1fr track is then minmax(0, 1fr))', () => {
    expect(spec.columns).toBe('480px 1fr');
    expect(spec.rows).toBe('44px 1fr 35vh');
    for (const name of ['layoutStyle', 'sidebarStyle', 'mainStyle', 'bottomRowStyle', 'sideColumnStyle']) {
      const i = spec.code.indexOf(`const ${name} = {`);
      expect(i).toBeGreaterThan(-1);
      const block = spec.code.slice(i, spec.code.indexOf('};', i));
      expect(block).toMatch(/overflow: 'hidden'/);
      expect(block).toMatch(/minHeight: 0/);
    }
    // the pace grid, track map and circle cells
    expect(spec.code.match(/<div style=\{\{ overflow: 'hidden', minHeight: 0 \}\}>/g)).toHaveLength(3);
  });

  for (const vp of VIEWPORTS) {
    it(`${vp.name}: the pace-grid row and the map row both have room, and 20 tower rows fit with no focus driver`, () => {
      const pw = pitWallAt(css, spec, vp);
      expect(pw.middle).toBeGreaterThan(200);
      expect(pw.bottom).toBeGreaterThanOrEqual(0.35 * vp.H - 0.5);
      expect(pw.mapW).toBeGreaterThan(280);
      // the tower fits its rows to its body (fitRows): ROW_MAX px each while
      // they fit, down to ROW_MIN
      const tower = read('components/visualizations/TimingTower.jsx');
      const rowH = Number(tower.match(/const ROW_MAX = (\d+);/)[1]);
      expect(tower).toMatch(/fitRows\(bodyBox\.height, entries\.length, \{ rowMin: ROW_MIN, rowMax: ROW_MAX/);
      expect(tower).toMatch(/height: rowH,/);
      // header and column header of the tower: at most 64 px
      expect(Math.floor((pw.body - 64) / rowH)).toBeGreaterThanOrEqual(20);
    });
  }

  it('the focus cards sit side by side and open collapsed below 900 px of viewport height', () => {
    const code = spec.code;
    expect(code).toContain("const SHORT_VIEWPORT = '(max-height: 899px)'");
    expect(code).toMatch(/useState\(!short\)/);
    const rules = dashRules;
    const cards = rules.find((r) => r.selector === '.pitwall-layout__focus-cards');
    expect(cards.decls.find((d) => d.prop === 'grid-auto-flow').value).toBe('column');
    const collapsed = rules.find((r) => r.selector.includes('.pitwall-layout__focus--collapsed .focus-widget > :not(.focus-widget__header)'));
    expect(collapsed.decls.find((d) => d.prop === 'display').value).toBe('none');
  });
});

describe('docked layouts: every pane of every window preset has a usable box', () => {
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: every preset pane is at least 400 x 180 px of content`, () => {
      for (const [key, preset] of Object.entries(WINDOW_PRESETS)) {
        for (const p of dockedPanesAt(css, preset.dockedLayout, vp)) {
          expect(p.width, `${key} ${p.tabs}`).toBeGreaterThanOrEqual(400);
          expect(p.height, `${key} ${p.tabs}`).toBeGreaterThanOrEqual(180);
        }
      }
    });
  }

  it('panes, splits and tab bars never scroll: no inline overflow auto left in DockedLayout', () => {
    const code = read('components/layout/DockedLayout.jsx');
    expect(code).not.toMatch(/overflow[XY]?: '(auto|scroll)'/);
    const rules = dashRules;
    for (const sel of ['.docked-layout', '.docked-split', '.docked-split__child', '.docked-pane', '.docked-pane__tabs', '.docked-pane__content']) {
      const r = rules.find((x) => !x.media && x.selector === sel);
      expect(r, sel).toBeTruthy();
      expect(r.decls.find((d) => d.prop === 'overflow')?.value, sel).toBe('hidden');
    }
  });
});

describe('floating overlays fit between the weather bar and the bottom chrome', () => {
  const overlay = read('components/layout/OverlayPanel.jsx');
  const minH = Number(overlay.match(/const MIN_H = (\d+)/)[1]);
  for (const vp of VIEWPORTS) {
    it(`${vp.name}: the overlay layer holds a minimum panel even with the timeline expanded`, () => {
      const s = shellAt(css, vp);
      expect(vp.H - s.overlayTop - s.overlayBottomExpanded).toBeGreaterThanOrEqual(minH + 16);
    });
  }
});
