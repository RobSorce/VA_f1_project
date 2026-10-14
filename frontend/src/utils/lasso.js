import * as d3 from 'd3';

/**
 * Point-in-polygon test (ray casting).
 * @param {[number, number]} point
 * @param {Array<[number, number]>} polygon - vertices (closing edge implied)
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const TRANSLATE_RE = /translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)/;

/**
 * Area of the lasso's background rect in the group's own coordinates: the
 * outer svg's viewBox shifted back by the translate of the group and of every
 * ancestor up to the svg, so a shift-drag can start anywhere on the chart.
 * Only translate transforms are undone (the plot groups use nothing else).
 * Null when the svg has no viewBox.
 *
 * @param {SVGGElement} groupNode
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
export function captureExtent(groupNode) {
  const svg = groupNode?.ownerSVGElement;
  const vb = (svg?.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || !vb.every(Number.isFinite)) return null;
  let tx = 0;
  let ty = 0;
  for (let n = groupNode; n && n !== svg; n = n.parentNode) {
    const m = TRANSLATE_RE.exec(n.getAttribute?.('transform') || '');
    if (m) {
      tx += Number(m[1]);
      ty += Number(m[2] || 0);
    }
  }
  return { x: vb[0] - tx, y: vb[1] - ty, width: vb[2], height: vb[3] };
}

/**
 * Attach a shift+drag lasso to a plot group (a translated <g> inside the svg).
 *
 * The pointer is measured in the group's own coordinates (d3.drag container =
 * the group), the space getPoints() returns its marks in, so the polygon
 * drawn and the polygon tested are where the pointer went whatever the
 * group's translate and the svg's viewBox scaling. A transparent background
 * rect (class 'lasso-capture', first child of the group, under every mark)
 * receives a shift-drag that starts on empty plot area. The outline is drawn
 * with straight segments: what the user sees is the polygon that is tested.
 * A shift-click with no drag changes nothing.
 *
 * @param {d3.Selection} group - the plot group (its marks are positioned in it)
 * @param {object} opts
 * @param {Function} opts.getPoints - () => [{x, y, id}] in the group's coordinates
 * @param {Function} opts.onSelect - (selectedIds) => void
 * @param {string} [opts.className] - CSS class for lasso path
 * @param {{x: number, y: number, width: number, height: number}} [opts.extent] -
 *   background rect in the group's coordinates (default: captureExtent)
 * @returns {Function} cleanup function
 */
export function attachLasso(group, { getPoints, onSelect, className = 'lasso-path', extent = null }) {
  let lassoPath = null;
  let lassoPoints = [];

  const area = extent || captureExtent(group.node());
  const capture = area
    ? group.insert('rect', ':first-child')
      .attr('class', 'lasso-capture')
      .attr('x', area.x).attr('y', area.y)
      .attr('width', area.width).attr('height', area.height)
      .attr('fill', 'none')
      .attr('pointer-events', 'all')
    : null;

  const lineGen = d3.line();

  const drag = d3.drag()
    // Shift + primary button only: plain clicks and drags stay with the marks
    .filter((event) => event.shiftKey && !event.ctrlKey && !event.button)
    // The group itself (default: its parent, the svg, whose origin is the
    // margin away from the marks' origin)
    .container(function container() { return this; })
    // Always the pointer, never the datum of the group
    .subject((event) => ({ x: event.x, y: event.y }))
    .on('start', function onStart(event) {
      if (lassoPath) lassoPath.interrupt().remove();
      lassoPoints = [[event.x, event.y]];
      lassoPath = d3.select(this)
        .append('path')
        .attr('class', className)
        .attr('pointer-events', 'none')
        .attr('d', lineGen(lassoPoints));
    })
    .on('drag', (event) => {
      lassoPoints.push([event.x, event.y]);
      if (lassoPath) lassoPath.attr('d', `${lineGen(lassoPoints)}Z`);
    })
    .on('end', () => {
      const path = lassoPath;
      lassoPath = null;
      if (lassoPoints.length < 3) {
        if (path) path.remove();
        return;
      }

      // Test each point against the lasso polygon
      const selectedIds = getPoints()
        .filter((p) => pointInPolygon([p.x, p.y], lassoPoints))
        .map((p) => p.id);

      onSelect(selectedIds);

      // Fade out lasso path
      if (path) {
        path
          .transition()
          .duration(800)
          .style('opacity', 0)
          .remove();
      }
    });

  group.call(drag);

  return () => {
    group.on('.drag', null);
    if (capture) capture.remove();
    if (lassoPath) lassoPath.interrupt().remove();
    lassoPath = null;
  };
}
