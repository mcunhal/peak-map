import { describe, it, expect } from 'vitest';
import {
  renderRidgelineScene,
  projectTrack,
  projectFieldPolyline,
  dotsAlong,
  splitByVisibility,
} from './scene';
import { createHeightField, NODATA } from './heightField';
import { fieldToLngLat } from '../dem/tileMath';

const BBOX = { west: -10, south: 40, east: -8, north: 42 };

function field(width, height, elevationAt) {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) data[y * width + x] = elevationAt(x, y);
  }
  return createHeightField({ width, height, data, bbox: BBOX });
}

/** A track along a given field row, expressed geographically. */
function trackAlongRow(f, row, name = 'route', fromX = 2, toX = null) {
  const points = [];
  const end = toX === null ? f.width - 2 : toX;
  for (let x = fromX; x <= end; ++x) {
    const { lng, lat } = fieldToLngLat(BBOX, f.width, f.height, x + 0.5, row + 0.5);
    points.push({ lat, lon: lng, ele: null });
  }
  return { name, points };
}

const pointCount = (polylines) => polylines.reduce((n, l) => n + l.length / 2, 0);

describe('projectTrack', () => {
  it('lifts the track by the terrain under it, not by its own elevation', () => {
    const f = field(40, 40, (x, y) => (y < 20 ? 0 : 1000));
    // GPS elevation is deliberately absurd; it must be ignored.
    const track = trackAlongRow(f, 30);
    track.points = track.points.map((p) => ({ ...p, ele: 99999 }));

    const projected = projectTrack(track, f, {
      minHeight: 0,
      displacementPerMetre: 0.02,
    });
    // Terrain there is 1000m, so displacement is 20 samples above row 30.
    for (const p of projected) expect(p.y).toBeCloseTo(p.row - 20, 5);
  });

  it('places a track on the very sample it stands on', () => {
    // The height field is filled by sampling the ground at each sample's
    // *centre*. A track placed by the plain inverse lands on the sample's
    // corner instead, which puts every route half a sample right and down of
    // the terrain it belongs to — 0.65mm on an A3 at detail 300.
    const f = field(40, 40, () => 0);
    const { lng, lat } = fieldToLngLat(BBOX, f.width, f.height, 12 + 0.5, 7 + 0.5);

    const [p] = projectTrack(
      { name: 't', points: [{ lat, lon: lng, ele: null }] },
      f,
      { minHeight: 0, displacementPerMetre: 0 }
    );

    expect(p.x).toBeCloseTo(12, 6);
    expect(p.row).toBeCloseTo(7, 6);
  });

  it('drops points outside the field', () => {
    const f = field(20, 20, () => 100);
    const track = { name: 'x', points: [{ lat: 60, lon: 0, ele: null }] };
    expect(projectTrack(track, f, { minHeight: 0, displacementPerMetre: 0 })).toHaveLength(0);
  });

  it('drops points over nodata', () => {
    const f = field(20, 20, () => NODATA);
    expect(
      projectTrack(trackAlongRow(f, 10), f, { minHeight: 0, displacementPerMetre: 0 })
    ).toHaveLength(0);
  });
});

describe('dotsAlong', () => {
  const line = (n, step) =>
    Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0 }));

  it('spaces dots at the requested pitch', () => {
    const dots = dotsAlong(line(2, 100), 10, 2);
    expect(dots.length).toBe(11);
    expect(dots[1][0] - dots[0][0]).toBeCloseTo(10, 9);
  });

  it('gives each dot the requested length', () => {
    const dots = dotsAlong(line(2, 100), 10, 2);
    expect(dots[0][2] - dots[0][0]).toBeCloseTo(2, 9);
  });

  it('keeps the pitch across segment boundaries', () => {
    const dots = dotsAlong(line(11, 10), 7, 1);
    for (let i = 1; i < dots.length; ++i) {
      expect(dots[i][0] - dots[i - 1][0]).toBeCloseTo(7, 6);
    }
  });

  it('produces nothing without a pitch', () => {
    expect(dotsAlong(line(2, 100), 0, 2)).toEqual([]);
  });
});

describe('splitByVisibility', () => {
  const pts = (flags) => flags.map((v, i) => ({ x: i, y: 0, visible: v }));

  it('returns one polyline when everything is visible', () => {
    expect(splitByVisibility(pts([true, true, true]), 'hidden', 1, 0.5)).toHaveLength(1);
  });

  it('drops hidden runs in hidden mode', () => {
    const out = splitByVisibility(pts([true, true, false, false, true, true]), 'hidden', 1, 0.5);
    expect(out).toHaveLength(2);
  });

  it('replaces hidden runs with dots in dotted mode', () => {
    const hiddenOnly = splitByVisibility(pts([false, false, false, false]), 'hidden', 1, 0.4);
    const dotted = splitByVisibility(pts([false, false, false, false]), 'dotted', 1, 0.4);
    expect(hiddenOnly).toHaveLength(0);
    expect(dotted.length).toBeGreaterThan(0);
  });

  it('ignores visibility entirely in visible mode', () => {
    const out = splitByVisibility(pts([true, false, false, true]), 'visible', 1, 0.5);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(8);
  });
});

describe('renderRidgelineScene', () => {
  const opts = (over = {}) => ({
    rowCount: 20,
    heightScale: 30,
    smoothSteps: 0,
    occlude: true,
    trackMode: 'visible',
    ...over,
  });

  it('returns terrain and one entry per track, named', () => {
    const f = field(60, 60, (x, y) => 500 + 300 * Math.sin(y / 8));
    const scene = renderRidgelineScene(f, {
      ...opts(),
      tracks: [trackAlongRow(f, 30, 'A'), trackAlongRow(f, 40, 'B')],
    });
    expect(scene.terrain.length).toBeGreaterThan(0);
    expect(scene.tracks.map((t) => t.name)).toEqual(['A', 'B']);
    expect(scene.tracks[0].polylines.length).toBeGreaterThan(0);
  });

  it('does not hide a foreground route behind mountains further away', () => {
    // This is the depth-ordering bug the design called out. The far half of the
    // field is a tall range; the near half is low flat ground with a route on it.
    // Tested against the finished occlusion buffer, the far peaks would have raised
    // the horizon across every column and wrongly erased the whole route.
    const f = field(80, 80, (x, y) => (y < 40 ? 2000 : 10));
    const track = trackAlongRow(f, 70);

    const scene = renderRidgelineScene(f, {
      ...opts({ trackMode: 'hidden', heightScale: 60 }),
      tracks: [track],
    });

    const drawn = pointCount(scene.tracks[0].polylines);
    expect(drawn).toBeGreaterThan(70);
    expect(scene.tracks[0].polylines).toHaveLength(1);
  });

  it('does hide a route that runs behind nearer terrain', () => {
    // A route on the far low ground, with a tall near range in front of it.
    const f = field(80, 80, (x, y) => (y > 40 ? 2000 : 10));
    const track = trackAlongRow(f, 10);

    const visible = renderRidgelineScene(f, {
      ...opts({ trackMode: 'visible', heightScale: 60 }),
      tracks: [track],
    });
    const hidden = renderRidgelineScene(f, {
      ...opts({ trackMode: 'hidden', heightScale: 60 }),
      tracks: [track],
    });

    expect(pointCount(hidden.tracks[0].polylines)).toBeLessThan(
      pointCount(visible.tracks[0].polylines)
    );
  });

  it('handles a route that weaves back and forth in depth', () => {
    // A cursor walking the route in order would mis-band a zigzag like this.
    const f = field(60, 60, (x, y) => 400 + 200 * Math.sin(x / 6));
    const points = [];
    for (let i = 0; i < 60; ++i) {
      const x = 5 + i * 0.8;
      const row = 30 + 20 * Math.sin(i / 3);
      const { lng, lat } = fieldToLngLat(BBOX, f.width, f.height, x, row);
      points.push({ lat, lon: lng, ele: null });
    }

    const scene = renderRidgelineScene(f, {
      ...opts({ trackMode: 'visible' }),
      tracks: [{ name: 'zigzag', points }],
    });
    // In visible mode the whole route survives as one polyline, in route order.
    expect(scene.tracks[0].polylines).toHaveLength(1);
    expect(scene.tracks[0].polylines[0].length / 2).toBe(points.length);
  });

  it('draws fewer track points when hiding than when always visible', () => {
    const f = field(70, 70, (x, y) => 800 * Math.exp(-((y - 45) ** 2) / 200));
    const track = trackAlongRow(f, 20);
    const count = (trackMode) =>
      pointCount(
        renderRidgelineScene(f, { ...opts({ trackMode, heightScale: 50 }), tracks: [track] })
          .tracks[0].polylines
      );
    expect(count('hidden')).toBeLessThanOrEqual(count('visible'));
  });

  it('emits dotted runs as many short subpaths', () => {
    const f = field(70, 70, (x, y) => (y > 40 ? 2000 : 10));
    const track = trackAlongRow(f, 10);
    const scene = renderRidgelineScene(f, {
      ...opts({ trackMode: 'dotted', heightScale: 60, dotPitch: 2, dotLength: 0.5 }),
      tracks: [track],
    });
    const polylines = scene.tracks[0].polylines;
    expect(polylines.length).toBeGreaterThan(3);
    // Dots are two-point segments.
    expect(polylines.filter((l) => l.length === 4).length).toBeGreaterThan(0);
  });

  it('leaves the terrain unchanged by the presence of tracks', () => {
    const f = field(60, 60, (x, y) => 500 + 300 * Math.sin(y / 8));
    const without = renderRidgelineScene(f, opts());
    const with_ = renderRidgelineScene(f, { ...opts(), tracks: [trackAlongRow(f, 30)] });
    expect(with_.terrain).toEqual(without.terrain);
  });

  // Sea to the west, land rising eastward. The coast runs down the sheet rather
  // than across it, so no row hides another and every row carries both the
  // shoreline and the summit — which is what lets one drawing show both where
  // the coast landed and how much relief the land actually got.
  const coastalField = () =>
    field(40, 40, (x) => (x < 20 ? -5000 : 1 + (x - 20) * 50));

  const drawnYs = (scene) => {
    const ys = [];
    for (const line of scene.terrain) {
      for (let i = 1; i < line.length; i += 2) ys.push(line[i]);
    }
    return ys;
  };

  it('puts the coastline on the coast, not above it', () => {
    // Terrarium carries real bathymetry, so a coastal sheet's lowest sample is
    // the seabed — off Iberia, -5246m against a 3436m summit. The sea is never
    // drawn, but while it still set the baseline it lifted every line on the
    // sheet by one constant, sliding the whole drawing north of the map under it.
    const scene = renderRidgelineScene(coastalField(), {
      ...opts({ heightScale: 30, oceanLevel: 0, rowCount: 20, smoothSteps: 0 }),
    });

    // The shoreline is 1m above the water, so it belongs on its own row: the
    // nearest drawn row is 39, and the shore on it must sit at y = 39.
    expect(Math.max(...drawnYs(scene))).toBeGreaterThan(38.5);
  });

  it('spends the whole relief height on the ground that is drawn', () => {
    // 30 samples of relief has to mean 30 between the lowest land and the
    // highest, not 30 shared with five kilometres of water nobody asked to see.
    const scene = renderRidgelineScene(coastalField(), {
      ...opts({ heightScale: 30, oceanLevel: 0, rowCount: 20, smoothSteps: 0, occlude: false }),
    });

    const ys = drawnYs(scene);
    // Rows 1 to 39 are drawn, so the sheet spans 38 samples of ground before
    // any lift. The drawing's total height is that plus the relief, and the
    // relief is what the setting asked for: 38 + 30. While the seabed set the
    // scale, land got 950 of 5950 metres of it — under five samples.
    const span = Math.max(...ys) - Math.min(...ys);
    expect(span).toBeGreaterThan(38 + 28);
    expect(span).toBeLessThan(38 + 32);
  });

  it('rejects an unknown track mode', () => {
    const f = field(20, 20, () => 100);
    expect(() => renderRidgelineScene(f, { trackMode: 'sparkles' })).toThrow(/track mode/i);
  });

  it('refuses to place tracks on a field with no bounding box', () => {
    const data = new Float32Array(400).fill(100);
    const noBbox = createHeightField({ width: 20, height: 20, data });
    expect(() =>
      renderRidgelineScene(noBbox, { tracks: [{ name: 'x', points: [] }] })
    ).toThrow(/bounding box/i);
  });
});


describe('projectFieldPolyline', () => {
  it('lifts the line by the terrain under it', () => {
    const f = field(40, 40, (x, y) => (y < 20 ? 0 : 1000));
    const line = [];
    for (let x = 2; x < 38; ++x) line.push(x, 30);

    const projected = projectFieldPolyline(line, f, {
      minHeight: 0,
      displacementPerMetre: 0.02,
    });

    expect(projected).toHaveLength(36);
    // Terrain there is 1000m, so displacement is 20 samples above row 30.
    for (const p of projected) expect(p.y).toBeCloseTo(p.row - 20, 9);
  });

  it('keeps the drawn row as the depth, so the line is occluded where it lies', () => {
    const f = field(40, 40, () => 1000);
    const projected = projectFieldPolyline([5, 12, 6, 12], f, {
      minHeight: 0,
      displacementPerMetre: 0.02,
    });
    for (const p of projected) expect(p.row).toBe(12);
  });

  it('applies the same per-row perspective scale the terrain uses', () => {
    const f = field(40, 40, () => 1000);
    const rowScale = new Float64Array(40).fill(1);
    rowScale[10] = 0.5;

    const flat = projectFieldPolyline([5, 10, 6, 10], f, {
      minHeight: 0,
      displacementPerMetre: 0.02,
    });
    const scaled = projectFieldPolyline([5, 10, 6, 10], f, {
      minHeight: 0,
      displacementPerMetre: 0.02,
      rowScale,
    });

    expect(flat[0].y).toBeCloseTo(10 - 20, 9);
    expect(scaled[0].y).toBeCloseTo(10 - 10, 9);
  });

  it('drops points over nodata', () => {
    const f = field(20, 20, () => NODATA);
    expect(
      projectFieldPolyline([5, 5, 6, 5], f, { minHeight: 0, displacementPerMetre: 0 })
    ).toHaveLength(0);
  });
});

describe('renderRidgelineScene draping', () => {
  const opts = (over = {}) => ({
    rowCount: 20,
    heightScale: 30,
    smoothSteps: 0,
    occlude: true,
    trackMode: 'visible',
    ...over,
  });

  /** A flat-space polyline running along one field row. */
  const alongRow = (row, fromX, toX) => {
    const line = [];
    for (let x = fromX; x <= toX; ++x) line.push(x, row);
    return line;
  };

  it('returns one entry per drape, keyed by its id', () => {
    const f = field(40, 40, () => 500);
    const scene = renderRidgelineScene(f, {
      ...opts(),
      drapes: [
        { id: 'contours', polylines: [alongRow(20, 2, 37)] },
        { id: 'hachures', polylines: [alongRow(25, 2, 37)] },
      ],
    });

    expect(scene.drapes.map((d) => d.id)).toEqual(['contours', 'hachures']);
  });

  it('lifts a drape onto the surface the terrain rows are drawn on', () => {
    // Flat ground everywhere but a plateau: the drape must ride the plateau.
    const f = field(40, 40, (x, y) => (x < 20 ? 0 : 1000));
    const scene = renderRidgelineScene(f, {
      ...opts({ heightScale: 20, occlude: false }),
      drapes: [{ id: 'contours', polylines: [alongRow(30, 2, 37)] }],
    });

    const drawn = scene.drapes[0].polylines[0];
    // heightScale 20 over a 1000m range displaces 0.02 samples per metre.
    for (let i = 0; i < drawn.length; i += 2) {
      const expected = drawn[i] < 20 ? 30 : 30 - 20;
      expect(drawn[i + 1]).toBeCloseTo(expected, 6);
    }
  });

  it('cuts the part of a drape that a nearer ridge hides', () => {
    // The near half stands 1000m tall and is drawn first; the far half is flat
    // ground, and every screen row it would occupy is already taken.
    const f = field(40, 40, (x, y) => (y >= 20 ? 1000 : 0));
    const scene = renderRidgelineScene(f, {
      ...opts({ heightScale: 20 }),
      drapes: [{ id: 'contours', polylines: [alongRow(10, 2, 37)] }],
    });

    expect(pointCount(scene.drapes[0].polylines)).toBe(0);
  });

  it('draws the part of a drape that nothing hides', () => {
    const f = field(40, 40, (x, y) => (y >= 20 ? 1000 : 0));
    const scene = renderRidgelineScene(f, {
      ...opts({ heightScale: 20 }),
      drapes: [{ id: 'contours', polylines: [alongRow(35, 2, 37)] }],
    });

    expect(pointCount(scene.drapes[0].polylines)).toBeGreaterThan(0);
  });

  it('lets a drape be hidden by terrain without hiding terrain itself', () => {
    const f = field(60, 60, (x, y) => 500 + 300 * Math.sin(y / 8));
    const without = renderRidgelineScene(f, opts());
    const with_ = renderRidgelineScene(f, {
      ...opts(),
      drapes: [{ id: 'contours', polylines: [alongRow(30, 2, 57)] }],
    });

    expect(with_.terrain).toEqual(without.terrain);
  });

  it('occludes drapes without drawing the terrain when asked not to emit it', () => {
    const f = field(40, 40, (x, y) => (y >= 20 ? 1000 : 0));
    const scene = renderRidgelineScene(f, {
      ...opts({ heightScale: 20, emitTerrain: false }),
      drapes: [
        { id: 'far', polylines: [alongRow(10, 2, 37)] },
        { id: 'near', polylines: [alongRow(35, 2, 37)] },
      ],
    });

    expect(scene.terrain).toEqual([]);
    expect(pointCount(scene.drapes[0].polylines)).toBe(0);
    expect(pointCount(scene.drapes[1].polylines)).toBeGreaterThan(0);
  });

  it('needs no bounding box to drape, because drapes are already in field space', () => {
    const data = new Float32Array(1600).fill(100);
    const noBbox = createHeightField({ width: 40, height: 40, data });
    expect(() =>
      renderRidgelineScene(noBbox, {
        ...opts(),
        drapes: [{ id: 'contours', polylines: [alongRow(20, 2, 37)] }],
      })
    ).not.toThrow();
  });
});
