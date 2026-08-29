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
 * The area a sheet covers, as a quadrilateral.
 *
 * A bounding box cannot describe a rotated map, and a parallelogram cannot
 * describe a tilted one. Tilting the camera makes the visible ground a
 * trapezoid: at 55 degrees of pitch the far edge of the view spans nearly three
 * times the ground the near edge does. Taking three corners and assuming the
 * fourth gives a flat render that is merely larger, which is not a tilted map at
 * all.
 *
 * So the sheet is a projective map from the unit square onto four corners. That
 * is exactly what a camera does, it degenerates to the affine case when the
 * fourth corner completes the parallelogram, and it makes the far half of a
 * tilted sheet compress the way a view of a landscape actually does.
 *
 * @param {object} corners - {nw, ne, sw} and optionally {se}, each {lng, lat}.
 *   Without `se` the sheet is a parallelogram.
 */
export function createRegion({ nw, ne, sw, se = null }) {
  const P = (c) => [lngToTileX(c.lng, 0), latToTileY(c.lat, 0)];

  // Heckbert's unit-square-to-quadrilateral mapping, corners in the order
  // (0,0) (1,0) (1,1) (0,1).
  const [x0, y0] = P(nw);
  const [x1, y1] = P(ne);
  const [x3, y3] = P(sw);
  const [x2, y2] = se ? P(se) : [x1 + x3 - x0, y1 + y3 - y0];

  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  let a, b, c, d, e, f, g, h;

  if (Math.abs(sx) < 1e-15 && Math.abs(sy) < 1e-15) {
    // A parallelogram: no perspective term, so this is the affine case.
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const dx1 = x1 - x2, dx2 = x3 - x2;
    const dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-18) throw new Error('Region corners are degenerate');
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    c = x0;
    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
    f = y0;
  }

  const det = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-24) {
    throw new Error('Region corners are collinear; it has no area');
  }

  // Adjugate, for the inverse mapping.
  const iA = e - f * h, iB = c * h - b, iC = b * f - c * e;
  const iD = f * g - d, iE = a - c * g, iF = c * d - a * f;
  const iG = d * h - e * g, iH = b * g - a * h, iI = a * e - b * d;

  const xs = [x0, x1, x2, x3];
  const ys = [y0, y1, y2, y3];
  const bbox = {
    west: tileXToLng(Math.min(...xs), 0),
    east: tileXToLng(Math.max(...xs), 0),
    north: tileYToLat(Math.min(...ys), 0),
    south: tileYToLat(Math.max(...ys), 0),
  };

  return {
    corners: { nw, ne, sw, se: se || { lng: tileXToLng(x2, 0), lat: tileYToLat(y2, 0) } },
    bbox,
    /** True when the sheet has perspective, rather than being merely rotated. */
    perspective: g !== 0 || h !== 0,

    /** Where a field sample falls on the Earth. */
    toLngLat(fieldWidth, fieldHeight, x, y) {
      const u = x / fieldWidth;
      const v = y / fieldHeight;
      const w = g * u + h * v + 1;
      return {
        lng: tileXToLng((a * u + b * v + c) / w, 0),
        lat: tileYToLat((d * u + e * v + f) / w, 0),
      };
    },

    /** Where a place on the Earth falls in the field. */
    fromLngLat(fieldWidth, fieldHeight, lng, lat) {
      const X = lngToTileX(lng, 0);
      const Y = latToTileY(lat, 0);
      const w = iG * X + iH * Y + iI;
      return {
        x: ((iA * X + iB * Y + iC) / w) * fieldWidth,
        y: ((iD * X + iE * Y + iF) / w) * fieldHeight,
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

/**
 * How much the sheet is foreshortened, row by row.
 *
 * A tilted sheet projects the ground in perspective, but elevation was lifted by
 * a fixed amount everywhere, which makes the drawing a hybrid: a perspective
 * ground plane carrying orthographic heights. Distant hills then stand as tall as
 * near ones, and the way ridges overlap reads as wrong, because it is.
 *
 * In a real view a hill of a given height covers more of the image the nearer it
 * is, in exactly the proportion the ground does. So displacement is scaled by the
 * local image scale of the row, normalised so the middle of the sheet keeps the
 * height that was asked for.
 *
 * Returns null for a sheet with no perspective, where every row scales alike.
 */
export function regionRowScales(region, fieldWidth, fieldHeight) {
  if (!region || !region.perspective) return null;

  const midX = fieldWidth / 2;
  const scales = new Float64Array(fieldHeight);

  for (let y = 0; y < fieldHeight; ++y) {
    // Ground covered by one field unit across, at this row.
    const a = region.toLngLat(fieldWidth, fieldHeight, midX, y);
    const b = region.toLngLat(fieldWidth, fieldHeight, midX + 1, y);
    const ground = Math.hypot(
      lngToTileX(b.lng, 0) - lngToTileX(a.lng, 0),
      latToTileY(b.lat, 0) - latToTileY(a.lat, 0)
    );
    scales[y] = ground > 0 ? 1 / ground : 0;
  }

  const middle = scales[Math.floor(fieldHeight / 2)];
  if (!(middle > 0)) return null;
  for (let y = 0; y < fieldHeight; ++y) scales[y] /= middle;
  return scales;
}
