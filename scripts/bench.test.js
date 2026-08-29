/**
 * Times every algorithm at the size the app actually asks for.
 * Guarded behind BENCH so `npm test` stays fast.
 *   BENCH=1 npx vitest run scripts/bench.test.js
 */
import { it } from 'vitest';
import { createHeightField } from '../src/core/heightField';
import { renderTerrain, ALGORITHMS } from '../src/core/algorithms/index';
import { optimizeLayers, measurePlot } from '../src/core/optimize';

const enabled = !!process.env.BENCH;

/** Terrain with the roughness of a real DEM, at the app's default detail. */
function terrain(W, H) {
  const data = new Float32Array(W * H);
  for (let y = 0; y < H; ++y) {
    for (let x = 0; x < W; ++x) {
      const massif = 1600 * Math.exp(-(((x - W * 0.55) / (W * 0.28)) ** 2 + ((y - H * 0.45) / (H * 0.3)) ** 2));
      const ranges = 260 * Math.sin(x / 37) * Math.cos(y / 41) + 170 * Math.sin(y / 19);
      const detail = 70 * Math.sin(x / 8 + y / 6) + 30 * Math.sin(x / 3.1 - y / 2.7);
      data[y * W + x] = Math.max(0, massif + ranges + detail + 400);
    }
  }
  return createHeightField({ width: W, height: H, data });
}

it.skipIf(!enabled)('times every algorithm at app detail', () => {
  const field = terrain(900, 616);
  console.log(`BENCH field=${field.width}x${field.height} (${field.width * field.height} samples)`);

  for (const id of Object.keys(ALGORITHMS)) {
    const t0 = Date.now();
    let groups;
    try {
      groups = renderTerrain(field, id);
    } catch (error) {
      console.log(`BENCH ${id.padEnd(20)} THREW ${error.message}`);
      continue;
    }
    const generate = Date.now() - t0;

    const paths = groups.reduce((n, g) => n + g.polylines.length, 0);
    const points = groups.reduce((n, g) => n + g.polylines.reduce((m, l) => m + l.length / 2, 0), 0);

    const t1 = Date.now();
    const layers = optimizeLayers(
      groups.map((g) => ({ id: g.name, penColor: '#000', penWidth: 0.3, polylines: g.polylines })),
      { dedupTolerance: 0.05, mergeTolerance: 0.15, simplifyTolerance: 0.08 }
    );
    const optimize = Date.now() - t1;
    const after = measurePlot(layers);

    console.log(
      `BENCH ${id.padEnd(20)} generate=${String(generate).padStart(6)}ms ` +
        `optimize=${String(optimize).padStart(6)}ms ` +
        `total=${String(generate + optimize).padStart(6)}ms ` +
        `paths=${String(paths).padStart(6)}->${String(after.paths).padStart(6)} ` +
        `points=${String(points).padStart(8)}`
    );
  }
}, 900000);
