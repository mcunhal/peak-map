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
 * The area a sheet covers, as a rotated rectangle.
 *
 * A bounding box cannot describe a rotated map: turn the map and the box of the
 * visible area is both larger than what is on screen and the wrong shape. The
 * sheet is instead described by three of its corners, which is enough, because
 * the mapping from screen pixels to projected coordinates is an affine one -
 * a translation, a scale and a rotation. Interpolating between the corners is
 * therefore exact rather than an approximation, at any bearing.
 *
 * @param {object} corners - {nw, ne, sw}, each {lng, lat}
 */
export function createRegion({ nw, ne, sw }) {
  const originX = lngToTileX(nw.lng, 0);
  const originY = latToTileY(nw.lat, 0);

  // Edge vectors, in projected units, spanning the full width and height.
  const ux = lngToTileX(ne.lng, 0) - originX;
  const uy = latToTileY(ne.lat, 0) - originY;
  const vx = lngToTileX(sw.lng, 0) - originX;
  const vy = latToTileY(sw.lat, 0) - originY;

  const determinant = ux * vy - uy * vx;
  if (Math.abs(determinant) < 1e-18) {
    throw new Error('Region corners are collinear; it has no area');
  }

  // Tiles still have to be fetched over an axis-aligned box, so a rotated sheet
  // covers more of them than it draws.
  const xs = [originX, originX + ux, originX + vx, originX + ux + vx];
  const ys = [originY, originY + uy, originY + vy, originY + uy + vy];
  const bbox = {
    west: tileXToLng(Math.min(...xs), 0),
    east: tileXToLng(Math.max(...xs), 0),
    north: tileYToLat(Math.min(...ys), 0),
    south: tileYToLat(Math.max(...ys), 0),
  };

  return {
    corners: { nw, ne, sw },
    bbox,

    /** Where a field sample falls on the Earth. */
    toLngLat(fieldWidth, fieldHeight, x, y) {
      const s = x / fieldWidth;
      const t = y / fieldHeight;
      return {
        lng: tileXToLng(originX + ux * s + vx * t, 0),
        lat: tileYToLat(originY + uy * s + vy * t, 0),
      };
    },

    /** Where a place on the Earth falls in the field. */
    fromLngLat(fieldWidth, fieldHeight, lng, lat) {
      const px = lngToTileX(lng, 0) - originX;
      const py = latToTileY(lat, 0) - originY;
      return {
        x: ((px * vy - py * vx) / determinant) * fieldWidth,
        y: ((ux * py - uy * px) / determinant) * fieldHeight,
      };
    },
  };
}

/** A north-up region covering a bounding box. */
export function regionFromBbox(bbox) {
  return createRegion({
    nw: { lng: bbox.west, lat: bbox.north },
    ne: { lng: bbox.east, lat: bbox.north },
    sw: { lng: bbox.west, lat: bbox.south },
  });
}
