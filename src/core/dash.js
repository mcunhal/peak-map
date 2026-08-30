/**
 * Line styles, drawn as geometry.
 *
 * The SVG contract forbids `stroke-dasharray`: simple viewers ignore it, and a
 * plotter needs the pen path itself to be broken. So a dashed line is real
 * marks, cut from the run along its own arc length.
 *
 * This is deliberately not `dotsAlong` in `scene.js`. That one clips every mark
 * at the end of the polyline segment it starts in, which is invisible for a
 * 0.3mm dot and ruinous for a 1.8mm dash: a GPX track recorded every few metres
 * has segments shorter than the dash on paper, so every dash would come out
 * truncated to a segment. This walks the whole run instead, and a mark follows
 * the route around a corner.
 */

/** Patterns in millimetres: [on, off, on, off, ...]. Null means no dashing. */
export const LINE_STYLES = {
  solid: null,
  dashed: [1.8, 1.2],
  dotted: [0.3, 0.9],
  'dash-dot': [1.8, 0.8, 0.3, 0.8],
};

export const LINE_STYLE_IDS = Object.keys(LINE_STYLES);

/**
 * The same style, thinned out: gaps doubled, marks untouched.
 *
 * Used where a route passes behind a ridge. Scaling the whole pattern would
 * lengthen the marks too, which reads as a different style rather than the same
 * one at lower density.
 */
export function sparsePattern(pattern) {
  if (!pattern || pattern.length === 0) return null;
  return pattern.map((value, i) => (i % 2 === 1 ? value * 2 : value));
}

/**
 * Cut a run into marks along its arc length.
 *
 * @param {Array<{x: number, y: number}>} points - a run, in field samples
 * @param {Array<number>|null} pattern - [on, off, ...] in samples, cycling
 * @returns {Array<Array<number>>} flat [x0,y0,x1,y1,...] polylines
 */
export function dashAlong(points, pattern) {
  if (points.length < 2) return [];
  if (!pattern || pattern.length === 0) {
    return [points.flatMap((p) => [p.x, p.y])];
  }

  const out = [];
  let step = 0;              // which entry of the pattern we are inside
  let left = pattern[0];     // how much of that entry is still ahead
  let drawing = true;        // even entries are marks, odd ones are gaps
  let run = drawing ? [points[0].x, points[0].y] : [];

  for (let i = 1; i < points.length; ++i) {
    const a = points[i - 1];
    const b = points[i];
    let segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (segment === 0) continue;

    let travelled = 0;
    while (segment - travelled > left) {
      travelled += left;
      const t = travelled / Math.hypot(b.x - a.x, b.y - a.y);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;

      if (drawing) {
        run.push(x, y);
        if (run.length >= 4) out.push(run);
        run = [];
      } else {
        run = [x, y];
      }

      drawing = !drawing;
      step = (step + 1) % pattern.length;
      left = pattern[step];
    }

    left -= segment - travelled;
    // The far end of this segment falls inside the current entry, so a mark in
    // progress simply carries on through the corner.
    if (drawing) run.push(b.x, b.y);
  }

  if (drawing && run.length >= 4) out.push(run);
  return out;
}
