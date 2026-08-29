import { describe, it, expect } from 'vitest';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { readGeoTiff, buildHeightFieldFromRasters, resolutionAdvice } from './ptLidarRaster';
import { tm06ToLngLat } from './ptLidarGrid';
import { createRegion } from './tileMath';
import { computeRange, isNoData } from '../core/heightField';

/**
 * A real GeoTIFF shaped like DGT's: Float32, one square kilometre, EPSG:3763.
 * Written rather than mocked, so the reader is exercised against an actual file.
 */
async function makeTiff(minX, minY, valueAt, { size = 20, noData = -999 } = {}) {
  const values = new Float32Array(size * size);
  for (let py = 0; py < size; ++py) {
    for (let px = 0; px < size; ++px) {
      const x = minX + ((px + 0.5) / size) * 1000;
      const y = minY + 1000 - ((py + 0.5) / size) * 1000;
      values[py * size + px] = valueAt(x, y);
    }
  }
  return writeArrayBuffer(values, {
    width: size,
    height: size,
    // The projection has to be declared, or the writer decides the file is
    // geographic and replaces the tiepoint with one covering the whole globe.
    // DGT's files are EPSG:3763, so saying so makes the fixture faithful too.
    ProjectedCSTypeGeoKey: 3763,
    GTModelTypeGeoKey: 1,
    ModelTiepoint: [0, 0, 0, minX, minY + 1000, 0],
    ModelPixelScale: [1000 / size, 1000 / size, 0],
    GDAL_NODATA: String(noData),
  });
}

/** A north-up sheet over a patch of ground given in EPSG:3763. */
function sheetOver(minX, minY, spanX, spanY) {
  const nw = tm06ToLngLat(minX, minY + spanY);
  const ne = tm06ToLngLat(minX + spanX, minY + spanY);
  const sw = tm06ToLngLat(minX, minY);
  return createRegion({ nw, ne, sw });
}

describe('readGeoTiff', () => {
  it('reads position, size and values out of a real file', async () => {
    const bytes = await makeTiff(35000, 78000, () => 42);
    const r = await readGeoTiff(bytes, { fromArrayBuffer });

    expect(r.minX).toBeCloseTo(35000, 6);
    expect(r.minY).toBeCloseTo(78000, 6);
    expect(r.maxX).toBeCloseTo(36000, 6);
    expect(r.maxY).toBeCloseTo(79000, 6);
    expect(r.width).toBe(20);
    expect(r.height).toBe(20);
    expect(r.data[0]).toBeCloseTo(42, 4);
  });

  it('carries the nodata value declared by the file', async () => {
    const bytes = await makeTiff(0, 0, () => 1, { noData: -999 });
    const r = await readGeoTiff(bytes, { fromArrayBuffer });
    expect(r.noData).toBe(-999);
  });

  it('keeps north at the top, as a GeoTIFF stores it', async () => {
    const bytes = await makeTiff(0, 0, (x, y) => y);
    const r = await readGeoTiff(bytes, { fromArrayBuffer });
    // First row is the northern edge, so it holds the larger value.
    expect(r.data[0]).toBeGreaterThan(r.data[(r.height - 1) * r.width]);
  });
});

describe('buildHeightFieldFromRasters', () => {
  it('samples a tile onto a sheet covering the same ground', async () => {
    const bytes = await makeTiff(35000, 78000, () => 500);
    const raster = await readGeoTiff(bytes, { fromArrayBuffer });
    const region = sheetOver(35000, 78000, 1000, 1000);

    const { field, coverage, tilesUsed } = buildHeightFieldFromRasters({
      region, rasters: [raster], fieldWidth: 40, fieldHeight: 40,
    });

    expect(tilesUsed).toBe(1);
    expect(coverage).toBeGreaterThan(0.95);
    const range = computeRange(field);
    expect(range.minHeight).toBeCloseTo(500, 1);
    expect(range.maxHeight).toBeCloseTo(500, 1);
  });

  it('reproduces a slope in the right direction', async () => {
    // Rising to the east and to the north.
    const bytes = await makeTiff(35000, 78000, (x, y) => (x - 35000) + (y - 78000));
    const raster = await readGeoTiff(bytes, { fromArrayBuffer });
    const region = sheetOver(35000, 78000, 1000, 1000);

    const { field } = buildHeightFieldFromRasters({
      region, rasters: [raster], fieldWidth: 40, fieldHeight: 40,
    });

    // East is a larger x in the field.
    expect(field.get(35, 20)).toBeGreaterThan(field.get(4, 20));
    // North is a smaller y in the field.
    expect(field.get(20, 4)).toBeGreaterThan(field.get(20, 35));
  });

  it('joins several tiles into one surface', async () => {
    const rasters = [];
    for (const [x, y, v] of [[35000, 78000, 1], [36000, 78000, 2], [35000, 79000, 3], [36000, 79000, 4]]) {
      rasters.push(await readGeoTiff(await makeTiff(x, y, () => v), { fromArrayBuffer }));
    }
    const region = sheetOver(35000, 78000, 2000, 2000);
    const { field, coverage, tilesUsed } = buildHeightFieldFromRasters({
      region, rasters, fieldWidth: 40, fieldHeight: 40,
    });

    expect(tilesUsed).toBe(4);
    expect(coverage).toBeGreaterThan(0.95);
    // All four values must be present somewhere in the field.
    const seen = new Set(Array.from(field.data, (v) => Math.round(v)));
    expect([...seen].sort()).toEqual([1, 2, 3, 4]);
  });

  it('leaves ground it has no tile for as nodata, and says how much', async () => {
    const bytes = await makeTiff(35000, 78000, () => 500);
    const raster = await readGeoTiff(bytes, { fromArrayBuffer });
    // A sheet twice as wide as the single tile covering it.
    const region = sheetOver(35000, 78000, 2000, 1000);

    const { field, coverage } = buildHeightFieldFromRasters({
      region, rasters: [raster], fieldWidth: 40, fieldHeight: 20,
    });

    expect(coverage).toBeGreaterThan(0.4);
    expect(coverage).toBeLessThan(0.6);
    expect(Array.from(field.data).some((v) => isNoData(v))).toBe(true);
    expect(computeRange(field).minHeight).toBeCloseTo(500, 1);
  });

  it('treats the unflown value as absent rather than as an elevation', async () => {
    const bytes = await makeTiff(35000, 78000, () => -999);
    const raster = await readGeoTiff(bytes, { fromArrayBuffer });
    const region = sheetOver(35000, 78000, 1000, 1000);
    const { field, coverage } = buildHeightFieldFromRasters({
      region, rasters: [raster], fieldWidth: 20, fieldHeight: 20,
    });
    // The tile is there, so it is covered, but nothing in it is elevation.
    expect(coverage).toBeGreaterThan(0.9);
    expect(computeRange(field).isEmpty).toBe(true);
  });

  it('produces an empty field rather than throwing when given no tiles', () => {
    const region = sheetOver(35000, 78000, 1000, 1000);
    const { field, coverage, tilesUsed } = buildHeightFieldFromRasters({
      region, rasters: [], fieldWidth: 10, fieldHeight: 10,
    });
    expect(tilesUsed).toBe(0);
    expect(coverage).toBe(0);
    expect(computeRange(field).isEmpty).toBe(true);
  });

  it('carries the region onto the field, so tracks and tilt still work', async () => {
    const bytes = await makeTiff(35000, 78000, () => 100);
    const raster = await readGeoTiff(bytes, { fromArrayBuffer });
    const region = sheetOver(35000, 78000, 1000, 1000);
    const { field } = buildHeightFieldFromRasters({
      region, rasters: [raster], fieldWidth: 10, fieldHeight: 10,
    });
    expect(field.region).toBe(region);
  });

  it('needs a region', () => {
    expect(() => buildHeightFieldFromRasters({ rasters: [], fieldWidth: 4, fieldHeight: 4 }))
      .toThrow(/region/i);
  });
});

describe('resolutionAdvice', () => {
  it('says the pen is the limit on a wide sheet', () => {
    // 20km across A3: 51m per mm, so 50cm data gives a hundred samples per mm.
    const a = resolutionAdvice(20000, 390, 0.5);
    expect(a.dataIsTheLimit).toBe(false);
    expect(a.worthIt).toBe(false);
  });

  it('says fine data is worth it on a close-up', () => {
    // 500m across A3 is 1.3m per mm, where even 50cm data starts to show.
    const a = resolutionAdvice(500, 390, 0.5);
    expect(a.worthIt).toBe(true);
  });

  it('spots data too coarse for the sheet', () => {
    // 2km across A3 with 30m tiles: a sample covers most of a millimetre.
    const a = resolutionAdvice(2000, 390, 30);
    expect(a.dataIsTheLimit).toBe(true);
  });
});
