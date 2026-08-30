/**
 * Loaded GPX routes, grouped by the file they came from.
 *
 * A file is the unit a person thinks in: one ride, one colour, one pen. The
 * parser hands back one entry per track segment, and flattening those straight
 * into a list gave a six-segment ride six different colours with nothing to say
 * they belonged together.
 *
 * A section inherits its file's style until it overrides a key, and then holds
 * that key until it is cleared. A file-level change therefore never disturbs
 * something set by hand.
 *
 * Pure, and free of Vue: the panel drives these, and so do the tests.
 */
import { DEFAULT_TRACK_COLORS } from '../core/layers';

const STYLE_KEYS = ['color', 'width', 'lineStyle'];

let seed = 0;
const nextId = (prefix) => `${prefix}${++seed}`;

/**
 * @param {string} fileName - as dropped, e.g. "estrela.gpx"
 * @param {Array<{name, points}>} parsedSections - straight from `parseGpx`
 * @param {number} index - how many files were already loaded; picks the colour
 */
export function makeTrackFile(fileName, parsedSections, index) {
  const id = nextId('f');
  return {
    id,
    name: fileName,
    style: {
      color: DEFAULT_TRACK_COLORS[index % DEFAULT_TRACK_COLORS.length],
      width: 0.5,
      lineStyle: 'solid',
    },
    sections: parsedSections.map((section) => ({
      id: nextId(`${id}s`),
      name: section.name,
      points: section.points,
      override: {},
    })),
  };
}

/** The style a section actually draws with. */
export function resolveStyle(file, section) {
  const out = {};
  for (const key of STYLE_KEYS) {
    out[key] = key in section.override ? section.override[key] : file.style[key];
  }
  return out;
}

export function isOverridden(section, key) {
  return key in section.override;
}

export function setOverride(section, key, value) {
  section.override[key] = value;
}

export function clearOverride(section, key) {
  delete section.override[key];
}

/**
 * Flatten to the shape the worker already takes: a list of tracks and a list of
 * pens by the same index. Grouping into layers happens later, from the pens.
 */
export function flattenForRequest(trackFiles) {
  const tracks = [];
  const pens = [];

  for (const file of trackFiles) {
    for (const section of file.sections) {
      const style = resolveStyle(file, section);
      tracks.push({
        name: section.name,
        fileName: file.name,
        points: section.points,
        lineStyle: style.lineStyle,
      });
      pens.push({ color: style.color, width: style.width });
    }
  }

  return { tracks, pens };
}
