/**
 * Renders a real place from real elevation tiles.
 *
 * Guarded behind REAL_DATA because it goes to the network; `npm test` skips it.
 * Run with:  REAL_DATA=1 SAMPLE_DIR=... npx vitest run scripts/renderRealMap.test.js
 */
import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createNodeTileLoader } from './pngDecode';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { computeRange } from '../src/core/heightField';
import { renderRidgelineScene } from '../src/core/scene';
import { renderTerrain, ALGORITHMS } from '../src/core/algorithms/index';
import { createPage, createPageMapper } from '../src/core/page';
import { buildLayers } from '../src/core/layers';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers, measurePlot } from '../src/core/optimize';
import { fieldToLngLat } from '../src/dem/tileMath';

// Serra da Estrela, Portugal. Torre, the highest point of mainland Portugal,
// stands at 1993m and sits inside this box.
const BBOX = { west: -7.78, south: 40.20, east: -7.42, north: 40.45 };
const TORRE_ELEVATION = 1993;

const OUT = process.env.SAMPLE_DIR || '.';
const enabled = !!process.env.REAL_DATA;

it.skipIf(!enabled)('renders Serra da Estrela from real Terrarium tiles', async () => {
  const loadTile = createNodeTileLoader();

  const { field, zoom, tileCount, missingTiles } = await buildHeightField({
    source: DEM_SOURCES.terrarium,
    bbox: BBOX,
    fieldWidth: 900,
    fieldHeight: 620,
    tileBudget: 64,
    loadTile,
  });

  const range = computeRange(field);
  console.log(
    `REAL zoom=${zoom} tiles=${tileCount} missing=${missingTiles} ` +
      `min=${range.minHeight.toFixed(0)}m max=${range.maxHeight.toFixed(0)}m`
  );

  // Ground truth: the summit must show up, within the sampling error of the grid.
  expect(missingTiles).toBe(0);
  expect(range.maxHeight).toBeGreaterThan(TORRE_ELEVATION - 60);
  expect(range.maxHeight).toBeLessThan(TORRE_ELEVATION + 60);
  expect(range.minHeight).toBeGreaterThan(0);
  expect(range.minHeight).toBeLessThan(600);

  const geo = (x, y) => {
    const { lng, lat } = fieldToLngLat(BBOX, field.width, field.height, x, y);
    return { lat, lon: lng, ele: null };
  };

  // A route over the massif, drawn across the field so it crosses the high ground.
  const route = { name: 'Estrela traverse', points: [] };
  for (let i = 0; i <= 400; ++i) {
    const t = i / 400;
    route.points.push(
      geo(40 + t * 820, 480 - 300 * Math.sin(t * Math.PI) + 40 * Math.sin(t * 11))
    );
  }

  const page = createPage({ paper: 'A3', orientation: 'landscape', margin: 15 });
  const mapper = createPageMapper(page, field);
  const machine = { drawSpeed: 60, travelSpeed: 150, penLiftTime: 0.2 };
  const optimizeOptions = {
    dedupTolerance: 0.05,
    mergeTolerance: 0.15,
    simplifyTolerance: 0.08,
  };

  // 1. Ridge lines with the GPX route on top, dotted where it passes behind a ridge.
  const scene = renderRidgelineScene(field, {
    rowCount: 90,
    heightScale: 70,
    smoothSteps: 2,
    occlude: true,
    tracks: [route],
    trackMode: 'dotted',
    dotPitch: 2.2,
    dotLength: 0.7,
  });

  const withRoute = optimizeLayers(
    buildLayers(scene, mapper, {
      terrainPen: { color: '#161616', width: 0.25 },
      trackPens: [{ color: '#c1272d', width: 0.55 }],
    }),
    optimizeOptions
  );
  const metrics = measurePlot(withRoute, machine);
  writeFileSync(
    `${OUT}/real-estrela-ridgeline-gpx.svg`,
    writeSvg({ page, layers: withRoute, title: 'Serra da Estrela' })
  );
  console.log(
    `REAL ridgeline+gpx layers=${withRoute.length} paths=${metrics.paths} ` +
      `penDown=${metrics.penDownMm.toFixed(0)}mm time=${(metrics.seconds / 60).toFixed(1)}min`
  );

  expect(withRoute.length).toBe(2);
  expect(withRoute[1].id).toBe('route-estrela-traverse');

  // 2. The same real terrain through every algorithm.
  const PENS = ['#161616', '#1a4f7a', '#7a1a1a', '#1a7a3f', '#6b3fa0'];
  for (const id of Object.keys(ALGORITHMS)) {
    const groups = renderTerrain(field, id);
    const layers = optimizeLayers(
      groups.map((g, i) => ({
        id: g.name,
        label: g.name,
        penColor: PENS[i % PENS.length],
        penWidth: Number((0.15 + g.weight * 0.35).toFixed(2)),
        polylines: g.polylines.map((l) => mapper.polylineToMm(l)),
      })),
      optimizeOptions
    );
    const m = measurePlot(layers, machine);
    writeFileSync(
      `${OUT}/real-estrela-${id}.svg`,
      writeSvg({ page, layers, title: `Serra da Estrela — ${ALGORITHMS[id].name}` })
    );
    console.log(
      `REAL ${id.padEnd(20)} paths=${String(m.paths).padStart(5)} ` +
        `penDown=${String(m.penDownMm.toFixed(0)).padStart(6)}mm ` +
        `time=${(m.seconds / 60).toFixed(1)}min`
    );
    expect(m.penDownMm).toBeGreaterThan(0);
  }
}, 240000);
