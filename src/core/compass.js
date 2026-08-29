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

/**
 * The rose in its own frame: centred on the origin, radius 1, north towards -y.
 *
 * Built once here and then mapped, rather than drawn straight onto the page, so
 * the same geometry can be laid flat or laid on the ground.
 */
export function roseGeometry({ ring = true, ticks = true, segments = 72 } = {}) {
  const out = [];

  if (ring) {
    const circle = [];
    for (let i = 0; i <= segments; ++i) {
      const a = (i / segments) * Math.PI * 2;
      circle.push(Math.cos(a), Math.sin(a));
    }
    out.push(circle);
  }

  // The needle: a narrow kite pointing north, as one closed stroke.
  out.push([0, -0.78, 0.22, 0, 0, 0.5, -0.22, 0, 0, -0.78]);
  // A line down the middle, which is what separates the lit half of a rose from
  // the shaded one without needing any fill.
  out.push([0, -0.78, 0, 0.5]);

  if (ticks) {
    for (const angle of [90, 180, 270]) {
      const a = (angle * Math.PI) / 180;
      const dx = Math.sin(a);
      const dy = -Math.cos(a);
      out.push([dx * 0.82, dy * 0.82, dx * 0.98, dy * 0.98]);
    }
  }

  // The letter N, as three strokes, held clear of the ring.
  const h = 0.42;
  const w = h * 0.62;
  const cy = -1.28;
  out.push([-w / 2, cy + h / 2, -w / 2, cy - h / 2]);
  out.push([-w / 2, cy - h / 2, w / 2, cy + h / 2]);
  out.push([w / 2, cy + h / 2, w / 2, cy - h / 2]);

  return out;
}

/** Map every point of the rose through a transform. */
function mapRose(geometry, transform) {
  return geometry.map((line) => {
    const out = new Array(line.length);
    for (let i = 0; i < line.length; i += 2) {
      const [x, y] = transform(line[i], line[i + 1]);
      out[i] = x;
      out[i + 1] = y;
    }
    return out;
  });
}

/**
 * Build a compass rose flat on the page.
 *
 * @param {object} options
 * @param {number} options.cx - centre, in millimetres on the page
 * @param {number} options.cy
 * @param {number} [options.radius] - millimetres
 * @param {number} [options.northAngle] - which way north lies on the sheet, in
 *   degrees clockwise from up the page.
 * @param {boolean} [options.ring] - draw the outer circle
 * @param {boolean} [options.ticks] - draw the minor points
 * @returns {Array} polylines in millimetres
 */
export function compassRose({
  cx,
  cy,
  radius = 12,
  northAngle = 0,
  ring = true,
  ticks = true,
} = {}) {
  if (!(radius > 0)) throw new Error('Compass radius must be positive');

  // Page y grows downwards, so a clockwise angle from up-the-page is already the
  // sign convention the page uses.
  const rotation = (northAngle * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return mapRose(roseGeometry({ ring, ticks }), (x, y) => [
    cx + radius * (x * cos - y * sin),
    cy + radius * (x * sin + y * cos),
  ]);
}

/**
 * Build a compass rose lying on the ground.
 *
 * A rose is a circle drawn on the map, not a badge stuck to the paper, so it is
 * only a circle when the map is seen from directly above. Tilt the view and it
 * becomes an ellipse, exactly as the terrain around it is foreshortened. Drawing
 * a projected needle inside an unprojected circle would be neither one thing nor
 * the other.
 *
 * This is also why no separate north angle is needed here: north falls out of
 * the projection, at the point where the rose actually sits.
 *
 * @param {Function} toPage - maps the rose's own frame (origin at its centre,
 *   radius 1, north towards -y) to millimetres on the page
 */
export function compassOnGround(toPage, { ring = true, ticks = true } = {}) {
  return mapRose(roseGeometry({ ring, ticks }), toPage);
}

/**
 * Place a rose in a page corner, inside the margins.
 *
 * @param {object} page - from createPage
 * @param {object} [options] - passed on to compassRose, minus the position
 * @param {number} [options.radius]
 * @param {number|Function} [options.northAngle] - degrees, or a function of the
 *   rose's own page position, since on a tilted sheet north depends on where you
 *   are standing
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

  // Given a way to lay the rose on the ground, use it: that is the honest
  // geometry, and it reduces to a plain circle when the view is top-down,
  // because ground-to-page is then a similarity.
  if (typeof rest.project === 'function') {
    const toPage = rest.project(position[0], position[1], radius);
    if (toPage) return compassOnGround(toPage, rest);
  }

  const northAngle =
    typeof rest.northAngle === 'function'
      ? rest.northAngle(position[0], position[1])
      : (rest.northAngle ?? 0);

  return compassRose({ ...rest, cx: position[0], cy: position[1], radius, northAngle });
}
