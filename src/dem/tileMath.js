/**
 * Web Mercator tile arithmetic.
 *
 * Upstream asked MapLibre's private transform for tile coverage and for the
 * geographic position of a screen pixel. Doing the arithmetic here instead means
 * the elevation pipeline depends on a bounding box and a zoom rather than on a live
 * map object, so it can run in a worker, under test, and against a private API that
 * may change without notice.
 */

/** Latitudes beyond this are outside the Web Mercator projection. */
export const MAX_LATITUDE = 85.0511287798066;

export function clampLatitude(lat) {
  return Math.min(MAX_LATITUDE, Math.max(-MAX_LATITUDE, lat));
}

/** Fractional tile x. Whole part is the tile index, fraction is the offset in it. */
export function lngToTileX(lng, zoom) {
  return ((lng + 180) / 360) * Math.pow(2, zoom);
}

export function latToTileY(lat, zoom) {
  const rad = (clampLatitude(lat) * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return y * Math.pow(2, zoom);
}

export function tileXToLng(x, zoom) {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

export function tileYToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Inclusive range of tile indices covering a bounding box.
 * Note north maps to the smaller y, since tile rows run top-down.
 */
export function tileRangeForBbox(bbox, zoom) {
  const { west, south, east, north } = bbox;
  const minX = Math.floor(lngToTileX(west, zoom));
  const maxX = Math.floor(lngToTileX(east, zoom));
  const minY = Math.floor(latToTileY(north, zoom));
  const maxY = Math.floor(latToTileY(south, zoom));

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    count: (maxX - minX + 1) * (maxY - minY + 1),
  };
}

/**
 * Highest zoom whose tile coverage stays within a tile budget, so a large region
 * degrades to coarser data instead of trying to download hundreds of tiles.
 */
export function chooseZoom(bbox, { maxZoom = 15, minZoom = 0, tileBudget = 64 } = {}) {
  for (let zoom = maxZoom; zoom > minZoom; --zoom) {
    if (tileRangeForBbox(bbox, zoom).count <= tileBudget) return zoom;
  }
  return minZoom;
}

/**
 * Geographic position of a sample in a field laid over a bounding box.
 *
 * Longitude is linear in Mercator, latitude is not, so the row is interpolated in
 * projected space. Sampling latitude linearly would stretch terrain towards the
 * poles.
 */
export function fieldToLngLat(bbox, fieldWidth, fieldHeight, x, y) {
  const lng = bbox.west + ((bbox.east - bbox.west) * x) / fieldWidth;

  const northY = latToTileY(bbox.north, 0);
  const southY = latToTileY(bbox.south, 0);
  const lat = tileYToLat(northY + ((southY - northY) * y) / fieldHeight, 0);

  return { lng, lat };
}
