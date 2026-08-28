import { describe, it, expect, vi } from 'vitest';
import { buildHeightField } from './buildHeightField';
import { DEM_SOURCES } from './sources';
import { NODATA } from '../core/heightField';
import { tileXToLng, tileYToLat } from './tileMath';

const terrarium = DEM_SOURCES.terrarium;

/** Encode metres the way a Terrarium tile does. */
function encode(metres) {
  const v = Math.round((metres + 32768) * 256);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

/**
 * A tile loader that synthesises pixels from a function of geographic position, so
 * the sampling arithmetic can be checked against a known analytic surface.
 */
function syntheticLoader(elevationAt, { size = 256, fail = () => false } = {}) {
  return vi.fn(async (url) => {
    const [, z, x, y] = url.match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/).map(Number);
    if (fail(x, y)) throw new Error('simulated tile failure');

    const data = new Uint8ClampedArray(size * size * 4);
    for (let py = 0; py < size; ++py) {
      for (let px = 0; px < size; ++px) {
        const lng = tileXToLng(x + (px + 0.5) / size, z);
        const lat = tileYToLat(y + (py + 0.5) / size, z);
        const [r, g, b] = encode(elevationAt(lng, lat));
        const o = (py * size + px) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    return { width: size, height: size, data };
  });
}

const bbox = { west: -121.9, south: 46.75, east: -121.6, north: 46.95 };

describe('buildHeightField', () => {
  it('recovers a constant elevation surface', async () => {
    const { field } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 40, fieldHeight: 30,
      loadTile: syntheticLoader(() => 1234),
    });
    expect(field.width).toBe(40);
    expect(field.height).toBe(30);
    for (let i = 0; i < field.data.length; ++i) {
      expect(field.data[i]).toBeCloseTo(1234, 2);
    }
  });

  it('recovers a surface that varies with longitude', async () => {
    // Elevation rises eastwards, so the field must rise with x.
    const { field } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 50, fieldHeight: 10,
      loadTile: syntheticLoader((lng) => (lng + 122) * 1000),
    });
    for (let x = 1; x < field.width; ++x) {
      expect(field.get(x, 0)).toBeGreaterThan(field.get(x - 1, 0));
    }
  });

  it('puts north at the top of the field', async () => {
    const { field } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 10, fieldHeight: 50,
      loadTile: syntheticLoader((lng, lat) => lat * 100),
    });
    // Row 0 is the northern edge, so it must hold the higher value.
    expect(field.get(0, 0)).toBeGreaterThan(field.get(0, field.height - 1));
  });

  it('stays within the tile budget', async () => {
    const loadTile = syntheticLoader(() => 100);
    const { tileCount, zoom } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 20, fieldHeight: 20,
      tileBudget: 4, loadTile,
    });
    expect(tileCount).toBeLessThanOrEqual(4);
    expect(loadTile).toHaveBeenCalledTimes(tileCount);
    expect(zoom).toBeLessThanOrEqual(terrarium.maxZoom);
  });

  it('never asks for a zoom the source does not publish', async () => {
    const { zoom } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 10, fieldHeight: 10,
      // z15 over this box is ~550 tiles; tiny synthetic tiles keep the test quick
      // without changing the arithmetic under test.
      zoom: 22, loadTile: syntheticLoader(() => 0, { size: 8 }),
    });
    expect(zoom).toBe(terrarium.maxZoom);
  });

  it('marks a failed tile as nodata instead of sea level', async () => {
    const { field, missingTiles } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 40, fieldHeight: 40, zoom: 12,
      loadTile: syntheticLoader(() => 800, { fail: (x) => x % 2 === 0 }),
    });
    expect(missingTiles).toBeGreaterThan(0);
    const values = Array.from(field.data);
    expect(values).toContain(NODATA);
    // Everything that did load kept its real elevation.
    for (const v of values) {
      if (v !== NODATA) expect(v).toBeCloseTo(800, 2);
    }
  });

  it('fails loudly when no tile loads at all', async () => {
    await expect(
      buildHeightField({
        source: terrarium, bbox, fieldWidth: 10, fieldHeight: 10,
        loadTile: syntheticLoader(() => 0, { fail: () => true }),
      })
    ).rejects.toThrow(/no elevation tiles/i);
  });

  it('reports progress from download through sampling', async () => {
    const seen = [];
    await buildHeightField({
      source: terrarium, bbox, fieldWidth: 10, fieldHeight: 10,
      loadTile: syntheticLoader(() => 0),
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1].message).toMatch(/sampling/i);
    expect(seen[seen.length - 1].loaded).toBe(seen[seen.length - 1].total);
  });

  it('carries the bounding box onto the field', async () => {
    const { field } = await buildHeightField({
      source: terrarium, bbox, fieldWidth: 8, fieldHeight: 8,
      loadTile: syntheticLoader(() => 0),
    });
    expect(field.bbox).toEqual(bbox);
  });
});
