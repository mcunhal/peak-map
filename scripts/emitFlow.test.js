import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createNodeTileLoader } from './pngDecode';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { regionFromBbox } from '../src/dem/tileMath';
import { computeGradient, computeSlope } from '../src/core/derived';
import { evenlySpacedStreamlines } from '../src/core/algorithms/streamlines';
import { hachures } from '../src/core/algorithms/hachures';
import { createPage, createPageMapper } from '../src/core/page';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers, measurePlot } from '../src/core/optimize';

const OUT = process.env.SAMPLE_DIR || '.';
const BBOX = { west: -7.95, south: 40.15, east: -7.25, north: 40.55 };

it.skipIf(!process.env.REAL_DATA)('flow family with the new defaults', async () => {
  const page = createPage({ paper: 'A3', orientation: 'landscape', margin: 15 });
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = 900;
  const fieldHeight = Math.round(fieldWidth / aspect);

  const { field } = await buildHeightField({
    source: DEM_SOURCES.terrarium, region: regionFromBbox(BBOX),
    fieldWidth, fieldHeight, tileBudget: 64, loadTile: createNodeTileLoader(),
  });
  const mapper = createPageMapper(page, field);
  const perMm = 1 / mapper.scale;          // samples per millimetre
  const gradient = computeGradient(field);
  const slope = computeSlope(gradient);

  // Exactly what the worker now derives from the millimetre settings.
  const separation = 4 * perMm;
  const stepSize = Math.max(0.25, separation / 8);

  const jobs = {
    streamlines: () => evenlySpacedStreamlines(gradient, { separation, stepSize, mode: 'slope', minLength: 4 }),
    hachures: () => hachures(gradient, slope, {
      separation, stepSize,
      minStroke: 0.8 * perMm, maxStroke: 3.5 * perMm, gap: 1.2 * perMm,
    }),
  };

  for (const [name, run] of Object.entries(jobs)) {
    const t = Date.now();
    const lines = run();
    const ms = Date.now() - t;
    const layers = optimizeLayers([{
      id: name, label: name, penColor: '#161616', penWidth: 0.3,
      polylines: lines.map((l) => mapper.polylineToMm(l)),
    }], { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 });
    const m = measurePlot(layers);
    writeFileSync(`${OUT}/flow-${name}.svg`,
      writeSvg({ page, layers, title: name, background: '#ffffff' }));
    console.log(`FLOW ${name.padEnd(12)} sep=${separation.toFixed(2)}samples ${String(ms).padStart(5)}ms ` +
      `strokes=${String(lines.length).padStart(6)} paths=${String(m.paths).padStart(6)} plot=${(m.seconds/60).toFixed(1)}min`);
  }
}, 300000);
