import { it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { readGeoTiff, buildHeightFieldFromRasters, resolutionAdvice } from '../src/dem/ptLidarRaster';
import { tileBounds, tm06ToLngLat } from '../src/dem/ptLidarGrid';
import { createRegion } from '../src/dem/tileMath';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { createNodeTileLoader } from './pngDecode';
import { computeRange } from '../src/core/heightField';
import { ridgeline } from '../src/core/algorithms/ridgeline';
import { createPage, createPageMapper } from '../src/core/page';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers, measurePlot } from '../src/core/optimize';

const OUT = process.env.SAMPLE_DIR || '.';
const TIF = process.env.LIDAR_TIF;

it.skipIf(!TIF)('one square kilometre, LiDAR against the tiled source', async () => {
  const b = tileBounds('238372');
  const region = createRegion({
    nw: tm06ToLngLat(b.minX, b.maxY),
    ne: tm06ToLngLat(b.maxX, b.maxY),
    sw: tm06ToLngLat(b.minX, b.minY),
  });

  const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 12 });
  const aspect = page.drawable.width / page.drawable.height;
  const W = 900, H = Math.round(W / aspect);

  const buf = readFileSync(TIF);
  const raster = await readGeoTiff(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { fromArrayBuffer });

  const lidar = buildHeightFieldFromRasters({ region, rasters: [raster], fieldWidth: W, fieldHeight: H });
  const tiled = await buildHeightField({
    source: DEM_SOURCES.terrarium, region, fieldWidth: W, fieldHeight: H,
    tileBudget: 64, loadTile: createNodeTileLoader(),
  });

  const advice = resolutionAdvice(1000, page.drawable.width, 0.5);
  console.log(`LIDAR sheet is 1km across: ${advice.metresPerMm.toFixed(2)} m per mm of paper`);
  console.log(`LIDAR 50cm data -> ${advice.samplesPerMm.toFixed(1)} samples/mm; 30m tiles -> ${(advice.metresPerMm/30).toFixed(3)}`);

  for (const [name, field] of [['lidar-50cm', lidar.field], ['terrarium-30m', tiled.field]]) {
    const r = computeRange(field);
    const mapper = createPageMapper(page, field);
    const lines = ridgeline(field, { rowCount: 90, heightScale: 26 / mapper.scale, smoothSteps: 0, occlude: true });
    const layers = optimizeLayers([{
      id: 'terrain', label: 'terrain', penColor: '#161616', penWidth: 0.25,
      polylines: lines.map((l) => mapper.polylineToMm(l)),
    }], { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 });
    const m = measurePlot(layers);
    writeFileSync(`${OUT}/km-${name}.svg`, writeSvg({ page, layers, title: name, background: '#ffffff' }));
    console.log(`LIDAR ${name.padEnd(14)} elev ${r.minHeight.toFixed(0)}-${r.maxHeight.toFixed(0)}m  paths=${m.paths}  points=${m.points}`);
  }
}, 300000);
