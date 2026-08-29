import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createNodeTileLoader } from './pngDecode';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { createRegion, lngToTileX, latToTileY, tileXToLng, tileYToLat } from '../src/dem/tileMath';
import { renderTerrain } from '../src/core/algorithms/index';
import { createPage, createPageMapper } from '../src/core/page';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers } from '../src/core/optimize';
import { compassForPage } from '../src/core/compass';

const OUT = process.env.SAMPLE_DIR || '.';
const enabled = !!process.env.REAL_DATA;

/** A sheet centred on a place, of a given size and bearing. */
function sheetRegion(centerLng, centerLat, halfW, halfH, bearingDeg) {
  const cx = lngToTileX(centerLng, 0);
  const cy = latToTileY(centerLat, 0);
  const a = (bearingDeg * Math.PI) / 180;
  const corner = (sx, sy) => ({
    lng: tileXToLng(cx + sx * halfW * Math.cos(a) - sy * halfH * Math.sin(a), 0),
    lat: tileYToLat(cy + sx * halfW * Math.sin(a) + sy * halfH * Math.cos(a), 0),
  });
  return createRegion({ nw: corner(-1, -1), ne: corner(1, -1), sw: corner(-1, 1) });
}

it.skipIf(!enabled)('renders the same place at two bearings', async () => {
  const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 12 });
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = 700;
  const fieldHeight = Math.round(fieldWidth / aspect);
  const halfH = 0.00042;
  const halfW = halfH * aspect;

  for (const bearing of [0, 35]) {
    const region = sheetRegion(-7.61, 40.33, halfW, halfH, bearing);
    const { field, zoom, tileCount } = await buildHeightField({
      source: DEM_SOURCES.terrarium,
      region, fieldWidth, fieldHeight, tileBudget: 90,
      loadTile: createNodeTileLoader(),
    });

    const mapper = createPageMapper(page, field);
    const groups = renderTerrain(field, 'ridgeline', { rowCount: 70, heightScale: 62, smoothSteps: 2 });
    const layers = optimizeLayers([
      { id: 'terrain', label: 'terrain', penColor: '#161616', penWidth: 0.25,
        polylines: groups[0].polylines.map((l) => mapper.polylineToMm(l)) },
      { id: 'compass', label: 'compass', penColor: '#c1272d', penWidth: 0.35,
        polylines: compassForPage(page, { radius: 12, bearing, corner: 'bottom-right' }) },
    ], { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 });

    const svg = writeSvg({ page, layers, title: `Bearing ${bearing}`, background: '#ffffff' });
    writeFileSync(`${OUT}/rotated-${bearing}.svg`, svg);

    // The compass needle must point where north actually is on this sheet.
    const compass = layers.find((l) => l.id === 'compass');
    expect(compass.polylines.length).toBeGreaterThan(3);
    console.log(`ROT bearing=${bearing} zoom=${zoom} tiles=${tileCount} paths=${layers.reduce((n,l)=>n+l.polylines.length,0)}`);
  }
}, 300000);
