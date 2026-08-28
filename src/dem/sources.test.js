import { describe, it, expect } from 'vitest';
import { DEM_SOURCES, tileUrl, listSources, unavailableReason } from './sources';

const terrarium = DEM_SOURCES.terrarium;
const mapbox = DEM_SOURCES['mapbox-terrain-rgb'];

describe('terrarium decode', () => {
  it('maps the zero-offset encoding to sea level', () => {
    // 32768 is the offset, so R=128,G=0,B=0 is exactly 0m.
    expect(terrarium.decode(128, 0, 0)).toBe(0);
  });

  it('decodes below sea level', () => {
    expect(terrarium.decode(127, 255, 0)).toBe(-1);
  });

  it('carries 1/256 m of fractional precision in the blue channel', () => {
    expect(terrarium.decode(128, 0, 128)).toBeCloseTo(0.5, 6);
  });

  it('decodes a realistic summit elevation', () => {
    // 4370m, the observed maximum on the z10 tile covering Mount Rainier.
    const metres = 4370;
    const v = metres + 32768;
    const r = Math.floor(v / 256);
    const g = v % 256;
    expect(terrarium.decode(r, g, 0)).toBeCloseTo(metres, 6);
  });
});

describe('mapbox terrain-rgb decode', () => {
  it('maps the zero-offset encoding to the documented floor', () => {
    expect(mapbox.decode(0, 0, 0)).toBeCloseTo(-10000, 6);
  });

  it('advances 0.1m per unit of the blue channel', () => {
    expect(mapbox.decode(0, 0, 1) - mapbox.decode(0, 0, 0)).toBeCloseTo(0.1, 6);
  });
});

describe('tileUrl', () => {
  it('substitutes z/x/y for a key-free source', () => {
    expect(tileUrl(terrarium, 10, 165, 360)).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/165/360.png'
    );
  });

  it('leaves no unsubstituted placeholders', () => {
    expect(tileUrl(terrarium, 1, 2, 3)).not.toMatch(/\{[a-z]+\}/);
  });
});

describe('source availability', () => {
  it('offers terrarium without any token', () => {
    expect(unavailableReason('terrarium')).toBeNull();
    expect(listSources().find((s) => s.id === 'terrarium').available).toBe(true);
  });

  it('explains why a token-gated source is unavailable rather than throwing', () => {
    const reason = unavailableReason('mapbox-terrain-rgb');
    expect(reason).toContain('VITE_MAPBOX_TOKEN');
  });

  it('reports unknown sources by name', () => {
    expect(unavailableReason('nope')).toContain('nope');
  });
});
