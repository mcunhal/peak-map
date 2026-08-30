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
import { buildTerrainLayers } from '../src/core/composite';
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

/**
 * The Lisbon coast, where the seabed is real and deep.
 *
 * This is the sheet that exposed the ocean bug: Terrarium carries bathymetry, so
 * the lowest sample here is Atlantic floor, not ground. The ridge lines stopped
 * at the shore while the hachures, both streamline modes and the hillshade
 * hatching drew the seabed, because everything they see arrives through
 * `computeGradient`, which knows only about nodata.
 *
 * Synthetic terrain shows this too, in `composite.test.js`. Only a real coast
 * proves the bathymetry is as deep as the fix assumes.
 */
const COAST_BBOX = { west: -10.2, south: 38.4, east: -9.2, north: 39.1 };

/**
 * A small tile budget on purpose, which forces zoom 10.
 *
 * Terrarium only carries the deep bathymetry at low zoom: the same box gives
 * -4850m at z10 and -8m at z11, because the shallower pyramid levels flatten the
 * sea. So a zoomed-in coastal sheet has an ocean about ten metres deep, and only
 * a zoomed-out one has the five kilometres that wrecked the elevation range.
 * The sea still gets *drawn* at every zoom, which is the visible half of the bug;
 * this fixture is chosen to carry the other half too.
 */
const COAST_TILE_BUDGET = 16;

it.skipIf(!enabled)('keeps every algorithm off the water on a real coast', async () => {
  const loadTile = createNodeTileLoader();

  const { field, missingTiles } = await buildHeightField({
    source: DEM_SOURCES.terrarium,
    bbox: COAST_BBOX,
    fieldWidth: 700,
    fieldHeight: 500,
    tileBudget: COAST_TILE_BUDGET,
    loadTile,
  });

  expect(missingTiles).toBe(0);

  const wet = computeRange(field);
  const dry = computeRange(field, { floor: 0 });
  console.log(
    `COAST all samples min=${wet.minHeight.toFixed(0)}m max=${wet.maxHeight.toFixed(0)}m | ` +
      `land only min=${dry.minHeight.toFixed(0)}m max=${dry.maxHeight.toFixed(0)}m`
  );

  // The fixture is only worth anything if deep sea and real land are both in it.
  expect(wet.minHeight).toBeLessThan(-1000);
  expect(dry.minHeight).toBeGreaterThan(0);
  expect(dry.maxHeight).toBeGreaterThan(300);

  const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 10 });
  const mapper = createPageMapper(page, field);

  /** Whether the ground under a page position is land. */
  const isLand = (xMm, yMm) => {
    const x = Math.round((xMm - mapper.offsetX) / mapper.scale);
    const y = Math.round((yMm - mapper.offsetY) / mapper.scale);
    return field.get(
      Math.min(field.width - 1, Math.max(0, x)),
      Math.min(field.height - 1, Math.max(0, y))
    ) > 0;
  };

  for (const id of Object.keys(ALGORITHMS)) {
    const layers = buildTerrainLayers({
      field,
      mapper,
      algorithmIds: [id],
      algorithmOptions: {
        oceanLevel: 0,
        rowCount: 60,
        heightScale: 20,
        smoothSteps: 2,
        count: 12,
      },
    });

    let onWater = 0;
    let total = 0;
    for (const layer of layers) {
      for (const line of layer.polylines) {
        for (let i = 0; i < line.length; i += 2) {
          total += 1;
          if (!isLand(line[i], line[i + 1])) onWater += 1;
        }
      }
    }

    const fraction = total ? onWater / total : 0;
    console.log(
      `COAST ${id.padEnd(20)} points=${String(total).padStart(6)} ` +
        `on water=${(fraction * 100).toFixed(1)}%`
    );

    expect(total).toBeGreaterThan(0);
    // Not zero: the relief lifts a ridge line clear of the column it belongs to,
    // so its own ink legitimately stands over water further down the page.
    expect(fraction).toBeLessThan(0.08);
  }
}, 240000);
