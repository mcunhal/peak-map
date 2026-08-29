/**
 * The rendering worker.
 *
 * The whole pipeline runs here: tiles in, plot-ready layers and SVG out. It has to
 * be off the main thread because the dense algorithms are not close to
 * interactive. Streamlines and hachures over a full sheet take seconds, and
 * upstream's approach of slicing the work across animation frames cannot help when
 * a single pass is that long.
 *
 * Nothing in src/core touches the DOM, which is what makes this possible at all.
 */
import { buildHeightField, loadTilePixels } from '../dem/buildHeightField';
import { getDemSource, unavailableReason } from '../dem/sources';
import { computeRange } from '../core/heightField';
import { renderRidgelineScene } from '../core/scene';
import { renderTerrain, getAlgorithm } from '../core/algorithms/index';
import { createPage, createPageMapper } from '../core/page';
import { buildLayers } from '../core/layers';
import { writeSvg } from '../core/svgWriter';
import { optimizeLayers, measurePlot, compareMetrics, vpypeRecipe } from '../core/optimize';

let currentJob = 0;

self.onmessage = async (event) => {
  const { id, request } = event.data;
  currentJob = id;

  const progress = (message, fraction) => {
    // A superseded job must go quiet rather than fight the newer one for the UI.
    if (currentJob === id) self.postMessage({ id, type: 'progress', message, fraction });
  };

  try {
    const result = await render(request, progress, () => currentJob === id);
    if (currentJob === id) self.postMessage({ id, type: 'done', result });
  } catch (error) {
    if (currentJob === id) {
      self.postMessage({ id, type: 'error', message: error.message || String(error) });
    }
  }
};

async function render(request, progress, stillCurrent) {
  const {
    bbox,
    sourceId = 'terrarium',
    detail = 900,
    algorithm = 'ridgeline',
    algorithmOptions = {},
    tracks = [],
    trackMode = 'dotted',
    page: pageSettings = {},
    pens = {},
    optimize: optimizeSettings = {},
    machine = {},
    background = null,
  } = request;

  const source = getDemSource(sourceId);
  if (!source) throw new Error(unavailableReason(sourceId));

  const page = createPage(pageSettings);

  // Match the sample grid to the sheet, so a landscape page is not sampled as a
  // square and then squashed.
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = Math.round(aspect >= 1 ? detail : detail * aspect);
  const fieldHeight = Math.round(aspect >= 1 ? detail / aspect : detail);

  progress('Downloading elevation tiles', 0);
  const { field, zoom, tileCount, missingTiles } = await buildHeightField({
    source,
    bbox,
    fieldWidth,
    fieldHeight,
    loadTile: loadTilePixels,
    onProgress: ({ loaded, total, message }) =>
      progress(message, total ? (loaded / total) * 0.5 : 0),
  });
  if (!stillCurrent()) return null;

  const range = computeRange(field);
  progress('Generating lines', 0.55);

  const mapper = createPageMapper(page, field);
  const definition = getAlgorithm(algorithm);
  const options = { ...definition.defaults, ...algorithmOptions };

  let layers;

  if (!definition.planar && tracks.length > 0) {
    // The ridgeline family needs terrain and tracks rendered together, because a
    // track is only hidden by terrain nearer than it.
    const scene = renderRidgelineScene(field, { ...options, tracks, trackMode });
    layers = buildLayers(scene, mapper, {
      terrainPen: pens.terrain || { color: '#161616', width: 0.3 },
      trackPens: pens.tracks || [],
    });
  } else {
    const groups = renderTerrain(field, algorithm, options);
    layers = buildLayers(
      {
        terrain: groups.length === 1 ? groups[0].polylines : [],
        tracks: [],
      },
      mapper,
      { terrainPen: pens.terrain || { color: '#161616', width: 0.3 } }
    );

    // Algorithms that vary pen weight return several groups; each is its own pen.
    if (groups.length > 1) {
      layers = groups.map((group, i) => ({
        id: group.name,
        label: group.name,
        penColor: (pens.terrain && pens.terrain.color) || '#161616',
        penWidth: Number((0.15 + group.weight * 0.35).toFixed(2)),
        polylines: group.polylines.map((line) => mapper.polylineToMm(line)),
      }));
    }

    // Planar algorithms have no depth, so a track is simply drawn over the top.
    if (tracks.length > 0) {
      const scene = renderRidgelineScene(field, {
        ...options,
        heightScale: 0,
        rowCount: 1,
        occlude: false,
        tracks,
        trackMode: 'visible',
      });
      layers = layers.concat(
        buildLayers({ terrain: [], tracks: scene.tracks }, mapper, {
          trackPens: pens.tracks || [],
        })
      );
    }
  }

  if (!stillCurrent()) return null;
  progress('Optimizing plot path', 0.85);

  const before = measurePlot(layers, machine);
  const optimized = optimizeLayers(layers, optimizeSettings);
  const after = measurePlot(optimized, machine);

  progress('Writing SVG', 0.95);
  const svg = writeSvg({
    page,
    layers: optimized,
    title: request.title || 'peak map',
    // Without this the sheet is transparent, and viewers that do not paint a
    // background of their own show black strokes on black.
    background,
  });

  return {
    svg,
    page,
    layers: optimized,
    zoom,
    tileCount,
    missingTiles,
    fieldSize: [fieldWidth, fieldHeight],
    elevation: { min: range.minHeight, max: range.maxHeight },
    metrics: compareMetrics(before, after),
    vpype: vpypeRecipe(optimizeSettings),
  };
}
