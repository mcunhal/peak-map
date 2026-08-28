/**
 * GPX parsing.
 *
 * Only what a map needs: ordered sequences of positions with optional elevation.
 * Tracks, routes and standalone waypoints all reduce to the same shape, so the
 * rest of the pipeline does not care which one a file contained.
 */
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  isArray: (name) => ['trk', 'trkseg', 'trkpt', 'rte', 'rtept', 'wpt'].includes(name),
});

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function readPoint(node) {
  const lat = Number.parseFloat(node['@lat']);
  const lon = Number.parseFloat(node['@lon']);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const rawEle = node.ele;
  const ele = rawEle === undefined ? null : Number.parseFloat(rawEle);

  return { lat, lon, ele: Number.isFinite(ele) ? ele : null };
}

function readSegment(node) {
  return toArray(node).map(readPoint).filter(Boolean);
}

/**
 * @param {string} xml
 * @param {string} [name] - fallback name, normally the file name
 * @returns {Array<{name: string, points: Array<{lat,lon,ele}>}>} one entry per
 *   track segment or route, in document order.
 */
export function parseGpx(xml, name = 'track') {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('GPX input is empty');
  }

  let doc;
  try {
    doc = parser.parse(xml);
  } catch (cause) {
    throw new Error(`Could not parse GPX: ${cause.message}`);
  }

  const gpx = doc && doc.gpx;
  if (!gpx) throw new Error('Not a GPX file: no <gpx> root element');

  const out = [];

  for (const trk of toArray(gpx.trk)) {
    const trackName = trk.name || name;
    const segments = toArray(trk.trkseg);
    segments.forEach((seg, i) => {
      const points = readSegment(seg.trkpt);
      if (points.length < 2) return;
      out.push({
        name: segments.length > 1 ? `${trackName} (${i + 1})` : String(trackName),
        points,
      });
    });
  }

  for (const rte of toArray(gpx.rte)) {
    const points = readSegment(rte.rtept);
    if (points.length >= 2) out.push({ name: String(rte.name || name), points });
  }

  if (out.length === 0) {
    const waypoints = readSegment(gpx.wpt);
    if (waypoints.length >= 2) out.push({ name: String(name), points: waypoints });
  }

  if (out.length === 0) {
    throw new Error('GPX file contains no track, route or waypoint sequence');
  }

  return out;
}

/** Bounding box of one or more parsed tracks. */
export function trackBounds(tracks) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const track of tracks) {
    for (const p of track.points) {
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
    }
  }
  if (west > east) throw new Error('Tracks contain no points');
  return { west, south, east, north };
}
