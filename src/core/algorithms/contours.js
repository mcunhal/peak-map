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
 * Marching squares over one level, emitting unchained two-point segments.
 *
 * Cells touching nodata are skipped entirely: a contour that ran along the edge of
 * a data hole would be an artefact of the hole, not of the terrain.
 */
export function marchSquares(field, level) {
  const { width, height } = field;
  const segments = [];

  // Nudge the level off the sample values.
  //
  // A level lying exactly on grid samples is the degenerate case for marching
  // squares: crossings land precisely on cell corners, producing zero-length
  // segments and junctions shared by four or six segments, which then chain into
  // fragments instead of one ring. A cone is the obvious example, since its
  // elevation hits round numbers exactly. The offset is far below any elevation
  // anyone can measure, and moves the contour by nothing that can be plotted.
  const effective = level + Math.max(Math.abs(level), 1) * 1e-9;

  for (let y = 0; y < height - 1; ++y) {
    for (let x = 0; x < width - 1; ++x) {
      // Corners, clockwise from top-left.
      const tl = field.get(x, y);
      const tr = field.get(x + 1, y);
      const br = field.get(x + 1, y + 1);
      const bl = field.get(x, y + 1);
      if (isNoData(tl) || isNoData(tr) || isNoData(br) || isNoData(bl)) continue;

      const index =
        (tl >= effective ? 8 : 0) |
        (tr >= effective ? 4 : 0) |
        (br >= effective ? 2 : 0) |
        (bl >= effective ? 1 : 0);
      if (index === 0 || index === 15) continue;

      // Crossing points on each edge, in field coordinates.
      const top = [x + interpolate(effective, tl, tr), y];
      const right = [x + 1, y + interpolate(effective, tr, br)];
      const bottom = [x + interpolate(effective, bl, br), y + 1];
      const left = [x, y + interpolate(effective, tl, bl)];

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

        // Saddles. The centre value decides which way the two lines run; taking
        // the wrong pairing joins ridges that are not connected.
        case 5: {
          const centre = (tl + tr + br + bl) / 4;
          if (centre >= effective) { push(left, top); push(bottom, right); }
          else { push(left, bottom); push(top, right); }
          break;
        }
        case 10: {
          const centre = (tl + tr + br + bl) / 4;
          if (centre >= effective) { push(top, right); push(left, bottom); }
          else { push(left, top); push(bottom, right); }
          break;
        }
        default: break;
      }
    }
  }

  return segments;
}

/**
 * Contour lines, grouped by elevation.
 *
 * @returns {Array<{level: number, polylines: Array}>}
 */
export function contourLevels(field, options = {}) {
  const { chainTolerance = 0.01 } = options;
  // Only an explicit list of elevations counts. Algorithms share one options bag,
  // and `levels` means a tonal step count to the hatching algorithm, so accepting
  // whatever turns up here silently mixes the two.
  const levels = Array.isArray(options.levels)
    ? options.levels
    : chooseLevels(field, options);

  return levels
    .map((level) => ({
      level,
      polylines: mergePolylines(marchSquares(field, level), chainTolerance),
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
