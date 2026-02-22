import * as d3 from 'd3';

// Point-in-polygon test (ray casting)
function pointInPolygon(point, polygon) {
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

/**
 * Attach lasso selection to an SVG group.
 * @param {d3.Selection} svg - The SVG element
 * @param {object} opts
 * @param {Function} opts.getPoints - () => [{x, y, id, ...}] current point data
 * @param {Function} opts.onSelect - (selectedIds) => void
 * @param {string} [opts.className] - CSS class for lasso path
 * @returns {Function} cleanup function
 */
export function attachLasso(svg, { getPoints, onSelect, className = 'lasso-path' }) {
  let lassoPath = null;
  let lassoPoints = [];
  let active = false;

  const lineGen = d3.line().curve(d3.curveBasis);

  const drag = d3.drag()
    .on('start', function (event) {
      // Only start lasso on right-click or with shift held
      if (!event.sourceEvent.shiftKey) return;
      active = true;
      lassoPoints = [[event.x, event.y]];
      lassoPath = d3.select(this)
        .append('path')
        .attr('class', className)
        .attr('d', lineGen(lassoPoints));
    })
    .on('drag', function (event) {
      if (!active) return;
      lassoPoints.push([event.x, event.y]);
      lassoPath.attr('d', lineGen(lassoPoints) + 'Z');
    })
    .on('end', function () {
      if (!active) return;
      active = false;

      if (lassoPoints.length < 3) {
        if (lassoPath) lassoPath.remove();
        onSelect([]);
        return;
      }

      // Test each point against the lasso polygon
      const points = getPoints();
      const selectedIds = points
        .filter((p) => pointInPolygon([p.x, p.y], lassoPoints))
        .map((p) => p.id);

      onSelect(selectedIds);

      // Fade out lasso path
      if (lassoPath) {
        lassoPath
          .transition()
          .duration(800)
          .style('opacity', 0)
          .remove();
      }
    });

  svg.call(drag);

  return () => {
    svg.on('.drag', null);
    if (lassoPath) lassoPath.remove();
  };
}
