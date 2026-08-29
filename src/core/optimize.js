/**
 * Plot-path optimization.
 *
 * Everything here works on polylines already in millimetres, so every tolerance is
 * a physical distance rather than a pixel count.
 *
 * The pipeline follows the order vpype documents, with deduplication inserted
 * first, since coincident geometry is cheapest to remove before anything tries to
 * chain or reorder it:
 *
 *     deduplicate -> merge -> sort -> reloop -> simplify
 *
 * What each pass is for:
 *   deduplicate  drops segments drawn twice. The big win for contours and
 *                hatching, where coincident geometry is everywhere.
 *   merge        joins polylines whose ends meet, removing a pen lift.
 *   sort         reorders the draw so the pen travels less between strokes.
 *   reloop       moves the seam of a closed loop so seams do not line up.
 *   simplify     drops points that say nothing, below plotter resolution.
 */

const DEFAULTS = {
  dedupTolerance: 0.05,
  mergeTolerance: 0.1,
  simplifyTolerance: 0.05,
  reloop: true,
  sort: true,
  allowReverse: true,
  origin: [0, 0],
};

/* ------------------------------------------------------------------ helpers */

function pointCount(line) {
  return line.length / 2;
}

export function polylineLength(line) {
  let total = 0;
  for (let i = 2; i < line.length; i += 2) {
    total += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  }
  return total;
}

function startOf(line) {
  return [line[0], line[1]];
}

function endOf(line) {
  return [line[line.length - 2], line[line.length - 1]];
}

function reversed(line) {
  const out = new Array(line.length);
  const n = pointCount(line);
  for (let i = 0; i < n; ++i) {
    out[2 * i] = line[2 * (n - 1 - i)];
    out[2 * i + 1] = line[2 * (n - 1 - i) + 1];
  }
  return out;
}

export function isClosed(line, tolerance) {
  if (pointCount(line) < 3) return false;
  const [sx, sy] = startOf(line);
  const [ex, ey] = endOf(line);
  return Math.hypot(ex - sx, ey - sy) <= tolerance;
}

/**
 * A uniform spatial hash over points. Nearest-neighbour sorting is otherwise
 * quadratic, which matters as soon as an algorithm emits thousands of strokes.
 *
 * Entries are owned by the polyline they came from and are retired together once
 * that polyline is consumed, so the search never walks over geometry that has
 * already been used. The ring search is bounded by the extent of the grid, and
 * stops immediately once nothing live is left: without both of those a fully
 * consumed index sends the search off across millions of empty cells.
 */
function createPointIndex(cellSize) {
  const cells = new Map();
  const byOwner = new Map();
  let live = 0;
  let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity;

  const key = (cx, cy) => cx + ',' + cy;

  return {
    get live() {
      return live;
    },

    add(x, y, owner, payload) {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;

      const entry = { x, y, owner, payload, dead: false };
      let bucket = cells.get(key(cx, cy));
      if (!bucket) cells.set(key(cx, cy), (bucket = []));
      bucket.push(entry);

      let owned = byOwner.get(owner);
      if (!owned) byOwner.set(owner, (owned = []));
      owned.push(entry);
      live += 1;
    },

    /** Retire every entry belonging to a polyline once it has been consumed. */
    retire(owner) {
      const owned = byOwner.get(owner);
      if (!owned) return;
      for (const entry of owned) {
        if (!entry.dead) {
          entry.dead = true;
          live -= 1;
        }
      }
    },

    /** Nearest live entry, or null when the index is exhausted. */
    nearest(x, y) {
      if (live === 0) return null;

      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      // Far enough to reach every occupied cell from here; beyond it there is
      // nothing left to find.
      const maxRing =
        Math.max(Math.abs(cx - minCx), Math.abs(cx - maxCx)) +
        Math.max(Math.abs(cy - minCy), Math.abs(cy - maxCy)) +
        1;

      let best = null;
      let bestDistance = Infinity;

      for (let ring = 0; ring <= maxRing; ++ring) {
        // Once a hit is nearer than the ring's guaranteed minimum distance,
        // nothing further out can beat it.
        if (best && (ring - 1) * cellSize > bestDistance) break;

        for (let dx = -ring; dx <= ring; ++dx) {
          for (let dy = -ring; dy <= ring; ++dy) {
            // Only the shell of the ring is new.
            if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
            const bucket = cells.get(key(cx + dx, cy + dy));
            if (!bucket) continue;
            for (const entry of bucket) {
              if (entry.dead) continue;
              const d = Math.hypot(entry.x - x, entry.y - y);
              if (d < bestDistance) {
                bestDistance = d;
                best = entry;
              }
            }
          }
        }
      }

      return best;
    },
  };
}

/* ------------------------------------------------------------------- passes */

/** Ramer-Douglas-Peucker. */
export function simplifyPolyline(line, tolerance) {
  const n = pointCount(line);
  if (n < 3 || !(tolerance > 0)) return line;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    if (last <= first + 1) continue;

    const x1 = line[2 * first];
    const y1 = line[2 * first + 1];
    const x2 = line[2 * last];
    const y2 = line[2 * last + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    let worst = -1;
    let worstDistance = tolerance;

    for (let i = first + 1; i < last; ++i) {
      const px = line[2 * i];
      const py = line[2 * i + 1];

      let distance;
      if (lengthSq === 0) {
        distance = Math.hypot(px - x1, py - y1);
      } else {
        let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        distance = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      }

      if (distance > worstDistance) {
        worstDistance = distance;
        worst = i;
      }
    }

    if (worst !== -1) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out = [];
  for (let i = 0; i < n; ++i) {
    if (keep[i]) out.push(line[2 * i], line[2 * i + 1]);
  }
  return out;
}

/**
 * Drop segments that are drawn more than once.
 *
 * Segments are quantised to the tolerance and keyed without regard to direction,
 * so a stroke retraced either way is recognised. Survivors come back as individual
 * segments; `mergePolylines` chains them into strokes again.
 */
export function deduplicateSegments(polylines, tolerance) {
  if (!(tolerance > 0)) return polylines.slice();

  const seen = new Set();
  const out = [];

  for (const line of polylines) {
    for (let i = 2; i < line.length; i += 2) {
      const ax = line[i - 2];
      const ay = line[i - 1];
      const bx = line[i];
      const by = line[i + 1];

      const qax = Math.round(ax / tolerance);
      const qay = Math.round(ay / tolerance);
      const qbx = Math.round(bx / tolerance);
      const qby = Math.round(by / tolerance);

      // A segment shorter than the tolerance carries no information.
      if (qax === qbx && qay === qby) continue;

      const forward = qax + ',' + qay + ',' + qbx + ',' + qby;
      const backward = qbx + ',' + qby + ',' + qax + ',' + qay;
      if (seen.has(forward) || seen.has(backward)) continue;

      seen.add(forward);
      out.push([ax, ay, bx, by]);
    }
  }

  return out;
}

/** Chain polylines whose ends meet within tolerance, reversing where it helps. */
export function mergePolylines(polylines, tolerance, { allowReverse = true } = {}) {
  if (!(tolerance > 0) || polylines.length === 0) return polylines.slice();

  const remaining = polylines.filter((l) => pointCount(l) >= 2);
  const used = new Uint8Array(remaining.length);
  const index = createPointIndex(Math.max(tolerance * 4, 1));

  remaining.forEach((line, i) => {
    const [sx, sy] = startOf(line);
    const [ex, ey] = endOf(line);
    index.add(sx, sy, i, { i, atStart: true });
    if (allowReverse) index.add(ex, ey, i, { i, atStart: false });
  });

  const out = [];

  for (let i = 0; i < remaining.length; ++i) {
    if (used[i]) continue;
    used[i] = 1;
    index.retire(i);
    let current = remaining[i].slice();

    // Extend forward for as long as something meets the end of the chain.
    for (;;) {
      const [ex, ey] = endOf(current);
      const hit = index.nearest(ex, ey);
      if (!hit) break;
      if (Math.hypot(hit.x - ex, hit.y - ey) > tolerance) break;

      const next = hit.payload.atStart
        ? remaining[hit.payload.i]
        : reversed(remaining[hit.payload.i]);
      used[hit.payload.i] = 1;
      index.retire(hit.payload.i);
      // Drop the duplicated joint point.
      current = current.concat(next.slice(2));
    }

    // And backwards. Without this a chain seeded from its middle strands
    // everything before that point as separate strokes, which is exactly what
    // contour segments do: they arrive in scan order, not in ring order.
    for (;;) {
      const [sx, sy] = startOf(current);
      const hit = index.nearest(sx, sy);
      if (!hit) break;
      if (Math.hypot(hit.x - sx, hit.y - sy) > tolerance) break;

      // The joined stroke must end where the chain starts.
      const previous = hit.payload.atStart
        ? reversed(remaining[hit.payload.i])
        : remaining[hit.payload.i];
      used[hit.payload.i] = 1;
      index.retire(hit.payload.i);
      current = previous.concat(current.slice(2));
    }

    out.push(current);
  }

  return out;
}

/**
 * Greedy nearest-neighbour ordering, reversing strokes when that puts their far
 * end closer. Not optimal, but it removes most of the pen-up travel a naive
 * emission order leaves behind.
 */
export function sortPolylines(polylines, { origin = [0, 0], allowReverse = true } = {}) {
  // Not an early return at length 1: a lone stroke may still start at its far end.
  if (polylines.length === 0) return [];

  const used = new Uint8Array(polylines.length);
  const index = createPointIndex(
    Math.max(1, estimateSpan(polylines) / Math.sqrt(polylines.length + 1))
  );

  polylines.forEach((line, i) => {
    const [sx, sy] = startOf(line);
    index.add(sx, sy, i, { i, atStart: true });
    if (allowReverse) {
      const [ex, ey] = endOf(line);
      index.add(ex, ey, i, { i, atStart: false });
    }
  });

  const out = [];
  let [px, py] = origin;

  for (let n = 0; n < polylines.length; ++n) {
    const hit = index.nearest(px, py);
    if (!hit) {
      // Index exhausted; append whatever is left in original order.
      for (let i = 0; i < polylines.length; ++i) if (!used[i]) { used[i] = 1; out.push(polylines[i]); }
      break;
    }

    used[hit.payload.i] = 1;
    index.retire(hit.payload.i);
    const line = hit.payload.atStart
      ? polylines[hit.payload.i]
      : reversed(polylines[hit.payload.i]);
    out.push(line);
    [px, py] = endOf(line);
  }

  return out;
}

function estimateSpan(polylines) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const line of polylines) {
    for (let i = 0; i < line.length; i += 2) {
      if (line[i] < minX) minX = line[i];
      if (line[i] > maxX) maxX = line[i];
      if (line[i + 1] < minY) minY = line[i + 1];
      if (line[i + 1] > maxY) maxY = line[i + 1];
    }
  }
  return Math.max(maxX - minX, maxY - minY) || 1;
}

/**
 * Rotate the start of each closed loop so seams do not all line up.
 *
 * The offset is derived from the loop itself rather than a random number, so the
 * same input always produces the same plot.
 */
export function reloopPolylines(polylines, tolerance) {
  return polylines.map((line) => {
    if (!isClosed(line, tolerance)) return line;

    const n = pointCount(line);
    // Drop the repeated closing point while rotating.
    const cycle = n - 1;
    if (cycle < 3) return line;

    // Hash the whole loop, not just its first point: a square starting at the
    // origin hashes to zero and would never move.
    let hash = cycle * 2654435761;
    for (let i = 0; i < line.length; ++i) {
      hash = (hash ^ Math.round(line[i] * 1000)) * 16777619;
      hash = hash >>> 0;
    }
    // Always move the seam; an offset of zero would leave it where it was.
    const offset = 1 + (hash % (cycle - 1));

    const out = [];
    for (let i = 0; i <= cycle; ++i) {
      const j = (offset + i) % cycle;
      out.push(line[2 * j], line[2 * j + 1]);
    }
    return out;
  });
}

/* ---------------------------------------------------------------- pipeline */

/** Run the full pipeline over one layer's polylines. */
export function optimizePolylines(polylines, options = {}) {
  const o = { ...DEFAULTS, ...options };
  let lines = polylines.filter((l) => pointCount(l) >= 2);

  if (o.dedupTolerance > 0) lines = deduplicateSegments(lines, o.dedupTolerance);
  if (o.mergeTolerance > 0) {
    lines = mergePolylines(lines, o.mergeTolerance, { allowReverse: o.allowReverse });
  }
  if (o.sort) lines = sortPolylines(lines, { origin: o.origin, allowReverse: o.allowReverse });
  if (o.reloop) lines = reloopPolylines(lines, o.mergeTolerance || 0.1);
  if (o.simplifyTolerance > 0) {
    lines = lines.map((l) => simplifyPolyline(l, o.simplifyTolerance));
  }

  return lines.filter((l) => pointCount(l) >= 2);
}

/** Optimize every layer, leaving pen assignments untouched. */
export function optimizeLayers(layers, options = {}) {
  return layers.map((layer) => ({
    ...layer,
    polylines: optimizePolylines(layer.polylines, options),
  }));
}

/* ----------------------------------------------------------------- metrics */

/**
 * What the plot will cost. Distances in millimetres, time in seconds.
 *
 * @param {Array} layers
 * @param {object} [machine]
 * @param {number} [machine.drawSpeed]   - mm/s with the pen down
 * @param {number} [machine.travelSpeed] - mm/s with the pen up
 * @param {number} [machine.penLiftTime] - seconds per lift-and-drop
 * @param {Array}  [machine.origin]
 */
export function measurePlot(layers, machine = {}) {
  const {
    drawSpeed = 60,
    travelSpeed = 150,
    penLiftTime = 0.2,
    origin = [0, 0],
  } = machine;

  let penDown = 0;
  let penUp = 0;
  let lifts = 0;
  let points = 0;
  let [px, py] = origin;

  for (const layer of layers) {
    for (const line of layer.polylines) {
      if (pointCount(line) < 2) continue;
      penUp += Math.hypot(line[0] - px, line[1] - py);
      lifts += 1;
      penDown += polylineLength(line);
      points += pointCount(line);
      [px, py] = endOf(line);
    }
  }

  const seconds = penDown / drawSpeed + penUp / travelSpeed + lifts * penLiftTime;

  return {
    penDownMm: penDown,
    penUpMm: penUp,
    penLifts: lifts,
    points,
    paths: layers.reduce((n, l) => n + l.polylines.length, 0),
    seconds,
  };
}

/** Human-readable comparison of two measurements. */
export function compareMetrics(before, after) {
  const change = (a, b) => (a === 0 ? 0 : ((b - a) / a) * 100);
  return {
    before,
    after,
    penDownChangePercent: change(before.penDownMm, after.penDownMm),
    penUpChangePercent: change(before.penUpMm, after.penUpMm),
    penLiftChangePercent: change(before.penLifts, after.penLifts),
    pointChangePercent: change(before.points, after.points),
    secondsSaved: before.seconds - after.seconds,
  };
}

/**
 * The equivalent vpype pipeline, for going further than this app does.
 * Emitted alongside the SVG rather than run by it.
 */
export function vpypeRecipe(options = {}, { input = 'map.svg', output = 'plot.svg' } = {}) {
  const o = { ...DEFAULTS, ...options };
  const mm = (v) => `${Number(v.toFixed(3))}mm`;

  const parts = [`vpype read "${input}"`];
  if (o.dedupTolerance > 0) parts.push(`deduplicate --tolerance ${mm(o.dedupTolerance)}`);
  if (o.mergeTolerance > 0) {
    parts.push(
      `linemerge --tolerance ${mm(o.mergeTolerance)}${o.allowReverse ? '' : ' --no-flip'}`
    );
  }
  if (o.sort) parts.push(`linesort${o.allowReverse ? '' : ' --no-flip'}`);
  if (o.reloop) parts.push('reloop');
  if (o.simplifyTolerance > 0) {
    parts.push(`linesimplify --tolerance ${mm(o.simplifyTolerance)}`);
  }
  parts.push(`write "${output}"`);

  return parts.join(' \\\n  ');
}
