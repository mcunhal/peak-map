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
import { computeRange, isNoData, sheetRows } from './heightField';
import { dashAlong, sparsePattern } from './dash';
import { createOcclusionBuffer } from './occlusion';
import { createRowIterator, smoothPolyline } from './algorithms/ridgeline';
import { regionFromBbox, regionRowScales } from '../dem/tileMath';

export const TRACK_MODES = ['hidden', 'visible', 'dotted'];

/**
 * Place a geographic track in field coordinates and lift it onto the drawn terrain
 * surface, using the same displacement the ridge lines use so that it sits on them
 * rather than floating over them.
 */
export function projectTrack(track, field, { minHeight, displacementPerMetre, rowScale }) {
  // Placing a track has to use the same mapping the terrain was sampled with,
  // rotation included, or a turned sheet puts the route somewhere else entirely.
  const region = field.region || regionFromBbox(field.bbox);

  const flat = [];
  for (const point of track.points) {
    // Sample centres, because that is where the height field's samples are.
    // The plain inverse returns the sample's corner, which put every route half
    // a sample right and down of the terrain it crosses.
    const { x, y } = region.sampleFromLngLat(
      field.width,
      field.height,
      point.lon,
      point.lat
    );
    flat.push(x, y);
  }

  return projectFieldPolyline(flat, field, { minHeight, displacementPerMetre, rowScale });
}

/**
 * Lift a polyline that is already in field coordinates onto the drawn surface.
 *
 * This is what a track becomes once it has been placed, and it is also what a
 * planar algorithm produces to begin with. Contours, hachures and streamlines
 * are all computed flat, so draping one over the relief is only this step: the
 * line keeps the row it was computed on as its depth, and is displaced upwards
 * by the terrain beneath it, exactly as `drawTerrainRow` displaces the ground.
 *
 * @param {number[]} points - a flat [x0, y0, x1, y1, ...] polyline in samples
 */
export function projectFieldPolyline(
  points,
  field,
  { minHeight, displacementPerMetre, rowScale }
) {
  const projected = [];

  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < 0 || y < 0 || x > field.width || y > field.height) continue;

    // Ride the rendered surface rather than any elevation carried by the line.
    // For a GPX track the two disagree by metres, and a route that fails to
    // touch the ridge it crosses reads as a mistake.
    const roundedY = Math.min(field.height - 1, Math.max(0, Math.round(y)));
    const elevation = field.get(
      Math.min(field.width - 1, Math.max(0, Math.round(x))),
      roundedY
    );
    if (isNoData(elevation)) continue;

    const lift = displacementPerMetre * (rowScale ? rowScale[roundedY] : 1);

    projected.push({
      x,
      row: y,
      y: y - (elevation - minHeight) * lift,
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
 *
 * `pattern` is the track's line style, in samples, or null for a solid line.
 * A solid track keeps the original path exactly — including `dotsAlong` for its
 * hidden run — which is what makes a sheet drawn with the defaults unchanged.
 */
export function splitByVisibility(points, mode, dotPitch, dotLength, pattern = null) {
  const out = [];
  if (points.length < 2) return out;

  const styled = (run) =>
    pattern ? dashAlong(run, pattern) : [run.flatMap((p) => [p.x, p.y])];

  if (mode === 'visible') {
    out.push(...styled(points));
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
      out.push(...styled(run));
    } else if (mode === 'dotted') {
      // A solid line has no gaps to widen, so it falls back to plain dots.
      out.push(
        ...(pattern
          ? dashAlong(run, sparsePattern(pattern))
          : dotsAlong(run, dotPitch, dotLength))
      );
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
    // Planar linework to hang on the same surface, already in field samples.
    drapes = [],
    // False draws the rows into the occlusion buffer without emitting them, so
    // drapes can be hidden by relief that is not itself on the sheet.
    emitTerrain = true,
  } = options;

  if (!TRACK_MODES.includes(trackMode)) {
    throw new Error(
      `Unknown track mode "${trackMode}"; expected one of ${TRACK_MODES.join(', ')}`
    );
  }

  // Measured against the ground that will actually be drawn. Terrarium carries
  // real bathymetry, so a coastal sheet's lowest sample is the seabed: off
  // Iberia it is -5246m against a 3436m summit, which put 60% of the relief
  // underwater and lifted the entire drawing 34mm north of the map beneath it.
  const range = computeRange(field, { floor: oceanLevel });
  if (range.isEmpty) {
    return {
      terrain: [],
      tracks: tracks.map((t) => ({ name: t.name, fileName: t.fileName, polylines: [] })),
      drapes: drapes.map((d) => ({ id: d.id, polylines: [] })),
    };
  }

  if (tracks.length && !field.region && !field.bbox) {
    throw new Error('Placing GPX tracks needs a height field with a bounding box');
  }

  const { width, height } = field;
  const { minHeight, heightRange } = range;
  const displacementPerMetre = heightRange > 0 ? heightScale / heightRange : 0;

  const { rows, spacing } = createRowIterator(rowCount, height);
  // Normalised at the middle of the *sheet*, not of the field: over-plotting
  // below the bottom edge makes the field taller, and normalising at its middle
  // would rescale the whole relief as a side effect of extending it.
  const rowScale = regionRowScales(field.region, width, height, {
    normaliseRow: sheetRows(field) / 2,
  });
  const buffer = occlude ? createOcclusionBuffer(width, height) : null;

  // Drapes are cut against the ground itself rather than against the strokes
  // drawn on it, and that needs a horizon of its own.
  //
  // The terrain buffer only knows the rows that were drawn. That is right for
  // the ridge lines, which hide each other, but a contour lies on the ground
  // *between* them: every nearer stroke that crests above it clips it, and the
  // contour comes out as dashes whose number follows the line count rather than
  // the terrain. Raising the line count made it worse, not better — 105 pieces
  // at 10 rows, 837 at 120, and back to 80 once every row was drawn. So the
  // drape horizon is built from every field row, which also means changing the
  // line count no longer changes which contours are visible.
  const surface = buffer && drapes.length ? createOcclusionBuffer(width, height) : null;

  const rowCountDrawn = rows.length;

  const projected = tracks.map((track) =>
    projectTrack(track, field, { minHeight, displacementPerMetre, rowScale })
  );

  // A drape is a whole family of lines rather than one route, but each of its
  // polylines is tested exactly as a track is: same surface, same buffer, same
  // depth order. Only the way it arrives differs.
  const projectedDrapes = drapes.map((drape) =>
    (drape.polylines || []).map((line) =>
      projectFieldPolyline(line, field, { minHeight, displacementPerMetre, rowScale })
    )
  );

  // File every projected point under the iteration that must precede its test: the
  // one by which every nearer row has been drawn, and no further row has.
  const buckets = Array.from({ length: rowCountDrawn + 1 }, () => []);
  const file = (points) => {
    for (const point of points) {
      // Rows run nearest-first from the bottom edge, so a point belongs to the
      // bucket tested once every nearer row has been drawn.
      const index = Math.ceil((height - 1 - point.row) / spacing);
      buckets[Math.min(rowCountDrawn, Math.max(0, index))].push(point);
    }
  };
  projected.forEach(file);

  const terrain = [];

  occludeDrapes();

  for (let i = 0; i < rowCountDrawn; ++i) {
    testSurfacePoints(buckets[i]);
    drawTerrainRow(rows[i]);
  }
  testSurfacePoints(buckets[rowCountDrawn]);

  return {
    terrain,
    // `fileName` rides along untouched: `layers.js` groups by pen and needs it to
    // say which files fed a layer. The scene itself has no use for it.
    tracks: tracks.map((track, i) => ({
      name: track.name,
      fileName: track.fileName,
      polylines: splitByVisibility(
        projected[i], trackMode, dotPitch, dotLength, track.pattern || null
      ),
    })),
    // Draped linework has no dotted mode: a contour is either on the visible
    // face of the terrain or it is behind it, and drawing the hidden part as
    // dots would be inventing a feature the ground does not have.
    drapes: drapes.map((drape, i) => ({
      id: drape.id,
      polylines: projectedDrapes[i].flatMap((points) =>
        splitByVisibility(points, 'hidden', dotPitch, dotLength)
      ),
    })),
  };

  /**
   * Walk the ground from the near edge back, deciding each drape point the
   * moment every row nearer than it has been laid down and none further has.
   *
   * The same depth order the terrain rows are drawn in, at every row rather than
   * only the drawn ones. A drape marks nothing: it is paint on the surface.
   */
  function occludeDrapes() {
    if (!surface) return;

    const byRow = Array.from({ length: height }, () => []);
    for (const lines of projectedDrapes) {
      for (const points of lines) {
        for (const point of points) {
          const row = Math.min(height - 1, Math.max(0, Math.ceil(point.row)));
          byRow[row].push(point);
        }
      }
    }

    for (let y = height - 1; y >= 0; --y) {
      for (const point of byRow[y]) {
        const column = Math.round(point.x);
        point.visible =
          column >= 0 && column < surface.width && surface.isVisible(column, point.y);
      }

      const lift = displacementPerMetre * (rowScale ? rowScale[y] : 1);
      for (let x = 0; x < width; ++x) {
        const elevation = field.get(x, y);
        if (isNoData(elevation) || elevation <= oceanLevel) continue;
        surface.mark(x, y - (elevation - minHeight) * lift);
      }
    }
  }

  /**
   * Neither a track nor a drape marks the occlusion buffer. Both are lines
   * painted on the surface, and neither hides the terrain behind it.
   */
  function testSurfacePoints(points) {
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
        if (run.length >= 4) emitTerrainRun(run);
        run = [];
        continue;
      }
      run.push(x, y - (elevation - minHeight) * lift);
    }
    if (run.length >= 4) emitTerrainRun(run);
  }

  function emitTerrainRun(points) {
    const smoothed = smoothPolyline(points, smoothSteps);
    if (!buffer) {
      if (emitTerrain) terrain.push(smoothed);
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
        if (current.length >= 4 && emitTerrain) terrain.push(current);
        current = null;
      }
    }
    if (current && current.length >= 4 && emitTerrain) terrain.push(current);
  }
}
