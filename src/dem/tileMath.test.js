import { describe, it, expect } from 'vitest';
import {
  lngToTileX, latToTileY, tileXToLng, tileYToLat,
  tileRangeForBbox, chooseZoom, fieldToLngLat, MAX_LATITUDE,
} from './tileMath';

describe('tile projection', () => {
  it('puts the origin at the centre of the world', () => {
    expect(lngToTileX(0, 0)).toBeCloseTo(0.5, 12);
    expect(latToTileY(0, 0)).toBeCloseTo(0.5, 12);
  });

  it('puts the antimeridian at the edges', () => {
    expect(lngToTileX(-180, 0)).toBeCloseTo(0, 12);
    expect(lngToTileX(180, 0)).toBeCloseTo(1, 12);
  });

  it('round-trips longitude and latitude', () => {
    for (const lng of [-179, -45, 0, 12.34, 179]) {
      expect(tileXToLng(lngToTileX(lng, 12), 12)).toBeCloseTo(lng, 9);
    }
    for (const lat of [-84, -33.3, 0, 46.85, 84]) {
      expect(tileYToLat(latToTileY(lat, 12), 12)).toBeCloseTo(lat, 9);
    }
  });

  it('clamps beyond the Mercator limit instead of returning infinity', () => {
    expect(Number.isFinite(latToTileY(89.9, 10))).toBe(true);
    expect(latToTileY(90, 10)).toBeCloseTo(latToTileY(MAX_LATITUDE, 10), 9);
  });

  it('agrees with the tile verified against real elevation data', () => {
    // The z10 tile over Mount Rainier, confirmed to decode to a 4370m maximum.
    expect(Math.floor(lngToTileX(-121.7603, 10))).toBe(165);
    expect(Math.floor(latToTileY(46.8523, 10))).toBe(360);
  });
});

describe('tileRangeForBbox', () => {
  const bbox = { west: -121.9, south: 46.75, east: -121.6, north: 46.95 };

  it('covers the box inclusively', () => {
    const r = tileRangeForBbox(bbox, 10);
    expect(r.minX).toBeLessThanOrEqual(165);
    expect(r.maxX).toBeGreaterThanOrEqual(165);
    expect(r.count).toBe(r.width * r.height);
  });

  it('puts north at the smaller row index', () => {
    const r = tileRangeForBbox(bbox, 12);
    expect(r.minY).toBeLessThanOrEqual(r.maxY);
    expect(latToTileY(bbox.north, 12)).toBeLessThan(latToTileY(bbox.south, 12));
  });

  it('never needs fewer tiles at a higher zoom', () => {
    // Growth is not a clean fourfold per level: for a box smaller than a tile the
    // inclusive edges dominate, so 1x1 at z8 becomes only 2x2 at z10.
    let previous = 0;
    for (let zoom = 8; zoom <= 14; ++zoom) {
      const count = tileRangeForBbox(bbox, zoom).count;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
    expect(tileRangeForBbox(bbox, 14).count).toBeGreaterThan(
      tileRangeForBbox(bbox, 8).count
    );
  });
});

describe('chooseZoom', () => {
  const bbox = { west: -121.9, south: 46.75, east: -121.6, north: 46.95 };

  it('never exceeds the tile budget', () => {
    const zoom = chooseZoom(bbox, { maxZoom: 15, tileBudget: 16 });
    expect(tileRangeForBbox(bbox, zoom).count).toBeLessThanOrEqual(16);
  });

  it('takes the most detail the budget allows', () => {
    const zoom = chooseZoom(bbox, { maxZoom: 15, tileBudget: 16 });
    expect(tileRangeForBbox(bbox, zoom + 1).count).toBeGreaterThan(16);
  });

  it('respects the source maximum zoom', () => {
    expect(chooseZoom(bbox, { maxZoom: 12, tileBudget: 10000 })).toBe(12);
  });

  it('falls back to the minimum for a whole-world box', () => {
    const world = { west: -180, south: -85, east: 180, north: 85 };
    expect(chooseZoom(world, { maxZoom: 15, tileBudget: 4 })).toBeLessThanOrEqual(1);
  });
});

describe('fieldToLngLat', () => {
  const bbox = { west: -10, south: 40, east: -8, north: 42 };

  it('maps the field corners to the box corners', () => {
    expect(fieldToLngLat(bbox, 100, 100, 0, 0).lng).toBeCloseTo(-10, 9);
    expect(fieldToLngLat(bbox, 100, 100, 0, 0).lat).toBeCloseTo(42, 9);
    expect(fieldToLngLat(bbox, 100, 100, 100, 100).lng).toBeCloseTo(-8, 9);
    expect(fieldToLngLat(bbox, 100, 100, 100, 100).lat).toBeCloseTo(40, 9);
  });

  it('interpolates latitude in projected space, not linearly', () => {
    // A linear midpoint would be exactly 41; Mercator puts it slightly north.
    const mid = fieldToLngLat(bbox, 100, 100, 50, 50).lat;
    expect(mid).not.toBeCloseTo(41, 6);
    expect(mid).toBeGreaterThan(41);
    expect(mid).toBeLessThan(41.01);
  });

  it('keeps rows evenly spaced in projected space', () => {
    const y = (v) => latToTileY(fieldToLngLat(bbox, 10, 10, 0, v).lat, 0);
    expect(y(2) - y(1)).toBeCloseTo(y(8) - y(7), 12);
  });
});

describe('lngLatToField', () => {
  const bbox = { west: -10, south: 40, east: -8, north: 42 };

  it('inverts fieldToLngLat', async () => {
    const { lngLatToField } = await import('./tileMath');
    for (const [x, y] of [[0, 0], [25, 75], [100, 100], [13.5, 61.25]]) {
      const { lng, lat } = fieldToLngLat(bbox, 100, 100, x, y);
      const back = lngLatToField(bbox, 100, 100, lng, lat);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('puts a northern point near the top of the field', async () => {
    const { lngLatToField } = await import('./tileMath');
    expect(lngLatToField(bbox, 100, 100, -9, 41.9).y).toBeLessThan(10);
  });
});

describe('createRegion', () => {
  const bbox = { west: -8.0, south: 40.1, east: -7.2, north: 40.6 };

  it('agrees with the north-up mapping it replaces', async () => {
    const { regionFromBbox } = await import('./tileMath');
    const region = regionFromBbox(bbox);
    for (const [x, y] of [[0, 0], [100, 0], [0, 100], [37, 63], [100, 100]]) {
      const a = region.toLngLat(100, 100, x, y);
      const b = fieldToLngLat(bbox, 100, 100, x, y);
      expect(a.lng).toBeCloseTo(b.lng, 12);
      expect(a.lat).toBeCloseTo(b.lat, 12);
    }
  });

  it('round-trips a point through the field and back', async () => {
    const { regionFromBbox } = await import('./tileMath');
    const region = regionFromBbox(bbox);
    for (const [x, y] of [[0, 0], [25, 75], [100, 100], [13.5, 61.25]]) {
      const { lng, lat } = region.toLngLat(100, 100, x, y);
      const back = region.fromLngLat(100, 100, lng, lat);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.y).toBeCloseTo(y, 9);
    }
  });

  it('round-trips just as exactly when the sheet is rotated', async () => {
    const { createRegion, lngToTileX, latToTileY, tileXToLng, tileYToLat } =
      await import('./tileMath');

    // Build a sheet turned 30 degrees, directly in projected space.
    const cx = lngToTileX(-7.6, 0);
    const cy = latToTileY(40.35, 0);
    const a = (30 * Math.PI) / 180;
    const halfW = 0.0008;
    const halfH = 0.0005;
    const corner = (sx, sy) => ({
      lng: tileXToLng(cx + sx * halfW * Math.cos(a) - sy * halfH * Math.sin(a), 0),
      lat: tileYToLat(cy + sx * halfW * Math.sin(a) + sy * halfH * Math.cos(a), 0),
    });
    const region = createRegion({
      nw: corner(-1, -1),
      ne: corner(1, -1),
      sw: corner(-1, 1),
    });

    for (const [x, y] of [[0, 0], [200, 0], [0, 140], [200, 140], [83, 57]]) {
      const { lng, lat } = region.toLngLat(200, 140, x, y);
      const back = region.fromLngLat(200, 140, lng, lat);
      expect(back.x).toBeCloseTo(x, 8);
      expect(back.y).toBeCloseTo(y, 8);
    }
  });

  it('reports a bounding box that contains a rotated sheet', async () => {
    const { createRegion } = await import('./tileMath');
    const region = createRegion({
      nw: { lng: -7.7, lat: 40.4 },
      ne: { lng: -7.4, lat: 40.5 },
      sw: { lng: -7.75, lat: 40.2 },
    });
    // Every corner, including the implied fourth, must lie inside the box.
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const { lng, lat } = region.toLngLat(1, 1, x, y);
      expect(lng).toBeGreaterThanOrEqual(region.bbox.west - 1e-9);
      expect(lng).toBeLessThanOrEqual(region.bbox.east + 1e-9);
      expect(lat).toBeGreaterThanOrEqual(region.bbox.south - 1e-9);
      expect(lat).toBeLessThanOrEqual(region.bbox.north + 1e-9);
    }
  });

  it('needs a region with area', async () => {
    const { createRegion } = await import('./tileMath');
    expect(() =>
      createRegion({
        nw: { lng: 0, lat: 0 },
        ne: { lng: 1, lat: 0 },
        sw: { lng: 2, lat: 0 },
      })
    ).toThrow(/collinear|area/i);
  });
});
