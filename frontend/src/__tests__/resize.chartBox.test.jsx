// The one hook every D3 view sizes itself with
// (utils/views/chartBox.js useChartBox) and its helpers:
//  - measures the box the chart's svg fills (its parent's content box) when
//    the svg appears, then follows every resize through a ResizeObserver,
//    coalesced to one state update per animation frame;
//  - follows an svg that mounts later or moves to another container, stops
//    observing (and drops a pending frame) on unmount;
//  - contentBox / chartSize / svgScreenScale: the sizes a chart lays out at
//    and the scale its labels are divided by.
import { describe, it, expect, afterAll } from 'vitest';
import { installMiniDom } from './helpers/miniDom.js';

const dom = installMiniDom();
const React = (await import('react')).default;
const { act, useRef, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { installResizeObserverMock } = await import('./helpers/chartFixtures.js');
const {
  useChartBox, chartSize, contentBox, svgScreenScale,
} = await import('../utils/views/chartBox.js');

const ro = installResizeObserverMock();
afterAll(() => ro.uninstall());

const h = React.createElement;
const settle = () => act(async () => { ro.flushFrames(); });

// A chart stand-in: the svg in one of two containers, or not mounted yet
let renders = 0;
let lastBox = null;
let setWhere = null;
function Probe() {
  const svgRef = useRef(null);
  const [where, setW] = useState('a');
  setWhere = setW;
  const box = useChartBox(svgRef);
  renders += 1;
  lastBox = box;
  const svg = h('svg', { ref: svgRef, style: { width: '100%', height: '100%' } });
  return h('div', null,
    h('div', { id: 'box-a' }, where === 'a' ? svg : null),
    h('div', { id: 'box-b' }, where === 'b' ? svg : null));
}

async function mountProbe() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  dom.setRect(host, { left: 0, top: 0, width: 800, height: 450 });
  const root = createRoot(host);
  await act(async () => { root.render(h(Probe)); });
  await settle();
  return { host, root };
}

describe('useChartBox: the box of a D3 view, kept up to date', () => {
  let probe;

  it('measures the svg\'s container when it mounts', async () => {
    probe = await mountProbe();
    expect(lastBox).toEqual({ width: 800, height: 450 });
    const a = probe.host.querySelector('#box-a');
    expect(ro.watched(a)).toBe(true);
  });

  it('a burst of resizes in one frame: one update, at the last size', async () => {
    const a = probe.host.querySelector('#box-a');
    const before = renders;
    await act(async () => {
      ro.notify(a, 700, 400);
      ro.notify(a, 650, 380);
      ro.notify(a, 612.7, 344.9);
    });
    // nothing until the frame
    expect(lastBox).toEqual({ width: 800, height: 450 });
    expect(ro.pendingFrames()).toBe(1);
    await settle();
    expect(lastBox).toEqual({ width: 612, height: 344 });
    expect(renders - before).toBe(1);
  });

  it('the same size again: no update', async () => {
    const a = probe.host.querySelector('#box-a');
    const before = renders;
    await act(async () => { ro.notify(a, 612.2, 344.1); });
    await settle();
    expect(renders - before).toBe(0);
  });

  it('follows the svg into another container', async () => {
    const b = probe.host.querySelector('#box-b');
    dom.setRect(b, { left: 0, top: 0, width: 320, height: 200 });
    await act(async () => { setWhere('b'); });
    await settle();
    expect(lastBox).toEqual({ width: 320, height: 200 });
    expect(ro.watched(b)).toBe(true);
    expect(ro.watched(probe.host.querySelector('#box-a'))).toBe(false);
    await act(async () => { ro.notify(b, 300, 180); });
    await settle();
    expect(lastBox).toEqual({ width: 300, height: 180 });
  });

  it('unmount: the observer is disconnected and a pending frame dropped', async () => {
    const b = probe.host.querySelector('#box-b');
    await act(async () => { ro.notify(b, 280, 170); });
    expect(ro.pendingFrames()).toBe(1);
    await act(async () => { probe.root.unmount(); });
    expect(ro.watched(b)).toBe(false);
    expect(ro.pendingFrames()).toBe(0);
    probe.host.remove();
  });
});

describe('contentBox, chartSize, svgScreenScale', () => {
  it('contentBox: the layout box less padding, floored; 0 x 0 without an element', () => {
    const el = dom.document.createElement('div');
    dom.setRect(el, { width: 401.8, height: 250.5 });
    expect(contentBox(el)).toEqual({ width: 401, height: 250 });
    el.style.setProperty('padding-left', '8px');
    el.style.setProperty('padding-right', '8px');
    el.style.setProperty('padding-top', '4px');
    expect(contentBox(el)).toEqual({ width: 385, height: 246 });
    expect(contentBox(null)).toEqual({ width: 0, height: 0 });
  });

  it('chartSize: the observed box, else the container now, else the fallback', () => {
    const parent = dom.document.createElement('div');
    const svg = dom.document.createElementNS(dom.SVG_NS, 'svg');
    parent.appendChild(svg);
    expect(chartSize(svg, { width: 0, height: 0 }, { width: 600, height: 250 })).toEqual({ width: 600, height: 250 });
    dom.setRect(parent, { width: 520, height: 300 });
    expect(chartSize(svg, { width: 0, height: 0 }, { width: 600, height: 250 })).toEqual({ width: 520, height: 300 });
    expect(chartSize(svg, { width: 480, height: 270 }, { width: 600, height: 250 })).toEqual({ width: 480, height: 270 });
  });

  it('svgScreenScale: rendered size over viewBox (meet), 1 when unknown', () => {
    const parent = dom.document.createElement('div');
    const svg = dom.document.createElementNS(dom.SVG_NS, 'svg');
    parent.appendChild(svg);
    expect(svgScreenScale(svg)).toBe(1);
    svg.setAttribute('viewBox', '0 0 1000 560');
    expect(svgScreenScale(svg)).toBe(1); // no layout
    dom.setRect(parent, { width: 600, height: 400 });
    expect(svgScreenScale(svg)).toBeCloseTo(0.6, 10);
    dom.setRect(parent, { width: 1000, height: 280 });
    expect(svgScreenScale(svg)).toBeCloseTo(0.5, 10);
    expect(svgScreenScale(null)).toBe(1);
  });
});

describe('every D3 view sizes itself with useChartBox (source)', () => {
  it.each([
    'TrackMap', 'ChampionshipChart', 'ChampionshipStandings', 'LapDeltaChart', 'PCABiplot', 'TireDegradation',
    'RaceSituationMap', 'PositionByLap', 'StrategyTimeline', 'TyreManagement', 'TyreHealth', 'TelemetryStrip',
    'SectorsBestChart',
  ])('%s', async (name) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, `../components/visualizations/${name}.jsx`), 'utf8');
    expect(src).toMatch(/useChartBox\(/);
    // no view keeps its own observer or a size read once at its first draw
    expect(src).not.toMatch(/new ResizeObserver\(/);
    expect(src).not.toMatch(/parentElement\.getBoundingClientRect\(\)|const container = svgRef\.current\.parentElement/);
  });
});
