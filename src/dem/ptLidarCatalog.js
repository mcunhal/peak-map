/**
 * Naming the LiDAR tiles a sheet needs, using DGT's public catalogue.
 *
 * The STAC search at `cdd.dgterritorio.gov.pt/dgt-be/v1/search` needs no
 * account: anyone may ask which tiles cover a place and what they are called.
 * What it returns for each tile is a link to `/dgt-be/v1/download/<sha256>`,
 * which mints a presigned object-store URL — but only for a logged-in session,
 * and only to a non-browser client, since that endpoint sends no
 * `Access-Control-Allow-Origin`. So discovery happens here, in the page, and
 * fetching happens elsewhere: from our own cache, or from a file the user drops.
 *
 * The data is CC-BY-4.0 ("Acesso público sem restrições"), which is why caching
 * it is allowed at all. The STAC `license` field says "proprietary", but that is
 * STAC 1.0's placeholder for "not an SPDX id" left unfilled; the authoritative
 * INSPIRE record is the one that governs. See ATTRIBUTION in this module.
 */
import { resolutionAdvice } from './resolution.js';
import { tilesForBbox } from './ptLidarGrid.js';

export const SEARCH_URL = 'https://cdd.dgterritorio.gov.pt/dgt-be/v1/search';

/** Required by CC-BY-4.0, and carried into the SVG so a plotted sheet keeps it. */
export const ATTRIBUTION = {
  text: 'Dados LiDAR: Direção-Geral do Território (DGT), CC-BY-4.0',
  license: 'CC-BY-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  source: 'https://cdd.dgterritorio.gov.pt',
};

/** Terrain (bare earth) and surface (canopy and rooftops), at both resolutions. */
export const COLLECTIONS = {
  'MDT-50cm': { metres: 0.5, kind: 'terrain' },
  'MDT-2m': { metres: 2, kind: 'terrain' },
  'MDS-50cm': { metres: 0.5, kind: 'surface' },
  'MDS-2m': { metres: 2, kind: 'surface' },
};

/**
 * Which resolution actually earns its place on this sheet.
 *
 * 50cm is worth fetching only for a very tight sheet: past about three samples
 * per millimetre the pen cannot show the difference, and a 50cm tile is sixteen
 * times the bytes of the 2m one covering the same ground. Below roughly 600m
 * across, 50cm starts to tell; above it, 2m is indistinguishable on paper.
 */
export function chooseCollection(groundWidthM, drawableMm, { kind = 'terrain' } = {}) {
  const prefix = kind === 'surface' ? 'MDS' : 'MDT';
  const fine = resolutionAdvice(groundWidthM, drawableMm, 0.5);
  return fine.worthIt ? `${prefix}-50cm` : `${prefix}-2m`;
}

/**
 * The grid number embedded in a STAC item id, e.g. `MDT-50cm-111197-07-2024`.
 * It is the same six-digit name `tileNameAt` computes, which lets a catalogue
 * result be matched against a tile worked out offline.
 */
export function tileNameOf(itemId) {
  const m = String(itemId || '').match(/-(\d{6})-/);
  return m ? m[1] : null;
}

/** Both response shapes this API uses: bare FeatureCollection, or wrapped in `data`. */
function featuresOf(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.features)) return body.features;
  if (body.data && Array.isArray(body.data.features)) return body.data.features;
  return [];
}

/** The asset holding the raster; MDT/MDS call it `data`, orthos call it `visual`. */
function assetOf(feature) {
  const assets = feature.assets || {};
  return assets.data || assets.visual || Object.values(assets)[0] || null;
}

/**
 * Ask the catalogue which tiles cover a bounding box.
 *
 * @param {object} opts
 * @param {number[]} opts.bbox - [west, south, east, north] in degrees
 * @param {string} opts.collection - one of COLLECTIONS
 * @param {function} opts.fetchImpl - injected, so this is testable and so the
 *   worker and a node script can both use it
 * @returns {Promise<Array>} one entry per tile, with the id, grid name, and the
 *   download endpoint that a logged-in non-browser client can redeem
 */
export async function searchTiles({ bbox, collection, fetchImpl, limit = 400, signal }) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('A [w,s,e,n] bbox is required');
  if (!COLLECTIONS[collection]) throw new Error(`Unknown collection: ${collection}`);
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');

  const response = await fetchImpl(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bbox, collections: [collection], limit }),
    signal,
  });
  if (!response.ok) throw new Error(`Catalogue search failed: ${response.status}`);

  return featuresOf(await response.json())
    .map((feature) => {
      const asset = assetOf(feature);
      return {
        id: feature.id,
        collection: feature.collection || collection,
        tileName: tileNameOf(feature.id),
        // The full id, not the grid number: tiles carry a campaign date and a
        // version, and keying a cache on the number alone would silently serve
        // superseded data once an area is reflown.
        cacheKey: feature.id,
        downloadUrl: asset ? asset.href : null,
        bbox: feature.bbox || null,
      };
    })
    .filter((t) => t.tileName);
}

/**
 * What a sheet needs, whether or not the catalogue can be reached.
 *
 * The grid is a pure formula, so the tile names are known offline; the search
 * only adds the ids and download links. Keeping the two separable means the
 * panel can still say "this sheet needs these nine tiles" with no network.
 */
export function tilesForSheet(bbox, { limit = 400 } = {}) {
  return tilesForBbox(bbox, limit);
}

/** Where a cached tile lives, if a cache base is configured. */
export function cacheUrlFor(cacheKey, base) {
  if (!base) return null;
  return `${String(base).replace(/\/$/, '')}/${encodeURIComponent(cacheKey)}.tif`;
}
