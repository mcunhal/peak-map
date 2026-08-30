/**
 * Turns a rendered scene into pen layers on a page.
 *
 * One layer per pen. The terrain is one layer; the GPX sections are grouped by the
 * pen they resolved to, so a route can be plotted in a different colour without
 * touching the terrain, and can be skipped or re-plotted independently.
 *
 * Grouping is by pen rather than by section because a plotter does a pen change
 * per layer: a twenty-segment ride in one colour is one layer, and the label says
 * which files fed it.
 */

/** Distinct default pen colours, used in order when a track has none assigned. */
export const DEFAULT_TRACK_COLORS = [
  '#c1272d', // red
  '#0b6e99', // blue
  '#1a7f37', // green
  '#b8860b', // ochre
  '#6b3fa0', // violet
  '#c2560f', // orange
];

/** Strip characters that would make an unusable SVG id. */
function toId(prefix, name, index) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug ? `${prefix}-${slug}` : `${prefix}-${index + 1}`;
}

/**
 * A layer id from the pen itself, so the same pen always lands in the same
 * layer whatever it was called upstream.
 */
function penId(color, width) {
  const hex = String(color).replace('#', '').toLowerCase();
  const hundredths = String(Math.round(Number(width) * 100)).padStart(3, '0');
  return `route-${hex}-${hundredths}`;
}

/**
 * @param {object} scene - from renderRidgelineScene
 * @param {object} mapper - from createPageMapper; converts field units to millimetres
 * @param {object} [options]
 * @param {object} [options.terrainPen] - {color, width} in millimetres
 * @param {Array}  [options.trackPens]  - per-track {color, width}, by index
 * @returns {Array} layers ready for writeSvg
 */
export function buildLayers(scene, mapper, options = {}) {
  const {
    terrainPen = { color: '#161616', width: 0.3 },
    trackPens = [],
    // Several algorithms can share one sheet, and each needs an id of its own:
    // a plotter driven from these layers selects them by name.
    terrainId = 'terrain',
  } = options;

  const layers = [];

  if (scene.terrain && scene.terrain.length) {
    layers.push({
      id: terrainId,
      label: terrainId,
      penColor: terrainPen.color,
      penWidth: terrainPen.width,
      polylines: scene.terrain.map((line) => mapper.polylineToMm(line)),
    });
  }

  const usedIds = new Set(layers.map((l) => l.id));

  // One layer per pen, not per section. A plotter does a pen change per layer,
  // so a twenty-segment ride in one colour must not ask for twenty of them.
  // Line style does not enter the key: by this point a dash is geometry, and a
  // dashed and a solid route of the same colour and width take the same pen.
  const byPen = new Map();

  (scene.tracks || []).forEach((track, index) => {
    if (!track.polylines || track.polylines.length === 0) return;

    const pen = trackPens[index] || {};
    const color = pen.color || DEFAULT_TRACK_COLORS[index % DEFAULT_TRACK_COLORS.length];
    const width = pen.width ?? 0.5;
    const key = `${color}|${width}`;

    if (!byPen.has(key)) {
      byPen.set(key, {
        id: penId(color, width),
        sources: [],
        penColor: color,
        penWidth: width,
        polylines: [],
      });
    }

    const layer = byPen.get(key);
    const source = track.fileName || track.name;
    if (source && !layer.sources.includes(source)) layer.sources.push(source);
    for (const line of track.polylines) layer.polylines.push(mapper.polylineToMm(line));
  });

  for (const layer of byPen.values()) {
    let id = layer.id;
    if (usedIds.has(id)) id = `${id}-${usedIds.size}`;
    usedIds.add(id);
    layers.push({
      id,
      label: layer.sources.join(', ') || id,
      penColor: layer.penColor,
      penWidth: layer.penWidth,
      polylines: layer.polylines,
    });
  }

  return layers;
}
