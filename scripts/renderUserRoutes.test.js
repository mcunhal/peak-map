/**
 * Renders real GPX routes over real elevation data.
 *
 * Guarded behind GPX_DIR so `npm test` stays offline and self-contained.
 *   GPX_DIR=... SAMPLE_DIR=... npx vitest run scripts/renderUserRoutes.test.js
 */
import { it, expect } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNodeTileLoader } from './pngDecode';
import { parseGpx, trackBounds } from '../src/gpx/parse';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { computeRange } from '../src/core/heightField';
import { renderRidgelineScene } from '../src/core/scene';
import { renderTerrain } from '../src/core/algorithms/index';
import { createPage, createPageMapper } from '../src/core/page';
import { buildLayers } from '../src/core/layers';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers, measurePlot } from '../src/core/optimize';

const GPX_DIR = process.env.GPX_DIR;
const OUT = process.env.SAMPLE_DIR || '.';

/** Grow a bounding box by a fraction of its own size, so routes are not flush to the edge. */
function padBbox(bbox, fraction = 0.12) {
  const dx = (bbox.east - bbox.west) * fraction;
  const dy = (bbox.north - bbox.south) * fraction;
  return {
    west: bbox.west - dx,
    south: bbox.south - dy,
    east: bbox.east + dx,
    north: bbox.north + dy,
  };
}

it.skipIf(!GPX_DIR)('renders real routes over real terrain', async () => {
  const files = readdirSync(GPX_DIR).filter((f) => f.toLowerCase().endsWith('.gpx')).sort();
  expect(files.length).toBeGreaterThan(0);

  // One pen per file, not per segment. A day's ride arrives as a dozen segments
  // because the recorder paused; they are one route to anyone reading the map.
  const tracks = [];
  const fileOfTrack = [];
  const fileNames = [];
  files.forEach((file, fileIndex) => {
    const name = file.replace(/\.gpx$/i, '');
    const parsed = parseGpx(readFileSync(join(GPX_DIR, file), 'utf8'), name);
    for (const track of parsed) {
      tracks.push(track);
      fileOfTrack.push(fileIndex);
    }
    fileNames.push(name);
    console.log(
      `GPX ${file.padEnd(24)} segments=${parsed.length} points=${parsed.reduce((n, t) => n + t.points.length, 0)}`
    );
  });

  const extent = trackBounds(tracks);
  console.log(
    `GPX extent W${extent.west.toFixed(3)} S${extent.south.toFixed(3)} ` +
      `E${extent.east.toFixed(3)} N${extent.north.toFixed(3)} tracks=${tracks.length}`
  );

  const bbox = padBbox(extent);
  const page = createPage({ paper: 'A2', orientation: 'landscape', margin: 18 });
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = 1100;
  const fieldHeight = Math.round(fieldWidth / aspect);

  const { field, zoom, tileCount, missingTiles } = await buildHeightField({
    source: DEM_SOURCES.terrarium,
    bbox,
    fieldWidth,
    fieldHeight,
    tileBudget: 120,
    loadTile: createNodeTileLoader(),
  });

  const range = computeRange(field);
  console.log(
    `GPX terrain zoom=${zoom} tiles=${tileCount} missing=${missingTiles} ` +
      `field=${fieldWidth}x${fieldHeight} min=${range.minHeight.toFixed(0)}m max=${range.maxHeight.toFixed(0)}m`
  );
  expect(missingTiles).toBe(0);
  expect(range.maxHeight).toBeGreaterThan(range.minHeight);

  const mapper = createPageMapper(page, field);
  const machine = { drawSpeed: 60, travelSpeed: 150, penLiftTime: 0.2 };
  const optimizeOptions = { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 };
  const palette = ['#c1272d', '#0b6e99', '#1a7f37', '#b8860b', '#6b3fa0', '#c2560f', '#00808a'];
  const trackPens = tracks.map((_, i) => ({
    color: palette[fileOfTrack[i] % palette.length],
    width: 0.55,
  }));

  /** Fold the per-segment layers back into one layer per file. */
  function groupByFile(layers) {
    const terrain = layers.filter((l) => !l.id.startsWith('route-'));
    const routes = layers.filter((l) => l.id.startsWith('route-'));
    const byFile = new Map();

    routes.forEach((layer, i) => {
      const fileIndex = fileOfTrack[i] ?? 0;
      const existing = byFile.get(fileIndex);
      if (existing) {
        existing.polylines.push(...layer.polylines);
      } else {
        byFile.set(fileIndex, {
          ...layer,
          id: 'route-' + fileNames[fileIndex].toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          label: fileNames[fileIndex],
          polylines: [...layer.polylines],
        });
      }
    });

    return [...terrain, ...byFile.values()];
  }

  // 1. Ridge lines, routes riding the terrain, dotted where they pass behind a ridge.
  const scene = renderRidgelineScene(field, {
    rowCount: 120,
    heightScale: 62,
    smoothSteps: 2,
    occlude: true,
    oceanLevel: 0,
    tracks,
    trackMode: 'dotted',
    dotPitch: 2.0,
    dotLength: 0.65,
  });

  const ridgeLayers = optimizeLayers(
    groupByFile(
      buildLayers(scene, mapper, {
        terrainPen: { color: '#161616', width: 0.22 },
        trackPens,
      })
    ),
    optimizeOptions
  );
  const ridgeMetrics = measurePlot(ridgeLayers, machine);
  writeFileSync(
    `${OUT}/routes-ridgeline.svg`,
    writeSvg({ page, layers: ridgeLayers, title: 'Routes over Serra da Estrela', background: '#ffffff' })
  );
  console.log(
    `GPX ridgeline layers=${ridgeLayers.length} paths=${ridgeMetrics.paths} ` +
      `penDown=${ridgeMetrics.penDownMm.toFixed(0)}mm time=${(ridgeMetrics.seconds / 60).toFixed(1)}min`
  );

  // One terrain layer plus one per route that actually crossed the sheet.
  expect(ridgeLayers.length).toBeGreaterThan(1);
  expect(ridgeLayers[0].id).toBe('terrain');

  // 2. Contours with the routes drawn flat over them, which is the planar case.
  const contourGroups = renderTerrain(field, 'contours', { count: 34, base: 0 });
  const flat = renderRidgelineScene(field, {
    rowCount: 1,
    heightScale: 0,
    occlude: false,
    tracks,
    trackMode: 'visible',
  });

  const contourLayers = optimizeLayers(
    [
      {
        id: 'contours',
        label: 'contours',
        penColor: '#5a5a5a',
        penWidth: 0.2,
        polylines: contourGroups[0].polylines.map((l) => mapper.polylineToMm(l)),
      },
      ...groupByFile(
        buildLayers({ terrain: [], tracks: flat.tracks }, mapper, { trackPens })
      ),
    ],
    optimizeOptions
  );
  const contourMetrics = measurePlot(contourLayers, machine);
  writeFileSync(
    `${OUT}/routes-contours.svg`,
    writeSvg({ page, layers: contourLayers, title: 'Routes on contours', background: '#ffffff' })
  );
  console.log(
    `GPX contours  layers=${contourLayers.length} paths=${contourMetrics.paths} ` +
      `penDown=${contourMetrics.penDownMm.toFixed(0)}mm time=${(contourMetrics.seconds / 60).toFixed(1)}min`
  );

  expect(contourLayers.length).toBeGreaterThan(1);
}, 600000);
