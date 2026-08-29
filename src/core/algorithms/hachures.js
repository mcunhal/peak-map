/**
 * Hachures and hillshade hatching.
 *
 * Hachures are the nineteenth-century way of drawing relief, standardised by
 * Lehmann in 1799: short strokes running straight down the slope, drawn heavier and
 * closer together where the ground is steeper. On complex terrain a field of them
 * behaves like a dithering filter, which is exactly what a single-colour pen needs
 * in order to render tone. Samsonov's flowline hachures are the modern automated
 * form, and they start from the same place this does: strokes that follow the
 * slope, cut to lengths that report steepness.
 *
 * Hillshade hatching is the other tonal technique: straight parallel rules whose
 * local density follows a computed hillshade. It has no relation to the terrain's
 * own directions, which makes it read as shading rather than as structure.
 */
import { evenlySpacedStreamlines } from './streamlines';
import { sampleGrid } from '../derived';
import { isNoData } from '../heightField';

/**
 * Cut a long slope line into hachure strokes.
 *
 * Steep ground gets long strokes with short gaps, gentle ground short strokes with
 * long gaps, so tone follows steepness. Flat ground is left blank, which is the
 * convention: on a hachure map, white means level.
 */
function cutIntoHachures(line, slopeGrid, options) {
  const { minStroke, maxStroke, gap, maxSlope, minSlope } = options;
  const out = [];

  let run = [];
  let runLength = 0;
  let target = null;
  let skipping = 0;

  const flush = () => {
    if (run.length >= 4) out.push(run);
    run = [];
    runLength = 0;
    target = null;
  };

  for (let i = 2; i < line.length; i += 2) {
    const x = line[i];
    const y = line[i + 1];
    const stepLength = Math.hypot(x - line[i - 2], y - line[i - 1]);

    const slope = sampleGrid(slopeGrid, x, y);
    // Steepness in 0..1, where 0 is flatter than we care to draw.
    const steepness = isNoData(slope)
      ? 0
      : Math.min(1, Math.max(0, (slope - minSlope) / (maxSlope - minSlope)));

    if (steepness <= 0) {
      flush();
      skipping = 0;
      continue;
    }

    if (skipping > 0) {
      skipping -= stepLength;
      continue;
    }

    if (target === null) {
      target = minStroke + (maxStroke - minStroke) * steepness;
      run = [line[i - 2], line[i - 1]];
    }

    run.push(x, y);
    runLength += stepLength;

    if (runLength >= target) {
      flush();
      // Gentle ground leaves a longer gap, so it reads lighter.
      skipping = gap * (1.6 - steepness);
    }
  }

  flush();
  return out;
}

/**
 * @param {object} gradient  - from computeGradient
 * @param {object} slopeGrid - from computeSlope
 * @param {object} [options]
 * @param {number} [options.separation] - spacing between hachure columns, in samples
 * @param {number} [options.minStroke]  - stroke length on the gentlest drawn ground
 * @param {number} [options.maxStroke]  - stroke length on the steepest ground
 * @param {number} [options.gap]        - base gap between strokes
 * @param {number} [options.minSlope]   - radians below which nothing is drawn
 * @param {number} [options.maxSlope]   - radians treated as fully steep
 */
export function hachures(gradient, slopeGrid, options = {}) {
  const settings = {
    separation: 4,
    minStroke: 1.5,
    maxStroke: 7,
    gap: 2.5,
    minSlope: 0.05,
    maxSlope: 0.8,
    stepSize: 0.5,
    maxLines: 8000,
    ...options,
  };

  const flowlines = evenlySpacedStreamlines(gradient, {
    separation: settings.separation,
    stepSize: settings.stepSize,
    mode: 'slope',
    minLength: settings.minStroke,
    maxLines: settings.maxLines,
    // Do not trace across ground too flat to hachure.
    minMagnitude: Math.tan(settings.minSlope),
  });

  return flowlines.flatMap((line) => cutIntoHachures(line, slopeGrid, settings));
}

/**
 * Parallel hatching whose density follows a hillshade.
 *
 * Rules are drawn at a fixed angle and a fixed base spacing. Each rule belongs to
 * one of `levels` interleaved passes, and a pass is only drawn where the ground is
 * dark enough to warrant it. So the lightest areas keep every nth rule, the darkest
 * keep them all, and the spacing between drawn rules varies smoothly with tone
 * without any rule ever moving. Fixed positions matter: shifting rules to vary
 * spacing produces moire, whereas dropping whole passes does not.
 *
 * @param {object} hillshadeGrid - from computeHillshade, values in 0..1
 * @param {object} [options]
 * @param {number} [options.angle]   - degrees, 0 is horizontal
 * @param {number} [options.spacing] - distance between adjacent rules, in samples
 * @param {number} [options.levels]  - tonal steps
 * @param {number} [options.stepSize]
 * @param {number} [options.minTone] - shade at or above this is left blank
 */
export function hillshadeHatching(hillshadeGrid, options = {}) {
  const {
    angle = 45,
    spacing = 2,
    levels = 4,
    stepSize = 1,
    minTone = 0.92,
  } = options;

  const { width, height } = hillshadeGrid;
  if (!(spacing > 0)) throw new Error('Hatching spacing must be positive');
  if (!(levels >= 1)) throw new Error('Hatching needs at least one tonal level');

  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians);
  const dy = Math.sin(radians);
  // Rule normal, along which the rules are spaced.
  const nx = -dy;
  const ny = dx;

  const centreX = (width - 1) / 2;
  const centreY = (height - 1) / 2;
  const halfSpan = Math.hypot(width, height) / 2;
  const ruleCount = Math.ceil((halfSpan * 2) / spacing);

  const out = [];

  for (let r = 0; r <= ruleCount; ++r) {
    const offset = -halfSpan + r * spacing;
    // Which interleaved pass this rule belongs to.
    const pass = ((r % levels) + levels) % levels;
    // A pass is drawn where darkness has reached its share of the range.
    const threshold = pass / levels;

    const originX = centreX + nx * offset;
    const originY = centreY + ny * offset;

    let run = [];
    const flush = () => {
      if (run.length >= 4) out.push(run);
      run = [];
    };

    for (let t = -halfSpan; t <= halfSpan; t += stepSize) {
      const x = originX + dx * t;
      const y = originY + dy * t;

      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) {
        flush();
        continue;
      }

      const shade = sampleGrid(hillshadeGrid, x, y);
      if (isNoData(shade)) {
        flush();
        continue;
      }

      const darkness = 1 - shade;
      // Blank where the ground is bright, and where this pass is not yet due.
      if (shade >= minTone || darkness < threshold) {
        flush();
        continue;
      }

      run.push(x, y);
    }

    flush();
  }

  return out;
}
