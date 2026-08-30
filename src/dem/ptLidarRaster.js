/**
 * Reading DGT's LiDAR rasters into a HeightField.
 *
 * The catalogue at `cdd.dgterritorio.gov.pt/dgt-be/v1` is public and its STAC
 * search will tell anyone which tiles cover a place and what they are called.
 * The files themselves are not public: they sit in object storage that answers
 * 403 without an account. So the tiles arrive here as bytes the reader already
 * has, rather than as a URL this fetches, and that is a deliberate boundary
 * rather than a limitation to work around: a public web page cannot hold
 * somebody's credentials without handing them to everyone who visits it.
 *
 * The files are Float32 GeoTIFF in EPSG:3763, one square kilometre each, 2000
 * pixels square at 50cm or 500 at 2m, with -999 for ground that was not flown.
 */
import { createHeightField, NODATA } from '../core/heightField';
import { createMosaic, coverageOf } from './rasterMosaic';
import { lngLatToTM06 } from './ptLidarGrid';

// Kept exported from here for the readers that already import it.
export { resolutionAdvice } from './resolution';

/**
 * Turn a GeoTIFF into the plain rectangle-of-numbers the mosaic wants.
 *
 * @param {ArrayBuffer} bytes
 * @param {object} deps - `fromArrayBuffer` from the geotiff package, injected so
 *   the decoder is not a hard dependency of anything that merely samples.
 */
export async function readGeoTiff(bytes, { fromArrayBuffer }) {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();

  const [minX, minY, maxX, maxY] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();
  const [data] = await image.readRasters();

  let noData;
  const declared = image.getGDALNoData?.();
  if (declared !== null && declared !== undefined) noData = Number(declared);

  return { minX, minY, maxX, maxY, width, height, data, noData };
}

/**
 * Sample a mosaic of projected rasters onto the sheet.
 *
 * The sheet is described by a region, exactly as the tiled elevation path
 * describes it, so rotation and tilt carry over unchanged: each field cell is
 * asked where it is on the Earth, projected into EPSG:3763, and looked up.
 *
 * @returns {{field, coverage, tilesUsed}} coverage is the fraction of the sheet
 *   the rasters actually cover, which is worth showing rather than letting
 *   somebody wonder why half a drawing is missing.
 */
export function buildHeightFieldFromRasters({ region, rasters, fieldWidth, fieldHeight }) {
  if (!region) throw new Error('A region is required to place the rasters on a sheet');
  if (!(fieldWidth > 0) || !(fieldHeight > 0)) {
    throw new Error('Field dimensions must be positive');
  }

  const mosaic = createMosaic(rasters);
  const data = new Float32Array(fieldWidth * fieldHeight);

  if (mosaic.count === 0) {
    data.fill(NODATA);
    return {
      field: createHeightField({ width: fieldWidth, height: fieldHeight, data, region }),
      coverage: 0,
      tilesUsed: 0,
    };
  }

  for (let y = 0; y < fieldHeight; ++y) {
    for (let x = 0; x < fieldWidth; ++x) {
      // Pixel centres, so the field is not biased half a cell.
      const { lng, lat } = region.toLngLat(fieldWidth, fieldHeight, x + 0.5, y + 0.5);
      const p = lngLatToTM06(lng, lat);
      data[y * fieldWidth + x] = mosaic.sampleAt(p.x, p.y);
    }
  }

  const toProjected = (x, y) => {
    const { lng, lat } = region.toLngLat(fieldWidth, fieldHeight, x, y);
    return lngLatToTM06(lng, lat);
  };

  return {
    field: createHeightField({ width: fieldWidth, height: fieldHeight, data, region }),
    coverage: coverageOf(mosaic, toProjected, fieldWidth, fieldHeight),
    tilesUsed: mosaic.count,
  };
}
