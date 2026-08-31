/**
 * Products derived from a HeightField: gradient, slope, aspect and hillshade.
 *
 * These are computed once and shared. Illuminated contours need the hillshade;
 * streamlines and hachures need the gradient; hatching needs both. Recomputing
 * them per algorithm is what would turn four algorithms into four separate builds.
 *
 * Nodata propagates: a cell whose neighbourhood is incomplete has no defined
 * gradient, and is marked rather than quietly treated as flat.
 */
import { isNoData, NODATA } from './heightField';

/**
 * Reads one axis of a cell size that may be a number, or a value per field row.
 *
 * A tilted sheet has no single cell size: the far rows cover several times the
 * ground the near ones do, so the run has to be asked for by row.
 */
function cellSizeReader(cellSize, axis, height) {
  const value =
    cellSize && typeof cellSize === 'object' && !Array.isArray(cellSize) && !ArrayBuffer.isView(cellSize)
      ? cellSize[axis]
      : cellSize;

  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length !== height) {
      throw new Error(`A per-row cell size needs one value per row, not ${value.length}`);
    }
    return (y) => (value[y] > 0 ? value[y] : 1);
  }
  return Number.isFinite(value) && value > 0 ? () => value : () => 1;
}

/**
 * Central-difference gradient, in metres of rise per unit of run.
 *
 * `cellSize` is the ground a sample covers, and the unit of the result follows
 * it: leaving it at 1 gives metres per *sample*, which is all the line-generating
 * algorithms need, while passing ground metres gives a true dimensionless slope.
 *
 * Anything lighting the surface needs the latter. A sample is not a fixed size —
 * it is hundreds of metres on a zoomed-out sheet and tens on a zoomed-in one —
 * so metres-per-sample inflates every gradient by that factor and the shading
 * saturates: the surface normal goes horizontal, and what should be a hillshade
 * collapses into a clamped aspect mask with no slope left in it. Measured on a
 * z7 sheet of Iberia at 811m a sample: 52% of the land clamped to pure black,
 * nothing above 0.85, and the same numbers at every detail setting because they
 * were all far past saturation. In real ground units the same sheet gives a mean
 * of 0.67 and 1.6% black.
 *
 * It may be a single number, or `{x, y}` where each axis is a number or a value
 * per field row. Both axes are needed because a projective sheet foreshortens
 * depth harder than width, so a row step and a column step cover different
 * ground and a single figure would skew the aspect — and with it the light.
 */
export function computeGradient(field, { cellSize = 1 } = {}) {
  const { width, height } = field;
  const runXAt = cellSizeReader(cellSize, 'x', height);
  const runYAt = cellSizeReader(cellSize, 'y', height);
  const dzdx = new Float32Array(width * height);
  const dzdy = new Float32Array(width * height);
  const valid = new Uint8Array(width * height);

  for (let y = 0; y < height; ++y) {
    const cellX = runXAt(y);
    const cellY = runYAt(y);

    for (let x = 0; x < width; ++x) {
      const i = y * width + x;

      // Clamp at the edges so the border has a gradient rather than a hole.
      const left = field.get(Math.max(0, x - 1), y);
      const right = field.get(Math.min(width - 1, x + 1), y);
      const up = field.get(x, Math.max(0, y - 1));
      const down = field.get(x, Math.min(height - 1, y + 1));

      if (isNoData(left) || isNoData(right) || isNoData(up) || isNoData(down)) {
        valid[i] = 0;
        continue;
      }

      const runX = (x === 0 || x === width - 1 ? 1 : 2) * cellX;
      const runY = (y === 0 || y === height - 1 ? 1 : 2) * cellY;

      dzdx[i] = (right - left) / runX;
      dzdy[i] = (down - up) / runY;
      valid[i] = 1;
    }
  }

  return {
    width,
    height,
    dzdx,
    dzdy,
    valid,
    at(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const i = y * width + x;
      return valid[i] ? { dx: dzdx[i], dy: dzdy[i] } : null;
    },
  };
}

/** Slope in radians, 0 on flat ground and approaching pi/2 on a cliff. */
export function computeSlope(gradient) {
  const { width, height, dzdx, dzdy, valid } = gradient;
  const slope = new Float32Array(width * height);
  for (let i = 0; i < slope.length; ++i) {
    slope[i] = valid[i] ? Math.atan(Math.hypot(dzdx[i], dzdy[i])) : NODATA;
  }
  return { width, height, data: slope };
}

/**
 * Aspect in radians: the compass direction the slope faces, measured clockwise
 * from north (up the field), which is the convention cartography uses.
 */
export function computeAspect(gradient) {
  const { width, height, dzdx, dzdy, valid } = gradient;
  const aspect = new Float32Array(width * height);
  for (let i = 0; i < aspect.length; ++i) {
    if (!valid[i]) {
      aspect[i] = NODATA;
      continue;
    }
    // Downhill direction is the negative gradient.
    let a = Math.atan2(-dzdx[i], dzdy[i]);
    if (a < 0) a += Math.PI * 2;
    aspect[i] = a;
  }
  return { width, height, data: aspect };
}

/**
 * Standard hillshade, in 0..1, where 0 is fully shadowed and 1 faces the light.
 *
 * @param {number} [azimuth]  - light direction in degrees clockwise from north
 * @param {number} [altitude] - light elevation in degrees above the horizon
 * @param {number} [zFactor]  - vertical exaggeration
 */
export function computeHillshade(
  gradient,
  { azimuth = 315, altitude = 45, zFactor = 1 } = {}
) {
  const { width, height, dzdx, dzdy, valid } = gradient;
  const shade = new Float32Array(width * height);

  // Unit vector pointing at the light. Azimuth is measured clockwise from north,
  // and north is -y because the field runs top-down, so north is (0, -1).
  const a = (azimuth * Math.PI) / 180;
  const alt = (altitude * Math.PI) / 180;
  const lx = Math.cos(alt) * Math.sin(a);
  const ly = -Math.cos(alt) * Math.cos(a);
  const lz = Math.sin(alt);

  for (let i = 0; i < shade.length; ++i) {
    if (!valid[i]) {
      shade[i] = NODATA;
      continue;
    }

    // Surface normal of z = f(x, y) is (-dz/dx, -dz/dy, 1).
    const nx = -dzdx[i] * zFactor;
    const ny = -dzdy[i] * zFactor;
    const norm = Math.hypot(nx, ny, 1);

    const value = (nx * lx + ny * ly + lz) / norm;
    shade[i] = Math.min(1, Math.max(0, value));
  }

  return { width, height, data: shade };
}

/** Bilinear sample of a scalar grid, returning NODATA outside or over a hole. */
export function sampleGrid(grid, x, y) {
  const { width, height, data } = grid;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return NODATA;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];
  if (isNoData(v00) || isNoData(v10) || isNoData(v01) || isNoData(v11)) return NODATA;

  const tx = x - x0;
  const ty = y - y0;
  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

/**
 * Bilinear sample of the gradient into a caller-supplied object.
 *
 * Streamline integration calls this twice per step and takes millions of steps,
 * so returning a fresh object each time is most of the cost: not the arithmetic,
 * but the garbage. Writing into a reused object removes that entirely.
 *
 * @returns {boolean} whether the sample was defined
 */
export function sampleGradientInto(gradient, x, y, out) {
  const { width, height, dzdx, dzdy, valid } = gradient;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return false;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < width ? x0 + 1 : width - 1;
  const y1 = y0 + 1 < height ? y0 + 1 : height - 1;

  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  if (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11]) return false;

  const tx = x - x0;
  const ty = y - y0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  out.dx = dzdx[i00] * w00 + dzdx[i10] * w10 + dzdx[i01] * w01 + dzdx[i11] * w11;
  out.dy = dzdy[i00] * w00 + dzdy[i10] * w10 + dzdy[i01] * w01 + dzdy[i11] * w11;
  return true;
}

/** Bilinear sample of the gradient, for streamline integration. */
export function sampleGradient(gradient, x, y) {
  const { width, height, dzdx, dzdy, valid } = gradient;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return null;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);

  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  if (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11]) return null;

  const tx = x - x0;
  const ty = y - y0;
  const lerp = (a, b, c, d) =>
    a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;

  return {
    dx: lerp(dzdx[i00], dzdx[i10], dzdx[i01], dzdx[i11]),
    dy: lerp(dzdy[i00], dzdy[i10], dzdy[i01], dzdy[i11]),
  };
}

/** Everything derived from a field, computed once. */
export function deriveAll(field, options = {}) {
  const gradient = computeGradient(field, options);
  return {
    gradient,
    slope: computeSlope(gradient),
    aspect: computeAspect(gradient),
    hillshade: computeHillshade(gradient, options),
  };
}
