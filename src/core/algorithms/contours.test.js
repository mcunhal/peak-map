import { describe, it, expect } from 'vitest';
import {
  chooseLevels, marchSquares, contourLevels, contours,
  tanakaClasses, shadeWeightedClasses,
} from './contours';
import { createHeightField, NODATA } from '../heightField';
import { planeField, coneField, gaussianHill, rampField } from '../testFields';
import { computeGradient, computeHillshade } from '../derived';
import { polylineLength, isClosed, mergePolylines } from '../optimize';

const totalLength = (lines) => lines.reduce((n, l) => n + polylineLength(l), 0);

describe('chooseLevels', () => {
  it('spans the elevation range', () => {
    const levels = chooseLevels(coneField(41, 41, 1000), { interval: 100 });
    expect(levels[0]).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBeLessThan(1000);
    expect(levels).toContain(500);
  });

  it('uses an interval a paper map would use', () => {
    const levels = chooseLevels(coneField(41, 41, 1000), { count: 10 });
    expect(levels[1] - levels[0]).toBe(100);
  });

  it('honours a requested interval', () => {
    const levels = chooseLevels(coneField(41, 41, 1000), { interval: 250 });
    expect(levels[1] - levels[0]).toBe(250);
  });

  it('aligns levels to the base', () => {
    const levels = chooseLevels(coneField(41, 41, 1000), { interval: 100, base: 50 });
    for (const level of levels) expect((level - 50) % 100).toBeCloseTo(0, 9);
  });

  it('returns nothing for flat ground', () => {
    expect(chooseLevels(planeField(10, 10, 400))).toEqual([]);
  });

  it('produces roughly the requested number of contours', () => {
    const levels = chooseLevels(gaussianHill(60, 60, 900), { count: 20 });
    expect(levels.length).toBeGreaterThan(5);
    expect(levels.length).toBeLessThan(60);
  });
});

describe('marchSquares', () => {
  it('finds nothing when the level is outside the data', () => {
    expect(marchSquares(coneField(21, 21, 100), 200)).toEqual([]);
    expect(marchSquares(coneField(21, 21, 100), -5)).toEqual([]);
  });

  it('finds nothing on flat ground', () => {
    expect(marchSquares(planeField(10, 10, 100), 100)).toEqual([]);
  });

  it('traces a straight line across a ramp', () => {
    // A ramp rising along x: the 50m contour is a vertical line at the midpoint.
    const segments = marchSquares(rampField(11, 11, 0, 100), 50);
    expect(segments.length).toBeGreaterThan(0);
    for (const [x1, , x2] of segments) {
      expect(x1).toBeCloseTo(5, 6);
      expect(x2).toBeCloseTo(5, 6);
    }
  });

  it('traces a closed ring around a cone', () => {
    const lines = mergeOnce(marchSquares(coneField(41, 41, 100), 50));
    expect(lines).toHaveLength(1);
    expect(isClosed(lines[0], 0.01)).toBe(true);
  });

  it('skips cells touching nodata rather than tracing the hole', () => {
    const width = 21, height = 21;
    const solid = coneField(width, height, 100);
    const data = Float32Array.from(solid.data);
    // Punch a hole well inside the 50m ring.
    for (let y = 9; y <= 11; ++y) for (let x = 9; x <= 11; ++x) data[y * width + x] = NODATA;
    const holed = createHeightField({ width, height, data });

    const withHole = marchSquares(holed, 50);
    const without = marchSquares(solid, 50);
    // The ring at 50m is far from the hole, so it is unaffected.
    expect(withHole.length).toBe(without.length);

    // A level that would run through the hole loses geometry instead of tracing it.
    expect(marchSquares(holed, 95).length).toBeLessThan(marchSquares(solid, 95).length);
  });

  it('resolves a saddle without joining unconnected ridges', () => {
    // A saddle has two contour branches at the level through its centre.
    const width = 21, height = 21;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; ++y) {
      for (let x = 0; x < width; ++x) {
        data[y * width + x] = ((x - 10) / 10) ** 2 - ((y - 10) / 10) ** 2;
      }
    }
    const field = createHeightField({ width, height, data });
    const lines = mergeOnce(marchSquares(field, 0));
    // Two crossing branches, not one continuous loop.
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});

// Mirrors what contourLevels does, so marchSquares can be examined as strokes.
function mergeOnce(segments) {
  return mergePolylines(segments, 0.01);
}

describe('contourLevels', () => {
  const hill = gaussianHill(60, 60, 900);

  it('groups polylines by elevation', () => {
    const groups = contourLevels(hill, { interval: 100 });
    expect(groups.length).toBeGreaterThan(3);
    for (const group of groups) {
      expect(typeof group.level).toBe('number');
      expect(group.polylines.length).toBeGreaterThan(0);
    }
  });

  it('returns levels in ascending order', () => {
    const groups = contourLevels(hill, { interval: 100 });
    const levels = groups.map((g) => g.level);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });

  it('nests contours: higher levels are shorter on a single hill', () => {
    const groups = contourLevels(hill, { interval: 150 });
    const lengths = groups.map((g) => totalLength(g.polylines));
    for (let i = 1; i < lengths.length; ++i) {
      expect(lengths[i]).toBeLessThan(lengths[i - 1]);
    }
  });

  it('chains segments into long strokes rather than leaving them loose', () => {
    const segments = marchSquares(hill, 400);
    const chained = contourLevels(hill, { levels: [400] })[0].polylines;
    expect(chained.length).toBeLessThan(segments.length);
  });

  it('closes rings on a smooth hill', () => {
    const group = contourLevels(hill, { levels: [400] })[0];
    expect(group.polylines.some((l) => isClosed(l, 0.05))).toBe(true);
  });

  it('gives more lines at a finer interval', () => {
    const coarse = contours(hill, { interval: 200 });
    const fine = contours(hill, { interval: 50 });
    expect(totalLength(fine)).toBeGreaterThan(totalLength(coarse));
  });

  it('is deterministic', () => {
    expect(contours(hill, { interval: 100 })).toEqual(contours(hill, { interval: 100 }));
  });

  it('returns nothing for flat ground', () => {
    expect(contours(planeField(20, 20, 300))).toEqual([]);
  });
});

describe('tanakaClasses', () => {
  const hill = gaussianHill(60, 60, 900);
  const lines = contours(hill, { interval: 100 });

  it('splits contours into the requested number of classes', () => {
    const groups = tanakaClasses(lines, { classes: 3 });
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.weight)).toEqual([1 / 3, 2 / 3, 1]);
  });

  it('puts geometry in more than one class', () => {
    const used = tanakaClasses(lines, { classes: 3 }).filter((g) => g.polylines.length);
    expect(used.length).toBeGreaterThan(1);
  });

  it('preserves total drawn length', () => {
    const groups = tanakaClasses(lines, { classes: 4 });
    const split = groups.reduce((n, g) => n + totalLength(g.polylines), 0);
    expect(split).toBeCloseTo(totalLength(lines), 3);
  });

  it('moves geometry between classes when the light moves', () => {
    // Deliberately not the radially symmetric hill: its contours are circles, so
    // the distribution of segment directions is uniform and rotating the light
    // provably changes nothing. Asymmetric terrain is needed to see the effect.
    const ridge = contours(rampField(60, 60, 0, 900), { interval: 100 });
    const a = tanakaClasses(ridge, { azimuth: 90, classes: 3 });
    const b = tanakaClasses(ridge, { azimuth: 0, classes: 3 });
    expect(totalLength(a[2].polylines)).not.toBeCloseTo(totalLength(b[2].polylines), 3);
  });

  it('collapses to a single class when asked for one', () => {
    const groups = tanakaClasses(lines, { classes: 1 });
    expect(groups).toHaveLength(1);
    expect(totalLength(groups[0].polylines)).toBeCloseTo(totalLength(lines), 3);
  });

  it('rejects a nonsensical class count', () => {
    expect(() => tanakaClasses(lines, { classes: 0 })).toThrow(/at least one/i);
  });
});

describe('shadeWeightedClasses', () => {
  it('weights contours by an actual hillshade', () => {
    const hill = gaussianHill(60, 60, 900);
    const lines = contours(hill, { interval: 100 });
    const shade = computeHillshade(computeGradient(hill), { zFactor: 4 });
    const groups = shadeWeightedClasses(lines, shade, { classes: 3 });
    expect(groups).toHaveLength(3);
    expect(groups.filter((g) => g.polylines.length).length).toBeGreaterThan(1);
  });
});
