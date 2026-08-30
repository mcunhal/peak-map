import { describe, it, expect } from 'vitest';
import {
  normaliseName,
  matchFileToTile,
  loadFromCache,
  describeCoverage,
  describeCacheBase,
} from './lidarCache';

const tiles = [
  { cacheKey: 'MDT-50cm-236380-04-2024', tileName: '236380', collection: 'MDT-50cm' },
  { cacheKey: 'MDT-50cm-237380-04-2024', tileName: '237380', collection: 'MDT-50cm' },
];

describe('normaliseName', () => {
  it('strips the extension and the file version the catalogue id lacks', () => {
    expect(normaliseName('MDT-50cm-236380-04-2024_v01.tif')).toBe('MDT-50cm-236380-04-2024');
    expect(normaliseName('MDT-50cm-236380-04-2024.tiff')).toBe('MDT-50cm-236380-04-2024');
  });
});

describe('matchFileToTile', () => {
  it('matches the file the portal actually hands you', () => {
    expect(matchFileToTile('MDT-50cm-236380-04-2024_v01.tif', tiles).tileName).toBe('236380');
  });

  it('still matches when the campaign date differs from the catalogue', () => {
    // Reflown ground: same square, later campaign, file named for the new one.
    expect(matchFileToTile('MDT-50cm-237380-11-2025_v02.tif', tiles).tileName).toBe('237380');
  });

  it('refuses a surface tile offered for a terrain slot', () => {
    expect(matchFileToTile('MDS-50cm-236380-04-2024_v01.tif', tiles)).toBeNull();
  });

  it('returns null for something unrelated rather than guessing', () => {
    expect(matchFileToTile('holiday-photo.tif', tiles)).toBeNull();
    expect(matchFileToTile('MDT-50cm-999999-04-2024.tif', tiles)).toBeNull();
  });
});

describe('loadFromCache', () => {
  const bytes = new ArrayBuffer(8);

  it('returns everything as missing when no cache is configured', async () => {
    const { loaded, missing } = await loadFromCache({ tiles, base: null });
    expect(loaded).toHaveLength(0);
    expect(missing).toHaveLength(2);
  });

  it('fetches each tile by its cache key', async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return { ok: true, arrayBuffer: async () => bytes };
    };
    const { loaded, missing } = await loadFromCache({ tiles, base: 'https://tiles.test/', fetchImpl });

    expect(missing).toHaveLength(0);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].bytes).toBe(bytes);
    expect(asked[0]).toBe('https://tiles.test/MDT-50cm-236380-04-2024.tif');
  });

  it('treats a miss as ordinary, not as a failure', async () => {
    const fetchImpl = async (url) =>
      url.includes('236380') ? { ok: true, arrayBuffer: async () => bytes } : { ok: false, status: 404 };
    const { loaded, missing } = await loadFromCache({ tiles, base: 'https://tiles.test', fetchImpl });
    expect(loaded).toHaveLength(1);
    expect(missing).toHaveLength(1);
    expect(missing[0].tileName).toBe('237380');
  });

  it('treats a network error as a miss too, so one bad tile is not fatal', async () => {
    const fetchImpl = async () => {
      throw new Error('offline');
    };
    const { loaded, missing } = await loadFromCache({ tiles, base: 'https://tiles.test', fetchImpl });
    expect(loaded).toHaveLength(0);
    expect(missing).toHaveLength(2);
  });

  it('lets an abort through rather than swallowing it', async () => {
    const fetchImpl = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(loadFromCache({ tiles, base: 'https://tiles.test', fetchImpl })).rejects.toThrow(/abort/i);
  });

  it('reports progress as it goes', async () => {
    const seen = [];
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => bytes });
    await loadFromCache({ tiles, base: 'https://t', fetchImpl, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([{ loaded: 1, total: 2 }, { loaded: 2, total: 2 }]);
  });
});

describe('describeCoverage', () => {
  it('says when everything is ready', () => {
    expect(describeCoverage(tiles, tiles).text).toMatch(/All 2 tiles/);
  });

  it('says how far along it is', () => {
    expect(describeCoverage(tiles, [tiles[0]]).text).toBe('1 of 2 tiles ready');
  });

  it('says when nothing has arrived', () => {
    expect(describeCoverage(tiles, []).text).toMatch(/None of the 2/);
  });

  it('handles a sheet needing nothing', () => {
    expect(describeCoverage([], []).fraction).toBe(0);
  });
});

describe('describeCacheBase', () => {
  it('accepts an https base whatever the page is', () => {
    expect(describeCacheBase('https://tiles.example/lidar', 'https:').ok).toBe(true);
    expect(describeCacheBase('https://tiles.example/lidar', 'http:').ok).toBe(true);
  });

  it('accepts a plain http base on a plain http page', () => {
    expect(describeCacheBase('http://192.168.0.142:8080/lidar', 'http:').ok).toBe(true);
  });

  it('refuses a plain http base on an https page, and says why', () => {
    // The browser blocks this outright, and loadFromCache files a blocked
    // request as a miss — so without this the panel would report every tile
    // absent and give no hint that the page never asked for them.
    const verdict = describeCacheBase('http://192.168.0.142:8080/lidar', 'https:');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/https/i);
  });

  it('treats localhost as safe, because browsers do', () => {
    expect(describeCacheBase('http://localhost:8080/lidar', 'https:').ok).toBe(true);
    expect(describeCacheBase('http://127.0.0.1:8080/lidar', 'https:').ok).toBe(true);
  });

  it('reports an empty base as no cache rather than as a fault', () => {
    const verdict = describeCacheBase('', 'https:');
    expect(verdict.ok).toBe(false);
    expect(verdict.configured).toBe(false);
    expect(verdict.reason).toMatch(/no tile cache/i);
  });

  it('refuses something that is not a URL', () => {
    const verdict = describeCacheBase('192.168.0.142:8080', 'https:');
    expect(verdict.ok).toBe(false);
    expect(verdict.configured).toBe(true);
    expect(verdict.reason).toMatch(/url/i);
  });

  it('refuses a scheme that cannot serve tiles', () => {
    expect(describeCacheBase('ftp://tiles.example/lidar', 'https:').ok).toBe(false);
  });
});
