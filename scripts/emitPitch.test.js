import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createNodeTileLoader } from './pngDecode';
import { buildHeightField } from '../src/dem/buildHeightField';
import { DEM_SOURCES } from '../src/dem/sources';
import { createRegion } from '../src/dem/tileMath';
import { renderTerrain } from '../src/core/algorithms/index';
import { createPage, createPageMapper } from '../src/core/page';
import { writeSvg } from '../src/core/svgWriter';
import { optimizeLayers } from '../src/core/optimize';
import { compassForPage } from '../src/core/compass';
import { lngToTileX, latToTileY, tileXToLng, tileYToLat } from '../src/dem/tileMath';

const OUT = process.env.SAMPLE_DIR || '.';
const enabled = !!process.env.REAL_DATA;

// Corners taken from the running app, A4 landscape with 12mm margins.
const CORNERS = {
  0: { nw:{lng:-8.2839,lat:40.684275}, ne:{lng:-6.9161,lat:40.684275},
       sw:{lng:-8.2839,lat:39.973856}, se:{lng:-6.9161,lat:39.973856} },
  50:{ nw:{lng:-8.734635,lat:41.240577}, ne:{lng:-6.465365,lat:41.240577},
       sw:{lng:-8.089461,lat:39.933345}, se:{lng:-7.110539,lat:39.933345} },
};

/** Lay the rose on the ground, the way the worker does. */
function makeProjector(region, mapper, fieldWidth, fieldHeight, page) {
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
  return (cxMm, cyMm, radiusMm) => {
    const [gx, gy] = pageToGround(cxMm, cyMm);
    const probe = 1e-6;
    const [px, py] = groundToPage(gx + probe, gy);
    const mmPerGround = Math.hypot(px - cxMm, py - cyMm) / probe;
    if (!Number.isFinite(mmPerGround) || mmPerGround <= 0) return null;
    let r = radiusMm / mmPerGround;
    const { drawable } = page;
    const fits = (rr) => [[-1.05,-1.5],[1.05,-1.5],[-1.05,1.05],[1.05,1.05]].every(([lx,ly]) => {
      const [x, y] = groundToPage(gx + lx*rr, gy + ly*rr);
      return Number.isFinite(x) && Number.isFinite(y) &&
        x >= drawable.x && x <= drawable.x + drawable.width &&
        y >= drawable.y && y <= drawable.y + drawable.height;
    });
    for (let i = 0; i < 8 && !fits(r); ++i) r *= 0.8;
    return (lx, ly) => groundToPage(gx + lx * r, gy + ly * r);
  };
}

it.skipIf(!enabled)('renders flat and tilted', async () => {
  const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 12 });
  const aspect = page.drawable.width / page.drawable.height;
  const fieldWidth = 820;
  const fieldHeight = Math.round(fieldWidth / aspect);

  for (const pitch of [0, 50]) {
    const region = createRegion(CORNERS[pitch]);
    const { field, zoom, tileCount } = await buildHeightField({
      source: DEM_SOURCES.terrarium, region, fieldWidth, fieldHeight,
      tileBudget: 140, loadTile: createNodeTileLoader(),
    });

    const mapper = createPageMapper(page, field);
    const groups = renderTerrain(field, 'ridgeline', {
      rowCount: 95, heightScale: 55, smoothSteps: 2, oceanLevel: 0,
    });
    const layers = optimizeLayers([
      { id: 'terrain', label: 'terrain', penColor: '#161616', penWidth: 0.25,
        polylines: groups[0].polylines.map((l) => mapper.polylineToMm(l)) },
      { id: 'compass', label: 'compass', penColor: '#c1272d', penWidth: 0.35,
        polylines: compassForPage(page, { radius: 11, project: makeProjector(region, mapper, fieldWidth, fieldHeight, page) }) },
    ], { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 });

    writeSvg({ page, layers });
    writeFileSync(`${OUT}/pitch-${pitch}.svg`,
      writeSvg({ page, layers, title: `Pitch ${pitch}`, background: '#ffffff' }));
    console.log(`PITCH ${pitch} perspective=${region.perspective} zoom=${zoom} tiles=${tileCount} paths=${layers.reduce((n,l)=>n+l.polylines.length,0)}`);
  }
}, 300000);
