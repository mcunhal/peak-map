/**
 * Builds a HeightField for a geographic bounding box from a tiled DEM source.
 *
 * The tile loader is injected. In the browser or a worker it decodes PNGs; in tests
 * it hands back synthetic pixels, which is what lets the sampling arithmetic be
 * checked without a network.
 */
import { createHeightField, NODATA } from '../core/heightField';
import {
  chooseZoom,
  tileRangeForBbox,
  regionFromBbox,
  lngToTileX,
  latToTileY,
} from './tileMath';
import { tileUrl } from './sources';

/** Decode a tile URL to RGBA pixels. Works on a worker thread. */
export async function loadTilePixels(url, { signal } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Tile request failed with ${response.status}: ${url}`);
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  // Read the dimensions before releasing the bitmap. Closing it sets width and
  // height to zero, and reading them afterwards yields a tile that claims to be
  // empty, so every sample indexes out of bounds and becomes nodata.
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  return { width, height, data };
}

/**
 * @param {object} options
 * @param {object} options.source      - a DEM source descriptor from ./sources
 * @param {object} options.bbox        - {west, south, east, north}
 * @param {number} options.fieldWidth  - samples across
 * @param {number} options.fieldHeight - samples down
 * @param {number} [options.sheetHeight] - how many of those rows land on the sheet,
 *   when the field is extended below it; see `sheetRows` in core/heightField
 * @param {number} [options.zoom]      - forced zoom; otherwise chosen from the budget
 * @param {number} [options.tileBudget]
 * @param {Function} [options.loadTile] - (url, {signal}) => {width, height, data}
 * @param {Function} [options.onProgress] - ({loaded, total, message})
 */
export async function buildHeightField({
  source,
  bbox,
  region: suppliedRegion = null,
  fieldWidth,
  fieldHeight,
  sheetHeight = null,
  zoom = null,
  tileBudget = 64,
  loadTile = loadTilePixels,
  onProgress = null,
  signal = null,
}) {
  if (!source) throw new Error('An elevation source is required');
  if (!(fieldWidth > 0) || !(fieldHeight > 0)) {
    throw new Error('Field dimensions must be positive');
  }

  // A plain bounding box is just a region that happens to be north-up.
  const region = suppliedRegion || regionFromBbox(bbox);
  const coverage = region.bbox;

  const chosenZoom =
    zoom === null
      ? chooseZoom(coverage, { maxZoom: source.maxZoom ?? 15, tileBudget })
      : Math.min(zoom, source.maxZoom ?? 15);

  const range = tileRangeForBbox(coverage, chosenZoom);
  const report = (loaded, message) =>
    onProgress && onProgress({ loaded, total: range.count, message });

  report(0, `Downloading ${range.count} elevation tiles`);

  // Fetch every tile, keeping failures as gaps rather than failing the whole render.
  const tiles = new Map();
  let loaded = 0;
  await Promise.all(
    Array.from({ length: range.count }, (_, i) => {
      const tx = range.minX + (i % range.width);
      const ty = range.minY + Math.floor(i / range.width);
      return loadTile(tileUrl(source, chosenZoom, tx, ty), { signal })
        .then((pixels) => {
          // A tile with no dimensions is unusable, and must be counted as missing
          // rather than quietly turning its whole area into nodata.
          const usable = pixels && pixels.width > 0 && pixels.height > 0 && pixels.data;
          tiles.set(`${tx},${ty}`, usable ? pixels : null);
        })
        .catch(() => tiles.set(`${tx},${ty}`, null))
        .finally(() => report(++loaded, `Downloaded ${loaded} of ${range.count} tiles`));
    })
  );

  if (![...tiles.values()].some(Boolean)) {
    throw new Error(
      `No elevation tiles could be loaded for this region from ${source.name}`
    );
  }

  report(range.count, 'Sampling elevation');

  const data = new Float32Array(fieldWidth * fieldHeight);
  const { decode } = source;

  for (let y = 0; y < fieldHeight; ++y) {
    for (let x = 0; x < fieldWidth; ++x) {
      // Sample at pixel centres so the field is not biased half a cell north-west.
      const { lng, lat } = region.toLngLat(fieldWidth, fieldHeight, x + 0.5, y + 0.5);

      const globalX = lngToTileX(lng, chosenZoom);
      const globalY = latToTileY(lat, chosenZoom);
      const tx = Math.floor(globalX);
      const ty = Math.floor(globalY);

      const tile = tiles.get(`${tx},${ty}`);
      if (!tile) {
        data[y * fieldWidth + x] = NODATA;
        continue;
      }

      const px = Math.min(tile.width - 1, Math.floor((globalX - tx) * tile.width));
      const py = Math.min(tile.height - 1, Math.floor((globalY - ty) * tile.height));
      const offset = (py * tile.width + px) * 4;

      data[y * fieldWidth + x] = decode(
        tile.data[offset],
        tile.data[offset + 1],
        tile.data[offset + 2]
      );
    }
  }

  return {
    field: createHeightField({
      width: fieldWidth,
      height: fieldHeight,
      data,
      // Report the box that was asked for when one was; deriving it back from
      // the region round-trips through the projection and changes the last few
      // digits for no reason. A rotated region has no such box of its own.
      bbox: suppliedRegion ? coverage : bbox,
      region,
      sheetHeight,
    }),
    zoom: chosenZoom,
    tileCount: range.count,
    missingTiles: [...tiles.values()].filter((t) => !t).length,
  };
}
