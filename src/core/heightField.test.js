import { describe, it, expect } from 'vitest';
import { NODATA, createHeightField, computeRange, cutBelow } from './heightField';
import { planeField, gaussianHill, coneField } from './testFields';

describe('createHeightField', () => {
  it('reads samples in row-major order', () => {
    const field = createHeightField({
      width: 3,
      height: 2,
      data: Float32Array.from([1, 2, 3, 4, 5, 6]),
    });
    expect(field.get(0, 0)).toBe(1);
    expect(field.get(2, 0)).toBe(3);
    expect(field.get(0, 1)).toBe(4);
    expect(field.get(2, 1)).toBe(6);
  });

  it('reports samples outside the grid as nodata', () => {
    const field = planeField(4, 4, 10);
    expect(field.get(-1, 0)).toBe(NODATA);
    expect(field.get(4, 0)).toBe(NODATA);
    expect(field.get(0, 4)).toBe(NODATA);
  });

  it('distinguishes nodata from a real sample', () => {
    const data = Float32Array.from([5, NODATA, 7, 8]);
    const field = createHeightField({ width: 2, height: 2, data });
    expect(field.hasData(0, 0)).toBe(true);
    expect(field.hasData(1, 0)).toBe(false);
  });

  it('rejects a data array that does not match the dimensions', () => {
    expect(() =>
      createHeightField({ width: 3, height: 3, data: Float32Array.from([1, 2]) })
    ).toThrow(/length/i);
  });
});

describe('computeRange', () => {
  it('finds the range of a plane', () => {
    const range = computeRange(planeField(5, 5, 42));
    expect(range.minHeight).toBe(42);
    expect(range.maxHeight).toBe(42);
    expect(range.validSamples).toBe(25);
  });

  it('locates the row holding the highest point', () => {
    // A cone peaks at its centre row.
    const field = coneField(21, 21, 100);
    const range = computeRange(field);
    expect(range.rowWithHighestPoint).toBe(10);
    expect(range.maxHeight).toBeCloseTo(100, 5);
  });

  it('excludes nodata from the range', () => {
    const data = Float32Array.from([NODATA, 10, 20, NODATA]);
    const range = computeRange(createHeightField({ width: 2, height: 2, data }));
    expect(range.minHeight).toBe(10);
    expect(range.maxHeight).toBe(20);
    expect(range.validSamples).toBe(2);
  });

  it('reports an empty range when every sample is nodata', () => {
    const data = Float32Array.from([NODATA, NODATA]);
    const range = computeRange(createHeightField({ width: 2, height: 1, data }));
    expect(range.validSamples).toBe(0);
    expect(range.isEmpty).toBe(true);
  });

  it('gives a gaussian hill its peak at the centre', () => {
    const field = gaussianHill(31, 31, 500);
    const range = computeRange(field);
    expect(range.maxHeight).toBeCloseTo(500, 5);
    expect(range.rowWithHighestPoint).toBe(15);
  });
});

describe('computeRange over a floor', () => {
  const field = (values) =>
    createHeightField({
      width: values[0].length,
      height: values.length,
      data: Float32Array.from(values.flat()),
    });

  it('counts every sample when no floor is given', () => {
    const range = computeRange(field([[-5000, 10], [20, 30]]));
    expect(range.minHeight).toBe(-5000);
    expect(range.maxHeight).toBe(30);
  });

  it('ignores samples at or below the floor', () => {
    // The seabed is not part of the drawing, so it must not set its baseline.
    const range = computeRange(field([[-5000, 10], [20, 30]]), { floor: 0 });
    expect(range.minHeight).toBe(10);
    expect(range.maxHeight).toBe(30);
    expect(range.heightRange).toBe(20);
  });

  it('excludes a sample sitting exactly on the floor', () => {
    // Matches how the renderer cuts: `elevation <= oceanLevel` is not drawn.
    expect(computeRange(field([[0, 5]]), { floor: 0 }).minHeight).toBe(5);
  });

  it('counts nothing when the floor is above everything', () => {
    const range = computeRange(field([[-100, -50]]), { floor: 0 });
    expect(range.isEmpty).toBe(true);
    expect(range.validSamples).toBe(0);
  });

  it('still reports the row holding the highest point', () => {
    const range = computeRange(field([[-5000, -5000], [10, 900]]), { floor: 0 });
    expect(range.rowWithHighestPoint).toBe(1);
  });
});

describe('cutBelow', () => {
  const field = (values, extra = {}) =>
    createHeightField({
      width: values[0].length,
      height: values.length,
      data: Float32Array.from(values.flat()),
      ...extra,
    });

  it('marks samples at or below the level as nodata', () => {
    const cut = cutBelow(field([[-5000, 10], [0, 30]]), 0);
    expect(cut.hasData(0, 0)).toBe(false);
    expect(cut.hasData(0, 1)).toBe(false);
    expect(cut.get(1, 0)).toBe(10);
    expect(cut.get(1, 1)).toBe(30);
  });

  it('leaves the field alone when no level is given', () => {
    const original = field([[-5000, 10]]);
    expect(cutBelow(original, -Infinity)).toBe(original);
    expect(cutBelow(original, undefined)).toBe(original);
  });

  it('does not write through to the field it was given', () => {
    const original = field([[-5000, 10]]);
    cutBelow(original, 0);
    expect(original.get(0, 0)).toBe(-5000);
  });

  it('carries the sheet height, bbox and region across', () => {
    const region = { marker: true };
    const cut = cutBelow(
      field([[-5000, 10], [20, 30]], { bbox: { west: 1, south: 2, east: 3, north: 4 }, region, sheetHeight: 1.5 }),
      0
    );
    expect(cut.sheetHeight).toBe(1.5);
    expect(cut.region).toBe(region);
    expect(cut.bbox).toEqual({ west: 1, south: 2, east: 3, north: 4 });
  });

  it('leaves the range of the ground it kept', () => {
    const cut = cutBelow(field([[-5000, 10], [20, 30]]), 0);
    // The whole point: a range taken over the cut field needs no floor.
    expect(computeRange(cut).minHeight).toBe(10);
    expect(computeRange(cut).maxHeight).toBe(30);
  });
});
