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
