/**
 * The algorithm registry.
 *
 * Every terrain-to-line algorithm has the same shape:
 *
 *     run(field, options) -> Array<{ name, polylines, weight }>
 *
 * A group is a set of strokes meant for one pen. Most algorithms return a single
 * group; the ones that vary line weight to convey relief return several, because a
 * pen cannot change width partway along a stroke. Weight is a hint in 0..1 that the
 * caller maps onto pen widths or extra passes.
 *
 * Occlusion belongs to the ridgeline family alone: contours and hatching are
 * top-down, and nothing is behind anything. `planar` records that, since it decides
 * whether GPX tracks get occlusion modes or a knockout corridor.
 */
import { ridgeline } from './ridgeline';
import { contours, contourLevels, tanakaClasses, shadeWeightedClasses, chooseLevels } from './contours';
import { computeGradient, computeHillshade, computeSlope } from '../derived';
import { evenlySpacedStreamlines } from './streamlines';
import { hachures, hillshadeHatching } from './hachures';

/**
 * Vertical exaggeration for every algorithm lit by a hillshade.
 *
 * Tanaka and the hatching render the same hillshade from the same sun, so they
 * have to exaggerate it by the same amount or one light gives a sheet two
 * different reliefs. They disagreed — 4 against 3 — because Tanaka's lived as a
 * `?? 4` inside `run`, where the defaults table could not see it and the UI
 * could not report it. One constant, read by both.
 */
const HILLSHADE_Z_FACTOR = 3;

/**
 * The two lit algorithms both need the gradient in ground units, not sample ones.
 *
 * `composite.js` measures the ground a sample covers and puts it in the options
 * bag; a field with no geography behind it has none, and `computeGradient` then
 * falls back to its own unit run. Both callers go through here so they cannot
 * drift apart the way the exaggeration above once did.
 */
const litGradient = (field, options) =>
  computeGradient(field, { cellSize: options.groundCellSize });

export const ALGORITHMS = {
  ridgeline: {
    id: 'ridgeline',
    name: 'Ridge lines',
    description:
      'Horizontal scanlines displaced by elevation, with hidden-line removal. The Joy Division look.',
    planar: false,
    defaults: { rowCount: 60, heightScale: 60, smoothSteps: 2, occlude: true },
    run(field, options) {
      return [{ name: 'terrain', weight: 1, polylines: ridgeline(field, options) }];
    },
  },

  contours: {
    id: 'contours',
    name: 'Contour lines',
    description:
      'Isolines at fixed elevation intervals by marching squares. The classic topographic map.',
    planar: true,
    defaults: { count: 25, interval: null },
    run(field, options) {
      return [{ name: 'contours', weight: 1, polylines: contours(field, options) }];
    },
  },

  'contours-by-level': {
    id: 'contours-by-level',
    name: 'Contour lines, one pen per level',
    description:
      'The same isolines, split by elevation so index contours can take a heavier pen.',
    planar: true,
    defaults: { count: 20, interval: null, indexEvery: 5 },
    run(field, options) {
      const { indexEvery = 5 } = options;
      return contourLevels(field, options).map((group, i) => ({
        name: `contour-${group.level}`,
        // Every nth contour is an index contour, drawn heavier, as on a paper map.
        weight: i % indexEvery === 0 ? 1 : 0.5,
        level: group.level,
        polylines: group.polylines,
      }));
    },
  },

  tanaka: {
    id: 'tanaka',
    name: 'Illuminated contours (Tanaka)',
    description:
      'Contours whose weight follows the light, so flat isolines read as relief.',
    planar: true,
    defaults: {
      count: 25,
      azimuth: 315,
      classes: 3,
      useHillshade: true,
      zFactor: HILLSHADE_Z_FACTOR,
      // Ground metres per sample; null means the run is one field unit.
      groundCellSize: null,
    },
    run(field, options) {
      const { azimuth = 315, classes = 3, useHillshade = true } = options;
      const lines = contours(field, options);

      const groups = useHillshade
        ? shadeWeightedClasses(
            lines,
            computeHillshade(litGradient(field, options), {
              azimuth,
              zFactor: options.zFactor,
            }),
            { classes }
          )
        : tanakaClasses(lines, { azimuth, classes });

      return groups.map((group, i) => ({
        name: `tanaka-${i + 1}`,
        weight: group.weight,
        polylines: group.polylines,
      }));
    },
  },

  streamlines: {
    id: 'streamlines',
    name: 'Streamlines (Jobard & Lefer)',
    description:
      'Evenly-spaced strokes following the slope downhill, so the drawing reads as drainage and spurs.',
    planar: true,
    defaults: { separation: 5, mode: 'slope', stepSize: 0.5, minLength: 4 },
    run(field, options) {
      return [
        {
          name: 'streamlines',
          weight: 1,
          polylines: evenlySpacedStreamlines(computeGradient(field), options),
        },
      ];
    },
  },

  'streamlines-contour': {
    id: 'streamlines-contour',
    name: 'Streamlines along the hillside',
    description:
      'The same even spacing, but following the perpendicular: contour-like strokes at even spacing rather than at fixed elevations.',
    planar: true,
    defaults: { separation: 5, mode: 'contour', stepSize: 0.5, minLength: 4 },
    run(field, options) {
      return [
        {
          name: 'streamlines-contour',
          weight: 1,
          polylines: evenlySpacedStreamlines(computeGradient(field), {
            ...options,
            mode: 'contour',
          }),
        },
      ];
    },
  },

  hachures: {
    id: 'hachures',
    name: 'Hachures',
    description:
      'Short strokes down the slope, longer and denser where the ground is steeper. Level ground is left blank.',
    planar: true,
    defaults: { separation: 4, minStroke: 1.5, maxStroke: 7, gap: 2.5 },
    run(field, options) {
      const gradient = computeGradient(field);
      return [
        {
          name: 'hachures',
          weight: 1,
          polylines: hachures(gradient, computeSlope(gradient), options),
        },
      ];
    },
  },

  'hillshade-hatching': {
    id: 'hillshade-hatching',
    name: 'Hillshade hatching',
    description:
      'Straight parallel rules whose local density follows a hillshade, rendering tone rather than structure.',
    planar: true,
    defaults: {
      angle: 45,
      spacing: 2,
      toneLevels: 4,
      azimuth: 315,
      zFactor: HILLSHADE_Z_FACTOR,
      // Ground metres per sample; null means the run is one field unit.
      groundCellSize: null,
    },
    run(field, options) {
      const shade = computeHillshade(litGradient(field, options), {
        azimuth: options.azimuth,
        zFactor: options.zFactor,
      });
      return [
        {
          name: 'hatching',
          weight: 1,
          // Renamed at this boundary so it cannot collide with the contour levels.
          polylines: hillshadeHatching(shade, { ...options, levels: options.toneLevels }),
        },
      ];
    },
  },
};

export const DEFAULT_ALGORITHM = 'ridgeline';

/** The algorithms a UI can offer, in a stable order. */
export function listAlgorithms() {
  return Object.values(ALGORITHMS).map(({ id, name, description, planar }) => ({
    id,
    name,
    description,
    planar,
  }));
}

export function getAlgorithm(id) {
  const algorithm = ALGORITHMS[id];
  if (!algorithm) {
    throw new Error(
      `Unknown algorithm "${id}"; expected one of ${Object.keys(ALGORITHMS).join(', ')}`
    );
  }
  return algorithm;
}

/**
 * Run an algorithm with its defaults filled in.
 *
 * @returns {Array<{name, polylines, weight}>}
 */
export function renderTerrain(field, id = DEFAULT_ALGORITHM, options = {}) {
  const algorithm = getAlgorithm(id);
  return algorithm.run(field, { ...algorithm.defaults, ...options });
}

export { chooseLevels };
