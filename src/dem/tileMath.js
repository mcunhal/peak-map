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

/**
 * Inverse of fieldToLngLat: where a geographic position falls in the field.
 * Used to place GPX tracks in the same coordinate space as the terrain.
 */
export function lngLatToField(bbox, fieldWidth, fieldHeight, lng, lat) {
  const x = ((lng - bbox.west) / (bbox.east - bbox.west)) * fieldWidth;

  const northY = latToTileY(bbox.north, 0);
  const southY = latToTileY(bbox.south, 0);
  const y = ((latToTileY(lat, 0) - northY) / (southY - northY)) * fieldHeight;

  return { x, y };
}

/**
 * Crop a bounding box to a target width/height ratio, keeping its centre.
 *
 * The map viewport and the sheet rarely share a shape: the window might be tall
 * and the paper landscape. Sampling the whole viewport onto a page-shaped grid
 * stretches the terrain, and leaves the drawing showing a different region from
 * the one that was framed. Cropping first means the sheet is exactly a
 * page-shaped piece of what is on screen.
 *
 * The comparison has to happen in projected space. A degree of longitude is much
 * shorter than a degree of latitude away from the equator, so comparing the two
 * in degrees would crop to the wrong shape by a factor of cos(latitude) - about
 * 0.77 at Serra da Estrela.
 *
 * @param {object} bbox   - {west, south, east, north}
 * @param {number} aspect - desired width divided by height
 */
export function cropBboxToAspect(bbox, aspect) {
  if (!(aspect > 0)) throw new Error('Aspect ratio must be positive');

  const west = lngToTileX(bbox.west, 0);
  const east = lngToTileX(bbox.east, 0);
  const north = latToTileY(bbox.north, 0);
  const south = latToTileY(bbox.south, 0);

  const centreX = (west + east) / 2;
  const centreY = (north + south) / 2;

  let halfWidth = (east - west) / 2;
  let halfHeight = (south - north) / 2;

  // Only ever shrink, so the result stays inside what the viewport shows.
  if (halfWidth / halfHeight > aspect) {
    halfWidth = halfHeight * aspect;
  } else {
    halfHeight = halfWidth / aspect;
  }

  return {
    west: tileXToLng(centreX - halfWidth, 0),
    east: tileXToLng(centreX + halfWidth, 0),
    north: tileYToLat(centreY - halfHeight, 0),
    south: tileYToLat(centreY + halfHeight, 0),
  };
}
