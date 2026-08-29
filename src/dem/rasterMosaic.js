/**
 * Sampling a set of projected rasters as if they were one surface.
 *
 * The Portuguese LiDAR products arrive as separate GeoTIFFs, one per square
 * kilometre of the national grid, each in EPSG:3763. A sheet usually spans
 * several, and often not all of them are present: a region may straddle the
 * coast, or cover ground that was never flown, or the reader may simply have
 * been given some of the tiles and not others.
 *
 * So this is deliberately tolerant. Missing ground is nodata rather than an
 * error, tiles need not be contiguous, and nothing here knows about GeoTIFF or
 * the network: a raster is a rectangle of numbers with a position, which is what
 * makes the sampling testable without decoding anything.
 */
import { NODATA } from '../core/heightField';

/**
 * @typedef {object} Raster
 * @property {number} minX  - projected coordinates of the raster's extent
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 * @property {number} width  - pixels
 * @property {number} height
 * @property {ArrayLike<number>} data - row-major, width*height
 * @property {number} [noData] - value standing for absent ground
 */

/**
 * Index a set of rasters for point lookup.
 *
 * Rasters are bucketed by a grid the size of the first one, so finding the
 * raster under a point does not mean testing them all. With a few hundred
 * square-kilometre tiles that hardly matters; with a whole municipality it does.
 */
export function createMosaic(rasters) {
  const usable = rasters.filter(
    (r) => r && r.width > 0 && r.height > 0 && r.data && r.maxX > r.minX && r.maxY > r.minY
  );

  if (usable.length === 0) {
    return {
      count: 0,
      bounds: null,
      sampleAt: () => NODATA,
      covers: () => false,
    };
  }

  const bounds = {
    minX: Math.min(...usable.map((r) => r.minX)),
    minY: Math.min(...usable.map((r) => r.minY)),
    maxX: Math.max(...usable.map((r) => r.maxX)),
    maxY: Math.max(...usable.map((r) => r.maxY)),
  };

  // Cell size follows the tiles themselves, so each bucket holds about one.
  const cell = Math.max(1, usable[0].maxX - usable[0].minX);
  const buckets = new Map();
  const key = (cx, cy) => cx + ',' + cy;

  for (const raster of usable) {
    const x0 = Math.floor(raster.minX / cell);
    const x1 = Math.floor((raster.maxX - 1e-9) / cell);
    const y0 = Math.floor(raster.minY / cell);
    const y1 = Math.floor((raster.maxY - 1e-9) / cell);
    for (let cy = y0; cy <= y1; ++cy) {
      for (let cx = x0; cx <= x1; ++cx) {
        const k = key(cx, cy);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(raster);
      }
    }
  }

  function rasterAt(x, y) {
    const candidates = buckets.get(key(Math.floor(x / cell), Math.floor(y / cell)));
    if (!candidates) return null;
    for (const r of candidates) {
      if (x >= r.minX && x < r.maxX && y >= r.minY && y < r.maxY) return r;
    }
    return null;
  }

  return {
    count: usable.length,
    bounds,

    covers(x, y) {
      return rasterAt(x, y) !== null;
    },

    /**
     * Nearest-neighbour sample at a projected coordinate.
     *
     * Nearest rather than bilinear on purpose: at 50cm the pixels are far finer
     * than anything a pen resolves, so interpolating buys nothing and would
     * smear the nodata edges of a tile into its neighbour.
     */
    sampleAt(x, y) {
      const r = rasterAt(x, y);
      if (!r) return NODATA;

      // Rasters are north-up: the first row is the top, at maxY.
      const px = Math.floor(((x - r.minX) / (r.maxX - r.minX)) * r.width);
      const py = Math.floor(((r.maxY - y) / (r.maxY - r.minY)) * r.height);
      if (px < 0 || py < 0 || px >= r.width || py >= r.height) return NODATA;

      const value = r.data[py * r.width + px];
      if (!Number.isFinite(value)) return NODATA;
      if (r.noData !== undefined && value === r.noData) return NODATA;
      // DGT writes -999 for absent ground, and float rasters rarely land on it
      // exactly by accident at these elevations.
      if (value <= -998 && value >= -1000) return NODATA;
      return value;
    },
  };
}

/**
 * How much of a sheet a mosaic actually covers, as a fraction.
 *
 * Worth knowing before rendering: a sheet half outside the flown area produces a
 * half-empty drawing, and it is better to say so than to let someone wonder.
 */
export function coverageOf(mosaic, toProjected, fieldWidth, fieldHeight, samples = 24) {
  if (!mosaic.count) return 0;

  let covered = 0;
  let total = 0;
  for (let j = 0; j < samples; ++j) {
    for (let i = 0; i < samples; ++i) {
      const x = ((i + 0.5) / samples) * fieldWidth;
      const y = ((j + 0.5) / samples) * fieldHeight;
      const p = toProjected(x, y);
      total += 1;
      if (mosaic.covers(p.x, p.y)) covered += 1;
    }
  }
  return covered / total;
}
