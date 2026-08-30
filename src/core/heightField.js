/**
 * A HeightField is elevation sampled on a regular grid, in field coordinates.
 *
 * This is the single input every algorithm takes. It carries no DOM, no map and no
 * tile plumbing, which is what makes the algorithms testable against synthetic
 * terrain.
 */

/**
 * Sentinel for a sample with no elevation: a tile that failed to load, a void in
 * the source data, or a point outside the selected boundary.
 *
 * Negative infinity is deliberate. The renderer's `height <= oceanLevel` test then
 * breaks the line at a gap rather than drawing a false sea-level plateau.
 */
export const NODATA = Number.NEGATIVE_INFINITY;

export function isNoData(value) {
  return !(value > NODATA) || Number.isNaN(value);
}

/**
 * @param {object} options
 * @param {number} options.width  - samples across
 * @param {number} options.height - samples down
 * @param {Float32Array} options.data - row-major, length width*height
 * @param {object} [options.bbox] - geographic extent {west,south,east,north}
 * @param {number} [options.sheetHeight] - how many rows land on the sheet, when
 *   the field extends past it. See `sheetRows` below.
 */
export function createHeightField({
  width,
  height,
  data,
  bbox = null,
  region = null,
  sheetHeight = null,
}) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Height field needs a positive width and height');
  }
  if (!data || data.length !== width * height) {
    throw new Error(
      `Height field data length ${data ? data.length : 0} does not match ${width}x${height}`
    );
  }

  return {
    width,
    height,
    data,
    bbox,
    // How field coordinates relate to the Earth. Carries the sheet's rotation,
    // which a bounding box cannot express.
    region,
    // Null unless the field runs past the bottom of the sheet; see `sheetRows`.
    sheetHeight,

    get(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return NODATA;
      return data[y * width + x];
    },

    hasData(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      return !isNoData(data[y * width + x]);
    },
  };
}

/**
 * How many of a field's rows land on the sheet.
 *
 * The bottom of the page is over-plotted: ground nearer than the sheet's own
 * near edge is sampled and drawn, so that a peak on that edge, which is lifted
 * up the page, does not leave blank paper beneath it. Those rows are cut off at
 * the page edge once drawn.
 *
 * Everything that has to know where the sheet actually ends — the page mapper,
 * and the row that normalises perspective foreshortening — asks here, so a field
 * without over-plot behaves exactly as it always did.
 */
export function sheetRows(field) {
  return Number.isFinite(field.sheetHeight) && field.sheetHeight > 0
    ? field.sheetHeight
    : field.height;
}

/**
 * The same field with everything at or below `level` removed.
 *
 * The ocean is a property of the ground, not of one way of drawing it. Left as a
 * per-algorithm option it has to be re-implemented eight times, and it was
 * implemented twice: the ridge lines cut at the coast while the hachures,
 * streamlines and hillshade hatching drew five kilometres of Atlantic seabed,
 * because everything they see arrives through `computeGradient`, which knows only
 * about nodata. Cutting the field once, at the boundary, is what makes one
 * setting mean the same thing to all of them.
 *
 * Nodata is the right sentinel rather than a new one: every algorithm already
 * handles it, which is exactly why this works without touching any of them.
 */
export function cutBelow(field, level) {
  // No ocean set: hand back the same field rather than copying it for nothing.
  if (!Number.isFinite(level)) return field;

  const data = new Float32Array(field.data);
  for (let i = 0; i < data.length; ++i) {
    if (data[i] <= level) data[i] = NODATA;
  }

  return createHeightField({
    width: field.width,
    height: field.height,
    data,
    bbox: field.bbox,
    region: field.region,
    sheetHeight: field.sheetHeight,
  });
}

/**
 * Elevation range over the samples that actually have data.
 *
 * `rowWithHighestPoint` is what the ridgeline iterator aligns its rows to, so the
 * summit always falls on a drawn line rather than between two of them.
 */
export function computeRange(field, { floor = NODATA } = {}) {
  const { width, height, data } = field;

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let rowWithHighestPoint = -1;
  let validSamples = 0;

  for (let y = 0; y < height; ++y) {
    const rowOffset = y * width;
    for (let x = 0; x < width; ++x) {
      const value = data[rowOffset + x];
      // A sample the renderer will not draw must not set the range the drawing
      // is positioned and scaled by. `floor` is the ocean level, and the test
      // matches how the rows are cut: at or below it is water, not ground.
      if (isNoData(value) || value <= floor) continue;
      validSamples += 1;
      if (value < minHeight) minHeight = value;
      if (value > maxHeight) {
        maxHeight = value;
        rowWithHighestPoint = y;
      }
    }
  }

  const isEmpty = validSamples === 0;
  return {
    minHeight: isEmpty ? 0 : minHeight,
    maxHeight: isEmpty ? 0 : maxHeight,
    heightRange: isEmpty ? 0 : maxHeight - minHeight,
    rowWithHighestPoint: isEmpty ? 0 : rowWithHighestPoint,
    validSamples,
    isEmpty,
  };
}
