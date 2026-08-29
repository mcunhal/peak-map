/**
 * Evenly-spaced streamlines through the terrain gradient field.
 *
 * After Jobard and Lefer, "Creating Evenly-Spaced Streamlines of Arbitrary
 * Density" (1997). The idea is simple and the result is what makes it worth
 * implementing: rather than seeding strokes on a grid and accepting whatever
 * spacing falls out, every new streamline is grown from a seed placed exactly one
 * separation distance away from an existing one, and is stopped the moment it comes
 * too close to anything already drawn. The plot ends up evenly covered, with no
 * clumping and no bald patches, which is what a pen needs.
 *
 * Two fields are useful here:
 *
 *   slope    follows the gradient downhill, so strokes run the way water does and
 *            the drawing reads as drainage and spurs.
 *   contour  follows the perpendicular, so strokes run along the hillside like
 *            isolines, but evenly spaced rather than at fixed elevations.
 */
import { sampleGradient } from '../derived';

/**
 * Spatial hash over the points of streamlines already accepted, so proximity
 * tests stay constant-time as the drawing fills up.
 */
function createProximityGrid(cellSize, width, height) {
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const cells = new Array(cols * rows);

  return {
    add(x, y) {
      const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
      const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
      const i = cy * cols + cx;
      if (!cells[i]) cells[i] = [];
      cells[i].push(x, y);
    },

    /** Is any recorded point within `distance` of (x, y)? */
    hasNeighbourWithin(x, y, distance) {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      const reach = Math.ceil(distance / cellSize);
      const d2 = distance * distance;

      for (let gy = cy - reach; gy <= cy + reach; ++gy) {
        if (gy < 0 || gy >= rows) continue;
        for (let gx = cx - reach; gx <= cx + reach; ++gx) {
          if (gx < 0 || gx >= cols) continue;
          const bucket = cells[gy * cols + gx];
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i += 2) {
            const dx = bucket[i] - x;
            const dy = bucket[i + 1] - y;
            if (dx * dx + dy * dy < d2) return true;
          }
        }
      }
      return false;
    },
  };
}

/** Unit direction of the chosen field at a point, or null where it is undefined. */
function fieldDirection(gradient, x, y, mode) {
  const g = sampleGradient(gradient, x, y);
  if (!g) return null;

  const magnitude = Math.hypot(g.dx, g.dy);
  // Flat ground has no direction to follow; a stroke there would be arbitrary.
  if (magnitude < 1e-9) return null;

  if (mode === 'contour') {
    // Perpendicular to the gradient: along the hillside.
    return { x: -g.dy / magnitude, y: g.dx / magnitude, magnitude };
  }
  // Downhill.
  return { x: -g.dx / magnitude, y: -g.dy / magnitude, magnitude };
}

/**
 * Integrate one streamline from a seed, in one direction, by second-order
 * Runge-Kutta. Euler drifts badly across a curving field and closes loops that
 * should stay open.
 */
function integrate(gradient, seed, sign, options, isTooClose) {
  const { stepSize, maxSteps, mode, width, height, minMagnitude, recordSpacing } = options;
  const points = [];

  let x = seed.x;
  let y = seed.y;
  // Integration steps finely for accuracy, but a plotted line does not need a
  // vertex every half sample. Recording at a coarser spacing is what keeps the
  // proximity index small, and the index is what the whole algorithm's cost
  // turns on: at one vertex per step this was eight million points.
  let sinceRecord = 0;
  let lastX = x;
  let lastY = y;

  for (let step = 0; step < maxSteps; ++step) {
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) break;

    const k1 = fieldDirection(gradient, x, y, mode);
    if (!k1 || k1.magnitude < minMagnitude) break;

    // Midpoint.
    const mx = x + sign * k1.x * stepSize * 0.5;
    const my = y + sign * k1.y * stepSize * 0.5;
    const k2 = fieldDirection(gradient, mx, my, mode);
    if (!k2) break;

    const nx = x + sign * k2.x * stepSize;
    const ny = y + sign * k2.y * stepSize;
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
    if (nx < 0 || ny < 0 || nx > width - 1 || ny > height - 1) break;

    // Stop before crowding a stroke that is already drawn.
    if (isTooClose(nx, ny)) break;

    sinceRecord += Math.hypot(nx - lastX, ny - lastY);
    if (sinceRecord >= recordSpacing) {
      points.push(nx, ny);
      sinceRecord = 0;
      lastX = nx;
      lastY = ny;
    }

    x = nx;
    y = ny;
  }

  // Always finish on the last position, so the stroke reaches where it stopped.
  if (points.length < 2 || points[points.length - 2] !== x || points[points.length - 1] !== y) {
    points.push(x, y);
  }

  return points;
}

function lengthOf(line) {
  let total = 0;
  for (let i = 2; i < line.length; i += 2) {
    total += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  }
  return total;
}

/**
 * @param {object} gradient - from computeGradient
 * @param {object} [options]
 * @param {number} [options.separation]  - target spacing between strokes, in samples
 * @param {number} [options.testFactor]  - stop distance as a fraction of separation
 * @param {number} [options.stepSize]    - integration step, in samples
 * @param {number} [options.maxSteps]    - cap on one stroke, both directions
 * @param {'slope'|'contour'} [options.mode]
 * @param {number} [options.minLength]   - discard strokes shorter than this
 * @param {number} [options.minMagnitude] - treat gentler ground than this as flat
 * @param {number} [options.maxLines]    - hard cap, so a dense setting cannot hang
 * @returns {Array} polylines in field coordinates
 */
export function evenlySpacedStreamlines(gradient, options = {}) {
  const settings = {
    separation: 5,
    testFactor: 0.5,
    stepSize: 0.5,
    maxSteps: 3000,
    mode: 'slope',
    minLength: 3,
    minMagnitude: 0,
    maxLines: 20000,
    ...options,
    recordSpacing:
      options.recordSpacing ?? Math.max(options.stepSize ?? 0.5, (options.separation ?? 5) / 3),
    width: gradient.width,
    height: gradient.height,
  };

  const { separation, testFactor, width, height, minLength, maxLines } = settings;
  if (!(separation > 0)) throw new Error('Streamline separation must be positive');

  const stopDistance = separation * testFactor;
  const grid = createProximityGrid(Math.max(1, separation), width, height);
  const isTooClose = (x, y) => grid.hasNeighbourWithin(x, y, stopDistance);

  const accepted = [];
  // Streamlines waiting to have seeds spawned alongside them.
  const queue = [];

  const growFrom = (seed) => {
    if (isTooClose(seed.x, seed.y)) return null;

    const forward = integrate(gradient, seed, +1, settings, isTooClose);
    const backward = integrate(gradient, seed, -1, settings, isTooClose);

    // Backward run is reversed and prepended so the stroke reads start to end.
    const line = [];
    for (let i = backward.length - 2; i >= 0; i -= 2) line.push(backward[i], backward[i + 1]);
    line.push(seed.x, seed.y);
    line.push(...forward);

    if (line.length < 4 || lengthOf(line) < minLength) return null;

    for (let i = 0; i < line.length; i += 2) grid.add(line[i], line[i + 1]);
    accepted.push(line);
    queue.push(line);
    return line;
  };

  // Candidate seeds, steepest first, on a grid fine enough to reach every part of
  // the terrain. The propagation below is the main engine, but it cannot be the
  // only one: it grows outwards from wherever it starts, so it stalls at a ridge
  // the field does not cross, and it dies altogether if the very first seed
  // happens to run straight out of the field. A saddle does exactly that, since
  // its steepest ground is in the corners and the flow there leaves immediately.
  const seedStep = Math.max(1, Math.floor(separation / 2));
  const candidates = [];
  for (let y = 1; y < height - 1; y += seedStep) {
    for (let x = 1; x < width - 1; x += seedStep) {
      const d = fieldDirection(gradient, x, y, settings.mode);
      if (d) candidates.push({ x, y, magnitude: d.magnitude });
    }
  }
  candidates.sort((a, b) => b.magnitude - a.magnitude);

  let nextCandidate = 0;

  while (accepted.length < maxLines) {
    // Refill from the candidate list whenever propagation has nothing left.
    if (queue.length === 0) {
      let grew = false;
      while (nextCandidate < candidates.length) {
        if (growFrom(candidates[nextCandidate++])) {
          grew = true;
          break;
        }
      }
      if (!grew) break;
    }

    const line = queue.shift();

    // Each accepted stroke offers seeds one separation to either side, which is
    // what keeps the spacing even rather than merely random. Candidates are
    // placed at intervals along the stroke rather than at every vertex: seeding
    // from every vertex proposes hundreds of candidates per stroke that all fall
    // within a separation of one another and are rejected in turn.
    let travelled = separation;
    for (let i = 0; i < line.length; i += 2) {
      if (i >= 2) {
        travelled += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
      }
      if (travelled < separation) continue;
      travelled = 0;

      const x = line[i];
      const y = line[i + 1];
      const direction = fieldDirection(gradient, x, y, settings.mode);
      if (!direction) continue;

      // Normal to the stroke.
      const nx = -direction.y;
      const ny = direction.x;

      for (const sign of [+1, -1]) {
        const seed = { x: x + sign * nx * separation, y: y + sign * ny * separation };
        if (seed.x < 0 || seed.y < 0 || seed.x > width - 1 || seed.y > height - 1) continue;
        if (accepted.length >= maxLines) break;
        growFrom(seed);
      }
    }
  }

  return accepted;
}
