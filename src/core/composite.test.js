import { describe, it, expect } from 'vitest';
import { buildTerrainLayers } from './composite';
import { createPage, createPageMapper } from './page';
import { createHeightField } from './heightField';
import { gaussianHill } from './testFields';
import { fieldToLngLat } from '../dem/tileMath';

const BBOX = { west: -10, south: 40, east: -8, north: 42 };

/** The same gaussian hill, but carrying a bounding box so tracks can be placed. */
function hillWithBbox(width, height, peak = 800) {
  const plain = gaussianHill(width, height, peak);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) data[y * width + x] = plain.get(x, y);
  }
  return createHeightField({ width, height, data, bbox: BBOX });
}

/**
 * Two hills under a low swell.
 *
 * A single smooth hill cannot show whether draping is cut by the ground or by
 * the strokes drawn on it: its contours run parallel to the rows and never graze
 * one. Terrain the contours wander across is what separates the two.
 */
function roughTerrain(w, h) {
  const data = new Float32Array(w * h);
  const bump = (x, y, cx, cy, s, p) =>
    p * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s)));
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      data[y * w + x] =
        bump(x, y, w * 0.6, h * 0.35, w * 0.14, 1300) +
        bump(x, y, w * 0.3, h * 0.62, w * 0.11, 900) +
        60 * Math.sin(x / 9) * Math.cos(y / 11);
    }
  }
  return createHeightField({ width: w, height: h, data });
}

function setup(field) {
  const page = createPage({ paper: 'A4', orientation: 'landscape', margin: 10 });
  return { page, mapper: createPageMapper(page, field) };
}

function trackAlongRow(f, row) {
  const points = [];
  for (let x = 2; x < f.width - 2; ++x) {
    const { lng, lat } = fieldToLngLat(BBOX, f.width, f.height, x + 0.5, row + 0.5);
    points.push({ lat, lon: lng, ele: null });
  }
  return { name: 'route', points };
}

const pointCount = (layer) =>
  layer.polylines.reduce((n, line) => n + line.length / 2, 0);

/**
 * Total drawn length, in millimetres.
 *
 * Counting points cannot measure occlusion: cutting a line in two shares the
 * boundary point between both halves, so a cut drawing can hold more points
 * than an uncut one while putting less ink on the paper.
 */
const drawnLength = (layer) =>
  layer.polylines.reduce((total, line) => {
    let run = 0;
    for (let i = 2; i < line.length; i += 2) {
      run += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
    }
    return total + run;
  }, 0);

const byId = (layers, id) => layers.find((l) => l.id === id);

describe('buildTerrainLayers', () => {
  const field = hillWithBbox(80, 60);
  const { mapper } = setup(field);

  const base = (over = {}) => ({
    field,
    mapper,
    algorithmIds: ['ridgeline'],
    algorithmOptions: { rowCount: 20, heightScale: 20, smoothSteps: 0, count: 10 },
    pens: { terrain: { color: '#161616', width: 0.3 } },
    ...over,
  });

  it('gives every selected algorithm a layer of its own', () => {
    const layers = buildTerrainLayers(base({ algorithmIds: ['ridgeline', 'contours'] }));

    expect(layers.map((l) => l.id)).toEqual(['ridgeline', 'contours']);
  });

  it('gives every layer the pen chosen for that algorithm', () => {
    const layers = buildTerrainLayers(
      base({
        algorithmIds: ['ridgeline', 'contours'],
        pens: {
          terrain: { color: '#161616', width: 0.3 },
          algorithmPens: {
            ridgeline: { color: '#ff0000', width: 0.5 },
            contours: { color: '#0000ff', width: 0.2 },
          },
        },
      })
    );

    expect(byId(layers, 'ridgeline').penColor).toBe('#ff0000');
    expect(byId(layers, 'contours').penColor).toBe('#0000ff');
    expect(byId(layers, 'contours').penWidth).toBe(0.2);
  });

  it('falls back to the shared terrain pen when an algorithm has none of its own', () => {
    const layers = buildTerrainLayers(
      base({ algorithmIds: ['contours'], pens: { terrain: { color: '#123456', width: 0.4 } } })
    );

    expect(byId(layers, 'contours').penColor).toBe('#123456');
  });

  it('draws the tracks once, however many algorithms are selected', () => {
    const layers = buildTerrainLayers(
      base({
        algorithmIds: ['ridgeline', 'contours', 'hachures'],
        tracks: [trackAlongRow(field, 30)],
        trackMode: 'visible',
      })
    );

    expect(layers.filter((l) => l.id.startsWith('route'))).toHaveLength(1);
  });

  it('keeps one layer per weight group for the per-level contours', () => {
    const layers = buildTerrainLayers(base({ algorithmIds: ['contours-by-level'] }));

    expect(layers.length).toBeGreaterThan(1);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  });

  describe('draping', () => {
    it('lifts planar linework onto the relief', () => {
      const flat = buildTerrainLayers(base({ algorithmIds: ['contours'], drape: false }));
      const draped = buildTerrainLayers(base({ algorithmIds: ['contours'], drape: true }));

      const topOf = (layer) =>
        Math.min(...layer.polylines.flatMap((l) => l.filter((_, i) => i % 2 === 1)));

      // The hill peaks in the middle of the sheet, so draping pushes the
      // summit contours up the page, above where the flat drawing put them.
      expect(topOf(byId(draped, 'contours'))).toBeLessThan(topOf(byId(flat, 'contours')));
    });

    it('draws no terrain of its own when the ridge lines are not selected', () => {
      const layers = buildTerrainLayers(base({ algorithmIds: ['contours'], drape: true }));

      expect(layers.map((l) => l.id)).toEqual(['contours']);
    });

    it('draws the ridge lines too when they are selected', () => {
      const layers = buildTerrainLayers(
        base({ algorithmIds: ['ridgeline', 'contours'], drape: true })
      );

      expect(layers.map((l) => l.id).sort()).toEqual(['contours', 'ridgeline']);
      expect(pointCount(byId(layers, 'ridgeline'))).toBeGreaterThan(0);
    });

    it('cuts the linework the relief hides', () => {
      const shown = buildTerrainLayers(base({ algorithmIds: ['contours'], drape: true }));
      const all = buildTerrainLayers(
        base({
          algorithmIds: ['contours'],
          drape: true,
          algorithmOptions: {
            rowCount: 20,
            heightScale: 20,
            smoothSteps: 0,
            count: 10,
            occlude: false,
          },
        })
      );

      expect(drawnLength(byId(shown, 'contours'))).toBeLessThan(
        drawnLength(byId(all, 'contours'))
      );
    });

    it('cuts a drape against the ground, not against the drawn rows', () => {
      // A contour lies on the ground between the strokes, so the strokes cannot
      // be what hides it: each nearer one that crests above the contour clips
      // it, and what should be a line comes out as dashes whose number follows
      // the line count rather than the terrain. Draw the same contours over two
      // line counts; how much of them survives has to agree.
      const rough = roughTerrain(120, 90);
      const { mapper: roughMapper } = setup(rough);

      const runsAt = (rowCount) =>
        byId(
          buildTerrainLayers({
            field: rough,
            mapper: roughMapper,
            algorithmIds: ['contours'],
            algorithmOptions: { rowCount, heightScale: 25, smoothSteps: 1, count: 14, occlude: true },
            pens: { terrain: { color: '#161616', width: 0.3 } },
            drape: true,
          }),
          'contours'
        ).polylines.length;

      const coarse = runsAt(8);
      const fine = runsAt(50);
      expect(coarse).toBeGreaterThan(0);
      expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.1);
    });

    it('leaves a non-planar algorithm to draw itself, not as a drape', () => {
      const layers = buildTerrainLayers(base({ algorithmIds: ['ridgeline'], drape: true }));

      expect(layers.map((l) => l.id)).toEqual(['ridgeline']);
      expect(pointCount(byId(layers, 'ridgeline'))).toBeGreaterThan(0);
    });

    it('occludes the tracks against the same relief', () => {
      const layers = buildTerrainLayers(
        base({
          algorithmIds: ['contours'],
          drape: true,
          tracks: [trackAlongRow(field, 5)],
          trackMode: 'hidden',
        })
      );

      expect(layers.some((l) => l.id.startsWith('route'))).toBe(true);
    });
  });
});
