/**
 * Synthetic height fields.
 *
 * Algorithms are deterministic functions of a HeightField, so their tests use
 * terrain with known analytic properties rather than fixtures pulled off a tile
 * server.
 */
import { createHeightField } from './heightField';

function build(width, height, fn) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      data[y * width + x] = fn(x, y);
    }
  }
  return createHeightField({ width, height, data });
}

/** Flat ground. No gradient anywhere. */
export function planeField(width, height, elevation = 0) {
  return build(width, height, () => elevation);
}

/** A constant slope rising towards +x, for checking gradient direction. */
export function rampField(width, height, from = 0, to = 100) {
  const span = width > 1 ? width - 1 : 1;
  return build(width, height, (x) => from + ((to - from) * x) / span);
}

/** A cone peaking at the centre sample. */
export function coneField(width, height, peak = 100) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const maxR = Math.min(cx, cy) || 1;
  return build(width, height, (x, y) => {
    const r = Math.hypot(x - cx, y - cy);
    return r >= maxR ? 0 : peak * (1 - r / maxR);
  });
}

/** A smooth gaussian hill peaking at the centre sample. */
export function gaussianHill(width, height, peak = 100, sigmaFraction = 0.2) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const sigma = Math.max(width, height) * sigmaFraction;
  return build(width, height, (x, y) => {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    return peak * Math.exp(-d2 / (2 * sigma * sigma));
  });
}

/** A saddle: rising along x, falling along y. Two opposing gradients. */
export function saddleField(width, height, amplitude = 100) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const sx = cx || 1;
  const sy = cy || 1;
  return build(
    width,
    height,
    (x, y) => amplitude * (((x - cx) / sx) ** 2 - ((y - cy) / sy) ** 2)
  );
}
