import { describe, it, expect } from 'vitest';
import { parseGpx, trackBounds } from './parse';

const wrap = (inner) =>
  `<?xml version="1.0"?><gpx version="1.1" creator="test">${inner}</gpx>`;

const track = (pts) =>
  wrap(`<trk><name>Serra</name><trkseg>${pts}</trkseg></trk>`);

const pt = (lat, lon, ele) =>
  `<trkpt lat="${lat}" lon="${lon}">${ele === undefined ? '' : `<ele>${ele}</ele>`}</trkpt>`;

describe('parseGpx', () => {
  it('reads a track segment in order', () => {
    const tracks = parseGpx(track(pt(40.1, -8.1, 100) + pt(40.2, -8.2, 200)));
    expect(tracks).toHaveLength(1);
    expect(tracks[0].name).toBe('Serra');
    expect(tracks[0].points).toEqual([
      { lat: 40.1, lon: -8.1, ele: 100 },
      { lat: 40.2, lon: -8.2, ele: 200 },
    ]);
  });

  it('treats missing elevation as unknown rather than zero', () => {
    const tracks = parseGpx(track(pt(40.1, -8.1) + pt(40.2, -8.2)));
    expect(tracks[0].points[0].ele).toBeNull();
  });

  it('splits multiple segments into separate tracks', () => {
    const xml = wrap(
      `<trk><name>Ride</name>` +
        `<trkseg>${pt(1, 1) + pt(2, 2)}</trkseg>` +
        `<trkseg>${pt(3, 3) + pt(4, 4)}</trkseg></trk>`
    );
    const tracks = parseGpx(xml);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].name).toBe('Ride (1)');
    expect(tracks[1].name).toBe('Ride (2)');
  });

  it('keeps multiple tracks from one file separate', () => {
    const xml = wrap(
      `<trk><name>A</name><trkseg>${pt(1, 1) + pt(2, 2)}</trkseg></trk>` +
        `<trk><name>B</name><trkseg>${pt(3, 3) + pt(4, 4)}</trkseg></trk>`
    );
    expect(parseGpx(xml).map((t) => t.name)).toEqual(['A', 'B']);
  });

  it('reads routes as well as tracks', () => {
    const xml = wrap(
      `<rte><name>Planned</name><rtept lat="1" lon="1"/><rtept lat="2" lon="2"/></rte>`
    );
    expect(parseGpx(xml)[0].name).toBe('Planned');
  });

  it('falls back to waypoints when there is nothing else', () => {
    const xml = wrap(`<wpt lat="1" lon="1"/><wpt lat="2" lon="2"/>`);
    expect(parseGpx(xml, 'wpts.gpx')[0].points).toHaveLength(2);
  });

  it('uses the supplied name when the file has none', () => {
    const xml = wrap(`<trk><trkseg>${pt(1, 1) + pt(2, 2)}</trkseg></trk>`);
    expect(parseGpx(xml, 'serra-da-estrela.gpx')[0].name).toBe('serra-da-estrela.gpx');
  });

  it('drops segments too short to draw', () => {
    const xml = wrap(
      `<trk><name>X</name><trkseg>${pt(1, 1)}</trkseg>` +
        `<trkseg>${pt(3, 3) + pt(4, 4)}</trkseg></trk>`
    );
    expect(parseGpx(xml)).toHaveLength(1);
  });

  it('skips points with unusable coordinates', () => {
    const xml = wrap(
      `<trk><trkseg><trkpt lat="abc" lon="1"/>${pt(2, 2) + pt(3, 3)}</trkseg></trk>`
    );
    expect(parseGpx(xml)[0].points).toHaveLength(2);
  });

  it('rejects empty input', () => {
    expect(() => parseGpx('')).toThrow(/empty/i);
  });

  it('rejects a file that is not GPX', () => {
    expect(() => parseGpx('<html><body>no</body></html>')).toThrow(/not a gpx/i);
  });

  it('rejects a GPX file with nothing to draw', () => {
    expect(() => parseGpx(wrap('<metadata><name>x</name></metadata>'))).toThrow(
      /no track, route or waypoint/i
    );
  });
});

describe('trackBounds', () => {
  it('spans every point of every track', () => {
    const tracks = [
      { name: 'a', points: [{ lat: 40, lon: -8 }, { lat: 41, lon: -7 }] },
      { name: 'b', points: [{ lat: 39, lon: -9 }, { lat: 42, lon: -6 }] },
    ];
    expect(trackBounds(tracks)).toEqual({ west: -9, south: 39, east: -6, north: 42 });
  });
});
