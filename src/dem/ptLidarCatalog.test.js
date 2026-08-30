import { describe, it, expect } from 'vitest';
import {
  searchTiles, chooseCollection, tileNameOf, cacheUrlFor, COLLECTIONS, ATTRIBUTION,
} from './ptLidarCatalog';

/** A fetch that answers with one canned body, and records what it was asked. */
function stubFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

/** Shaped like a real MDT-50cm search result. */
function feature(id, href = 'https://cdd.dgterritorio.gov.pt/dgt-be/v1/download/abc123') {
  return {
    id,
    collection: 'MDT-50cm',
    bbox: [-9.15, 38.72, -9.14, 38.73],
    assets: { data: { href, type: 'image/tiff; application=geotiff' } },
  };
}

describe('chooseCollection', () => {
  it('asks for 50cm only when the sheet is tight enough to show it', () => {
    // 500m across A3 is 1.3m per mm, where 50cm data still tells.
    expect(chooseCollection(500, 390)).toBe('MDT-50cm');
  });

  it('settles for 2m once the pen is the limit', () => {
    // 5km across A3: 50cm would be 25 samples per millimetre, invisible.
    expect(chooseCollection(5000, 390)).toBe('MDT-2m');
  });

  it('can ask for the surface model instead of the terrain', () => {
    expect(chooseCollection(500, 390, { kind: 'surface' })).toBe('MDS-50cm');
    expect(chooseCollection(5000, 390, { kind: 'surface' })).toBe('MDS-2m');
  });

  it('only ever names a collection that exists', () => {
    for (const w of [100, 500, 2000, 20000]) {
      for (const kind of ['terrain', 'surface']) {
        expect(COLLECTIONS[chooseCollection(w, 390, { kind })]).toBeDefined();
      }
    }
  });
});

describe('tileNameOf', () => {
  it('finds the grid number in a catalogue id', () => {
    expect(tileNameOf('MDT-50cm-111197-07-2024')).toBe('111197');
    expect(tileNameOf('MDS-50cm-236380-04-2024')).toBe('236380');
  });

  it('returns null rather than guessing', () => {
    expect(tileNameOf('ORTOS-2025-cog-25cm-431-2')).toBeNull();
    expect(tileNameOf(undefined)).toBeNull();
  });
});

describe('searchTiles', () => {
  const bbox = [-9.15, 38.72, -9.14, 38.73];

  it('asks the catalogue for the right box and collection', async () => {
    const f = stubFetch({ type: 'FeatureCollection', features: [feature('MDT-2m-111197-07-2024')] });
    await searchTiles({ bbox, collection: 'MDT-2m', fetchImpl: f });

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].body.bbox).toEqual(bbox);
    expect(f.calls[0].body.collections).toEqual(['MDT-2m']);
    expect(f.calls[0].init.method).toBe('POST');
  });

  it('reads a bare FeatureCollection', async () => {
    const f = stubFetch({ type: 'FeatureCollection', features: [feature('MDT-50cm-111197-07-2024')] });
    const tiles = await searchTiles({ bbox, collection: 'MDT-50cm', fetchImpl: f });

    expect(tiles).toHaveLength(1);
    expect(tiles[0].tileName).toBe('111197');
    expect(tiles[0].downloadUrl).toContain('/dgt-be/v1/download/');
  });

  it('reads the wrapped shape the same API also uses', async () => {
    const f = stubFetch({ status: 200, data: { features: [feature('MDT-50cm-111197-07-2024')] } });
    const tiles = await searchTiles({ bbox, collection: 'MDT-50cm', fetchImpl: f });
    expect(tiles).toHaveLength(1);
    expect(tiles[0].tileName).toBe('111197');
  });

  it('keys the cache on the full id, so a reflown tile is not served stale', async () => {
    const f = stubFetch({ features: [feature('MDT-50cm-111197-07-2024')] });
    const [tile] = await searchTiles({ bbox, collection: 'MDT-50cm', fetchImpl: f });
    // Same ground, later campaign, must not collide.
    expect(tile.cacheKey).toBe('MDT-50cm-111197-07-2024');
    expect(tile.cacheKey).not.toBe(tile.tileName);
  });

  it('drops entries it cannot place on the grid', async () => {
    const f = stubFetch({ features: [feature('MDT-50cm-111197-07-2024'), feature('nonsense')] });
    const tiles = await searchTiles({ bbox, collection: 'MDT-50cm', fetchImpl: f });
    expect(tiles).toHaveLength(1);
  });

  it('survives a tile with no asset rather than throwing', async () => {
    const bare = { id: 'MDT-2m-111197-07-2024', assets: {} };
    const f = stubFetch({ features: [bare] });
    const [tile] = await searchTiles({ bbox, collection: 'MDT-2m', fetchImpl: f });
    expect(tile.downloadUrl).toBeNull();
    expect(tile.tileName).toBe('111197');
  });

  it('says so when the catalogue refuses', async () => {
    const f = stubFetch({}, { ok: false, status: 503 });
    await expect(searchTiles({ bbox, collection: 'MDT-2m', fetchImpl: f })).rejects.toThrow(/503/);
  });

  it('refuses a bad bbox, an unknown collection, or no fetch', async () => {
    const f = stubFetch({ features: [] });
    await expect(searchTiles({ bbox: [1, 2], collection: 'MDT-2m', fetchImpl: f })).rejects.toThrow(/bbox/i);
    await expect(searchTiles({ bbox, collection: 'MDT-1cm', fetchImpl: f })).rejects.toThrow(/collection/i);
    await expect(searchTiles({ bbox, collection: 'MDT-2m' })).rejects.toThrow(/fetchImpl/i);
  });
});

describe('cacheUrlFor', () => {
  it('places a tile under the cache base', () => {
    expect(cacheUrlFor('MDT-2m-111197-07-2024', 'https://tiles.example/')).toBe(
      'https://tiles.example/MDT-2m-111197-07-2024.tif'
    );
  });

  it('is null when no cache is configured', () => {
    expect(cacheUrlFor('MDT-2m-111197-07-2024', null)).toBeNull();
  });
});

describe('attribution', () => {
  it('carries what CC-BY-4.0 requires', () => {
    expect(ATTRIBUTION.text).toMatch(/Direção-Geral do Território/);
    expect(ATTRIBUTION.license).toBe('CC-BY-4.0');
    expect(ATTRIBUTION.licenseUrl).toMatch(/creativecommons\.org/);
  });
});
