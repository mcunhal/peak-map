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
import { createRegion, regionFromBbox, lngToTileX, latToTileY, tileXToLng, tileYToLat } from '../dem/tileMath';
import { computeRange } from '../core/heightField';
import { renderRidgelineScene } from '../core/scene';
import { renderTerrain, getAlgorithm } from '../core/algorithms/index';
import { createPage, createPageMapper } from '../core/page';
import { buildLayers } from '../core/layers';
import { writeSvg } from '../core/svgWriter';
import { optimizeLayers, measurePlot, compareMetrics, vpypeRecipe } from '../core/optimize';
import { compassForPage } from '../core/compass';

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
    bbox = null,
    regionCorners = null,
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
    compass = null,
  } = request;

  const source = getDemSource(sourceId);
  if (!source) throw new Error(unavailableReason(sourceId));

  // The sheet is a rotated rectangle in general; a bounding box is the north-up
  // special case, kept so the worker can still be driven with one.
  const region = regionCorners ? createRegion(regionCorners) : regionFromBbox(bbox);

  const page = createPage(pageSettings);

  // Match the sample grid to the sheet, so a landscape page is not sampled as a
  // square and then squashed.
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = Math.round(aspect >= 1 ? detail : detail * aspect);
  const fieldHeight = Math.round(aspect >= 1 ? detail / aspect : detail);

  progress('Downloading elevation tiles', 0);
  const { field, zoom, tileCount, missingTiles } = await buildHeightField({
    source,
    region,
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

  const sized = {};
  for (const [key, fallback] of Object.entries(MILLIMETRE_OPTIONS)) {
    if (algorithmOptions[key] !== undefined) sized[key] = mm(algorithmOptions[key], fallback);
  }

  const options = { ...definition.defaults, ...algorithmOptions, ...sized };
  // Integration step follows the separation, so it never needs its own setting.
  // An eighth keeps hachure cutting stable: a coarser step overshoots the gap
  // logic and triples the number of strokes.
  if (sized.separation) options.stepSize = Math.max(0.25, sized.separation / 8);
  if (sized.smoothSteps !== undefined) {
    options.smoothSteps = Math.max(0, Math.round(sized.smoothSteps));
  }

  let layers;

  if (!definition.planar && tracks.length > 0) {
    // The ridgeline family needs terrain and tracks rendered together, because a
    // track is only hidden by terrain nearer than it.
    const scene = renderRidgelineScene(field, {
      ...options,
      tracks,
      trackMode,
      dotPitch: mm(request.dotPitch, 0.9),
      dotLength: mm(request.dotLength, 0.3),
    });
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

  // Its own layer, so it can be plotted in a different pen or left off the
  // sheet entirely without touching the map.
  if (compass && compass.show) {
    // Page millimetres to the projected sphere and back, so the rose can be
    // drawn where it lies on the ground rather than stuck flat to the paper.
    const pageToGround = (xMm, yMm) => {
      const fx = (xMm - mapper.offsetX) / mapper.scale;
      const fy = (yMm - mapper.offsetY) / mapper.scale;
      const p = region.toLngLat(fieldWidth, fieldHeight, fx, fy);
      return [lngToTileX(p.lng, 0), latToTileY(p.lat, 0)];
    };
    const groundToPage = (gx, gy) => {
      const f = region.fromLngLat(fieldWidth, fieldHeight, tileXToLng(gx, 0), tileYToLat(gy, 0));
      return [mapper.offsetX + f.x * mapper.scale, mapper.offsetY + f.y * mapper.scale];
    };

    /**
     * A transform from the rose's own frame onto the page.
     *
     * The ground radius is solved for, rather than assumed, by measuring how far
     * a small step on the ground moves on the page at the rose's position. Under
     * perspective that scale differs across the sheet, so it has to be taken
     * where the rose actually is.
     */
    const project = (cxMm, cyMm, radiusMm) => {
      const [gx, gy] = pageToGround(cxMm, cyMm);
      if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;

      const probe = 1e-6;
      const [px, py] = groundToPage(gx + probe, gy);
      const mmPerGround = Math.hypot(px - cxMm, py - cyMm) / probe;
      if (!Number.isFinite(mmPerGround) || mmPerGround <= 0) return null;

      let groundRadius = radiusMm / mmPerGround;

      // A rose far up a tilted sheet stretches a long way. Shrink it until it
      // stays inside the margins rather than letting it run off the paper.
      const { drawable } = page;
      const fits = (r) => {
        for (const [lx, ly] of [[-1.05, -1.5], [1.05, -1.5], [-1.05, 1.05], [1.05, 1.05]]) {
          const [x, y] = groundToPage(gx + lx * r, gy + ly * r);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
          if (x < drawable.x || x > drawable.x + drawable.width) return false;
          if (y < drawable.y || y > drawable.y + drawable.height) return false;
        }
        return true;
      };
      for (let i = 0; i < 8 && !fits(groundRadius); ++i) groundRadius *= 0.8;

      return (lx, ly) => groundToPage(gx + lx * groundRadius, gy + ly * groundRadius);
    };

    const polylines = compassForPage(page, {
      radius: compass.radius,
      corner: compass.corner,
      project,
    });
    if (polylines.length) {
      layers = layers.concat([
        {
          id: 'compass',
          label: 'compass',
          penColor: compass.color || '#161616',
          penWidth: compass.width ?? 0.35,
          polylines,
        },
      ]);
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
