/**
 * How fine the data is, against how fine the sheet can be drawn.
 *
 * This is a property of pens and paper rather than of any file format, so it
 * lives apart from the readers: both the GeoTIFF path and the catalogue need
 * it, and the catalogue must stay loadable outside a bundler.
 */

/**
 * The point of fine data is close-ups, and it is worth being able to say when
 * it is not buying anything: past about a third of a millimetre per sample the
 * pen is the limit, not the terrain, and coarser data will look the same.
 *
 * @param {number} groundWidthM - width of the sheet on the ground, in metres
 * @param {number} drawableMm   - width of the drawable area, in millimetres
 * @param {number} rasterMetres - the raster's own resolution
 */
export function resolutionAdvice(groundWidthM, drawableMm, rasterMetres) {
  const metresPerMm = groundWidthM / drawableMm;
  const samplesPerMm = metresPerMm / rasterMetres;
  return {
    metresPerMm,
    samplesPerMm,
    // Below this the data is coarser than the pen, and stair-steps.
    dataIsTheLimit: samplesPerMm < 0.35,
    // Above this the pen cannot show the extra detail anyway.
    worthIt: samplesPerMm < 3,
  };
}
