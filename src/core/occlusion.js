/**
 * Hidden-line removal for the ridgeline renderer.
 *
 * Rows are drawn from the bottom of the field upwards. A column remembers the
 * highest point drawn in it so far (its horizon); anything at or below that is
 * behind something already drawn and must not be plotted.
 *
 * This is a first-class object rather than a local inside the renderer because
 * GPX tracks have to be tested against it at their own depth, interleaved with
 * the terrain rows. Testing them against the finished buffer would wrongly hide a
 * track in the foreground behind ridges that are actually further away.
 */
export function createOcclusionBuffer(width, height) {
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Occlusion buffer needs a positive width and height');
  }

  // Smaller y is higher on the page, so the horizon starts at the bottom edge.
  const horizon = new Float32Array(width).fill(height);

  function checkColumn(x) {
    if (!Number.isInteger(x) || x < 0 || x >= width) {
      throw new Error(`Occlusion column ${x} is outside 0..${width - 1}`);
    }
  }

  return {
    width,
    height,

    /** Is (x, y) in front of everything drawn in this column so far? */
    isVisible(x, y) {
      checkColumn(x);
      if (y < 0) return false;
      return y <= horizon[x];
    },

    /** Record that (x, y) was drawn, raising the column's horizon. */
    mark(x, y) {
      checkColumn(x);
      if (y < horizon[x]) horizon[x] = y;
    },

    horizonAt(x) {
      checkColumn(x);
      return horizon[x];
    },

    reset() {
      horizon.fill(height);
    },
  };
}
