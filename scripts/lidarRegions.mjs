/**
 * The ground worth caching, and what it costs to cache it.
 *
 * Flat country makes dull topographic plots, so the plottable subset of
 * Portugal is far smaller than the country. Seeding these once covers most of
 * what anyone would draw; everything else fills in as it gets rendered.
 *
 * Serra da Estrela is the exception that earns 50cm: it is the one range where
 * sheets get tight enough for half-metre data to reach the paper.
 */
import { tilesForBbox } from '../src/dem/ptLidarGrid.js';

/** Measured from real files: 2000x2000 and 500x500 Float32, plus COG overviews. */
export const TILE_BYTES = { '50cm': 21_349_908, '2m': 1_333_744 };

export const SEED_REGIONS = [
  // [west, south, east, north]
  { name: 'Serra da Estrela', resolution: '50cm', bbox: [-7.85, 40.15, -7.30, 40.50] },
  { name: 'Peneda-Gerês', resolution: '2m', bbox: [-8.35, 41.65, -7.85, 42.05] },
  { name: 'Montesinho', resolution: '2m', bbox: [-7.15, 41.75, -6.55, 42.00] },
  { name: 'Alvão / Marão', resolution: '2m', bbox: [-8.15, 41.15, -7.75, 41.35] },
  { name: 'Serra do Açor', resolution: '2m', bbox: [-8.05, 40.10, -7.75, 40.35] },
  { name: 'Serra da Lousã', resolution: '2m', bbox: [-8.35, 40.00, -7.95, 40.20] },
  { name: 'São Mamede', resolution: '2m', bbox: [-7.50, 39.20, -7.20, 39.45] },
  { name: 'Montejunto', resolution: '2m', bbox: [-9.15, 39.15, -8.95, 39.25] },
  { name: 'Arrábida', resolution: '2m', bbox: [-9.10, 38.42, -8.85, 38.52] },
  { name: 'Sintra', resolution: '2m', bbox: [-9.50, 38.75, -9.32, 38.85] },
];

/** Collection name for a region, terrain unless the surface model is wanted. */
export function collectionFor(region, kind = 'terrain') {
  return `${kind === 'surface' ? 'MDS' : 'MDT'}-${region.resolution}`;
}

/**
 * How many tiles a region needs and roughly what they weigh.
 *
 * The tile count is exact — the grid is a formula — but the byte figure is an
 * estimate: tiles over water or outside the flown area do not exist, so the
 * real total is always somewhat lower.
 */
export function bboxObject([west, south, east, north]) {
  return { west, south, east, north };
}

export function estimateRegion(region, limit = 20000) {
  const tiles = tilesForBbox(bboxObject(region.bbox), limit);
  const bytes = tiles.length * TILE_BYTES[region.resolution];
  return { name: region.name, resolution: region.resolution, tiles: tiles.length, bytes };
}

export function estimateAll(regions = SEED_REGIONS) {
  const rows = regions.map((r) => estimateRegion(r));
  return { rows, totalTiles: rows.reduce((a, r) => a + r.tiles, 0), totalBytes: rows.reduce((a, r) => a + r.bytes, 0) };
}

/** R2 charges for storage past the free tier; egress is free, which is the point. */
export function monthlyCostUSD(bytes, { freeGB = 10, perGB = 0.015 } = {}) {
  const gb = bytes / 1e9;
  return Math.max(0, gb - freeGB) * perGB;
}

export function formatBytes(bytes) {
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
