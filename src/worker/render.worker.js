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
import { readGeoTiff, buildHeightFieldFromRasters } from '../dem/ptLidarRaster';
import { ATTRIBUTION as LIDAR_ATTRIBUTION } from '../dem/ptLidarCatalog';
import { getDemSource, unavailableReason } from '../dem/sources';
import { createRegion, regionFromBbox, lngToTileX, latToTileY, tileXToLng, tileYToLat } from '../dem/tileMath';
import { computeRange } from '../core/heightField';
import { buildTerrainLayers } from '../core/composite';
import { createPage, createPageMapper } from '../core/page';
import { writeSvg } from '../core/svgWriter';
import { optimizeLayers, measurePlot, compareMetrics, vpypeRecipe } from '../core/optimize';
import { compassForPage, compassCutout } from '../core/compass';
import { clipToBounds, subtractPolygon } from '../core/clip';

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
    // The UI sends a list; a single `algorithm` is still accepted so the worker
    // can be driven the old way.
    algorithms = null,
    algorithmOptions = {},
    tracks = [],
    trackMode = 'dotted',
    page: pageSettings = {},
    pens = {},
    optimize: optimizeSettings = {},
    machine = {},
    background = null,
    compass = null,
    weightMode = 'passes',
    weightPasses = 3,
    lidarTiles = [],
    // Hang the planar algorithms on the relief instead of drawing them flat.
    drape = false,
    // How far past the bottom edge of the sheet to sample and draw, as a
    // fraction of the drawable height. The caller extended `regionCorners` by
    // the same fraction; see the note above `fieldHeight` below.
    overplot = 0,
  } = request;

  // LiDAR replaces the tiled sources rather than supplementing them: when the
  // caller has supplied rasters, they already cover the sheet at a resolution
  // no web-mercator tile pyramid reaches, and mixing the two would seam.
  const usingLidar = Array.isArray(lidarTiles) && lidarTiles.length > 0;

  const source = usingLidar ? null : getDemSource(sourceId);
  if (!usingLidar && !source) throw new Error(unavailableReason(sourceId));

  // The sheet is a rotated rectangle in general; a bounding box is the north-up
  // special case, kept so the worker can still be driven with one.
  const region = regionCorners ? createRegion(regionCorners) : regionFromBbox(bbox);

  const page = createPage(pageSettings);

  // Match the sample grid to the sheet, so a landscape page is not sampled as a
  // square and then squashed.
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = Math.round(aspect >= 1 ? detail : detail * aspect);
  const sheetRowCount = Math.round(aspect >= 1 ? detail / aspect : detail);

  /**
   * Over-plot below the near edge.
   *
   * A peak sitting on the bottom row is lifted up the page by the relief, and
   * the paper beneath it comes out blank, because there is no nearer ground to
   * draw there. So the caller unprojects a screen rectangle that reaches past
   * the sheet, and the extra rows are drawn and then cut off at the page edge.
   *
   * Screen-to-ground is a homography and `createRegion` fits one through four
   * corners, so lengthening the rectangle re-parametrises the same map: row
   * `sheetHeight` lands exactly where the old bottom row did, and nothing above
   * it moves. That is what makes this safe to do to a finished sheet.
   *
   * `sheetHeight` is deliberately fractional. Rounding it to a whole row would
   * put the sheet's edge a sample away from where the caller extended it.
   */
  const overplotFraction = Number.isFinite(overplot) ? Math.max(0, overplot) : 0;
  const fieldHeight = Math.round(sheetRowCount * (1 + overplotFraction));
  const sheetHeight = overplotFraction > 0 ? fieldHeight / (1 + overplotFraction) : null;

  let field, zoom = null, tileCount = 0, missingTiles = 0, lidarCoverage = null;

  if (usingLidar) {
    // Decoding happens here rather than on the main thread: a 50cm tile is
    // 2000x2000 floats, and decoding a sheetful of them would stall the map.
    progress('Decoding LiDAR tiles', 0);
    const { fromArrayBuffer } = await import('geotiff');

    const rasters = [];
    for (let i = 0; i < lidarTiles.length; ++i) {
      const bytes = lidarTiles[i] && lidarTiles[i].bytes ? lidarTiles[i].bytes : lidarTiles[i];
      try {
        rasters.push(await readGeoTiff(bytes, { fromArrayBuffer }));
      } catch (err) {
        // One unreadable tile should leave a hole, not lose the whole sheet.
        missingTiles += 1;
      }
      progress('Decoding LiDAR tiles', ((i + 1) / lidarTiles.length) * 0.5);
      if (!stillCurrent()) return null;
    }

    const built = buildHeightFieldFromRasters({
      region,
      rasters,
      fieldWidth,
      fieldHeight,
      sheetHeight,
    });
    field = built.field;
    tileCount = built.tilesUsed;
    lidarCoverage = built.coverage;
  } else {
    progress('Downloading elevation tiles', 0);
    ({ field, zoom, tileCount, missingTiles } = await buildHeightField({
      source,
      region,
      fieldWidth,
      fieldHeight,
      sheetHeight,
      loadTile: loadTilePixels,
      onProgress: ({ loaded, total, message }) =>
        progress(message, total ? (loaded / total) * 0.5 : 0),
    }));
  }
  if (!stillCurrent()) return null;

  // Reported to the panel, so it describes the drawing rather than the data
  // behind it: a coastal sheet whose lowest sample is 5km of Atlantic seabed
  // would otherwise say it spans ground it never draws.
  const range = computeRange(field, {
    floor: Number.isFinite(algorithmOptions.oceanLevel)
      ? algorithmOptions.oceanLevel
      : undefined,
  });
  progress('Generating lines', 0.55);

  const mapper = createPageMapper(page, field);

  // Choosing and combining the algorithms is `core/composite.js`: it is pure, so
  // the combination rules can be tested against synthetic terrain rather than
  // only through a worker that needs a tile server to say anything at all.
  let layers = buildTerrainLayers({
    field,
    mapper,
    algorithmIds: algorithms && algorithms.length > 0 ? algorithms : [algorithm],
    algorithmOptions,
    pens,
    tracks,
    trackMode,
    drape,
    weightMode,
    weightPasses,
  });

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

    const placement = {
      radius: compass.radius,
      corner: compass.corner,
      project,
    };

    const polylines = compassForPage(page, placement);
    if (polylines.length) {
      // Clean paper under the rose. A compass drawn on top of ridge lines is
      // unreadable, and a plotter cannot fill a disc behind it, so the map is
      // cut away instead. The cut-out goes through the same placement the rose
      // does, which is what keeps the two agreeing on a tilted sheet where the
      // rose is an ellipse rather than a circle.
      const cutout = compassCutout(page, {
        ...placement,
        margin: Number.isFinite(compass.margin) ? compass.margin : 1.5,
      });
      layers = layers.map((layer) => ({
        ...layer,
        polylines: subtractPolygon(layer.polylines, cutout),
      }));

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

  // Cut the over-plot off at the near edge of the sheet.
  //
  // Only the bottom: a far ridge lifted above the top edge runs off the paper
  // today, and clipping it here would change every sheet rather than only the
  // ones this feature touches.
  if (sheetHeight) {
    const bottom = page.drawable.y + page.drawable.height;
    layers = layers.map((layer) => ({
      ...layer,
      polylines: clipToBounds(layer.polylines, { maxY: bottom }),
    }));
  }

  // Clipping empties a layer whose every stroke was under the rose, and an empty
  // layer is a pen the plotter would be asked to select for nothing.
  layers = layers.filter((layer) => layer.polylines.length > 0);

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
    // CC-BY-4.0 requires the credit to travel with the work, and the SVG is
    // what actually leaves: it gets plotted, shared and filed long after this
    // page is closed.
    attribution: usingLidar ? LIDAR_ATTRIBUTION.text : null,
  });

  return {
    svg,
    page,
    layers: optimized,
    zoom,
    tileCount,
    missingTiles,
    // Null unless LiDAR was used; a fraction below 1 means part of the sheet
    // had no tile, which is worth saying rather than leaving as blank paper.
    lidarCoverage,
    fieldSize: [fieldWidth, fieldHeight],
    elevation: { min: range.minHeight, max: range.maxHeight },
    metrics: compareMetrics(before, after),
    vpype: vpypeRecipe(optimizeSettings),
  };
}
