/**
 * Ridgeline: horizontal scanlines displaced by elevation, with hidden-line removal.
 *
 * This is the algorithm the upstream project was built around, lifted out of screen
 * space into a pure function of a HeightField. It returns flat [x0,y0,x1,y1,...]
 * polylines in field coordinates; nothing here knows about canvases, maps or
 * millimetres.
 *
 * Rows are walked from the bottom of the field upwards so that nearer ridges are
 * drawn first and can occlude the ones behind them.
 */
import { computeRange, isNoData } from '../heightField';
import { createOcclusionBuffer } from '../occlusion';

/**
 * Choose row positions so that one row lands exactly on the highest point. Without
 * this the summit can fall between two scanlines and simply not be drawn.
 */
export function createRowIterator(rowCount, fieldHeight, rowWithHighestPoint) {
  const step = Math.max(1, Math.round(fieldHeight / Math.max(1, rowCount)));
  const start = rowWithHighestPoint - Math.floor(rowWithHighestPoint / step) * step;
  const stop = start + step * Math.floor((fieldHeight - 1 - start) / step);
  return { start, stop, step };
}

/**
 * Moving average over the y values of a polyline, reported with its extent so the
 * caller does not need a second pass to find it.
 */
export function smoothPolyline(points, windowSize) {
  if (windowSize <= 0) return points;

  const count = points.length / 2;
  const result = new Array(points.length);

  for (let i = 0; i < count; ++i) {
    const from = Math.max(0, i - windowSize);
    const to = Math.min(count - 1, i + windowSize);
    let sum = 0;
    for (let j = from; j <= to; ++j) sum += points[2 * j + 1];
    result[2 * i] = points[2 * i];
    result[2 * i + 1] = sum / (to - from + 1);
  }
  return result;
}

/**
 * Split a polyline at points hidden behind already-drawn terrain, marking what it
 * draws so later (further) rows are occluded by it.
 */
function clipToOcclusion(points, buffer, out) {
  let current = null;

  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    const column = Math.round(x);

    let visible = false;
    if (column >= 0 && column < buffer.width) {
      visible = buffer.isVisible(column, y);
      if (visible) buffer.mark(column, y);
    }

    if (visible) {
      if (!current) current = [];
      current.push(x, y);
    } else if (current) {
      if (current.length >= 4) out.push(current);
      current = null;
    }
  }

  if (current && current.length >= 4) out.push(current);
}

/**
 * @param {object} field - a HeightField
 * @param {object} options
 * @param {number} options.rowCount    - how many scanlines to draw
 * @param {number} options.heightScale - vertical displacement, in field samples,
 *                                       applied to the full elevation range
 * @param {number} options.oceanLevel  - break lines at or below this elevation
 * @param {number} options.smoothSteps - moving-average half-window, 0 to disable
 * @param {boolean} options.occlude    - remove geometry hidden behind nearer ridges
 * @returns {Array<Array<number>>} flat polylines in field coordinates
 */
export function ridgeline(field, options = {}) {
  const {
    rowCount = 30,
    heightScale = 40,
    oceanLevel = -Infinity,
    smoothSteps = 1,
    occlude = true,
  } = options;

  const range = computeRange(field);
  if (range.isEmpty) return [];

  const { width, height } = field;
  const { minHeight, heightRange } = range;

  // A flat field has no range to normalise against; leave it undisplaced rather
  // than dividing by zero.
  const displacementPerMetre = heightRange > 0 ? heightScale / heightRange : 0;

  const iterator = createRowIterator(rowCount, height, range.rowWithHighestPoint);
  const buffer = occlude ? createOcclusionBuffer(width, height) : null;
  const out = [];

  // Bottom to top: nearer ridges are drawn before the ones they hide.
  for (let y = iterator.stop; y >= iterator.start; y -= iterator.step) {
    let run = [];

    for (let x = 0; x < width; ++x) {
      const elevation = field.get(x, y);

      if (isNoData(elevation) || elevation <= oceanLevel) {
        if (run.length >= 4) emit(run);
        run = [];
        continue;
      }

      run.push(x, y - (elevation - minHeight) * displacementPerMetre);
    }

    if (run.length >= 4) emit(run);
  }

  return out;

  function emit(points) {
    const smoothed = smoothPolyline(points, smoothSteps);
    if (buffer) {
      clipToOcclusion(smoothed, buffer, out);
    } else {
      out.push(smoothed);
    }
  }
}
