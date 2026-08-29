import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createNodeTileLoader } from './pngDecode';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { regionFromBbox } from '../src/dem/tileMath';
import { renderTerrain } from '../src/core/algorithms/index';
import { createPage, createPageMapper } from '../src/core/page';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers, measurePlot } from '../src/core/optimize';

const OUT = process.env.SAMPLE_DIR || '.';
const BBOX = { west: -7.95, south: 40.15, east: -7.25, north: 40.55 };

it.skipIf(!process.env.REAL_DATA)('tanaka weight by passes vs pen width', async () => {
  const page = createPage({ paper: 'A3', orientation: 'landscape', margin: 15 });
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = 900, fieldHeight = Math.round(fieldWidth / aspect);
  const { field } = await buildHeightField({
    source: DEM_SOURCES.terrarium, region: regionFromBbox(BBOX),
    fieldWidth, fieldHeight, tileBudget: 64, loadTile: createNodeTileLoader(),
  });
  const mapper = createPageMapper(page, field);
  const groups = renderTerrain(field, 'tanaka', { count: 26, classes: 3 });

  for (const mode of ['passes', 'pen']) {
    const layers = optimizeLayers(groups.map((g) => ({
      id: g.name, label: g.name, penColor: '#161616',
      penWidth: mode === 'passes' ? 0.3 : Number((0.15 + g.weight * 0.35).toFixed(2)),
      passes: mode === 'passes' ? Math.max(1, Math.round(g.weight * 3)) : 1,
      polylines: g.polylines.map((l) => mapper.polylineToMm(l)),
    })), { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 });

    const m = measurePlot(layers);
    writeFileSync(`${OUT}/weight-${mode}.svg`, writeSvg({ page, layers, title: mode, background: '#ffffff' }));
    console.log(`WEIGHT ${mode.padEnd(7)} penDown=${(m.penDownMm/1000).toFixed(1)}m lifts=${m.penLifts} ` +
      `plot=${(m.seconds/60).toFixed(1)}min widths=${[...new Set(layers.map(l=>l.penWidth))].join('/')} ` +
      `passes=${[...new Set(layers.map(l=>l.passes))].join('/')}`);
  }
}, 300000);
