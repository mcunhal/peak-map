/**
 * The page: a physical sheet in millimetres, and the mapping from field
 * coordinates onto it.
 *
 * Everything downstream of this module is in millimetres, which is what makes
 * optimizer tolerances and pen widths mean something physical. Upstream worked in
 * browser pixels, so an export was only ever as large as the window.
 */

/** ISO A series and a few common sizes, portrait, in millimetres. */
export const PAPER_SIZES = {
  A0: { width: 841, height: 1189 },
  A1: { width: 594, height: 841 },
  A2: { width: 420, height: 594 },
  A3: { width: 297, height: 420 },
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
  Tabloid: { width: 279.4, height: 431.8 },
};

function resolveMargin(margin) {
  if (margin === undefined || margin === null) margin = 0;
  if (typeof margin === 'number') {
    return { top: margin, right: margin, bottom: margin, left: margin };
  }
  return {
    top: margin.top || 0,
    right: margin.right || 0,
    bottom: margin.bottom || 0,
    left: margin.left || 0,
  };
}

/**
 * Build a page description.
 *
 * @param {object} options
 * @param {string|{width:number,height:number}} options.paper - a key of PAPER_SIZES,
 *   or an explicit size in millimetres.
 * @param {'portrait'|'landscape'} [options.orientation]
 * @param {number|{top,right,bottom,left}} [options.margin] - millimetres.
 */
export function createPage({ paper = 'A4', orientation = 'portrait', margin = 0 } = {}) {
  const size = typeof paper === 'string' ? PAPER_SIZES[paper] : paper;
  if (!size) throw new Error(`Unknown paper size "${paper}"`);

  const landscape = orientation === 'landscape';
  const widthMm = landscape ? size.height : size.width;
  const heightMm = landscape ? size.width : size.height;

  const m = resolveMargin(margin);
  const drawable = {
    x: m.left,
    y: m.top,
    width: widthMm - m.left - m.right,
    height: heightMm - m.top - m.bottom,
  };

  if (drawable.width <= 0 || drawable.height <= 0) {
    throw new Error(
      `Margin leaves no drawable area on a ${widthMm}x${heightMm}mm page`
    );
  }

  return { paper, orientation, widthMm, heightMm, margin: m, drawable };
}

/**
 * Map field coordinates (samples) onto the page (millimetres), fitting the field
 * inside the drawable area without distorting it, and centring the slack.
 */
export function createPageMapper(page, field) {
  if (!field || !field.width || !field.height) {
    throw new Error('Field must have a non-zero width and height');
  }

  const { drawable } = page;
  const scale = Math.min(drawable.width / field.width, drawable.height / field.height);

  const drawnWidth = field.width * scale;
  const drawnHeight = field.height * scale;
  const offsetX = drawable.x + (drawable.width - drawnWidth) / 2;
  const offsetY = drawable.y + (drawable.height - drawnHeight) / 2;

  return {
    scale,
    offsetX,
    offsetY,
    toMm(x, y) {
      return [offsetX + x * scale, offsetY + y * scale];
    },
    /** Map a flat [x0,y0,x1,y1,...] polyline in one pass. */
    polylineToMm(points) {
      const out = new Array(points.length);
      for (let i = 0; i < points.length; i += 2) {
        out[i] = offsetX + points[i] * scale;
        out[i + 1] = offsetY + points[i + 1] * scale;
      }
      return out;
    },
  };
}
