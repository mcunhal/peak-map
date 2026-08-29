import { describe, it, expect } from 'vitest';
import { createMosaic, coverageOf } from './rasterMosaic';
import { isNoData } from '../core/heightField';

/** A one-kilometre tile of the national grid, filled by a function of position. */
function tile(minX, minY, valueAt, { size = 10, noData } = {}) {
  const data = new Float32Array(size * size);
  for (let py = 0; py < size; ++py) {
    for (let px = 0; px < size; ++px) {
      // Row 0 is the top, so it is the highest y.
      const x = minX + ((px + 0.5) / size) * 1000;
      const y = minY + 1000 - ((py + 0.5) / size) * 1000;
      data[py * size + px] = valueAt(x, y);
    }
  }
  return { minX, minY, maxX: minX + 1000, maxY: minY + 1000, width: size, height: size, data, noData };
}

describe('createMosaic', () => {
  it('samples a single tile by position', () => {
    const m = createMosaic([tile(35000, 78000, (x, y) => x + y)]);
    expect(m.count).toBe(1);
    // Near the middle of the tile.
    expect(m.sampleAt(35500, 78500)).toBeCloseTo(35500 + 78500, -3);
  });

  it('knows which ground it holds', () => {
    const m = createMosaic([tile(35000, 78000, () => 100)]);
    expect(m.covers(35500, 78500)).toBe(true);
    expect(m.covers(36500, 78500)).toBe(false);
  });

  it('reports ground it does not hold as nodata, not zero', () => {
    const m = createMosaic([tile(35000, 78000, () => 100)]);
    expect(isNoData(m.sampleAt(99000, 99000))).toBe(true);
  });

  it('picks the right tile out of several', () => {
    const m = createMosaic([
      tile(35000, 78000, () => 1),
      tile(36000, 78000, () => 2),
      tile(35000, 79000, () => 3),
    ]);
    expect(m.sampleAt(35500, 78500)).toBe(1);
    expect(m.sampleAt(36500, 78500)).toBe(2);
    expect(m.sampleAt(35500, 79500)).toBe(3);
  });

  it('accepts tiles that do not touch, which is what a coastline gives', () => {
    const m = createMosaic([tile(35000, 78000, () => 1), tile(50000, 90000, () => 2)]);
    expect(m.sampleAt(35500, 78500)).toBe(1);
    expect(m.sampleAt(50500, 90500)).toBe(2);
    expect(isNoData(m.sampleAt(42000, 84000))).toBe(true);
  });

  it('puts north at the top of the raster', () => {
    // Value carries y, so the top row must read higher than the bottom.
    const m = createMosaic([tile(0, 0, (x, y) => y)]);
    expect(m.sampleAt(500, 950)).toBeGreaterThan(m.sampleAt(500, 50));
  });

  it('treats the DGT nodata value as absent ground', () => {
    const m = createMosaic([tile(0, 0, () => -999)]);
    expect(isNoData(m.sampleAt(500, 500))).toBe(true);
  });

  it('honours a nodata value declared by the file', () => {
    const m = createMosaic([tile(0, 0, () => -32768, { noData: -32768 })]);
    expect(isNoData(m.sampleAt(500, 500))).toBe(true);
  });

  it('keeps real elevations that merely look extreme', () => {
    // Nothing in Portugal is below sea level by much, but a legitimate -5 must
    // survive; only the sentinel band is rejected.
    const m = createMosaic([tile(0, 0, () => -5)]);
    expect(m.sampleAt(500, 500)).toBe(-5);
  });

  it('survives being given nothing', () => {
    const m = createMosaic([]);
    expect(m.count).toBe(0);
    expect(m.bounds).toBeNull();
    expect(isNoData(m.sampleAt(0, 0))).toBe(true);
    expect(m.covers(0, 0)).toBe(false);
  });

  it('ignores rasters with no extent or no pixels', () => {
    const m = createMosaic([
      { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 4, height: 4, data: new Float32Array(16) },
      { minX: 0, minY: 0, maxX: 10, maxY: 10, width: 0, height: 0, data: new Float32Array(0) },
      tile(0, 0, () => 7),
    ]);
    expect(m.count).toBe(1);
    expect(m.sampleAt(500, 500)).toBe(7);
  });

  it('reports the extent it spans', () => {
    const m = createMosaic([tile(35000, 78000, () => 1), tile(37000, 80000, () => 2)]);
    expect(m.bounds).toEqual({ minX: 35000, minY: 78000, maxX: 38000, maxY: 81000 });
  });

  it('stays quick with many tiles', () => {
    const tiles = [];
    for (let i = 0; i < 400; ++i) {
      tiles.push(tile(35000 + (i % 20) * 1000, 78000 + Math.floor(i / 20) * 1000, () => i));
    }
    const m = createMosaic(tiles);
    const started = Date.now();
    for (let n = 0; n < 200000; ++n) m.sampleAt(35000 + (n % 20000), 78000 + (n % 20000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('coverageOf', () => {
  const identity = (x, y) => ({ x, y });

  it('reports full coverage when every sample lands on a tile', () => {
    const m = createMosaic([tile(0, 0, () => 1)]);
    expect(coverageOf(m, (x, y) => identity(x, y), 1000, 1000)).toBe(1);
  });

  it('reports none when the sheet is elsewhere', () => {
    const m = createMosaic([tile(0, 0, () => 1)]);
    expect(coverageOf(m, (x, y) => ({ x: x + 50000, y: y + 50000 }), 1000, 1000)).toBe(0);
  });

  it('reports a fraction when the sheet runs off the flown area', () => {
    // One tile, but a sheet twice its width: about half should be covered.
    const m = createMosaic([tile(0, 0, () => 1)]);
    const c = coverageOf(m, (x, y) => ({ x, y: y }), 2000, 1000);
    expect(c).toBeGreaterThan(0.4);
    expect(c).toBeLessThan(0.6);
  });

  it('is zero for an empty mosaic', () => {
    expect(coverageOf(createMosaic([]), identity, 100, 100)).toBe(0);
  });
});
