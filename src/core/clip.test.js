import { describe, it, expect } from 'vitest';
import { clipToBounds, subtractPolygon, convexHull, pointInPolygon } from './clip';

/** Every vertex of a flat polyline, as pairs, for readable assertions. */
const pairs = (line) => {
  const out = [];
  for (let i = 0; i < line.length; i += 2) out.push([line[i], line[i + 1]]);
  return out;
};

describe('clipToBounds', () => {
  const below = { maxY: 10 };

  it('leaves a polyline that is entirely inside untouched', () => {
    const line = [0, 0, 5, 5, 9, 2];
    expect(clipToBounds([line], below)).toEqual([line]);
  });

  it('drops a polyline that is entirely outside', () => {
    expect(clipToBounds([[0, 11, 5, 20]], below)).toEqual([]);
  });

  it('cuts a crossing segment at the boundary', () => {
    const [line] = clipToBounds([[0, 0, 0, 20]], below);
    expect(pairs(line)).toEqual([
      [0, 0],
      [0, 10],
    ]);
  });

  it('cuts on the way back in', () => {
    const [line] = clipToBounds([[0, 20, 0, 0]], below);
    expect(pairs(line)).toEqual([
      [0, 10],
      [0, 0],
    ]);
  });

  it('splits a polyline that leaves and re-enters', () => {
    const lines = clipToBounds([[0, 0, 1, 20, 2, 20, 3, 0]], below);
    expect(lines).toHaveLength(2);
    expect(pairs(lines[0])[0]).toEqual([0, 0]);
    expect(pairs(lines[1]).at(-1)).toEqual([3, 0]);
    // Every emitted vertex is inside.
    for (const line of lines) {
      for (const [, y] of pairs(line)) expect(y).toBeLessThanOrEqual(10 + 1e-9);
    }
  });

  it('does not emit a run of a single point', () => {
    // Only the very first vertex is inside; the crossing lands on top of it.
    expect(clipToBounds([[0, 10, 0, 20, 1, 30]], below)).toEqual([]);
  });

  it('clips against all four sides when they are given', () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const [line] = clipToBounds([[-5, 5, 15, 5]], bounds);
    expect(pairs(line)).toEqual([
      [0, 5],
      [10, 5],
    ]);
  });

  it('treats an omitted side as unbounded', () => {
    // Nothing constrains y, so a line far below survives whole.
    const line = [0, -100, 5, 900];
    expect(clipToBounds([line], { minX: 0, maxX: 10 })).toEqual([line]);
  });
});

describe('pointInPolygon', () => {
  const square = [0, 0, 10, 0, 10, 10, 0, 10];

  it('finds a point inside', () => {
    expect(pointInPolygon(square, 5, 5)).toBe(true);
  });

  it('finds a point outside', () => {
    expect(pointInPolygon(square, 15, 5)).toBe(false);
    expect(pointInPolygon(square, 5, -1)).toBe(false);
  });
});

describe('subtractPolygon', () => {
  // A square hole from (4,4) to (6,6).
  const hole = [4, 4, 6, 4, 6, 6, 4, 6];

  it('leaves a polyline that misses the polygon untouched', () => {
    const line = [0, 0, 10, 0];
    expect(subtractPolygon([line], hole)).toEqual([line]);
  });

  it('drops a polyline entirely inside the polygon', () => {
    expect(subtractPolygon([[4.5, 4.5, 5.5, 5.5]], hole)).toEqual([]);
  });

  it('splits a polyline that crosses the polygon in two', () => {
    const lines = subtractPolygon([[0, 5, 10, 5]], hole);
    expect(lines).toHaveLength(2);
    expect(pairs(lines[0])).toEqual([
      [0, 5],
      [4, 5],
    ]);
    expect(pairs(lines[1])).toEqual([
      [6, 5],
      [10, 5],
    ]);
  });

  it('trims a polyline that ends inside the polygon', () => {
    const lines = subtractPolygon([[0, 5, 5, 5]], hole);
    expect(lines).toHaveLength(1);
    expect(pairs(lines[0])).toEqual([
      [0, 5],
      [4, 5],
    ]);
  });

  it('keeps a polyline that passes just outside', () => {
    const line = [0, 3.99, 10, 3.99];
    expect(subtractPolygon([line], hole)).toEqual([line]);
  });

  it('keeps the parts of a polyline whose vertices straddle a corner', () => {
    // Enters through the left edge and leaves through the top.
    const lines = subtractPolygon([[0, 5, 5, 0]], hole);
    const inside = lines.flatMap((l) => pairs(l)).filter(([x, y]) => x > 4.001 && x < 5.999 && y > 4.001 && y < 5.999);
    expect(inside).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('does nothing without a polygon', () => {
    const line = [0, 5, 10, 5];
    expect(subtractPolygon([line], null)).toEqual([line]);
  });
});

describe('convexHull', () => {
  it('drops a point inside the hull', () => {
    const hull = convexHull([0, 0, 10, 0, 10, 10, 0, 10, 5, 5]);
    expect(hull).toHaveLength(8);
    expect(pointInPolygon(hull, 5, 5)).toBe(true);
  });

  it('contains every input point', () => {
    const points = [];
    for (let i = 0; i < 40; ++i) {
      const a = (i / 40) * Math.PI * 2;
      points.push(Math.cos(a) * (1 + (i % 3) * 0.1), Math.sin(a));
    }
    const hull = convexHull(points);

    // Hull vertices lie *on* the boundary, where a crossing count is undefined.
    // For a convex ring the honest test is that the point is on the inner side
    // of every edge.
    for (let i = 0; i < points.length; i += 2) {
      for (let j = 0, k = hull.length - 2; j < hull.length; k = j, j += 2) {
        const side =
          (hull[j] - hull[k]) * (points[i + 1] - hull[k + 1]) -
          (hull[j + 1] - hull[k + 1]) * (points[i] - hull[k]);
        expect(side).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('winds counter-clockwise in a y-down frame', () => {
    // Shoelace is positive for this winding when y grows downwards.
    const hull = convexHull([0, 0, 10, 0, 10, 10, 0, 10]);
    let area = 0;
    for (let i = 0; i < hull.length; i += 2) {
      const j = (i + 2) % hull.length;
      area += hull[i] * hull[j + 1] - hull[j] * hull[i + 1];
    }
    expect(area).toBeGreaterThan(0);
  });
});
