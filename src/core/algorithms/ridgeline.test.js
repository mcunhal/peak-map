import { describe, it, expect } from 'vitest';
import { ridgeline, createRowIterator } from './ridgeline';
import { planeField, coneField, gaussianHill } from '../testFields';
import { createHeightField, NODATA } from '../heightField';

const opts = (over = {}) => ({
  rowCount: 10,
  heightScale: 20,
  oceanLevel: -Infinity,
  smoothSteps: 0,
  occlude: false,
  ...over,
});

describe('ridgeline', () => {
  it('draws the requested number of rows on flat ground', () => {
    const lines = ridgeline(planeField(40, 40, 100), opts({ rowCount: 10 }));
    expect(lines.length).toBe(10);
  });

  it('leaves flat ground flat rather than dividing by a zero range', () => {
    const lines = ridgeline(planeField(20, 20, 100), opts());
    for (const line of lines) {
      const ys = [];
      for (let i = 1; i < line.length; i += 2) ys.push(line[i]);
      expect(Math.max(...ys) - Math.min(...ys)).toBe(0);
      expect(ys.every(Number.isFinite)).toBe(true);
    }
  });

  it('spans the full width of the field', () => {
    const field = coneField(30, 30, 100);
    const lines = ridgeline(field, opts());
    const xs = lines.flatMap((l) => l.filter((_, i) => i % 2 === 0));
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(field.width - 1);
  });

  it('lifts high ground further up the page than low ground', () => {
    // On a cone the centre column is the summit, so its drawn y must be smaller
    // (higher on the page) than its own row's baseline.
    const field = coneField(31, 31, 100);
    const lines = ridgeline(field, opts({ rowCount: 15, heightScale: 20 }));
    // Rows now reach both edges, and the edge rows lie on flat ground outside the
    // cone, so pick the row with the most relief rather than the first one found.
    const spread = (line) => {
      const ys = [];
      for (let i = 1; i < line.length; i += 2) ys.push(line[i]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(Math.max(...lines.map(spread))).toBeGreaterThan(5);
  });

  it('scales displacement with heightScale', () => {
    const field = coneField(31, 31, 100);
    const spread = (scale) => {
      const lines = ridgeline(field, opts({ heightScale: scale }));
      const ys = lines.flatMap((l) => l.filter((_, i) => i % 2 === 1));
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(spread(40)).toBeGreaterThan(spread(10));
  });

  it('drops geometry at or below the ocean level', () => {
    // A horizontal cut through a cone is one contiguous interval, so flooding
    // shrinks rows and removes the ones that miss the cone entirely, rather than
    // splitting them in two.
    const field = coneField(31, 31, 100);
    const points = (lines) => lines.reduce((n, l) => n + l.length / 2, 0);

    const dry = ridgeline(field, opts({ oceanLevel: -Infinity }));
    const flooded = ridgeline(field, opts({ oceanLevel: 1 }));

    expect(points(flooded)).toBeLessThan(points(dry));

    // The cone is zero outside its radius, so nothing may be drawn at the edges.
    const xs = flooded.flatMap((l) => l.filter((_, i) => i % 2 === 0));
    expect(Math.min(...xs)).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(field.width - 1);
  });

  it('treats nodata as a gap rather than as sea level', () => {
    const width = 20, height = 20;
    const data = new Float32Array(width * height).fill(50);
    for (let y = 0; y < height; ++y) data[y * width + 10] = NODATA;
    const field = createHeightField({ width, height, data });
    const lines = ridgeline(field, opts({ rowCount: 5 }));
    // Every row is split in two by the nodata column.
    expect(lines.length).toBe(10);
    const xs = lines.flatMap((l) => l.filter((_, i) => i % 2 === 0));
    expect(xs).not.toContain(10);
  });

  it('removes hidden geometry when occlusion is on', () => {
    const field = gaussianHill(60, 60, 400);
    const count = (o) =>
      ridgeline(field, opts(o)).reduce((n, l) => n + l.length / 2, 0);
    expect(count({ occlude: true, heightScale: 60 })).toBeLessThan(
      count({ occlude: false, heightScale: 60 })
    );
  });

  it('occludes nothing until displacement outruns the row spacing', () => {
    // Terrain only hides terrain when a nearer row is lifted past the one behind
    // it. Below that threshold every row stands clear and occlusion is a no-op,
    // which is a real property of the algorithm rather than a missing feature.
    const field = gaussianHill(60, 60, 400);
    const count = (scale, occlude) =>
      ridgeline(field, opts({ heightScale: scale, occlude })).reduce(
        (n, l) => n + l.length / 2,
        0
      );

    // Rows span the field, so the topmost sits on the edge and any relief lifts
    // it off the sheet, where it is clipped. That is page-edge clipping, not
    // terrain hiding terrain, so allow for one row and compare the rest.
    const rowWidth = 60;
    expect(count(20, false) - count(20, true)).toBeLessThanOrEqual(rowWidth);
    expect(count(150, true)).toBeLessThan(count(20, true) * 0.8);
  });

  it('keeps every drawn point on the page when occluding', () => {
    const field = gaussianHill(60, 60, 900);
    const lines = ridgeline(field, opts({ occlude: true, heightScale: 50 }));
    for (const line of lines) {
      for (let i = 1; i < line.length; i += 2) {
        expect(line[i]).toBeGreaterThanOrEqual(0);
        expect(line[i]).toBeLessThanOrEqual(field.height);
      }
    }
  });

  it('smooths without changing how many rows are drawn', () => {
    const field = gaussianHill(40, 40, 300);
    const rough = ridgeline(field, opts({ smoothSteps: 0 }));
    const smooth = ridgeline(field, opts({ smoothSteps: 3 }));
    expect(smooth.length).toBe(rough.length);
  });

  it('is deterministic', () => {
    const field = gaussianHill(40, 40, 300);
    expect(ridgeline(field, opts())).toEqual(ridgeline(field, opts()));
  });

  it('returns nothing for a field with no data at all', () => {
    const data = new Float32Array(16).fill(NODATA);
    const field = createHeightField({ width: 4, height: 4, data });
    expect(ridgeline(field, opts())).toEqual([]);
  });
});

describe('rows span the sheet', () => {
  it('places a row on each edge of the field', () => {
    const { rows } = createRowIterator(40, 616);
    expect(Math.max(...rows)).toBe(615);
    expect(Math.min(...rows)).toBe(0);
  });

  it('spaces them evenly', () => {
    const { rows, spacing } = createRowIterator(30, 500);
    for (let i = 1; i < rows.length; ++i) {
      expect(Math.abs(rows[i - 1] - rows[i] - spacing)).toBeLessThanOrEqual(1);
    }
  });

  it('runs nearest first, which is what occlusion needs', () => {
    const { rows } = createRowIterator(10, 100);
    for (let i = 1; i < rows.length; ++i) expect(rows[i]).toBeLessThan(rows[i - 1]);
  });

  it('draws terrain right down to the bottom edge', () => {
    // The gap this replaced was a full row spacing, which on a sheet with no
    // margins looked like a margin.
    const field = gaussianHill(200, 140, 400);
    const lines = ridgeline(field, opts({ rowCount: 20, heightScale: 10 }));
    let lowest = -Infinity;
    for (const line of lines) {
      for (let i = 1; i < line.length; i += 2) if (line[i] > lowest) lowest = line[i];
    }
    // Within a sample of the last row, allowing for the relief lift.
    expect(lowest).toBeGreaterThan(field.height - 1 - 1.5);
  });

  it('honours the requested number of rows', () => {
    expect(createRowIterator(25, 400).rows).toHaveLength(25);
  });
});
