/**
 * Renders terrain and GPX tracks together, at the right depth.
 *
 * Occlusion is depth-ordered, so tracks cannot simply be drawn after the terrain.
 * A point is hidden only by geometry nearer than it, and rows are drawn from the
 * bottom of the field (nearest) upwards. Testing a track against the finished
 * occlusion buffer would hide a foreground route behind ridges that are actually
 * further away than it is.
 *
 * A route also weaves back and forth in depth, so it cannot be walked in route
 * order against a buffer that only moves one way. Visibility is therefore decided
 * in depth order, and the geometry is emitted afterwards in route order:
 *
 *   1. every track point is filed under the terrain row that bracket its depth;
 *   2. rows are drawn nearest-first, and each point is tested the moment every
 *      nearer row has been drawn and no further row has;
 *   3. each track is then walked in route order and split into runs of visible
 *      and hidden points.
 */
import { computeRange, isNoData } from './heightField';
import { createOcclusionBuffer } from './occlusion';
import { createRowIterator, smoothPolyline } from './algorithms/ridgeline';
import { regionFromBbox, regionRowScales } from '../dem/tileMath';

export const TRACK_MODES = ['hidden', 'visible', 'dotted'];

/**
 * Place a geographic track in field coordinates and lift it onto the drawn terrain
 * surface, using the same displacement the ridge lines use so that it sits on them
 * rather than floating over them.
 */
export function projectTrack(track, field, { minHeight, displacementPerMetre }) {
  const projected = [];

  // Placing a track has to use the same mapping the terrain was sampled with,
  // rotation included, or a turned sheet puts the route somewhere else entirely.
  const region = field.region || regionFromBbox(field.bbox);

  for (const point of track.points) {
    const { x, y } = region.fromLngLat(field.width, field.height, point.lon, point.lat);
    if (x < 0 || y < 0 || x > field.width || y > field.height) continue;

    // Ride the rendered surface rather than the elevation recorded by the GPS.
    // The two disagree by metres, and a route that fails to touch the ridge it
    // crosses reads as a mistake.
    const elevation = field.get(
      Math.min(field.width - 1, Math.max(0, Math.round(x))),
      Math.min(field.height - 1, Math.max(0, Math.round(y)))
    );
    if (isNoData(elevation)) continue;

    projected.push({
      x,
      row: y,
      y: y - (elevation - minHeight) * displacementPerMetre,
      visible: true,
    });
  }

  return projected;
}

/** Break a run of hidden geometry into evenly spaced dots along its own length. */
export function dotsAlong(points, pitch, dotLength) {
  const out = [];
  if (points.length < 2 || !(pitch > 0)) return out;

  let distanceToNextDot = 0;

  for (let i = 1; i < points.length; ++i) {
    const a = points[i - 1];
    const b = points[i];
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (segmentLength === 0) continue;

    let travelled = distanceToNextDot;
    while (travelled <= segmentLength) {
      const t0 = travelled / segmentLength;
      const t1 = Math.min(1, (travelled + dotLength) / segmentLength);
      out.push([
        a.x + (b.x - a.x) * t0,
        a.y + (b.y - a.y) * t0,
        a.x + (b.x - a.x) * t1,
        a.y + (b.y - a.y) * t1,
      ]);
      travelled += pitch;
    }
    distanceToNextDot = travelled - segmentLength;
  }

  return out;
}

/**
 * Walk a track in route order and cut it into drawable polylines according to the
 * visibility already decided for each point.
 */
export function splitByVisibility(points, mode, dotPitch, dotLength) {
  const out = [];
  if (points.length < 2) return out;

  if (mode === 'visible') {
    out.push(points.flatMap((p) => [p.x, p.y]));
    return out;
  }

  let run = [];
  let runVisible = points[0].visible;

  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    if (runVisible) {
      out.push(run.flatMap((p) => [p.x, p.y]));
    } else if (mode === 'dotted') {
      out.push(...dotsAlong(run, dotPitch, dotLength));
    }
    run = [];
  };

  for (const point of points) {
    if (point.visible !== runVisible) {
      // Share the boundary point with both runs so there is no gap between them.
      run.push(point);
      flush();
      runVisible = point.visible;
      run.push(point);
    }
    run.push(point);
  }
  flush();

  return out;
}

/**
 * @param {object} field - a HeightField, carrying a bbox when tracks are supplied
 * @param {object} options
 * @param {Array} [options.tracks] - parsed GPX tracks
 * @param {'hidden'|'visible'|'dotted'} [options.trackMode]
 * @param {number} [options.dotPitch]  - dot spacing, in field samples
 * @param {number} [options.dotLength] - dot length, in field samples
 * @returns {{terrain: Array, tracks: Array<{name: string, polylines: Array}>}}
 */
export function renderRidgelineScene(field, options = {}) {
  const {
    rowCount = 30,
    heightScale = 40,
    oceanLevel = -Infinity,
    smoothSteps = 1,
    occlude = true,
    tracks = [],
    trackMode = 'dotted',
    dotPitch = 2,
    dotLength = 0.6,
  } = options;

  if (!TRACK_MODES.includes(trackMode)) {
    throw new Error(
      `Unknown track mode "${trackMode}"; expected one of ${TRACK_MODES.join(', ')}`
    );
  }

  const range = computeRange(field);
  if (range.isEmpty) {
    return { terrain: [], tracks: tracks.map((t) => ({ name: t.name, polylines: [] })) };
  }

  if (tracks.length && !field.region && !field.bbox) {
    throw new Error('Placing GPX tracks needs a height field with a bounding box');
  }

  const { width, height } = field;
  const { minHeight, heightRange } = range;
  const displacementPerMetre = heightRange > 0 ? heightScale / heightRange : 0;

  const { rows, spacing } = createRowIterator(rowCount, height);
  const rowScale = regionRowScales(field.region, width, height);
  const buffer = occlude ? createOcclusionBuffer(width, height) : null;

  const rowCountDrawn = rows.length;

  const projected = tracks.map((track) =>
    projectTrack(track, field, { minHeight, displacementPerMetre })
  );

  // File every track point under the iteration that must precede its test: the one
  // by which every nearer row has been drawn, and no further row has.
  const buckets = Array.from({ length: rowCountDrawn + 1 }, () => []);
  projected.forEach((points) => {
    for (const point of points) {
      // Rows run nearest-first from the bottom edge, so a point belongs to the
      // bucket tested once every nearer row has been drawn.
      const index = Math.ceil((height - 1 - point.row) / spacing);
      buckets[Math.min(rowCountDrawn, Math.max(0, index))].push(point);
    }
  });

  const terrain = [];

  for (let i = 0; i < rowCountDrawn; ++i) {
    testTrackPoints(buckets[i]);
    drawTerrainRow(rows[i]);
  }
  testTrackPoints(buckets[rowCountDrawn]);

  return {
    terrain,
    tracks: tracks.map((track, i) => ({
      name: track.name,
      polylines: splitByVisibility(projected[i], trackMode, dotPitch, dotLength),
    })),
  };

  /**
   * A track never marks the occlusion buffer. It is a line painted on the surface,
   * and it does not hide the terrain behind it.
   */
  function testTrackPoints(points) {
    if (!buffer) return;
    for (const point of points) {
      const column = Math.round(point.x);
      point.visible =
        column >= 0 && column < buffer.width && buffer.isVisible(column, point.y);
    }
  }

  function drawTerrainRow(y) {
    // Heights obey the same perspective as the ground, so a distant hill does
    // not stand as tall as a near one.
    const lift = displacementPerMetre * (rowScale ? rowScale[y] : 1);
    let run = [];
    for (let x = 0; x < width; ++x) {
      const elevation = field.get(x, y);
      if (isNoData(elevation) || elevation <= oceanLevel) {
        if (run.length >= 4) emitTerrain(run);
        run = [];
        continue;
      }
      run.push(x, y - (elevation - minHeight) * lift);
    }
    if (run.length >= 4) emitTerrain(run);
  }

  function emitTerrain(points) {
    const smoothed = smoothPolyline(points, smoothSteps);
    if (!buffer) {
      terrain.push(smoothed);
      return;
    }

    let current = null;
    for (let i = 0; i < smoothed.length; i += 2) {
      const x = smoothed[i];
      const py = smoothed[i + 1];
      const column = Math.round(x);

      let visible = false;
      if (column >= 0 && column < buffer.width) {
        visible = buffer.isVisible(column, py);
        if (visible) buffer.mark(column, py);
      }

      if (visible) {
        if (!current) current = [];
        current.push(x, py);
      } else if (current) {
        if (current.length >= 4) terrain.push(current);
        current = null;
      }
    }
    if (current && current.length >= 4) terrain.push(current);
  }
}
