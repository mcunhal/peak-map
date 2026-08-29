/**
 * The Portuguese LiDAR tile grid.
 *
 * DGT surveyed continental Portugal at high resolution and publishes it through
 * `portugal3d.dgterritorio.gov.pt`, which is CORS-open and accepts range requests.
 * What it serves is LAZ point clouds on a one-kilometre grid, not a raster, so
 * this module covers only the part that can be settled exactly: where a place on
 * the Earth falls in that grid, and what to ask for.
 *
 * The grid is EPSG:3763, ETRS89 / Portugal TM06. Tile names look opaque but are
 * not: they encode the tile's own grid position, and the relationship was checked
 * against all 91196 tiles in DGT's published index with no mismatches.
 *
 *     col = floor(x / 1000)
 *     row = floor(y / 1000)
 *     name = (col + 200) * 1000 + (row + 301)
 *
 * So nothing has to be shipped to look a tile up. Whether one exists is another
 * matter, and the answer comes from the service: about 8800 of those tiles were
 * not flown, and `/info` reports it.
 */

/** ETRS89 / Portugal TM06, on GRS80. */
const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = 2 * F - F * F;
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
const LAT0 = (39.668258333333333 * Math.PI) / 180;
const LON0 = (-8.133108333333334 * Math.PI) / 180;

const TILE_SIZE = 1000;
const COL_OFFSET = 200;
const ROW_OFFSET = 301;

const BASE = 'https://portugal3d.dgterritorio.gov.pt';

/** Meridional arc. */
function meridian(phi) {
  return (
    A *
    ((1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi))
  );
}

const M0 = meridian(LAT0);

/** WGS84 degrees to EPSG:3763 metres. */
export function lngLatToTM06(lng, lat) {
  const phi = (lat * Math.PI) / 180;
  const lam = (lng * Math.PI) / 180;

  const ep2 = E2 / (1 - E2);
  const N = A / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2;
  const C = ep2 * Math.cos(phi) ** 2;
  const D = (lam - LON0) * Math.cos(phi);

  const x =
    N * (D + ((1 - T + C) * D ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * D ** 5) / 120);
  const y =
    meridian(phi) -
    M0 +
    N *
      Math.tan(phi) *
      ((D * D) / 2 +
        ((5 - T + 9 * C + 4 * C * C) * D ** 4) / 24 +
        ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * D ** 6) / 720);

  return { x, y };
}

/** EPSG:3763 metres back to WGS84 degrees. */
export function tm06ToLngLat(x, y) {
  const mu = (M0 + y) / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);

  const ep2 = E2 / (1 - E2);
  const C1 = ep2 * Math.cos(phi1) ** 2;
  const T1 = Math.tan(phi1) ** 2;
  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1) ** 2);
  const R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(phi1) ** 2) ** 1.5;
  const D = x / N1;

  const lat =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);

  const lon =
    LON0 +
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
      Math.cos(phi1);

  return { lng: (lon * 180) / Math.PI, lat: (lat * 180) / Math.PI };
}

/** The tile name covering a point given in EPSG:3763 metres. */
export function tileNameAt(x, y) {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  return String((col + COL_OFFSET) * 1000 + (row + ROW_OFFSET)).padStart(6, '0');
}

/** The tile name covering a point given in degrees. */
export function tileNameForLngLat(lng, lat) {
  const { x, y } = lngLatToTM06(lng, lat);
  return tileNameAt(x, y);
}

/** Where a named tile sits, in EPSG:3763 metres. */
export function tileBounds(name) {
  const n = Number(name);
  if (!Number.isInteger(n)) throw new Error(`Not a tile name: ${name}`);
  const col = Math.floor(n / 1000) - COL_OFFSET;
  const row = (n % 1000) - ROW_OFFSET;
  return {
    minX: col * TILE_SIZE,
    minY: row * TILE_SIZE,
    maxX: (col + 1) * TILE_SIZE,
    maxY: (row + 1) * TILE_SIZE,
  };
}

/**
 * Every tile covering a geographic bounding box.
 *
 * The box is projected corner by corner and then bounded, which is a little
 * generous near the edges of the projection but never misses a tile.
 *
 * @param {object} bbox - {west, south, east, north} in degrees
 * @param {number} [limit] - refuse to enumerate more than this many
 */
export function tilesForBbox(bbox, limit = 400) {
  const corners = [
    lngLatToTM06(bbox.west, bbox.south),
    lngLatToTM06(bbox.east, bbox.south),
    lngLatToTM06(bbox.west, bbox.north),
    lngLatToTM06(bbox.east, bbox.north),
  ];

  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));

  const colFrom = Math.floor(minX / TILE_SIZE);
  const colTo = Math.floor(maxX / TILE_SIZE);
  const rowFrom = Math.floor(minY / TILE_SIZE);
  const rowTo = Math.floor(maxY / TILE_SIZE);

  const count = (colTo - colFrom + 1) * (rowTo - rowFrom + 1);
  if (count > limit) {
    throw new Error(
      `That region needs ${count} LiDAR tiles, over the limit of ${limit}. ` +
        `Each is a square kilometre, so zoom in.`
    );
  }

  const tiles = [];
  for (let row = rowFrom; row <= rowTo; ++row) {
    for (let col = colFrom; col <= colTo; ++col) {
      tiles.push({
        name: tileNameAt(col * TILE_SIZE, row * TILE_SIZE),
        minX: col * TILE_SIZE,
        minY: row * TILE_SIZE,
      });
    }
  }
  return tiles;
}

/** Where to ask whether a tile exists, and what its file is called. */
export function infoUrl(name) {
  return `${BASE}/info/LO-${name}`;
}

/** The octree hierarchy for a tile, a few tens of kilobytes. */
export function metaUrl(filename, location = 'portugal') {
  return `${BASE}/laz/meta/${filename}?location=${location}`;
}

/** The points themselves. Large: a full tile is hundreds of megabytes. */
export function pointsUrl(filename, location = 'portugal') {
  return `${BASE}/laz/${filename}?location=${location}`;
}

/**
 * Ask the service about a tile.
 * @returns {Promise<{exists: boolean, filename?: string, x?: number, y?: number}>}
 */
export async function fetchTileInfo(name, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(infoUrl(name), {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return { exists: false };
  return response.json();
}
