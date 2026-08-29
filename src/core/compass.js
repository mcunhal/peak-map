/**
 * A compass rose, as strokes.
 *
 * Everything a plotter draws has to be geometry. A north arrow set as a text
 * glyph would be a font reference the machine cannot follow, so the rose,
 * including its N, is built from lines and arcs in millimetres like everything
 * else, and goes through the same optimizer.
 *
 * It is drawn on the page rather than in the field, because it belongs to the
 * sheet: it should be the same size whatever the map's scale.
 */

/** Points of a circle, as a closed polyline. */
function circle(cx, cy, radius, segments = 64) {
  const points = [];
  for (let i = 0; i <= segments; ++i) {
    const a = (i / segments) * Math.PI * 2;
    points.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
  }
  return points;
}

/**
 * The letter N, drawn as three strokes so a pen can follow it.
 * Height `h`, centred on (cx, cy), and rotated with the rest of the rose.
 */
function letterN(cx, cy, h, rotation) {
  const w = h * 0.62;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const at = (x, y) => [cx + (x * cos - y * sin), cy + (x * sin + y * cos)];

  const [lx0, ly0] = at(-w / 2, h / 2);
  const [lx1, ly1] = at(-w / 2, -h / 2);
  const [dx0, dy0] = at(-w / 2, -h / 2);
  const [dx1, dy1] = at(w / 2, h / 2);
  const [rx0, ry0] = at(w / 2, h / 2);
  const [rx1, ry1] = at(w / 2, -h / 2);

  return [
    [lx0, ly0, lx1, ly1],
    [dx0, dy0, dx1, dy1],
    [rx0, ry0, rx1, ry1],
  ];
}

/**
 * Build a compass rose.
 *
 * @param {object} options
 * @param {number} options.cx - centre, in millimetres on the page
 * @param {number} options.cy
 * @param {number} [options.radius] - millimetres
 * @param {number} [options.bearing] - the map's bearing in degrees. North on the
 *   rose points where north is on the sheet, which is opposite the rotation the
 *   map was turned by.
 * @param {boolean} [options.ring] - draw the outer circle
 * @param {boolean} [options.ticks] - draw the minor points
 * @returns {Array} polylines in millimetres
 */
export function compassRose({
  cx,
  cy,
  radius = 12,
  bearing = 0,
  ring = true,
  ticks = true,
} = {}) {
  if (!(radius > 0)) throw new Error('Compass radius must be positive');

  const out = [];

  // Turning the map clockwise by `bearing` turns north on the paper the other
  // way, so the rose is rotated by the negative of it. Screen y grows downwards,
  // which is already the sign convention the page uses.
  const rotation = (-bearing * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  // North is up the page before rotation.
  const at = (x, y) => [cx + (x * cos - y * sin), cy + (x * sin + y * cos)];

  if (ring) out.push(circle(cx, cy, radius));

  // The needle: a narrow kite pointing north, drawn as one closed stroke so the
  // pen makes a single pass.
  const tip = at(0, -radius * 0.78);
  const tail = at(0, radius * 0.5);
  const left = at(-radius * 0.22, 0);
  const right = at(radius * 0.22, 0);
  out.push([
    tip[0], tip[1],
    right[0], right[1],
    tail[0], tail[1],
    left[0], left[1],
    tip[0], tip[1],
  ]);

  // A line down the middle, which is what distinguishes the lit half of a rose
  // from the shaded one without needing any fill.
  out.push([tip[0], tip[1], tail[0], tail[1]]);

  if (ticks) {
    // East, south and west, as short marks inside the ring.
    for (const angle of [90, 180, 270]) {
      const a = ((angle - bearing) * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      out.push([
        cx + dx * radius * 0.82,
        cy + dy * radius * 0.82,
        cx + dx * radius * 0.98,
        cy + dy * radius * 0.98,
      ]);
    }
  }

  // The N, held clear of the ring.
  const label = at(0, -radius * 1.28);
  out.push(...letterN(label[0], label[1], radius * 0.42, rotation));

  return out;
}

/**
 * Place a rose in a page corner, inside the margins.
 *
 * @param {object} page - from createPage
 * @param {object} [options] - passed on to compassRose, minus the position
 * @param {number} [options.radius]
 * @param {number} [options.bearing]
 * @param {number} [options.inset] - millimetres in from the drawable corner
 * @param {'bottom-right'|'bottom-left'|'top-right'|'top-left'} [options.corner]
 */
export function compassForPage(page, options = {}) {
  const { radius = 12, inset = 4, corner = 'bottom-right', ...rest } = options;
  const { drawable } = page;

  // Room for the ring and the label above it.
  const padX = radius + inset;
  const padY = radius + inset;

  const right = drawable.x + drawable.width - padX;
  const left = drawable.x + padX;
  const bottom = drawable.y + drawable.height - padY;
  const top = drawable.y + padY + radius * 0.5;

  const positions = {
    'bottom-right': [right, bottom],
    'bottom-left': [left, bottom],
    'top-right': [right, top],
    'top-left': [left, top],
  };
  const position = positions[corner];
  if (!position) throw new Error(`Unknown compass corner "${corner}"`);

  return compassRose({ cx: position[0], cy: position[1], radius, ...rest });
}
