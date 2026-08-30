/**
 * Cutting polylines against the page and against keep-out shapes.
 *
 * Two things need geometry removed rather than merely not drawn. The sheet is
 * over-plotted below its bottom edge, so terrain that would otherwise leave the
 * paper blank under a near peak is generated and then cut off at the edge. And
 * the compass rose needs clean paper under it, so everything else is cut away
 * inside its footprint.
 *
 * Both are the same operation — split a polyline where it crosses a boundary and
 * keep the runs on one side — so both live here, in millimetres, and run before
 * the optimizer sees the geometry. Cutting afterwards would hand the optimizer a
 * plot path it had already sorted and then invalidate it.
 *
 * Pure: flat [x0, y0, x1, y1, ...] arrays in, the same out.
 */

/** Below this, two points are the same point and the stroke between them is not a stroke. */
const EPSILON = 1e-9;

/** Push a point unless it repeats the one before it. */
function pushPoint(run, x, y) {
  const n = run.length;
  if (n >= 2 && Math.abs(run[n - 2] - x) < EPSILON && Math.abs(run[n - 1] - y) < EPSILON) {
    return;
  }
  run.push(x, y);
}

/** A run of fewer than two distinct points is a pen-down with nowhere to go. */
function flushRun(out, run) {
  if (run.length >= 4) out.push(run);
}

/**
 * Keep the parts of each polyline inside a rectangle.
 *
 * Any side may be left out, and is then unbounded. The bottom over-plot only
 * needs `maxY`: clipping the other three would change what already-shipped
 * sheets look like, since a far ridge lifted above the top edge runs off the
 * paper today and is expected to.
 *
 * @param {Array<number[]>} polylines
 * @param {{minX?:number,minY?:number,maxX?:number,maxY?:number}} bounds
 */
export function clipToBounds(polylines, bounds = {}) {
  const minX = Number.isFinite(bounds.minX) ? bounds.minX : -Infinity;
  const minY = Number.isFinite(bounds.minY) ? bounds.minY : -Infinity;
  const maxX = Number.isFinite(bounds.maxX) ? bounds.maxX : Infinity;
  const maxY = Number.isFinite(bounds.maxY) ? bounds.maxY : Infinity;

  if (minX === -Infinity && minY === -Infinity && maxX === Infinity && maxY === Infinity) {
    return polylines;
  }

  // How far along a segment the boundary is crossed. Liang-Barsky, without the
  // early exits: every crossing is wanted, not just the first and last, because
  // a run is emitted on each side of it.
  const crossing = (x0, y0, x1, y1) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let enter = 0;
    let leave = 1;

    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) {
        if (t > leave) return false;
        if (t > enter) enter = t;
      } else {
        if (t < enter) return false;
        if (t < leave) leave = t;
      }
      return true;
    };

    if (
      clip(-dx, x0 - minX) &&
      clip(dx, maxX - x0) &&
      clip(-dy, y0 - minY) &&
      clip(dy, maxY - y0)
    ) {
      return [enter, leave];
    }
    return null;
  };

  const out = [];

  for (const points of polylines) {
    if (!points || points.length < 4) continue;

    let run = [];
    for (let i = 0; i + 3 < points.length; i += 2) {
      const x0 = points[i];
      const y0 = points[i + 1];
      const x1 = points[i + 2];
      const y1 = points[i + 3];

      const span = crossing(x0, y0, x1, y1);
      if (!span) {
        // The whole segment is outside; whatever came before it ends here.
        flushRun(out, run);
        run = [];
        continue;
      }

      const [enter, leave] = span;
      const ax = x0 + (x1 - x0) * enter;
      const ay = y0 + (y1 - y0) * enter;
      const bx = x0 + (x1 - x0) * leave;
      const by = y0 + (y1 - y0) * leave;

      // A segment that starts outside begins a new run at the point it enters.
      if (enter > 0 && run.length) {
        flushRun(out, run);
        run = [];
      }
      pushPoint(run, ax, ay);
      pushPoint(run, bx, by);

      // A segment that leaves early ends the run at the point it leaves.
      if (leave < 1) {
        flushRun(out, run);
        run = [];
      }
    }
    flushRun(out, run);
  }

  return out;
}

/**
 * Whether a point is inside a polygon, by ray casting.
 *
 * A point exactly on the boundary is undefined, as it is in every crossing-count
 * test. Nothing here depends on it: the keep-out shape carries a margin, so a
 * stroke that lands on its edge was going to be cut anyway.
 *
 * @param {number[]} polygon - flat [x0, y0, x1, y1, ...], implicitly closed
 */
export function pointInPolygon(polygon, x, y) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = polygon[i];
    const yi = polygon[i + 1];
    const xj = polygon[j];
    const yj = polygon[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Remove the parts of each polyline that fall inside a polygon.
 *
 * Every crossing of every polygon edge is collected, the segment is cut at each
 * one, and each piece is kept or dropped by testing its midpoint. Testing the
 * midpoint rather than the endpoints is what makes a piece that runs exactly
 * between two crossings decidable at all.
 *
 * @param {Array<number[]>} polylines
 * @param {number[]} polygon - flat, implicitly closed; null leaves the input alone
 */
export function subtractPolygon(polylines, polygon) {
  if (!polygon || polygon.length < 6) return polylines;

  // A cheap reject, so the great majority of strokes never touch the edge loop.
  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  for (let i = 0; i < polygon.length; i += 2) {
    if (polygon[i] < bMinX) bMinX = polygon[i];
    if (polygon[i] > bMaxX) bMaxX = polygon[i];
    if (polygon[i + 1] < bMinY) bMinY = polygon[i + 1];
    if (polygon[i + 1] > bMaxY) bMaxY = polygon[i + 1];
  }

  const out = [];

  for (const points of polylines) {
    if (!points || points.length < 4) continue;

    // Whole strokes clear of the shape's bounding box, which is most of them.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      if (points[i] < minX) minX = points[i];
      if (points[i] > maxX) maxX = points[i];
      if (points[i + 1] < minY) minY = points[i + 1];
      if (points[i + 1] > maxY) maxY = points[i + 1];
    }
    if (maxX < bMinX || minX > bMaxX || maxY < bMinY || minY > bMaxY) {
      out.push(points);
      continue;
    }

    let run = [];
    for (let i = 0; i + 3 < points.length; i += 2) {
      const x0 = points[i];
      const y0 = points[i + 1];
      const x1 = points[i + 2];
      const y1 = points[i + 3];

      const cuts = segmentCuts(polygon, x0, y0, x1, y1);

      let previous = 0;
      for (const t of [...cuts, 1]) {
        const mid = (previous + t) / 2;
        const keep = !pointInPolygon(
          polygon,
          x0 + (x1 - x0) * mid,
          y0 + (y1 - y0) * mid
        );

        if (keep) {
          pushPoint(run, x0 + (x1 - x0) * previous, y0 + (y1 - y0) * previous);
          pushPoint(run, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        } else {
          flushRun(out, run);
          run = [];
        }
        previous = t;
      }
    }
    flushRun(out, run);
  }

  return out;
}

/** Sorted parameters along a segment at which it crosses a polygon's edges. */
function segmentCuts(polygon, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const cuts = [];
  const n = polygon.length;

  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ex = polygon[i] - polygon[j];
    const ey = polygon[i + 1] - polygon[j + 1];
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-12) continue; // Parallel, including collinear.

    const px = polygon[j] - x0;
    const py = polygon[j + 1] - y0;
    const t = (px * ey - py * ex) / denominator;
    const u = (px * dy - py * dx) / denominator;
    if (t > EPSILON && t < 1 - EPSILON && u >= 0 && u <= 1) cuts.push(t);
  }

  return cuts.sort((a, b) => a - b);
}

/**
 * The convex hull of a set of points, counter-clockwise in a y-down frame.
 *
 * Andrew's monotone chain. Used to wrap the compass rose in one convex shape
 * rather than maintaining a keep-out outline by hand: the rose can grow a
 * feature without the cut-out silently failing to cover it.
 *
 * @param {number[]} points - flat [x0, y0, x1, y1, ...]
 */
export function convexHull(points) {
  const sorted = [];
  for (let i = 0; i < points.length; i += 2) sorted.push([points[i], points[i + 1]]);
  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted.flat();

  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (list) => {
    const chain = [];
    for (const p of list) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) {
        chain.pop();
      }
      chain.push(p);
    }
    chain.pop();
    return chain;
  };

  return [...build(sorted), ...build(sorted.slice().reverse())].flat();
}
