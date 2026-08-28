import { describe, it, expect } from 'vitest';
import { renderRidgelineScene, projectTrack, dotsAlong, splitByVisibility } from './scene';
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
