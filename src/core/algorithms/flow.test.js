import { describe, it, expect } from 'vitest';
import { evenlySpacedStreamlines } from './streamlines';
import { hachures, hillshadeHatching } from './hachures';
import { computeGradient, computeSlope, computeHillshade } from '../derived';
import { planeField, coneField, gaussianHill, rampField, saddleField } from '../testFields';
import { createHeightField, NODATA } from '../heightField';
import { polylineLength } from '../optimize';

const totalLength = (lines) => lines.reduce((n, l) => n + polylineLength(l), 0);
const allPoints = (lines) => lines.flatMap((l) => {
  const out = [];
  for (let i = 0; i < l.length; i += 2) out.push([l[i], l[i + 1]]);
  return out;
});

/** Smallest distance between points on two different strokes. */
function minSeparation(lines) {
  let best = Infinity;
  for (let a = 0; a < lines.length; ++a) {
    for (let b = a + 1; b < lines.length; ++b) {
      for (let i = 0; i < lines[a].length; i += 2) {
        for (let j = 0; j < lines[b].length; j += 2) {
          const d = Math.hypot(lines[a][i] - lines[b][j], lines[a][i + 1] - lines[b][j + 1]);
          if (d < best) best = d;
        }
      }
    }
  }
  return best;
}

describe('evenlySpacedStreamlines', () => {
  const hill = gaussianHill(80, 80, 900);
  const gradient = computeGradient(hill);

  it('draws nothing on flat ground, which has no direction to follow', () => {
    expect(evenlySpacedStreamlines(computeGradient(planeField(40, 40, 300)))).toEqual([]);
  });

  it('covers real terrain with many strokes', () => {
    const lines = evenlySpacedStreamlines(gradient, { separation: 4 });
    expect(lines.length).toBeGreaterThan(10);
    expect(totalLength(lines)).toBeGreaterThan(100);
  });

  it('respects the separation distance', () => {
    // No point of one stroke may sit closer than the stop distance to another.
    const separation = 6;
    const lines = evenlySpacedStreamlines(gradient, { separation, testFactor: 0.5, maxLines: 60 });
    expect(lines.length).toBeGreaterThan(3);
    expect(minSeparation(lines)).toBeGreaterThan(separation * 0.5 * 0.9);
  });

  it('draws more strokes as the separation tightens', () => {
    const wide = evenlySpacedStreamlines(gradient, { separation: 10 });
    const tight = evenlySpacedStreamlines(gradient, { separation: 3 });
    expect(tight.length).toBeGreaterThan(wide.length);
  });

  it('runs downhill in slope mode', () => {
    // On a ramp rising eastwards, every stroke must head west.
    const ramp = computeGradient(rampField(60, 60, 0, 600));
    const lines = evenlySpacedStreamlines(ramp, { separation: 6, mode: 'slope' });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line[line.length - 2]).toBeLessThan(line[0]);
    }
  });

  it('runs along the hillside in contour mode', () => {
    // On the same ramp, contour-mode strokes are vertical: x barely changes.
    const ramp = computeGradient(rampField(60, 60, 0, 600));
    const lines = evenlySpacedStreamlines(ramp, { separation: 6, mode: 'contour' });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(Math.abs(line[line.length - 2] - line[0])).toBeLessThan(1);
    }
  });

  it('stays inside the field', () => {
    for (const [x, y] of allPoints(evenlySpacedStreamlines(gradient, { separation: 5 }))) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(hill.width - 1);
      expect(y).toBeLessThanOrEqual(hill.height - 1);
    }
  });

  it('emits only finite coordinates', () => {
    for (const [x, y] of allPoints(evenlySpacedStreamlines(gradient, { separation: 5 }))) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('avoids ground with no gradient data', () => {
    const width = 60, height = 60;
    const solid = gaussianHill(width, height, 900);
    const data = Float32Array.from(solid.data);
    for (let y = 20; y < 40; ++y) for (let x = 20; x < 40; ++x) data[y * width + x] = NODATA;
    const holed = createHeightField({ width, height, data });

    const lines = evenlySpacedStreamlines(computeGradient(holed), { separation: 4 });
    for (const [x, y] of allPoints(lines)) {
      const insideHole = x > 21 && x < 38 && y > 21 && y < 38;
      expect(insideHole).toBe(false);
    }
  });

  it('honours the hard cap on stroke count', () => {
    expect(
      evenlySpacedStreamlines(gradient, { separation: 1, maxLines: 25 }).length
    ).toBeLessThanOrEqual(25);
  });

  it('discards strokes shorter than the minimum', () => {
    const lines = evenlySpacedStreamlines(gradient, { separation: 4, minLength: 8 });
    for (const line of lines) expect(polylineLength(line)).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic', () => {
    const a = evenlySpacedStreamlines(gradient, { separation: 5 });
    const b = evenlySpacedStreamlines(gradient, { separation: 5 });
    expect(a).toEqual(b);
  });

  it('rejects a nonsensical separation', () => {
    expect(() => evenlySpacedStreamlines(gradient, { separation: 0 })).toThrow(/separation/i);
  });

  it('handles a saddle, where the field has two opposing directions', () => {
    const lines = evenlySpacedStreamlines(computeGradient(saddleField(60, 60, 400)), {
      separation: 5,
    });
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('hachures', () => {
  const hill = gaussianHill(80, 80, 900);
  const gradient = computeGradient(hill);
  const slope = computeSlope(gradient);

  it('draws a field of short strokes', () => {
    const lines = hachures(gradient, slope, { separation: 4 });
    expect(lines.length).toBeGreaterThan(20);
  });

  it('leaves level ground blank, as a hachure map does', () => {
    const flat = planeField(50, 50, 200);
    const g = computeGradient(flat);
    expect(hachures(g, computeSlope(g), { separation: 3 })).toEqual([]);
  });

  it('draws longer strokes on steeper ground', () => {
    const meanLength = (peak) => {
      const field = gaussianHill(80, 80, peak);
      const g = computeGradient(field);
      const lines = hachures(g, computeSlope(g), { separation: 4 });
      return totalLength(lines) / lines.length;
    };
    expect(meanLength(2000)).toBeGreaterThan(meanLength(300));
  });

  it('keeps strokes within the configured length range', () => {
    const lines = hachures(gradient, slope, { separation: 4, minStroke: 2, maxStroke: 6 });
    for (const line of lines) {
      // A stroke may overshoot by up to one integration step.
      expect(polylineLength(line)).toBeLessThanOrEqual(6 + 1);
    }
  });

  it('emits only finite coordinates inside the field', () => {
    for (const [x, y] of allPoints(hachures(gradient, slope, { separation: 4 }))) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(79);
    }
  });

  it('is deterministic', () => {
    expect(hachures(gradient, slope, { separation: 5 })).toEqual(
      hachures(gradient, slope, { separation: 5 })
    );
  });
});

describe('hillshadeHatching', () => {
  const hill = gaussianHill(80, 80, 1200);
  const shade = computeHillshade(computeGradient(hill), { zFactor: 3 });

  it('draws rules over shaded ground', () => {
    const lines = hillshadeHatching(shade, { spacing: 2, levels: 4 });
    expect(lines.length).toBeGreaterThan(10);
  });

  it('draws nothing where there is no shading to render', () => {
    const flat = computeHillshade(computeGradient(planeField(50, 50, 100)));
    // Even ground is uniformly lit, so at a high blank threshold nothing is drawn.
    expect(hillshadeHatching(flat, { spacing: 2, minTone: 0.1 })).toEqual([]);
  });

  it('puts more ink on darker ground', () => {
    // Compare ink in the shadowed quadrant against the lit one.
    const lines = hillshadeHatching(shade, { spacing: 2, levels: 4 });
    const inkIn = (x0, y0) => {
      let n = 0;
      for (const [x, y] of allPoints(lines)) {
        if (x >= x0 && x < x0 + 30 && y >= y0 && y < y0 + 30) n += 1;
      }
      return n;
    };
    // Light comes from the north-west by default, so the south-east is darker.
    expect(inkIn(45, 45)).toBeGreaterThan(inkIn(8, 8));
  });

  it('follows the requested angle', () => {
    const horizontal = hillshadeHatching(shade, { angle: 0, spacing: 3 });
    expect(horizontal.length).toBeGreaterThan(0);
    for (const line of horizontal) {
      // A horizontal rule keeps a constant y.
      expect(Math.abs(line[1] - line[line.length - 1])).toBeLessThan(0.001);
    }
  });

  it('lays down more ink at a tighter spacing', () => {
    const coarse = hillshadeHatching(shade, { spacing: 5, levels: 4 });
    const fine = hillshadeHatching(shade, { spacing: 1.5, levels: 4 });
    expect(totalLength(fine)).toBeGreaterThan(totalLength(coarse));
  });

  it('stays inside the field', () => {
    for (const [x, y] of allPoints(hillshadeHatching(shade, { spacing: 3 }))) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(79);
      expect(y).toBeLessThanOrEqual(79);
    }
  });

  it('rejects nonsensical settings', () => {
    expect(() => hillshadeHatching(shade, { spacing: 0 })).toThrow(/spacing/i);
    expect(() => hillshadeHatching(shade, { levels: 0 })).toThrow(/level/i);
  });

  it('is deterministic', () => {
    expect(hillshadeHatching(shade, { spacing: 3 })).toEqual(
      hillshadeHatching(shade, { spacing: 3 })
    );
  });
});

describe('hachures scale to their terrain', () => {
  it('reads the slope range out of the field', async () => {
    const { slopePercentiles } = await import('./hachures');
    const gentle = computeSlope(computeGradient(gaussianHill(60, 60, 60)));
    const steep = computeSlope(computeGradient(gaussianHill(60, 60, 3000)));
    const a = slopePercentiles(gentle);
    const b = slopePercentiles(steep);
    expect(a.maxSlope).toBeLessThan(b.maxSlope);
    expect(a.minSlope).toBeLessThan(a.maxSlope);
  });

  it('has nothing to report on flat ground', async () => {
    const { slopePercentiles } = await import('./hachures');
    const flat = computeSlope(computeGradient(planeField(40, 40, 100)));
    expect(slopePercentiles(flat)).toBeNull();
  });

  it('varies stroke length on gentle terrain, where a fixed range would not', async () => {
    // A hill far below the old fixed maximum of 0.8 radians. Every stroke used to
    // come out at the minimum, giving a flat, textureless drawing.
    const field = gaussianHill(90, 90, 120);
    const gradient = computeGradient(field);
    const lines = hachures(gradient, computeSlope(gradient), { separation: 4 });
    expect(lines.length).toBeGreaterThan(20);

    const lengths = lines.map((l) => polylineLength(l));
    const shortest = Math.min(...lengths);
    const longest = Math.max(...lengths);
    expect(longest / shortest).toBeGreaterThan(1.5);
  });

  it('still honours an explicit range', async () => {
    const field = gaussianHill(60, 60, 900);
    const gradient = computeGradient(field);
    const wide = hachures(gradient, computeSlope(gradient), { separation: 4, minSlope: 0.01, maxSlope: 2 });
    expect(wide.length).toBeGreaterThan(0);
  });
});
