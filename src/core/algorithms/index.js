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
import { computeGradient, computeHillshade } from '../derived';

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
    defaults: { count: 25, azimuth: 315, classes: 3, useHillshade: true },
    run(field, options) {
      const { azimuth = 315, classes = 3, useHillshade = true } = options;
      const lines = contours(field, options);

      const groups = useHillshade
        ? shadeWeightedClasses(
            lines,
            computeHillshade(computeGradient(field), { azimuth, zFactor: options.zFactor ?? 4 }),
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
