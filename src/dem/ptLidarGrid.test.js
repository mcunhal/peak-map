import { describe, it, expect, vi } from 'vitest';
import {
  lngLatToTM06, tm06ToLngLat, tileNameAt, tileNameForLngLat,
  tileBounds, tilesForBbox, infoUrl, metaUrl, pointsUrl, fetchTileInfo,
} from './ptLidarGrid';

describe('EPSG:3763', () => {
  it('puts the projection origin at zero', () => {
    const { x, y } = lngLatToTM06(-8.133108333333334, 39.668258333333333);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('round-trips across the country', () => {
    for (const [lng, lat] of [[-9.1, 38.7], [-7.6136, 40.3217], [-6.2, 41.8], [-8.9, 37.0]]) {
      const { x, y } = lngLatToTM06(lng, lat);
      const back = tm06ToLngLat(x, y);
      expect(back.lng).toBeCloseTo(lng, 8);
      expect(back.lat).toBeCloseTo(lat, 8);
    }
  });

  it('agrees with the coordinates the service reports for a known tile', () => {
    // DGT gives tile 235379 an origin of x=35000, y=78000. Its centre should
    // land in Seia, which is what /info says the tile belongs to.
    const { lng, lat } = tm06ToLngLat(35500, 78500);
    expect(lat).toBeCloseTo(40.374, 2);
    expect(lng).toBeCloseTo(-7.715, 2);
  });
});

describe('tile naming', () => {
  it('reproduces names published in DGT index', () => {
    // Taken from LiDAR2024_2025_Secciona.gpkg, whose 91196 rows this formula
    // reproduces without a single mismatch.
    const known = [
      ['235379', 35000, 78000],
      ['286368', 86000, 67000],
      ['137177', -63000, -124000],
      ['258454', 58000, 153000],
      ['244379', 44000, 78000],
      ['286211', 86000, -90000],
      ['139344', -61000, 43000],
      ['157280', -43000, -21000],
    ];
    for (const [name, x, y] of known) {
      expect(tileNameAt(x, y)).toBe(name);
      expect(tileNameAt(x + 500, y + 500)).toBe(name);
    }
  });

  it('inverts back to the tile origin', () => {
    for (const name of ['235379', '137177', '286211']) {
      const b = tileBounds(name);
      expect(tileNameAt(b.minX, b.minY)).toBe(name);
      expect(b.maxX - b.minX).toBe(1000);
      expect(b.maxY - b.minY).toBe(1000);
    }
  });

  it('finds the tile holding Torre', () => {
    // The highest point of mainland Portugal, where Covilha, Manteigas and Seia
    // meet. The service reports exactly those three for this tile.
    expect(tileNameForLngLat(-7.6136, 40.3217)).toBe('244373');
  });

  it('rejects something that is not a tile name', () => {
    expect(() => tileBounds('not-a-tile')).toThrow(/tile name/i);
  });
});

describe('tilesForBbox', () => {
  const around = (lng, lat, d) => ({ west: lng - d, east: lng + d, south: lat - d, north: lat + d });

  it('covers a small region and includes the tile at its centre', () => {
    const bbox = around(-7.6136, 40.3217, 0.01);
    const tiles = tilesForBbox(bbox);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.map((t) => t.name)).toContain('244373');
  });

  it('grows with the region', () => {
    const small = tilesForBbox(around(-7.6136, 40.3217, 0.01)).length;
    const large = tilesForBbox(around(-7.6136, 40.3217, 0.05)).length;
    expect(large).toBeGreaterThan(small);
  });

  it('names every tile it returns consistently with its own origin', () => {
    for (const tile of tilesForBbox(around(-7.6136, 40.3217, 0.02))) {
      expect(tileNameAt(tile.minX, tile.minY)).toBe(tile.name);
    }
  });

  it('refuses a region too large to fetch, rather than trying', () => {
    // A whole country at one square kilometre per tile is tens of thousands.
    expect(() => tilesForBbox({ west: -9.5, east: -6.2, south: 37, north: 42 })).toThrow(
      /square kilometre|zoom in/i
    );
  });
});

describe('service URLs', () => {
  it('builds the info URL from a tile name', () => {
    expect(infoUrl('244373')).toBe('https://portugal3d.dgterritorio.gov.pt/info/LO-244373');
  });

  it('builds the metadata and point URLs from the filename the service gives', () => {
    const file = 'LO-244373-05-2024_v01.laz';
    expect(metaUrl(file)).toContain(`/laz/meta/${file}?location=portugal`);
    expect(pointsUrl(file)).toContain(`/laz/${file}?location=portugal`);
  });
});

describe('fetchTileInfo', () => {
  it('returns what the service says', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ exists: true, filename: 'LO-244373-05-2024_v01.laz' }),
    }));
    const info = await fetchTileInfo('244373', { fetchImpl });
    expect(info.filename).toBe('LO-244373-05-2024_v01.laz');
    expect(fetchImpl.mock.calls[0][0]).toContain('/info/LO-244373');
  });

  it('reports a tile that was never flown as absent rather than throwing', async () => {
    // About 8800 of the 91196 tiles are marked unavailable.
    const fetchImpl = vi.fn(async () => ({ ok: false }));
    expect(await fetchTileInfo('190434', { fetchImpl })).toEqual({ exists: false });
  });
});
