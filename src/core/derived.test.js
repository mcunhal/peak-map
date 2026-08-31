import { describe, it, expect } from 'vitest';
import {
  computeGradient, computeSlope, computeAspect, computeHillshade,
  sampleGrid, sampleGradient, deriveAll,
} from './derived';
import { createHeightField, NODATA, isNoData } from './heightField';
import { planeField, rampField, coneField, gaussianHill } from './testFields';

const at = (grid, x, y) => grid.data[y * grid.width + x];

describe('computeGradient', () => {
  it('is zero on flat ground', () => {
    const g = computeGradient(planeField(10, 10, 500));
    expect(g.at(5, 5)).toEqual({ dx: 0, dy: 0 });
  });

  it('points uphill along x on an eastward ramp', () => {
    // 0 to 100 over 10 samples is 10m per sample.
    const g = computeGradient(rampField(11, 5, 0, 100));
    expect(g.at(5, 2).dx).toBeCloseTo(10, 6);
    expect(g.at(5, 2).dy).toBeCloseTo(0, 6);
  });

  it('uses a one-sided difference at the edges', () => {
    const g = computeGradient(rampField(11, 5, 0, 100));
    expect(g.at(0, 2).dx).toBeCloseTo(10, 6);
    expect(g.at(10, 2).dx).toBeCloseTo(10, 6);
  });

  it('scales with cell size', () => {
    const a = computeGradient(rampField(11, 5, 0, 100), { cellSize: 1 });
    const b = computeGradient(rampField(11, 5, 0, 100), { cellSize: 2 });
    expect(b.at(5, 2).dx).toBeCloseTo(a.at(5, 2).dx / 2, 6);
  });

  it('takes a different cell size along each axis', () => {
    // The sheet is a projective region: under pitch a row step covers several
    // times the ground a column step does, and a single cell size cannot say so.
    const g = computeGradient(rampField(11, 5, 0, 100), { cellSize: { x: 2, y: 10 } });
    expect(g.at(5, 2).dx).toBeCloseTo(5, 6);
    expect(g.at(5, 2).dy).toBeCloseTo(0, 6);
  });

  it('reads a per-row cell size at the row it belongs to', () => {
    // Ground per sample varies down a tilted sheet, so the run does too.
    const perRow = { x: [1, 1, 2, 4, 8], y: 1 };
    const g = computeGradient(rampField(11, 5, 0, 100), { cellSize: perRow });
    expect(g.at(5, 0).dx).toBeCloseTo(10, 6);
    expect(g.at(5, 2).dx).toBeCloseTo(5, 6);
    expect(g.at(5, 4).dx).toBeCloseTo(1.25, 6);
  });

  it('treats a missing cell size as one field unit', () => {
    const plain = computeGradient(rampField(11, 5, 0, 100));
    for (const absent of [null, undefined]) {
      const g = computeGradient(rampField(11, 5, 0, 100), { cellSize: absent });
      expect(g.at(5, 2).dx).toBeCloseTo(plain.at(5, 2).dx, 9);
    }
  });

  it('has no gradient where the neighbourhood touches nodata', () => {
    const data = new Float32Array(25).fill(100);
    data[12] = NODATA;
    const g = computeGradient(createHeightField({ width: 5, height: 5, data }));
    expect(g.at(1, 2)).toBeNull();
    expect(g.at(0, 0)).not.toBeNull();
  });
});

describe('computeHillshade at map scale', () => {
  // A sample on a zoomed-out sheet is hundreds of metres of ground. Measuring the
  // run in samples instead of metres inflates every gradient by that factor, and
  // the shading saturates: the normal goes horizontal, the surface stops being a
  // surface, and what is left is a clamped aspect mask with no slope in it.
  const METRES_PER_SAMPLE = 800;

  const spread = (shade) => {
    let black = 0, n = 0, min = Infinity, max = -Infinity;
    for (const s of shade.data) {
      if (isNoData(s)) continue;
      n++;
      if (s <= 0.02) black++;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    return { black: black / n, min, max };
  };

  it('collapses to black and white when the run is measured in samples', () => {
    const hill = gaussianHill(60, 60, 2000);
    const saturated = spread(computeHillshade(computeGradient(hill), { zFactor: 3 }));
    expect(saturated.black).toBeGreaterThan(0.2);
    expect(saturated.max).toBeLessThan(0.9);
  });

  it('keeps a usable range of tone when the run is real ground', () => {
    const hill = gaussianHill(60, 60, 2000);
    const real = spread(
      computeHillshade(computeGradient(hill, { cellSize: METRES_PER_SAMPLE }), { zFactor: 3 })
    );
    expect(real.black).toBeLessThan(0.02);
    expect(real.max).toBeGreaterThan(0.9);
  });
});

describe('computeSlope', () => {
  it('is zero on flat ground', () => {
    const slope = computeSlope(computeGradient(planeField(8, 8, 10)));
    expect(at(slope, 4, 4)).toBeCloseTo(0, 9);
  });

  it('rises with steepness', () => {
    const gentle = computeSlope(computeGradient(rampField(11, 5, 0, 10)));
    const steep = computeSlope(computeGradient(rampField(11, 5, 0, 1000)));
    expect(at(steep, 5, 2)).toBeGreaterThan(at(gentle, 5, 2));
  });

  it('approaches a right angle on a cliff but never exceeds it', () => {
    const cliff = computeSlope(computeGradient(rampField(11, 5, 0, 1e7)));
    expect(at(cliff, 5, 2)).toBeLessThan(Math.PI / 2);
    expect(at(cliff, 5, 2)).toBeGreaterThan(1.5);
  });
});

describe('computeAspect', () => {
  it('faces west where the ground rises to the east', () => {
    // Downhill is westward, so the aspect is 270 degrees.
    const aspect = computeAspect(computeGradient(rampField(11, 5, 0, 100)));
    expect((at(aspect, 5, 2) * 180) / Math.PI).toBeCloseTo(270, 3);
  });

  it('stays within a full turn', () => {
    const aspect = computeAspect(computeGradient(gaussianHill(20, 20, 300)));
    for (const v of aspect.data) {
      if (isNoData(v)) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(Math.PI * 2 + 1e-9);
    }
  });
});

describe('computeHillshade', () => {
  const hill = gaussianHill(41, 41, 400);

  it('stays within zero and one', () => {
    const shade = computeHillshade(computeGradient(hill));
    for (const v of shade.data) {
      if (isNoData(v)) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('lights the slope facing the sun more than the one facing away', () => {
    // Default azimuth 315 is from the north-west, so the north-west flank of the
    // hill is lit and the south-east flank is shadowed.
    const shade = computeHillshade(computeGradient(hill));
    expect(at(shade, 12, 12)).toBeGreaterThan(at(shade, 28, 28));
  });

  it('follows the light round when the azimuth changes', () => {
    const fromNW = computeHillshade(computeGradient(hill), { azimuth: 315 });
    const fromSE = computeHillshade(computeGradient(hill), { azimuth: 135 });
    expect(at(fromNW, 12, 12)).toBeGreaterThan(at(fromSE, 12, 12));
    expect(at(fromSE, 28, 28)).toBeGreaterThan(at(fromNW, 28, 28));
  });

  it('is uniform on flat ground', () => {
    const shade = computeHillshade(computeGradient(planeField(9, 9, 100)));
    expect(at(shade, 2, 2)).toBeCloseTo(at(shade, 6, 6), 9);
  });

  it('deepens the contrast with vertical exaggeration', () => {
    // A gentle hill, because a steep one saturates at 0 and 1 under both
    // settings and the difference disappears into the clamp.
    const gentle = gaussianHill(41, 41, 8);
    const spread = (z) => {
      const g = computeHillshade(computeGradient(gentle), { zFactor: z });
      const values = [...g.data].filter((v) => !isNoData(v));
      return Math.max(...values) - Math.min(...values);
    };
    expect(spread(8)).toBeGreaterThan(spread(1));
  });
});

describe('sampleGrid', () => {
  const grid = { width: 2, height: 2, data: Float32Array.from([0, 10, 20, 30]) };

  it('returns corner values exactly', () => {
    expect(sampleGrid(grid, 0, 0)).toBeCloseTo(0, 9);
    expect(sampleGrid(grid, 1, 1)).toBeCloseTo(30, 9);
  });

  it('interpolates between corners', () => {
    expect(sampleGrid(grid, 0.5, 0)).toBeCloseTo(5, 9);
    expect(sampleGrid(grid, 0.5, 0.5)).toBeCloseTo(15, 9);
  });

  it('reports nodata outside the grid', () => {
    expect(isNoData(sampleGrid(grid, -0.1, 0))).toBe(true);
    expect(isNoData(sampleGrid(grid, 1.1, 0))).toBe(true);
  });

  it('reports nodata when a corner is missing', () => {
    const holed = { width: 2, height: 2, data: Float32Array.from([0, 10, NODATA, 30]) };
    expect(isNoData(sampleGrid(holed, 0.5, 0.5))).toBe(true);
  });
});

describe('sampleGradient', () => {
  it('matches the grid gradient at a sample point', () => {
    const g = computeGradient(rampField(11, 5, 0, 100));
    expect(sampleGradient(g, 5, 2).dx).toBeCloseTo(10, 6);
  });

  it('returns null over a hole', () => {
    const data = new Float32Array(25).fill(100);
    data[12] = NODATA;
    const g = computeGradient(createHeightField({ width: 5, height: 5, data }));
    expect(sampleGradient(g, 1.5, 2)).toBeNull();
  });
});

describe('deriveAll', () => {
  it('computes every derived product once', () => {
    const all = deriveAll(coneField(21, 21, 100));
    expect(all.gradient.width).toBe(21);
    expect(all.slope.data.length).toBe(441);
    expect(all.aspect.data.length).toBe(441);
    expect(all.hillshade.data.length).toBe(441);
  });
});
