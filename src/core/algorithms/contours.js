/**
 * Contour lines by marching squares, and Tanaka illuminated contours.
 *
 * Contours are the most plotter-native way to draw terrain: closed loops, no
 * overdraw, and every line means something specific. Marching squares is
 * implemented here rather than pulled in as a dependency because the two things
 * that matter for this use are nodata handling and emitting open polylines rather
 * than filled polygon rings.
 *
 * Segments come out of the marching pass unordered. Chaining them into long
 * strokes is exactly what the optimizer's merge pass already does, so the two are
 * composed rather than duplicated.
 */
import { computeRange, isNoData } from '../heightField';
import { mergePolylines } from '../optimize';
import { sampleGrid } from '../derived';

/**
 * Round contour intervals, chosen so a map has a readable number of lines.
 * These are the intervals paper maps actually use.
 */
const NICE_INTERVALS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];

/**
 * Pick contour levels for a field.
 *
 * @param {object} field
 * @param {object} [options]
 * @param {number} [options.interval] - fixed interval in metres; overrides count
 * @param {number} [options.count]    - desired number of contours
 * @param {number} [options.base]     - align levels to this elevation
 */
export function chooseLevels(field, { interval = null, count = 25, base = 0 } = {}) {
  const range = computeRange(field);
  if (range.isEmpty || range.heightRange <= 0) return [];

  let step = interval;
  if (!step) {
    const rough = range.heightRange / Math.max(1, count);
    step = NICE_INTERVALS.find((v) => v >= rough) ?? NICE_INTERVALS[NICE_INTERVALS.length - 1];
  }

  const levels = [];
  // Strictly above the minimum: a contour sitting exactly on the lowest value
  // traces the edge of every flat area rather than a feature of the terrain.
  let first = Math.ceil((range.minHeight - base) / step) * step + base;
  if (first <= range.minHeight) first += step;
  for (let level = first; level < range.maxHeight; level += step) {
    levels.push(level);
  }
  return levels;
}

/** Where a contour crosses the edge between two corner values. */
function interpolate(level, a, b) {
  if (a === b) return 0.5;
  return (level - a) / (b - a);
}

/**
 * Emit the contour segments for one cell at one level.
 *
 * Split out so the whole grid can be walked once for every level at a time,
 * rather than once per level. Cells touching nodata are the caller's problem.
 */
function emitCell(level, x, y, tl, tr, br, bl, segments) {
  const index =
    (tl >= level ? 8 : 0) |
    (tr >= level ? 4 : 0) |
    (br >= level ? 2 : 0) |
    (bl >= level ? 1 : 0);
  if (index === 0 || index === 15) return;

  const top = [x + interpolate(level, tl, tr), y];
  const right = [x + 1, y + interpolate(level, tr, br)];
  const bottom = [x + interpolate(level, bl, br), y + 1];
  const left = [x, y + interpolate(level, tl, bl)];

  // A crossing with no length carries no information and only confuses the
  // chaining pass, which sees it as a junction.
  const push = (a, b) => {
    if (a[0] === b[0] && a[1] === b[1]) return;
    segments.push([a[0], a[1], b[0], b[1]]);
  };

  switch (index) {
    case 1: case 14: push(left, bottom); break;
    case 2: case 13: push(bottom, right); break;
    case 3: case 12: push(left, right); break;
    case 4: case 11: push(top, right); break;
    case 6: case 9: push(top, bottom); break;
    case 7: case 8: push(left, top); break;

    // Saddles. The centre value decides which way the two lines run; taking the
    // wrong pairing joins ridges that are not connected.
    case 5: {
      const centre = (tl + tr + br + bl) / 4;
      if (centre >= level) { push(left, top); push(bottom, right); }
      else { push(left, bottom); push(top, right); }
      break;
    }
    case 10: {
      const centre = (tl + tr + br + bl) / 4;
      if (centre >= level) { push(top, right); push(left, bottom); }
      else { push(left, top); push(bottom, right); }
      break;
    }
    default: break;
  }
}

/**
 * Nudge a level off the sample values.
 *
 * A level lying exactly on grid samples is the degenerate case for marching
 * squares: crossings land precisely on cell corners, producing zero-length
 * segments and junctions shared by four or six segments, which then chain into
 * fragments instead of one ring. A cone is the obvious example, since its
 * elevation hits round numbers exactly. The offset is far below any elevation
 * anyone can measure, and moves the contour by nothing that can be plotted.
 */
function nudge(level) {
  return level + Math.max(Math.abs(level), 1) * 1e-9;
}

/** Marching squares over one level, emitting unchained two-point segments. */
export function marchSquares(field, level) {
  return marchSquaresMulti(field, [level])[0];
}

/**
 * Marching squares over many levels in a single pass over the grid.
 *
 * Walking the grid once per level is the obvious implementation and it is what
 * this did first, but it costs a full scan of every cell for every contour: at
 * app detail that is twenty-five scans of half a million cells, and twenty
 * seconds of work. Since a cell can only be crossed by levels lying between its
 * own lowest and highest corner, one scan can serve every level at once, and
 * typical terrain has only a handful of levels crossing any given cell.
 *
 * @param {object} field
 * @param {Array<number>} levels - ascending
 * @param {Function} [onProgress] - called with a fraction as rows are scanned
 * @returns {Array<Array>} segments per level, in the order the levels were given
 */
export function marchSquaresMulti(field, levels, onProgress = null) {
  const { width, height } = field;
  const perLevel = levels.map(() => []);
  if (levels.length === 0) return perLevel;

  const effective = levels.map(nudge);
  const data = field.data;
  const reportEvery = Math.max(1, Math.floor((height - 1) / 20));

  for (let y = 0; y < height - 1; ++y) {
    const row = y * width;
    const nextRow = row + width;

    for (let x = 0; x < width - 1; ++x) {
      const tl = data[row + x];
      const tr = data[row + x + 1];
      const br = data[nextRow + x + 1];
      const bl = data[nextRow + x];
      if (isNoData(tl) || isNoData(tr) || isNoData(br) || isNoData(bl)) continue;

      let low = tl, high = tl;
      if (tr < low) low = tr; else if (tr > high) high = tr;
      if (br < low) low = br; else if (br > high) high = br;
      if (bl < low) low = bl; else if (bl > high) high = bl;

      // Only levels inside this cell's own range can cross it.
      for (let i = 0; i < effective.length; ++i) {
        const level = effective[i];
        if (level <= low) continue;
        if (level > high) break; // levels are ascending
        emitCell(level, x, y, tl, tr, br, bl, perLevel[i]);
      }
    }

    if (onProgress && y % reportEvery === 0) onProgress(y / (height - 1));
  }

  return perLevel;
}

/**
 * Contour lines, grouped by elevation.
 *
 * @returns {Array<{level: number, polylines: Array}>}
 */
export function contourLevels(field, options = {}) {
  const { chainTolerance = 0.01, onProgress = null } = options;
  // Only an explicit list of elevations counts. Algorithms share one options bag,
  // and `levels` means a tonal step count to the hatching algorithm, so accepting
  // whatever turns up here silently mixes the two.
  const requested = Array.isArray(options.levels)
    ? options.levels
    : chooseLevels(field, options);
  if (requested.length === 0) return [];

  const levels = [...requested].sort((a, b) => a - b);
  const perLevel = marchSquaresMulti(field, levels, onProgress);

  return levels
    .map((level, i) => ({
      level,
      polylines: mergePolylines(perLevel[i], chainTolerance),
    }))
    .filter((group) => group.polylines.length > 0);
}

/** Every contour as a flat list of polylines, for a single-pen plot. */
export function contours(field, options = {}) {
  return contourLevels(field, options).flatMap((group) => group.polylines);
}

/**
 * Tanaka illuminated contours.
 *
 * A contour is drawn heavily where it faces the light and lightly where it faces
 * away, which makes a flat set of isolines read as relief. A pen cannot vary its
 * width along a stroke, so segments are sorted into weight classes and each class
 * becomes its own group, to be plotted with a different pen or with extra passes.
 *
 * @param {Array} polylines - contour geometry in field coordinates
 * @param {object} [options]
 * @param {number} [options.azimuth] - light direction, degrees clockwise from north
 * @param {number} [options.classes] - number of weight classes
 * @returns {Array<{weight: number, polylines: Array}>} lightest class first
 */
export function tanakaClasses(polylines, { azimuth = 315, classes = 3 } = {}) {
  if (classes < 1) throw new Error('Tanaka needs at least one weight class');

  // Light direction in field space: y grows southwards.
  const a = ((360 - azimuth + 90) * Math.PI) / 180;
  const lightX = Math.cos(a);
  const lightY = -Math.sin(a);

  const buckets = Array.from({ length: classes }, () => []);

  for (const line of polylines) {
    let run = [];
    let runClass = -1;

    for (let i = 2; i < line.length; i += 2) {
      const dx = line[i] - line[i - 2];
      const dy = line[i + 1] - line[i - 1];
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;

      // The uphill normal of a contour segment. Which of the two normals is
      // uphill does not matter here: illumination is taken as a magnitude, so
      // both the lit and the shaded face are drawn heavily, which is what makes
      // the relief read.
      const illumination = Math.abs((-dy / length) * lightX + (dx / length) * lightY);
      const index = Math.min(classes - 1, Math.floor(illumination * classes));

      if (index !== runClass) {
        if (run.length >= 4) buckets[runClass].push(run);
        // Start the new run at the shared point so there is no gap.
        run = [line[i - 2], line[i - 1]];
        runClass = index;
      }
      run.push(line[i], line[i + 1]);
    }

    if (run.length >= 4 && runClass >= 0) buckets[runClass].push(run);
  }

  return buckets.map((lines, i) => ({
    weight: (i + 1) / classes,
    polylines: lines,
  }));
}

/**
 * Contours weighted by an existing hillshade grid rather than by segment
 * direction. Slower to compute but truer, since it accounts for the actual slope.
 */
export function shadeWeightedClasses(polylines, hillshade, { classes = 3 } = {}) {
  const buckets = Array.from({ length: classes }, () => []);

  for (const line of polylines) {
    let run = [];
    let runClass = -1;

    for (let i = 0; i < line.length; i += 2) {
      const shade = sampleGrid(hillshade, line[i], line[i + 1]);
      const lit = isNoData(shade) ? 0.5 : shade;
      // Dark faces are drawn heavily, lit faces lightly.
      const index = Math.min(classes - 1, Math.floor((1 - lit) * classes));

      if (index !== runClass) {
        if (run.length >= 4) buckets[runClass].push(run);
        run = i >= 2 ? [line[i - 2], line[i - 1]] : [];
        runClass = index;
      }
      run.push(line[i], line[i + 1]);
    }

    if (run.length >= 4 && runClass >= 0) buckets[runClass].push(run);
  }

  return buckets.map((lines, i) => ({ weight: (i + 1) / classes, polylines: lines }));
}
