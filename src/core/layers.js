/**
 * Turns a rendered scene into pen layers on a page.
 *
 * One layer per pen. The terrain is one layer; every GPX track gets its own, so a
 * route can be plotted in a different colour without touching the terrain, and can
 * be skipped or re-plotted independently.
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
  } = options;

  const layers = [];

  if (scene.terrain && scene.terrain.length) {
    layers.push({
      id: 'terrain',
      label: 'terrain',
      penColor: terrainPen.color,
      penWidth: terrainPen.width,
      polylines: scene.terrain.map((line) => mapper.polylineToMm(line)),
    });
  }

  const usedIds = new Set(layers.map((l) => l.id));

  (scene.tracks || []).forEach((track, index) => {
    if (!track.polylines || track.polylines.length === 0) return;

    const pen = trackPens[index] || {};
    let id = toId('route', track.name, index);
    // Two files can easily share a track name; ids may not collide.
    if (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);

    layers.push({
      id,
      label: track.name || id,
      penColor: pen.color || DEFAULT_TRACK_COLORS[index % DEFAULT_TRACK_COLORS.length],
      penWidth: pen.width ?? 0.5,
      polylines: track.polylines.map((line) => mapper.polylineToMm(line)),
    });
  });

  return layers;
}
