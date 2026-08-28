/**
 * Registry of elevation (DEM) sources.
 *
 * Two kinds exist, and the difference is structural rather than cosmetic:
 *
 *  - `rgb-tiles` — a slippy-map tile URL template plus a decode function. These drop
 *    straight into the tile fetcher in ../getRegionElevation.js.
 *  - `bbox-api`  — a bounding-box request returning a raster (GeoTIFF) that must be
 *    decoded and reprojected onto the render grid. Staged later; not implemented yet.
 */

export const DEM_SOURCES = {
  terrarium: {
    id: 'terrarium',
    name: 'AWS Terrain Tiles (Terrarium)',
    kind: 'rgb-tiles',
    // Open data on S3. No API key, no account.
    urlTemplate: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    tilePixels: 256,
    maxZoom: 15,
    requiresToken: false,
    attribution:
      'Elevation: AWS Terrain Tiles (SRTM, NED and others), via the AWS Open Data programme',
    // Terrarium packs 16 bits of integer metres plus 8 bits of fraction, offset by 32768.
    decode(r, g, b) {
      return r * 256 + g + b / 256 - 32768;
    },
  },

  'mapbox-terrain-rgb': {
    id: 'mapbox-terrain-rgb',
    name: 'Mapbox Terrain-RGB',
    kind: 'rgb-tiles',
    urlTemplate:
      'https://api.mapbox.com/v4/mapbox.terrain-rgb/{z}/{x}/{y}@2x.pngraw?access_token={token}',
    tilePixels: 512,
    maxZoom: 15,
    requiresToken: true,
    tokenEnvVar: 'VITE_MAPBOX_TOKEN',
    attribution: 'Elevation: Mapbox Terrain-RGB',
    decode(r, g, b) {
      return -10000 + (r * 65536 + g * 256 + b) * 0.1;
    },
  },
};

export const DEFAULT_DEM_SOURCE = 'terrarium';

/**
 * Resolve a source by id, returning null (rather than throwing) when it needs a token
 * that has not been supplied, so the UI can disable it with a reason instead of
 * failing a render.
 */
export function getDemSource(id) {
  const source = DEM_SOURCES[id];
  if (!source) return null;
  if (source.requiresToken && !getToken(source)) return null;
  return source;
}

export function getToken(source) {
  if (!source.tokenEnvVar) return null;
  return import.meta.env?.[source.tokenEnvVar] || null;
}

/** Reason a source is unavailable, for display in the source picker. */
export function unavailableReason(id) {
  const source = DEM_SOURCES[id];
  if (!source) return `Unknown elevation source "${id}"`;
  if (source.requiresToken && !getToken(source)) {
    return `${source.name} needs a token in ${source.tokenEnvVar}`;
  }
  return null;
}

export function tileUrl(source, z, x, y) {
  return source.urlTemplate
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
    .replace('{token}', getToken(source) || '');
}

export function listSources() {
  return Object.values(DEM_SOURCES).map((source) => ({
    id: source.id,
    name: source.name,
    available: !unavailableReason(source.id),
    reason: unavailableReason(source.id),
  }));
}
