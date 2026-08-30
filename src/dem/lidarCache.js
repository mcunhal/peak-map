/**
 * Getting LiDAR tiles into the page: from our cache, or from dropped files.
 *
 * The page can never fetch from DGT directly — the download endpoint sends no
 * `Access-Control-Allow-Origin`, and it needs a session besides. So tiles reach
 * the browser by one of two routes, and this module is both of them.
 *
 * The cache is a plain object store keyed by the catalogue's item id, filled by
 * `scripts/fetchLidar.mjs`. Redistributing it is allowed because the data is
 * CC-BY-4.0; keeping the attribution with it is the condition of that.
 */

/** Filenames carry a version the catalogue id does not: `..._v01.tif`. */
export function normaliseName(name) {
  return String(name || '')
    .replace(/\.tiff?$/i, '')
    .replace(/_v\d+$/i, '')
    .trim();
}

/**
 * Match a dropped file to one of the tiles the sheet is waiting for.
 *
 * People drop whatever the portal gave them, so this is deliberately forgiving:
 * an exact id first, then the grid number and product, which is what actually
 * distinguishes one file from another on disk.
 */
export function matchFileToTile(filename, tiles) {
  const base = normaliseName(filename);
  const exact = tiles.find((t) => normaliseName(t.cacheKey) === base);
  if (exact) return exact;

  const m = base.match(/(MD[TS])-?(?:50cm|2m)?-?(\d{6})/i);
  if (!m) return null;
  const product = m[1].toUpperCase();
  const grid = m[2];
  return (
    tiles.find(
      (t) => t.tileName === grid && String(t.collection || '').toUpperCase().startsWith(product)
    ) || null
  );
}

/**
 * Try the cache for each tile, reporting what it did not have.
 *
 * A miss is ordinary — the cache holds the ground people plot, not the whole
 * country — so a 404 produces a `missing` entry rather than an error. Only an
 * abort is worth propagating.
 */
export async function loadFromCache({ tiles, base, fetchImpl = fetch, onProgress = null, signal = null }) {
  const loaded = [];
  const missing = [];
  if (!base) return { loaded, missing: [...tiles] };

  for (let i = 0; i < tiles.length; ++i) {
    const tile = tiles[i];
    const url = `${String(base).replace(/\/$/, '')}/${encodeURIComponent(tile.cacheKey)}.tif`;
    try {
      const res = await fetchImpl(url, { signal });
      if (res.ok) loaded.push({ ...tile, bytes: await res.arrayBuffer() });
      else missing.push(tile);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      missing.push(tile);
    }
    if (onProgress) onProgress({ loaded: i + 1, total: tiles.length });
  }

  return { loaded, missing };
}

/**
 * Whether a configured cache base can actually be fetched from this page.
 *
 * Worth a function of its own because the failure it catches is invisible. A
 * page served over HTTPS may not fetch `http://`, and the browser refuses
 * without ever sending the request; `loadFromCache` sees a rejected fetch and
 * files it as a miss, which is exactly what a genuine 404 looks like. The panel
 * would then report every tile absent, from a cache that is sitting there
 * working, and nothing would say the page had not asked.
 *
 * Localhost is exempt because browsers treat it as a secure context, which is
 * what makes `npm run dev` against a local tile server work.
 *
 * @param {string} base         - the configured base URL
 * @param {string} pageProtocol - `location.protocol`, so this stays testable
 */
export function describeCacheBase(base, pageProtocol = 'https:') {
  const value = String(base || '').trim();
  if (!value) {
    return { ok: false, configured: false, reason: 'No tile cache configured' };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, configured: true, reason: `Not a URL: ${value}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      configured: true,
      reason: `Tiles must be served over http or https, not ${url.protocol}`,
    };
  }

  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';

  if (pageProtocol === 'https:' && url.protocol === 'http:' && !isLocal) {
    return {
      ok: false,
      configured: true,
      reason:
        'This page is served over https, so the browser will block a plain http cache ' +
        'before it is even requested. Serve the tiles over https, or use the dev server.',
    };
  }

  return { ok: true, configured: true, reason: null };
}

/** What the panel says about a sheet: how much of it the tiles in hand cover. */
export function describeCoverage(needed, held) {
  if (!needed.length) return { fraction: 0, text: 'No LiDAR tiles needed for this sheet' };
  const fraction = held.length / needed.length;
  if (fraction >= 1) return { fraction, text: `All ${needed.length} tiles ready` };
  if (fraction === 0) return { fraction, text: `None of the ${needed.length} tiles are loaded yet` };
  return { fraction, text: `${held.length} of ${needed.length} tiles ready` };
}
