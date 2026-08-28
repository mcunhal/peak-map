/**
 * Writes a LayerSet to plot-ready SVG.
 *
 * Three properties matter for plotting, and each is asserted by a test:
 *
 *  - The root is declared in millimetres with a numerically identical viewBox, so
 *    one user unit is one millimetre and the sheet comes out the size it says.
 *  - Every layer is an Inkscape layer group, and also carries a plain `id` and
 *    `stroke`, so toolchains that ignore the Inkscape namespace still see pens.
 *  - Nothing is ever filled, and no dash array is emitted. Dashes are unreliable
 *    across plotter toolchains, so a dotted line is drawn as real short subpaths.
 */

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
const SODIPODI_NS = 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.0.dtd';

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Millimetres, rounded to a micron. Below any plotter's resolution, and short. */
function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** Number formatting that drops a trailing ".0" without going exponential. */
function num(value) {
  const r = round(value);
  return Object.is(r, -0) ? '0' : String(r);
}

function polylineToPathData(points) {
  const parts = [];
  for (let i = 0; i < points.length; i += 2) {
    parts.push(`${i === 0 ? 'M' : 'L'}${num(points[i])} ${num(points[i + 1])}`);
  }
  return parts.join(' ');
}

function writeLayer(layer) {
  const paths = [];
  for (const points of layer.polylines || []) {
    // A single point is not a stroke; it would be a pen-down with nowhere to go.
    if (!points || points.length < 4) continue;
    paths.push(`    <path fill="none" d="${polylineToPathData(points)}"/>`);
  }
  if (paths.length === 0) return '';

  const label = escapeAttr(layer.label ?? layer.id);
  const attrs = [
    `id="${escapeAttr(layer.id)}"`,
    `inkscape:groupmode="layer"`,
    `inkscape:label="${label}"`,
    `fill="none"`,
    `stroke="${escapeAttr(layer.penColor || '#000000')}"`,
    `stroke-width="${num(layer.penWidth ?? 0.3)}"`,
    `stroke-linecap="round"`,
    `stroke-linejoin="round"`,
  ];

  return `  <g ${attrs.join(' ')}>\n${paths.join('\n')}\n  </g>`;
}

/**
 * @param {object} options
 * @param {object} options.page - from createPage(); supplies the physical size.
 * @param {Array} options.layers - [{id, label, penColor, penWidth, polylines}]
 *   with polylines already in millimetres.
 * @param {string} [options.background] - paint a background rect in this colour.
 *   Off by default: a plotter does not draw it, and it only gets in the way.
 * @param {string} [options.title]
 */
export function writeSvg({ page, layers = [], background = null, title = null }) {
  const width = num(page.widthMm);
  const height = num(page.heightMm);

  const parts = [];
  parts.push('<?xml version="1.0" encoding="utf-8"?>');
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `xmlns:inkscape="${INKSCAPE_NS}" xmlns:sodipodi="${SODIPODI_NS}" ` +
      `version="1.1" width="${width}mm" height="${height}mm" ` +
      `viewBox="0 0 ${width} ${height}">`
  );
  if (title) parts.push(`  <title>${escapeAttr(title)}</title>`);
  if (background) {
    parts.push(
      `  <rect id="background" fill="${escapeAttr(background)}" ` +
        `x="0" y="0" width="${width}" height="${height}"/>`
    );
  }

  for (const layer of layers) {
    const rendered = writeLayer(layer);
    if (rendered) parts.push(rendered);
  }

  parts.push('</svg>');
  return parts.join('\n');
}
