import { describe, it, expect } from 'vitest';
import { NODATA, createHeightField, computeRange } from './heightField';
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
