/**
 * Turns a selection of algorithms into the layers that get plotted.
 *
 * More than one algorithm can share a sheet, and there are two ways to put them
 * there:
 *
 *   flat    every algorithm draws in plan view, one layer after another. They
 *           overlap as ink on paper overlaps, and nothing hides anything.
 *   draped  the planar algorithms are lifted onto the same displaced surface the
 *           ridge lines are drawn on, and hidden-line removed against it, so a
 *           contour wraps over the near face of a ridge and stops at its edge.
 *
 * Draping has to be one pass, not one per algorithm: occlusion is decided in
 * depth order, so the terrain rows and every draped line must be interleaved in
 * the same walk from the front of the field to the back. That is the whole
 * reason this lives here rather than inside the loop it replaces.
 *
 * This module is pure, and takes a height field rather than fetching one, so the
 * combination logic can be tested without a tile server. The rendering worker is
 * then only tiles in, SVG out.
 */
import { renderRidgelineScene } from './scene';
import { renderTerrain, getAlgorithm } from './algorithms/index';
import { buildLayers } from './layers';
import { sheetRows } from './heightField';

/** Options the app supplies in millimetres, with the default each falls back to. */
const MILLIMETRE_OPTIONS = {
  heightScale: 26,
  separation: 4,
  spacing: 0.9,
  smoothSteps: 0.9,
  minStroke: 0.8,
  maxStroke: 3.5,
  gap: 1.2,
};

const DEFAULT_PEN = { color: '#161616', width: 0.3 };

/**
 * @param {object}   args
 * @param {object}   args.field          - the height field to draw
 * @param {object}   args.mapper         - page mapper, which also fixes the mm scale
 * @param {string[]} args.algorithmIds   - the algorithms to draw, in plotting order
 * @param {object}   [args.algorithmOptions] - settings, sizes in millimetres
 * @param {object}   [args.pens]         - {terrain, tracks[], algorithmPens{}}
 * @param {Array}    [args.tracks]       - parsed GPX tracks
 * @param {boolean}  [args.drape]        - hang the planar algorithms on the relief
 * @returns {Array} plot-ready layers, in page millimetres
 */
export function buildTerrainLayers({
  field,
  mapper,
  algorithmIds,
  algorithmOptions = {},
  pens = {},
  tracks = [],
  trackMode = 'dotted',
  dotPitch = 0.9,
  dotLength = 0.3,
  drape = false,
  weightMode = 'passes',
  weightPasses = 3,
}) {
  const ids = algorithmIds && algorithmIds.length ? algorithmIds : ['ridgeline'];

  // Every setting with a size arrives in millimetres and is converted here.
  //
  // The algorithms work in field samples, which is right for them, but a sample
  // is not a fixed size: raising the detail makes samples smaller, so a relief
  // of "60 samples" silently shrank from 74mm of paper to 14mm as detail went
  // from 300 to 1600. Detail should decide how much the data resolves, and
  // nothing else. Converting at this boundary is what makes that true.
  const samplesPerMm = 1 / mapper.scale;
  const mm = (value, fallback) =>
    (Number.isFinite(value) ? value : fallback) * samplesPerMm;

  // Line count is a count, not a size, and it is asked of the *sheet*. The
  // field can be taller than the sheet, because the bottom edge is over-plotted
  // so that a peak sitting on it does not leave the paper beneath it blank.
  // Spreading the requested number of lines over the taller field would thin
  // them out on the page — the same silent failure the millimetre table above
  // exists to prevent, arriving from the other direction. Ask for enough lines
  // to cover the whole field at the pitch the sheet was promised.
  const overplotRatio = field.height / sheetRows(field);

  const trackDots = { dotPitch: mm(dotPitch, 0.9), dotLength: mm(dotLength, 0.3) };

  /** One algorithm's settings, with its own defaults underneath. */
  function optionsFor(algorithmId) {
    const { defaults } = getAlgorithm(algorithmId);

    const sized = {};
    for (const [key, fallback] of Object.entries(MILLIMETRE_OPTIONS)) {
      if (algorithmOptions[key] !== undefined) sized[key] = mm(algorithmOptions[key], fallback);
    }

    const options = { ...defaults, ...algorithmOptions, ...sized };
    if (overplotRatio > 1 && Number.isFinite(options.rowCount)) {
      options.rowCount = Math.round(options.rowCount * overplotRatio);
    }
    // Integration step follows the separation, so it never needs its own setting.
    // An eighth keeps hachure cutting stable: a coarser step overshoots the gap
    // logic and triples the number of strokes.
    if (sized.separation) options.stepSize = Math.max(0.25, sized.separation / 8);
    if (sized.smoothSteps !== undefined) {
      options.smoothSteps = Math.max(0, Math.round(sized.smoothSteps));
    }
    return options;
  }

  const penFor = (algorithmId) =>
    (pens.algorithmPens && pens.algorithmPens[algorithmId]) || pens.terrain || DEFAULT_PEN;

  /**
   * Algorithms that vary line weight return several groups. There are two ways
   * to honour that on a plotter, and they are not equivalent:
   *
   *   passes  draw the heavier groups more than once, so one pen renders the
   *           whole sheet. Costs plotting time.
   *   pen     give each group its own width, which needs the pens actually
   *           swapped between layers. Free, if you are willing to do that.
   *
   * Passes is the default, because a sheet plotted with one pen and no
   * intervention is the case that has to work.
   */
  function layersFromGroups(algorithmId, groups, polylinesOf) {
    const pen = penFor(algorithmId);

    if (groups.length === 1) {
      const polylines = polylinesOf(groups[0]);
      if (!polylines.length) return [];
      return [
        {
          id: algorithmId,
          label: algorithmId,
          penColor: pen.color,
          penWidth: Number(pen.width),
          polylines,
        },
      ];
    }

    const byPasses = (weightMode || 'passes') === 'passes';
    const maxPasses = Math.max(1, Math.round(weightPasses || 3));

    return groups
      .map((group) => ({
        id: group.name,
        label: group.name,
        penColor: pen.color,
        penWidth: byPasses
          ? Number(pen.width)
          : Number((0.15 + group.weight * 0.35).toFixed(2)),
        passes: byPasses ? Math.max(1, Math.round(group.weight * maxPasses)) : 1,
        polylines: polylinesOf(group),
      }))
      .filter((layer) => layer.polylines.length > 0);
  }

  const toMm = (polylines) => polylines.map((line) => mapper.polylineToMm(line));

  return drape ? draped() : flat();

  /** Plan view: each algorithm drawn in turn, overlapping as ink does. */
  function flat() {
    const layers = [];
    let tracksDrawn = false;

    for (const algorithmId of ids) {
      const definition = getAlgorithm(algorithmId);
      const options = optionsFor(algorithmId);

      if (!definition.planar && tracks.length > 0) {
        // The ridgeline family needs terrain and tracks rendered together,
        // because a track is only hidden by terrain nearer than it.
        const scene = renderRidgelineScene(field, {
          ...options,
          tracks,
          trackMode,
          ...trackDots,
        });
        layers.push(
          ...buildLayers(scene, mapper, {
            terrainPen: penFor(algorithmId),
            trackPens: pens.tracks || [],
            terrainId: algorithmId,
          })
        );
        tracksDrawn = true;
        continue;
      }

      const groups = renderTerrain(field, algorithmId, options);
      layers.push(
        ...layersFromGroups(algorithmId, groups, (group) => toMm(group.polylines))
      );
    }

    // Planar algorithms have no depth, so a track is simply drawn over the top.
    if (!tracksDrawn && tracks.length > 0) {
      layers.push(...flatTracks());
    }

    return layers;
  }

  /** Relief view: everything planar hung on the surface, and cut where it is hidden. */
  function draped() {
    // Whichever non-planar algorithm is selected supplies the relief. When none
    // is, the relief is still built — it just is not drawn, so the drapes are
    // occluded by ground that never reaches the paper.
    const reliefId = ids.find((id) => !getAlgorithm(id).planar);
    const planarIds = ids.filter((id) => getAlgorithm(id).planar);

    // Group names are what the weighted algorithms layer by, so a drape keeps
    // its group's identity and each one can still take its own pen and passes.
    const drapes = [];
    const groupsById = new Map();

    for (const algorithmId of planarIds) {
      const groups = renderTerrain(field, algorithmId, optionsFor(algorithmId));
      groupsById.set(algorithmId, groups);
      for (const group of groups) {
        drapes.push({
          id: groups.length === 1 ? algorithmId : group.name,
          polylines: group.polylines,
        });
      }
    }

    const scene = renderRidgelineScene(field, {
      ...optionsFor(reliefId || 'ridgeline'),
      tracks,
      trackMode,
      ...trackDots,
      drapes,
      emitTerrain: Boolean(reliefId),
    });

    const occluded = new Map(scene.drapes.map((d) => [d.id, d.polylines]));

    const layers = buildLayers(scene, mapper, {
      terrainPen: penFor(reliefId || 'ridgeline'),
      trackPens: pens.tracks || [],
      terrainId: reliefId || 'terrain',
    });

    for (const algorithmId of planarIds) {
      const groups = groupsById.get(algorithmId);
      layers.push(
        ...layersFromGroups(algorithmId, groups, (group) =>
          toMm(occluded.get(groups.length === 1 ? algorithmId : group.name) || [])
        )
      );
    }

    return layers;
  }

  /** Tracks with no relief to hide them: laid flat over whatever was drawn. */
  function flatTracks() {
    const scene = renderRidgelineScene(field, {
      ...optionsFor(ids[0]),
      heightScale: 0,
      rowCount: 1,
      occlude: false,
      tracks,
      trackMode: 'visible',
    });
    return buildLayers({ terrain: [], tracks: scene.tracks }, mapper, {
      trackPens: pens.tracks || [],
    });
  }
}
